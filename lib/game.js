/**
 * 小游戏《牧羊小勇士 · 丛林回响》的服务端支撑：每日榜 + 好友助力复活。
 *
 * 公开接口，所以每条都要：字段白名单 + 长度/范围校验 + 按 IP 限流。
 * 好友助力是“点开链接就等于帮了一次”——token 一次性核销，别人刷不出第二次。
 *
 * 数据落在 store 的两张表（game_scores / game_assists），
 * LocalStore 与 SupabaseStore 接口一致；云端缺表时接口降级成“未启用”，
 * 绝不让一个没建表的部署把整站打成 500。
 */
'use strict';

const crypto = require('crypto');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAME_MAX = 12, TOKEN_RE = /^[0-9a-f]{12,24}$/;
const SCORE_MAX = 999999, SECS_MAX = 6 * 3600, SHEEP_MAX = 99, COMBO_MAX = 999;
const BOARD_MAX = 50;

function str(v, max) { return String(v == null ? '' : v).slice(0, max); }
function int(v, min, max) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return null;
  return n < min ? min : n > max ? max : n;
}
function todayCN() {
  // 榜单按“中国境内玩家的一天”切：UTC 日子会把晚上 8 点后的成绩推到第二天
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
function normDay(v) { const s = str(v, 10); return DAY_RE.test(s) ? s : todayCN(); }
function newToken() { return crypto.randomBytes(9).toString('hex'); }   // 18 位 hex
const cleanToken = (v) => { const s = str(v, 24).toLowerCase(); return TOKEN_RE.test(s) ? s : ''; };

/* ---------------- 限流（与 lib/visit.js 同一思路：按不可伪造的 socket IP） ---------------- */
function makeLimiter(windowMs, max) {
  const hits = new Map();
  return function limited(key) {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return true; }        // 超限
    arr.push(now); hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) { if (!v.length || now - v[v.length - 1] > windowMs * 3) hits.delete(k); }
    return false;
  };
}
const limitScore = makeLimiter(60 * 1000, 12);         // 每人每分钟最多交 12 次成绩
const limitCreate = makeLimiter(60 * 60 * 1000, 20);   // 求助链接每小时 20 条
const limitRedeem = makeLimiter(60 * 60 * 1000, 60);   // 帮别人点每小时 60 次

/* ---------------- store 缺表时的探测缓存（只在云端可能缺） ---------------- */
const probe = new Map();     // 'scores'|'assists' -> boolean
async function hasTable(store, which) {
  if (store.kind !== 'supabase') return true;
  if (probe.has(which)) return probe.get(which);
  const table = which === 'scores' ? 'game_scores' : 'game_assists';
  let ok = false;
  try { await store._req('GET', `${store._tb(table)}?select=*&limit=1`); ok = true; }
  catch (e) { ok = false; }
  probe.set(which, ok);
  return ok;
}

/* =====================================================================
   接口处理器：pathname 以 /api/game/ 开头
   ===================================================================== */
