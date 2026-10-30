/**
 * 个人旅行摄影博客（微信朋友圈风格）
 * 零依赖 Node 服务：静态资源 + JSON API
 * 本地预览用 LocalStore；发布到 QW Pages 后由运行时注入 SUPABASE_URL/ANON_KEY 自动切换云端库。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net'); // clientIp() 用它做 net.isIP 校验
const { makeStore } = require('./lib/store');
const { seedIfEmpty } = require('./lib/seed');
const { migrateSnapshotToCloud } = require('./lib/migrate');
const { screenComment } = require('./lib/spam');
const visit = require('./lib/visit');

const COMMENT_MAX = 200; // 评论字数上限
const POST_MAX = 5000;   // 正文长度上限，与发布页 textarea 的 maxlength 对齐
const IMAGE_SIGNATURES = {
  'image/jpeg': (b) => b.length > 2 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.length > 7 && b.slice(0, 8).toString('hex') === '89504e470d0a1a0a',
  'image/gif': (b) => b.length > 5 && ['GIF87a', 'GIF89a'].includes(b.slice(0, 6).toString('ascii')),
  'image/webp': (b) => b.length > 11 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP',
};

/* 唯一的数据源默认值：前端不再各自抄一份（此前散在 index.html 兜底 src、
 * feed.js state.settings、admin.js DEFAULTS 共 4 处，改封面时真实漏改过）。
 * 对外只通过 GET /api/settings 下发，且只回下面这几个键，服务端自用键不外泄。 */
const PUBLIC_SETTING_KEYS = ['cover', 'avatar', 'nickname', 'sign', 'fx'];
const FX_VALUES = ['snow', 'blossom', 'off'];
const DEFAULT_SETTINGS = {
  cover: '/demo/cover.png',
  avatar: '/demo/ming.jpg',
  nickname: 'Ming',
  sign: '低调入尘埃',
  /* 飘落特效：三选一，互斥。值是字符串（setSettings 走 String(v).trim()）。
     取数失败时前端拿到 undefined，会退回这个默认值，不会整站没特效。 */
  fx: 'snow',
};

/* 访客填的主页、友链、音视频外链都走这一道：只允许 http(s)。统一"补协议 → new URL → 存 href"，
 * 存下来的值必然以 http(s):// 开头，javascript: / data: 之类进不来。 */
const URL_MAX = 2048;   // 浏览器与多数 CDN 的实际上限；不设限等于给库塞任意大的字符串
function safeHttpUrl(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v || v.length > URL_MAX) return null;   // 长度上限：一条 50 万字符的 URL 会原样进库并被每次发布重传
  if (/\s/.test(v)) return null; // 含空白的不是合法地址，直接判无效
  let u;
  try { u = new URL(/^https?:\/\//i.test(v) ? v : 'https://' + v); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname || !/\./.test(u.hostname)) return null; // 拒 "javascript" 这类无点主机
  // 内嵌凭证一律抹掉：`https://good.com@evil.com` 视觉上像 good.com，实际请求 evil.com，
  // 是典型的钓鱼写法；而 `https://user:pw@host` 会把口令明文摊在公开列表接口和页面 src 上。
  if (u.username || u.password) { u.username = ''; u.password = ''; }
  return u.href;
}

/* 音视频：只存「外链描述」，本站不托管媒体文件。两条硬理由：
 *  1) 发布包 = 项目目录全部内容，而 db.json 已有 4MB 纯图片 base64；几十 MB 的视频
 *     一旦进库，每次发布都要整个重传。
 *  2) base64 内联的接口给不出 HTTP Range，iOS Safari 对不能 seek 的视频源直接拒绝播放。
 * 所以这里只收 URL + 类型 + 是否自动播放，播放与拖动进度条由源站负责。
 * 非法条目（类型不认识、URL 不是 http(s)）静默丢弃而不是整条报错：
 * 用户贴错一个链接不该让他刚写的正文发不出去。但"丢了几条"要回传给调用方——
 * 更新时如果全部条目都被丢光，不能把人家原有的媒体当成"用户想清空"。 */
const MEDIA_KINDS = ['video', 'audio'];
const MEDIA_MAX = 3;
function sanitizeMedia(raw) {
  const empty = { list: [], dropped: 0 };
  if (!Array.isArray(raw)) return empty;
  const list = [];
  let dropped = 0;
  for (const it of raw) {
    if (!it || typeof it !== 'object') { dropped++; continue; }
    // kind 必须是字符串：String(['video']) 也等于 'video'，数组/对象不该蒙混过关
    const kind = typeof it.kind === 'string'
      ? (MEDIA_KINDS.indexOf(it.kind.trim().toLowerCase()) >= 0 ? it.kind.trim().toLowerCase() : null)
      : null;
    const url = safeHttpUrl(it.url);
    if (!kind || !url) { dropped++; continue; }
    const m = { kind, url, autoplay: it.autoplay === true || it.autoplay === 'true' };
    // 封面只对视频有意义；音频给个 poster 也无处显示，省得一团糊
    const poster = kind === 'video' ? safeHttpUrl(it.poster) : null;
    if (poster) m.poster = poster;
    list.push(m);
    if (list.length >= MEDIA_MAX) break;
  }
  return { list, dropped };
}

const PORT = Number(process.env.PORT || 8081);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'db.json');

const store = makeStore(DATA_DIR);

/* 安全响应头。script-src 不含 unsafe-inline，因此各页脚本已全部外置成文件；
 * style-src 保留 'unsafe-inline'：页面里有 style="display:none" 这类内联样式属性。 */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    /* 音视频与封面是外链（本站不托管媒体文件），所以 media-src / img-src 必须放开到 http(s)。
       不加这两条，default-src 'self' 会把所有站外媒体直接拦死——实测报
       "media-src ← …" 与 MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check，
       功能看着代码全对、线上一个字节都拉不到。
       注意：https 页面上引用 http 媒体仍会被浏览器按混合内容拦掉，那是浏览器策略，
       与 CSP 无关，所以编辑页提示里写明了要用 https 直链。 */
    "img-src 'self' data: blob: http: https:",
    "media-src http: https:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
  ].join('; '),
};

