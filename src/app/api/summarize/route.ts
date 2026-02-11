import { NextRequest, NextResponse } from "next/server";
import { YoutubeTranscript } from "youtube-transcript";
import { GoogleGenerativeAI } from "@google/generative-ai";
import ytdl from "@distube/ytdl-core";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
export const maxDuration = 60; // 60 seconds is the max for Vercel Pro, Hobby is 10s.

export async function POST(req: NextRequest) {
    try {
        const body = await req.json().catch(() => ({}));
        const { url } = body;

        if (!url) return NextResponse.json({ error: "URL is required" }, { status: 400 });
        if (!process.env.GEMINI_API_KEY) return NextResponse.json({ error: "Gemini API Key missing" }, { status: 500 });

        const videoIdMatch = url.match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        const videoId = videoIdMatch ? videoIdMatch[1] : "";

        if (!videoId) return NextResponse.json({ error: "Invalid YouTube URL" }, { status: 400 });

        let transcriptText = "";

        // Stage 1: Attempt YoutubeTranscript (Fastest)
        try {
            console.log(`[Stage 1] Fetching transcript via YoutubeTranscript: ${videoId}`);
            const transcript = await YoutubeTranscript.fetchTranscript(videoId);
            if (transcript && transcript.length > 0) {
                transcriptText = transcript.map(t => t.text).join("\n");
                console.log("[Stage 1] Success.");
            }
        } catch (e) {
            console.warn("[Stage 1] Failed.");
        }

        // Stage 2: Attempt ytdl-core subtitle extraction (Medium)
        if (!transcriptText) {
            try {
                console.log(`[Stage 2] Fetching via ytdl-core: ${videoId}`);
                const info = await ytdl.getInfo(url);
                const tracks = info.player_response.captions?.playerCaptionsTracklistRenderer?.captionTracks;
                if (tracks && tracks.length > 0) {
                    // Prefer English, then English (auto), then first available
                    const track = tracks.find((t: any) => t.languageCode === 'en' && !t.kind) ||
                        tracks.find((t: any) => t.languageCode === 'en') ||
                        tracks[0];

                    if (track) {
                        console.log(`[Stage 2] Found track: ${track.languageCode}`);
                        const response = await fetch(track.baseUrl);
                        const xml = await response.text();
                        // Basic XML tag removal for transcript
                        transcriptText = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                        console.log("[Stage 2] Success.");
                    }
                }
            } catch (e) {
                console.warn("[Stage 2] Failed.");
            }
        }

        const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

        if (transcriptText && transcriptText.length > 100) {
            console.log("[Gemini] Processing with Transcript Text");
            const prompt = `Analyze this YouTube transcript and generate:
            1. A concise summary (2-3 paragraphs).
            2. Structured study notes in markdown.
            
            Transcript:
            ${transcriptText.substring(0, 20000)}
            
            Format your entire response as a JSON object: {"summary": "...", "notes": "..."}`;

            const result = await model.generateContent(prompt);
            const aiData = extractJson((await result.response).text());
            return NextResponse.json({ ...aiData, transcript: transcriptText });
        } else {
            // Stage 3: Audio extraction (Slowest)
            console.log("[Stage 3] Processing via Audio Fallback");
            try {
                const audioBuffer = await downloadAudio(url);
                console.log(`[Stage 3] Audio downloaded: ${(audioBuffer.length / 1024 / 1024).toFixed(2)}MB`);

                const prompt = "Listen to this video audio and generate: 1. A verbatim transcript (key 'transcript'). 2. A concise summary (key 'summary'). 3. Detailed study notes in markdown (key 'notes'). Format as JSON.";

                const result = await model.generateContent([
                    prompt,
                    { inlineData: { data: audioBuffer.toString('base64'), mimeType: "audio/mp4" } }
                ]);

                const aiData = extractJson((await result.response).text());
                return NextResponse.json(aiData);
            } catch (err: any) {
                console.error("[Stage 3] Error:", err.message);
                const msg = err.message.includes("429") ? "YouTube is temporarily rate-limiting requests. Please try again in a few minutes." :
                    "This video has no subtitles and audio extraction failed. This can happen if the video is too long (over 10-15 mins) or private.";
                return NextResponse.json({ error: msg }, { status: 500 });
            }
        }
    } catch (error: any) {
        console.error("General Failure:", error);
        return NextResponse.json({ error: "A server error occurred. Try a different video." }, { status: 500 });
    }
}

async function downloadAudio(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        try {
            const stream = ytdl(url, {
                quality: 'lowestaudio',
                filter: 'audioonly',
                requestOptions: {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                    }
                }
            });

            stream.on('data', chunk => chunks.push(chunk));
            stream.once('end', () => resolve(Buffer.concat(chunks)));
            stream.on('error', e => reject(e));

            setTimeout(() => {
                stream.destroy();
                reject(new Error("Audio download timed out (30s)"));
            }, 30000);
        } catch (e) {
            reject(e);
        }
    });
}

function extractJson(text: string) {
    try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        return JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch {
        return { summary: "Error generating structured summary.", notes: text, transcript: "AI transcript failed." };
    }
}
