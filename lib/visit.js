/**
 * 访客访问记录（会话 + 行为流水）的服务端核心。
 *
 * 职责边界：这里只管"采集与编排"——校验入参、限流、算时长、查归属地、组装后台要看的形状。
 * 落库全在 lib/store.js 的两个驱动里（本地 JSON ↔ Supabase 同构接口）。
 *
 * 三条设计前提，改之前先看：
 *  1) **时长以服务端心跳累加为准，不信客户端上报的秒数。**
 *     前端每 30 秒 ping 一次，每次给 `now - last_seen` 记账，并设单次上限
 *     （后台标签页的定时器会被浏览器节流到分钟级，不设上限就会漏算；
 *      设了上限也不会被伪造——客户端没有"往时长里加数"的入口）。
 *  2) **会话 sid 由服务端签发。** 客户端传来的 sid 只是"我想接着这个会话记"的凭据：
 *     认得、且归属同一 visitor_hash、且半小时内活跃过才复用，否则新发一个。
 *     否则任何人都能猜一个 sid 把动作记到别人的会话上。
 *  3) **公开写接口一律限流 + 白名单 + 长度截断。** start/ping/event 都不需要登录，
 *     不设闸就等于给全站开了一个可以无限撑大数据库的口子。
 */
'use strict';

const crypto = require('crypto');
const { resolveIp } = require('./geoip');

/* ---------------- 常量 ---------------- */
const EVENT_LABEL = {
  pv: '浏览页面',
  post_read: '阅读内容',
  like: '点赞',
  unlike: '取消点赞',
  comment: '发表评论',
  cmt_edit: '编辑评论',
  cmt_del: '删除评论',
  image_view: '查看大图',
  blogroll_click: '点击友情链接',
  page_turn: '翻页',
};
const EVENT_TYPES = new Set(Object.keys(EVENT_LABEL));
const EVENTS_PER_FLUSH = 10;        // 单次上报最多几条（超出的直接丢，不给客户端"一次灌一万条"）
const SESSION_EVENTS_MAX = 500;     // 单会话动作上限（挂一整天页面的极端情况）
const TARGET_MAX = 64, DETAIL_MAX = 200;
const SID_RE = /^vs_[0-9a-f]{8,40}$/;
const REUSE_WINDOW_MS = 30 * 60 * 1000;   // 超过这个空档的 sid 不再复用，另起一次访问
const PING_CREDIT_MAX = 90 * 1000;        // 单次心跳最多计入 90 秒

// 留存策略：90 天滚动 + 两张表的行数上限。三个值都可在 server.js 顶部改。
const RETENTION_DAYS = 90;
const SESSIONS_MAX = 20000;
const EVENTS_MAX = 50000;

/* ---------------- 限流 ---------------- */
/* 通用滑动窗口计数（按 socket IP，不可伪造那一层）。
 * 与 server.js 里 visitLimited / likeWait 同一思路，但这里有三类端点，
 * 所以抽成工厂，而不是再抄三份 Map。 */
function makeLimiter(windowMs, max) {
  const hits = new Map();
  return function limited(key) {
    const now = Date.now();
    let arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return true; }
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    }
    return false;
  };
}
const limitStart = makeLimiter(60 * 1000, 20);   // 新建会话：每分钟 20 次
const limitWrite = makeLimiter(60 * 1000, 90);   // ping + event 合计：每分钟 90 次

/* ---------------- 小工具 ---------------- */
const genSid = () => 'vs_' + crypto.randomBytes(8).toString('hex');

/* 控制字符与超长都要抹掉：这些字符串会原样出现在后台表格里，
 * 一个 \u0000 或 5000 字的 target 就能把一行撑爆。 */
function clean(s, max) {
  const v = typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  return v ? v.slice(0, max) : null;
}

function credit(lastSeen) {
  const t = Date.parse(lastSeen || '');
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.min(Date.now() - t, PING_CREDIT_MAX));
}

/* ---------------- UA 解析 ---------------- */
/* 够用即可，不引库。判断顺序有讲究：国产壳浏览器（微信/QQ/UC/夸克…）的 UA 里
 * 都带 Chrome，先匹 Chrome 就会把微信里打开的页面全记成 Chrome。 */
