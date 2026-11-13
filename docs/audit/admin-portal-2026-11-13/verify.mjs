// Admin portal browser verification (operator tool, not part of the app's suite; 13 November 2026).
// Drives a real headless Chromium against a running dev server with WARTHOG_DEV_TOOLS=1.
//
//   node verify.mjs signup   create the operator's account (OPERATOR_EMAIL) through the real
//                            sign-up flow with a virtual passkey; then RESTART the dev server so
//                            the first scheduler tick promotes it (the hourly operator-role sweep).
//   node verify.mjs verify   sign in as the operator (dev sign-in-as), open the admin portal from
//                            Settings (the handoff round trip), capture every admin page at the
//                            configured widths/themes, measure layout (free text, overflow,
//                            truncation, small targets, contrast) and write results.json + JPEGs.
//
// BASE (default http://localhost:3217), ADMIN (default http://admin.localhost:3217),
// EMAIL (default admin@example.test), OUT (default ./run). Playwright is not a Warthog
// dependency: PLAYWRIGHT_MODULE points at any local install.
import { mkdir, writeFile } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "/Users/oren.levy/Personal/skynet-group/skynet-ui/node_modules/playwright/index.mjs");

const DIR = new URL(".", import.meta.url).pathname;
const BASE = process.env.BASE ?? "http://localhost:3217";
const ADMIN = process.env.ADMIN ?? "http://admin.localhost:3217";
const EMAIL = process.env.EMAIL ?? "admin@example.test";
const OUT = process.env.OUT ?? `${DIR}run`;
const mode = process.argv[2] ?? "verify";
const step = (m) => console.log(`· ${m}`);
const fail = (m) => { console.log(`✗ ${m}`); process.exitCode = 1; };

const PAGES = ["/", "/signups", "/usage", "/accounts", "/reliability", "/traffic", "/system", "/signups?range=30d", "/usage?range=today", "/accounts?filter=no_agent", "/accounts?email=" + encodeURIComponent(EMAIL)];
const CONFIGS = {
  "light-320": { width: 320, height: 640, scheme: "light" },
  "light-390": { width: 390, height: 844, scheme: "light" },
  "light-1440": { width: 1440, height: 900, scheme: "light" },
  "dark-390": { width: 390, height: 844, scheme: "dark" },
  "dark-1440": { width: 1440, height: 900, scheme: "dark" },
  "light-land": { width: 844, height: 390, scheme: "light" },
};
const keyOf = (u) => (u === "/" ? "overview" : u.slice(1).replace(/[^a-z0-9]+/gi, "_")).slice(0, 80);

