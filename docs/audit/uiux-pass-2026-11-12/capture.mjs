// UI/UX audit capture harness for Warthog (operator tool, not part of the app's suite; used for
// the 12 November 2026 UI/UX pass). Needs a running dev server and a signed-in storage state.
//
//   node capture.mjs discover                 crawl routes + in-page tabs → urls.json
//   node capture.mjs capture [filter] [cfgs]  screenshot + measure every url × config → shots/, metrics/
//
// filter: substring/regex on the url key (e.g. "agents|home"); cfgs: comma list of config names
// (default: all). OUT=<dir> overrides the output dir (default: ./run). BASE overrides the server.
// Screenshots are viewport-height JPEG slices (s1, s2, …) so tall phone pages stay legible.
// Playwright is not a Warthog dependency: point PLAYWRIGHT_MODULE at any local install.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
import { mkdir, readFile, writeFile } from "node:fs/promises";

const DIR = new URL(".", import.meta.url).pathname;
const BASE = process.env.BASE ?? "http://localhost:3217";
const OUT = process.env.OUT ?? `${DIR}run`;
const STATE = process.env.STATE ?? `${DIR}storage-state.json`;
const MAX_SLICES = Number(process.env.MAX_SLICES ?? 6);

export const CONFIGS = {
  "light-320": { width: 320, height: 640, scheme: "light" },
  "light-390": { width: 390, height: 844, scheme: "light" },
  "light-768": { width: 768, height: 1024, scheme: "light" },
  "light-1024": { width: 1024, height: 768, scheme: "light" },
  "light-1440": { width: 1440, height: 900, scheme: "light" },
  "light-1920": { width: 1920, height: 1080, scheme: "light" },
  "light-land": { width: 844, height: 390, scheme: "light" },
  "dark-390": { width: 390, height: 844, scheme: "dark" },
  "dark-1440": { width: 1440, height: 900, scheme: "dark" },
};

const PUBLIC = ["/", "/signin", "/signup", "/recover", "/reset", "/reset/setup", "/device", "/help", "/help/compatibility", "/privacy", "/terms"];
const PRIVATE = [
  "/home", "/inbox", "/activity", "/agents", "/agents/connect", "/agents/access-key", "/connectors", "/connectors/key",
  "/household", "/life-admin", "/memory", "/more", "/rules", "/skills", "/spending", "/vault", "/vault/cards",
  "/settings", "/settings/agents", "/settings/data", "/settings/notifications", "/settings/security",
  "/oauth/consent", "/dev/agent-console", "/dev/outbox",
];
const AGENT_SECTIONS = ["overview", "connectors", "vault", "skills", "memory", "spending", "rules", "activity", "settings"];

const HIDE_DEV = "nextjs-portal{display:none!important}";
const keyOf = (u) => {
  const url = new URL(u, BASE);
  let k = url.pathname === "/" ? "landing" : url.pathname.slice(1).replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "ID").replaceAll("/", "_");
  if (url.search) k += "__" + url.search.slice(1).replace(/[^a-z0-9=]+/gi, "_").replace(/=/g, "-");
  return k.slice(0, 120);
};

async function newContext(browser, cfg, signedIn) {
  const ctx = await browser.newContext({
    viewport: { width: cfg.width, height: cfg.height },
    colorScheme: cfg.scheme,
    deviceScaleFactor: 1,
    hasTouch: cfg.width < 1024,
    ...(signedIn ? { storageState: STATE } : {}),
  });
  ctx.setDefaultTimeout(90000);
  return ctx;
}