/* ---------------- 后台鉴权 ----------------
 * 修改密码：node -e "console.log(require('crypto').createHash('sha256').update('tm-blog-salt:新密码').digest('hex'))"
 * 然后把结果替换到 ADMIN_PASS_HASH。
 */
const ADMIN_USER = 'helloeddy';
const ADMIN_PASS_HASH = 'f71be0e5d6493fc8ba50f7d855898d18adfadcd1cf4a8af911f399252b947a76';
const SESSION_TTL = 7 * 24 * 3600 * 1000; // 7 天，滑动续期
const sessions = new Map(); // token -> expireAt

/* 登录限速：同一「IP+用户名」在窗口内累计 5 次失败就锁 60 秒，返回 429。
 * 站点完全公开且口令由用户自定，这一层是必需的。
 * IP 取 x-forwarded-for 首段——它可被伪造，所以这只是"抬高撞库成本"而非绝对防线；
 * 真正的防线是运行时的反代/IP 归一化。 */
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 60 * 1000;
const loginFails = new Map(); // key -> { n, first }

function clientIp(req) {
  const h = req.headers;
  // 候选顺序：CDN 自己写的头不可伪造优先，其次 XFF 最左段，最后 socket。
  // 但每一段都要过 net.isIP —— 否则客户端塞一个任意字符串进来就能凭空造一个"新访客"。
  const real = h['ali-swift-real-client-ip'] || h['x-real-ip'] || h['cf-connecting-ip'];
  const xff = h['x-forwarded-for'];
  const candidates = [real, typeof xff === 'string' ? xff.split(',')[0] : '', req.socket && req.socket.remoteAddress];
  for (const c of candidates) {
    const v = typeof c === 'string' ? c.trim() : '';
    if (v && net.isIP(v)) return v;
  }
  return 'unknown';
}

/* socket IP 不可伪造，用它给 /api/visit 兜一道节流：
 * 单个来源 60 秒内最多 20 次上报（真实用户刷新几十次才会撞上，脚本会立刻被限）。 */
const VISIT_WINDOW_MS = 60 * 1000, VISIT_MAX = 20;
const visitHits = new Map();
function visitLimited(req) {
  const sock = (req.socket && req.socket.remoteAddress) || 'unknown';
  const now = Date.now();
  let arr = (visitHits.get(sock) || []).filter((t) => now - t < VISIT_WINDOW_MS);
  if (arr.length >= VISIT_MAX) { visitHits.set(sock, arr); return true; }
  arr.push(now);
  visitHits.set(sock, arr);
  if (visitHits.size > 5000) {
    for (const [k, v] of visitHits) if (!v.some((t) => now - t < VISIT_WINDOW_MS)) visitHits.delete(k);
  }
  return false;
}


function loginLockInfo(key) {
  const rec = loginFails.get(key);
  if (!rec) return null;
  if (Date.now() - rec.first > LOGIN_WINDOW_MS) { loginFails.delete(key); return null; }
  return rec.n >= LOGIN_MAX_FAILS ? Math.ceil((rec.first + LOGIN_WINDOW_MS - Date.now()) / 1000) : null;
}

function noteLoginFail(key) {
  const rec = loginFails.get(key);
  if (!rec || Date.now() - rec.first > LOGIN_WINDOW_MS) loginFails.set(key, { n: 1, first: Date.now() });
  else rec.n += 1;
  if (loginFails.size > 2000) { // 防无界增长：过期项顺手清
    const now = Date.now();
    for (const [k, v] of loginFails) if (now - v.first > LOGIN_WINDOW_MS) loginFails.delete(k);
  }
}

/* 点赞改成可双击累加后，节流是唯一的刷量屏障（访客无需登录）。
 * 两道闸：突发 1 秒内最多 3 次；累计 60 秒内最多 60 次。 */
const LIKE_BURST_MS = 1000, LIKE_BURST_MAX = 3;
const LIKE_MINUTE_MS = 60 * 1000, LIKE_MINUTE_MAX = 60;
const likeHits = new Map(); // "ip|postId" -> [时间戳]

