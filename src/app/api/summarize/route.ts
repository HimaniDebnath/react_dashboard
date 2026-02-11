import { NextRequest, NextResponse } from "next/server";
import { YoutubeTranscript } from "youtube-transcript";
import { GoogleGenerativeAI } from "@google/generative-ai";
import ytdl from "@distube/ytdl-core";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

// Vercel Timeout is usually 10s on Hobby, but we try to be fast.
export const maxDuration = 60; // For Pro accounts, this helps.

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
            const videoIdMatch = url.match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
            videoId = videoIdMatch ? videoIdMatch[1] : "";
        } catch (e) {
            console.error("Video ID extraction failed", e);
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
                console.warn("YoutubeTranscript failed.");
            }
        }

        const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

        if (transcriptText && transcriptText.length > 100) {
            console.log("Processing with Transcript (Text Mode)");
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
                const aiData = extractJson(text);
                return NextResponse.json({ ...aiData, transcript: transcriptText });
            } catch (geminiError: any) {
                console.error("Gemini Text Mode Error:", geminiError);
                return NextResponse.json({
                    summary: "⚠️ **AI Summary Unavailable**\n\nWe encountered an error generating the summary.",
                    notes: "Study notes are unavailable due to the AI error.",
                    transcript: transcriptText
                }, { status: 500 });
            }

        } else {
            // Attempt 2: Process with Audio via ytdl-core (Fallback for Vercel)
            console.log("Processing via Audio (ytdl-core fallback)...");

            try {
                if (!ytdl.validateURL(url)) {
                    throw new Error("Invalid YouTube URL for audio extraction.");
                }

                console.log("Downloading audio info...");
                const info = await ytdl.getInfo(url);
                const format = ytdl.chooseFormat(info.formats, { quality: 'lowestaudio', filter: 'audioonly' });

                if (!format) {
                    throw new Error("No suitable audio format found.");
                }

                console.log(`Downloading audio from: ${format.url}`);
                const audioBuffer = await downloadAudioStream(url);
                const base64Audio = audioBuffer.toString('base64');
                const mimeType = "audio/mp4"; // Gemini supports mp4/m4a

                console.log(`Audio buffer loaded. Size: ${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB`);

                if (audioBuffer.length > 19 * 1024 * 1024) {
                    return NextResponse.json({ error: "Video audio is too large for the free tier (over 19MB). Please use a shorter video." }, { status: 400 });
                }

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
                return NextResponse.json({ error: `Failed to process video: ${audioError.message}. This can happen if the video is too long or YouTube is blocking the request. Try a different video.` }, { status: 500 });
            }
        }

    } catch (error: any) {
        console.error("General error:", error);
        return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
    }
}

async function downloadAudioStream(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const stream = ytdl(url, {
            quality: 'lowestaudio',
            filter: 'audioonly',
        });

        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', (err) => reject(err));

        // Timeout after 45 seconds
        setTimeout(() => {
            stream.destroy();
            reject(new Error("Audio download timed out after 45 seconds."));
        }, 45000);
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
