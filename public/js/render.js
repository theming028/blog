/**
 * 帖子/评论的纯字符串渲染层（零依赖、零 DOM）。
 *
 * 为什么单独一个文件：SEO 要求服务端把信息流直接渲染进 HTML（百度系基本不执行 JS，
 * 客户端渲染等于给爬虫一个空白页）。渲染逻辑如果在服务端再抄一遍，就是两份真源——
 * 改一处漏一处，爬虫看到的和用户看到的会悄悄分叉。所以这里做成浏览器与 Node 共用：
 * 浏览器里 feed.js 调它，服务端 server.js 用 require 调同一个函数（同 crop.js 的先例）。
 *
 * 纯函数要求：不碰 document / window / localStorage，所有环境相关输入由 ctx 传入。
 * 因此 SSR 与客户端渲染的差异只剩「我是否赞过」这类只有浏览器才知道的状态。
 */
'use strict';

(function (root) {

/* HTML 转义：属性与文本都够用。单引号也转，因为模板里有大量双引号属性。 */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* 微信朋友圈时间：刚刚 / N分钟前 / N小时前 / 昨天 / 前天 / M月D日 / YYYY年M月D日。
   nowMs 由 ctx 传入，服务端与浏览器才能算出同一个结果（否则 SSR 与客户端会抖一字之差）。 */
function fmtTime(iso, nowMs) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const now = nowMs ? new Date(nowMs) : new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.floor((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days === 1) return '昨天';
  if (days === 2) return '前天';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

const imgUrl = (id) => `/api/images/${encodeURIComponent(id)}`;

const COMMENT_MAX = 200;   // 与 server.js 的同名常量保持一致（输入框 maxlength 亦为此值）
const CMT_CLAMP_AT = 80;   // 评论超过此字数先折叠；按码点计数，避免切碎 emoji 造成乱码
const IMGS_MAX = 9;        // 信息流宫格的显示上限（数据层同样截在 9 张，这里只管显示）

const ICON_HEART = '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.7-10-9.3C.5 8.6 2.4 5 5.8 5c2 0 3.4 1 4.2 2.4h4c.8-1.4 2.2-2.4 4.2-2.4 3.4 0 5.3 3.6 3.8 6.7C19.5 16.3 12 21 12 21z"/></svg>';
const ICON_LIKE_SM = '<svg viewBox="0 0 24 24"><path d="M12 21.3C10.6 20.2 2.5 14.6 2.5 8.9 2.5 5.6 5 3.5 7.6 3.5c1.8 0 3.4.9 4.4 2.4 1-1.5 2.6-2.4 4.4-2.4 2.6 0 5.1 2.1 5.1 5.4 0 5.7-8.1 11.3-9.5 12.4z"/></svg>';
const ICON_CMT = '<svg viewBox="0 0 24 24"><path d="M12 3C6.5 3 2 6.9 2 11.7c0 2.7 1.4 5.1 3.7 6.7-.2 1-.8 2.2-1.6 3 1.7-.2 3.3-.9 4.4-1.7 1.1.3 2.3.5 3.5.5 5.5 0 10-3.9 10-8.5S17.5 3 12 3z"/></svg>';
const ICON_PIN = '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>';
const ICON_IMG = '<svg viewBox="0 0 24 24"><path d="M21 3H3a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1zM8.5 9A1.5 1.5 0 1 1 7 10.5A1.5 1.5 0 0 1 8.5 9zM5 18l4.5-6 3 4 2.5-3 4 5z"/></svg>';

/* 评论前缀（昵称 + 回复对象），折叠切换时需要重拼，单独抽出 */
function cmtPrefix(c) {
  // 渲染端再兜一层：服务端已只收 http(s)，历史数据里可能还留着 javascript: 值
  const site = /^https?:\/\//i.test(c.site || '') ? c.site : '';
  const nameHtml = site
    ? `<a class="nm nm-link" href="${esc(site)}" target="_blank" rel="noopener nofollow">${esc(c.name)}</a>`
    : `<span class="nm">${esc(c.name)}</span>`;
  const reply = c.reply_to_name ? ` 回复 <span class="rn">${esc(c.reply_to_name)}</span>` : '';
  return `${nameHtml}${reply}：`;
}

/* 折叠放在渲染层做：按 Unicode 码点截取，正文与操作项才能同处一行 */
function cmtFolded(c) {
  const chars = Array.from(c.content || '');
  return chars.length > CMT_CLAMP_AT ? chars.slice(0, CMT_CLAMP_AT).join('') : null;
}

/* ctx: { clientKey, expanded:Set|Array } —— 谁写的评论、哪条已展开，都是访问者状态，必须外面给 */
function renderComment(c, ctx) {
  ctx = ctx || {};
  const mine = !!c.client_key && c.client_key === ctx.clientKey;
  const folded = cmtFolded(c);
  const expandedList = ctx.expanded;
  const expanded = expandedList ? (expandedList.has ? expandedList.has(c.id) : expandedList.indexOf(c.id) >= 0) : false;
  const body = `<span class="cmt-body">${cmtPrefix(c)}${esc(expanded || folded === null ? c.content : folded)}</span>`;
  const more = folded === null ? '' : `<i class="cmt-more">${expanded ? '收起' : '…展开'}</i>`;
  const ops = mine ? '<span class="cmt-ops"><i class="cmt-op" data-op="edit">编辑</i><i class="cmt-op danger" data-op="del">删除</i></span>' : '';
  return `<div class="cmt${mine ? ' mine' : ''}" data-cid="${c.id}" data-cname="${esc(c.name)}">${body}${more}${ops}</div>`;
}

/* 一条朋友圈的完整 DOM。ctx: { nickname, avatar, clientKey, expanded, nowMs, detail }
   detail=true 表示这是详情页渲染（图片一行一张、不再给"阅读全文"链接）。
   图片/音视频的属性顺序与原先逐字保持一致——SSR 与客户端要产出同一串，
   否则浏览器接管后整页重绘会闪，diff 也看不出是真改了还是顺序变了。 */
function renderPost(p, ctx) {
  ctx = ctx || {};
  const liked = (p.likes || []).some((l) => l.client_key === ctx.clientKey);
  // 头像未就绪时不写 src：src="" 会让浏览器再去请求当前页面 URL
  const avAttr = ctx.avatar ? ` src="${esc(ctx.avatar)}"` : '';
  const shown = (p.images || []).slice(0, IMGS_MAX);   // 信息流宫格的显示上限

  /* 图片两种排法，由 ctx.detail 决定（服务端与浏览器都传这个标记）：
     - 信息流：最多前 IMGS_MAX 张走宫格；
     - 详情页：全部图片一行一张，不裁切成正方形。
     数据层目前就把一条内容的图片截在 9 张（server.js 的 POST/PUT 与编辑页同口径），
     所以今天两者数量相同；但显示规则要独立成立——将来放宽上限时不必再回来改这里。 */
  let imgHtml = '';
  if (ctx.detail) {
    imgHtml = (p.images || []).map((im, i) =>
      `<div class="p-full"><img src="${imgUrl(im)}" data-pid="${p.id}" data-idx="${i}" loading="lazy" decoding="async" alt=""></div>`).join('');
  } else if (shown.length === 1) {
    imgHtml = `<div class="p-single"><img src="${imgUrl(shown[0])}" data-pid="${p.id}" data-idx="0" loading="lazy" decoding="async" alt=""></div>`;
  } else if (shown.length > 1) {
    // 2 张与 4 张走两列：三列布局下 2 张只占容器 2/3 宽，两列才与单图（.p-single 撑满）同宽
    const twoUp = shown.length === 2 || shown.length === 4;
    const cls = twoUp ? 'p-grid cols-2' : 'p-grid';
    imgHtml = `<div class="${cls}">` + shown.map((im, i) =>
      `<img src="${imgUrl(im)}" data-pid="${p.id}" data-idx="${i}" loading="lazy" decoding="async" alt="">`).join('') + '</div>';
  }

  const locHtml = p.location
    ? `<div class="p-location">${ICON_PIN}${esc(p.location)}</div>` : '';

  /* 音视频：只播外链（本站不托管媒体文件），一条内容最多 3 段，排在图片之后。
     - video 用 preload="none"：列表里刷过去时一个字节都不下，点开才取流；
     - audio 用 preload="metadata"：它没有画面，进度条与时长要靠文件头才画得出来，
       这只请求头部几 KB，不是整段；
     - playsinline 是 iOS 必需，少了它一点播放就全屏接管；
     - 自动播放刻意【不】写 autoplay 属性，改成 data-autoplay 交给 feed.js 的播放控制器：
       属性版会在页面加载瞬间就把屏幕外的播放器一起点着（用户只听见声音不知道哪来的），
       而且"先播再被 IntersectionObserver 暂停"是有竞态的。改成"进入视口才 play()"，
       行为确定，也顺带满足浏览器策略——带声音的自动播放 Chrome/Safari 一律拦，
       所以自动播放必须配 muted，编辑页里也照这句写。 */
  const mediaHtml = (p.media || []).map((m) => {
    if (!m || (m.kind !== 'video' && m.kind !== 'audio')) return '';
    if (!/^https?:\/\//i.test(m.url || '')) return '';
    if (m.kind === 'audio') {
      /* 音频不给自动播放：能自动起播的必然被静音（浏览器策略），结果就是
         "一条进度条在走、完全没声"的音频条，比不播更让人困惑。
         编辑页里音频那一行的勾选框也是禁用 + 说明，两处口径一致。 */
      return `<div class="p-audio"><audio class="p-media-el" controls preload="metadata" src="${esc(m.url)}">当前浏览器不支持音频播放。</audio></div>`;
    }
    const auto = m.autoplay ? ' data-autoplay="1" muted' : '';
    const poster = m.poster ? ` poster="${esc(m.poster)}"` : '';
    return `<video class="p-media-el" controls playsinline webkit-playsinline${poster} preload="none"${auto} src="${esc(m.url)}">当前浏览器不支持视频播放。</video>`;
  }).join('');

  const hasLikes = (p.likes || []).length > 0;
  const hasCmts = (p.comments || []).length > 0;

  // 点赞入口放在 .p-foot 里、··· 按钮左侧 8px：0 赞显示"♡ 点赞"，有赞显示实心蓝心+计数，我赞过标红
  const likeInner = hasLikes
    ? `<span class="like-count">${p.likes.length}</span>`
    : '<span class="like-word">点赞</span>';
  const likeCls = ['like-row', hasLikes ? 'num' : '', liked ? 'mine' : ''].filter(Boolean).join(' ');
  // title 要跟随状态：气泡里那个"取消点赞"入口已删掉，红色实心心如何撤销必须能被看出来
  const titleAttr = liked ? '已点赞，点击取消' : hasLikes ? '双击内容也可点赞' : '点赞';
  const likeBtn = `<button type="button" class="${likeCls}" data-act="like" aria-pressed="${liked}" title="${titleAttr}">${ICON_LIKE_SM}${likeInner}</button>`;

  // 点赞搬走后 .acts 回到"只有评论才渲染"，零互动帖子不再多一条灰盒
  const actsHtml = hasCmts
    ? `<div class="acts"><div class="cmt-list">` + p.comments.map((c) => renderComment(c, ctx)).join('') + '</div></div>'
    : '';

  return `
  <div class="post" data-pid="${p.id}">
    <img class="p-avatar"${avAttr} alt="">
    <div class="p-body">
      <span class="p-name">${esc(ctx.nickname)}</span>
      ${p.content ? `<div class="p-text">${esc(p.content)}</div>` : ''}
      ${imgHtml}
      ${mediaHtml}
      ${locHtml}
      <div class="p-foot">
        ${ctx.detail ? '' : `<a class="p-read" href="/p/${encodeURIComponent(p.id)}">阅读全文</a>`}
        <span class="p-time">${fmtTime(p.created_at, ctx.nowMs)}</span>
        ${likeBtn}
        <div class="p-toggle" data-pid="${p.id}"><i></i><i></i></div>
      </div>
      ${actsHtml}
    </div>
  </div>`;
}

/* 整列信息流的 HTML。空列表给一句引导文案，与 feed.js 原来的分支保持一致。 */
function feedHTML(posts, ctx) {
  if (!posts || !posts.length) return '<div class="loading">还没有内容，点右上角相机发布第一条吧</div>';
  return posts.map((p) => renderPost(p, ctx)).join('');
}

const Render = {
  esc, fmtTime, imgUrl, COMMENT_MAX, CMT_CLAMP_AT, IMGS_MAX,
  ICON_HEART, ICON_LIKE_SM, ICON_CMT, ICON_PIN, ICON_IMG,
  cmtPrefix, cmtFolded, renderComment, renderPost, feedHTML,
};

root.Render = Render;
// 浏览器侧继续暴露 esc/fmtTime 全局：原先声明在 common.js，现在随渲染层一起搬到这里，
// 免得同一个函数有两份。common.js 必须在本文件之后加载。
root.esc = esc;
root.fmtTime = fmtTime;
// 让纯渲染函数在 Node 里也能被 require，SSR 与浏览器共用一份（同 crop.js 的做法）
if (typeof module !== 'undefined' && module.exports) module.exports = Render;
})(typeof window !== 'undefined' ? window : globalThis);
