// BRAINFIRE — простой сервер для Railway: отдаёт index.html
// и обрабатывает ссылки партнёров вида  /r/КОД?src=tg&sub=shorts25
// (засчитывает переход и сразу открывает бота).
// Ничего устанавливать не нужно, только Node.js 18+ (Railway ставит его сам).
//
// Адрес Supabase, ключ и имя бота сервер берёт из CONFIG в index.html.
// При желании их можно задать в Railway → Variables:
//   SUPABASE_URL, SUPABASE_ANON_KEY, BOT_USERNAME
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const FILE = path.join(__dirname, "index.html");

// настройки из index.html (CONFIG = { SUPABASE_URL: '...', ... })
function fromHtml(key) {
  try {
    const html = fs.readFileSync(FILE, "utf8");
    const m = new RegExp(key + "\\s*:\\s*['\"]([^'\"]*)['\"]").exec(html);
    return m ? m[1] : "";
  } catch { return ""; }
}
const cfg = (k) => process.env[k] || fromHtml(k);

const SOURCES = ["tg", "yt", "tt", "tw", "vk", "kick", "ds", "other"];
const clean = (v, n) => String(v || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, n);

async function countClick(code, src, sub, req) {
  const url = cfg("SUPABASE_URL"), key = cfg("SUPABASE_ANON_KEY");
  if (!url) return;
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const h = crypto.createHash("sha256").update(ip + "|" + (req.headers["user-agent"] || "")).digest("hex").slice(0, 32);
  const headers = { "Content-Type": "application/json" };
  if (key) { headers.apikey = key; if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key; }
  try {
    await fetch(url.replace(/\/$/, "") + "/functions/v1/api", {
      method: "POST", headers, body: JSON.stringify({ action: "click", code, src, sub, h }),
      signal: AbortSignal.timeout(2500),
    });
  } catch { /* переход не засчитался — не страшно, игрок всё равно попадёт в бота */ }
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/health") { res.writeHead(200); return res.end("ok"); }

  // ссылка партнёра: /r/FORTIK?src=tg&sub=shorts25
  const m = /^\/r\/([A-Za-z0-9]{3,16})\/?$/.exec(u.pathname);
  if (m) {
    const code = m[1].toUpperCase();
    const src = SOURCES.includes(String(u.searchParams.get("src")).toLowerCase()) ? String(u.searchParams.get("src")).toLowerCase() : "";
    const sub = clean(u.searchParams.get("sub"), 24);
    await countClick(code, src, sub, req);
    const start = ["r", code, src, sub].join("_").replace(/_+$/, "");
    res.writeHead(302, { Location: `https://t.me/${cfg("BOT_USERNAME")}?startapp=${start}`, "Cache-Control": "no-store" });
    return res.end();
  }

  fs.readFile(FILE, (err, data) => {
    if (err) { res.writeHead(500); return res.end("index.html not found"); }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",            // чтобы Telegram сразу видел новую версию
      "X-Content-Type-Options": "nosniff",
    });
    res.end(data);
  });
}).listen(PORT, () => console.log("BRAINFIRE работает на порту " + PORT));
