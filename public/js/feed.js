/* 朋友圈信息流：渲染、点赞、评论、回复、大图查看 */
'use strict';

const COMMENT_MAX = 200; // 与 server.js 的同名常量保持一致（输入框 maxlength 亦为此值）
const CMT_CLAMP_AT = 80; // 评论超过此字数先折叠；按码点计数，避免切碎 emoji 造成乱码

const state = {
  posts: [],
  cmtExpanded: new Set(), // 已点开的长评论 id，重渲染后保持展开
  viewer: { imgs: [], i: 0 },
  swipeGuard: 0,      // 横滑翻页后短暂抑制浏览器补发的 click，避免误关预览
  viewerOpen: null,   // {t,x,y,pid} 打开大图的时刻与位置，用于识别"双击照片点赞"的第二击
  replyTo: null,      // { id, name } 回复某条评论
  activePid: null,    // 评论栏当前对应的朋友圈
  editingCid: null,   // 正在编辑的评论 id
  tmpActs: null,      // 为「无点赞无评论」的帖子临时创建的 acts 容器，收起时移除
  page: 1, pages: 1, total: 0,   // 分页
  settings: {}, // 默认值只在 server.js 一处维护，前端等 /api/settings 下发，避免多副本漂移
};

const ICON_HEART = '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.7-10-9.3C.5 8.6 2.4 5 5.8 5c2 0 3.4 1 4.2 2.4h4c.8-1.4 2.2-2.4 4.2-2.4 3.4 0 5.3 3.6 3.8 6.7C19.5 16.3 12 21 12 21z"/></svg>';
const ICON_LIKE_SM = '<svg viewBox="0 0 24 24"><path d="M12 21.3C10.6 20.2 2.5 14.6 2.5 8.9 2.5 5.6 5 3.5 7.6 3.5c1.8 0 3.4.9 4.4 2.4 1-1.5 2.6-2.4 4.4-2.4 2.6 0 5.1 2.1 5.1 5.4 0 5.7-8.1 11.3-9.5 12.4z"/></svg>';
const ICON_CMT = '<svg viewBox="0 0 24 24"><path d="M12 3C6.5 3 2 6.9 2 11.7c0 2.7 1.4 5.1 3.7 6.7-.2 1-.8 2.2-1.6 3 1.7-.2 3.3-.9 4.4-1.7 1.1.3 2.3.5 3.5.5 5.5 0 10-3.9 10-8.5S17.5 3 12 3z"/></svg>';
const ICON_PIN = '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>';
const ICON_IMG = '<svg viewBox="0 0 24 24"><path d="M21 3H3a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1zM8.5 9A1.5 1.5 0 1 1 7 10.5A1.5 1.5 0 0 1 8.5 9zM5 18l4.5-6 3 4 2.5-3 4 5z"/></svg>';

const imgUrl = (id) => `/api/images/${encodeURIComponent(id)}`;

/* 特效调度：只认三个合法值，其它一律按默认飘雪处理 */
function applyFx(mode) {
  const m = mode === 'blossom' || mode === 'off' ? mode : 'snow';
  if (window.Snow) Snow.setEnabled(m === 'snow');
  if (window.Blossom) Blossom.setEnabled(m === 'blossom');
}

/* ---------- 音视频播放控制 ----------
   四条规则，都是为了"不占资源、不吵"：
   1) 同一时刻只允许一个在播。play 事件不冒泡，所以监听必须走捕获阶段；
      不做这条，自动播放的那条滚过去之后还在出声，用户找不到是谁在响。
   2) 滚出视口就暂停。IntersectionObserver 的回调只在跨越阈值时触发，
      比 scroll 监听 + getBoundingClientRect 便宜得多，也不会引起重排。
   3) data-autoplay 的元素"进入视口足够多"才 play()，且只自动起播一次。
      阈值不能是默认的 0：露出 1px 就起播的话，滚动途中每条视频都会去抢
      "唯一在播"那个槽位，用户正在看的那条被反复打断。取 0.25 面积。
   4) autoDone 只能在 play() 真正成功后写。iOS 上 preload="none" 的非手势
      play() 可能被拒一次，若在调用前就置标记，这条视频此后永远不会自动起播。
      同时用 autoTried 兜住"被拒后每个交叉事件都重试"的无限循环。
   没有 IntersectionObserver 的老内核退化为"不自动播、其余照常手动播"，不影响手动播放。 */
const mediaIO = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
      for (const en of entries) {
        const el = en.target;
        if (en.isIntersecting) {
          if (el.dataset.autoplay === '1' && el.dataset.autoDone !== '1' && el.dataset.autoTried !== '1') {
            el.dataset.autoTried = '1';
            let pr = null;
            try { pr = el.play(); } catch (e) { pr = null; }   // 老内核可能直接抛，不能打断整页
            if (pr && pr.then) pr.then(() => { el.dataset.autoDone = '1'; }, () => {});
            else el.dataset.autoDone = '1';
          }
        } else if (!el.paused) el.pause();
      }
    }, { threshold: 0.25 })
  : null;

function observeMedia() {
  if (!mediaIO) return;
  $$('.p-media-el').forEach((el) => mediaIO.observe(el));
}