function likeWait(key) {
  const now = Date.now();
  let arr = (likeHits.get(key) || []).filter((t) => now - t < LIKE_MINUTE_MS);
  const minute = arr.length;
  const burst = arr.filter((t) => now - t < LIKE_BURST_MS).length;
  if (minute >= LIKE_MINUTE_MAX) {
    likeHits.set(key, arr);
    return Math.ceil((arr[0] + LIKE_MINUTE_MS - now) / 1000) || 1;
  }
  if (burst >= LIKE_BURST_MAX) { likeHits.set(key, arr); return 1; }
  arr.push(now);
  likeHits.set(key, arr);
  if (likeHits.size > 2000) {
    for (const [k, v] of likeHits) if (!v.some((t) => now - t < LIKE_MINUTE_MS)) likeHits.delete(k);
  }
  return 0;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* 独立访客：只存 sha256(ip + 固定盐)，不落原始 IP。
 * 盐必须固定，否则每次重启所有访客都变"新人"、计数直接归零；
 * 代价是拿到代码的人可以离线验证某个 IP 是否访问过（访客量级的小博客可接受）。 */
const VISITOR_SALT = 'tm-blog-visitor-salt';
const visitorHash = (ip) => sha256(VISITOR_SALT + ':' + ip).slice(0, 32);
const hashEq = (a, b) => {
  const ba = Buffer.from(a, 'hex'), bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((kv) => {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  });
  return out;
}
function isAdmin(req) {
  const t = parseCookies(req).tm_admin;
  if (!t || !sessions.has(t)) return false;
  if (Date.now() > sessions.get(t)) { sessions.delete(t); return false; }
  sessions.set(t, Date.now() + SESSION_TTL);
  return true;
}

/* ---------------- 工具 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(body);
}
function sendError(res, code, msg) { sendJson(res, code, { error: msg }); }

function readBody(req, limitMB = 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitMB * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

/* 只回白名单键：settings 里还有服务端自用的标记（如 _migrated），不能整包吐给浏览器 */
function publicSettings(raw) {
  const stored = { ...(raw || {}) };
  /* 旧版只有一个 snow: 'on' | 'off' 开关。在读取边界上一次性翻译成 fx，
     之后客户端只认 fx——避免两个键各说一套、改了一个另一个还留着旧值。 */
  if (stored.fx === undefined && stored.snow !== undefined) {
    stored.fx = String(stored.snow).trim() === 'off' ? 'off' : 'snow';
  }
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  if (FX_VALUES.indexOf(String(merged.fx).trim()) < 0) merged.fx = DEFAULT_SETTINGS.fx;
  else merged.fx = String(merged.fx).trim();
  const out = {};
  for (const k of PUBLIC_SETTING_KEYS) out[k] = merged[k];
  return out;
}

/* 注入首页用的公开设置快照：后台定时刷新，绝不挂在请求路径上——
   Supabase 驱动下 getSettings() 是一次网络往返，串进 HTML 响应会让首字节更晚。 */
let publicCache = null;
async function refreshPublicCache() {
  try { publicCache = publicSettings(await store.getSettings()); } catch (e) { /* 留着上一份，别让一次读失败把封面打回空 */ }
}

/* 资源版本号：按内容哈希。文件名不变而内容变了 URL 也跟着变，
   于是 js/css 可以放心给一年 immutable，不必每次打开都回源验证一轮。
   跨境链路一个 RTT 约 400ms，一次打开省掉 8 次验证 ≈ 3.2 秒。 */
const verMemo = new Map(); // filePath -> { key, ver }
function assetVer(full, st) {
  const key = st.mtimeMs + ':' + st.size;
  const hit = verMemo.get(full);
  if (hit && hit.key === key) return hit.ver;
  let ver;
  try { ver = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 10); }
  catch (e) { return null; }
  verMemo.set(full, { key, ver });
  return ver;
}

const IMG_FONT_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.otf'];

/** 给 HTML 里的 /js/*、/css/* 引用补版本号，并替封面/头像把 src 提前写进文档 */
function transformHtml(html) {
  html = html.replace(/((?:href|src)=")(\/(?:js|css)\/[^"?]+)(")/g, (m, pre, p, post) => {
    const full = path.normalize(path.join(PUBLIC_DIR, p.slice(1)));
    if (!full.startsWith(PUBLIC_DIR + path.sep)) return m;
    let st;
    try { st = fs.statSync(full); } catch (e) { return m; }
    if (!st.isFile()) return m;
    const v = assetVer(full, st);
    return v ? pre + p + '?v=' + v + post : m;
  });
  const s = publicCache || {};
  // 只有拿到值才写 src：src="" 会让浏览器去请求当前页面本身
  const fill = (attrs, val) => (val && !/\bsrc=/.test(attrs) ? `<img${attrs} src="${String(val).replace(/"/g, '&quot;')}">` : `<img${attrs}>`);
  for (const [id, val] of [['coverImg', s.cover], ['coverAvatar', s.avatar]]) {
    html = html.replace(new RegExp('<img([^>]*\\bid="' + id + '"[^>]*)>'), (m, attrs) => fill(attrs, val));
  }
  return html;
}

/* 缓存策略分级：
 *  - html：no-cache（它带着新版本号，必须每次验证）
 *  - js/css：带 ?v= 给一年 immutable；没带（旧链接、直接敲 URL）退回 no-cache 验证
 *  - 图片/字体：按名字不变，给一天——比原来的 300 秒少几十次回源
 *  - /api/images/ 另走一路，本来就是 immutable 一年 */
function cachePolicy(ext, url) {
  if (ext === '.html') return 'no-cache';
  if (ext === '.js' || ext === '.css') return /[?&]v=/.test(url) ? 'public, max-age=31536000, immutable' : 'no-cache';
  if (IMG_FONT_EXT.includes(ext)) return 'public, max-age=86400';
  return 'public, max-age=300';
}