// ---------- in-page measurement (runs in the browser) ----------
function measure() {
  const vw = document.documentElement.clientWidth;
  const out = { title: document.title, h1: [...document.querySelectorAll("h1")].map((h) => h.innerText.trim().slice(0, 80)) };
  out.docScrollWidth = document.documentElement.scrollWidth;
  out.viewport = vw;
  out.docOverflowX = document.documentElement.scrollWidth > vw + 1;

  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
  const painted = (n) => { const c = parse(getComputedStyle(n).backgroundColor); return c && c.a > 0.05 ? c : null; };
  const same = (a, b) => a && b && Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 6;
  // The visible canvas is the nearest painted ancestor of <main> (or of body when there is no main).
  const canvases = [];
  const main = document.querySelector("main");
  for (let n = main ?? document.body; n; n = n.parentElement) { const c = painted(n); if (c) { canvases.push(c); break; } }
  if (!canvases.length) canvases.push({ r: 255, g: 255, b: 255, a: 1 });
  const isCanvas = (c) => canvases.some((k) => same(k, c));
  // Elements that ARE the canvas (incl. its decorative gradient) never count as a container.
  const canvasEls = new Set([document.documentElement, document.body, ...document.querySelectorAll("main,.wh-main,.wh-workspace,.wh-page,[data-canvas]")]);
  for (let n = main; n; n = n.parentElement) canvasEls.add(n);

  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.01; };
  const path = (el) => { const parts = []; for (let n = el; n && n !== document.body && parts.length < 5; n = n.parentElement) { let s = n.tagName.toLowerCase(); if (n.id && !/^_R_|^«/.test(n.id)) s += "#" + n.id; const cls = [...n.classList].filter((c) => c.startsWith("wh-")).slice(0, 2); if (cls.length) s += "." + cls.join("."); parts.unshift(s); } return parts.join(" > "); };
  const isSurface = (n) => {
    if (canvasEls.has(n)) return null;
    const cs = getComputedStyle(n);
    const bg = painted(n);
    if (bg && !isCanvas(bg)) return "bg";
    const sides = ["Top", "Right", "Bottom", "Left"].filter((s) => parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== "none").length;
    if (sides >= 3) return "border";
    if (cs.boxShadow && cs.boxShadow !== "none") return "shadow";
    if (cs.backgroundImage && cs.backgroundImage !== "none") return "image";
    return null;
  };

  // Free text: visible text whose nearest visual container is the page canvas itself.
  const free = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.nodeValue.trim().length > 1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
  const seen = new Set();
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const el = t.parentElement;
    if (!el || seen.has(el) || !visible(el) || el.closest("script,style,noscript,nextjs-portal,[aria-hidden=true],.sr-only")) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    let surface = null;
    for (let n = el; n && n !== document.body; n = n.parentElement) { if (isSurface(n)) { surface = n; break; } }
    if (surface) continue;
    seen.add(el);
    const landmark = el.closest("header,nav,aside,footer,[role=banner],[role=navigation],[role=contentinfo]");
    free.push({ text: el.innerText.trim().replace(/\s+/g, " ").slice(0, 90), tag: el.tagName.toLowerCase(), where: landmark ? `chrome:${landmark.tagName.toLowerCase()}` : el.closest("main") ? "main" : "other", path: path(el), y: Math.round(r.top + scrollY) });
  }
  out.freeText = free.slice(0, 60);
  out.freeTextCount = free.length;

  // Elements poking outside the viewport (not inside a clipping/scrolling ancestor).
  const clipped = (el) => { for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) { const ox = getComputedStyle(n).overflowX; if (ox !== "visible") return true; } return false; };
  const offscreen = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (el.closest("nextjs-portal,dialog:not([open])")) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if ((r.right > vw + 1 || r.left < -1) && !clipped(el) && visible(el) && getComputedStyle(el).position !== "fixed") offscreen.push({ path: path(el), left: Math.round(r.left), right: Math.round(r.right), text: (el.innerText || "").trim().slice(0, 50) });
  }
  out.offscreen = offscreen.slice(0, 25);

  // Clipped / truncated text inside an element.
  const trunc = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (!el.childNodes.length || !visible(el)) continue;
    const cs = getComputedStyle(el);
    if ((cs.overflowX === "hidden" || cs.overflowX === "clip" || cs.textOverflow === "ellipsis") && el.scrollWidth > el.clientWidth + 1 && (el.innerText || "").trim()) trunc.push({ path: path(el), text: el.innerText.trim().slice(0, 60), scroll: el.scrollWidth, client: el.clientWidth });
  }
  out.truncated = trunc.slice(0, 25);

  // Phone-size touch targets and input text size.
  const small = [], tinyInputs = [];
  if (vw < 1024) {
    for (const el of document.querySelectorAll("a[href],button,input:not([type=hidden]),select,textarea,summary,[role=tab],[role=button],label:has(input[type=checkbox]),label:has(input[type=radio])")) {
      if (!visible(el) || el.closest("nextjs-portal")) continue;
      const r = el.getBoundingClientRect();
      const inlineLink = el.tagName === "A" && el.closest("p,li") && getComputedStyle(el).display === "inline";
      if ((r.height < 44 || r.width < 24) && !inlineLink && !(el.type === "checkbox" || el.type === "radio")) small.push({ path: path(el), text: (el.innerText || el.getAttribute("aria-label") || el.value || "").trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) });
    }
    for (const el of document.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]),select,textarea")) if (visible(el) && parseFloat(getComputedStyle(el).fontSize) < 16) tinyInputs.push({ path: path(el), size: getComputedStyle(el).fontSize });
  }
  out.smallTargets = small.slice(0, 30);
  out.smallTargetCount = small.length;
  out.smallInputs = tinyInputs.slice(0, 15);

  // Rough text contrast against the nearest painted ancestor.
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const low = [];
  const w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.nodeValue.trim().length > 1 ? 1 : 2) });
  const seen2 = new Set();
  for (let t = w2.nextNode(); t; t = w2.nextNode()) {
    const el = t.parentElement;
    if (!el || seen2.has(el) || !visible(el) || el.closest("nextjs-portal,[aria-hidden=true],button:disabled,[aria-disabled=true]")) continue;
    seen2.add(el);
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    let bg = null;
    for (let n = el; n; n = n.parentElement) { bg = painted(n); if (bg && bg.a > 0.9) break; }
    if (!fg || !bg) continue;
    const L1 = lum(fg), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const large = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5) && fg.a > 0.5) low.push({ text: el.innerText.trim().slice(0, 50), ratio: Math.round(ratio * 100) / 100, size: cs.fontSize, path: path(el) });
  }
  out.lowContrast = low.slice(0, 20);

  out.unnamedControls = [...document.querySelectorAll("button,a[href],[role=button],[role=tab]")].filter((b) => visible(b) && !(b.innerText || "").trim() && !b.getAttribute("aria-label") && !b.getAttribute("aria-labelledby") && !b.getAttribute("title") && !b.querySelector("img[alt]:not([alt=''])")).map(path).slice(0, 10);
  out.imagesNoAlt = [...document.querySelectorAll("img:not([alt])")].map(path).slice(0, 10);
  out.pageHeight = document.documentElement.scrollHeight;
  out.textSample = (document.querySelector("main") ?? document.body).innerText.replace(/\s+/g, " ").slice(0, 600);
  return out;
}

