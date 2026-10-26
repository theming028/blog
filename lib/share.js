/**
 * 单条内容的分享地址与 <head> 元信息。
 *
 * 为什么必须在服务端做：微信、QQ、微博、Telegram 抓链接摘要时**不执行 JavaScript**。
 * 前端把 document.title 改得再准，爬虫看到的仍是模板里那句站点名，
 * 分享出去就是一条没有标题、没有缩略图的裸链接。所以 title / og:* 必须写进 HTML 本身。
 *
 * 三条口径：
 *  1) 只输出已发布内容。草稿的标题与正文不能出现在 meta 里——那等于绕过后台把草稿
 *     内容推给所有爬虫（分享链接会被各级缓存记录，删掉帖子也收不回来）。
 *  2) 图片用**绝对地址**。og:image 给相对路径，多数平台直接忽略。
 *  3) Host 是可伪造的请求头，构造绝对地址时严格白名单过滤，并且优先用
 *     PUBLIC_BASE_URL 显式配置（换成自有域名后把它设成正式域名，最稳）。
 */
'use strict';

const POST_ID_RE = /^[\w-]{4,64}$/;
const TITLE_MAX = 30;   // 微信卡片标题两行左右就截了，长了没用
const DESC_MAX = 80;
const SITE_NAME = '朝夕光年';

/* 属性值转义：正文里出现 " < > & 会把 meta 标签撑破，甚至注入新的标签 */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* 按码点截断，不能按 UTF-16 长度：emoji 是代理对，切一半会变乱码 */
function clip(s, max) {
  const chars = Array.from(String(s || '').replace(/\s+/g, ' ').trim());
  return chars.length > max ? chars.slice(0, max).join('') + '…' : chars.join('');
}

/**
 * 从请求头里取"对外可见的站点根地址"。
 *
 * ⚠️ 实测踩坑：QW Pages 的函数计算网关会把 Host 重写成容器内网域名
 * （page-xxx.cn-shanghai-vpc.fcapp.run），而运行时又没法设环境变量。
 * 只看 Host 的结果就是线上 og:url / canonical 指向一个别人访问不到的内网地址。
 * 所以候选顺序是 PUBLIC_BASE_URL > x-forwarded-host > Host，每一关做两件事：
 * 形状白名单（Host 可伪造，引号/尖括号/空格一律不进）+ 内网特征黑名单；
 * 全部不合格就宁可不输出 og:url / canonical，也不给一个错的域名
 * ——错的 canonical 会让爬虫把真实地址判成副本，比没有更糟。
 */
const INTERNAL_HOST = /(^|\.)(fcapp\.run|fc\.aliyuncs\.com|alibabacloud|internal|intranet)$/i;
const LOCAL_NAME = /^(localhost|.*\.local)$/i;

/* 判断一个 Host 该按什么身份用：'local' 本地预览（http）、'public' 公网域名（https）、
   null 不可用。本地要单独放行——它没有点分域名，走公网那条校验会被误杀，
   而本地看不到完整 og:url/og:image 就没法在发布前验证这套逻辑。 */
function hostScope(h) {
  if (typeof h !== 'string') return null;
  const raw = h.trim().toLowerCase();
  const host = raw.replace(/:\d{2,5}$/, '');
  if (!/^[\w.:\[\]-]+$/.test(host)) return null;       // 只允许域名/IP 形状，挡引号、尖括号、换行
  if (host.includes('..')) return null;
  if (INTERNAL_HOST.test(host)) return null;           // 网关内网域名，给了也是错的
  if (LOCAL_NAME.test(host)) return 'local';
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    // 只有真正的私有网段算本地预览。169.254.x.x 是链路本地段（云主机的元数据端点在这儿），
    // 0.x 也不该出现在对外地址里——把它们当 local 放行，就等于允许 x-forwarded-host
    // 把 og:url 指到内网元数据接口，这是我自己测出来的洞。
    const priv = a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
    return priv ? 'local' : null;
  }
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return 'local';
  if (!host.includes('.')) return null;                // 没有点的裸名字不是域名
  return 'public';
}