async function handleGame(store, req, res, pathname, query, ip) {
  const method = req.method;
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }); res.end(JSON.stringify(obj)); };
  const ipKey = ip || 'unknown';

  /* ---- 日榜：GET /api/game/board?day=&limit= ---- */
  if (pathname === '/api/game/board' && method === 'GET') {
    if (!(await hasTable(store, 'scores'))) return json(200, { enabled: false, day: normDay(query.get('day')), rows: [] });
    const day = normDay(query.get('day'));
    // limit 缺省给 10：int() 的 clamp 会把 null 变成下界 1，导致榜单只剩第一名（实测踩过）
    const limit = Math.min(Math.max(parseInt(query.get('limit'), 10) || 10, 1), BOARD_MAX);
    const rows = await store.gameBoard(day, limit);
    return json(200, { enabled: true, day, rows: rows.map(publicRow) });
  }

  /* ---- 交成绩：POST /api/game/score ---- */
  if (pathname === '/api/game/score' && method === 'POST') {
    if (limitScore(ipKey)) return json(429, { ok: false, error: '太频繁了，稍后再交' });
    if (!(await hasTable(store, 'scores'))) return json(200, { ok: false, enabled: false });
    const b = await readJson(req);
    const name = str(b.name, 24).replace(/[\u0000-\u001f<>]/g, '');
    const row = {
      day: normDay(b.day),
      // hash 是客户端生成的匿名访客标识（不含 IP）：只用来算“我的名次”，榜上不显示
      hash: str(b.hash, 64).replace(/[^\w-]/g, ''),
      name: name.slice(0, NAME_MAX),
      score: int(b.score, 0, SCORE_MAX),
      sheep: int(b.sheep, 0, SHEEP_MAX),
      combo: int(b.combo, 0, COMBO_MAX),
      secs: int(b.secs, 0, SECS_MAX),
      seed: int(b.seed, 0, 4294967295),
      win: !!b.win,
    };
    if (!row.hash || row.score == null || row.secs == null) return json(400, { ok: false, error: '参数不完整' });
    const saved = await store.addGameScore(row);
    const rank = await store.gameRank(row.day, row.hash);
    return json(200, { ok: true, id: saved && saved.id, rank, day: row.day });
  }

  /* ---- 发起求助：POST /api/game/assist { day, hash } ---- */
  if (pathname === '/api/game/assist' && method === 'POST') {
    if (limitCreate(ipKey)) return json(429, { ok: false, error: '今天求助太多次了' });
    if (!(await hasTable(store, 'assists'))) return json(200, { ok: false, enabled: false });
    const b = await readJson(req);
    const owner = str(b.hash, 64).replace(/[^\w-]/g, '');
    if (!owner) return json(400, { ok: false, error: '缺少身份标识' });
    const token = newToken();
    await store.createGameAssist({ token, day: normDay(b.day), owner, name: str(b.name, NAME_MAX), used_by: null, used_at: null });
    return json(200, { ok: true, token });
  }

  /* ---- 好友点开助力：POST /api/game/assist/redeem { token, name } ---- */
  if (pathname === '/api/game/assist/redeem' && method === 'POST') {
    if (limitRedeem(ipKey)) return json(429, { ok: false, error: '手速太快了，歇一会儿' });
    if (!(await hasTable(store, 'assists'))) return json(200, { ok: false, enabled: false });
    const b = await readJson(req);
    const token = cleanToken(b.token);
    if (!token) return json(400, { ok: false, error: '助力链接不完整' });
    const by = str(b.name, NAME_MAX) || '路过的牧人';
    const r = await store.useGameAssist(token, by);
    if (!r) return json(404, { ok: false, error: '这条助力链接不存在' });
    if (r.already) return json(200, { ok: false, used: true, for: r.row.name, usedBy: r.row.used_by });
    return json(200, { ok: true, used: false, for: r.row.name });
  }

  /* ---- 本机轮询是否已被助力：GET /api/game/assist?token=&hash= ---- */
  if (pathname === '/api/game/assist' && method === 'GET') {
    if (!(await hasTable(store, 'assists'))) return json(200, { ok: false, enabled: false });
    const token = cleanToken(query.get('token'));
    const who = str(query.get('hash'), 64).replace(/[^\w-]/g, '');
    if (!token || !who) return json(400, { ok: false, error: '参数不完整' });
    const row = await store.getGameAssist(token);
    // 只有发起人能查状态：不然任何拿到 token 的人都能探测别人是否被帮过
    if (!row || row.owner !== who) return json(200, { ok: false });
    return json(200, { ok: true, used: !!row.used_at, usedBy: row.used_by || '' });
  }

  return json(404, { ok: false, error: 'not found' });
}

function publicRow(r) {
  return { name: r.name || '匿名牧人', score: r.score | 0, sheep: r.sheep | 0, combo: r.combo | 0, secs: r.secs | 0, win: !!r.win };
}

async function readJson(req) {
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 64 * 1024) { raw = raw.slice(0, 64 * 1024); break; } }
  try { return JSON.parse(raw || '{}'); } catch (e) { return {}; }
}

module.exports = { handleGame, todayCN, normDay, publicRow, _tokens: { newToken } };