/* 节点被替换前先把旧元素交还给 IO 并停下：
   observeMedia() 只加不减，重建过的帖子留下的旧节点会被 IO 一直强引用，
   整页翻下来这些脱离文档的子树（含 video/audio 与它们的解码缓冲）都不回收。 */
function releaseMedia(root) {
  if (!mediaIO || !root) return;
  $$('.p-media-el', root).forEach((el) => { try { el.pause(); } catch (e) {} mediaIO.unobserve(el); });
}

document.addEventListener('play', (e) => {
  const el = e.target;
  if (!el.classList || !el.classList.contains('p-media-el')) return;
  $$('.p-media-el').forEach((other) => { if (other !== el && !other.paused) other.pause(); });
}, true);

/* ---------- 渲染 ---------- */
function renderFeed() {
  const feed = $('#feed');
  releaseMedia(feed);          // 旧节点交还给 IO 并停下，别让上一页的视频继续在后台出声
  if (!state.posts.length) {
    feed.innerHTML = '<div class="loading">还没有内容，点右上角相机发布第一条吧</div>';
    return;
  }
  feed.innerHTML = state.posts.map(renderPost).join('');
  observeMedia();
}

function renderPost(p) {
  const clientKey = getClientKey();
  const liked = p.likes.some((l) => l.client_key === clientKey);
  // 头像未就绪时不写 src：src="" 会让浏览器再去请求当前页面 URL
  const avAttr = state.settings.avatar ? ` src="${esc(state.settings.avatar)}"` : '';

  let imgHtml = '';
  if (p.images.length === 1) {
    imgHtml = `<div class="p-single"><img src="${imgUrl(p.images[0])}" data-pid="${p.id}" data-idx="0" loading="lazy" decoding="async" alt=""></div>`;
  } else if (p.images.length > 1) {
    // 2 张与 4 张走两列：三列布局下 2 张只占容器 2/3 宽，两列才与单图（.p-single 撑满）同宽
    const twoUp = p.images.length === 2 || p.images.length === 4;
    const cls = twoUp ? 'p-grid cols-2' : 'p-grid';
    imgHtml = `<div class="${cls}">` + p.images.map((im, i) =>
      `<img src="${imgUrl(im)}" data-pid="${p.id}" data-idx="${i}" loading="lazy" decoding="async" alt="">`).join('') + '</div>';
  }

  const locHtml = p.location
    ? `<div class="p-location">${ICON_PIN}${esc(p.location)}</div>` : '';

  /* 音视频：只播外链（本站不托管媒体文件），一条内容最多 3 段，排在图片之后。
     - video 用 preload="none"：列表里刷过去时一个字节都不下，点开才取流；
     - audio 用 preload="metadata"：它没有画面，进度条与时长要靠文件头才画得出来，
       这只请求头部几 KB，不是整段；
     - playsinline 是 iOS 必需，少了它一点播放就全屏接管；
     - 自动播放刻意【不】写 autoplay 属性，改成 data-autoplay 交给下面的控制器：
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

  const hasLikes = p.likes.length > 0;
  const hasCmts = p.comments.length > 0;

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
    ? `<div class="acts"><div class="cmt-list">` + p.comments.map((c) => renderComment(c)).join('') + '</div></div>'
    : '';

  return `
  <div class="post" data-pid="${p.id}">
    <img class="p-avatar"${avAttr} alt="">
    <div class="p-body">
      <span class="p-name">${esc(state.settings.nickname)}</span>
      ${p.content ? `<div class="p-text">${esc(p.content)}</div>` : ''}
      ${imgHtml}
      ${mediaHtml}
      ${locHtml}
      <div class="p-foot">
        <span class="p-time">${fmtTime(p.created_at)}</span>
        ${likeBtn}
        <div class="p-toggle" data-pid="${p.id}"><i></i><i></i></div>
      </div>
      ${actsHtml}
    </div>
  </div>`;
}

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
  const chars = Array.from(c.content);
  return chars.length > CMT_CLAMP_AT ? chars.slice(0, CMT_CLAMP_AT).join('') : null;
}

function renderComment(c) {
  const mine = c.client_key && c.client_key === getClientKey();
  const folded = cmtFolded(c);
  const expanded = state.cmtExpanded.has(c.id);
  const body = `<span class="cmt-body">${cmtPrefix(c)}${esc(expanded || folded === null ? c.content : folded)}</span>`;
  const more = folded === null ? '' : `<i class="cmt-more">${expanded ? '收起' : '…展开'}</i>`;
  const ops = mine ? '<span class="cmt-ops"><i class="cmt-op" data-op="edit">编辑</i><i class="cmt-op danger" data-op="del">删除</i></span>' : '';
  return `<div class="cmt${mine ? ' mine' : ''}" data-cid="${c.id}" data-cname="${esc(c.name)}">${body}${more}${ops}</div>`;
}

function refreshPost(pid) {
  const p = state.posts.find((x) => x.id === pid);
  const old = $(`.post[data-pid="${pid}"]`);
  if (!p || !old) return;
  const bar = $('#cbar');
  /* 整条重建会连带销毁正在播的音视频：点赞、发评论、删评论都走这里，
     等于"我赞了个点，视频从头开始"。所以先把每条的播放位置与自动播标记摘下来，
     重建后再贴回去。 */
  const mediaState = $$('.p-media-el', old).map((el) => ({
    t: el.currentTime || 0,
    playing: !el.paused && !el.ended,
    done: el.dataset.autoDone === '1',
    tried: el.dataset.autoTried === '1',
  }));
  releaseMedia(old);
  // 外点不再收起表单，所以整条重建时也不能把用户写了一半的内容弄丢：
  // 先把表单节点摘下（值随节点保留），重建后再挂回去并恢复展开态
  const reopen = bar.classList.contains('show') && state.activePid === pid;
  if (old.contains(bar)) stashCbar();
  const wrap = document.createElement('div');
  wrap.innerHTML = renderPost(p);
  const fresh = wrap.firstElementChild;
  old.replaceWith(fresh);
  $$('.p-media-el', fresh).forEach((el, i) => {
    const s = mediaState[i];
    if (!s) return;
    if (s.done) el.dataset.autoDone = '1';
    if (s.tried) el.dataset.autoTried = '1';
    if (!s.playing && !s.t) return;
    const resume = () => {
      try { if (s.t > 0.2) el.currentTime = s.t; } catch (e) { /* 未就绪时忽略，下面照样起播 */ }
      if (s.playing) { const pr = el.play(); if (pr && pr.catch) pr.catch(() => {}); }
    };
    if (el.readyState >= 1) resume();
    else el.addEventListener('loadedmetadata', resume, { once: true });
  });
  observeMedia();   // 重建过的那条里有新节点，得重新登记给 IntersectionObserver
  if (reopen && mountCbar(pid)) bar.classList.add('show');
}

