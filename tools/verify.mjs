#!/usr/bin/env node
/*
 * verify.mjs — Data-verification pipeline for "Guess the Cricketer".
 *
 * Corroborates each player's fields in ../data.js against the OFFICIAL English
 * Wikipedia MediaWiki API by parsing the {{Infobox cricketer}} wikitext.
 * It reports mismatches only; it NEVER edits data.js.
 *
 * Run from the repo root:   node tools/verify.mjs
 * Options:
 *   --cache        use / populate an on-disk wikitext cache (tools/.wiki-cache.json)
 *                  so re-runs during iteration don't re-hit the API. Default: live fetch.
 *   --limit=N      only verify the first N players (handy while iterating).
 *
 * Output: tools/verify-report.md  (+ a summary printed to stdout).
 *
 * No npm dependencies. Requires Node 18+ (global fetch).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const DATA_PATH = join(REPO, "data.js");
const REPORT_PATH = join(__dirname, "verify-report.md");
const IPL_HISTORY_PATH = join(__dirname, "ipl-history.json");
const CACHE_PATH = join(__dirname, ".wiki-cache.json");

const API = "https://en.wikipedia.org/w/api.php";
const USER_AGENT =
  "GuessTheCricketerVerify/1.0 (contact: siddhant.kushwaha@gmail.com)";
const BATCH_SIZE = 50; // titles per API request
const PACE_MS = 1100; // ~1 req/sec, polite to Wikimedia

const argv = process.argv.slice(2);
const USE_CACHE = argv.includes("--cache");
const LIMIT = (() => {
  const a = argv.find((x) => x.startsWith("--limit="));
  return a ? parseInt(a.split("=")[1], 10) : Infinity;
})();

// ---------------------------------------------------------------------------
// MAPPING TABLES  —  explicit & editable.
// ---------------------------------------------------------------------------

// Canonical bowling strings used by our schema (family = pace | spin | none).
const CANON_BOWL = new Set([
  "Right-arm fast",
  "Right-arm fast-medium",
  "Right-arm medium",
  "Left-arm fast",
  "Left-arm fast-medium",
  "Left-arm medium",
  "Right-arm offbreak",
  "Legbreak",
  "Left-arm orthodox",
  "Left-arm wrist-spin",
]);

const BOWL_FAMILY = {
  "Right-arm fast": "pace",
  "Right-arm fast-medium": "pace",
  "Right-arm medium": "pace",
  "Left-arm fast": "pace",
  "Left-arm fast-medium": "pace",
  "Left-arm medium": "pace",
  "Right-arm offbreak": "spin",
  Legbreak: "spin",
  "Left-arm orthodox": "spin",
  "Left-arm wrist-spin": "spin",
};

// Country aliases: Wikipedia infobox `country` value (lowercased) -> our label.
// Anything not listed is compared verbatim (case-insensitive).
const COUNTRY_ALIASES = {
  "united states": "USA",
  "united states of america": "USA",
  usa: "USA",
  "west indies": "West Indies",
  england: "England",
};

// Role mapping is keyword-based (see normalizeRole): any "all-rounder" variant
// -> Allrounder, any "wicket-keeper" variant -> Keeper, else Bowler / Batter.

// Explicit Wikipedia-title overrides for names where both "<name>" and
// "<name> (cricketer)" are themselves disambiguation pages. Editable.
const TITLE_OVERRIDES = {
  "David Miller": "David Miller (cricketer, born 1989)",
  "Daryl Mitchell": "Daryl Mitchell (cricketer, born 1991)",
};

// IPL franchise mapping (ONLY IPL teams — domestic/international/other leagues
// are excluded by returning null). Matched against the raw clubN wikitext (both
// wikilink target and display text), so historical and abbreviated names hit.
// Order: most specific first. NOTE the Deccan Chargers vs Delhi Capitals "DC"
// collision — Delhi Capitals/Daredevils => "DC", old Deccan Chargers => "DECCAN".
const IPL_TEAMS = [
  { re: /chennai super kings/, abbr: "CSK" },
  { re: /mumbai indians/, abbr: "MI" },
  { re: /royal challengers (?:bangalore|bengaluru)/, abbr: "RCB" },
  { re: /kolkata knight riders/, abbr: "KKR" },
  { re: /rajasthan royals/, abbr: "RR" },
  { re: /delhi (?:daredevils|capitals)/, abbr: "DC" }, // same continuing franchise
  { re: /sunrisers hyderabad|sun risers hyderabad/, abbr: "SRH" },
  { re: /kings xi punjab|punjab kings/, abbr: "PBKS" }, // KXIP renamed -> PBKS
  { re: /gujarat titans/, abbr: "GT" },
  { re: /gujarat lions/, abbr: "GL" }, // defunct (2016-17)
  { re: /lucknow super giants/, abbr: "LSG" },
  { re: /deccan chargers/, abbr: "DECCAN" }, // defunct (2008-12), disambiguated from DC
  { re: /kochi tuskers kerala/, abbr: "KTK" }, // defunct (2011)
  { re: /rising pune supergiants?/, abbr: "RPS" }, // defunct (2016-17)
  { re: /pune warriors/, abbr: "PWI" }, // defunct (2011-13)
];

function iplAbbr(clubRaw) {
  const s = clubRaw.toLowerCase().replace(/[[\]|]/g, " ").replace(/\s+/g, " ");
  for (const { re, abbr } of IPL_TEAMS) if (re.test(s)) return abbr;
  return null;
}

// Extract the player's full IPL franchise history from clubN/yearN infobox
// params, in career (index) order, de-duplicated to first occurrence.
function extractIplHistory(params) {
  const entries = [];
  for (const key of Object.keys(params)) {
    const m = /^club(\d+)$/.exec(key);
    if (!m) continue;
    const idx = parseInt(m[1], 10);
    const abbr = iplAbbr(params[key] || "");
    if (!abbr) continue;
    const yr = params[`year${idx}`]
      ? parseInt(cleanValue(params[`year${idx}`]).match(/\b(19|20)\d\d\b/)?.[0] || "0", 10)
      : 0;
    entries.push({ idx, abbr, yr });
  }
  entries.sort((a, b) => a.idx - b.idx); // clubN listed in career order
  const seen = new Set();
  const history = [];
  for (const e of entries) {
    if (seen.has(e.abbr)) continue;
    seen.add(e.abbr);
    history.push(e.abbr);
  }
  return history;
}

// ---------------------------------------------------------------------------
// LOAD PLAYER DATA  (eval the IIFE with a stub `root`/`window`).
// ---------------------------------------------------------------------------

function loadPlayers() {
  const src = readFileSync(DATA_PATH, "utf8");
  // data.js is:  (function (root) { ... root.CRICKETERS = C; })(window||this)
  // Supply a `window` binding so the IIFE writes onto our stub object.
  const stub = {};
  try {
    // eslint-disable-next-line no-new-func
    const loader = new Function("window", src + "\n;return window;");
    const out = loader(stub);
    if (Array.isArray(out.CRICKETERS)) return out.CRICKETERS;
  } catch (e) {
    console.error("eval load failed, falling back to regex:", e.message);
  }
  // Fallback: regex-extract the array literal and JSON-ify it.
  const m = src.match(/var\s+C\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) throw new Error("Could not locate player array in data.js");
  // Turn JS object literals into JSON: quote keys, drop the em-dash quirk.
  const jsonish = m[1]
    .replace(/([{,]\s*)([a-zA-Z_][\w]*)\s*:/g, '$1"$2":')
    .replace(/,\s*]/g, "]")
    .replace(/\/\/[^\n]*/g, "");
  return JSON.parse(jsonish);
}