function parseUA(raw) {
  const ua = String(raw || '').slice(0, 256);
  const out = { ua, device: '其它', browser: '未知', os: '未知', bot: false };
  if (!ua) return out;
  if (/bot|crawler|spider|slurp|curl|wget|python|httpclient|headless|okhttp|feedfetcher/i.test(ua)) out.bot = true;

  let m;
  if (/MicroMessenger|WeChat/i.test(ua)) out.browser = '微信';
  else if (/wxwork|WeCom/i.test(ua)) out.browser = '企业微信';
  else if (/DingTalk/i.test(ua)) out.browser = '钉钉';
  else if (/AlipayClient/i.test(ua)) out.browser = '支付宝';
  else if (/QQBrowser|QQ\/|MQQBrowser/i.test(ua)) out.browser = 'QQ浏览器';
  else if (/Quark/i.test(ua)) out.browser = '夸克';
  else if (/UCBrowser/i.test(ua)) out.browser = 'UC浏览器';
  else if (/Edg(A|iOS|)\//i.test(ua)) out.browser = 'Edge';
  else if (/OPR\/|Opera/i.test(ua)) out.browser = 'Opera';
  else if (/Firefox\/|FxiOS\//i.test(ua)) out.browser = 'Firefox';
  else if (/CriOS/i.test(ua)) out.browser = 'Chrome';
  else if (/Chrome|Chromium|Silk/i.test(ua)) out.browser = 'Chrome';
  else if (/Version\/.*Safari|Safari/i.test(ua)) out.browser = 'Safari';

  if (/HarmonyOS|ArkWeb/i.test(ua)) out.os = '鸿蒙';
  else if (/iPhone|iPad|iPod|iOS/i.test(ua)) out.os = 'iOS';
  else if (/Android/i.test(ua)) out.os = 'Android';
  else if (/Windows/i.test(ua)) out.os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(ua)) out.os = 'macOS';
  else if (/CrOS/i.test(ua)) out.os = 'ChromeOS';
  else if (/Linux/i.test(ua)) out.os = 'Linux';

  m = /(iPhone|iPad|iPod)/.exec(ua);
  if (/iPad|Tablet/i.test(ua) || (/Android/.test(ua) && !/Mobile/i.test(ua))) out.device = '平板';
  else if (/Mobi|iPhone|iPod|Android/.test(ua)) out.device = '手机';
  else if (/Windows|Macintosh|Mac OS X|Linux x86|CrOS/.test(ua)) out.device = '电脑';
  else if (out.bot) out.device = '机器人';
  if (m) out.device = '平板'; // iPad 的 UA 现在也带 Macintosh，得在电脑判定后兜回来
  return out;
}

/* ---------------- 采集端点 ---------------- */

/* 开始/续用一个会话。
 * 归属地不能在这里 await：一次在线查询最长 2.5 秒，把它放在访客页面的首屏请求链上
 * 不值当。所以先落一条 geo 为空的会话立刻回包，查询在后台完成后补写那一行。 */
async function startSession(store, req, ctx) {
  if (limitStart(ctx.sockIp)) {
    // 被限流时仍把客户端手上的 sid 回给它：让它停在自己的会话上，而不是反复重试新建
    const sid = clean(ctx.body.sid, 48);
    return { sid: sid && SID_RE.test(sid) ? sid : null, limited: true };
  }
  const ip = ctx.ip;
  const ua = parseUA(req.headers['user-agent']);
  const wanted = clean(ctx.body.sid, 48);
  if (wanted && SID_RE.test(wanted)) {
    const exist = await store.getSession(wanted);
    if (exist && exist.visitor_hash === ctx.visitorHash
      && Date.now() - (Date.parse(exist.last_seen || exist.started_at) || 0) < REUSE_WINDOW_MS) {
      await store.updateSession(exist.id, { last_seen: new Date().toISOString(), ended: false, admin: ctx.authed });
      return { sid: exist.id, resumed: true };
    }
  }
  const now = new Date().toISOString();
  const row = {
    id: genSid(),
    visitor_hash: ctx.visitorHash,
    ip,
    geo_label: null, geo_country: null, geo_region: null, geo_city: null, geo_isp: null,
    ua: clean(ua.ua, 256) || '',
    device: ua.device, browser: ua.browser, os: ua.os, bot: ua.bot,
    admin: ctx.authed === true,
    referrer: clean(ctx.body.referrer, 300) || '',
    page: clean(ctx.body.page, 200) || '/',
    started_at: now,
    last_seen: now,
    duration_ms: 0,
    pv: 0,
    event_count: 0,
    ended: false,
  };
  await store.createSession(row);
  // 机器人不进在线查询队列：爬虫换 IP 极快，缓存永远命中不了，白烧额度
  if (!ua.bot) {
    resolveIp(store, ip).then((geo) => {
      if (!geo) return;
      return store.updateSession(row.id, {
        geo_label: geo.label, geo_country: geo.country, geo_region: geo.region,
        geo_city: geo.city, geo_isp: geo.isp,
      });
    }).catch((e) => console.warn('[geoip] 补写归属地失败:', e.message)); // 必须 catch：未处理的 rejection 会打死进程
  }
  return { sid: row.id, fresh: true };
}

/* 心跳：给会话记一次时长。sid 不认（过期/不是这个访客）就回 ok:false，前端据此停止心跳。
 * body.sync=true 表示"只把时钟拨到此刻、这一段不计入时长"——
 * 用于标签页从后台切回前台的瞬间：不这么做的话，"合上电脑十分钟再打开"
 * 会被算成十分钟浏览（实际只补了一个 PING_CREDIT_MAX 的零头，但那是白送的假时长）。 */
async function pingSession(store, ctx) {
  const sid = clean(ctx.body.sid, 48);
  if (!sid || !SID_RE.test(sid)) return { ok: false };
  if (limitWrite(ctx.sockIp)) return { ok: true };   // 限流：这一拍不记账，但别让前端误判会话已死
  const s = await store.getSession(sid);
  if (!s || s.visitor_hash !== ctx.visitorHash) return { ok: false };
  const patch = ctx.body.sync
    ? { last_seen: new Date().toISOString() }
    : {
      duration_ms: (Number(s.duration_ms) || 0) + credit(s.last_seen),
      last_seen: new Date().toISOString(),
      ended: false,
    };
  await store.updateSession(sid, patch);
  return { ok: true };
}

/* 批量行为上报。非法条目静默丢弃并回传条数，前端不需要为它做任何事。 */
async function trackEvents(store, ctx) {
  const sid = clean(ctx.body.sid, 48);
  if (!sid || !SID_RE.test(sid)) return { ok: false, accepted: 0 };
  if (limitWrite(ctx.sockIp)) return { ok: true, accepted: 0, limited: true };
  const s = await store.getSession(sid);
  if (!s || s.visitor_hash !== ctx.visitorHash) return { ok: false, accepted: 0 };
  const raw = Array.isArray(ctx.body.events) ? ctx.body.events.slice(0, EVENTS_PER_FLUSH) : [];
  const room = SESSION_EVENTS_MAX - (Number(s.event_count) || 0);
  const now = Date.now();
  const rows = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const type = typeof e.type === 'string' ? e.type : '';
    if (!EVENT_TYPES.has(type)) continue;             // 白名单之外一律不进库
    const ts = Number(e.ts);
    // 客户端时钟可能偏差几分钟：只用来做展示排序的次级键，越界的丢掉这个键
    const at = Number.isFinite(ts) && Math.abs(now - ts) < 5 * 60 * 1000
      ? new Date(ts).toISOString() : new Date(now).toISOString();
    rows.push({
      session_id: sid,
      visitor_hash: s.visitor_hash,
      ip: s.ip,
      type,
      target: clean(e.target, TARGET_MAX),
      detail: clean(e.detail, DETAIL_MAX),
      created_at: at,
    });
    if (rows.length >= Math.max(0, room)) break;
  }
  if (!rows.length) return { ok: true, accepted: 0 };
  await store.addEvents(rows);
  const patch = { event_count: (Number(s.event_count) || 0) + rows.length, last_seen: new Date().toISOString() };
  // pv 只由前端每次页面加载上报的那一条 'pv' 事件驱动：会话创建时不预置，
  // 否则刷新一次的计数到底算 1 还是 2 会在两端各写一套。
  const pv = (Number(s.pv) || 0) + rows.filter((r) => r.type === 'pv').length;
  patch.pv = pv;
  await store.updateSession(sid, patch);
  return { ok: true, accepted: rows.length };
}

