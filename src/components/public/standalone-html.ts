// The server-rendered HTML for the few responses that leave the app shell entirely: the
// OAuth "request not valid" page, a connect-callback failure, a malformed approval or
// household link, and the household invite confirmation (UI/UX pass: visual-03, public-09,
// public-29). Route handlers return these strings directly, so the page carries its own
// small style: the same --wh-* token values as globals.css/workspace.css for light and dark
// (prefers-color-scheme), the local Inter font, a brand bar and one panel with a way
// forward. No script and no remote assets; nothing from the request is ever echoed (callers
// pass fixed copy, and every value is escaped regardless).

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface StandaloneAction {
  readonly href: string;
  readonly label: string;
  readonly primary?: boolean;
}

export interface StandalonePage {
  // The document title, without the " · Warthog" suffix (added here).
  readonly title: string;
  readonly eyebrow?: string;
  readonly heading: string;
  readonly paragraphs: readonly string[];
  // Links shown as the panel's actions; the first primary one is the main way forward.
  readonly actions?: readonly StandaloneAction[];
  // Pre-built, trusted HTML placed after the paragraphs (e.g. a list or a POST form). Only
  // fixed markup built by the caller with escaped values belongs here.
  readonly bodyHtml?: string;
}

const STYLE = `
@font-face{font-family:Inter;font-style:normal;font-weight:100 900;font-display:swap;src:url(/fonts/inter/latin.woff2) format("woff2")}
:root{color-scheme:light dark;--canvas:#f5f6f7;--surface:#ffffff;--muted-surface:#f1f3f4;--fg:#282828;--muted:#5d5d5d;--line:#e7e7e7;--line-strong:#cdcdcd;--accent:#181818;--accent-hover:#303030;--accent-fg:#ffffff;--focus:#0169cc}
@media (prefers-color-scheme:dark){:root{--canvas:#191a1c;--surface:#252628;--muted-surface:#2d2f31;--fg:#dcdcdc;--muted:#afafaf;--line:#3c3c3c;--line-strong:#5d5d5d;--accent:#f3f3f3;--accent-hover:#dcdcdc;--accent-fg:#0d0d0d;--focus:#0285ff}}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;background:var(--canvas);color:var(--fg)}
body{min-height:100dvh;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);font:14px/1.6 Inter,ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.bar{background:var(--surface);border-bottom:1px solid var(--line)}
.bar-inner{display:flex;align-items:center;max-width:672px;min-height:64px;margin:0 auto;padding:8px 16px}
.brand{display:inline-flex;align-items:center;gap:8px;min-height:44px;font-size:18px;font-weight:600;letter-spacing:-.025em;text-decoration:none;border-radius:12px}
.brand svg{width:20px;height:20px;flex-shrink:0}
main{max-width:672px;margin:0 auto;padding:16px 16px 48px}
.panel{padding:24px 20px;border:1px solid var(--line);border-radius:16px;background:var(--surface);box-shadow:0 1px 2px rgb(0 0 0/5%)}
.panel .eyebrow{margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
h1{margin:0;font-size:24px;line-height:1.25;font-weight:600;letter-spacing:-.035em;text-wrap:balance}
p,li{color:var(--muted);font-size:15px;line-height:1.65}
.panel p{margin:12px 0 0}
ul{margin:12px 0 0;padding-left:20px}
li+li{margin-top:6px}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;margin-top:24px;padding-top:20px;border-top:1px solid var(--line)}
.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 20px;border:0;border-radius:999px;background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:500;text-decoration:none;cursor:pointer}
.button:hover{background:var(--accent-hover)}
.link{display:inline-flex;align-items:center;min-height:44px;text-decoration:underline;text-underline-offset:4px}
.link:hover{color:var(--muted)}
form{margin:0}
@media (min-width:640px){.bar-inner{padding-inline:32px;max-width:704px}main{padding:24px 32px 64px;max-width:704px}.panel{padding:32px 36px}h1{font-size:28px;line-height:1.2}}
@media (forced-colors:active){.button{border:1px solid ButtonText}}
`;

const SHIELD =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>';

// One action link: the primary as a pill button, the rest as underlined links.
export function actionHtml({ href, label, primary }: StandaloneAction): string {
  return `<a class="${primary ? "button" : "link"}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

export function standaloneHtml(page: StandalonePage): string {
  const paragraphs = page.paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join("");
  const actions = page.actions?.length ? `<div class="actions">${page.actions.map(actionHtml).join("")}</div>` : "";
  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(page.title)} · Warthog</title>
<style>${STYLE}</style>
</head>
<body>
<header class="bar"><div class="bar-inner"><a class="brand" href="/">${SHIELD}<span>Warthog</span></a></div></header>
<main>
<section class="panel" aria-labelledby="page-title">
${page.eyebrow ? `<p class="eyebrow">${escapeHtml(page.eyebrow)}</p>` : ""}<h1 id="page-title">${escapeHtml(page.heading)}</h1>
${paragraphs}${page.bodyHtml ?? ""}${actions}
</section>
</main>
</body>
</html>`;
}

// A standalone HTML response with the given status. `no-store` always; callers add any
// further headers they already send (framing, referrer policy).
export function standaloneResponse(page: StandalonePage, status: number, headers: Record<string, string> = {}): Response {
  return new Response(standaloneHtml(page), {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}
