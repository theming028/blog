'use strict';
/* SEO 相关的服务端纯函数：站点绝对地址、页面 head 注入块、robots.txt、sitemap.xml、JSON-LD。
   单独成文件是因为 server.js 已经够长，而且这几件事的坑都在"细节口径"上，值得集中写注释。 */

const { esc } = require('../public/js/render.js');

/* ---------- 站点绝对地址 ----------
 * canonical / og:url / sitemap 里的 loc 必须是绝对地址，而且必须是"用户真正访问的那个域名"。
 * 两个实测过的坑：
 *  1) 函数计算网关会把 Host 重写成容器内网域名（page-xxx.cn-shanghai-vpc.fcapp.run），
 *     只看 Host 就会把内网地址写进 canonical —— 爬虫会把真地址判成副本。
 *  2) 拿不到可信地址时【宁可不输出】这几个标签，也别输出一个空的或错的 canonical：
 *     错的 canonical 会把权重指到别处，比缺失更难发现。
 * 优先级：PUBLIC_BASE_URL（部署方显式声明）> x-forwarded-host（多级代理取最左）> Host。 */
const PRIVATE_HOST = /^(localhost|127\.|\[::1\]|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/i;
const INTERNAL_DOMAIN = /(\.fcapp\.run|\.fc\.internal|\.local|\.internal)$/i;

function firstOf(v) { return Array.isArray(v) ? v[0] : v; }

function siteBase(req) {
  const env = process.env.PUBLIC_BASE_URL;
  if (env && /^https?:\/\/[^\s/]+$/i.test(env.trim())) return env.trim().replace(/\/+$/, '');

  const xf = firstOf(req.headers['x-forwarded-host']);
  const host = String((xf && String(xf).split(',')[0]) || req.headers.host || '').trim();
  // 带空格、斜杠、@ 的 Host 一律不信（既可能是伪造，也可能把路径带进绝对地址）
  if (!host || /[\s/@]/.test(host)) return '';
  if (PRIVATE_HOST.test(host) || INTERNAL_DOMAIN.test(host)) return '';

  const xp = String(firstOf(req.headers['x-forwarded-proto']) || '').split(',')[0].trim().toLowerCase();
  const secure = xp === 'https' || (req.socket && req.socket.encrypted);
  return (secure ? 'https' : 'http') + '://' + host;
}

/* ---------- 页面 head 注入块 ----------
 * opts: { title, description, canonical, image, type, siteName, publishedTime, modifiedTime, jsonLd }
 * 只写有值的字段：空 description / 空 image 生成出来的标签比没有更糟。 */
function headBlock(o) {
  const L = [];
  if (o.description) L.push(`<meta name="description" content="${esc(o.description)}">`);
  if (o.canonical) L.push(`<link rel="canonical" href="${esc(o.canonical)}">`);
  L.push(`<meta property="og:site_name" content="${esc(o.siteName || '朝夕光年')}">`);
  L.push(`<meta property="og:title" content="${esc(o.title)}">`);
  if (o.description) L.push(`<meta property="og:description" content="${esc(o.description)}">`);
  L.push(`<meta property="og:type" content="${esc(o.type || 'website')}">`);
  if (o.canonical) L.push(`<meta property="og:url" content="${esc(o.canonical)}">`);
  if (o.image) L.push(`<meta property="og:image" content="${esc(o.image)}">`);
  if (o.publishedTime) L.push(`<meta property="article:published_time" content="${esc(o.publishedTime)}">`);
  if (o.modifiedTime) L.push(`<meta property="article:modified_time" content="${esc(o.modifiedTime)}">`);
  L.push(`<meta name="twitter:card" content="${o.image ? 'summary_large_image' : 'summary'}">`);
  L.push(`<meta name="twitter:title" content="${esc(o.title)}">`);
  if (o.description) L.push(`<meta name="twitter:description" content="${esc(o.description)}">`);
  if (o.image) L.push(`<meta name="twitter:image" content="${esc(o.image)}">`);
  // JSON-LD 是数据块不是可执行脚本：CSP `script-src 'self'` 不拦它，实测 DOM 保留且可被解析，
  // 所以加了结构化数据不必放开 CSP（放开反而是安全事故）。
  if (o.jsonLd && o.jsonLd.length) {
    for (const j of o.jsonLd) {
      L.push(`<script type="application/ld+json">${jsonSafe(JSON.stringify(j))}</script>`);
    }
  }
  return L.join('\n');
}

/* JSON 文本塞进 <script> 前必须转义 </ 与 U+2028/2029：
   否则正文里一个 "</script>" 就能提前闭合标签，把后面的内容变成可执行代码（存储型 XSS）。
   评论正文是访客写的，这条不是理论风险。 */
function jsonSafe(s) {
  return String(s)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/* ---------- 摘要 ---------- */
function excerpt(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const n = max || 120;
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

/* 详情页标题：取正文首行，但绝不在词中间硬切。
 * 上一版直接 slice(0,30) 加省略号，产出「鸣沙山的日落把影子拉得很长，驼队走得很慢，时间在这里好像也…」
 * 这种半截句子——搜索结果里像机器生成的，点击率反而低。
 * 现在优先在句读处收尾（。！？，、；），找不到就整句截断但不留半个标点。 */
function smartCut(t, max) {
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  // 从后往前找最后一个句读，且要求它至少走到 max 的六成，否则切出来太短不像标题
  for (let i = head.length - 1; i >= Math.floor(max * 0.6); i--) {
    if ('。！？!?；;，、 '.includes(head[i])) return head.slice(0, i).replace(/[，、；;:]+$/, '');
  }
  return head;
}

/* 搜索引擎对 title 与正文首行的重合度敏感，所以这里只做截断，不加关键词堆砌。 */
function postTitle(post) {
  const first = String(post.content || '').split('\n')[0].trim();
  if (first) return smartCut(first, 28);
  if (post.location) return smartCut(String(post.location), 28);
  if ((post.images || []).length) return '一张照片';
  return smartCut(String(post.content || ''), 28);
}

/* ---------- robots.txt ----------
 * 不 Disallow /api/：帖子图片走 /api/images/<id>，拦掉它等于把图片从搜索引擎外面关掉，
 * 而旅行摄影站一半流量本该来自图片搜索。API 的 noindex 改由响应头 X-Robots-Tag 精确处理。 */
function robotsTxt(base, extra) {
  const lines = [
    'User-agent: *',
    'Disallow: /admin',
    'Disallow: /admin.html',
    'Disallow: /edit',
    'Disallow: /edit.html',
    'Disallow: /login',
    'Disallow: /login.html',
    '',
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ];
  return lines.join('\n');
}

/* ---------- sitemap.xml ----------
 * entries: [{ loc, lastmod, priority }]。只收录公开可访问的页面；
 * 草稿不会进来（listPosts(false) 已过滤），所以不需要额外判断。 */
function sitemapXml(entries) {
  const body = (entries || []).map((e) => {
    const url = `<loc>${esc(e.loc)}</loc>`;
    const lm = e.lastmod ? `<lastmod>${esc(e.lastmod)}</lastmod>` : '';
    const pr = e.priority ? `<priority>${e.priority}</priority>` : '';
    return `  <url>${url}${lm}${pr}</url>`;
  }).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + body + '\n</urlset>\n';
}

/* ---------- JSON-LD ---------- */
function homeJsonLd({ base, siteName, description, posts, limit }) {
  const items = (posts || []).slice(0, limit || 10).map((p, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    url: `${base}/p/${encodeURIComponent(p.id)}`,
    name: postTitle(p),
  }));
  const site = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: siteName,
    url: `${base}/`,
    inLanguage: 'zh-CN',
  };
  if (description) site.description = description;
  const blog = {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: siteName,
    url: `${base}/`,
    inLanguage: 'zh-CN',
  };
  if (description) blog.description = description;
  if (items.length) blog.blogPost = items.map((it) => ({ '@type': 'BlogPosting', url: it.url, headline: it.name }));
  return [site, blog];
}

function postJsonLd({ base, siteName, post, avatar, nickname }) {
  const url = `${base}/p/${encodeURIComponent(post.id)}`;
  const images = (post.images || []).map((id) => `${base}/api/images/${encodeURIComponent(id)}`);
  const o = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: postTitle(post),
    url,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    inLanguage: 'zh-CN',
    author: { '@type': 'Person', name: nickname || siteName },
    publisher: { '@type': 'Organization', name: siteName },
  };
  if (post.created_at) o.datePublished = new Date(post.created_at).toISOString();
  if (post.updated_at && post.updated_at !== post.created_at) o.dateModified = new Date(post.updated_at).toISOString();
  const text = String(post.content || '').trim();
  if (text) o.articleBody = excerpt(text, 500);
  if (post.location) o.contentLocation = { '@type': 'Place', name: post.location };
  if (images.length) {
    o.image = images.length === 1 ? images[0] : images;
    o.graph = images.map((u) => ({ '@type': 'ImageObject', contentUrl: u, caption: text ? excerpt(text, 120) : postTitle(post) }));
  } else if (avatar) {
    o.image = avatar.startsWith('http') ? avatar : `${base}${avatar}`;
  }
  const comments = (post.comments || []).filter((c) => c && c.content);
  if (comments.length) {
    o.comment = comments.slice(0, 20).map((c) => ({
      '@type': 'Comment',
      text: excerpt(c.content, 300),
      author: { '@type': 'Person', name: c.name || '匿名' },
      dateCreated: c.created_at ? new Date(c.created_at).toISOString() : undefined,
    }));
    o.commentCount = comments.length;
  }
  return [o];
}

module.exports = {
  siteBase, headBlock, jsonSafe, excerpt, postTitle,
  robotsTxt, sitemapXml, homeJsonLd, postJsonLd,
  PRIVATE_HOST, INTERNAL_DOMAIN,
};