async function endSession(store, ctx) {
  const sid = clean(ctx.body.sid, 48);
  if (!sid || !SID_RE.test(sid)) return { ok: false };
  const s = await store.getSession(sid);
  if (!s || s.visitor_hash !== ctx.visitorHash) return { ok: false };
  await store.updateSession(sid, {
    duration_ms: (Number(s.duration_ms) || 0) + credit(s.last_seen),
    last_seen: new Date().toISOString(),
    ended: true,
  });
  return { ok: true };
}

/* ---------------- 后台查询 ---------------- */

/* 时间窗与关键字都在存储层过一遍，取回的都是要显示的页，
 * 统计则单独走一次"近 30 天有界取样"——两件事不要挤在一个查询里，
 * 否则为了算平均值会把整表拉回来。 */
const DAY = 24 * 3600 * 1000;

function rangeSince(query) {
  const r = query.get('range') || 'today';
  if (r === 'all') return null;
  if (r === '7d') return new Date(Date.now() - 7 * DAY).toISOString();
  if (r === '30d') return new Date(Date.now() - 30 * DAY).toISOString();
  // "今天"按服务器本地日零点的 UTC 瞬间算，不按"最近 24 小时"：
  // 后台写的是「今日访客」，跨到第二天凌晨必须归零，否则这个标签是假的。
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function cleanQ(query) {
  const raw = String(query.get('q') || '').replace(/["'(),\s]+/g, ' ').replace(/[\u0000-\u001f]/g, '').trim();
  return raw ? raw.slice(0, 40) : null;
}

async function listVisits(store, query) {
  const pageSize = Math.min(100, Math.max(1, parseInt(query.get('limit'), 10) || 20));
  let page = parseInt(query.get('page'), 10) || 1;
  const filter = {
    since: rangeSince(query),
    q: cleanQ(query),
    includeAdmin: query.get('hideAdmin') !== '1',
    limit: pageSize,
    offset: 0,
  };
  const first = await store.listSessions(filter);
  const total = first.total || 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  page = Math.min(Math.max(1, page), pages);
  filter.offset = (page - 1) * pageSize;
  const cur = page === 1 ? first : await store.listSessions(filter);
  const sessions = cur.rows;
  const ids = sessions.map((s) => s.id);
  /* 一次把本页所有会话的动作捞回来：既给"阅读内容"列做汇总，也让展开时间线不用再请求一次。
   * 额度按 50 条/会话给（一页 20 会话 = 1000 条封顶），因为查询只有全局 limit，
   * 给少了会让排在前面的会话把后面的饿掉——那一行的时间线就整个是空的。
   * 单个会话本身有 500 条上限（SESSION_EVENTS_MAX），超出的部分在时间线里明说"仅显示最近 N 条"。 */
  const events = ids.length ? await store.listEventsBySessions(ids, ids.length * 50) : [];
  const byId = {};
  for (const e of events) (byId[e.session_id] = byId[e.session_id] || []).push(e);
  return {
    /* 返回前把每行收窄一点：visitor_hash 只用于服务端归属判断，不必吐给浏览器；
     * UA 原文动辄上百字节，而后台只需要认出"这是哪种设备/是不是爬虫"，截 90 字够看了。 */
    sessions: sessions.map((s) => {
      const ev = byId[s.id] || [];
      const readIds = new Set(ev.filter((e) => e.type === 'post_read' && e.target).map((e) => e.target));
      const { visitor_hash, ...rest } = s;
      return { ...rest, ua: String(s.ua || '').slice(0, 90), read_count: readIds.size, event_list: ev };
    }),
    total, page, pageSize, pages,
    labels: EVENT_LABEL,
    retention: { days: RETENTION_DAYS, sessions_max: SESSIONS_MAX, events_max: EVENTS_MAX },
  };
}

/* 近 30 天取样算四张统计卡。limit 有界（2000 条会话）且只 select 用得到的列，
 * 不做全表扫描——这条在云端计数上吃过亏，见 README「访客计数」。 */
const STATS_COLS = ['started_at', 'last_seen', 'ip', 'duration_ms', 'pv', 'bot', 'admin'];
async function visitStats(store) {
  const r = await store.listSessions({
    since: new Date(Date.now() - 30 * DAY).toISOString(),
    limit: 2000, offset: 0, includeAdmin: true, cols: STATS_COLS,
  });
  const rows = r.rows || [];
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const today = rows.filter((s) => Date.parse(s.started_at) >= dayStart.getTime());
  const uniq = (list) => new Set(list.map((s) => s.ip).filter(Boolean)).size;
  const sum = (list) => list.reduce((n, s) => n + (Number(s.duration_ms) || 0), 0);
  const avg = (list) => (list.length ? Math.round(sum(list) / list.length) : 0);
  const week = rows.filter((s) => Date.parse(s.started_at) >= Date.now() - 7 * DAY);
  return {
    sessions: { total: r.total || rows.length, today: today.length, week: week.length, month: rows.length },
    ips: { today: uniq(today), week: uniq(week), month: uniq(rows) },
    avgDuration: { today: avg(today), week: avg(week), month: avg(rows) },
    // 正在看：最近 2 分钟还有心跳的会话。关掉标签页最坏也只会多显示 2 分钟，够用了
    online: rows.filter((s) => Date.now() - (Date.parse(s.last_seen || s.started_at) || 0) < 120 * 1000).length,
    bots: rows.filter((s) => s.bot).length,
    pvToday: today.reduce((n, s) => n + (Number(s.pv) || 0), 0),
  };
}

async function deleteVisits(store, ids) {
  const list = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && SID_RE.test(x)).slice(0, 500);
  if (!list.length) return 0;
  return store.deleteSessionsByIds(list);
}

async function purgeVisits(store) {
  const before = new Date(Date.now() - RETENTION_DAYS * DAY).toISOString();
  return store.purgeVisits({ before, maxSessions: SESSIONS_MAX, maxEvents: EVENTS_MAX });
}

module.exports = {
  EVENT_LABEL, RETENTION_DAYS, SESSIONS_MAX, EVENTS_MAX,
  parseUA, startSession, pingSession, trackEvents, endSession,
  listVisits, visitStats, deleteVisits, purgeVisits,
};
