/* 朋友圈信息流：渲染、点赞、评论、回复、大图查看 */
'use strict';

const COMMENT_MAX = 200; // 与 server.js 的同名常量保持一致（输入框 maxlength 亦为此值）
const CMT_CLAMP_AT = 80; // 评论超过此字数先折叠；按码点计数，避免切碎 emoji 造成乱码

const state = {
  posts: [],
  cmtExpanded: new Set(), // 已点开的长评论 id，重渲染后保持展开
  viewer: { imgs: [], i: 0 },
  swipeGuard: 0,      // 横滑翻页后短暂抑制浏览器补发的 click，避免误关预览
  replyTo: null,      // { id, name } 回复某条评论
  activePid: null,    // 评论栏当前对应的朋友圈
  editingCid: null,   // 正在编辑的评论 id
  tmpActs: null,      // 为「无点赞无评论」的帖子临时创建的 acts 容器，收起时移除
  cbarMode: 'comment', // comment=评论 / like=借同一表单补填昵称后点赞
  page: 1, pages: 1, total: 0,   // 分页
  settings: {}, // 默认值只在 server.js 一处维护，前端等 /api/settings 下发，避免多副本漂移
};

const ICON_HEART = '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.7-10-9.3C.5 8.6 2.4 5 5.8 5c2 0 3.4 1 4.2 2.4h4c.8-1.4 2.2-2.4 4.2-2.4 3.4 0 5.3 3.6 3.8 6.7C19.5 16.3 12 21 12 21z"/></svg>';
const ICON_LIKE_SM = '<svg viewBox="0 0 24 24"><path d="M12 21.3C10.6 20.2 2.5 14.6 2.5 8.9 2.5 5.6 5 3.5 7.6 3.5c1.8 0 3.4.9 4.4 2.4 1-1.5 2.6-2.4 4.4-2.4 2.6 0 5.1 2.1 5.1 5.4 0 5.7-8.1 11.3-9.5 12.4z"/></svg>';
const ICON_CMT = '<svg viewBox="0 0 24 24"><path d="M12 3C6.5 3 2 6.9 2 11.7c0 2.7 1.4 5.1 3.7 6.7-.2 1-.8 2.2-1.6 3 1.7-.2 3.3-.9 4.4-1.7 1.1.3 2.3.5 3.5.5 5.5 0 10-3.9 10-8.5S17.5 3 12 3z"/></svg>';
const ICON_PIN = '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>';
const ICON_IMG = '<svg viewBox="0 0 24 24"><path d="M21 3H3a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1zM8.5 9A1.5 1.5 0 1 1 7 10.5A1.5 1.5 0 0 1 8.5 9zM5 18l4.5-6 3 4 2.5-3 4 5z"/></svg>';

const imgUrl = (id) => `/api/images/${encodeURIComponent(id)}`;

/* ---------- 渲染 ---------- */
function renderFeed() {
  const feed = $('#feed');
  if (!state.posts.length) {
    feed.innerHTML = '<div class="loading">还没有内容，点右上角相机发布第一条吧</div>';
    return;
  }
  feed.innerHTML = state.posts.map(renderPost).join('');
}

