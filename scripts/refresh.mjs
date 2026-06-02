#!/usr/bin/env node
/**
 * GrantRadar refresh — OpenAI edition.
 *
 * Replaces the old Perplexity Computer agent. The LLM only *proposes* new
 * grants; this script validates everything deterministically and the test
 * suite (run by the workflow) is the final gate. A bad API response can add
 * nothing invalid — at worst it adds nothing.
 *
 * Env:
 *   OPENAI_API_KEY  (required)
 *   OPENAI_MODEL    (optional, default "gpt-4.1")
 *   OPENAI_SEARCH_TOOL (optional, default "web_search_preview")
 *
 * No npm dependencies — uses Node 20+ global fetch.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = join(ROOT, "index.html");
const SENTINEL = "  // @@GRANTS_END@@";

// ── Allowed values (must mirror grantradar-tests.js) ────────────────────────
const VALID_STATUSES   = new Set(["open", "upcoming", "closed"]);
const VALID_FUNDERS    = new Set(["Innovate UK","UKRI","SBRI","Wellcome Trust","EIC Europe","Horizon Europe","EIT Europe","Eureka","ERC"]);
const VALID_SECTORS    = new Set(["AI","Advanced Manufacturing","Agritech","Biotech","Clean Tech","Deep Tech","Digital","Energy","Health","Mobility","Social Sciences"]);
const VALID_CURRENCIES = new Set(["gbp","eur"]);
const FUNDER_PREFIX = {
  "Innovate UK":"iuk", "UKRI":"ukri", "SBRI":"sbri", "Wellcome Trust":"wt",
  "EIC Europe":"eic", "Horizon Europe":"he", "EIT Europe":"eit",
  "Eureka":"eureka", "ERC":"erc",
};

const TODAY = new Date(); TODAY.setHours(0,0,0,0);
const todayISO = TODAY.toISOString().slice(0,10);

// ── Load file & locate the GRANTS region ────────────────────────────────────
let html = readFileSync(HTML, "utf8");
const startIdx = html.indexOf("const GRANTS = [");
const sentIdx  = html.indexOf(SENTINEL);
if (startIdx === -1 || sentIdx === -1) {
  console.error("FATAL: could not locate GRANTS array or @@GRANTS_END@@ sentinel.");
  process.exit(1);
}
const region = html.slice(startIdx, sentIdx); // existing grant lines live here

// Extract existing urls / titles / ids for dedupe and id allocation.
const existingUrls   = new Set([...region.matchAll(/url:"([^"]+)"/g)].map(m => m[1].toLowerCase()));
const existingTitles = new Set([...region.matchAll(/title:"([^"]+)"/g)].map(m => m[1].toLowerCase()));
const existingIds    = [...region.matchAll(/id:"([^"]+)"/g)].map(m => m[1]);

function nextId(funder) {
  const pref = FUNDER_PREFIX[funder];
  let max = 0;
  for (const id of existingIds) {
    const m = id.match(new RegExp(`^${pref}-(\\d+)$`));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  const id = `${pref}-${String(max + 1).padStart(2, "0")}`;
  existingIds.push(id); // reserve so the next new grant of same funder increments
  return id;
}

// ── Step 1: mark past-deadline grants closed (deterministic, no LLM) ─────────
// Keep a closed call as a record until 14 days after its deadline, then drop it.
const CUTOFF = new Date(TODAY); CUTOFF.setDate(CUTOFF.getDate() - 14);
const cutoffISO = CUTOFF.toISOString().slice(0, 10);
let expiredCount = 0, droppedCount = 0;
const newRegion = region.split("\n").map((line) => {
  const dlm = line.match(/deadline:"(\d{4}-\d{2}-\d{2})"/);
  if (!dlm) return line;                                  // comment/blank/non-dated — keep
  const dl = dlm[1];
  if (dl < cutoffISO) { droppedCount++; return null; }    // >14 days past deadline — remove
  if (dl < todayISO && /status:"(open|upcoming)"/.test(line)) {
    expiredCount++;
    return line.replace(/status:"(open|upcoming)"/, 'status:"closed"'); // 1–14 days past — keep, mark closed
  }
  return line;
}).filter(l => l !== null).join("\n");
html = html.slice(0, startIdx) + newRegion + html.slice(sentIdx);

// ── Step 2: ask OpenAI for new open calls ────────────────────────────────────
const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error("FATAL: OPENAI_API_KEY not set."); process.exit(1); }
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
const SEARCH_TOOL = process.env.OPENAI_SEARCH_TOOL || "web_search_preview";

const FUNDERS = ["Innovate UK","UKRI","SBRI","Wellcome Trust","EIC Europe","Horizon Europe","EIT Europe","Eureka","ERC"];

function promptFor(funder) {
  return `You are updating a UK & EU research-funding dashboard. Today is ${todayISO}.
Use web search to find funding calls from ${funder} ONLY that are CURRENTLY OPEN
(or clearly upcoming). Search ${funder}'s official "open calls" / "funding
opportunities" pages thoroughly and include as many genuinely open calls as you find.

Return ONLY a JSON array (no prose, no markdown fences). Each element MUST be an
object with these fields:
  funder      : exactly "${funder}"
  programme   : short string
  title       : string
  amount      : human-readable string, e.g. "Up to £2,000,000"
  amtVal      : number (the headline figure, no currency symbol/commas)
  currency    : "gbp" or "eur"
  status      : "open" or "upcoming"
  deadline    : "YYYY-MM-DD", or "Rolling", or "TBC". Must be on/after ${todayISO} if a date.
  eligibility : string
  type        : string
  trl         : [min, max] two integers 1-9
  sectors     : non-empty array; each value from EXACTLY this list:
                AI, Advanced Manufacturing, Agritech, Biotech, Clean Tech, Deep Tech,
                Digital, Energy, Health, Mobility, Social Sciences
  location    : string
  desc        : 1-2 sentence string
  url         : official funder page for the call (https)

Do NOT include any call whose url or title already appears below. If you find no
genuinely new calls, return [].

EXISTING URLS:
${[...existingUrls].join("\n")}`;
}

async function callOpenAI(prompt) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, tools: [{ type: SEARCH_TOOL }], input: prompt, max_output_tokens: 16000 }),
  });
  if (!res.ok) {
    console.error(`FATAL: OpenAI API ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const data = await res.json();
  // [diag] Did the hosted web-search tool actually run? The Responses API emits
  // a web_search_call item in output when it does.
  const types = Array.isArray(data.output) ? data.output.map(o => o.type) : [];
  const searched = types.some(t => String(t).toLowerCase().includes("web_search"));
  // Concatenate all output_text segments from the Responses API result.
  let text = data.output_text || "";
  if (!text && Array.isArray(data.output)) {
    text = data.output
      .flatMap(o => Array.isArray(o.content) ? o.content : [])
      .filter(c => c.type === "output_text" && typeof c.text === "string")
      .map(c => c.text).join("\n");
  }
  if (!searched) console.warn(`[diag] WARN: web_search did not run for this query`);
  return text;
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  // 1) Fast path: parse the whole array if it's well-formed.
  const a = body.indexOf("["), b = body.lastIndexOf("]");
  if (a !== -1 && b > a) {
    try { const arr = JSON.parse(body.slice(a, b + 1)); if (Array.isArray(arr)) return arr; } catch {}
  }
  // 2) Resilient fallback: parse each flat {...} object on its own. Grant objects
  //    contain no nested braces, so this recovers from a truncated final object or
  //    any trailing prose without losing the complete ones.
  const objs = [];
  for (const m of body.matchAll(/\{[^{}]*\}/g)) {
    try { objs.push(JSON.parse(m[0])); } catch {}
  }
  return objs;
}

// ── Step 3: validate every proposed grant ────────────────────────────────────
function valid(g) {
  if (!g || typeof g !== "object") return false;
  if (!VALID_FUNDERS.has(g.funder)) return false;
  if (!VALID_CURRENCIES.has(g.currency)) return false;
  if (!VALID_STATUSES.has(g.status)) return false;
  if (typeof g.amtVal !== "number" || !isFinite(g.amtVal)) return false;
  if (!Array.isArray(g.trl) || g.trl.length !== 2 || !g.trl.every(n => typeof n === "number")) return false;
  if (!Array.isArray(g.sectors) || g.sectors.length === 0 || !g.sectors.every(s => VALID_SECTORS.has(s))) return false;
  const dl = g.deadline;
  if (dl !== "Rolling" && dl !== "TBC") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dl)) return false;
    if (dl < todayISO) return false; // never add an already-expired call
  }
  for (const f of ["programme","title","amount","eligibility","type","location","desc","url"]) {
    if (typeof g[f] !== "string" || g[f].trim() === "") return false;
  }
  if (!/^https?:\/\//.test(g.url)) return false;
  if (existingUrls.has(g.url.toLowerCase())) return false;
  if (existingTitles.has(g.title.toLowerCase())) return false;
  return true;
}

const jsStr = s => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ") + '"';
function serialize(g) {
  const id = nextId(g.funder);
  const sectors = "[" + g.sectors.map(jsStr).join(",") + "]";
  return `  { id:${jsStr(id)}, funder:${jsStr(g.funder)}, programme:${jsStr(g.programme)}, ` +
    `title:${jsStr(g.title)}, amount:${jsStr(g.amount)}, amtVal:${g.amtVal}, currency:${jsStr(g.currency)}, ` +
    `status:${jsStr(g.status)}, deadline:${jsStr(g.deadline)}, eligibility:${jsStr(g.eligibility)}, ` +
    `type:${jsStr(g.type)}, trl:[${g.trl[0]},${g.trl[1]}], sectors:${sectors}, location:${jsStr(g.location)}, ` +
    `desc:${jsStr(g.desc)}, url:${jsStr(g.url)} },\n`;
}

// Verify a proposed call's URL actually exists, to drop hallucinated/dead links.
// Lenient by design: many funder sites sit behind bot protection and answer 403
// to a plain fetch, so reject only clear "does not exist" signals (404/410) and
// hard network failures (bad domain, timeout).
async function urlOk(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, {
      method: "GET", redirect: "follow", signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; GrantRadarBot/1.0; +https://grants.cbitvb.uk)" },
    });
    return !(res.status === 404 || res.status === 410);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ── Run: one web search per funder, validating + deduping inline ─────────────
// Accepting a grant adds its url/title to the existing-sets immediately, so a
// later funder's search cannot re-add the same call.
const accepted = [];
let rejected = 0, deadLinks = 0;
for (const funder of FUNDERS) {
  let got = [];
  try {
    got = extractJson(await callOpenAI(promptFor(funder)));
  } catch (e) {
    console.error(`WARN: ${funder} search failed: ${e.message}`);
    continue;
  }
  let acc = 0;
  for (const g of got) {
    if (!valid(g)) { rejected++; continue; }
    if (!(await urlOk(g.url))) { deadLinks++; continue; }   // dead/fabricated link — skip
    accepted.push(g);
    existingUrls.add(g.url.toLowerCase());
    existingTitles.add(g.title.toLowerCase());
    acc++;
  }
  console.log(`[diag] ${funder}: ${got.length} proposed, ${acc} accepted`);
}

let lines = "";
for (const g of accepted) {
  lines += serialize(g);
  existingUrls.add(g.url.toLowerCase());
  existingTitles.add(g.title.toLowerCase());
}

if (lines) {
  const at = html.indexOf(SENTINEL);
  html = html.slice(0, at) + lines + html.slice(at);
}

writeFileSync(HTML, html);
console.log(`Refresh done: +${accepted.length} new, ${expiredCount} marked closed, ${droppedCount} dropped (>14d past), ${rejected} rejected by validation, ${deadLinks} skipped (dead URL).`);
