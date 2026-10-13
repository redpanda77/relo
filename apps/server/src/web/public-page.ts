// One look for the pages the server renders outside the Dashboard app (iPhone sign-in, CLI
// authorization): the app's canvas and three glows, the orb and rounded wordmark, mono labels,
// a glass card and the coral capsule actions. Mirrors apps/dashboard/src/index.css.

export const publicPageStyle = `:root{color-scheme:dark;--bg:#08080d;--surface:#111119;--glass:rgba(255,255,255,.04);--border:rgba(255,255,255,.08);--text:#f3f3f7;--muted:#a4a4b6;--coral:#ff6b57;--action:#c8432f;--action-hover:#d4513b;--mint:#34d399;--orange:#ff8a3d;--red:#f87171;--violet:#8b7cff;--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;--rounded:ui-rounded,"SF Pro Rounded",-apple-system,BlinkMacSystemFont,system-ui,sans-serif}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;
background:radial-gradient(72rem 48rem at 92% -14%,rgba(214,92,240,.30),transparent 68%),radial-gradient(62rem 44rem at -10% 6%,rgba(124,107,255,.26),transparent 68%),radial-gradient(58rem 40rem at 64% 120%,rgba(255,107,87,.18),transparent 68%),var(--bg);background-attachment:fixed}
.mono{font:600 .68rem/1.2 var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
.top{display:flex;align-items:center;height:64px;padding:0 clamp(20px,4vw,32px)}
.lockup{display:inline-flex;align-items:center;gap:10px;color:#fff;text-decoration:none}
.orb{position:relative;display:grid;place-items:center;width:28px;height:28px;border:1px solid rgba(255,255,255,.2);border-radius:999px;background:radial-gradient(circle,rgba(139,124,255,.55),rgba(8,8,13,0) 70%)}
.orb::after{content:"";width:8px;height:8px;border-radius:999px;background:#fff;box-shadow:0 0 12px 3px var(--violet)}
.wordmark{font:700 1.45rem/1 var(--rounded);letter-spacing:-.03em}
.hero{display:grid;justify-items:center;gap:10px;padding:clamp(12px,5vh,48px) 16px 24px;text-align:center}
.hero .orb{width:76px;height:76px;box-shadow:0 0 60px rgba(124,107,255,.35)}.hero .orb::after{width:20px;height:20px;box-shadow:0 0 26px 8px var(--violet)}
.status{display:inline-flex;align-items:center;gap:8px;color:var(--mint)}.status.warn{color:var(--orange)}
.status::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 10px currentColor}
.card{position:relative;width:min(520px,calc(100% - 32px));margin:0 auto 48px;padding:clamp(22px,5vw,32px);border:1px solid var(--border);border-radius:28px;
background:linear-gradient(180deg,rgba(255,255,255,.035),transparent 50%),var(--glass);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 12px 24px rgba(0,0,0,.45);backdrop-filter:blur(24px) saturate(140%);-webkit-backdrop-filter:blur(24px) saturate(140%)}
@media (prefers-contrast:more),(prefers-reduced-transparency:reduce){.card{background:var(--surface);border-color:rgba(255,255,255,.24);backdrop-filter:none}}
h1{margin:0 0 8px;font:700 clamp(1.6rem,6vw,2rem)/1.15 var(--rounded);letter-spacing:-.02em;text-wrap:balance}
h2{margin:0 0 6px;font:700 1.3rem/1.2 var(--rounded);letter-spacing:-.01em}
p{margin:0 0 14px;color:var(--muted)}
dl{display:grid;gap:14px;margin:20px 0 24px;padding:14px 16px;border:1px solid var(--border);border-radius:16px;background:rgba(0,0,0,.25)}dl div{display:grid;gap:6px}
dt{margin:0}dd{margin:0;overflow-wrap:anywhere;font:.9rem/1.4 var(--mono)}
.actions{display:flex;flex-wrap:wrap;gap:10px}
button,.button-link{display:inline-flex;flex:1 1 0;align-items:center;justify-content:center;min-height:52px;padding:10px 20px;border:1px solid transparent;border-radius:999px;font:600 1rem/1 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;cursor:pointer;text-decoration:none;transition:background-color .16s ease,transform .16s cubic-bezier(.22,1,.36,1)}
button:active:not(:disabled){transform:scale(.985)}
.approve{position:relative;overflow:hidden;background:var(--action);color:#fff;box-shadow:0 10px 28px -10px rgba(200,67,47,.75),inset 0 1px 0 rgba(255,255,255,.22)}.approve:hover:not(:disabled){background:var(--action-hover)}
.approve::after{content:"";position:absolute;inset:-20% auto -20% -40%;width:32%;transform:skewX(-18deg);background:linear-gradient(90deg,transparent,rgba(255,255,255,.28),transparent);animation:shimmer 6s ease-in-out 1.4s infinite}
@keyframes shimmer{0%{left:-40%}18%,100%{left:120%}}
.deny{border-color:rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:var(--text)}.deny:hover:not(:disabled){background:rgba(255,255,255,.09)}
button:focus-visible,.button-link:focus-visible,input:focus-visible{outline:2px solid #a796ff;outline-offset:2px}
button:disabled{cursor:not-allowed;opacity:.55}
[hidden]{display:none!important}
@media (prefers-reduced-motion:reduce){.approve::after{display:none}*{animation:none!important;transition:none!important}}
@media (max-width:520px){.card{border-radius:22px}}`;

/** The top bar: orb and wordmark, linking home. */
export const publicPageTopBar = `<div class="top"><a class="lockup" href="/" aria-label="Relo"><span class="orb" aria-hidden="true"></span><span class="wordmark">relo</span></a></div>`;

/** True for a browser asking for a page, not an API or webhook client. */
export function wantsHtmlPage(path: string, accept: string | undefined): boolean {
  if (/^\/(api|hooks|health)(\/|$)/.test(path)) return false;
  return (accept ?? "").includes("text/html");
}

/** A branded page for a missing route or a failed request; no script, nothing from the request echoed. */
export function publicErrorPage(status: 404 | 500): string {
  const [title, heading, detail] = status === 404
    ? ["Page not found", "This page isn't here", "The link may be old, or the item was removed."]
    : ["Something went wrong", "Relo couldn't load this page", "Try again in a moment. If it keeps happening, check the server's logs."];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#08080d"><title>${title} · Relo</title><style>${publicPageStyle}.actions{margin-top:22px}.actions .button-link{flex:0 1 auto}</style></head>
<body>${publicPageTopBar}<header class="hero"><span class="orb" aria-hidden="true"></span><span class="mono status warn">${status === 404 ? "Not found" : "Error"} · ${status}</span></header>
<main class="card"><h1>${heading}</h1><p>${detail}</p><div class="actions"><a class="button-link approve" href="/dashboard">Go to Now</a></div></main></body></html>`;
}

export const publicErrorPageSecurityPolicy =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