/* x-forwarded-host 可能是 "a.example.com, b.internal" 这样的一串，取第一段 */
function firstHeader(v) {
  const s = Array.isArray(v) ? v[0] : v;
  return String(s || '').split(',')[0].trim();
}

function baseUrl(req) {
  const cfg = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (cfg && /^https?:\/\/[\w.-]+(?::\d{2,5})?$/i.test(cfg)) return cfg;
  const h = req.headers || {};
  for (const c of [firstHeader(h['x-forwarded-host']), firstHeader(h.host)]) {
    const scope = hostScope(c);
    if (!scope) continue;
    // 公网域名一律给 https：平台入口只有 https，跟着请求 proto 走会在证书生效前生成 http 链接
    return `${scope === 'local' ? 'http' : 'https'}://${c.trim().toLowerCase()}`;
  }
  return null;
}

/* 单条分享地址：前台按同样的规则拼，两边不一致会出现"页面里显示的链接和实际分享出去的不是一个" */
function postUrl(base, id) {
  return `${base}/?p=${encodeURIComponent(id)}`;
}

/**
 * 摘要：有正文用正文；纯图帖/纯音视频帖给一句人话，
 * 否则分享卡片会是一片空白，看起来像坏链。
 */
function describe(post) {
  const text = String(post.content || '').trim();
  const media = Array.isArray(post.media) ? post.media : [];
  const imgs = Array.isArray(post.images) ? post.images : [];
  const parts = [];
  if (text) parts.push(clip(text, DESC_MAX));
  if (imgs.length) parts.push(text ? `含 ${imgs.length} 张图` : `这组照片共 ${imgs.length} 张，点开看原图。`);
  if (media.length) parts.push(media.some((m) => m.kind === 'video') ? '附带一段视频。' : '附带一段音频。');
  if (!parts.length) parts.push('一条新的动态。');
  return parts.join(' ');
}

function titleOf(post) {
  const text = String(post.content || '').trim();
  if (text) return clip(text, TITLE_MAX);
  if (post.location) return clip(post.location, TITLE_MAX);
  const imgs = Array.isArray(post.images) ? post.images : [];
  return imgs.length ? `照片 × ${imgs.length}` : '一条新的动态';
}

/**
 * 生成注入 index.html 的 head 片段。post 为 null 时输出"内容不存在"的通用片段，
 * 这样分享出去的旧链接不会打不开，也不会露出后台数据。
 */
function headMeta(post, base) {
  const title = post ? titleOf(post) : '内容不存在';
  const desc = post ? describe(post) : '这条内容已被删除或尚未发布。';
  const url = post && base ? postUrl(base, post.id) : (base ? base + '/' : '');
  const imgs = post && Array.isArray(post.images) ? post.images : [];
  const lines = [];
  lines.push(`<title>${esc(title)} · ${esc(SITE_NAME)}</title>`);
  lines.push(`<meta name="description" content="${esc(desc)}">`);
  lines.push('<meta property="og:type" content="article">');
  lines.push(`<meta property="og:title" content="${esc(title)}">`);
  lines.push(`<meta property="og:description" content="${esc(desc)}">`);
  lines.push(`<meta property="og:site_name" content="${esc(SITE_NAME)}">`);
  if (url) lines.push(`<meta property="og:url" content="${esc(url)}">`);
  // 没有图片的帖子不输出 og:image：给一张默认图会让所有纯文字动态的卡片长得一样，
  // 而给一个不存在的地址会在部分平台显示裂图，宁缺毋滥。
  if (base && imgs.length) lines.push(`<meta property="og:image" content="${esc(base + '/api/images/' + encodeURIComponent(imgs[0]))}">`);
  if (post && post.created_at) {
    const d = new Date(post.created_at);
    if (!isNaN(d)) lines.push(`<meta property="article:published_time" content="${esc(d.toISOString())}">`);
  }
  // 拿不到绝对地址时连 canonical 一起省略：href="" 会被解析成"当前文档"，
  // 看着无害，但它是一条声明了却没说清什么的指令，不如干脆不写。
  if (url) lines.push(`<link rel="canonical" href="${esc(url)}">`);
  return lines.join('\n');
}

module.exports = { POST_ID_RE, headMeta, postUrl, baseUrl, titleOf, describe, SITE_NAME };
