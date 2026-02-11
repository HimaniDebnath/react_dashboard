import { NextRequest, NextResponse } from "next/server";
import { YoutubeTranscript } from "youtube-transcript";
import { GoogleGenerativeAI } from "@google/generative-ai";
import ytdl from "@distube/ytdl-core";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
export const maxDuration = 60;

const YTDLP_PATH = path.join(process.cwd(), ".venv/bin/yt-dlp");

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

        // --- PHASE 1: TRANSCRIPT SEARCH ---

        // method 1: YoutubeTranscript (Fastest)
        try {
            console.log(`[Phase 1.1] YoutubeTranscript for: ${videoId}`);
            const transcript = await YoutubeTranscript.fetchTranscript(videoId);
            if (transcript && transcript.length > 0) {
                transcriptText = transcript.map(t => t.text).join("\n");
                console.log("[Phase 1.1] Success.");
            }
        } catch (e) {
            console.warn("[Phase 1.1] Failed.");
        }

        // method 2: yt-dlp subtitles (Local Robust)
        if (!transcriptText && fs.existsSync(YTDLP_PATH)) {
            try {
                console.log(`[Phase 1.2] yt-dlp subtitles for: ${videoId}`);
                transcriptText = await fetchSubtitleWithYtDlp(url);
                if (transcriptText) console.log("[Phase 1.2] Success.");
            } catch (e) {
                console.warn("[Phase 1.2] Failed.");
            }
        }

        // method 3: ytdl-core metadata (Vercel Fallback)
        if (!transcriptText) {
            try {
                console.log(`[Phase 1.3] ytdl-core metadata for: ${videoId}`);
                const info = await ytdl.getInfo(url);
                const tracks = info.player_response.captions?.playerCaptionsTracklistRenderer?.captionTracks;
                if (tracks && tracks.length > 0) {
                    const track = tracks.find((t: any) => t.languageCode === 'en') || tracks[0];
                    if (track) {
                        const res = await fetch(track.baseUrl);
                        const xml = await res.text();
                        transcriptText = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                        console.log("[Phase 1.3] Success.");
                    }
                }
            } catch (e) {
                console.warn("[Phase 1.3] Failed.");
            }
        }

        const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

        if (transcriptText && transcriptText.length > 100) {
            console.log("[Gemini] Processing via Transcript");
            const prompt = `Analyze this YouTube transcript and generate:
            1. A concise summary (2-3 paragraphs).
            2. Structured study notes in markdown.
            
            Transcript:
            ${transcriptText.substring(0, 20000)}
            
            Format as JSON: {"summary": "...", "notes": "..."}`;

            const result = await model.generateContent(prompt);
            const aiData = extractJson((await result.response).text());
            return NextResponse.json({ ...aiData, transcript: transcriptText });
        } else {
            // --- PHASE 2: AUDIO EXTRACTION ---
            console.log("[Phase 2] No transcript found. Attempting Audio fallback.");

            let audioBuffer: Buffer | null = null;

            // method 1: yt-dlp audio (Local Robust)
            if (fs.existsSync(YTDLP_PATH)) {
                try {
                    console.log("[Phase 2.1] yt-dlp audio download...");
                    audioBuffer = await downloadAudioYtDlp(url);
                    if (audioBuffer) console.log("[Phase 2.1] Success.");
                } catch (e) {
                    console.warn("[Phase 2.1] Failed.");
                }
            }

            // method 2: ytdl-core audio (Vercel Fallback)
            if (!audioBuffer) {
                try {
                    console.log("[Phase 2.2] ytdl-core audio download...");
                    audioBuffer = await downloadAudioYtdlCore(url);
                    if (audioBuffer) console.log("[Phase 2.2] Success.");
                } catch (e) {
                    console.warn("[Phase 2.2] Failed.");
                }
            }

            if (audioBuffer) {
                console.log(`[Gemini] Processing via Audio (${(audioBuffer.length / 1024 / 1024).toFixed(2)}MB)`);
                const prompt = "Listen to this audio and generate: 1. Verbatim transcript (key 'transcript'). 2. Summary (key 'summary'). 3. Study notes in markdown (key 'notes'). Format as JSON.";
                const result = await model.generateContent([
                    prompt,
                    { inlineData: { data: audioBuffer.toString('base64'), mimeType: "audio/mp4" } }
                ]);
                const aiData = extractJson((await result.response).text());
                return NextResponse.json(aiData);
            }

            return NextResponse.json({
                error: "Unable to extract content from this video. It might be too long, private, or age-restricted. Try a shorter video with subtitles."
            }, { status: 500 });
        }
    } catch (error: any) {
        console.error("Critical Failure:", error);
        return NextResponse.json({ error: "Server encountered an error processing this request." }, { status: 500 });
    }
}

// Helper: yt-dlp Subtitles
async function fetchSubtitleWithYtDlp(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = spawn(YTDLP_PATH, ['--dump-json', '--skip-download', '--write-auto-subs', '--sub-langs', 'en.*', url]);
        let data = "";
        proc.stdout.on('data', d => data += d);
        proc.on('close', async (code) => {
            if (code !== 0) return resolve("");
            try {
                const info = JSON.parse(data);
                const autoSubs = info.automatic_captions || {};
                const subs = info.subtitles || {};
                const enSubs = subs.en || autoSubs.en;
                if (!enSubs) return resolve("");
                const format = enSubs.find((f: any) => f.ext === 'json3') || enSubs[0];
                const res = await fetch(format.url);
                const json = await res.json();
                const text = json.events?.map((e: any) => e.segs ? e.segs.map((s: any) => s.utf8).join("") : "").join(" ") || "";
                resolve(text);
            } catch (e) { resolve(""); }
        });
    });
}

// Helper: yt-dlp Audio
async function downloadAudioYtDlp(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const proc = spawn(YTDLP_PATH, ['-f', 'bestaudio[ext=m4a]', '-o', '-', '--quiet', '--no-playlist', '--max-filesize', '19M', url]);
        const chunks: Buffer[] = [];
        proc.stdout.on('data', (chunk) => chunks.push(chunk));
        proc.on('close', (code) => code === 0 && chunks.length > 0 ? resolve(Buffer.concat(chunks)) : reject(new Error("yt-dlp failed")));
    });
}

// Helper: ytdl-core Audio
async function downloadAudioYtdlCore(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const stream = ytdl(url, { quality: 'lowestaudio', filter: 'audioonly' });
        stream.on('data', chunk => chunks.push(chunk));
        stream.once('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', e => reject(e));
        setTimeout(() => { stream.destroy(); reject(new Error("Timeout")); }, 30000);
    });
}

function extractJson(text: string) {
    try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        return JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch {
        return { summary: "Summary generation failed.", notes: text, transcript: "Transcript unavailable." };
    }
}
