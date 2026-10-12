/**
 * news_builder.mts — replaces the `news-builder` agent using the Gemini TTS API.
 *
 * Mirrors `.claude/agents/news-builder.md`. Uses Gemini's native MULTI-SPEAKER
 * TTS so a SINGLE request produces one audio file with TWO different voices
 * (host & reporter), which also fits within the free-tier quota.
 *
 *   1. Reads the scenario file `_workspace/03_news_scenario.md`
 *   2. Parses the host(호스트)/reporter(리포터) speaker lines
 *   3. Sends the whole scenario as a conversation (with speaker labels) in ONE
 *      call, mapping each speaker name to its own voice via
 *      `multiSpeakerVoiceConfig`
 *   4. Writes the single produced audio to `_workspace/04_news_files/{week}_full_news.wav`
 *
 * Reference: https://ai.google.dev/gemini-api/docs/speech-generation
 *   Multi-speaker: a `multiSpeakerVoiceConfig` object with each speaker (up to 2)
 *   configured as a `speakerVoiceConfig`. Speaker names must match the labels
 *   used in the prompt text.
 *
 * API key: read from `GEMINI_API_KEY` in `.env` (or env var).
 * Voices: `--host-voice` / `--reporter-voice` (or HOST_VOICE / REPORTER_VOICE).
 * Available Gemini TTS prebuilt voices include:
 *   Puck, Charon, Kore, Fenrir, Aoede, Zephyr, Calliope, Leda, Orus
 *
 * Run (from repo root):
 *   npx tsx scripts/news_builder.mts
 *   npx tsx scripts/news_builder.mts --host-voice=Kore --reporter-voice=Puck
 *   npx tsx scripts/news_builder.mts --input=... --output=...
 */
import * as fsp from "node:fs/promises";
import * as fss from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = path.join(ROOT, "_workspace");
const DEFAULT_INPUT = path.join(WORK, "03_news_scenario.md");
const DEFAULT_OUTPUT_DIR = path.join(ROOT, "store");

const DEFAULT_MODEL = "gemini-3.1-flash-tts-preview";
const DEFAULT_HOST_VOICE = "Kore";
const DEFAULT_REPORTER_VOICE = "Puck";

// Oracle Cloud Object Storage (S3-compatible)
// Note: When using Oracle Cloud pre-signed URLs, the endpoint already includes the namespace and bucket path.
// In that case, set the endpoint correctly to avoid pathing issues.
const DEFAULT_S3_ENDPOINT = "https://objectstorage.ap-chuncheon-1.oraclecloud.com";
const DEFAULT_S3_REGION = "ap-chuncheon-1";

const WEEK_ORDINALS: Record<string, string> = {
  첫째: "w1", 둘째: "w2", 셋째: "w3", 넷째: "w4", 다섯째: "w5", 여섯째: "w6",
};

const SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

interface Options {
  input: string;
  outputDir: string;
  model: string;
  hostVoice: string;
  reporterVoice: string;
  s3Endpoint: string;
  s3Region: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    input: DEFAULT_INPUT,
    outputDir: DEFAULT_OUTPUT_DIR,
    model: process.env.GEMINI_TTS_MODEL ?? DEFAULT_MODEL,
    hostVoice: process.env.HOST_VOICE ?? DEFAULT_HOST_VOICE,
    reporterVoice: process.env.REPORTER_VOICE ?? DEFAULT_REPORTER_VOICE,
    s3Endpoint: process.env.S3_ENDPOINT ?? DEFAULT_S3_ENDPOINT,
    s3Region: process.env.S3_REGION ?? DEFAULT_S3_REGION,
    s3AccessKey: process.env.S3_ACCESS_KEY,
    s3SecretKey: process.env.S3_SECRET_KEY,
  };
  for (const a of argv) {
    if (a.startsWith("--input=")) opts.input = a.slice("--input=".length);
    else if (a.startsWith("--output=")) opts.outputDir = a.slice("--output=".length);
    else if (a.startsWith("--model=")) opts.model = a.slice("--model=".length);
    else if (a.startsWith("--host-voice=")) opts.hostVoice = a.slice("--host-voice=".length);
    else if (a.startsWith("--reporter-voice=")) opts.reporterVoice = a.slice("--reporter-voice=".length);
    else if (a.startsWith("--s3-endpoint=")) opts.s3Endpoint = a.slice("--s3-endpoint=".length);
    else if (a.startsWith("--s3-region=")) opts.s3Region = a.slice("--s3-region=".length);
  }
  return opts;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/** Read the Gemini API key from `.env` (KEY=VALUE lines) or the environment. */
