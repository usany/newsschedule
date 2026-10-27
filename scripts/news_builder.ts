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
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = path.join(ROOT, "_workspace");
const DEFAULT_INPUT = path.join(WORK, "03_news_scenario.md");

const DEFAULT_MODEL = "gemini-3.8-flash-lite-tts";
const DEFAULT_HOST_VOICE = "Kore";
const DEFAULT_REPORTER_VOICE = "Puck";
const DEFAULT_OUTPUT_DIR = path.join(ROOT, "store");

// Oracle Cloud Object Storage pre-authenticated request (PAR) URL.
// When set (via env `S3_ENDPOINT`), the audio is PUT directly to this
// pre-signed URL (`.../o/<filename>`). No bucket or credentials needed.
const DEFAULT_S3_ENDPOINT = "";

const WEEK_ORDINALS: Record<string, string> = {
  첫째: "w1", 둘째: "w2", 셋째: "w3", 넷째: "w4", 다섯째: "w5", 여섯째: "w6",
  "1째": "w1", "2째": "w2", "3째": "w3", "4째": "w4", "5째": "w5", "6째": "w6",
};

interface Options {
  input: string;
  outputDir: string;
  model: string;
  hostVoice: string;
  reporterVoice: string;
  s3Endpoint: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    input: DEFAULT_INPUT,
    outputDir: DEFAULT_OUTPUT_DIR,
    model: process.env.GEMINI_TTS_MODEL ?? DEFAULT_MODEL,
    hostVoice: process.env.HOST_VOICE ?? DEFAULT_HOST_VOICE,
    reporterVoice: process.env.REPORTER_VOICE ?? DEFAULT_REPORTER_VOICE,
    s3Endpoint: process.env.S3_ENDPOINT ?? DEFAULT_S3_ENDPOINT,
  };
  for (const a of argv) {
    if (a.startsWith("--input=")) opts.input = a.slice("--input=".length);
    else if (a.startsWith("--output=")) opts.outputDir = a.slice("--output=".length);
    else if (a.startsWith("--model=")) opts.model = a.slice("--model=".length);
    else if (a.startsWith("--host-voice=")) opts.hostVoice = a.slice("--host-voice=".length);
    else if (a.startsWith("--reporter-voice=")) opts.reporterVoice = a.slice("--reporter-voice=".length);
    else if (a.startsWith("--s3-endpoint=")) opts.s3Endpoint = a.slice("--s3-endpoint=".length);
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

/** Derive the week prefix like `2026_10_w4` from the scenario's title line. */
async function weekPrefix(scenarioPath: string): Promise<string | null> {
  try {
    const text = await fsp.readFile(scenarioPath, "utf8");
    // Match titles like "2026년 10월 4째 주" or "2026년 8월 둘째 주".
    const m = text.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2}째|[가-힣]+) ?주/);
    if (m) {
      const ord = m[3];
      const numMatch = ord.match(/^(\d{1,2})/);
      const w = numMatch ? `w${numMatch[1]}` : WEEK_ORDINALS[ord] ?? "w1";
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

/**
 * Call the Gemini TTS Interactions API directly.
 * Returns the audio bytes + mime type.
 */
async function synthesizeMultiSpeaker(
  key: string,
  model: string,
  hostVoice: string,
  reporterVoice: string,
  text: string,
): Promise<{ mimeType: string; data: Buffer }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/interactions?key=${key}`;

  // Build the content with multi-speaker annotations
  const content: Array<{
    type: string;
    text: string;
    annotations?: Array<{
      type: string;
      speaker?: string;
    }>;
  }> = [];

  // Parse speaker lines and build annotated content
  const lines = text.split("\n");
  for (const line of lines) {
    const hostMatch = line.match(/^호스트:\s*(.+)$/);
    const reporterMatch = line.match(/^리포터:\s*(.+)$/);

    if (hostMatch) {
      content.push({
        type: "text",
        text: hostMatch[1],
        annotations: [
          {
            type: "speech_metadata",
            speaker: "호스트",
          },
        ],
      });
    } else if (reporterMatch) {
      content.push({
        type: "text",
        text: reporterMatch[1],
        annotations: [
          {
            type: "speech_metadata",
            speaker: "리포터",
          },
        ],
      });
    }
  }

  const payload = {
    model,
    input: [
      {
        type: "user_input",
        content,
      },
    ],
    response_format: {
      type: "audio",
    },
    generation_config: {
      speech_config: {
        speakers: [
          { speaker: "호스트", voice: hostVoice },
          { speaker: "리포터", voice: reporterVoice },
        ],
      },
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    // Prevent silent stalls on CI runners; fail loudly so retry kicks in.
    // signal: AbortSignal.timeout(180_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} status code (${text})`);
  }

  const responseJson = await response.json() as any;

  // Extract audio from ALL response steps. The interactions API may split a
  // long generation across multiple `model_output` steps (especially under
  // load/latency, e.g. on GitHub Actions runners). Taking only the first step
  // truncates the scenario, which is why the audio "doesn't finish" in CI.
  const audioChunks: Buffer[] = [];
  if (responseJson.steps && Array.isArray(responseJson.steps)) {
    for (const step of responseJson.steps) {
      if (step.type === "model_output" && step.content) {
        for (const content of step.content) {
          if (content.type === "audio" && content.data) {
            audioChunks.push(Buffer.from(content.data, "base64"));
          }
        }
      }
    }
  }

  if (audioChunks.length === 0) {
    throw new Error("Gemini API returned no audio data in response");
  }

  console.log(
    `[news_builder] synthesized ${audioChunks.length} audio step(s) (total ${audioChunks.reduce((n, b) => n + b.length, 0)} bytes)`,
  );

  return {
    mimeType: audioChunks.length === 1 ? "audio/wav" : "audio/wav",
    data: Buffer.concat(audioChunks),
  };
}

/**
 * Upload wav file to an Oracle Cloud Object Storage pre-authenticated
 * request (PAR) URL. The endpoint is a pre-signed URL ending in `/o/`,
 * so we simply PUT the audio to `<endpoint><filename>`.
 */
async function uploadToS3(
  wav: Buffer,
  filename: string,
  endpoint: string,
): Promise<string> {
  // Strip any leading/trailing slashes so the object is stored directly at
  // the bucket/FAR root instead of under a `/` folder.
  const cleanName = filename.replace(/^\/+/, "").replace(/\/+$/, "");
  const base = endpoint.endsWith("/") ? endpoint : endpoint + "/";
  const uploadUrl = base + cleanName;

  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "audio/wav" },
    body: new Uint8Array(wav),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  return uploadUrl;
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

  const filename = `${(await weekPrefix(opts.input)) ?? "full_news"}_full_news.wav`;

  if (opts.s3Endpoint) {
    const url = await uploadToS3(data, filename, opts.s3Endpoint);
    console.log(
      `[news_builder] ✓ Storage upload SUCCESS: ${url} (${data.length} bytes, ${mimeType})`,
    );
  } else {
    await fsp.mkdir(opts.outputDir, { recursive: true });
    const outPath = path.join(opts.outputDir, filename);
    fs.writeFileSync(outPath, data);
    console.log(
      `[news_builder] ✓ Saved locally: ${outPath} (${data.length} bytes, ${mimeType})`,
    );
  }
}

main().catch((err) => {
  console.error("[news_builder] FATAL:", err);
  process.exit(1);
});
