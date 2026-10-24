/**
 * khu_crawler.ts — replaces the `collector` + `ocr-director` agents.
 *
 * What it does (mirrors .claude/agents/collector.md + ocr-director.md):
 *   1. Crawls the KHU notice board across 전체 categories (일반/학사/장학/근로/행사),
 *      walking pageIndex until the notices are no longer inside the target week
 *      (default = the current calendar week, Mon–Fri).
 *   2. Visits each notice detail page, extracts title / date / author / body text,
 *      and downloads any embedded content images to `_workspace/01_notice_images/`.
 *   3. For notices that HAVE images, runs easyocr (ko,en) via scripts/easyocr_helper.py
 *      and embeds the OCR text directly into `_workspace/01_notice.md`.
 *   4. Writes `_workspace/01_notice.md` and `_workspace/01_scraping_report.md`.
 *
 * Run (from repo root):
 *   npx tsx scripts/khu_crawler.ts                 # this calendar week (Mon–Fri)
 *   npx tsx scripts/khu_crawler.ts --week=2026-07-20
 *   npx tsx scripts/khu_crawler.ts --no-ocr         # skip easyocr (faster)
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = path.join(ROOT, "_workspace");
const IMG_DIR = path.join(WORK, "01_notice_images");
const NOTICE_MD = path.join(WORK, "01_notice.md");
const NOTICE_JSON = path.join(WORK, "01_notice.json");
const SCRAPE_MD = path.join(WORK, "01_scraping_report.md");
const HELPER = path.join(ROOT, "scripts", "easyocr_helper.py");
const PYTHON = process.env.PYTHON ?? "python3";

const BASE = "https://www.khu.ac.kr/kor/user/bbs/BMSR00040";

const CATEGORIES = [
  { name: "일반", menuNo: "200316" },
  { name: "학사", menuNo: "200317" },
  { name: "장학", menuNo: "200318" },
  { name: "근로", menuNo: "200361" },
  { name: "행사", menuNo: "200321" },
];

/** Leading region tags (공통/서울/국제/수원/안성) that we strip from the title text. */
const REGION_TOKEN = ["공통", "서울", "국제", "수원", "안성"];

/** URL patterns that are UI icons / emoji, never notice content. */
const IGNORE_IMG =
  /(resource\.stibee\.com\/editor|images\/icon|\/icon\/|fonts\.gstatic\.com|data:image\/svg|img\.tistory|^data:)/i;

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------
interface ListRow {
  boardId: string;
  category: string;
  title: string;
  writer?: string;
  date: string;
  hit?: string;
}

interface Notice {
  boardId: string;
  category: string;
  title: string;
  region: string;
  author: string;
  date: string;
  link: string;
  body: string;
  images: { src: string; file: string }[];
  scrapedOk: boolean;
}

interface OcrResult {
  file: string;
  text: string;
  count: number;
}