function sendHtml(req, res, filePath, st) {
  let html;
  try { html = fs.readFileSync(filePath, 'utf8'); } catch (e) { res.writeHead(404); return res.end('Not Found'); }
  const body = Buffer.from(transformHtml(html), 'utf8');
  // ETag 必须按改写后的正文算：换了封面而文件 mtime 没变时，用文件指纹会让客户端继续拿旧页
  const etag = `W/"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
  const incs = req.headers['if-none-match'];
  const base = { ETag: etag, 'Last-Modified': new Date(Math.floor(st.mtimeMs)).toUTCString(), ...SECURITY_HEADERS };
  if (incs && incs.split(',').map((s) => s.trim()).includes(etag)) { res.writeHead(304, base); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Length': body.length, ...base });
  if (req.method === 'HEAD') return res.end();
  res.end(body);
}

function serveStatic(req, res, filePath) {
  let st;
  try { st = fs.statSync(filePath); } catch (e) { res.writeHead(404); return res.end('Not Found'); }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return sendHtml(req, res, filePath, st);
  const mime = MIME[ext] || 'application/octet-stream';
  const mtimeMs = Math.floor(st.mtimeMs);
  const etag = `W/"${st.size.toString(16)}-${mtimeMs.toString(16)}"`;
  const lastModified = new Date(mtimeMs).toUTCString();
  const inm = req.headers['if-modified-since'];
  const incs = req.headers['if-none-match'];
  // HTTP 日期只有秒级精度，两边都取整到秒再比，否则永远判定为“已修改”
  const mtimeSec = Math.floor(mtimeMs / 1000);
  const imsSec = inm ? Math.floor(Date.parse(inm) / 1000) : NaN;
  const notModified = (incs ? incs.split(',').map((s) => s.trim()).includes(etag) : false)
    || (Number.isFinite(imsSec) && imsSec >= mtimeSec);
  const base = { ETag: etag, 'Last-Modified': lastModified, ...SECURITY_HEADERS };
  if (notModified) { res.writeHead(304, base); return res.end(); }
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': cachePolicy(ext, req.url), ...base });
  if (req.method === 'HEAD') return res.end(); // HEAD 只回头部，不能吐 body
  fs.createReadStream(filePath)
    .on('error', () => {
      if (!res.headersSent) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS }); res.end('Not Found'); }
      else res.destroy(); // 头已发出就不能再往里写正文，只能断流
    })
    .pipe(res);
}

/* Secure 判定要三层兜底。实测 Page 运行时（函数计算）不透传 x-forwarded-proto，
 * 只看它会让线上会话 cookie 丢掉 Secure；只看 encrypted 又永远不成立（TLS 在网关终结）。
 * 因此再加"Host 不是本机/内网"这一条：发布出去的站点只有 https 入口。
 * 若将来把它跑在一个纯 http 的公网机器上，登录会因 Secure 被浏览器丢弃——
 * 那种部署请显式设 FORCE_INSECURE_COOKIE=1。 */
const PRIVATE_HOST = /^(localhost|127\.|\[::1\]|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;
function isHttps(req) {
  if (process.env.FORCE_INSECURE_COOKIE === '1') return false;
  if (req.headers['x-forwarded-proto'] === 'https') return true;
  if (req.socket && req.socket.encrypted) return true;
  return !PRIVATE_HOST.test(String(req.headers.host || ''));
}
const cookieFlags = 'Path=/; HttpOnly; SameSite=Lax';
const secureSuffix = (req) => (isHttps(req) ? '; Secure' : '');

/* ---------------- API ---------------- */
async function handleApi(req, res, pathname, query) {
  const method = req.method;
  const authed = isAdmin(req);

  // 鉴权接口（公开）
  if (pathname === '/api/login' && method === 'POST') {
    const b = await readBody(req);
    const user = String(b.user || '');
    const key = clientIp(req) + '|' + user;
    const wait = loginLockInfo(key);
    if (wait) {
      res.writeHead(429, { 'Retry-After': String(wait), 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
      return res.end(JSON.stringify({ error: `失败次数过多，请 ${wait} 秒后重试` }));
    }
    const ok = user === ADMIN_USER && hashEq(sha256('tm-blog-salt:' + String(b.pass || '')), ADMIN_PASS_HASH);
    if (!ok) {
      noteLoginFail(key);
      return sendError(res, 401, '用户名或密码错误');
    }
    loginFails.delete(key);
    // 登录成功换发新 token 并清掉旧的：缓解会话固定（cookie 由攻击者预设也活不过一次登录）
    for (const [t, exp] of sessions) if (exp < Date.now()) sessions.delete(t);
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, Date.now() + SESSION_TTL);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `tm_admin=${token}; ${cookieFlags}; Max-Age=${SESSION_TTL / 1000}${secureSuffix(req)}`,
      ...SECURITY_HEADERS,
    });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (pathname === '/api/logout' && method === 'POST') {
    const t = parseCookies(req).tm_admin;
    if (t) sessions.delete(t);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `tm_admin=; ${cookieFlags}; Max-Age=0${secureSuffix(req)}`,
    });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (pathname === '/api/session' && method === 'GET') {
    return sendJson(res, 200, { admin: authed });
  }

  // 管理操作需要登录：帖子增删改、设置、上传、草稿读取、评论管理/审核/统计。
  // 访客互动（点赞、评论、评论编辑/删除自己的）保持公开。
  const isPostItem = /^\/api\/posts\/[\w-]+$/.test(pathname);
  const isCommentModerate = /^\/api\/comments\/[\w-]+\/moderate$/.test(pathname);
  const isLinkItem = /^\/api\/links\/[\w-]+$/.test(pathname) && pathname !== '/api/links/batch-delete';
  const adminOnly =
    (pathname === '/api/upload' && method === 'POST') ||
    (pathname === '/api/settings' && method === 'PUT') ||
    (pathname === '/api/posts' && method === 'POST') ||
    (isPostItem && (method === 'PUT' || method === 'DELETE')) ||
    (pathname === '/api/comments' && method === 'GET') ||
    (pathname === '/api/comments/stats' && method === 'GET') ||
    (pathname === '/api/comments/batch-delete' && method === 'POST') ||
    (isCommentModerate && method === 'PUT') ||
    (pathname === '/api/links' && method === 'POST') ||
    (pathname === '/api/links/batch-delete' && method === 'POST') ||
    (isLinkItem && (method === 'PUT' || method === 'DELETE')) ||
    // 访客记录三条都要登录：里面是原始 IP 和省市，公开就等于把访客地理位置挂到公网上。
    // 注意是逐条精确列，不要写成 /^\/api\/visits/ 前缀匹配——/api/track/* 也必须保持公开。
    (pathname === '/api/visits' && method === 'GET') ||
    (pathname === '/api/visits/stats' && method === 'GET') ||
    (pathname === '/api/visits/batch-delete' && method === 'POST');
  const wantDrafts = pathname === '/api/posts' && method === 'GET' && query.get('drafts') === '1';
  if (!authed && (adminOnly || wantDrafts)) {
    return sendError(res, 401, '请先登录后台');
  }

  // 图片二进制
  let m = pathname.match(/^\/api\/images\/([\w-]+)$/);
  if (m && method === 'GET') {
    const img = await store.getImage(m[1]);
    if (!img) return sendError(res, 404, 'image not found');
    const buf = Buffer.from(img.data, 'base64');
    res.writeHead(200, { 'Content-Type': img.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Length': buf.length });
    return res.end(buf);
  }

  if (pathname === '/api/posts' && method === 'GET') {
    const includeDrafts = query.get('drafts') === '1';
    const posts = await store.listPosts(includeDrafts);
    const [likes, comments] = await Promise.all([store.allLikes(), store.allComments()]);
    for (const p of posts) {
      p.likes = likes.filter((l) => l.post_id === p.id);
      // 前台仅展示 visible 评论；后台草稿列表返回全部评论（含待审/屏蔽）以便计数与审核
      p.comments = comments.filter((c) => c.post_id === p.id && (includeDrafts || c.status === 'visible'));
    }
    // 后台草稿列表返回全量；前台信息流按页返回（默认每页 10 条）
    if (includeDrafts) return sendJson(res, 200, { posts });
    const pageSize = Math.min(50, Math.max(1, parseInt(query.get('limit'), 10) || 10));
    const total = posts.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    let page = parseInt(query.get('page'), 10) || 1;
    page = Math.min(Math.max(1, page), pages);
    const start = (page - 1) * pageSize;
    return sendJson(res, 200, { posts: posts.slice(start, start + pageSize), total, page, pageSize, pages });
  }

  if (pathname === '/api/posts' && method === 'POST') {
    const b = await readBody(req);
    // 先规范化 images 再做"三空"判定：上一版判定时用的是未规范化的 b.images，
    // 于是 {"content":"","images":"abc"} 能过关（字符串有 length），产出一条三全的空帖
    const images = Array.isArray(b.images) ? b.images.slice(0, 9) : [];
    const media = sanitizeMedia(b.media);
    if (!b.content && !images.length && !media.list.length) return sendError(res, 400, '内容、图片、音视频不能同时为空');
    if (String(b.content || '').length > POST_MAX) return sendError(res, 400, `正文不能超过 ${POST_MAX} 字`);
    const post = await store.createPost({
      content: String(b.content || ''),
      location: b.location ? String(b.location) : null,
      images,
      media: media.list,
      status: b.status === 'draft' ? 'draft' : 'published',
    });
    return sendJson(res, 200, { post, warning: store.mediaWarning });
  }

  m = pathname.match(/^\/api\/posts\/([\w-]+)$/);
  if (m && method === 'GET') {
    const post = await store.getPost(m[1]);
    // 草稿对访客一律 404：id 能从公开的 /api/posts 列表里拿到，
    // 少了这道判断，只要知道 id 就能匿名读到未发布内容的正文与图片。
    if (!post || (post.status !== 'published' && !authed)) return sendError(res, 404, 'post not found');
    post.likes = await store.listLikes(m[1]);
    const allC = await store.listComments(m[1]);
    post.comments = allC.filter((c) => c.status === 'visible');
    return sendJson(res, 200, { post });
  }
  if (m && method === 'PUT') {
    const b = await readBody(req);
    const patch = {};
    if (b.content !== undefined) {
      if (String(b.content).length > POST_MAX) return sendError(res, 400, `正文不能超过 ${POST_MAX} 字`);
      patch.content = String(b.content);
    }
    if (b.location !== undefined) patch.location = b.location ? String(b.location) : null;
    if (b.images !== undefined) patch.images = Array.isArray(b.images) ? b.images.slice(0, 9) : [];
    // 与创建走同一个清洗：否则"编辑时贴个 javascript: 链接"就能绕过发布时的校验
    if (b.media !== undefined) {
      const mm = sanitizeMedia(b.media);
      /* 全被丢光且原本有货时不动 media：
         "贴错一个链接"从"不挡发布"变成"顺手删掉旧媒体"是不可接受的。
         真要清空请显式传 media: []（清洗后 list 为空、dropped 为 0，走 else 分支）。 */
      if (mm.list.length || !mm.dropped) patch.media = mm.list;
      else console.warn('[media] 更新请求里的音视频条目全部非法，已保留原有媒体不覆盖');
    }
    if (b.status !== undefined) patch.status = b.status === 'draft' ? 'draft' : 'published';
    const post = await store.updatePost(m[1], patch);
    if (!post) return sendError(res, 404, 'post not found');
    return sendJson(res, 200, { post, warning: store.mediaWarning });
  }
  if (m && method === 'DELETE') {
    const post = await store.getPost(m[1]);
    if (!post) return sendError(res, 404, 'post not found');
    await store.deletePost(m[1]);
    return sendJson(res, 200, { ok: true });
  }

  m = pathname.match(/^\/api\/posts\/([\w-]+)\/like$/);
  if (m && method === 'POST') {
    const b = await readBody(req);
    const ck = String(b.clientKey || '');
    if (!ck) return sendError(res, 400, 'clientKey required');
    if (ck.length > 64) return sendError(res, 400, 'clientKey 过长');
    const wait = likeWait(clientIp(req) + '|' + m[1]);
    if (wait) {
      res.writeHead(429, { 'Retry-After': String(wait), 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
      return res.end(JSON.stringify({ error: '点赞太快了，稍候再试' }));
    }
    // 不再幂等去重：双击累加计数，所以每次调用都落一行（名字仍存，只是列表改显示总数）
    await store.addLike(m[1], ck, String(b.name || '游客').slice(0, 20));
    return sendJson(res, 200, { liked: true, likes: await store.listLikes(m[1]) });
  }
  if (m && method === 'DELETE') {
    const clientKey = query.get('clientKey');
    if (!clientKey) return sendError(res, 400, 'clientKey required');
    await store.removeLike(m[1], clientKey); // 清空"我"在这条下的全部赞
    return sendJson(res, 200, { liked: false, likes: await store.listLikes(m[1]) });
  }

  m = pathname.match(/^\/api\/posts\/([\w-]+)\/comments$/);
  if (m && method === 'POST') {
    const b = await readBody(req);
    if (!b.content || !String(b.content).trim()) return sendError(res, 400, '评论内容不能为空');
    if (!b.name || !String(b.name).trim()) return sendError(res, 400, '昵称不能为空');
    const content = String(b.content).trim();
    if (content.length > COMMENT_MAX) return sendError(res, 400, `评论不能超过 ${COMMENT_MAX} 字`);
    let replyToName = null;
    if (b.replyToId) {
      const all = await store.listComments(m[1]);
      const target = all.find((c) => c.id === b.replyToId);
      if (target) replyToName = target.name;
    }
    // 反垃圾筛查：命中 → pending（前台不展示，进后台待审）
    const check = screenComment(content);
    const comment = await store.addComment({
      post_id: m[1],
      name: String(b.name).trim(),
      content,
      reply_to_id: b.replyToId || null,
      reply_to_name: replyToName,
      client_key: b.clientKey ? String(b.clientKey) : null,
      site: safeHttpUrl(b.site), // 只接受 http(s)， javascript:/data: 之类一律置空
      status: check.flagged ? 'pending' : 'visible',
      flag_reason: check.reason,
    });
    return sendJson(res, 200, { comment });
  }

  /* ---------- 评论管理（后台） ---------- */
  if (pathname === '/api/comments/stats' && method === 'GET') {
    const all = await store.allComments();
    const by = (s) => all.filter((c) => c.status === s).length;
    return sendJson(res, 200, {
      stats: { total: all.length, visible: by('visible'), pending: by('pending'), hidden: by('hidden') },
    });
  }
  if (pathname === '/api/comments' && method === 'GET') {
    const status = query.get('status') || 'all';
    const pageSize = Math.min(100, Math.max(1, parseInt(query.get('limit'), 10) || 20));
    let page = parseInt(query.get('page'), 10) || 1;
    const [posts, all] = await Promise.all([store.listPosts(true), store.allComments()]);
    const postMap = {};
    posts.forEach((p) => { postMap[p.id] = { content: p.content, location: p.location }; });
    let list = all.slice();
    if (status !== 'all') list = list.filter((c) => c.status === status);
    list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const total = list.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    page = Math.min(Math.max(1, page), pages);
    const start = (page - 1) * pageSize;
    const rows = list.slice(start, start + pageSize).map((c) => ({
      ...c, post: postMap[c.post_id] || { content: '（内容已删除）', location: null },
    }));
    return sendJson(res, 200, { comments: rows, total, page, pageSize, pages });
  }
  m = pathname.match(/^\/api\/comments\/([\w-]+)\/moderate$/);
  if (m && method === 'PUT') {
    const b = await readBody(req);
    const st = ['visible', 'pending', 'hidden'].includes(b.status) ? b.status : null;
    if (!st) return sendError(res, 400, '非法状态');
    const updated = await store.updateCommentStatus(m[1], st, st === 'visible' ? null : undefined);
    if (!updated) return sendError(res, 404, '评论不存在');
    return sendJson(res, 200, { comment: updated });
  }

  m = pathname.match(/^\/api\/comments\/([\w-]+)$/);
  if (m && (method === 'PUT' || method === 'DELETE')) {
    const c = await store.getComment(m[1]);
    if (!c) return sendError(res, 404, '评论不存在');
    let ck = query.get('clientKey');
    let body = {};
    if (method === 'PUT') { body = await readBody(req); ck = body.clientKey; }
    // 非管理员只能操作自己（client_key 匹配）的评论
    if (!authed && (!ck || ck !== c.client_key)) return sendError(res, 403, '只能操作自己的评论');
    if (method === 'DELETE') {
      await store.deleteComment(m[1]);
      return sendJson(res, 200, { ok: true });
    }
    if (!body.content || !String(body.content).trim()) return sendError(res, 400, '评论内容不能为空');
    const content = String(body.content).trim();
    if (content.length > COMMENT_MAX) return sendError(res, 400, `评论不能超过 ${COMMENT_MAX} 字`);
    // 编辑后重新筛查
    const check = screenComment(content);
    const updated = await store.updateComment(m[1], content);
    await store.updateCommentStatus(m[1], check.flagged ? 'pending' : 'visible', check.reason);
    return sendJson(res, 200, { comment: { ...updated, status: check.flagged ? 'pending' : 'visible' } });
  }

  /* ---------- 独立访客计数（公开，只收 POST，由页面 JS 上报） ---------- */
  if (pathname === '/api/visit' && method === 'POST') {
    if (visitLimited(req)) {
      // 超限不再新增，但仍回真实总数：页脚那行不该因为限流而突然消失
      return sendJson(res, 200, { visitors: await store.countVisitors(), limited: true });
    }
    const total = await store.touchVisitor(visitorHash(clientIp(req)));
    return sendJson(res, 200, { visitors: total });
  }

  /* ---------- 访客访问记录 · 采集端（公开，由前台 track.js 上报） ----------
   * 三个写端点都不需要登录，所以每个都在 lib/visit.js 里按 socket IP 限流，
   * 并且只认服务端签发、且归属同一 visitor_hash 的 sid。
   * 埋点包体很小（10 条动作也就 3KB 上下），这里把上限收到 60KB，
   * 不给它一个"拿 20MB 图片上传额度来灌日志"的机会。 */
  if (pathname.startsWith('/api/track/') && method === 'POST') {
    if (pathname !== '/api/track/start' && pathname !== '/api/track/ping'
      && pathname !== '/api/track/event' && pathname !== '/api/track/end') {
      return sendError(res, 404, 'api not found');
    }
    let body;
    try { body = await readBody(req, 0.06); } catch (e) { return sendError(res, 400, '上报数据不合法'); }
    const ip = clientIp(req);
    const ctx = {
      ip,
      sockIp: (req.socket && req.socket.remoteAddress) || 'unknown',
      visitorHash: visitorHash(ip),
      authed,
      body,
    };
    if (pathname === '/api/track/start') return sendJson(res, 200, await visit.startSession(store, req, ctx));
    if (pathname === '/api/track/ping') return sendJson(res, 200, await visit.pingSession(store, ctx));
    if (pathname === '/api/track/event') return sendJson(res, 200, await visit.trackEvents(store, ctx));
    return sendJson(res, 200, await visit.endSession(store, ctx));
  }

  /* ---------- 访客访问记录 · 后台查询（需登录） ---------- */
  if (pathname === '/api/visits' && method === 'GET') {
    return sendJson(res, 200, await visit.listVisits(store, query));
  }
  if (pathname === '/api/visits/stats' && method === 'GET') {
    return sendJson(res, 200, await visit.visitStats(store));
  }
  if (pathname === '/api/visits/batch-delete' && method === 'POST') {
    const b = await readBody(req);
    const n = await visit.deleteVisits(store, b.ids);
    if (!n) return sendError(res, 400, '未选择有效的访问记录');
    return sendJson(res, 200, { ok: true, deleted: n });
  }

  /* 只回白名单键：settings 里还有服务端自用的标记（如 _migrated），不能整包吐给浏览器 */
  /* publicSettings 已上提到模块作用域：首页要把封面/头像直接写进 HTML，
     那边也得用同一个收敛逻辑，不能留两份各自演进的副本。 */

  if (pathname === '/api/settings' && method === 'GET') {
    const stored = await store.getSettings();
    return sendJson(res, 200, { settings: publicSettings(stored) });
  }
  if (pathname === '/api/settings' && method === 'PUT') {
    const b = await readBody(req);
    const patch = {};
    for (const k of PUBLIC_SETTING_KEYS) {
      if (b[k] === undefined) continue;
      const v = String(b[k]).trim();
      /* fx 是枚举值，写路径同样要把关：只靠读路径收敛的话，非法值会永久躺在库里，
         界面上选中项与库里存的值对不上，排查时极易误判成「我明明选了桃花」。 */
      if (k === 'fx' && FX_VALUES.indexOf(v) < 0) return sendError(res, 400, '特效取值只能是 snow / blossom / off');
      patch[k] = v;
    }
    const saved = await store.setSettings(patch);
    // 首页 HTML 里注入的封面/头像走的是后台快照，改完设置要立刻刷一次，
    // 否则管理员换了封面，访客拿到的还是旧图（最长要等到下一个刷新周期）。
    refreshPublicCache();
    return sendJson(res, 200, { settings: publicSettings(saved) });
  }

  /* ---------- 网上邻居（友情链接） ---------- */
  if (pathname === '/api/links' && method === 'GET') {
    return sendJson(res, 200, { links: await store.listLinks() });
  }
  if (pathname === '/api/links' && method === 'POST') {
    const b = await readBody(req);
    if (!b.name || !String(b.name).trim()) return sendError(res, 400, '名称不能为空');
    const url = safeHttpUrl(b.url); // 与评论 site 同一套协议白名单
    if (!url) return sendError(res, 400, '链接需以 http(s):// 开头且为合法地址');
    const link = await store.createLink({
      name: String(b.name).trim(), url,
      descr: b.descr ? String(b.descr).trim() : '', sort: Number(b.sort) || 0,
    });
    return sendJson(res, 200, { link });
  }
  if (pathname === '/api/links/batch-delete' && method === 'POST') {
    const b = await readBody(req);
    const ids = Array.isArray(b.ids) ? b.ids : [];
    const n = await store.deleteLinksByIds(ids);
    return sendJson(res, 200, { ok: true, deleted: n });
  }
  m = pathname.match(/^\/api\/links\/([\w-]+)$/);
  if (m && method === 'PUT') {
    const b = await readBody(req);
    const patch = {};
    if (b.name !== undefined) patch.name = String(b.name).trim();
    if (b.url !== undefined) {
      const url = safeHttpUrl(b.url); // 更新走的是同一条校验，别留"只有创建时把关"的缺口
      if (!url) return sendError(res, 400, '链接需以 http(s):// 开头且为合法地址');
      patch.url = url;
    }
    if (b.descr !== undefined) patch.descr = String(b.descr).trim();
    if (b.sort !== undefined) patch.sort = Number(b.sort) || 0;
    const link = await store.updateLink(m[1], patch);
    if (!link) return sendError(res, 404, '链接不存在');
    return sendJson(res, 200, { link });
  }
  if (m && method === 'DELETE') {
    await store.deleteLink(m[1]);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/comments/batch-delete' && method === 'POST') {
    const b = await readBody(req);
    const ids = Array.isArray(b.ids) ? b.ids : [];
    if (!ids.length) return sendError(res, 400, '未选择评论');
    const n = await store.deleteCommentsByIds(ids);
    return sendJson(res, 200, { ok: true, deleted: n });
  }

  if (pathname === '/api/upload' && method === 'POST') {
    const b = await readBody(req, 25);
    if (!b.data || !b.mime || !/^image\/(jpeg|png|webp|gif)$/.test(b.mime)) {
      return sendError(res, 400, '仅支持 jpg/png/webp/gif 图片');
    }
    let buf;
    try { buf = Buffer.from(String(b.data), 'base64'); }
    catch (e) { return sendError(res, 400, '图片数据无法解析'); }
    if (buf.length > 8 * 1024 * 1024) return sendError(res, 400, '图片不能超过 8MB');
    // 按真实文件头校验，不能信前端声明的 mime：/api/images 会原样带着存储的 mime 回吐，
    // 声明成 image/* 却塞进别的字节，等于给了一个可托管任意内容的同域 URL
    if (!(IMAGE_SIGNATURES[b.mime] || (() => false))(buf)) {
      return sendError(res, 400, '文件内容与声明的图片格式不符');
    }
    const id = await store.saveImage(b.mime, buf.toString('base64'));
    return sendJson(res, 200, { id, url: `/api/images/${id}` });
  }

  sendError(res, 404, 'api not found');
}

/* ---------------- Server ---------------- */
const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch (e) { res.writeHead(400, SECURITY_HEADERS); return res.end('Bad Request'); }
  // 只解码 pathname：把整条 URL（含 ?drafts=1）一起解码会让 searchParams 解析不到参数，
  // 后台草稿列表因此永远拿不到 drafts=1（本地按 ?param 分栏、线上按 & 拼接，才没被发现）。
  // 必须包 try：decodeURIComponent 对畸形百分号（GET /%zz、/%E4%AD）会抛 URIError，
  // 而这一行在下面的 try 之外——裸抛就是未捕获异常，整个 Node 进程直接退出。
  // 实测一条 `curl /%zz` 就能让本地服务与线上容器同时挂掉（远程可复现的 DoS）。
  let pathname;
  try { pathname = decodeURIComponent(u.pathname); }
  catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    return res.end('Bad Request');
  }

  // Windows 下 \ 也是路径分隔符。new URL() 只规范化 / 形式的点段，%5c 要等
  // decodeURIComponent 之后才变成 \，所以必须在 join 之前拒掉，否则 ..\ 能跳出 web 根。
  if (pathname.includes('\\') || /%5c/i.test(req.url)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    return res.end('Bad Request');
  }

  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, u.searchParams);
  } catch (e) {
    /* 上游报错原文（含 Supabase 主机名与 /rest/v1/... 路径）只进服务端日志：
       直接吐给浏览器等于把内部拓扑和一句 SQL 错误细节公开出去，
       而前台/后台看到的本来就该是"服务暂时不可用"这种可行动的信息。 */
    console.error('[api error]', pathname, e.message);
    if (!res.headersSent) return sendError(res, 500, '服务暂时不可用，请稍后重试');
    return res.end();
  }

  // 静态资源
  let file = pathname === '/' ? '/index.html' : pathname;
  if (pathname === '/admin') file = '/admin.html';
  if (pathname === '/edit') file = '/edit.html';
  if (pathname === '/login') file = '/login.html';
  // 管理页面需登录
  if (['/admin', '/admin.html', '/edit', '/edit.html'].includes(file) && !isAdmin(req)) {
    res.writeHead(302, { Location: '/login', ...SECURITY_HEADERS });
    return res.end();
  }
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  // 必须带分隔符比较：只写 startsWith(PUBLIC_DIR) 时，同级 public_backup/ 这类
  // "名字以 public 开头"的目录会被判为合法而读出去。
  const inside = full === PUBLIC_DIR || full.startsWith(PUBLIC_DIR + path.sep);
  if (!inside) { res.writeHead(403, SECURITY_HEADERS); return res.end('Forbidden'); }
  if (fs.existsSync(full) && fs.statSync(full).isFile()) return serveStatic(req, res, full);
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
  res.end('Not Found');
});

/* 先监听端口，再做可能要跑几秒的导入/播种。
 * 原先是 await 迁移完才 listen：3.3MB 快照要几十次云端插入，Page 运行时的健康检查
 * 可能在端口就绪前超时并重启容器，而"是否已导入"当时是按帖子数判断的——帖子插在
 * 评论/点赞之前，中途重启就会留下永久不完整的库。 */
const MIGRATION_FLAG = '_migrated';

/* 访问日志是滚动留存的（默认 90 天 + 两张表各自的行数上限，见 lib/visit.js）。
 * 只在启动时清一次、之后每 6 小时一次；不做"每次写入顺手清"——
 * 那会让流量最高的那台实例清得最勤，而本地是整表扫描。 */
const PURGE_EVERY_MS = 6 * 3600 * 1000;
async function purgeVisitsQuietly() {
  try {
    const r = await visit.purgeVisits(store);
    if (r && (r.sessions || r.events)) console.log(`[visits] 滚动清理：会话 ${r.sessions} 条、动作 ${r.events} 条`);
  } catch (e) {
    // 清理失败只是数据多留一会儿，不该把访问带崩
    console.warn('[visits] 滚动清理失败:', e.message);
  }
}

async function bootstrap() {
  try {
    if (store.kind === 'supabase') {
      const stored = await store.getSettings();
      if (!stored[MIGRATION_FLAG]) {
        const already = await store.countPosts();
        if (already > 0) {
          // 有内容却没标记：可能是旧版本导入过（当时还没有标记机制），也可能是上次中断。
          // 两种情况都不该再跑一遍（会重复写入），所以跳过并把两种可能都写清楚。
          console.warn('[migrate] 云端已有内容但缺少迁移标记（可能是早期版本导入，或上次导入中断）；'
            + '已跳过自动导入以免重复写入，如需核对请比对线上与 data/db.json 的条目');
        } else {
          const moved = await migrateSnapshotToCloud(store, SNAPSHOT_FILE);
          if (moved) {
            await store.setSettings({ [MIGRATION_FLAG]: new Date().toISOString() });
            console.log('[migrate] 本地快照已导入云端:', JSON.stringify(moved));
          }
        }
      }
    }
    const n = await store.countPosts();
    if (n === 0) {
      await seedIfEmpty(store, path.join(ROOT, 'assets', 'demo'));
      console.log('[seed] 已写入示例内容');
    }
    await purgeVisitsQuietly();
  } catch (e) {
    console.error('[boot error]', e.message);
  }
}

const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`朋友圈风格个人博客已启动: http://localhost:${PORT}`);
  console.log(`管理后台: http://localhost:${PORT}/admin`);
  bootstrap(); // 不 await：端口先可用，导入在后台进行
  // 首页注入封面/头像用的设置快照：启动先取一次（拿不到也不挡端口），之后每 30s 兜底刷新。
  // 30s 只是保险——改设置的路径上已经主动刷过一次，这里防的是有人直接改库。
  refreshPublicCache();
  setInterval(refreshPublicCache, 30 * 1000).unref();
  // unref：这个定时器不该吊住进程，也不该被当成"还有活要干"
  setInterval(purgeVisitsQuietly, PURGE_EVERY_MS).unref();
  // 退出前把合并写入窗口里的访问日志落盘（本地 JSON 驱动才有；云端是逐条写入）
  process.on('exit', () => { if (typeof store._flush === 'function') store._flush(); });
});