// ---------- discover ----------
async function discover() {
  const browser = await chromium.launch();
  const ctx = await newContext(browser, CONFIGS["light-1440"], true);
  const page = await ctx.newPage();
  const urls = new Map();
  const add = (u, signedIn, from) => { const url = new URL(u, BASE); if (url.origin !== new URL(BASE).origin) return; const k = keyOf(url.pathname + url.search); if (!urls.has(k)) urls.set(k, { key: k, url: url.pathname + url.search, signedIn, from }); };
  for (const p of PUBLIC) add(p, false, "seed");
  for (const p of PRIVATE) add(p, true, "seed");
  await page.goto(`${BASE}/agents`);
  const agentIds = [...new Set((await page.$$eval("a[href^='/agents/']", (as) => as.map((a) => a.getAttribute("href")))).map((h) => h.match(/^\/agents\/([0-9a-f-]{36})/)?.[1]).filter(Boolean))];
  agentIds.forEach((id, i) => { for (const s of i === 0 ? AGENT_SECTIONS : ["overview"]) add(`/agents/${id}?section=${s}`, true, "agent"); });
  // in-page tab links and filters, one level deep, for every signed-in page
  for (const entry of [...urls.values()].filter((e) => e.signedIn)) {
    try {
      await page.goto(`${BASE}${entry.url}`);
      const links = await page.$$eval("main a[href*='?'], main [role=tablist] a[href], main nav a[href]", (as) => as.map((a) => a.getAttribute("href")));
      for (const l of links) { if (!l || l.startsWith("http")) continue; const u = new URL(l, BASE + entry.url); if (u.pathname === new URL(BASE + entry.url).pathname) add(u.pathname + u.search, true, entry.key); }
    } catch (e) { console.log(`discover ${entry.url}: ${e.message.split("\n")[0]}`); }
  }
  await browser.close();
  const list = [...urls.values()];
  await writeFile(`${DIR}urls.json`, JSON.stringify({ agentIds, urls: list }, null, 2));
  console.log(`${list.length} urls (${agentIds.length} agents) → urls.json`);
}

