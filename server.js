// BRAINFIRE — простой сервер для Railway: отдаёт index.html,
// картинки брейнротов из папки img (адрес /img/имя.png)
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
const zlib = require("zlib");

const PORT = process.env.PORT || 3000;
const FILE = path.join(__dirname, "index.html");
const IMG_DIR = path.join(__dirname, "img");
const TYPES = { ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml" };

// ---------- index.html держим в памяти уже сжатым (brotli и gzip) + ETag:
// при 100+ игроках файл не читается с диска на каждый заход, весит в ~1,5 раза меньше,
// а у того, кто уже заходил, Telegram не качает его заново (ответ 304, 0 байт).
let PAGE = null;   // { mtime, raw, br, gz, etag, text }
function page() {
  try {
    const st = fs.statSync(FILE);
    if (PAGE && PAGE.mtime === st.mtimeMs) return PAGE;
    const raw = fs.readFileSync(FILE);
    PAGE = {
      mtime: st.mtimeMs, raw, text: raw.toString("utf8"),
      br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
      gz: zlib.gzipSync(raw, { level: 9 }),
      etag: '"' + crypto.createHash("sha1").update(raw).digest("hex").slice(0, 20) + '"',
    };
  } catch { /* файла нет — ответим ошибкой ниже */ }
  return PAGE;
}
page();
setInterval(page, 15_000).unref();   // заменил index.html — через 15 с отдаётся новый

// картинки из папки img — тоже в памяти, с ETag
const IMGS = new Map();
function img(name) {
  const c = IMGS.get(name);
  if (c) return c;
  try {
    const data = fs.readFileSync(path.join(IMG_DIR, name));
    const v = { data, etag: '"' + crypto.createHash("sha1").update(data).digest("hex").slice(0, 20) + '"' };
    if (IMGS.size < 2000) IMGS.set(name, v);
    return v;
  } catch { return null; }
}

// настройки из index.html (CONFIG = { SUPABASE_URL: '...', ... })
function fromHtml(key) {
  const p = page();
  if (!p) return "";
  const m = new RegExp(key + "\\s*:\\s*['\"]([^'\"]*)['\"]").exec(p.text);
  return m ? m[1] : "";
}
const cfg = (k) => process.env[k] || fromHtml(k);

// ---------- общие данные для всех игроков: каталог, лента дропов, топ дроп, профиль из ленты.
// Берём из базы (Supabase REST, публичный ключ) и держим в памяти несколько секунд: при 100+ игроках
// база получает один запрос раз в 2–20 с, а функция api в Supabase не вызывается вовсе (у неё лимит вызовов).
const PUB = {
  catalog: { fn: "api_catalog", ttl: 20_000 },
  feed:    { fn: "api_feed",    ttl: 2_500 },
  top:     { fn: "api_top",     ttl: 15_000 },
  player:  { fn: "api_player",  ttl: 10_000 },
};
const PCACHE = new Map();   // ключ → { t, p: Promise<{ok, body}> }
function pubFetch(key, fn, args, ttl) {
  const now = Date.now(), c = PCACHE.get(key);
  if (c && now - c.t < ttl) return c.p;
  const url = cfg("SUPABASE_URL"), k = cfg("SUPABASE_ANON_KEY");
  const headers = { "Content-Type": "application/json", apikey: k };
  if (k.startsWith("eyJ")) headers.Authorization = "Bearer " + k;
  const p = fetch(url.replace(/\/$/, "") + "/rest/v1/rpc/" + fn, { method: "POST", headers, body: JSON.stringify(args), signal: AbortSignal.timeout(8000) })
    .then(async (r) => ({ ok: r.ok, data: r.ok ? await r.json() : null }))
    .catch(() => ({ ok: false, data: null }));
  PCACHE.set(key, { t: now, p });
  p.then((r) => { if (!r.ok) PCACHE.delete(key); });   // ошибку не запоминаем
  if (PCACHE.size > 500) for (const [kk, v] of PCACHE) if (now - v.t > 60_000) PCACHE.delete(kk);
  return p;
}
async function pubHandle(name, u, req, res) {
  const def = PUB[name];
  let r;
  if (name === "feed") {
    r = await pubFetch("feed", def.fn, { p_after: 0 }, def.ttl);
    const after = Number(u.searchParams.get("after")) || 0;
    if (r.ok) r = { ok: true, data: (r.data || []).filter((x) => x.id > after) };
  } else if (name === "player") {
    const id = Math.floor(Number(String(u.searchParams.get("drop") || "").replace(/^f/, ""))) || 0;
    r = await pubFetch("player:" + id, def.fn, { p_drop: id }, def.ttl);
  } else {
    r = await pubFetch(name, def.fn, {}, def.ttl);
  }
  if (!r.ok) { res.writeHead(502, { "Content-Type": "application/json", "Cache-Control": "no-store" }); return res.end('{"error":"upstream"}'); }
  const body = Buffer.from(JSON.stringify({ ok: true, data: r.data }));
  const h = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Vary: "Accept-Encoding" };
  if (body.length > 1024 && /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""))) {
    res.writeHead(200, { ...h, "Content-Encoding": "gzip" });
    return res.end(zlib.gzipSync(body, { level: 6 }));
  }
  res.writeHead(200, h);
  res.end(body);
}

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

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/health") { res.writeHead(200); return res.end("ok"); }

  // общие данные для сайта: /pub/catalog, /pub/feed?after=N, /pub/top, /pub/player?drop=fN
  const pm = /^\/pub\/(catalog|feed|top|player)$/.exec(u.pathname);
  if (pm) return pubHandle(pm[1], u, req, res);

  // картинки брейнротов: /img/tung-tung-sahur.png → папка img рядом с server.js
  if (u.pathname.startsWith("/img/")) {
    const name = decodeURIComponent(u.pathname.slice(5));
    const type = TYPES[path.extname(name).toLowerCase()];
    if (!type || name.includes("/") || name.includes("\\") || name.startsWith(".")) { res.writeHead(404); return res.end(); }
    const f = img(name);
    if (!f) { res.writeHead(404, { "Cache-Control": "public, max-age=60" }); return res.end(); }
    const h = { "Content-Type": type, "Cache-Control": "public, max-age=604800", ETag: f.etag };
    if (req.headers["if-none-match"] === f.etag) { res.writeHead(304, h); return res.end(); }
    res.writeHead(200, h);
    return res.end(f.data);
  }

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

  const p = page();
  if (!p) { res.writeHead(500); return res.end("index.html not found"); }
  const h = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",            // каждый раз сверяемся, но качаем заново только новую версию
    "X-Content-Type-Options": "nosniff",
    ETag: p.etag,
    Vary: "Accept-Encoding",
  };
  if (req.headers["if-none-match"] === p.etag) { res.writeHead(304, h); return res.end(); }
  const ae = String(req.headers["accept-encoding"] || "");
  if (/\bbr\b/.test(ae)) { res.writeHead(200, { ...h, "Content-Encoding": "br" }); return res.end(p.br); }
  if (/\bgzip\b/.test(ae)) { res.writeHead(200, { ...h, "Content-Encoding": "gzip" }); return res.end(p.gz); }
  res.writeHead(200, h);
  res.end(p.raw);
});
server.keepAliveTimeout = 65_000;   // дольше держим соединение — меньше новых подключений
server.headersTimeout = 66_000;
server.listen(PORT, () => console.log("BRAINFIRE работает на порту " + PORT));