// ---------- in-page measurement (the UI/UX pass harness, trimmed) ----------
function measure() {
  const vw = document.documentElement.clientWidth;
  const out = { title: document.title, h1: [...document.querySelectorAll("h1")].map((h) => h.innerText.trim().slice(0, 80)) };
  out.docOverflowX = document.documentElement.scrollWidth > vw + 1;
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
  const painted = (n) => { const c = parse(getComputedStyle(n).backgroundColor); return c && c.a > 0.05 ? c : null; };
  const same = (a, b) => a && b && Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 6;
  const canvases = [];
  const main = document.querySelector("main");
  for (let n = main ?? document.body; n; n = n.parentElement) { const c = painted(n); if (c) { canvases.push(c); break; } }
  if (!canvases.length) canvases.push({ r: 255, g: 255, b: 255, a: 1 });
  const isCanvas = (c) => canvases.some((k) => same(k, c));
  const canvasEls = new Set([document.documentElement, document.body, ...document.querySelectorAll("main,.wh-main,.wh-workspace,.wh-page,[data-canvas]")]);
  for (let n = main; n; n = n.parentElement) canvasEls.add(n);
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.01; };
  const path = (el) => { const parts = []; for (let n = el; n && n !== document.body && parts.length < 5; n = n.parentElement) { let s = n.tagName.toLowerCase(); const cls = [...n.classList].filter((c) => c.startsWith("wh-")).slice(0, 2); if (cls.length) s += "." + cls.join("."); parts.unshift(s); } return parts.join(" > "); };
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
    free.push({ text: el.innerText.trim().replace(/\s+/g, " ").slice(0, 90), path: path(el) });
  }
  out.freeText = free.slice(0, 40); out.freeTextCount = free.length;
  const clipped = (el) => { for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) { if (getComputedStyle(n).overflowX !== "visible") return true; } return false; };
  const offscreen = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (el.closest("nextjs-portal,dialog:not([open])")) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if ((r.right > vw + 1 || r.left < -1) && !clipped(el) && visible(el) && getComputedStyle(el).position !== "fixed") offscreen.push({ path: path(el), left: Math.round(r.left), right: Math.round(r.right) });
  }
  out.offscreen = offscreen.slice(0, 20); out.offscreenCount = offscreen.length;
  const trunc = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (!el.childNodes.length || !visible(el)) continue;
    const cs = getComputedStyle(el);
    if ((cs.overflowX === "hidden" || cs.overflowX === "clip" || cs.textOverflow === "ellipsis") && el.scrollWidth > el.clientWidth + 1 && (el.innerText || "").trim() && !el.matches("[role=region],[tabindex]")) trunc.push({ path: path(el), text: el.innerText.trim().slice(0, 60) });
  }
  out.truncated = trunc.slice(0, 20); out.truncatedCount = trunc.length;
  const small = [], tinyInputs = [];
  if (vw < 1024) {
    for (const el of document.querySelectorAll("a[href],button,input:not([type=hidden]),select,textarea,summary,[role=tab],[role=button]")) {
      if (!visible(el) || el.closest("nextjs-portal")) continue;
      const r = el.getBoundingClientRect();
      const inlineLink = el.tagName === "A" && el.closest("p,li,td,dd") && getComputedStyle(el).display === "inline";
      if ((r.height < 44 || r.width < 24) && !inlineLink) small.push({ path: path(el), text: (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) });
    }
    for (const el of document.querySelectorAll("input:not([type=hidden]),select,textarea")) if (visible(el) && parseFloat(getComputedStyle(el).fontSize) < 16) tinyInputs.push({ path: path(el), size: getComputedStyle(el).fontSize });
  }
  out.smallTargets = small.slice(0, 20); out.smallTargetCount = small.length; out.smallInputs = tinyInputs;
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const low = [];
  const w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.nodeValue.trim().length > 1 ? 1 : 2) });
  const seen2 = new Set();
  for (let t = w2.nextNode(); t; t = w2.nextNode()) {
    const el = t.parentElement;
    if (!el || seen2.has(el) || !visible(el) || el.closest("nextjs-portal,[aria-hidden=true],.sr-only,button:disabled,[aria-disabled=true]")) continue;
    seen2.add(el);
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    let bg = null;
    for (let n = el; n; n = n.parentElement) { bg = painted(n); if (bg && bg.a > 0.9) break; }
    if (!fg || !bg) continue;
    const L1 = lum(fg), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const large = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5) && fg.a > 0.5) low.push({ text: el.innerText.trim().slice(0, 50), ratio: Math.round(ratio * 100) / 100, path: path(el) });
  }
  out.lowContrast = low.slice(0, 15); out.lowContrastCount = low.length;
  out.unnamedControls = [...document.querySelectorAll("button,a[href],[role=button],[role=tab]")].filter((b) => visible(b) && !(b.innerText || "").trim() && !b.getAttribute("aria-label") && !b.getAttribute("aria-labelledby") && !b.getAttribute("title")).map(path).slice(0, 10);
  out.chartsWithoutName = [...document.querySelectorAll("svg[role=img]")].filter((s) => !s.getAttribute("aria-label") && !s.querySelector("title")).length;
  out.textSample = (document.querySelector("main") ?? document.body).innerText.replace(/\s+/g, " ").slice(0, 300);
  return out;
}

async function virtualPasskey(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
}

// The dev server compiles a route on first use and may fully reload open pages while new
// chunks land; touching every route once before a flow keeps the flow's page stable.
async function warmUp(browser, urls) {
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const url of urls) { try { await page.goto(url, { waitUntil: "networkidle" }); } catch {} }
  await context.close();
}

