import { NextRequest, NextResponse } from "next/server";
import { YoutubeTranscript } from "youtube-transcript";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { spawn } from "child_process";
import path from "path";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
// Use local virtual env yt-dlp
const YTDLP_PATH = path.join(process.cwd(), ".venv/bin/yt-dlp");

export async function POST(req: NextRequest) {
    try {
        const { url } = await req.json();

        if (!url) {
            return NextResponse.json({ error: "URL is required" }, { status: 400 });
        }

        if (!process.env.GEMINI_API_KEY) {
            return NextResponse.json({ error: "Gemini API Key is not configured" }, { status: 500 });
        }

        let videoId = "";
        try {
            // Simple regex for video ID (yt-dlp is robust, but we need ID for transcript attempt)
            const videoIdMatch = url.match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
            videoId = videoIdMatch ? videoIdMatch[1] : "";
        } catch (e) {
            // allow continuing if regex fails, yt-dlp handles url
        }

        let transcriptText = "";

        // Attempt 1: Fetch Transcript via YoutubeTranscript (fastest)
        if (videoId) {
            try {
                console.log(`Attempting to fetch transcript via YoutubeTranscript for: ${videoId}`);
                const transcript = await YoutubeTranscript.fetchTranscript(videoId);
                if (transcript && transcript.length > 0) {
                    transcriptText = transcript.map(t => t.text).join("\n");
                    console.log("Transcript found via YoutubeTranscript.");
                }
            } catch (error) {
                console.warn("YoutubeTranscript failed, proceeding to yt-dlp.");
            }
        }

        // Attempt 2: Fetch Subtitles via yt-dlp (robust)
        if (!transcriptText) {
            try {
                console.log("Attempting to fetch transcript via yt-dlp...");
                transcriptText = await fetchSubtitleWithYtDlp(url);
                if (transcriptText) {
                    console.log(`Transcript found via yt-dlp. Length: ${transcriptText.length}`);
                } else {
                    console.log("yt-dlp return empty transcript.");
                }
            } catch (err) {
                console.warn("yt-dlp subtitle fetch failed:", err);
            }
        } else {
            console.log("Skipping yt-dlp because transcript was found via YoutubeTranscript.");
        }

        const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

        if (transcriptText && transcriptText.length > 100) {
            // Process with Transcript (Text Mode - Fast & Cheap)
            try {
                const prompt = `
                You are an expert educational content creator. I will provide you with a transcript of a YouTube video. 
                Your task is to generate:
                1. A concise summary of the video (2-3 paragraphs).
                2. Clean, well-structured study notes in markdown format, using headings, bullet points, and highlighting key concepts.
                
                Transcript:
                ${transcriptText.substring(0, 15000)}
                
                Please format your response as a JSON object with two keys: "summary" and "notes".
                Ensure the "notes" are in valid Markdown.
                `;

                const result = await model.generateContent(prompt);
                const response = await result.response;
                const text = response.text();

                // Return BOTH the AI result AND the transcript
                const aiData = extractJson(text);
                return NextResponse.json({ ...aiData, transcript: transcriptText });
            } catch (geminiError: any) {
                console.error("Gemini Text Mode Error:", geminiError);

                // For ANY error in text mode (Rate Limit, Safety, Server Error), 
                // meaningful to return the transcript since we have it.
                let summaryMsg = "⚠️ **AI Summary Unavailable**\n\nWe encountered an error generating the summary.";
                if (geminiError.status === 429 || geminiError.message?.includes("429") || geminiError.message?.includes("Quota exceeded")) {
                    summaryMsg = "⚠️ **AI Rate Limit Reached**\n\nWe couldn't generate the summary right now because of high traffic.";
                }

                return NextResponse.json({
                    summary: summaryMsg + " However, we successfully fetched the transcript for you below. We will automatically retry generating the summary in a moment.",
                    notes: "Study notes are unavailable due to the AI error.",
                    transcript: transcriptText
                }, { status: geminiError.status === 429 ? 429 : (geminiError.status || 500) });
            }

        } else {
            // Attempt 3: Process with Audio via yt-dlp (Audio Mode - Slow & Fallback)
            console.log("Processing via Audio (yt-dlp)...");

            try {
                const buffer = await downloadAudioBuffer(url);
                const base64Audio = buffer.toString('base64');
                const mimeType = "audio/aac"; // Force m4a/aac which is supported by Gemini

                console.log(`Audio buffer loaded via yt-dlp. Size: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

                if (buffer.length > 19 * 1024 * 1024) {
                    return NextResponse.json({ error: "Video audio is too large (over 19MB). Please use a shorter video." }, { status: 400 });
                }

                // Updated prompt to ask for transcript as well
                const prompt = "Listen to this audio from a YouTube video and generate:\n1. A verbatim transcript of the speech, formatted with frequent line breaks for readability (key 'transcript').\n2. A concise summary (2-3 paragraphs) (key 'summary').\n3. Clean, well-structured study notes in markdown format (key 'notes').\n\nPlease format your response as a JSON object with three keys: 'summary', 'notes', and 'transcript'. Ensure 'notes' are in valid Markdown.";

                const result = await model.generateContent([
                    prompt,
                    {
                        inlineData: {
                            data: base64Audio,
                            mimeType: mimeType
                        }
                    }
                ]);

                const response = await result.response;
                const text = response.text();
                const aiData = extractJson(text);
                return NextResponse.json(aiData);

            } catch (audioError: any) {
                console.error("Audio processing failed:", audioError);
                return NextResponse.json({ error: `Failed to process video: ${audioError.message}` }, { status: 500 });
            }
        }

    } catch (error: any) {
        console.error("General error:", error);

        // Handle Gemini Rate Limits (429)
        const errString = error.toString();
        if (error.status === 429 ||
            error.message?.includes("429") ||
            error.message?.includes("Quota exceeded") ||
            errString.includes("429") ||
            errString.includes("Quota exceeded")) {
            return NextResponse.json({
                error: "⚠️ AI Usage Limit Reached: You've hit the free tier limit for the Gemini API. Please wait a minute and try again."
            }, { status: 429 });
        }

        return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
    }
}

async function fetchSubtitleWithYtDlp(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = spawn(YTDLP_PATH, ['--dump-json', '--skip-download', url]);
        let data = "";
        proc.stdout.on('data', d => data += d);
        proc.stderr.on('data', () => { }); // ignore stderr

        proc.on('close', async (code) => {
            if (code !== 0) return resolve(""); // Fail silently
            try {
                const info = JSON.parse(data);
                const subs = info.subtitles || {};
                const autoSubs = info.automatic_captions || {};

                // Try multiple English variations
                const enSubs = subs.en || subs['en-US'] || subs['en-orig'] ||
                    autoSubs.en || autoSubs['en-US'] || autoSubs['en-orig'];

                if (!enSubs) {
                    console.log("No English subtitles found in keys:", Object.keys(subs).concat(Object.keys(autoSubs)));
                    return resolve("");
                }

                // Prefer json3 or vtt
                const format = enSubs.find((f: any) => f.ext === 'json3') || enSubs.find((f: any) => f.ext === 'vtt');
                if (!format) return resolve("");

                console.log(`Fetching subtitle URL: ${format.url}`);

                // Fetch content with user agent to avoid blocking
                const res = await fetch(format.url, {
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36"
                    }
                });

                if (!res.ok) {
                    console.log(`Subtitle fetch failed: ${res.status} ${res.statusText}`);
                    return resolve("");
                }

                if (format.ext === 'json3') {
                    const json = await res.json();
                    // Parse json3: events -> segs -> utf8
                    const events = json.events || [];
                    const text = events.map((e: any) => e.segs ? e.segs.map((s: any) => s.utf8).join("") : "").join("\n");
                    resolve(text);
                } else {
                    const text = await res.text();
                    // Basic VTT cleaning (remove headers and timestamps)
                    const cleaned = text.replace(/WEBVTT[\s\S]*?\n\n/g, '') // header
                        .replace(/^\d+\s+\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}.*$/gm, '') // timestamps
                        .replace(/<[^>]+>/g, '') // tags
                        .replace(/^\s*$/gm, '') // empty lines
                        .replace(/\n+/g, '\n'); // preserve line breaks
                    resolve(cleaned);
                }
            } catch (e) {
                resolve("");
            }
        });
    });
}

function downloadAudioBuffer(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const args = [
            '-f', 'bestaudio[ext=m4a]', // Force m4a for Gemini compatibility
            '-o', '-',                  // Output to stdout
            '--quiet',                  // Suppress output
            '--no-playlist',
            '--max-filesize', '19M',    // Limit size early if possible (soft limit)
            url
        ];

        console.log(`Spawning yt-dlp: ${YTDLP_PATH} ${args.join(' ')}`);

        const process = spawn(YTDLP_PATH, args);
        const chunks: Buffer[] = [];
        let errorData = "";

        process.stdout.on('data', (chunk) => {
            chunks.push(chunk);
        });

        process.stderr.on('data', (data) => {
            errorData += data.toString();
        });

        process.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`yt-dlp exited with code ${code}: ${errorData}`));
            } else {
                if (chunks.length === 0) {
                    reject(new Error("yt-dlp returned no data"));
                } else {
                    resolve(Buffer.concat(chunks));
                }
            }
        });

        process.on('error', (err) => {
            reject(new Error(`Failed to start yt-dlp: ${err.message}`));
        });
    });
}

function extractJson(text: string) {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const cleanedJson = jsonMatch ? jsonMatch[0] : text;

    try {
        return JSON.parse(cleanedJson);
    } catch (parseError) {
        return {
            summary: "I've generated the summary, but had trouble formatting it as JSON.",
            notes: text,
            transcript: "Transcript parsing failed."
        };
    }
}