/* ---------- 点赞 / 评论气泡 ---------- */
function closePop() {
  $$('.pop').forEach((n) => n.remove());
  $$('.p-toggle.on').forEach((n) => n.classList.remove('on'));
}

function openPop(toggleEl, pid) {
  closePop();
  const p = state.posts.find((x) => x.id === pid);
  if (!p) return;
  const pop = document.createElement('div');
  pop.className = 'pop';
  pop.innerHTML = `
    <div class="pop-item" data-act="cmt">${ICON_CMT}<span>评论</span></div>`;
  toggleEl.classList.add('on');
  toggleEl.parentElement.appendChild(pop);
  pop.addEventListener('click', async (e) => {
    const item = e.target.closest('.pop-item');
    if (!item) return;
    e.stopPropagation(); // 气泡自身的监听已处理这条点击，不必再冒到 document 走外点兜底
    closePop();
    openCbar(pid, null);
    // 气泡里只有"评论"一项：点赞走右下角常驻按钮（历史上这里放过点赞与分享，
    // 两个入口行为不一致才都撤了），别再往回加。
  });
}

async function handleLike(pid) {
  const p = state.posts.find((x) => x.id === pid);
  if (!p) return;
  const clientKey = getClientKey();
  const liked = p.likes.some((l) => l.client_key === clientKey);
  try {
    if (liked) {
      // 「取消点赞」＝清空我在这一条下累计的全部赞（双击可累加，只撤一次会令人困惑）
      const r = await api(`/api/posts/${pid}/like?clientKey=${encodeURIComponent(clientKey)}`, { method: 'DELETE' });
      p.likes = r.likes;
    } else {
      await addLikeOnly(pid);
      return;
    }
    refreshPost(pid);
  } catch (e) { alertDlg(e.message); }
}

/* 点赞不再要求填昵称：有昵称就带上，没有就记"游客"，绝不为点赞展开表单 */
async function addLikeOnly(pid) {
  const p = state.posts.find((x) => x.id === pid);
  if (!p) return false;
  try {
    const r = await api(`/api/posts/${pid}/like`, {
      method: 'POST', body: { clientKey: getClientKey(), name: getNick() || '游客' },
    });
    p.likes = r.likes;
    refreshPost(pid);
    return true;
  } catch (e) { showToast(e.message); return false; } // 限流/离线只给轻提示，不打断
}

/* ---------- 双击点赞 + 爱心喷发 ---------- */
/* video/audio 必须排除：一是原生双击会切全屏，我们的双击点赞会跟它抢；
   二是在播放器上"点赞"这个意图本来也不成立。 */
const LIKE_EXCLUDE = 'a, button, input, textarea, .like-row, .cbar, .p-toggle, .pop, .cmt, .cmt-more, .p-single img, .p-grid img, .blogroll-item, .viewer, video, audio';
const tapMemo = { pid: '', t: 0, x: 0, y: 0 };

async function likeAt(postEl, origin) {
  const pid = postEl.dataset.pid;
  if (!pid) return;
  // 先等结果再放特效：之前是"先炸心再发请求"，被限流或离线时心炸了但计数没变，视觉在说谎。
  // 本地/内网这一跳通常几毫秒；真机上一来一回也远快于人眼对"双击"的判定。
  const done = await addLikeOnly(pid);
  if (done) heartBurst(origin); // 失败（限流/离线）只留 toast，不炸心
}

// 桌面/触屏笔电：dblclick
document.addEventListener('dblclick', (e) => {
  const post = e.target.closest && e.target.closest('.post');
  if (!post || e.target.closest(LIKE_EXCLUDE)) return;
  likeAt(post);
});