async function signup(browser) {
  await warmUp(browser, [`${BASE}/signup`, `${BASE}/dev/outbox`, `${BASE}/home`, `${BASE}/settings`, `${ADMIN}/`]);
  const context = await browser.newContext();
  const page = await context.newPage();
  await virtualPasskey(context, page);
  await page.goto(`${BASE}/signup`);
  await page.getByLabel("Your name").fill("Operator");
  await page.getByLabel("Email address").fill(EMAIL);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "Check your email" }).waitFor({ timeout: 120000 });
  const outbox = await context.newPage();
  await outbox.goto(`${BASE}/dev/outbox`);
  const text = await outbox.locator("body").innerText();
  const at = text.lastIndexOf(EMAIL);
  const code = at === -1 ? null : (text.slice(at).match(/\b(\d{6})\b/) ?? [])[1];
  if (!code) return fail("no code in the dev outbox");
  await outbox.close();
  await page.getByLabel("Your code").fill(code);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Create a passkey" }).click({ timeout: 120000 });
  await page.getByText("I've saved it").waitFor({ timeout: 120000 });
  await page.getByLabel("I've saved it").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(`${BASE}/home`, { timeout: 120000 });
  step(`signed up ${EMAIL} → ${page.url()}. Now restart the dev server; its first scheduler tick promotes this account to admin.`);
  await context.close();
}

async function signInAs(context) {
  const response = await context.request.post(`${BASE}/dev/sign-in-as`, { data: { email: EMAIL }, headers: { origin: BASE } });
  if (!response.ok()) throw new Error(`dev sign-in-as ${response.status()}: ${await response.text()}`);
}