async function loadApiKey(): Promise<string | null> {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try {
    const env = await fsp.readFile(path.join(ROOT, ".env"), "utf8");
    for (const raw of env.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("GEMINI_API_KEY")) {
        const v = line.split("=", 2)[1].trim();
        return v.replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* .env missing — fall through */
  }
  return null;
}

/** Derive the week prefix like `2026_08_w2` from the scenario's first line. */
async function weekPrefix(scenarioPath: string): Promise<string | null> {
  try {
    const first = (await fsp.readFile(scenarioPath, "utf8")).split("\n", 1)[0];
    const m = first.match(/(\d{4})년\s*(\d{1,2})월\s*([가-힣]+) 주/);
    if (m) {
      const w = WEEK_ORDINALS[m[3]] ?? "w1";
      return `${m[1]}_${String(parseInt(m[2], 10)).padStart(2, "0")}_${w}`;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Extract (speaker, text) pairs from `**호스트:** ...` / `**리포터:** ...` lines. */
function parseScenario(markdown: string): Array<[string, string]> {
  const lines: Array<[string, string]> = [];
  for (const raw of markdown.split("\n")) {
    const m = raw.trim().match(/^\*\*(호스트|리포터):\*\*\s*(.*)$/);
    if (m && m[2].trim()) lines.push([m[1], m[2].trim()]);
  }
  return lines;
}

/** Build the multi-speaker conversation prompt with speaker labels. */
function buildConversation(lines: Array<[string, string]>): string {
  const speakers = ["호스트", "리포터"];
  const dialogue = lines.map(([sp, text]) => `${sp}: ${text}`).join("\n");
  return `TTS the following conversation between 호스트 and 리포터:\n${dialogue}\n\n(speakers: ${speakers.join(", ")})`;
}

/** Build the wav header for raw PCM L16/SAMPLE_RATE mono. */
function wavHeader(pcmLength: number): Buffer {
  const byteRate = SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
  const blockAlign = NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(NUM_CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmLength, 40);
  return header;
}

/**
 * Call the Gemini TTS generateContent endpoint.
 * Returns the audio bytes + mime type.
 */
async function synthesizeMultiSpeaker(
  key: string,
  model: string,
  hostVoice: string,
  reporterVoice: string,
  text: string,
): Promise<{ mimeType: string; data: Buffer }> {
  const payload = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: [
            {
              speaker: "호스트",
              voiceConfig: { prebuiltVoiceConfig: { voiceName: hostVoice } },
            },
            {
              speaker: "리포터",
              voiceConfig: { prebuiltVoiceConfig: { voiceName: reporterVoice } },
            },
          ],
        },
      },
    },
  };

  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) +
      ":generateContent?key=" +
      encodeURIComponent(key),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );

  if (!res.ok) {
    throw new Error(`Gemini API HTTP ${res.status}: ${await res.text()}`);
  }

  const json: any = await res.json();
  const candidates = json?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error(`Gemini API returned no candidates: ${JSON.stringify(json)}`);
  }
  const parts = candidates[0]?.content?.parts ?? [];
  for (const part of parts) {
    if (part?.inlineData?.data) {
      return {
        mimeType: part.inlineData.mimeType ?? "audio/L16",
        data: Buffer.from(part.inlineData.data, "base64"),
      };
    }
  }
  throw new Error(`Gemini API returned no audio: ${JSON.stringify(json)}`);
}