// 手机：自己判定双击，因为移动端 dblclick 会连带触发浏览器缩放且时机不稳
document.addEventListener('touchend', (e) => {
  if (e.touches.length > 0) { tapMemo.pid = ''; return; } // 多指手势（捏合等）不参与
  const t = e.changedTouches[0];
  const hit = document.elementFromPoint(t.clientX, t.clientY);
  const post = hit && hit.closest ? hit.closest('.post') : null;
  if (!post || hit.closest(LIKE_EXCLUDE)) { tapMemo.pid = ''; return; }
  const now = Date.now();
  const near = Math.abs(t.clientX - tapMemo.x) < 30 && Math.abs(t.clientY - tapMemo.y) < 30;
  if (tapMemo.pid === post.dataset.pid && now - tapMemo.t < 320 && near) {
    tapMemo.pid = '';
    e.preventDefault(); // 吃掉浏览器自己的双击缩放
    likeAt(post);
  } else {
    tapMemo.pid = post.dataset.pid; tapMemo.t = now; tapMemo.x = t.clientX; tapMemo.y = t.clientY;
  }
}, { passive: false });

// 纯 CSS 粒子：向上扇形喷出爱心并渐隐；不引任何库。
// origin 省略时以视口中心为原点（双击），传入时以该元素/点位为原点（点点赞按钮）。
function heartBurst(origin) {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const layer = document.createElement('div');
  layer.className = 'burst';
  if (origin) {                       // 覆盖 CSS 的 left/top: 50%，让粒子从按钮处冒出
    layer.style.left = origin.x + 'px';
    layer.style.top = origin.y + 'px';
  }
  for (let i = 0; i < 16; i++) {
    const s = document.createElement('span');
    s.className = 'burst-h';
    const ang = (-90 + (Math.random() * 130 - 65)) * Math.PI / 180;  // 以正上为中心的扇形
    const dist = 90 + Math.random() * 120;
    s.style.setProperty('--tx', (Math.cos(ang) * dist).toFixed(1) + 'px');
    s.style.setProperty('--ty', (Math.sin(ang) * dist).toFixed(1) + 'px');
    s.style.setProperty('--rot', (Math.random() * 80 - 40).toFixed(0) + 'deg');
    s.style.setProperty('--sz', (16 + Math.random() * 18).toFixed(0) + 'px');
    s.style.animationDelay = (Math.random() * 120).toFixed(0) + 'ms';
    s.innerHTML = ICON_HEART;
    layer.appendChild(s);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 1200); // 覆盖 1000ms 动画 + 最长 120ms 延迟，摘干净不留幽灵节点
}

/* ---------- 评论栏：挂在对应朋友圈的 acts 容器内（支持 回复 / 编辑自己的评论） ---------- */

/* 找到该条朋友圈的 acts 灰盒；没有（零赞零评）就临时补一个，保证评论栏有落点 */
function actsOf(pid) {
  const postEl = $(`.post[data-pid="${pid}"]`);
  if (!postEl) return null;
  const exists = postEl.querySelector('.acts');
  if (exists) return exists;
  const acts = document.createElement('div');
  acts.className = 'acts';
  postEl.querySelector('.p-body').appendChild(acts);
  state.tmpActs = acts;
  return acts;
}

/* 把全站唯一的 #cbar 节点搬进目标 acts */
function mountCbar(pid) {
  const acts = actsOf(pid);
  if (!acts) return false;
  const bar = $('#cbar');
  if (bar.parentElement !== acts) acts.appendChild(bar);
  return true;
}

/* 收起并搬回 body，同时清掉临时 acts，避免留下空灰盒 */
function stashCbar() {
  const bar = $('#cbar');
  bar.classList.remove('show');
  if (bar.parentElement && bar.parentElement !== document.body) document.body.appendChild(bar);
  if (state.tmpActs) { state.tmpActs.remove(); state.tmpActs = null; }
}