function renderPost(p) {
  const clientKey = getClientKey();
  const liked = p.likes.some((l) => l.client_key === clientKey);
  // 头像未就绪时不写 src：src="" 会让浏览器再去请求当前页面 URL
  const avAttr = state.settings.avatar ? ` src="${esc(state.settings.avatar)}"` : '';

  let mediaHtml = '';
  if (p.images.length === 1) {
    mediaHtml = `<div class="p-single"><img src="${imgUrl(p.images[0])}" data-pid="${p.id}" data-idx="0" loading="lazy" alt=""></div>`;
  } else if (p.images.length > 1) {
    const cls = p.images.length === 4 ? 'p-grid cols-2' : 'p-grid';
    mediaHtml = `<div class="${cls}">` + p.images.map((im, i) =>
      `<img src="${imgUrl(im)}" data-pid="${p.id}" data-idx="${i}" loading="lazy" alt="">`).join('') + '</div>';
  }

  const locHtml = p.location
    ? `<div class="p-location">${ICON_PIN}${esc(p.location)}</div>` : '';

  const hasLikes = p.likes.length > 0;
  const hasCmts = p.comments.length > 0;
  let actsHtml = '';
  if (hasLikes || hasCmts) {
    const likeRow = hasLikes
      ? `<div class="like-row">${ICON_LIKE_SM}<div class="like-names">${p.likes.map((l) => esc(l.name)).join('，')}</div></div>` : '';
    const sep = hasLikes && hasCmts ? '<div class="acts-sep"></div>' : '';
    const cmts = hasCmts
      ? `<div class="cmt-list">` + p.comments.map((c) => renderComment(c)).join('') + '</div>' : '';
    actsHtml = `<div class="acts">${likeRow}${sep}${cmts}</div>`;
  }

  return `
  <div class="post" data-pid="${p.id}">
    <img class="p-avatar"${avAttr} alt="">
    <div class="p-body">
      <span class="p-name">${esc(state.settings.nickname)}</span>
      ${p.content ? `<div class="p-text">${esc(p.content)}</div>` : ''}
      ${mediaHtml}
      ${locHtml}
      <div class="p-foot">
        <span class="p-time">${fmtTime(p.created_at)}</span>
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
  // 外点不再收起表单，所以整条重建时也不能把用户写了一半的内容弄丢：
  // 先把表单节点摘下（值随节点保留），重建后再挂回去并恢复展开态
  const reopen = bar.classList.contains('show') && state.activePid === pid;
  if (old.contains(bar)) stashCbar();
  const wrap = document.createElement('div');
  wrap.innerHTML = renderPost(p);
  old.replaceWith(wrap.firstElementChild);
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
  const liked = p.likes.some((l) => l.client_key === getClientKey());
  const pop = document.createElement('div');
  pop.className = 'pop';
  pop.innerHTML = `
    <div class="pop-item" data-act="like">${ICON_HEART}<span>${liked ? '取消点赞' : '点赞'}</span></div>
    <div class="pop-item" data-act="cmt">${ICON_CMT}<span>评论</span></div>`;
  toggleEl.classList.add('on');
  toggleEl.parentElement.appendChild(pop);
  pop.addEventListener('click', async (e) => {
    const item = e.target.closest('.pop-item');
    if (!item) return;
    e.stopPropagation(); // 气泡自身的监听已处理这条点击，不必再冒到 document 走外点兜底
    closePop();
    if (item.dataset.act === 'like') await handleLike(pid);
    else openCbar(pid, null);
  });
}

async function handleLike(pid) {
  const p = state.posts.find((x) => x.id === pid);
  if (!p) return;
  const clientKey = getClientKey();
  const liked = p.likes.some((l) => l.client_key === clientKey);
  if (!liked && !getNick()) {
    // 首次点赞需要昵称：直接展开同一张表单补填，不再单独弹窗
    openCbar(pid, null, null, 'like');
    return;
  }
  try {
    if (liked) {
      const r = await api(`/api/posts/${pid}/like?clientKey=${encodeURIComponent(clientKey)}`, { method: 'DELETE' });
      p.likes = r.likes;
    } else {
      const r = await api(`/api/posts/${pid}/like`, { method: 'POST', body: { clientKey, name: getNick() } });
      p.likes = r.likes;
    }
    refreshPost(pid);
  } catch (e) { alertDlg(e.message); }
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

function openCbar(pid, replyTo, editTarget, mode) {
  // 切到另一条朋友圈前，先清掉上一条临时补的 acts，避免留下空灰盒
  if (state.tmpActs) { state.tmpActs.remove(); state.tmpActs = null; }
  if (!mountCbar(pid)) return; // 目标帖子不在当前页 DOM 中，放弃弹出
  state.activePid = pid;
  state.replyTo = replyTo || null;
  state.editingCid = editTarget ? editTarget.id : null;
  state.cbarMode = mode || 'comment';
  const input = $('#cbarInput');
  const send = $('#cbarSend');
  const isLike = state.cbarMode === 'like';
  $('#cName').value = getNick();
  $('#cSite').value = getSite();
  if (isLike) {
    input.placeholder = '（点赞无需填写内容）';
    input.value = '';
    send.textContent = '点赞';
  } else if (editTarget) {
    input.placeholder = '编辑评论';
    input.value = editTarget.content;
    send.textContent = '更新评论';
  } else {
    input.placeholder = replyTo ? `回复 ${replyTo.name}：` : '写评论…';
    input.value = '';
    send.textContent = '发送';
  }
  send.classList.toggle('on', isLike || Boolean(editTarget) || input.value.trim().length > 0);
  cbarErr('');
  hideEmoji();   // 气泡菜单里的「评论」会 stopPropagation 绕过外点兜底，这里保证换目标时面板必收
  $('#cbar').classList.add('show');
  autoGrowCbar();                    // 编辑模式下带出原文时要立刻撑到对应高度
  // 老访客身份已回填，光标直接进内容框；首次使用才停在昵称框
  const focusEl = !isLike || getNick() ? input : $('#cName');
  // focus 同步做：iOS 要求在用户手势的同一任务里，包进 setTimeout 可能导致键盘不弹
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
  state.cbarMode = 'comment';
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

/* 发送按钮与回车统一入口：点赞模式下走 submitLike，其余走 sendComment */
function onSend() {
  if (state.cbarMode === 'like') return submitLike();
  return sendComment();
}

/* 借同一张表单补填昵称后完成点赞 */
async function submitLike() {
  const pid = state.activePid;
  if (!pid) return;
  const id = readIdentity();
  if (!id.name) { cbarErr('请先填写昵称'); $('#cName').focus(); return; }
  saveIdentity(id);
  try {
    const r = await api(`/api/posts/${pid}/like`, {
      method: 'POST', body: { clientKey: getClientKey(), name: id.name },
    });
    const p = state.posts.find((x) => x.id === pid);
    if (p) p.likes = r.likes;
    closeCbar();
    refreshPost(pid);
  } catch (e) { cbarErr(e.message); }
}

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

  // 气泡内部点击已在自身监听处理；点其他区域关闭气泡
  if (!t.closest('.pop')) closePop();

  // 图片 → 查看大图
  const img = t.closest('.p-grid img, .p-single img');
  if (img) {
    const p = state.posts.find((x) => x.id === img.dataset.pid);
    if (p) {
      state.viewer = { imgs: p.images, i: Number(img.dataset.idx) || 0 };
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
  if (cell) { e.stopPropagation(); insertEmoji(cell.textContent); }
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
$('#vImg').addEventListener('click', () => {
  // 刚横向滑完时浏览器可能补发一次 click，别把"滑动翻页"误判成"点图关闭"
  if (Date.now() - state.swipeGuard < 600) return;
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
  await loadSettings();
  checkAdmin();
  loadLinks();
  try {
    await loadPosts(1);
  } catch (e) {
    $('#feed').innerHTML = `<div class="loading">加载失败：${esc(e.message)}</div>`;
  }
})();