// ---------- capture ----------
async function capture(filter, cfgNames) {
  const { urls } = JSON.parse(await readFile(`${DIR}urls.json`, "utf8"));
  const re = filter && filter !== "all" ? new RegExp(filter) : null;
  const list = urls.filter((u) => !re || re.test(u.key) || re.test(u.url));
  const cfgs = (cfgNames ? cfgNames.split(",") : Object.keys(CONFIGS)).map((n) => [n, CONFIGS[n]]);
  await mkdir(`${OUT}/metrics`, { recursive: true });
  const browser = await chromium.launch();
  const jobs = [];
  for (const [name, cfg] of cfgs) for (const u of list) jobs.push({ name, cfg, u });
  let i = 0, done = 0;
  const summary = [];
  const worker = async () => {
    const ctxs = {};
    while (i < jobs.length) {
      const job = jobs[i++];
      const ck = `${job.name}:${job.u.signedIn}`;
      ctxs[ck] ??= await newContext(browser, job.cfg, job.u.signedIn);
      const page = await ctxs[ck].newPage();
      const errors = [];
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));
      try {
        const res = await page.goto(`${BASE}${job.u.url}`, { waitUntil: "networkidle" });
        await page.addStyleTag({ content: HIDE_DEV });
        await page.waitForTimeout(300);
        const m = await page.evaluate(measure);
        m.status = res?.status();
        m.finalUrl = new URL(page.url()).pathname + new URL(page.url()).search;
        m.consoleErrors = errors;
        const dir = `${OUT}/shots/${job.name}`;
        await mkdir(dir, { recursive: true });
        const H = job.cfg.height;
        const slices = Math.min(MAX_SLICES, Math.ceil(m.pageHeight / H));
        m.slices = slices;
        m.slicesTruncated = Math.ceil(m.pageHeight / H) > MAX_SLICES;
        for (let s = 0; s < (process.env.NOSHOTS ? 0 : slices); s++) {
          await page.screenshot({ path: `${dir}/${job.u.key}.s${s + 1}.jpg`, type: "jpeg", quality: 72, fullPage: true, clip: { x: 0, y: s * H, width: job.cfg.width, height: Math.min(H, m.pageHeight - s * H) } });
        }
        await writeFile(`${OUT}/metrics/${job.name}__${job.u.key}.json`, JSON.stringify(m, null, 2));
        summary.push({ cfg: job.name, key: job.u.key, url: job.u.url, final: m.finalUrl, status: m.status, overflowX: m.docOverflowX, scrollW: m.docScrollWidth, freeText: m.freeTextCount, offscreen: m.offscreen.length, truncated: m.truncated.length, smallTargets: m.smallTargetCount, smallInputs: m.smallInputs.length, lowContrast: m.lowContrast.length, errors: errors.length, h1: m.h1.length, slices });
      } catch (e) {
        summary.push({ cfg: job.name, key: job.u.key, url: job.u.url, failed: e.message.split("\n")[0] });
      } finally {
        await page.close();
        if (++done % 25 === 0) console.log(`${done}/${jobs.length}`);
      }
    }
    for (const c of Object.values(ctxs)) await c.close();
  };
  await Promise.all(Array.from({ length: Number(process.env.WORKERS ?? 4) }, worker));
  await browser.close();
  summary.sort((a, b) => (a.key + a.cfg).localeCompare(b.key + b.cfg));
  await writeFile(`${OUT}/summary.json`, JSON.stringify(summary, null, 1));
  console.log(`captured ${summary.filter((s) => !s.failed).length}/${jobs.length}; failures: ${summary.filter((s) => s.failed).length} → ${OUT}`);
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "discover") await discover();
else if (cmd === "capture") await capture(a, b);
else console.log("usage: node capture.mjs discover | capture [filter|all] [cfg,cfg]");