/* 表单里的身份两栏：昵称必填、主页选填（缺协议自动补 https://） */
function readIdentity() {
  const name = $('#cName').value.trim();
  let site = $('#cSite').value.trim();
  if (site && !/^https?:\/\//i.test(site)) site = 'https://' + site;
  return { name, site };
}
function saveIdentity(id) { if (id.name) { setNick(id.name); setSite(id.site); } }

/* 表单内联错误提示，替代弹窗 */
function cbarErr(msg) {
  const el = $('#cbarErr');
  el.textContent = msg || '';
  el.classList.toggle('show', Boolean(msg));
}

/* 键盘避让：手机键盘弹出压缩的是 visual viewport（layout 坐标不变），且键盘动画比 focus 晚
   数十到数百毫秒，所以必须在视口变化后重新计算滚动量，否则表单正好被键盘盖住。 */
function keyboardSafeScroll() {
  const bar = $('#cbar');
  if (!bar.classList.contains('show')) return;
  const vv = window.visualViewport;
  // 没有键盘（视口未被压缩）时只需粗定位；有键盘时按视觉视口底边精算
  const kbUp = vv && vv.height < window.innerHeight - 80;
  if (!kbUp) { bar.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
  const box = bar.getBoundingClientRect();
  const visibleBottom = vv.offsetTop + vv.height;   // 视觉视口底边
  const need = box.bottom - (visibleBottom - 16);   // 留 16px 呼吸位
  if (need > 0) window.scrollBy({ top: need, behavior: 'smooth' });
}

let vvWatcher = null;
function watchKeyboard() {
  unwatchKeyboard();
  const vv = window.visualViewport;
  if (!vv) return;
  // 只监听 resize：键盘弹起改变的是可视区高度。不监听 scroll——回调里会程序化滚动，
  // iOS 上 vv 的 scroll 事件在平滑动画期间持续触发，会和自己的滚动互相拉扯产生抖动。
  vvWatcher = () => keyboardSafeScroll();
  vv.addEventListener('resize', vvWatcher);
}
function unwatchKeyboard() {
  const vv = window.visualViewport;
  if (vv && vvWatcher) vv.removeEventListener('resize', vvWatcher);
  vvWatcher = null;
}

/* 评论框随内容撑高：上限从 CSS 的 max-height 读，避免 JS 与样式各写一个魔法数。
   注意必须在 .cbar 已经 display:block 之后测量，否则 scrollHeight 为 0。 */
function autoGrowCbar() {
  const el = $('#cbarInput');
  el.style.height = 'auto';
  const max = parseFloat(getComputedStyle(el).maxHeight) || 120;
  el.style.height = Math.min(el.scrollHeight, max) + 'px';
  el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
}

function openCbar(pid, replyTo, editTarget) {
  // 切到另一条朋友圈前，先清掉上一条临时补的 acts，避免留下空灰盒
  if (state.tmpActs) { state.tmpActs.remove(); state.tmpActs = null; }
  if (!mountCbar(pid)) return; // 目标帖子不在当前页 DOM 中，放弃弹出
  state.activePid = pid;
  state.replyTo = replyTo || null;
  state.editingCid = editTarget ? editTarget.id : null;
  const input = $('#cbarInput');
  const send = $('#cbarSend');
  $('#cName').value = getNick();
  $('#cSite').value = getSite();
  if (editTarget) {
    input.placeholder = '编辑评论';
    input.value = editTarget.content;
    send.textContent = '更新评论';
  } else {
    input.placeholder = replyTo ? `回复 ${replyTo.name}：` : '写评论…';
    input.value = '';
    send.textContent = '发送';
  }
  send.classList.toggle('on', Boolean(editTarget) || input.value.trim().length > 0);
  cbarErr('');
  hideEmoji();   // 气泡菜单里的「评论」会 stopPropagation 绕过外点兜底，这里保证换目标时面板必收
  $('#cbar').classList.add('show');
  autoGrowCbar();                    // 编辑模式下带出原文时要立刻撑到对应高度
  // focus 同步做：iOS 要求在用户手势的同一任务里，包进 setTimeout 可能导致键盘不弹
  const focusEl = getNick() ? input : $('#cName'); // 老访客直接进内容框，首次使用先停在昵称框
  focusEl.focus({ preventScroll: true });
  focusEl.setSelectionRange(focusEl.value.length, focusEl.value.length);
  watchKeyboard();
  keyboardSafeScroll();
  // 键盘动画结束后再兜底校正（部分安卓 WebView 不触发 visualViewport resize）
  [120, 300, 550].forEach((t) => setTimeout(keyboardSafeScroll, t));
}

function closeCbar() {
  unwatchKeyboard();
  stashCbar();
  const ci = $('#cbarInput');
  ci.value = '';
  ci.style.height = '';        // 交回 CSS 的 32px 静止高度，不留内联残留
  ci.style.overflowY = 'hidden';
  $('#cbarSend').classList.remove('on');
  $('#cbarSend').textContent = '发送';
  cbarErr('');
  hideEmoji();
  state.replyTo = null;
  state.activePid = null;
  state.editingCid = null;
}

/* ---------- Emoji 选择插入 ---------- */
const EMOJIS = [
  '😀','😄','😂','','😊','😍','😘','🥰','','🤩','😉','🙂','🤔','😴','😭','😡',
  '👍','👏','🙏','','✌️','❤️','💛','💙','💔','✨','🔥','','🌟','⭐','🌈','️',
  '⛅','','🌊','🏔️','🌸','','🍀','🌵','','🦋','','✈️','🚗','🏖️','🍜','☕',
  '🍺','🎂','🎁','🎉','💡','','🌍','🎵'
];

function toggleEmoji() { $('#emojiPanel').classList.toggle('show'); }
function hideEmoji() { const p = $('#emojiPanel'); if (p) p.classList.remove('show'); }

function buildEmojiPanel() {
  const panel = $('#emojiPanel');
  if (panel && !panel.childElementCount) {
    panel.innerHTML = EMOJIS.filter((e) => e && e.trim())
      .map((e) => `<span class="emoji-cell">${e}</span>`).join('');
  }
}

function insertEmoji(emoji) {
  const input = $('#cbarInput');
  const start = input.selectionStart != null ? input.selectionStart : input.value.length;
  const end = input.selectionEnd != null ? input.selectionEnd : input.value.length;
  input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
  const caret = start + emoji.length;
  input.focus();
  input.setSelectionRange(caret, caret);
  autoGrowCbar();
  $('#cbarSend').classList.toggle('on', input.value.trim().length > 0);
}

// 表单只有一个提交目标：评论（点赞已不走表单）
const onSend = sendComment;

/* 借同一张表单补填昵称后完成点赞 */

async function sendComment() {
  const input = $('#cbarInput');
  const text = input.value.trim();
  const pid = state.activePid;
  if (!pid) return;
  if (!text) { cbarErr('评论内容不能为空'); input.focus(); return; }
  if (text.length > COMMENT_MAX) { cbarErr(`评论不能超过 ${COMMENT_MAX} 字`); return; }
  const id = readIdentity();
  // 编辑自己的评论由服务端按 clientKey 校验，无需再填昵称
  if (!state.editingCid && !id.name) { cbarErr('请先填写昵称'); $('#cName').focus(); return; }
  saveIdentity(id);
  try {
    let res;
    if (state.editingCid) {
      res = await api(`/api/comments/${state.editingCid}`, {
        method: 'PUT', body: { content: text, clientKey: getClientKey() },
      });
    } else {
      res = await api(`/api/posts/${pid}/comments`, {
        method: 'POST',
        body: { content: text, name: id.name, clientKey: getClientKey(), site: id.site, replyToId: state.replyTo ? state.replyTo.id : null },
      });
    }
    const r = await api(`/api/posts/${pid}`);
    const p = state.posts.find((x) => x.id === pid);
    if (p) p.comments = r.post.comments;
    closeCbar();
    refreshPost(pid);
    const st = res && res.comment && res.comment.status;
    if (st === 'pending') showToast('评论已提交，审核通过后展示');
  } catch (e) { cbarErr(e.message); }
}

/* ---------- 大图查看器 ---------- */
function showViewer() {
  const { imgs, i } = state.viewer;
  $('#vImg').src = imgUrl(imgs[i]);
  $('#vCount').textContent = `${i + 1}/${imgs.length}`;
  $('#viewer').classList.toggle('single', imgs.length < 2); // 单图不显示翻页箭头
  $('#viewer').classList.add('show');
}
function hideViewer() { $('#viewer').classList.remove('show'); }

/* ---------- 事件绑定 ---------- */
document.addEventListener('click', async (e) => {
  const t = e.target;

  // 表情面板开着时，点面板本体与表情按钮以外的任意位置都收起它。
  // 放在最前面，是为了让下面那些会 return / stopPropagation 的分支不影响这条全局兜底；
  // 且只收面板、绝不碰表单——上一轮已明确：写了一半的评论不能因为外点丢失。
  const panel = $('#emojiPanel');
  if (panel.classList.contains('show') && !t.closest('#emojiPanel') && !t.closest('#emojiBtn')) hideEmoji();

  // 打开/切换 ·· 气泡
  const toggle = t.closest('.p-toggle');
  if (toggle) {
    e.stopPropagation();
    const pid = toggle.dataset.pid;
    if (toggle.classList.contains('on')) closePop();
    else openPop(toggle, pid);
    return;
  }

  // 「❤ 点赞」按钮：未赞则 +1，已赞则清空我在这一条的赞
  const likeBtn = t.closest && t.closest('.like-row');
  if (likeBtn) {
    e.stopPropagation();
    const postEl = likeBtn.closest('.post');
    const pid = postEl.dataset.pid;
    const p = state.posts.find((x) => x.id === pid);
    const already = p && p.likes.some((l) => l.client_key === getClientKey());
    if (already) { await handleLike(pid); return; }  // 已赞→撤销，不喷心
    // 原点取按钮自身的中心（视口坐标），爱心就从"点赞"处冒出来
    const r = likeBtn.getBoundingClientRect();
    await likeAt(postEl, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
    return;
  }

  // 气泡内部点击已在自身监听处理；点其他区域关闭气泡
  if (!t.closest('.pop')) closePop();

  // 图片 → 查看大图
  const img = t.closest('.p-grid img, .p-single img');
  if (img) {
    const p = state.posts.find((x) => x.id === img.dataset.pid);
    if (p) {
      state.viewer = { imgs: p.images, i: Number(img.dataset.idx) || 0 };
      // 记下"打开这一刻"的时间与位置：手机上双击照片的直觉是"点赞"，
      // 而第一击必然先把大图打开，所以在查看器里补判第二击（不延迟正常打开）
      state.viewerOpen = { t: Date.now(), x: e.clientX, y: e.clientY, pid: p.id };
      showViewer();
    }
    return;
  }

  // 自己评论的 编辑/删除
  const op = t.closest('.cmt-op');
  if (op) {
    e.stopPropagation();
    const cmtEl = op.closest('.cmt');
    const postEl = op.closest('.post');
    const pid = postEl.dataset.pid;
    const cid = cmtEl.dataset.cid;
    const p = state.posts.find((x) => x.id === pid);
    const c = p && p.comments.find((x) => x.id === cid);
    if (!c) return;
    try {
      if (op.dataset.op === 'edit') {
        openCbar(pid, null, { id: cid, content: c.content });
      } else if (op.dataset.op === 'del') {
        const ok = await confirmDlg('确定删除这条评论吗？', '删除');
        if (!ok) return;
        await api(`/api/comments/${cid}?clientKey=${encodeURIComponent(getClientKey())}`, { method: 'DELETE' });
        const r = await api(`/api/posts/${pid}`);
        p.comments = r.post.comments;
        closeCbar();   // 删除会重建该条 DOM，先把评论栏收起（可能正带着这条评论的编辑内容）
        refreshPost(pid);
      }
    } catch (err) { alertDlg(err.message); }
    return;
  }

  // 长评论 展开/收起
  const more = t.closest('.cmt-more');
  if (more) {
    e.stopPropagation();
    const cmtEl = more.closest('.cmt');
    const p = state.posts.find((x) => x.id === more.closest('.post').dataset.pid);
    const c = p && p.comments.find((x) => x.id === cmtEl.dataset.cid);
    if (!c) return;
    const willExpand = !state.cmtExpanded.has(c.id);
    if (willExpand) state.cmtExpanded.add(c.id);
    else state.cmtExpanded.delete(c.id);
    cmtEl.querySelector('.cmt-body').innerHTML =
      cmtPrefix(c) + esc(willExpand ? c.content : (cmtFolded(c) || c.content));
    more.textContent = willExpand ? '收起' : '…展开';
    return;
  }

  // 评论者主页链接：正常跳转，不触发回复
  if (t.closest('.nm-link')) { e.stopPropagation(); return; }

  // 评论行 → 回复
  const cmt = t.closest('.cmt');
  if (cmt) {
    const post = t.closest('.post');
    openCbar(post.dataset.pid, { id: cmt.dataset.cid, name: cmt.dataset.cname });
    return;
  }

  // 刻意不做"点页面其它区域自动收起"：那样随手一点就会把已经写了一半的评论清空。
  // 表单只由「取消」按钮、Esc、发送成功、或切到另一条评论/帖子时显式关闭。
});

$('#cbarInput').addEventListener('input', (e) => {
  $('#cbarSend').classList.toggle('on', e.target.value.trim().length > 0);
  autoGrowCbar();
  cbarErr('');
});
// 昵称/主页里回车：推进到内容框，不直接提交，避免误发
['#cName', '#cSite'].forEach((sel) => {
  $(sel).addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    $('#cbarInput').focus();
  });
  $(sel).addEventListener('input', () => cbarErr(''));
});
$('#cbarInput').addEventListener('keydown', (e) => {
  // e.isComposing：中文输入法用回车选候选词时不应触发发送（textarea 换行后更易踩到）
  if (e.key !== 'Enter' || e.isComposing) return;
  if (e.shiftKey) return;            // Shift+Enter 留给换行
  e.preventDefault();
  onSend();
});
$('#cbarSend').addEventListener('click', onSend);
$('#cbarCancel').addEventListener('click', () => closeCbar());

$('#emojiBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleEmoji(); });
$('#emojiPanel').addEventListener('click', (e) => {
  const cell = e.target.closest('.emoji-cell');
  if (!cell) return;                       // 点面板空白处不选字也不关（外点兜底才收）
  e.stopPropagation();
  insertEmoji(cell.textContent);
  hideEmoji();                             // 选完即收起：浮层压在输入框上方，留着会挡住继续编辑
});

$('#vClose').addEventListener('click', hideViewer);
// 点蒙层本体（图片与翻页热区之外的黑边）也关闭预览；
// 只认 target 恰为 viewer 本身（图片与翻页按钮是它的子节点，点它们不该被当成点蒙层）
$('#viewer').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) hideViewer();
});
function goPrev() {
  const v = state.viewer;
  if (v.imgs.length < 2) return;
  v.i = (v.i - 1 + v.imgs.length) % v.imgs.length;
  showViewer();
}
function goNext() {
  const v = state.viewer;
  if (v.imgs.length < 2) return;
  v.i = (v.i + 1) % v.imgs.length;
  showViewer();
}
$('#vPrev').addEventListener('click', goPrev);
$('#vNext').addEventListener('click', goNext);
$('#vImg').addEventListener('click', (e) => {
  // 刚横向滑完时浏览器可能补发一次 click，别把"滑动翻页"误判成"点图关闭"
  if (Date.now() - state.swipeGuard < 600) return;
  const vo = state.viewerOpen;
  // 打开后 350ms 内同一位置再点一次 = 手机上"双击照片点赞"：点赞并保持打开，不关闭
  if (vo && vo.pid && Date.now() - vo.t < 350
      && Math.abs(e.clientX - vo.x) < 40 && Math.abs(e.clientY - vo.y) < 40) {
    state.viewerOpen = null;
    const postEl = $(`.post[data-pid="${vo.pid}"]`);
    if (postEl) likeAt(postEl);
    return;
  }
  hideViewer();
});