// ----------------------------------------------------------------------------
// Date helpers (local, week = Mon–Fri)
// ----------------------------------------------------------------------------
function toDateStr(d: Date): string {
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getDate()).padStart(2, "0")}`
  );
}

function getWeekRange(ref: Date): { mon: string; fri: string } {
  const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const diffToMon = (d.getDay() + 6) % 7; // 0 = Mon
  d.setDate(d.getDate() - diffToMon);
  const mon = toDateStr(d);
  const friD = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 4);
  return { mon, fri: toDateStr(friD) };
}

function parseArgs(argv: string[]) {
  const args = { week: "", ocr: true };
  for (const a of argv) {
    if (a.startsWith("--week=")) args.week = a.slice("--week=".length);
    else if (a === "--no-ocr") args.ocr = false;
    else if (a.startsWith("--week ")) args.week = a.slice("--week ".length + 1);
  }
  return args;
}

// ----------------------------------------------------------------------------
// Parsing
// ----------------------------------------------------------------------------
function extractBoardId(href: string | null): string | undefined {
  if (!href) return undefined;
  const m = href.match(/view\('(\d+)'/);
  return m ? m[1] : undefined;
}

async function parseListRows(page: Page): Promise<ListRow[]> {
  const rows = await page.$$("table.board01 tbody tr");
  const out: ListRow[] = [];
  for (const r of rows) {
    const tds = await r.$$("td");
    if (tds.length < 4) continue;
    const cells: string[] = [];
    for (const td of tds) {
      cells.push((await td.innerText()).replace(/\s+/g, " ").trim());
    }
    const a = await r.$('a[href*="javascript:view(\'"]');
    const boardId = extractBoardId(a ? await a.getAttribute("href") : null);
    if (!boardId) continue;

    // Title = <a> text with the region span (txtBox01) removed.
    let rawTitle = a ? ((await a.innerText()).replace(/\s+/g, " ").trim()) : "";
    const regionA = a ? await a.$("span.txtBox01") : null;
    let region = "";
    if (regionA) {
      region = (await regionA.innerText()).trim();
      // drop the leading region token from the title text, if present
      for (const tok of REGION_TOKEN) {
        if (rawTitle.startsWith(tok)) { rawTitle = rawTitle.slice(tok.length).trim(); break; }
      }
    }

    out.push({
      boardId,
      category: cells[0],
      title: rawTitle,
      writer: cells[2],
      date: cells[3],
      hit: cells[4],
      // region captured above
    } as ListRow & { region?: string });
  }
  return out;
}

async function parseDetail(page: Page, row: ListRow, menuNo: string): Promise<Notice> {
  await fsp.mkdir(IMG_DIR, { recursive: true });
  const link = `${BASE}/view.do?menuNo=${menuNo}&boardId=${row.boardId}&pageIndex=1`;

  const authorSel = await page.$(".row.clearfix .tit.txtWriter");
  const dateSel = await page.$(".dateBox .date");
  const titleSel = await page.$("p.txt06");
  let region = "";
  const regionSel = await page.$(".txtBox01");
  if (regionSel) region = (await regionSel.innerText()).trim();

  const contentSel = await page.$("div.row.contents.clearfix");
  let body = "";
  const rawImgs: { src: string }[] = [];
  if (contentSel) {
    body = ((await contentSel.innerText()) ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    const imgs = await contentSel.$$("img");
    const seen = new Set<string>();
    for (const img of imgs) {
      const src = await img.getAttribute("src");
      if (!src || IGNORE_IMG.test(src)) continue;
      if (/\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(src) === false) continue;
      if (seen.has(src)) continue;
      seen.add(src);
      rawImgs.push({ src });
    }
  }

  // Download images to _workspace/01_notice_images/
  const context = page.context();
  const images: Notice["images"] = [];
  for (let i = 0; i < rawImgs.length; i++) {
    const src = rawImgs[i].src;
    const res = await downloadImage(context, src, row.boardId, i + 1);
    if (res.file) images.push({ src, file: res.file });
  }

  return {
    boardId: row.boardId,
    category: row.category,
    title: titleSel ? (await titleSel.innerText()).replace(/\s+/g, " ").trim() : row.title,
    region,
    author: authorSel ? (await authorSel.innerText()).trim() : (row.writer ?? ""),
    date: dateSel ? (await dateSel.innerText()).trim() : row.date,
    link,
    body,
    images,
    scrapedOk: true,
  };
}

async function downloadImage(
  context: BrowserContext,
  url: string,
  boardId: string,
  idx: number,
): Promise<{ file?: string; error?: string }> {
  try {
    // Use a cross-origin incognito request (Cookie: none) to avoid login redirects.
    const res = await context.request.get(url, { timeout: 45_000 });
    if (!res.ok() || res.status() >= 400) {
      return { error: `HTTP ${res.status()}` };
    }
    const buf = await res.body();
    if (!buf || buf.length < 2000) return { error: "too small" };
    const ct = res.headers()["content-type"] || "";
    let ext = "jpg";
    if (/png/i.test(ct)) ext = "png";
    else if (/webp/i.test(ct)) ext = "webp";
    else if (/gif/i.test(ct)) ext = "gif";
    else {
      const urlExt = url.match(/\.(png|jpe?g|webp|gif)/i);
      if (urlExt) ext = urlExt[1].toLowerCase().replace("jpeg", "jpg");
    }
    const file = `${boardId}_img${idx}.${ext}`;
    await fsp.writeFile(path.join(IMG_DIR, file), buf);
    return { file, error: undefined };
  } catch (e) {
    return { error: String(e) };
  }
}

function stripRegion(title: string): string {
  const t = title.trim();
  for (const tok of REGION_TOKEN) {
    if (t.startsWith(tok + " ")) return t.slice(tok.length).trim();
  }
  return t;
}

// ----------------------------------------------------------------------------
// OCR (easyocr via python)
// ----------------------------------------------------------------------------
// easyocr holds the model + image tensors in a single python process; feeding the
// whole batch at once can exhaust RAM and get the process SIGKILLed (exit 137).
// Run small batches in separate subprocesses so memory is freed between them.
const OCR_BATCH_SIZE = 3;

async function runOcr(imagePaths: string[]): Promise<OcrResult[]> {
  if (imagePaths.length === 0) return [];
  const results: OcrResult[] = [];
  for (let i = 0; i < imagePaths.length; i += OCR_BATCH_SIZE) {
    const batch = imagePaths.slice(i, i + OCR_BATCH_SIZE);
    const { stdout } = await execFileAsync(PYTHON, [HELPER, ...batch], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
      // Belt-and-suspenders: ensure Python emits UTF-8 (Windows defaults to
      // cp949, which Node then decodes as UTF-8 and mangles Korean into '�').
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });
    const parsed = JSON.parse(stdout);
    results.push(...(parsed.result ?? []));
  }
  return results;
}

// ----------------------------------------------------------------------------
// Markdown / JSON writers
// ----------------------------------------------------------------------------
async function writeNoticeJson(week: { mon: string; fri: string }, notices: Notice[]) {
  const payload = {
    meta: {
      weekStart: week.mon,
      weekEnd: week.fri,
      generatedAt: toDateStr(new Date()),
      noticeCount: notices.filter((n) => n.scrapedOk).length,
      categories: CATEGORIES.map((c) => c.name),
    },
    notices: notices.map((n) => ({
      boardId: n.boardId,
      category: n.category,
      title: stripRegion(n.title),
      region: n.region,
      author: n.author,
      date: n.date,
      link: n.link,
      body: n.body,
      images: n.images.map((i) => ({ src: i.src, file: i.file })),
      scrapedOk: n.scrapedOk,
    })),
  };
  await fsp.writeFile(NOTICE_JSON, JSON.stringify(payload, null, 2), "utf8");
}

async function writeNoticeMd(
  week: { mon: string; fri: string },
  notices: Notice[],
  ocrByFile: Map<string, OcrResult>,
) {
  const lines: string[] = [];
  lines.push(`# 경희대학교 공지사항 (${week.mon} ~ ${week.fri})`);
  lines.push("");
  lines.push(`> 작성일: ${toDateStr(new Date())} | 스크래핑된 해당 주차(월~금) 공지사항`);
  lines.push("");
  const today = toDateStr(new Date());
  void today;

  for (const cat of CATEGORIES) {
    const kept = notices.filter((n) => n.scrapedOk && n.category === cat.name);
    if (kept.length === 0) continue;
    lines.push(`## ${cat.name} (${kept.length}건)`);
    lines.push("");
    for (const n of kept) {
      const titleForHeader = [n.title].join(" ");
      lines.push(`### [${n.date}] ${stripRegion(titleForHeader)}`);
      lines.push("");
      lines.push(`- 작성자: ${n.author}`);
      lines.push(`- 링크: ${n.link}`);
      lines.push("");
      lines.push(n.body);
      lines.push("");
      if (n.images.length) {
        lines.push(`- 포함 이미지: ${n.images.map((i) => i.file).join(", ")}`);
        lines.push("");
        for (const img of n.images) {
          const r = ocrByFile.get(img.file);
          lines.push(`- ${img.file} OCR 텍스트:`);
          lines.push("```");
          lines.push(r?.text ?? "[OCR 실패 또는 텍스트 없음]");
          lines.push("```");
          lines.push("");
        }
      }
    }
  }
  await fsp.writeFile(NOTICE_MD, lines.join("\n"), "utf8");
}

