import { NextRequest, NextResponse } from "next/server";
import { YoutubeTranscript } from "youtube-transcript";
import { GoogleGenerativeAI } from "@google/generative-ai";
import ytdl from "@distube/ytdl-core";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

export const maxDuration = 60;

export async function POST(req: NextRequest) {
    try {
        const body = await req.json().catch(() => ({}));
        const { url } = body;

        if (!url) {
            return NextResponse.json({ error: "URL is required" }, { status: 400 });
        }

        if (!process.env.GEMINI_API_KEY) {
            return NextResponse.json({ error: "Gemini API Key is not configured" }, { status: 500 });
        }

        let videoId = "";
        const videoIdMatch = url.match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        videoId = videoIdMatch ? videoIdMatch[1] : "";

        if (!videoId) {
            return NextResponse.json({ error: "Invalid YouTube URL" }, { status: 400 });
        }

        let transcriptText = "";

        // Attempt 1: Fetch Transcript via YoutubeTranscript
        try {
            console.log(`Attempting transcript for: ${videoId}`);
            const transcript = await YoutubeTranscript.fetchTranscript(videoId);
            if (transcript && transcript.length > 0) {
                transcriptText = transcript.map(t => t.text).join("\n");
                console.log("Transcript found.");
            }
        } catch (error) {
            console.warn("YoutubeTranscript failed.");
        }

        const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

        if (transcriptText && transcriptText.length > 100) {
            try {
                const prompt = `
                Analyze this YouTube transcript and generate:
                1. A concise summary (2-3 paragraphs).
                2. Structured study notes in markdown.
                
                Transcript:
                ${transcriptText.substring(0, 15000)}
                
                Format as JSON: {"summary": "...", "notes": "..."}
                `;

                const result = await model.generateContent(prompt);
                const response = await result.response;
                const aiData = extractJson(response.text());
                return NextResponse.json({ ...aiData, transcript: transcriptText });
            } catch (geminiError: any) {
                return NextResponse.json({
                    summary: "⚠️ Summary generation failed.",
                    notes: "N/A",
                    transcript: transcriptText
                });
            }
        } else {
            // Attempt 2: Audio extraction (Resource intensive)
            console.log("Attempting audio extraction...");
            try {
                const audioBuffer = await downloadAudioStream(url);

                const prompt = "Listen to this audio and generate: 1. A verbatim transcript (key 'transcript'). 2. A summary (key 'summary'). 3. Study notes in markdown (key 'notes'). Format as JSON.";

                const result = await model.generateContent([
                    prompt,
                    {
                        inlineData: {
                            data: audioBuffer.toString('base64'),
                            mimeType: "audio/mp4"
                        }
                    }
                ]);

                const aiData = extractJson((await result.response).text());
                return NextResponse.json(aiData);
            } catch (err: any) {
                console.error("Audio fallback failed:", err.message);
                return NextResponse.json({
                    error: "This video has no subtitles and audio extraction failed. Try a video with subtitles or a shorter one."
                }, { status: 500 });
            }
        }
    } catch (error: any) {
        console.error("API Route Error:", error);
        return NextResponse.json({ error: "A server error occurred. Please check your configuration." }, { status: 500 });
    }
}

async function downloadAudioStream(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        try {
            const stream = ytdl(url, {
                quality: 'lowestaudio',
                filter: 'audioonly',
                // Add some basic headers to avoid immediate blocking
                requestOptions: {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    }
                }
            });

            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('end', () => resolve(Buffer.concat(chunks)));
            stream.on('error', (err) => reject(err));

            setTimeout(() => {
                stream.destroy();
                reject(new Error("Audio processing timed out."));
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
        return { summary: "Error parsing AI response.", notes: text };
    }
}