/* 触屏左右滑动翻页：横向位移够大且明显强于纵向才算，避免误吞上下滚动。
   配 CSS 的 touch-action: pan-y —— 不让浏览器把横滑吃掉当成"后退"手势。 */
(function viewerSwipe() {
  const img = $('#vImg');
  let sx = 0, sy = 0, tracking = false;
  img.addEventListener('touchstart', (e) => {
    tracking = false;
    if (state.viewer.imgs.length < 2 || e.touches.length !== 1) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
  }, { passive: true });
  img.addEventListener('touchcancel', () => { tracking = false; }, { passive: true });
  img.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    state.swipeGuard = Date.now();
    if (dx < 0) goNext(); else goPrev();
  }, { passive: true });
})();
document.addEventListener('keydown', (e) => {
  // 表单开着时 Esc 等价于点「取消」；查看器同时开着则优先由它消费（避免一次 Esc 关两样）
  if (e.key === 'Escape' && state.activePid && !$('#viewer').classList.contains('show')) { closeCbar(); return; }
  if (!$('#viewer').classList.contains('show')) return;
  if (e.key === 'Escape') hideViewer();
  if (e.key === 'ArrowLeft') $('#vPrev').click();
  if (e.key === 'ArrowRight') $('#vNext').click();
});

/* ---------- 分页 ---------- */
function renderPager() {
  const pager = $('#pager');
  if (!pager) return;
  if (state.pages <= 1) { pager.style.display = 'none'; pager.innerHTML = ''; return; }
  pager.style.display = 'flex';
  let html = `<span class="pg-arrow${state.page <= 1 ? ' disabled' : ''}" data-page="${state.page - 1}">‹</span>`;
  for (let i = 1; i <= state.pages; i++) {
    html += `<span class="pg-num${i === state.page ? ' cur' : ''}" data-page="${i}">${i}</span>`;
  }
  html += `<span class="pg-arrow${state.page >= state.pages ? ' disabled' : ''}" data-page="${state.page + 1}">›</span>`;
  pager.innerHTML = html;
}

