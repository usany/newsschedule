/**
 * scenarist.ts — generates a radio news scenario using the OpenAI SDK with Gemini API.
 *
 * Mirrors `.claude/agents/scenarist.md`:
 *   1. Reads the notice file `_workspace/01_notice.md`
 *   2. Summarizes the notice contents
 *   3. Writes a two-person (host, reporter) radio news scenario
 *      (do not repeat the same comment from both host and reporter,
 *       include all notices, only readable texts)
 *   4. Writes the result to `_workspace/03_news_scenario.md`
 *
 * Uses `openai` SDK with Gemini API (via Google Cloud).
 *
 * Requires GOOGLE_API_KEY environment variable or configure your credentials.
 *
 * Run (from repo root):
 *   npx tsx scripts/scenarist.ts
 *   npx tsx scripts/scenarist.ts --input=_workspace/01_notice.md
 *   npx tsx scripts/scenarist.ts --output=_workspace/03_news_scenario.md
 *   npx tsx scripts/scenarist.ts --model=gemini-2.0-flash
 */
import OpenAI from "openai";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = path.join(ROOT, "_workspace");
const DEFAULT_INPUT = path.join(WORK, "01_notice.md");
const DEFAULT_OUTPUT = path.join(WORK, "03_news_scenario.md");

// Gemini model to use. Override via GEMINI_MODEL or --model.
const DEFAULT_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";

function parseArgs(argv: string[]) {
  const args: { input: string; output: string; model: string } = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    model: DEFAULT_MODEL,
  };
  for (const a of argv) {
    if (a.startsWith("--input=")) args.input = a.slice("--input=".length);
    else if (a.startsWith("--output=")) args.output = a.slice("--output=".length);
    else if (a.startsWith("--model=")) args.model = a.slice("--model=".length);
  }
  return args;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function buildPrompt(noticeMarkdown: string): string {
  return [
    "You are the Scenarist agent for a university radio news program at Kyung Hee University.",
    "",
    "입력으로 주어지는 금주 공지사항을 읽고, 다음 원칙을 지켜 호스트(앵커) 1명과 리포터 1명의 radio news 시나리오를 한국어로 작성한다. 호스트와 리포터의 이름은 언급하지 않는다.",
    "",
    "## 작업 원칙",
    "1. **do not repeat** — 호스트와 리포터가 같은 내용을 반복하지 않도록 한다.",
    "2. **only readable texts** — 읽을 수 없는 텍스트는 시나리오에 가져오지 않는다.",
    "3. **all notices** — 모든 공지를 빠짐없이 포함한다. 공지가 많으면 뉴스 섹션(뉴스 1, 뉴스 2, ...)으로 묶어 정리한다.",
    "",
    "## 출력 형식 (반드시 아래 마크다운 구조)",
    "```",
    "# {YYYY년 M월 N째 주} 경희대학교 라디오 뉴스 시나리오",
    "",
    "> 근거 자료: `_workspace/01_notice.md`",
    "> 형식: 호스트(앵커) + 리포터 2인 라디오 뉴스",
    "",
    "## 오프닝",
    "**호스트:** ...",
    "**리포터:** ...",
    "",
    "## 뉴스 1 — {제목}",
    "**리포터:** ...",
    "**호스트:** ...",
    "...",
    "",
    "## 클로징",
    "**호스트:** ...",
    "**리포터:** ...",
    "**호스트:** ...",
    "```",
    "",
    "Write the scenario to a markdown file named `03_news_scenario.md`.",
    "",
    "---",
    "아래는 이번 주 공지사항 원문이다.",
    "---",
    "",
    noticeMarkdown,
  ].join("\n");
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  // 1. Read the notice file.
  let noticeMarkdown: string;
  try {
    noticeMarkdown = await fsp.readFile(args.input, "utf8");
  } catch (err) {
    console.error(`[scenarist] ERROR: cannot read input file: ${args.input}\n  ${err}`);
    process.exit(1);
  }
  if (!noticeMarkdown.trim()) {
    console.error(`[scenarist] ERROR: input file is empty: ${args.input}`);
    process.exit(1);
  }
  console.log(`[scenarist] read ${noticeMarkdown.length} chars from ${args.input}`);

  // 2. Initialize OpenAI client with Gemini API.
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[scenarist] ERROR: GEMINI_API_KEY environment variable not set");
    process.exit(1);
  }

  const client = new OpenAI({
    apiKey: apiKey,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
  });

  try {
    // 3. Call the Gemini API with the scenarist prompt.
    console.log(`[scenarist] sending scenarist prompt to ${args.model}...`);
    const prompt = buildPrompt(noticeMarkdown);

    const response = await client.chat.completions.create({
      model: args.model,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    // 4. Extract the generated scenario text.
    const scenarioText = response.choices[0].message.content || "";

    if (!scenarioText) {
      throw new Error("No text content in response from Gemini");
    }

    // 5. Write the scenario to the output file.
    const outputDir = path.dirname(args.output);
    await fsp.mkdir(outputDir, { recursive: true });
    await fsp.writeFile(args.output, scenarioText, "utf8");

    console.log(`[scenarist] DONE — wrote ${scenarioText.length} chars to ${args.output}`);
  } catch (err) {
    console.error("[scenarist] ERROR:", err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[scenarist] FATAL:", err);
  process.exit(1);
});