'use strict';
/* 百度主动推送（普通收录）：发帖/改帖之后把 URL 直接推给百度，收录延迟从"天"降到"分钟"。
 *
 * 配置绝不写进代码——GitHub 仓库是公开的，token 是凭据。读取顺序：
 *   1) data/baidu-push.json   （与 db.json 同在 .gitignore 内）：{ "site": "...", "token": "..." }
 *   2) 环境变量 BAIDU_PUSH_SITE / BAIDU_PUSH_TOKEN
 * 两处都没有就静默跳过（只在第一次打一行日志）。跳过不等于功能坏：sitemap.xml 一直在，
 * 百度顺着它也能慢慢收，只是慢。
 *
 * 失败绝不能冒到发帖接口上：推送是副作用。百度抖动、超时、配额用尽、token 失效，
 * 都不该让管理员看到"发布失败"而以为帖子没存进去——帖子那时早就已经落库了。
 * 结果一律进服务端日志，运维看 journalctl -u blog 就能定位。 */

const fs = require('fs');
const path = require('path');

const ENDPOINT = 'http://data.zz.baidu.com/urls';
const TIMEOUT_MS = 8000;

let warnedNoConfig = false;
let lastResult = null;   // 最近一次推送结果，给后台/排障看，不参与业务判断

function loadConfig(dataDir) {
  const file = path.join(dataDir, 'baidu-push.json');
  try {
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && j.site && j.token) return { site: String(j.site).trim(), token: String(j.token).trim(), from: 'data/baidu-push.json' };
    }
  } catch (e) {
    console.warn('[baidu-push] data/baidu-push.json 解析失败，改用环境变量:', e.message);
  }
  if (process.env.BAIDU_PUSH_SITE && process.env.BAIDU_PUSH_TOKEN) {
    return { site: process.env.BAIDU_PUSH_SITE.trim(), token: process.env.BAIDU_PUSH_TOKEN.trim(), from: '环境变量' };
  }
  return null;
}

/* 真正发一次。urls 是绝对地址数组。返回 {ok, ...} 或 {ok:false, error} */
async function pushUrls(dataDir, urls) {
  const list = (urls || []).filter((u) => /^https?:\/\//.test(u));
  if (!list.length) return { ok: false, error: '没有可推送的绝对地址' };
  const cfg = loadConfig(dataDir);
  if (!cfg) {
    if (!warnedNoConfig) { console.warn('[baidu-push] 未配置 site/token，跳过推送（可建 data/baidu-push.json 或设环境变量）'); warnedNoConfig = true; }
    return { ok: false, error: '未配置' };
  }
  const url = `${ENDPOINT}?site=${encodeURIComponent(cfg.site)}&token=${encodeURIComponent(cfg.token)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: list.join('\n'),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 百度偶尔返回 HTML 错误页 */ }
    // 成功形如 {"success":1,"remain":499}；失败形如 {"error":400,"message":"token invalid"}
    const ok = res.ok && json && json.success !== undefined && !json.error;
    lastResult = { at: new Date().toISOString(), ok, status: res.status, body: text.slice(0, 200), urls: list.length, from: cfg.from };
    if (ok) console.log(`[baidu-push] 成功 ${json.success} 条，今日剩余配额 ${json.remain}`);
    else console.warn(`[baidu-push] 失败 status=${res.status} body=${text.slice(0, 160)}`);
    return lastResult;
  } catch (e) {
    lastResult = { at: new Date().toISOString(), ok: false, error: e.message, urls: list.length };
    console.warn('[baidu-push] 请求异常:', e.message);
    return lastResult;
  }
}

/* 副作用调用：不 await、不抛错。 */
function pushAsync(dataDir, urls, label) {
  pushUrls(dataDir, urls).then((r) => {
    if (label && !r.ok) console.warn(`[baidu-push] ${label} 未推送成功:`, r.error || r.body || '');
  }).catch((e) => console.warn(`[baidu-push] ${label || ''} 异常:`, e.message));
}

function lastPushResult() { return lastResult; }

module.exports = { pushUrls, pushAsync, loadConfig, lastPushResult, ENDPOINT };