async function loadPosts(page) {
  const r = await api(`/api/posts?page=${page}&limit=10`);
  state.posts = r.posts;
  state.cmtExpanded.clear(); // 换页即换数据集，别把旧会话的展开状态无限攒着
  state.page = r.page; state.pages = r.pages; state.total = r.total;
  closePop(); closeCbar();
  renderFeed();
  renderPager();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$('#pager').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-page]');
  if (!btn || btn.classList.contains('disabled')) return;
  const p = Number(btn.dataset.page);
  if (p >= 1 && p <= state.pages && p !== state.page) loadPosts(p);
});

/* ---------- 发布入口仅管理员可见 ---------- */
async function checkAdmin() {
  try {
    const r = await api('/api/session');
    const btn = $('#navPublish');
    if (btn) btn.style.display = r.admin ? 'flex' : 'none';
  } catch (e) {
    const btn = $('#navPublish');
    if (btn) btn.style.display = 'none';
  }
}

/* ---------- 独立访客计数 ----------
 * 由浏览器上报，因此爬虫和不执行 JS 的客户端不计入；失败就整行不显示，绝不影响读博客 */
async function loadVisitors() {
  const el = $('#visitors');
  if (!el) return;
  try {
    const r = await api('/api/visit', { method: 'POST', body: {} });
    if (r && typeof r.visitors === 'number' && r.visitors > 0) {
      el.textContent = `你是第 ${r.visitors} 位访客`;
    }
  } catch (e) { /* 静默降级 */ }
}