// ---------------------------------------------------------------------------
// WIKITEXT PARSING
// ---------------------------------------------------------------------------

function extractInfobox(text) {
  const m = /\{\{\s*infobox cricketer/i.exec(text);
  if (!m) return null;
  let i = m.index;
  let depth = 0;
  const start = i;
  while (i < text.length) {
    if (text.startsWith("{{", i)) {
      depth++;
      i += 2;
      continue;
    }
    if (text.startsWith("}}", i)) {
      depth--;
      i += 2;
      if (depth === 0) return text.slice(start, i);
      continue;
    }
    i++;
  }
  return text.slice(start); // unbalanced fallback
}

function parseParams(infobox) {
  let body = infobox
    .replace(/^\{\{\s*infobox cricketer/i, "")
    .replace(/\}\}\s*$/, "");
  const parts = [];
  let depthC = 0,
    depthB = 0,
    cur = "";
  for (let i = 0; i < body.length; i++) {
    if (body.startsWith("{{", i)) {
      depthC++;
      cur += "{{";
      i++;
      continue;
    }
    if (body.startsWith("}}", i)) {
      depthC--;
      cur += "}}";
      i++;
      continue;
    }
    if (body.startsWith("[[", i)) {
      depthB++;
      cur += "[[";
      i++;
      continue;
    }
    if (body.startsWith("]]", i)) {
      depthB--;
      cur += "]]";
      i++;
      continue;
    }
    if (body[i] === "|" && depthC === 0 && depthB === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += body[i];
  }
  parts.push(cur);
  const params = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const key = p.slice(0, eq).trim().toLowerCase();
    const val = p.slice(eq + 1).trim();
    if (key) params[key] = val;
  }
  return params;
}

function cleanValue(v) {
  if (!v) return "";
  v = v.replace(/<ref[^>]*\/>/gi, "");
  v = v.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "");
  v = v.replace(/<!--[\s\S]*?-->/g, "");
  // list templates -> drop the template head, keep the items
  v = v.replace(
    /\{\{\s*(?:plainlist|plain list|ubl|unbulleted list|ublist|hlist|flatlist|nowrap|nobr|small|nobold|nobr)\s*\|/gi,
    " ",
  );
  // any remaining simple template -> space
  for (let n = 0; n < 4; n++) v = v.replace(/\{\{[^{}]*\}\}/g, " ");
  // wikilinks
  v = v.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2");
  v = v.replace(/\[\[([^\]]*)\]\]/g, "$1");
  v = v.replace(/'''?/g, "");
  v = v.replace(/<br\s*\/?>/gi, " / ");
  v = v.replace(/&nbsp;/g, " ");
  v = v.replace(/[{}]/g, " ");
  v = v.replace(/\s+/g, " ").trim();
  return v;
}

// -- Field normalizers -------------------------------------------------------

function normalizeBat(raw) {
  const low = (raw || "").toLowerCase();
  if (/left/.test(low)) return "Left";
  if (/right/.test(low)) return "Right";
  return null;
}

function normalizeBowl(raw) {
  if (!raw) return null;
  // A player may list several styles ({{ubl|..|..}} leaves "|" separators,
  // plainlist / <br> join with " / "). Classify each and take the FIRST that
  // maps to a canonical style — that is the player's primary style.
  const segs = raw
    .split(/\s*[\/,;|]\s*|<br\s*\/?>|\band\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const seg of segs) {
    const c = classifyBowl(seg);
    if (c) return c;
  }
  return null;
}

// All canonical styles Wikipedia lists (some players bowl several — e.g. Sobers
// bowled fast-medium, orthodox AND wrist-spin). Used so that if OUR single style
// is among them, we count it as corroborated rather than a mismatch.
function normalizeBowlSet(raw) {
  if (!raw) return [];
  const segs = raw
    .split(/\s*[\/,;|]\s*|<br\s*\/?>|\band\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
  const set = [];
  for (const seg of segs) {
    const c = classifyBowl(seg);
    if (c && !set.includes(c)) set.push(c);
  }
  return set;
}

function classifyBowl(seg) {
  const low = seg.toLowerCase();

  let arm = null;
  if (/left[\s-]?arm|slow left|left[\s-]?hand.*bowl/.test(low)) arm = "Left";
  else if (/right[\s-]?arm|right[\s-]?hand.*bowl/.test(low)) arm = "Right";

  // spin families first
  if (/orthodox/.test(low)) return "Left-arm orthodox";
  if (/chinaman|wrist[\s-]?spin|unorthodox/.test(low))
    return arm === "Left" ? "Left-arm wrist-spin" : "Legbreak";
  if (/off[\s-]?break|off[\s-]?spin|offbreak/.test(low))
    return "Right-arm offbreak";
  if (/leg[\s-]?break|leg[\s-]?spin|legbreak|googly/.test(low))
    return "Legbreak";
  if (/slow left/.test(low)) return "Left-arm orthodox";

  // pace families (need an arm to name it canonically)
  const hasFast = /\bfast\b|fast[\s-]?medium|medium[\s-]?fast/.test(low);
  const hasMedium = /\bmedium\b|medium[\s-]?pace|medium[\s-]?fast|fast[\s-]?medium|medium[\s-]?slow|slow[\s-]?medium/.test(
    low,
  );
  if (arm) {
    if (hasFast && /medium/.test(low)) return `${arm}-arm fast-medium`;
    if (hasFast) return `${arm}-arm fast`;
    if (hasMedium) return `${arm}-arm medium`;
  }
  return null; // e.g. "Right-arm bowler" with no descriptor -> can't classify
}

function normalizeRole(raw) {
  const low = (raw || "").toLowerCase();
  if (!low) return null;
  if (/all[\s-]?rounder/.test(low)) return "Allrounder";
  if (/wicket[\s-]?keeper|wicketkeeper|wk[\s-]?bat/.test(low)) return "Keeper";
  if (/bowler|bowling/.test(low)) return "Bowler";
  if (/bat(sman|ter|ting)|opener|opening/.test(low)) return "Batter";
  return null;
}

function normalizeCountry(raw) {
  const c = cleanValue(raw);
  if (!c) return null;
  const key = c.toLowerCase().trim();
  if (COUNTRY_ALIASES[key]) return COUNTRY_ALIASES[key];
  return c;
}

// debut year = min across test/odi/t20i debut years, debut dates, span start.
function extractDebutYear(params) {
  const years = [];
  const yearKeys = ["testdebutyear", "odidebutyear", "t20idebutyear"];
  for (const k of yearKeys) {
    if (params[k]) {
      const y = parseInt(cleanValue(params[k]).match(/\d{4}/)?.[0] || "", 10);
      if (y) years.push(y);
    }
  }
  const dateKeys = ["testdebutdate", "odidebutdate", "t20idebutdate"];
  for (const k of dateKeys) {
    if (params[k]) {
      const y = parseInt(cleanValue(params[k]).match(/\b(1[89]\d\d|20\d\d)\b/)?.[0] || "", 10);
      if (y) years.push(y);
    }
  }
  // internationalspan like "2008–2023" — the start year IS the intl debut.
  if (params.internationalspan) {
    const y = parseInt(
      cleanValue(params.internationalspan).match(/\b(1[89]\d\d|20\d\d)\b/)?.[0] || "",
      10,
    );
    if (y) years.push(y);
  }
  if (!years.length) return null;
  return Math.min(...years);
}

// Shirt/jersey number: not a standard {{Infobox cricketer}} field, but try a
// few plausible param names in case one is present. Usually absent.
function extractNumber(params) {
  const keys = ["clubnumber", "number", "shirtnumber", "jerseynumber"];
  for (const k of keys) {
    if (params[k]) {
      const n = parseInt(cleanValue(params[k]).match(/\d+/)?.[0] || "", 10);
      if (!Number.isNaN(n)) return n;
    }
  }
  return null;
}

function isDisambiguation(text) {
  return /\{\{\s*(disambiguation|disambig|dab|hndis|hn dis|human name disambiguation|surname|given name)\b/i.test(
    text,
  );
}

function parsePage(wikitext) {
  const infobox = extractInfobox(wikitext);
  if (!infobox)
    return { ok: false, reason: isDisambiguation(wikitext) ? "disambiguation" : "no-infobox" };
  const p = parseParams(infobox);
  return {
    ok: true,
    bat: normalizeBat(cleanValue(p.batting || "")),
    batRaw: cleanValue(p.batting || ""),
    bowl: normalizeBowl(cleanValue(p.bowling || "")),
    bowlSet: normalizeBowlSet(cleanValue(p.bowling || "")),
    bowlRaw: cleanValue(p.bowling || ""),
    role: normalizeRole(cleanValue(p.role || "")),
    roleRaw: cleanValue(p.role || ""),
    debut: extractDebutYear(p),
    country: normalizeCountry(p.country || p.internationalside || ""),
    countryRaw: cleanValue(p.country || p.internationalside || ""),
    num: extractNumber(p),
    iplHistory: extractIplHistory(p),
    hasClubs: Object.keys(p).some((k) => /^club\d+$/.test(k)),
  };
}

// ---------------------------------------------------------------------------
// WIKIPEDIA API
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiQuery(titles) {
  const params = new URLSearchParams({
    action: "query",
    prop: "revisions",
    rvprop: "content",
    rvslots: "main",
    format: "json",
    formatversion: "2",
    redirects: "1",
    titles: titles.join("|"),
  });
  const url = `${API}?${params.toString()}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Resolve requested titles through normalized + redirect chains, return a map
// requestedTitle -> wikitext (or null if missing).
function mapResponse(requested, data) {
  const norm = {};
  for (const n of data?.query?.normalized || []) norm[n.from] = n.to;
  const redir = {};
  for (const r of data?.query?.redirects || []) redir[r.from] = r.to;
  const pageByTitle = {};
  for (const pg of data?.query?.pages || []) pageByTitle[pg.title] = pg;

  const out = {};
  for (const title of requested) {
    let t = title;
    for (let i = 0; i < 5 && norm[t]; i++) t = norm[t];
    for (let i = 0; i < 8 && redir[t]; i++) t = redir[t];
    // fall back to case/space-insensitive lookup
    let pg = pageByTitle[t];
    if (!pg) {
      const wanted = t.replace(/_/g, " ").toLowerCase();
      for (const pgt of Object.keys(pageByTitle))
        if (pgt.toLowerCase() === wanted) pg = pageByTitle[pgt];
    }
    if (!pg || pg.missing) out[title] = null;
    else out[title] = pg.revisions?.[0]?.slots?.main?.content ?? null;
  }
  return out;
}

async function fetchBatchWithRetry(titles) {
  try {
    return mapResponse(titles, await apiQuery(titles));
  } catch (e) {
    await sleep(PACE_MS);
    try {
      return mapResponse(titles, await apiQuery(titles));
    } catch (e2) {
      const out = {};
      for (const t of titles) out[t] = undefined; // undefined = fetch failed
      return out;
    }
  }
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function fetchAll(names) {
  const cache = USE_CACHE && existsSync(CACHE_PATH)
    ? JSON.parse(readFileSync(CACHE_PATH, "utf8"))
    : {};
  const wikitext = {}; // name -> wikitext | null (missing) | undefined (failed)

  // 1) primary pass: exact names (or an explicit title override), cache keyed
  //    by our player name.
  const titleOf = (name) => TITLE_OVERRIDES[name] || name;
  const need = names.filter((n) => !(USE_CACHE && n in cache));
  const titleToName = {};
  for (const n of need) titleToName[titleOf(n)] = n;
  for (const b of chunk(need.map(titleOf), BATCH_SIZE)) {
    process.stderr.write(`  fetching ${b.length} titles...\n`);
    const res = await fetchBatchWithRetry(b);
    for (const [title, v] of Object.entries(res)) {
      const name = titleToName[title] || title;
      wikitext[name] = v;
      if (USE_CACHE && v !== undefined) cache[name] = v;
    }
    await sleep(PACE_MS);
  }
  for (const n of names) if (USE_CACHE && n in cache && !(n in wikitext)) wikitext[n] = cache[n];

  // 2) fallback pass: names whose page is missing OR lacks an infobox ->
  //    try "<name> (cricketer)".
  const fbNeeded = names.filter((n) => {
    const wt = wikitext[n];
    if (wt === undefined) return false; // fetch failed; leave as-is
    if (wt === null) return true; // missing page
    return !/\{\{\s*infobox cricketer/i.test(wt); // disambig / wrong article
  });
  const fbTitles = fbNeeded.map((n) => `${n} (cricketer)`);
  const fbMap = {}; // fb title -> original name
  fbNeeded.forEach((n, i) => (fbMap[fbTitles[i]] = n));
  const fbCacheKey = (t) => `FB::${t}`;
  const fbNeed = fbTitles.filter((t) => !(USE_CACHE && fbCacheKey(t) in cache));
  const fbResult = {};
  for (const b of chunk(fbNeed, BATCH_SIZE)) {
    process.stderr.write(`  fallback fetching ${b.length} "(cricketer)" titles...\n`);
    const res = await fetchBatchWithRetry(b);
    for (const [k, v] of Object.entries(res)) {
      fbResult[k] = v;
      if (USE_CACHE && v !== undefined) cache[fbCacheKey(k)] = v;
    }
    await sleep(PACE_MS);
  }
  for (const t of fbTitles) {
    let v = fbResult[t];
    if (v === undefined && USE_CACHE && fbCacheKey(t) in cache) v = cache[fbCacheKey(t)];
    const name = fbMap[t];
    // only adopt the fallback if it actually has an infobox
    if (v && /\{\{\s*infobox cricketer/i.test(v)) wikitext[name] = v;
  }

  if (USE_CACHE) writeFileSync(CACHE_PATH, JSON.stringify(cache));
  return wikitext;
}

// ---------------------------------------------------------------------------
// DIFF
// ---------------------------------------------------------------------------

function confidenceFor(field, ours, wiki, player) {
  switch (field) {
    case "bat":
      return 0.9;
    case "bowl": {
      const fo = BOWL_FAMILY[ours];
      const fw = BOWL_FAMILY[wiki];
      // A wrong style for a frontline bowler/allrounder is a strong signal; for
      // a batter/keeper who bowls occasionally it is soft (they bowl a bit of
      // everything, and our schema keeps only one style).
      const frontline = player.role === "Bowler" || player.role === "Allrounder";
      if (fo && fw && fo !== fw) return frontline ? 0.95 : 0.55; // pace vs spin
      return frontline ? 0.6 : 0.35; // same family, sub-type collapse
    }
    case "country":
      return 0.85;
    case "debut": {
      const d = Math.abs(ours - wiki);
      return d >= 3 ? 0.9 : d === 2 ? 0.75 : 0.6;
    }
    case "role":
      return 0.3;
    default:
      return 0.4;
  }
}

function diffPlayer(player, parsed) {
  const rows = [];
  const add = (field, ours, wiki, snippet) =>
    rows.push({
      name: player.name,
      field,
      ours,
      wiki,
      snippet,
      confidence: confidenceFor(field, ours, wiki, player),
    });

  // bat
  if (parsed.bat && parsed.bat !== player.bat)
    add("bat", player.bat, parsed.bat, parsed.batRaw);

  // bowl — only when BOTH assert a style (our "—" = not asserted). If our style
  // is among the styles Wikipedia lists (multi-style bowlers), it's corroborated.
  if (
    player.bowl !== "—" &&
    parsed.bowlSet.length &&
    !parsed.bowlSet.includes(player.bowl)
  )
    add("bowl", player.bowl, parsed.bowl, parsed.bowlRaw);

  // role
  if (parsed.role && parsed.role !== player.role)
    add("role", player.role, parsed.role, parsed.roleRaw);

  // debut
  if (parsed.debut && parsed.debut !== player.debut)
    add("debut", player.debut, parsed.debut, `intl debut ${parsed.debut}`);

  // country
  if (parsed.country && parsed.country.toLowerCase() !== player.country.toLowerCase())
    add("country", player.country, parsed.country, parsed.countryRaw);

  // shirt number — only if Wikipedia actually carries one AND it differs
  if (parsed.num != null && player.num != null && parsed.num !== player.num)
    add("num", player.num, parsed.num, `infobox #${parsed.num}`);

  return rows;
}

// ---------------------------------------------------------------------------
// REPORT
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s).replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 90);
}

function buildReport(players, wikitext, results) {
  const mismatches = [];
  const unresolved = [];
  const ambiguous = [];
  const iplHistoryMap = {}; // name -> [ABBR,...]  (only players parsed OK)
  let parsedOk = 0;
  let fetchFailed = 0;

  for (const player of players) {
    const wt = wikitext[player.name];
    if (wt === undefined) {
      fetchFailed++;
      unresolved.push({ name: player.name, reason: "fetch failed (network)" });
      continue;
    }
    if (wt === null) {
      unresolved.push({ name: player.name, reason: "page missing / not found (no '(cricketer)' fallback)" });
      continue;
    }
    const parsed = parsePage(wt);
    if (!parsed.ok) {
      unresolved.push({ name: player.name, reason: parsed.reason });
      continue;
    }
    parsedOk++;
    results.set(player.name, parsed);
    iplHistoryMap[player.name] = parsed.iplHistory;
    const rows = diffPlayer(player, parsed);
    for (const r of rows) mismatches.push(r);
    // Wikipedia itself ambiguous: bowling present but unclassifiable while we assert one
    if (player.bowl !== "—" && parsed.bowlRaw && !parsed.bowl)
      ambiguous.push({ name: player.name, note: `bowling "${parsed.bowlRaw}" not classifiable to a canonical style (ours: ${player.bowl})` });
    // IPL ambiguity: data.js says the player has an IPL team, but the infobox
    // club list yielded no IPL franchise -> can't corroborate history, flag it.
    if (player.ipl && player.ipl !== "—" && parsed.iplHistory.length === 0)
      ambiguous.push({
        name: player.name,
        note: `[IPL] data.js lists "${player.ipl}" but no IPL club found in infobox (${parsed.hasClubs ? "clubs present, none recognized as IPL" : "no club fields in infobox"})`,
      });
  }

  // field counts
  const byField = {};
  for (const m of mismatches) byField[m.field] = (byField[m.field] || 0) + 1;

  // top confident errors
  const ranked = [...mismatches].sort((a, b) => b.confidence - a.confidence);
  const top = ranked.slice(0, 15);

  const lines = [];
  lines.push("# Guess the Cricketer — data verification report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Source of truth: English Wikipedia MediaWiki API ({{Infobox cricketer}} wikitext)`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Players in data.js: **${players.length}**`);
  lines.push(`- Pages parsed with an infobox: **${parsedOk}**`);
  lines.push(`- Unresolved / unparseable: **${unresolved.length}**`);
  lines.push(`- Fetch failures: **${fetchFailed}**`);
  lines.push(`- Total field mismatches: **${mismatches.length}**`);
  const withIpl = Object.values(iplHistoryMap).filter((h) => h.length).length;
  lines.push(`- Players with >=1 IPL franchise found in infobox: **${withIpl}**`);
  lines.push("");
  lines.push("Mismatches by field:");
  lines.push("");
  lines.push("| Field | Count | Note |");
  lines.push("| --- | --- | --- |");
  const noteFor = {
    bat: "batting hand — objective, high confidence",
    bowl: "bowling style — only counted when both sides assert a style",
    role: "role — subjective on Wikipedia; low confidence",
    debut: "int'l debut year (min across formats)",
    country: "representative country",
    num: "shirt number — rarely present in infobox",
  };
  for (const f of ["bat", "bowl", "debut", "country", "role", "num"])
    if (byField[f]) lines.push(`| ${f} | ${byField[f]} | ${noteFor[f]} |`);
  lines.push("");

  // Most confident likely errors
  lines.push("## Most confident likely errors (top 15 by confidence)");
  lines.push("");
  lines.push("| # | Player | Field | Ours | Wikipedia | Confidence | Evidence (wikitext) |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  top.forEach((m, i) =>
    lines.push(
      `| ${i + 1} | ${esc(m.name)} | ${m.field} | ${esc(m.ours)} | ${esc(m.wiki)} | ${m.confidence.toFixed(2)} | ${esc(m.snippet)} |`,
    ),
  );
  lines.push("");

  // Full mismatch table
  lines.push("## All mismatches");
  lines.push("");
  lines.push("| Player | Field | Ours | Wikipedia | Wikitext snippet |");
  lines.push("| --- | --- | --- | --- | --- |");
  const sorted = [...mismatches].sort(
    (a, b) => a.name.localeCompare(b.name) || a.field.localeCompare(b.field),
  );
  for (const m of sorted)
    lines.push(`| ${esc(m.name)} | ${m.field} | ${esc(m.ours)} | ${esc(m.wiki)} | ${esc(m.snippet)} |`);
  lines.push("");

  // Ambiguous
  lines.push("## Ambiguous on Wikipedia (not counted as errors)");
  lines.push("");
  if (!ambiguous.length) lines.push("_None._");
  else {
    lines.push("| Player | Note |");
    lines.push("| --- | --- |");
    for (const a of ambiguous) lines.push(`| ${esc(a.name)} | ${esc(a.note)} |`);
  }
  lines.push("");

  // IPL franchise history (machine-parseable: "Name | T1,T2,T3")
  lines.push("## IPL FRANCHISE HISTORY");
  lines.push("");
  lines.push("One line per player, chronological (earliest -> latest), de-duplicated.");
  lines.push("Empty after the pipe = no IPL franchise found in the infobox.");
  lines.push("Also emitted as `tools/ipl-history.json`.");
  lines.push("");
  lines.push("```");
  for (const player of players) {
    if (!(player.name in iplHistoryMap)) continue; // only parsed players
    lines.push(`${player.name} | ${iplHistoryMap[player.name].join(",")}`);
  }
  lines.push("```");
  lines.push("");

  // Unresolved
  lines.push("## Unresolved / could not parse");
  lines.push("");
  if (!unresolved.length) lines.push("_None._");
  else {
    lines.push("| Player | Reason |");
    lines.push("| --- | --- |");
    for (const u of unresolved) lines.push(`| ${esc(u.name)} | ${esc(u.reason)} |`);
  }
  lines.push("");

  return { report: lines.join("\n"), byField, mismatches, unresolved, ambiguous, top, parsedOk, fetchFailed, iplHistoryMap };
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
  const all = loadPlayers();
  const players = Number.isFinite(LIMIT) ? all.slice(0, LIMIT) : all;
  console.error(`Loaded ${all.length} players${players.length !== all.length ? ` (limited to ${players.length})` : ""}.`);
  console.error(`Fetching Wikipedia wikitext${USE_CACHE ? " (cache on)" : " (live)"}...`);

  const names = players.map((p) => p.name);
  const wikitext = await fetchAll(names);

  const results = new Map();
  const { report, byField, mismatches, unresolved, top, parsedOk, fetchFailed, iplHistoryMap } =
    buildReport(players, wikitext, results);

  writeFileSync(REPORT_PATH, report);
  writeFileSync(IPL_HISTORY_PATH, JSON.stringify(iplHistoryMap, null, 2) + "\n");

  console.error("");
  console.error("==== SUMMARY ====");
  console.error(`Parsed with infobox : ${parsedOk}/${players.length}`);
  console.error(`Unresolved          : ${unresolved.length}`);
  console.error(`Fetch failures      : ${fetchFailed}`);
  console.error(`Total mismatches    : ${mismatches.length}`);
  console.error(`By field            : ${JSON.stringify(byField)}`);
  console.error(`Report written to   : ${REPORT_PATH}`);

  // spot-check famous players
  const spot = ["Virat Kohli", "Daniel Vettori", "Shane Warne", "Kumar Sangakkara", "Glenn McGrath"];
  console.error("\n---- spot check ----");
  for (const nm of spot) {
    const r = results.get(nm);
    if (r) console.error(`${nm}: bat=${r.bat} bowl=${r.bowl} role=${r.role} debut=${r.debut} country=${r.country}`);
    else console.error(`${nm}: (not in this run / unresolved)`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