async function writeScrapeMd(week: { mon: string; fri: string }, notices: Notice[]) {
  const lines: string[] = [];
  lines.push("# 스크래핑 보고서");
  lines.push("");
  lines.push(`- 수집 대상 기간: ${week.mon}(월) ~ ${week.fri}(금)`);
  lines.push(`- 전체 카테고리: ${CATEGORIES.map((c) => c.name).join(" / ")} (${CATEGORIES.length}개)`);
  const ok = notices.filter((n) => n.scrapedOk);
  lines.push(`- 수집된 공지 수: ${ok.length}건`);
  lines.push(`- 다운로드 이미지 디렉토리: _workspace/01_notice_images/`);
  lines.push("");
  lines.push("## 항목별 결과");
  lines.push("");
  for (const n of notices) {
    const imgNote = n.images.length ? `imgs=${n.images.map((i) => i.file).join(",")}` : "imgs=0";
    let status = "OK";
    if (!n.scrapedOk) status = "FAIL";
    lines.push(
      `- ${n.boardId} [${n.category}] ${stripRegion(n.title)} (${n.date}): ${status}, ${imgNote}`,
    );
  }
  await fsp.writeFile(SCRAPE_MD, lines.join("\n"), "utf8");
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main() {
  const { week, ocr } = parseArgs(process.argv.slice(2));
  const ref = week ? new Date(`${week}T00:00:00`) : new Date();
  if (Number.isNaN(ref.getTime())) {
    console.error(`[crawler] invalid --week value: ${week}`);
    process.exit(1);
  }
  const wk = getWeekRange(ref);
  console.log(`[crawler] target week: ${wk.mon} ~ ${wk.fri} (OCR: ${ocr ? "on" : "off"})`);

  await fsp.mkdir(WORK, { recursive: true });
  await fsp.mkdir(IMG_DIR, { recursive: true });
  // clear stale images from previous runs
  for (const f of await fsp.readdir(IMG_DIR)) {
    await fsp.rm(path.join(IMG_DIR, f), { force: true });
  }

  const browser: Browser = await chromium.launch({ headless: true });
  const context: BrowserContext = await browser.newContext({ locale: "ko-KR" });
  const page: Page = await context.newPage();

  const notices: Notice[] = [];

  for (const cat of CATEGORIES) {
    let pageIndex = 1;
    console.log(`[crawler] category ${cat.name} (menuNo=${cat.menuNo})`);
    for (; ;) {
      const listUrl = `${BASE}/list.do?menuNo=${cat.menuNo}&pageIndex=${pageIndex}`;
      await page.goto(listUrl, { waitUntil: "networkidle", timeout: 60_000 });
      const rows = await parseListRows(page);
      if (rows.length === 0) break;

      let pageFullyOld = true;
      for (const row of rows) {
        if (row.date >= wk.mon && row.date <= wk.fri) {
          pageFullyOld = false;
          // fetch detail
          const detailUrl = `${BASE}/view.do?menuNo=${cat.menuNo}&boardId=${row.boardId}&pageIndex=1`;
          try {
            await page.goto(detailUrl, { waitUntil: "networkidle", timeout: 60_000 });
            const n = await parseDetail(page, { ...row, category: cat.name }, cat.menuNo);
            notices.push(n);
            console.log(
              `  [${row.date}] #${n.boardId} ${n.title.slice(0, 40)} (imgs=${n.images.length})`,
            );
          } catch (e) {
            console.error(`  [ERROR] #${row.boardId} ${row.title}: ${String(e)}`);
            notices.push({
              boardId: row.boardId,
              category: cat.name,
              title: row.title,
              region: "",
              author: row.writer ?? "",
              date: row.date,
              link: detailUrl,
              body: "",
              images: [],
              scrapedOk: false,
            });
          }
        } else if (row.date > wk.fri) {
          // future (e.g. pinned newer items) — keep walking forward
          pageFullyOld = false;
        }
        // else row.date < wk.mon → older than target week
      }

      if (pageFullyOld) {
        console.log(`  (page ${pageIndex}: all older than ${wk.mon}, stop)`);
        break;
      }
      pageIndex++;
    }
  }

  await browser.close();

  // OCR the images first so the notice markdown can embed the results
  const ocrByFile = new Map<string, OcrResult>();
  if (ocr) {
    const allImages = notices
      .flatMap((n) => n.images.map((i) => i.file))
      .filter((f) => f);
    console.log(`[crawler] running easyocr on ${allImages.length} image(s)...`);
    if (allImages.length) {
      const imagePaths = allImages.map((f) => path.join(IMG_DIR, f));
      try {
        const results = await runOcr(imagePaths);
        for (const r of results) ocrByFile.set(r.file, r);
        console.log(`[crawler] OCR complete: ${results.length} file(s)`);
      } catch (e) {
        console.error(`[crawler] OCR failed: ${String(e)}`);
      }
    }
  }

  // Write scraping outputs (OCR text is embedded directly in the notice md)
  await writeNoticeMd(wk, notices, ocrByFile);
  await writeNoticeJson(wk, notices);
  await writeScrapeMd(wk, notices);

  console.log(`[crawler] done. ${notices.length} notices written to ${NOTICE_MD} and ${NOTICE_JSON}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