/* ---------- 启动 ---------- */
async function loadSettings() {
  try {
    const r = await api('/api/settings');
    Object.assign(state.settings, r.settings);
  } catch (e) { /* 用默认值兜底 */ }
  const s = state.settings;
  // 只有拿到值才写 src：src="" 会让浏览器去请求当前页面本身
  if (s.cover) $('#coverImg').src = s.cover;
  if (s.avatar) $('#coverAvatar').src = s.avatar;
  $('#coverName').textContent = s.nickname || '';
  $('#coverSign').textContent = s.sign || '';
  $('#coverSign').style.display = s.sign ? '' : 'none';
  /* 飘落特效：三选一、互斥，交给 applyFx 统一开关（两个引擎同时开着会各占一张
     全屏画布和一条 rAF，看起来还像"雪和桃花一起下"）。
     取数失败时 s.fx 是 undefined，落到默认 'snow'，不会因为一次请求失败就整站没特效。 */
  applyFx(s.fx);
  $('#copyright').textContent = `© ${new Date().getFullYear()} ${s.nickname || ''} · 朝夕光年`;
}

/* ---------- 网上邻居（友情链接） ---------- */
async function loadLinks() {
  try {
    const r = await api('/api/links');
    const links = r.links || [];
    const box = $('#blogroll');
    if (!links.length) { box.style.display = 'none'; return; }
    box.style.display = '';
    // 纯文字链接：描述仅保留在 title 悬浮提示中，不做卡片；非 http(s) 的 url 不渲染成链接
    $('#blogrollList').innerHTML = links.filter((l) => /^https?:\/\//i.test(l.url || '')).map((l) =>
      `<a class="blogroll-item" href="${esc(l.url)}" target="_blank" rel="noopener nofollow" title="${esc(l.descr || '')}">${esc(l.name)}</a>`
    ).join('');
  } catch (e) { /* 无友链则不展示 */ }
}

(async () => {
  buildEmojiPanel();
  checkAdmin();
  loadLinks();
  loadVisitors();            // 不 await：页脚计数不该挡信息流
  /* 设置与信息流互不依赖，原先 `await loadSettings()` 再 loadPosts 是白等一个来回；
     跨境链路上一个 RTT 约 400ms，并行掉它就是一次实打实的提前。
     两边各自兜底：设置取不到用默认值，只有帖子取不到才提示加载失败。 */
  await Promise.all([
    loadSettings(),
    loadPosts(1).catch((e) => { $('#feed').innerHTML = `<div class="loading">加载失败：${esc(e.message)}</div>`; }),
  ]);
})();