async function verify(browser) {
  await mkdir(OUT, { recursive: true });
  const results = { base: BASE, admin: ADMIN, when: new Date().toISOString(), handoff: {}, pages: {} };
  // 1. The handoff round trip from Settings, with a real browser navigation.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  await signInAs(context);
  await warmUp(browser, [`${BASE}/settings`, ...PAGES.map((p) => `${ADMIN}${p}`)]);
  const unauthenticated = await page.goto(`${ADMIN}/`);
  results.handoff.unauthenticatedLandsOn = page.url();
  step(`admin host without a session → ${page.url()} (${unauthenticated?.status()})`);
  await page.goto(`${BASE}/settings`);
  const entry = page.getByRole("button", { name: "Open admin portal" });
  if (!(await entry.count())) { fail("Settings shows no 'Open admin portal' control (is the account an admin yet?)"); await context.close(); return results; }
  await entry.click();
  await page.waitForURL((u) => u.origin === ADMIN, { timeout: 60000 });
  await page.waitForLoadState("networkidle");
  results.handoff.landedOn = page.url();
  results.handoff.cookie = (await context.cookies(ADMIN)).some((c) => c.name === "__Host-wh_admin");
  results.handoff.appOriginAdmin404 = (await context.request.get(`${BASE}/admin`)).status();
  results.handoff.adminOriginSignin404 = (await context.request.get(`${ADMIN}/api/auth/signin`)).status();
  results.handoff.adminOriginOauth404 = (await context.request.get(`${ADMIN}/oauth/authorize`)).status();
  const robots = await context.request.get(`${ADMIN}/usage`);
  results.handoff.robots = robots.headers()["x-robots-tag"] ?? null;
  step(`handoff → ${page.url()} cookie=${results.handoff.cookie} app/admin=${results.handoff.apporiginadmin404 ?? results.handoff.appOriginAdmin404} admin/api/auth/signin=${results.handoff.adminOriginSignin404} robots=${results.handoff.robots}`);
  const state = await context.storageState();
  await context.close();

  // 2. Every admin page at every configuration, measured.
  for (const [cfgName, cfg] of Object.entries(CONFIGS)) {
    const ctx = await browser.newContext({ viewport: { width: cfg.width, height: cfg.height }, colorScheme: cfg.scheme, hasTouch: cfg.width < 1024, storageState: state });
    const p = await ctx.newPage();
    const errors = [];
    p.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
    p.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    for (const path of PAGES) {
      const key = `${cfgName}-${keyOf(path)}`;
      try {
        const response = await p.goto(`${ADMIN}${path}`, { waitUntil: "networkidle" });
        const m = await p.evaluate(measure);
        m.status = response?.status();
        m.url = p.url();
        m.consoleErrors = errors.splice(0);
        results.pages[key] = m;
        await p.screenshot({ path: `${OUT}/${key}.jpg`, type: "jpeg", quality: 70, fullPage: cfg.width >= 1024 });
        const flags = [m.docOverflowX && "overflowX", m.freeTextCount && `free:${m.freeTextCount}`, m.offscreenCount && `offscreen:${m.offscreenCount}`, m.smallTargetCount && `small:${m.smallTargetCount}`, m.truncatedCount && `trunc:${m.truncatedCount}`, m.lowContrastCount && `contrast:${m.lowContrastCount}`, m.consoleErrors.length && `console:${m.consoleErrors.length}`, m.chartsWithoutName && `unnamedCharts:${m.chartsWithoutName}`].filter(Boolean);
        step(`${key} ${m.status} ${flags.length ? "⚠ " + flags.join(" ") : "ok"}`);
      } catch (e) {
        results.pages[key] = { error: String(e).slice(0, 300) };
        fail(`${key}: ${String(e).split("\n")[0]}`);
      }
    }
    await ctx.close();
  }

  try {
  // 3. Keyboard: the range tabs are links with aria-current; Back restores the earlier range.
  const kb = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: state });
  const kp = await kb.newPage();
  await kp.goto(`${ADMIN}/signups`);
  await kp.getByRole("link", { name: "30 days" }).first().click();
  await kp.waitForURL(/range=30d/);
  const current30 = await kp.locator("a[aria-current='page'][href*='range=30d']").count();
  await kp.goBack();
  await kp.waitForLoadState("networkidle");
  results.keyboard = { rangeLinkMarked: current30 > 0, backRestoredUrl: kp.url() };
  step(`range tabs: current marked=${current30 > 0}, after Back → ${kp.url()}`);
  // 4. Sign out of admin lands on the admin host's signed-out page (a cross-origin redirect
  // after a form POST would be blocked by CSP form-action); its link leads back to Settings;
  // the admin host then refuses.
  await kp.getByRole("button", { name: "Sign out of admin" }).click();
  await kp.waitForURL(`${ADMIN}/signed-out`, { timeout: 60000 });
  const signedOutPage = kp.url();
  await kp.getByRole("link", { name: "Back to Settings" }).click();
  await kp.waitForURL((u) => u.origin === BASE, { timeout: 60000 });
  results.signout = { signedOutPage, landedOn: kp.url(), adminAfter: (await kb.request.get(`${ADMIN}/`, { maxRedirects: 0 })).status() };
  step(`sign out → ${signedOutPage} → ${kp.url()}; admin host afterwards → ${results.signout.adminAfter}`);
  await kb.close();
  } catch (e) {
    results.interactionError = String(e).slice(0, 300);
    fail(`interaction checks: ${String(e).split("\n")[0]}`);
  }

  await writeFile(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  const pages = Object.values(results.pages);
  const summary = {
    pages: pages.length,
    failures: pages.filter((m) => m.error || (m.status && m.status >= 400)).length,
    overflow: pages.filter((m) => m.docOverflowX).length,
    freeText: pages.reduce((n, m) => n + (m.freeTextCount ?? 0), 0),
    offscreen: pages.reduce((n, m) => n + (m.offscreenCount ?? 0), 0),
    smallTargets: pages.reduce((n, m) => n + (m.smallTargetCount ?? 0), 0),
    smallInputs: pages.reduce((n, m) => n + (m.smallInputs?.length ?? 0), 0),
    truncated: pages.reduce((n, m) => n + (m.truncatedCount ?? 0), 0),
    lowContrast: pages.reduce((n, m) => n + (m.lowContrastCount ?? 0), 0),
    consoleErrors: pages.reduce((n, m) => n + (m.consoleErrors?.length ?? 0), 0),
    unnamedCharts: pages.reduce((n, m) => n + (m.chartsWithoutName ?? 0), 0),
  };
  console.log("summary " + JSON.stringify(summary));
  return results;
}

const browser = await chromium.launch();
try {
  if (mode === "signup") await signup(browser);
  else await verify(browser);
} finally {
  await browser.close();
}