/** Convert audio bytes (given their mimeType) into a full WAV file buffer. */
function toWav(mimeType: string, audio: Buffer): Buffer {
  const mime = mimeType.toLowerCase();

  if (mime.includes("wav")) return audio;

  if (mime.includes("mp3") || mime.includes("mpeg")) {
    const mp3 = path.join(os.tmpdir(), `news_builder_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);
    const wav = path.join(os.tmpdir(), `news_builder_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
    fss.writeFileSync(mp3, audio);
    try {
      convertMp3ToWav(mp3, wav);
      return fss.readFileSync(wav);
    } finally {
      fss.rmSync(mp3, { force: true });
      fss.rmSync(wav, { force: true });
    }
  }

  // Raw PCM L16 / SAMPLE_RATE / mono — wrap with a wav header.
  return Buffer.concat([wavHeader(audio.length), audio]);
}

/** Convert an MP3 file to 16-bit PCM WAV using `ffmpeg` (override binary via FFMPEG). */
function convertMp3ToWav(mp3Path: string, wavPath: string): void {
  const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
  const r = spawnSync(ffmpeg, ["-y", "-loglevel", "error", "-i", mp3Path, "-c:a", "pcm_s16le", wavPath], {
    encoding: "utf8",
    timeout: 300_000,
  });
  if (r.status !== 0) {
    throw new Error(`ffmpeg failed: ${r.stderr?.trim() || r.error?.message || "unknown"}`);
  }
}

/** Upload wav file to Oracle Cloud Object Storage (S3-compatible). */
async function uploadToS3(
  wav: Buffer,
  filename: string,
  opts: Options,
): Promise<{ success: boolean; url?: string; error?: string }> {
  try {
    // If S3_ENDPOINT from .env is a pre-signed URL, use it directly
    const endpoint = opts.s3Endpoint;
    const isPresignedUrl = endpoint.includes("/p/") && endpoint.includes("/n/");
    
    if (isPresignedUrl) {
      // Oracle Cloud pre-signed URL: append filename to the endpoint
      const uploadUrl = endpoint.endsWith("/") ? endpoint + filename : endpoint + "/" + filename;
      const response = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: wav,
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }
      
      // Return the URL without the trailing filename since the pre-signed URL is already the bucket path
      const url = endpoint.endsWith("/") ? endpoint + filename : endpoint + "/" + filename;
      return { success: true, url };
    } else {
      // For non-pre-signed URLs, use fetch with the endpoint
      const uploadUrl = endpoint.endsWith("/") ? endpoint + filename : endpoint + "/" + filename;
      const response = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: wav,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      const url = uploadUrl;
      return { success: true, url };
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: errorMsg };
  }
}

/** Synthesize, retrying transient API errors and honoring RetryInfo delays. */
async function synthesizeWithRetry(
  key: string,
  model: string,
  hostVoice: string,
  reporterVoice: string,
  text: string,
): Promise<{ mimeType: string; data: Buffer }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await synthesizeMultiSpeaker(key, model, hostVoice, reporterVoice, text);
    } catch (err) {
      lastErr = err;
      const msg = (err as Error).message;
      // Respect the API-provided retry delay if present, else back off.
      const delayMatch = msg.match(/retryDelay.?[:\s]*"(\d+\.?\d*)s"/i);
      const retryDelay = delayMatch ? parseFloat(delayMatch[1]) * 1000 : attempt * 8000;
      console.log(`  attempt ${attempt} failed (${msg.split("\n")[0]}); retrying in ${Math.round(retryDelay / 1000)}s`);
      await new Promise((r) => setTimeout(r, retryDelay));
    }
  }
  throw new Error(`failed after 5 attempts: ${(lastErr as Error)?.message}`);
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const key = await loadApiKey();
  if (!key) {
    console.error("[news_builder] ERROR: GEMINI_API_KEY not found in .env or environment.");
    process.exit(1);
  }

  let scenario: string;
  try {
    scenario = await fsp.readFile(opts.input, "utf8");
  } catch (err) {
    console.error(`[news_builder] ERROR: cannot read input file: ${opts.input}\n  ${err}`);
    process.exit(1);
  }
  if (!scenario.trim()) {
    console.error(`[news_builder] ERROR: input file is empty: ${opts.input}`);
    process.exit(1);
  }

  const lines = parseScenario(scenario);
  const prompt = buildConversation(lines);
  const outPath = path.join(
    opts.outputDir,
    `${(await weekPrefix(opts.input)) ?? "full_news"}_full_news.wav`,
  );

  console.log(
    `[news_builder] ${lines.length} speaker lines (${prompt.length} chars) → single multi-speaker TTS call`,
  );
  console.log(
    `[news_builder] model=${opts.model} | host=${opts.hostVoice}, reporter=${opts.reporterVoice}`,
  );

  const { mimeType, data } = await synthesizeWithRetry(
    key,
    opts.model,
    opts.hostVoice,
    opts.reporterVoice,
    prompt,
  );
  const wav = toWav(mimeType, data);

  const filename = path.basename(outPath);
  const seconds = wav.subarray(44).length / (SAMPLE_RATE * 2);
  const result = await uploadToS3(wav, filename, opts);
  
  if (result.success && result.url) {
    console.log(
      `[news_builder] ✓ Storage upload SUCCESS: ${result.url} (${wav.length} bytes, ~${seconds.toFixed(1)}s, ${mimeType})`,
    );
  } else {
    console.error(
      `[news_builder] ✗ Storage upload FAILED: ${result.error}`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[news_builder] FATAL:", err);
  process.exit(1);
});