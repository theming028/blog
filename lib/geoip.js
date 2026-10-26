/**
 * IP 归属地（国家 / 省 / 市 / 运营商）。零依赖：用 Node 18+ 的全局 fetch + AbortSignal.timeout。
 *
 * 为什么在线查而不是带离线库：常见离线地理库（ip2region / GeoLite2 mmdb）体积几十 MB 起，
 * 与本仓库"零 npm 依赖、单文件 node server.js 即跑"的口径冲突；而 ipplus362 / 纯真之类
 * 也需要额外授权。所以走 ip-api.com 的免费单 IP 接口，配合三层防护把代价压到可接受：
 *  1) 只在**新建会话**时查，且结果按 IP 落库缓存 30 天（同一访客一天刷 50 次也只查一次）；
 *  2) 失败结果同样缓存 1 小时（负缓存），否则一个查不通的 IP 会把每次访问都拖成 2.5 秒；
 *  3) 连续失败 3 次进入 10 分钟熔断，期间所有 IP 直接返回"未知"，不碰网络。
 * 查不到就显示"未知"，绝不因为归属地失败而丢掉整条访问记录。
 *
 * 两个必须知道的边界：
 *  - **外发 IP**：归属地要把访客 IP 交给第三方接口，这本身就是隐私外泄面。
 *    不需要就设 `GEOIP_OFF=1` 关掉；也可用 `GEOIP_ENDPOINT` 换成自建/内网服务
 *    （模板里用 {ip} 占位，例如 http://127.0.0.1:8080/geo?ip={ip}）。
 *  - **CDN / 代理后拿到的往往是出口 IP**，省市可能只精确到机房所在城市；
 *    取 IP 的候选顺序与 net.isIP 校验复用 server.js 的 clientIp()，不在这里另写一套。
 */
'use strict';

const GEO_TTL_MS = 30 * 24 * 3600 * 1000;  // 命中缓存的有效期
const GEO_NULL_TTL_MS = 60 * 60 * 1000;    // 查不到 / 查失败的负缓存有效期
const GEO_TIMEOUT_MS = 2500;               // 单次在线查询硬超时
const BREAKER_THRESHOLD = 3;               // 连续失败几次就熔断
const BREAKER_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_ENDPOINT = 'http://ip-api.com/json/{ip}?fields=status,message,country,regionName,city,isp,query&lang=zh-CN';

/* 进程内一层缓存：省掉"每次新会话都要先读一次存储"的往返。
 * 云端是多实例，各实例独立缓存，最坏情况是同 IP 每实例查一次，可接受。 */
const mem = new Map();          // ip -> { v, at }，v 为 null 表示负缓存
const inflight = new Map();     // ip -> Promise，并发同 IP 只发一次真实查询
let failStreak = 0;
let cooldownUntil = 0;
let warned = false;

function noteOnce(msg) {
  if (warned) return;
  warned = true;
  console.warn('[geoip]', msg);
}

function isPrivateIp(ip) {
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1' || ip === '::' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
}

function clean(s, max) {
  const v = typeof s === 'string' ? s.replace(/[\u0000-\u001f]/g, '').trim() : '';
  if (!v || v === '-') return '';
  return v.slice(0, max || 40);
}

/* 把接口原始返回收敛成我们自己的形状；status 不是 success 一律当"查不到"。 */
function normalize(raw) {
  if (!raw || raw.status !== 'success') return null;
  const country = clean(raw.country, 30);
  const region = clean(raw.regionName, 30);   // 一级行政区：省 / 直辖市
  const city = clean(raw.city, 30);
  const isp = clean(raw.isp, 40);
  const label = [country, region, city].filter(Boolean).join(' ') || '';
  if (!label) return null;
  // 整串在这里一次拼好：后台三个渲染点（表格、时间线、统计）都显示同一串，
  // 各拼一次迟早会出现"某处少了省市"这种对不齐。
  return { country, region, city, isp, label };
}

async function fetchOnline(ip) {
  const tpl = process.env.GEOIP_ENDPOINT || DEFAULT_ENDPOINT;
  if (!/\{ip\}/.test(tpl)) throw new Error('GEOIP_ENDPOINT 必须包含 {ip} 占位符');
  const url = tpl.replace('{ip}', encodeURIComponent(ip));
  const res = await fetch(url, { signal: AbortSignal.timeout(GEO_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* 查询单个 IP。返回 {country,region,city,isp,label} 或 null，任何异常都收敛成 null。 */
async function lookup(ip) {
  if (process.env.GEOIP_OFF === '1') return null;
  const v = typeof ip === 'string' ? ip.trim() : '';
  if (!v || v === 'unknown' || isPrivateIp(v)) return null;

  const now = Date.now();
  if (cooldownUntil > now) return null;
  const hit = mem.get(v);
  if (hit) {
    const ttl = hit.v ? GEO_TTL_MS : GEO_NULL_TTL_MS;
    if (now - hit.at < ttl) return hit.v;
  }
  if (inflight.has(v)) return inflight.get(v);

  const p = (async () => {
    try {
      const geo = normalize(await fetchOnline(v));
      failStreak = 0;
      mem.set(v, { v: geo, at: Date.now() });
      return geo;
    } catch (e) {
      failStreak += 1;
      mem.set(v, { v: null, at: Date.now() });   // 负缓存：别让坏 IP 每次访问都重连一次
      if (failStreak >= BREAKER_THRESHOLD) {
        cooldownUntil = Date.now() + BREAKER_COOLDOWN_MS;
        failStreak = 0;
        noteOnce(`连续查询失败，已熔断 ${BREAKER_COOLDOWN_MS / 60000} 分钟（期间归属地一律显示"未知"）：${e.message}`);
      }
      return null;
    } finally {
      inflight.delete(v);
    }
  })();
  inflight.set(v, p);
  return p;
}

/* 存储里的缓存行 -> 归属地。返回 undefined 表示"这行不算数，该查了"。
 * 未命中在云端 jsonb 列里存的是 {miss:true} 哨兵（SQL NULL 和本地 null 在回读时
 * 区分不开，见 store.setGeo），所以这里把"存过但没查到"和"没存过"分开处理：
 * 前者按 1 小时的负缓存生效，后者才真的去联网查。 */
function unwrapCached(row) {
  const at = Date.parse(row.updated_at || '');
  if (!Number.isFinite(at)) return undefined;
  const age = Date.now() - at;
  if (age < 0) return undefined;                       // 时钟偏差：宁可不信任这条缓存
  const geo = row.value && !row.value.miss ? row.value : null;
  return age < (geo ? GEO_TTL_MS : GEO_NULL_TTL_MS) ? geo : undefined;
}

/* 带存储缓存的解析：新会话先落库缓存，再回读。
 * 存储读写失败不阻断——归属地是锦上添花，拿不到就 null。 */
async function resolveIp(store, ip) {
  const v = typeof ip === 'string' ? ip.trim() : '';
  if (!v || v === 'unknown') return null;
  try {
    const row = await store.getGeo(v);
    if (row) {
      const cached = unwrapCached(row);
      if (cached !== undefined) {
        mem.set(v, { v: cached, at: Date.now() });
        return cached;
      }
    }
  } catch (e) { noteOnce('读取归属地缓存失败，改为每次现查：' + e.message); }

  const geo = await lookup(v);
  try { await store.setGeo(v, geo); } catch (e) { /* 缓存写不进去只是下次再查一次 */ }
  return geo;
}

module.exports = { resolveIp, lookup, isPrivateIp };
