/* 朝夕光年 · 管理后台：内容 / 评论（审核+批量删除） / 访客记录 / 网上邻居 / 设置（签名+封面+头像+昵称） */
'use strict';

const ICON_IMG = '<svg viewBox="0 0 24 24"><path d="M21 3H3a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1zM8.5 9A1.5 1.5 0 1 1 7 10.5A1.5 1.5 0 0 1 8.5 9zM5 18l4.5-6 3 4 2.5-3 4 5z"/></svg>';
// 默认值只在 server.js 一处维护。这里不再抄一份，避免改封面时四处漏改。
// settingsOk 用于：设置接口取数失败时禁止保存，否则会把空值写回去覆盖真实配置。
let settings = {};
let settingsOk = false;
let posts = [];
let cmtFilter = 'all';
let cmtSelected = new Set();
let links = [];
let editingLinkId = null;
let lastCmtTotal = null;
let pollTimer = null;

/* 访客记录视图的状态 */
let visitRange = 'today';
let visitQ = '';
let visitHideAdmin = false;
let visitPage = 1;
let visitSelected = new Set();
let visitRows = [];        // 当前页的会话，展开时间线时直接从这儿取，不再请求
let visitLabels = {};      // 动作类型的中文名由服务端下发，前后端只维护一份白名单
let visitOnline = -1;      // 上一次轮询的"正在浏览"人数，用来判断要不要整表重取

const STATUS_LABEL = { visible: '已显示', pending: '待审核', hidden: '已屏蔽' };
const STATUS_CLS = { visible: 'pub', pending: 'warn', hidden: 'off' };

/* ============ 视图切换 ============ */
const VIEW_TITLE = { content: '内容管理', comments: '评论管理', visits: '访客记录', links: '网上邻居', settings: '设置' };
function switchView(view) {
  if (!VIEW_TITLE[view]) view = 'content';
  $('#viewContent').hidden = view !== 'content';
  $('#viewComments').hidden = view !== 'comments';
  $('#viewVisits').hidden = view !== 'visits';
  $('#viewLinks').hidden = view !== 'links';
  $('#viewSettings').hidden = view !== 'settings';
  $$('.adm-nav-item[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#pageTitle').textContent = VIEW_TITLE[view];
  document.title = `${VIEW_TITLE[view]} · 朝夕光年后台`;
  if (view === 'comments') loadComments();
  if (view === 'visits') loadVisits();
  if (view === 'links') loadLinks();
  // 注意：进设置视图时不重填表单。切走再切回就把半截昵称/签名冲掉，等于"隐式丢弃输入"；
  // 值已经在 input 里，保持原样才对，换过的图也一样留在 settings 草稿里等保存。
  $('#side').classList.remove('open');
}
$$('.adm-nav-item[data-view]').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));

/* ============ 内容管理 ============ */
async function load() {
  try {
    const [pr, sr] = await Promise.all([
      api('/api/posts?drafts=1'),
      api('/api/settings').then((r) => { settingsOk = true; return r; }).catch(() => ({ settings: null })),
    ]);
    posts = pr.posts;
    if (sr.settings) settings = { ...settings, ...sr.settings };
  } catch (e) {
    $('#admTbody').innerHTML = `<tr><td colspan="6"><div class="adm-empty">加载失败：${esc(e.message)}</div></td></tr>`;
    return;
  }
  renderSettings();
  renderStats();
  renderTable();
  startPolling();
}

/* 预览框比例、裁剪框比例、提示文案三者同源，都读 Crop.SPECS：
   改槽位尺寸时只有 SPECS 一处要动，不会出现「裁出来 19:7、预览还是 20:7」。 */
function applyMediaSpecs() {
  if (!window.Crop) return;
  const c = Crop.SPECS.cover, a = Crop.SPECS.avatar;
  $('#pickCover').style.aspectRatio = c.w + ' / ' + c.h;
  $('#pickAvatar').style.aspectRatio = a.w + ' / ' + a.h;
  $('#coverSpecHint').textContent = '最佳 ' + c.w + '×' + c.h + '（槽位 ' + c.slot + ' 的 2 倍）· 上传后可裁剪';
  $('#avatarSpecHint').textContent = '正方形 · 最佳 ' + a.w + '×' + a.h;
}
const FX_VALUES = ['snow', 'blossom', 'off'];
function fxValue() {
  const el = document.querySelector('#fxSeg input:checked');
  return el && FX_VALUES.indexOf(el.value) >= 0 ? el.value : 'snow';
}
/* 选中态画在 label 上（radio 本体被隐藏了），change 时同步一次 */
function paintFx() {
  $$('#fxSeg .adm-seg-item').forEach((l) => l.classList.toggle('on', !!l.querySelector('input').checked));
}

/* 设置表单的唯一填充口：初次加载与保存成功后各调一次。
   不在视图切换时调用——那会冲掉用户写到一半的昵称/签名。 */
function renderSettings() {
  applyMediaSpecs();
  $('#pickCoverImg').src = settings.cover;
  $('#pickAvatarImg').src = settings.avatar;
  $('#setNickInput').value = settings.nickname || '';
  $('#signInput').value = settings.sign || '';
  // 特效三选一；服务端已把旧的 snow:'on|off' 迁移成 fx，这里只认 fx
  const want = FX_VALUES.indexOf(settings.fx) >= 0 ? settings.fx : 'snow';
  const r = document.querySelector('#fxSeg input[value="' + want + '"]');
  if (r) r.checked = true;
  paintFx();
  // 播放器开关 + 歌单草稿：只在初次加载与保存成功后重置，切视图不动（同昵称/签名的处理口径）
  const pr = document.querySelector('#playerSeg input[value="' + (settings.player === 'on' ? 'on' : 'off') + '"]');
  if (pr) pr.checked = true;
  paintPlayer();
  plDraft = (Array.isArray(settings.playlist) ? settings.playlist : []).map((t) => ({ ...t }));
  plCancelEdit();
  renderPlaylist();
}
$('#fxSeg').addEventListener('change', paintFx);

/* ============ 歌单编辑（草稿态，随「保存设置」一次写回） ============ */
let plDraft = [];
let plEditing = null;   // 正在编辑的条目 id；null 表示新增

function playerValue() {
  const el = document.querySelector('#playerSeg input:checked');
  return el ? el.value : 'off';
}
function paintPlayer() {
  $$('#playerSeg .adm-seg-item').forEach((l) => l.classList.toggle('on', !!l.querySelector('input').checked));
}
$('#playerSeg').addEventListener('change', paintPlayer);

/* 只显示主机名：让管理员一眼看出哪首歌依赖别人的服务器（外链失效是这类播放器最常见的故障） */
function plHost(u) { try { return new URL(u).host; } catch (e) { return '—'; } }

function renderPlaylist() {
  const box = $('#plList');
  $('#plCount').textContent = `已添加 ${plDraft.length} 首 · 最多 50 首 · 只支持 https 直链，本站不存放音频文件`;
  if (!plDraft.length) {
    box.innerHTML = '<div class="pl-empty">歌单为空，前台不会出现播放器</div>';
    return;
  }
  box.innerHTML = plDraft.map((t, i) => `
    <div class="pl-row${plEditing === t.id ? ' editing' : ''}" data-id="${esc(t.id)}">
      <div class="pl-info">
        <div class="pl-name">${esc(t.title)}</div>
        <div class="pl-sub">${esc(t.artist || '未填艺人')} · ${esc(plHost(t.url))}${t.cover ? ' · 有封面' : ''}</div>
      </div>
      <div class="pl-ops">
        <button class="adm-btn sm" data-pl="up" type="button" ${i === 0 ? 'disabled' : ''} title="上移">↑</button>
        <button class="adm-btn sm" data-pl="down" type="button" ${i === plDraft.length - 1 ? 'disabled' : ''} title="下移">↓</button>
        <button class="adm-btn sm" data-pl="edit" type="button">编辑</button>
        <button class="adm-btn sm danger" data-pl="del" type="button">删除</button>
      </div>
    </div>`).join('');
}

$('#plList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-pl]');
  if (!btn) return;
  const row = btn.closest('.pl-row');
  const id = row && row.dataset.id;
  const i = plDraft.findIndex((t) => t.id === id);
  if (i < 0) return;
  const op = btn.dataset.pl;
  if (op === 'up' && i > 0) { [plDraft[i - 1], plDraft[i]] = [plDraft[i], plDraft[i - 1]]; }
  else if (op === 'down' && i < plDraft.length - 1) { [plDraft[i + 1], plDraft[i]] = [plDraft[i], plDraft[i + 1]]; }
  else if (op === 'del') {
    // confirmDlg 是异步的，必须 await：不 await 时它返回 Promise（恒为真），确认框等于没做
    if (!await confirmDlg('删除《' + plDraft[i].title + '》？保存设置后生效', '删除')) return;
    plDraft.splice(i, 1);
    if (plEditing === id) plCancelEdit();
  } else if (op === 'edit') {
    plEditing = id;
    const t = plDraft[i];
    $('#plTitle').value = t.title || ''; $('#plArtist').value = t.artist || '';
    $('#plUrl').value = t.url || ''; $('#plCover').value = t.cover || '';
    $('#plAppend').textContent = '保存修改';
    $('#plCancel').hidden = false;
    $('#plTitle').focus();
  }
  renderPlaylist();
});

function plCancelEdit() {
  plEditing = null;
  ['plTitle', 'plArtist', 'plUrl', 'plCover'].forEach((k) => { $('#' + k).value = ''; });
  $('#plAppend').textContent = '添加歌曲';
  $('#plCancel').hidden = true;
}
$('#plCancel').addEventListener('click', () => { plCancelEdit(); renderPlaylist(); });

$('#plAppend').addEventListener('click', () => {
  const title = $('#plTitle').value.trim();
  const url = $('#plUrl').value.trim();
  if (!title) { alertDlg('歌曲名称不能为空'); $('#plTitle').focus(); return; }
  if (!/^https?:\/\//i.test(url)) { alertDlg('音频地址必须是 http(s) 直链'); $('#plUrl').focus(); return; }
  const entry = {
    id: plEditing || ('song_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
    title: title.slice(0, 60), artist: $('#plArtist').value.trim().slice(0, 40),
    url: url.slice(0, 2048), cover: $('#plCover').value.trim().slice(0, 2048) || null,
  };
  if (plEditing) {
    const i = plDraft.findIndex((t) => t.id === plEditing);
    if (i >= 0) plDraft[i] = entry;
  } else {
    if (plDraft.length >= 50) { alertDlg('歌单最多 50 首'); return; }
    plDraft.push(entry);
  }
  plCancelEdit();
  renderPlaylist();
  showToast('已加入草稿，点「保存设置」后生效');
});

function renderStats() {
  const total = posts.length;
  const pub = posts.filter((p) => p.status === 'published').length;
  const draft = total - pub;
  const inter = posts.reduce((s, p) => s + p.likes.length + p.comments.length, 0);
  const cards = [
    { cls: 'blue', num: total, lbl: '内容总数', icon: '<path d="M4 5h16v2H4zm0 6h16v2H4zm0 6h10v2H4z"/>' },
    { cls: 'green', num: pub, lbl: '已发布', icon: '<path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/>' },
    { cls: 'orange', num: draft, lbl: '草稿', icon: '<path d="M3 17.2V21h3.8L17.9 9.9l-3.8-3.8zM20.7 7.1a1 1 0 0 0 0-1.4l-2.4-2.4a1 1 0 0 0-1.4 0l-1.8 1.8 3.8 3.8z"/>' },
    { cls: 'purple', num: inter, lbl: '总互动（赞+评）', icon: '<path d="M12 21s-7.5-4.7-10-9.3C.5 8.6 2.4 5 5.8 5c2 0 3.4 1 4.2 2.4h4c.8-1.4 2.2-2.4 4.2-2.4 3.4 0 5.3 3.6 3.8 6.7C19.5 16.3 12 21 12 21z"/>' },
  ];
  $('#admStats').innerHTML = cards.map((c) => `
    <div class="adm-stat"><div class="ico ${c.cls}"><svg viewBox="0 0 24 24">${c.icon}</svg></div>
      <div><div class="num">${c.num}</div><div class="lbl">${c.lbl}</div></div></div>`).join('');
}

function renderTable() {
  const tb = $('#admTbody');
  $('#admCount').textContent = `共 ${posts.length} 条`;
  if (!posts.length) { tb.innerHTML = '<tr><td colspan="6"><div class="adm-empty">还没有内容，点右上角「新建内容」发布第一条吧</div></td></tr>'; return; }
  tb.innerHTML = posts.map((p) => {
    const pub = p.status === 'published';
    const thumb = p.images.length ? `<img class="adm-thumb" src="/api/images/${encodeURIComponent(p.images[0])}" alt="">` : `<div class="adm-thumb-ph">${ICON_IMG}</div>`;
    const media = p.media || [];
    const text = p.content || (p.images.length ? `[图片] × ${p.images.length}` : media.length ? `[音视频] × ${media.length}` : '（空内容）');
    // 音视频只列类型与是否自动播放：地址是外链，一眼能看出哪条依赖别人的服务器
    const mediaTag = media.length
      ? `<div class="loc">${media.map((m) => `${m.kind === 'audio' ? '🎵 音频' : '🎬 视频'}${m.autoplay ? '·自动播放' : ''}`).join(' ')}</div>`
      : '';
    const loc = p.location ? `<div class="loc">📍 ${esc(p.location)}</div>` : '';
    return `<tr data-pid="${p.id}">
      <td class="c-content"><div class="txt${p.content ? '' : ' empty'}">${esc(text)}</div>${mediaTag}${loc}</td>
      <td class="hide-sm">${thumb}</td>
      <td class="c-time hide-sm">${fmtTime(p.created_at)}</td>
      <td><span class="adm-badge ${pub ? 'pub' : 'draft'}">${pub ? '已发布' : '草稿'}</span></td>
      <td class="c-inter hide-sm">${p.likes.length} 赞 · ${p.comments.length} 评</td>
      <td style="text-align:right"><span class="adm-act" data-op="toggle">${pub ? '下架' : '发布'}</span><span class="adm-act" data-op="edit">编辑</span><span class="adm-act danger" data-op="del">删除</span></td>
    </tr>`;
  }).join('');
}

$('#admTbody').addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-pid]'); if (!row) return;
  const pid = row.dataset.pid; const p = posts.find((x) => x.id === pid); const op = e.target.closest('.adm-act');
  if (op) {
    e.stopPropagation();
    try {
      if (op.dataset.op === 'toggle') { const next = p.status === 'published' ? 'draft' : 'published'; await api(`/api/posts/${pid}`, { method: 'PUT', body: { status: next } }); p.status = next; renderStats(); renderTable(); }
      else if (op.dataset.op === 'edit') location.href = `/edit?id=${encodeURIComponent(pid)}`;
      else if (op.dataset.op === 'del') { const ok = await confirmDlg('删除后该条内容的评论和点赞都会一并删除，确定删除吗？', '删除'); if (!ok) return; await api(`/api/posts/${pid}`, { method: 'DELETE' }); posts = posts.filter((x) => x.id !== pid); renderStats(); renderTable(); }
    } catch (err) { alertDlg(err.message); }
    return;
  }
  location.href = `/edit?id=${encodeURIComponent(pid)}`;
});

/* ============ 评论管理 ============ */
async function loadComments() {
  try {
    const [st, list] = await Promise.all([api('/api/comments/stats'), api(`/api/comments?status=${cmtFilter}&limit=100`)]);
    renderCmtStats(st.stats);
    renderCmtTable(list);
    updateBadge(st.stats.pending);
    if (lastCmtTotal === null) lastCmtTotal = st.stats.total;
  } catch (e) {
    $('#cmtTbody').innerHTML = `<tr><td colspan="7"><div class="adm-empty">加载失败：${esc(e.message)}</div></td></tr>`;
  }
}

function renderCmtStats(s) {
  const cards = [
    { cls: 'blue', num: s.total, lbl: '评论总数', icon: '<path d="M12 3C6.5 3 2 6.9 2 11.7c0 2.7 1.4 5.1 3.7 6.7-.2 1-.8 2.2-1.6 3 1.7-.2 3.3-.9 4.4-1.7 1.1.3 2.3.5 3.5.5 5.5 0 10-3.9 10-8.5S17.5 3 12 3z"/>' },
    { cls: 'orange', num: s.pending, lbl: '待审核', icon: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2zm0-4h-2V7h2z"/>' },
    { cls: 'green', num: s.visible, lbl: '已显示', icon: '<path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/>' },
    { cls: 'purple', num: s.hidden, lbl: '已屏蔽', icon: '<path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92A9.9 9.9 0 0 0 22 12c-1.7-3.6-5-6.08-9-6.08-1.36 0-2.64.29-3.8.79l2.16 2.16c.54-.19 1.1-.32 1.68-.32zM2 4.27l2.8 2.8C3.4 8.3 2.26 9.9 1.5 12c1.7 3.6 5 6.08 9 6.08 1.55 0 3.03-.3 4.36-.84l3.33 3.33 1.4-1.4L3.4 2.87z"/>' },
  ];
  $('#cmtStats').innerHTML = cards.map((c) => `
    <div class="adm-stat"><div class="ico ${c.cls}"><svg viewBox="0 0 24 24">${c.icon}</svg></div>
      <div><div class="num">${c.num}</div><div class="lbl">${c.lbl}</div></div></div>`).join('');
}

function renderCmtTable(list) {
  const tb = $('#cmtTbody');
  $('#cmtCount').textContent = `共 ${list.total} 条`;
  cmtSelected.clear(); updateBatchBtn(); $('#cmtCheckAll').checked = false;
  if (!list.comments.length) { tb.innerHTML = '<tr><td colspan="7"><div class="adm-empty">该分类下暂无评论</div></td></tr>'; return; }
  tb.innerHTML = list.comments.map((c) => {
    const reason = c.status === 'pending' && c.flag_reason ? `<div class="cmt-flag">⚠ ${esc(c.flag_reason)}</div>` : '';
    const postTitle = c.post && c.post.content ? c.post.content.slice(0, 16) : (c.post && c.post.location ? c.post.location : '（内容已删除）');
    const site = c.site ? `<div class="c-site"><a href="${esc(c.site)}" target="_blank" rel="noopener nofollow">${esc(c.site)}</a></div>` : '';
    const acts = [];
    if (c.status !== 'visible') acts.push('<span class="adm-act" data-op="approve">显示</span>');
    acts.push('<span class="adm-act danger" data-op="del">删除</span>');
    return `<tr data-cid="${c.id}">
      <td class="chk-col"><input type="checkbox" class="cmt-check"></td>
      <td class="c-content"><div class="txt">${esc(c.content)}</div>${reason}</td>
      <td>${esc(c.name)}${site}</td>
      <td class="hide-sm"><span class="c-post">${esc(postTitle)}</span></td>
      <td class="c-time hide-sm">${fmtTime(c.created_at)}</td>
      <td><span class="adm-badge ${STATUS_CLS[c.status] || 'pub'}">${STATUS_LABEL[c.status] || c.status}</span></td>
      <td style="text-align:right">${acts.join('')}</td>
    </tr>`;
  }).join('');
}

function updateBatchBtn() {
  const btn = $('#btnCmtBatchDel');
  $('#cmtSelCount').textContent = cmtSelected.size;
  btn.style.display = cmtSelected.size > 0 ? 'inline-flex' : 'none';
}

$('#cmtTbody').addEventListener('change', (e) => {
  if (!e.target.classList.contains('cmt-check')) return;
  const cid = e.target.closest('tr[data-cid]').dataset.cid;
  if (e.target.checked) cmtSelected.add(cid); else cmtSelected.delete(cid);
  updateBatchBtn();
});
$('#cmtCheckAll').addEventListener('change', (e) => {
  $$('#cmtTbody .cmt-check').forEach((cb) => {
    cb.checked = e.target.checked;
    const cid = cb.closest('tr[data-cid]').dataset.cid;
    if (e.target.checked) cmtSelected.add(cid); else cmtSelected.delete(cid);
  });
  updateBatchBtn();
});

$('#cmtTbody').addEventListener('click', async (e) => {
  const op = e.target.closest('.adm-act'); if (!op) return;
  const cid = e.target.closest('tr[data-cid]').dataset.cid;
  try {
    if (op.dataset.op === 'del') {
      const ok = await confirmDlg('确定删除这条评论吗？', '删除'); if (!ok) return;
      await api(`/api/comments/${cid}`, { method: 'DELETE' });
    } else if (op.dataset.op === 'approve') {
      await api(`/api/comments/${cid}/moderate`, { method: 'PUT', body: { status: 'visible' } });
    }
    await loadComments();
  } catch (err) { alertDlg(err.message); }
});

$('#btnCmtBatchDel').addEventListener('click', async () => {
  if (!cmtSelected.size) return;
  const ok = await confirmDlg(`确定删除选中的 ${cmtSelected.size} 条评论吗？`, '批量删除'); if (!ok) return;
  try { await api('/api/comments/batch-delete', { method: 'POST', body: { ids: [...cmtSelected] } }); await loadComments(); }
  catch (e) { alertDlg(e.message); }
});

$('#cmtFilter').addEventListener('click', (e) => {
  const tab = e.target.closest('.adm-tab'); if (!tab) return;
  $$('.adm-tab', $('#cmtFilter')).forEach((t) => t.classList.toggle('active', t === tab));
  cmtFilter = tab.dataset.status; loadComments();
});

/* ============ 访客记录 ============ */
/* 绝对时间而不是 fmtTime 的"3小时前"：访问日志是拿来对账的，
 * "昨天"这种相对说法在跨天翻页时会自相矛盾，必须落到 月-日 时:分。 */
function fmtAbs(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtClock(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const p2 = (n) => String(n).padStart(2, '0');
/* 同一天的"末次"只写时:分：整列只有 ~95px，"末次 10-26 09:39" 会被截成"末次 10-…" */
function fmtLast(startIso, lastIso) {
  const a = new Date(startIso), b = new Date(lastIso);
  if (isNaN(a) || isNaN(b)) return fmtAbs(lastIso);
  const sameDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return sameDay ? `${p2(b.getHours())}:${p2(b.getMinutes())}` : fmtAbs(lastIso);
}
function fmtDuration(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}
/* 统计卡上的紧凑版：24px 字号下"22 分 30 秒"会顶破 160px 的卡宽 */
function fmtDurShort(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60 ? (s % 60) + '秒' : ''}`;
  return `${Math.floor(m / 60)}时${m % 60}分`;
}

function visitUrl() {
  const p = new URLSearchParams();
  p.set('range', visitRange);
  p.set('limit', '20');
  p.set('page', String(visitPage));
  if (visitQ) p.set('q', visitQ);
  if (visitHideAdmin) p.set('hideAdmin', '1');
  return '/api/visits?' + p.toString();
}

async function loadVisits() {
  try {
    const [st, data] = await Promise.all([api('/api/visits/stats'), api(visitUrl())]);
    visitLabels = data.labels || visitLabels;
    renderVisitStats(st);
    renderVisitTable(data);
    $('#visitNote').textContent = `记录内容：IP、省市归属、设备与浏览器、进入/离开时间、停留时长与行为动作（浏览、阅读、点赞、评论、看大图、点友链、翻页）。`
      + `自动保留最近 ${data.retention.days} 天，超出后由服务端滚动清理；标为「我自己」的是你登录后在前台产生的访问，可用上方开关隐藏。`;
  } catch (e) {
    $('#visitTbody').innerHTML = `<tr><td colspan="7"><div class="adm-empty">加载失败：${esc(e.message)}</div></td></tr>`;
  }
}

function renderVisitStats(st) {
  /* 四张卡并排时每张只有 ~210px、文字列 ~115px，副行必须短：
   * 写"7 个 IP · 26 次浏览"会被省略号吃掉后半，等于没写。 */
  const cards = [
    { num: st.sessions.today, lbl: '今日访问', sub: `IP ${st.ips.today} · PV ${st.pvToday}`, cls: 'blue',
      icon: '<path d="M12 5c-4.4 0-8.2 2.7-9.5 6C3.8 14.3 7.6 17 12 17s8.2-2.7 9.5-6C20.2 7.7 16.4 5 12 5zm0 9.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z"/>' },
    { num: st.online, lbl: '正在浏览', sub: '2 分钟内有心跳', cls: 'green',
      icon: '<path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z"/>' },
    { num: fmtDurShort(st.avgDuration.today), lbl: '今日平均停留', sub: `7 天 ${fmtDurShort(st.avgDuration.week)}`, sm: true, cls: 'orange',
      icon: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10.6V6h-2v7.4l5.2 3.1 1-1.7z"/>' },
    { num: st.sessions.week, lbl: '近 7 天访问', sub: `IP ${st.ips.week} · 30 天 ${st.sessions.month}`, cls: 'purple',
      icon: '<path d="M4 5h16v3H4zm0 5.5h16V22H4zM7 9h2v2H7zm4 0h2v2h-2zm-4 4h2v2H7zm4 0h2v2h-2zm-4 4h2v2H7z"/>' },
  ];
  $('#visitStats').innerHTML = cards.map((c) => `
    <div class="adm-stat"><div class="ico ${c.cls}"><svg viewBox="0 0 24 24">${c.icon}</svg></div>
      <div><div class="num${c.sm ? ' sm' : ''}">${c.num}</div><div class="lbl">${c.lbl}</div><div class="sub">${c.sub}</div></div></div>`).join('');
  // 侧栏徽章只做一件事：告诉后台"此刻有人在读"，所以是绿色的在线数而不是待办数
  const b = $('#navVisitBadge');
  visitOnline = st.online;
  if (st.online > 0) { b.textContent = st.online > 99 ? '99+' : st.online; b.classList.add('live'); b.style.display = 'inline-flex'; }
  else { b.style.display = 'none'; }
}

function geoCell(s) {
  const geo = s.geo_label || '<span class="v-unknown">归属地未知</span>';
  const tag = s.bot ? '<span class="adm-badge off">机器人</span>'
    : s.admin ? '<span class="adm-badge warn">我自己</span>' : '';
  const isp = s.geo_isp ? `<div class="loc">${esc(s.geo_isp)}</div>` : '';
  // 列宽被 colgroup 钉死后长 IP（尤其 IPv6）会省略号，完整值必须能从 title 拿到
  return `<div class="v-ip mono" title="${esc(s.ip || '')}">${esc(s.ip || '未知')}${tag}</div>`
    + `<div class="v-geo" title="${esc(s.geo_label || '')}">${geo}</div>${isp}`;
}

function deviceCell(s) {
  const line = `${s.device || '其它'} · ${s.browser || '未知'}`;
  // 来源单独一行：和 iOS 挤在同一行时，"iOS 来自 mp.weixin.qq.com" 必然被省略号截成半截域名
  const ref = s.referrer ? `<div class="loc v-ref" title="${esc(s.referrer)}">来自 ${esc(hostOf(s.referrer))}</div>` : '';
  return `<div title="${esc(line)} / ${esc(s.os || '')}">${esc(line)}</div><div class="loc">${esc(s.os || '')}</div>${ref}`;
}
function hostOf(u) {
  try { return new URL(u).host; } catch (e) { return String(u).slice(0, 24); }
}

function renderVisitTable(data) {
  const tb = $('#visitTbody');
  visitRows = data.sessions;
  visitSelected.clear();
  $('#visitSelCount').textContent = '0';
  $('#btnVisitBatchDel').style.display = 'none';
  $('#visitCheckAll').checked = false;
  $('#visitCount').textContent = `共 ${data.total} 次访问 · 第 ${data.page}/${data.pages} 页`;
  if (!visitRows.length) {
    tb.innerHTML = '<tr><td colspan="7"><div class="adm-empty">这个时间窗内还没有访问记录</div></td></tr>';
    $('#visitPager').innerHTML = '';
    return;
  }
  const online = (s) => Date.now() - (Date.parse(s.last_seen || s.started_at) || 0) < 120 * 1000;
  tb.innerHTML = visitRows.map((s) => `<tr data-sid="${esc(s.id)}">
    <td class="chk-col"><input type="checkbox" class="visit-check"></td>
    <td>${geoCell(s)}</td>
    <td>${deviceCell(s)}</td>
    <td class="c-time hide-sm">${fmtAbs(s.started_at)}<div class="loc" title="末次活动 ${fmtAbs(s.last_seen)}">末次 ${fmtLast(s.started_at, s.last_seen)}</div></td>
    <td><span class="v-dur${online(s) ? ' live' : ''}">${fmtDuration(s.duration_ms)}</span>${online(s) ? '<span class="v-live-dot" title="2 分钟内还有心跳"></span>' : ''}</td>
    <td class="hide-sm">${visitActsCell(s)}</td>
    <td style="text-align:right"><span class="adm-act" data-op="toggle">明细</span><span class="adm-act danger" data-op="del">删除</span></td>
  </tr>`).join('');
  renderVisitPager(data);
}

/* 动作总数 + 读到过几条正文。窄屏这一列会随 .hide-sm 隐藏，所以信息丢了不影响主判读 */
function visitActsCell(s) {
  const acts = Number(s.event_count) || 0;
  const reads = Number(s.read_count) || 0;
  return `<div>${acts} 次</div><div class="loc">${reads ? `读 ${reads} 条` : '未读到正文'}</div>`;
}

function renderVisitPager(data) {
  const box = $('#visitPager');
  if (data.pages <= 1) { box.innerHTML = ''; return; }
  box.innerHTML = `<button class="adm-btn" data-pg="${data.page - 1}"${data.page <= 1 ? ' disabled' : ''}>上一页</button>`
    + `<span class="v-pg-cur">${data.page} / ${data.pages}</span>`
    + `<button class="adm-btn" data-pg="${data.page + 1}"${data.page >= data.pages ? ' disabled' : ''}>下一页</button>`;
}

$('#visitPager').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-pg]');
  if (!btn || btn.disabled) return;
  visitPage = Number(btn.dataset.pg);
  loadVisits();
});

/* 时间线：一条会话的全部动作。事件已随列表一起返回，展开不再发请求。 */
function timelineHtml(s) {
  const list = s.event_list || [];
  const head = `<div class="v-tl-head">
     <b>${esc(s.ip || '未知')}</b> · ${esc(s.geo_label || '归属地未知')} · ${esc(s.device)} ${esc(s.browser)} ${esc(s.os)}
     <span class="sub">进入 ${fmtAbs(s.started_at)} · 停留 ${fmtDuration(s.duration_ms)} · 浏览 ${s.pv || 0} 次</span>
   </div>`;
  const uaLine = `<div class="v-tl-ua" title="原始 User-Agent：${esc(s.ua || '')}">${esc(s.ua || '')}</div>`;
  if (!list.length) return head + '<div class="v-tl-empty">这次访问没有采集到行为动作（可能只是打开就走，或浏览器拦截了上报）</div>' + uaLine;
  const over = (Number(s.event_count) || 0) - list.length;
  const items = list.map((e) => `<li><span class="t">${fmtClock(e.created_at)}</span>`
    + `<span class="k">${esc(visitLabels[e.type] || e.type)}</span>`
    + `<span class="d" title="${esc((e.detail || '') + (e.target ? ' · ' + e.target : ''))}">${esc(e.detail || '')}</span></li>`).join('');
  return head + `<ul class="v-tl">${items}${over > 0 ? `<li class="more">另有 ${over} 条动作未显示（单会话展示上限按页拉取）</li>` : ''}</ul>`
    + `<div class="v-tl-ua" title="${esc(s.ua || '')}">${esc(s.ua || '')}</div>`;
}

$('#visitTbody').addEventListener('change', (e) => {
  if (!e.target.classList.contains('visit-check')) return;
  const sid = e.target.closest('tr[data-sid]').dataset.sid;
  if (e.target.checked) visitSelected.add(sid); else visitSelected.delete(sid);
  $('#visitSelCount').textContent = visitSelected.size;
  $('#btnVisitBatchDel').style.display = visitSelected.size > 0 ? 'inline-flex' : 'none';
});
$('#visitCheckAll').addEventListener('change', (e) => {
  $$('#visitTbody .visit-check').forEach((cb) => {
    cb.checked = e.target.checked;
    const sid = cb.closest('tr[data-sid]').dataset.sid;
    if (e.target.checked) visitSelected.add(sid); else visitSelected.delete(sid);
  });
  $('#visitSelCount').textContent = visitSelected.size;
  $('#btnVisitBatchDel').style.display = visitSelected.size > 0 ? 'inline-flex' : 'none';
});

$('#visitTbody').addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-sid]');
  if (!row) return;
  const sid = row.dataset.sid;
  const s = visitRows.find((x) => x.id === sid);
  if (!s) return;
  const op = e.target.closest('.adm-act');
  if (op && op.dataset.op === 'del') {
    e.stopPropagation();
    const ok = await confirmDlg('删除这次访问记录及其全部行为动作？', '删除');
    if (!ok) return;
    try { await api('/api/visits/batch-delete', { method: 'POST', body: { ids: [sid] } }); await loadVisits(); }
    catch (err) { alertDlg(err.message); }
    return;
  }
  if (op && op.dataset.op === 'toggle') { e.stopPropagation(); toggleTimeline(row, s); op.textContent = row.classList.contains('open') ? '收起' : '明细'; return; }
  if (op) return; // 复选框等其它控件走各自的 change，不该顺手展开
  // 点行本体也展开/收起（与内容管理"点行进编辑"的手感一致）
  toggleTimeline(row, s);
  const act = row.querySelector('.adm-act[data-op="toggle"]');
  if (act) act.textContent = row.classList.contains('open') ? '收起' : '明细';
});

/* 展开行是插在数据行之后的兄弟节点。一次只展开一条（否则表格会被撑成一长串看不完），
 * 展开态挂在数据行的 .open 上，由调用方据此改"明细/收起"的文案。 */
function toggleTimeline(row, s) {
  const next = row.nextElementSibling;
  if (next && next.classList.contains('v-detail')) {
    next.remove();
    row.classList.remove('open');
    return;
  }
  $$('#visitTbody tr.v-detail').forEach((tr) => tr.remove());
  $$('#visitTbody tr.open').forEach((tr) => tr.classList.remove('open'));
  const tr = document.createElement('tr');
  tr.className = 'v-detail';
  tr.innerHTML = `<td colspan="7">${timelineHtml(s)}</td>`;
  row.after(tr);
  row.classList.add('open');
}

$('#btnVisitBatchDel').addEventListener('click', async () => {
  if (!visitSelected.size) return;
  const ok = await confirmDlg(`确定删除选中的 ${visitSelected.size} 次访问记录及其行为动作吗？`, '批量删除');
  if (!ok) return;
  try { await api('/api/visits/batch-delete', { method: 'POST', body: { ids: [...visitSelected] } }); await loadVisits(); }
  catch (e) { alertDlg(e.message); }
});

$('#visitRange').addEventListener('click', (e) => {
  const tab = e.target.closest('.adm-tab'); if (!tab) return;
  $$('.adm-tab', $('#visitRange')).forEach((t) => t.classList.toggle('active', t === tab));
  visitRange = tab.dataset.range; visitPage = 1; loadVisits();
});

/* 搜索框输入即查：300ms 静默期，边打字边发请求会把后台打成一串查询 */
let visitQTimer = null;
$('#visitQ').addEventListener('input', (e) => {
  clearTimeout(visitQTimer);
  const v = e.target.value.trim();
  visitQTimer = setTimeout(() => { visitQ = v; visitPage = 1; loadVisits(); }, 300);
});
$('#visitHideAdmin').addEventListener('change', (e) => {
  visitHideAdmin = e.target.checked; visitPage = 1; loadVisits();
});

/* ============ 网上邻居 ============ */
async function loadLinks() {
  try {
    const r = await api('/api/links');
    links = r.links || [];
    renderLinkTable();
  } catch (e) { $('#linkTbody').innerHTML = `<tr><td colspan="5"><div class="adm-empty">加载失败：${esc(e.message)}</div></td></tr>`; }
}
function renderLinkTable() {
  const tb = $('#linkTbody');
  $('#linkCount').textContent = `共 ${links.length} 条`;
  if (!links.length) { tb.innerHTML = '<tr><td colspan="5"><div class="adm-empty">还没有友情链接，点右上角「新建链接」添加</div></td></tr>'; return; }
  tb.innerHTML = links.map((l) => `<tr data-lid="${l.id}">
    <td><b>${esc(l.name)}</b></td>
    <td><a class="c-post" href="${esc(l.url)}" target="_blank" rel="noopener nofollow">${esc(l.url)}</a></td>
    <td class="hide-sm"><span class="c-post">${esc(l.descr || '')}</span></td>
    <td class="hide-sm c-time">${l.sort || 0}</td>
    <td style="text-align:right"><span class="adm-act" data-op="edit">编辑</span><span class="adm-act danger" data-op="del">删除</span></td>
  </tr>`).join('');
}
$('#linkTbody').addEventListener('click', async (e) => {
  const op = e.target.closest('.adm-act'); if (!op) return;
  const lid = e.target.closest('tr[data-lid]').dataset.lid;
  if (op.dataset.op === 'edit') { openLinkModal(links.find((x) => x.id === lid)); }
  else if (op.dataset.op === 'del') {
    const ok = await confirmDlg('确定删除这条友情链接吗？', '删除'); if (!ok) return;
    try { await api(`/api/links/${lid}`, { method: 'DELETE' }); await loadLinks(); } catch (err) { alertDlg(err.message); }
  }
});
$('#btnNewLink').addEventListener('click', () => openLinkModal(null));
function openLinkModal(link) {
  editingLinkId = link ? link.id : null;
  $('#linkModalTitle').textContent = link ? '编辑链接' : '新建链接';
  $('#linkName').value = link ? link.name : '';
  $('#linkUrl').value = link ? link.url : '';
  $('#linkDescr').value = link ? (link.descr || '') : '';
  $('#linkSort').value = link ? (link.sort || 0) : 0;
  $('#dlgLink').classList.add('show');
}
$('#dlgLinkCancel').addEventListener('click', () => $('#dlgLink').classList.remove('show'));
$('#dlgLinkOk').addEventListener('click', async () => {
  const body = { name: $('#linkName').value.trim(), url: $('#linkUrl').value.trim(), descr: $('#linkDescr').value.trim(), sort: Number($('#linkSort').value) || 0 };
  if (!body.name) { alertDlg('请填写名称'); return; }
  if (!/^https?:\/\//i.test(body.url)) { alertDlg('链接需以 http(s):// 开头'); return; }
  try {
    if (editingLinkId) await api(`/api/links/${editingLinkId}`, { method: 'PUT', body });
    else await api('/api/links', { method: 'POST', body });
    $('#dlgLink').classList.remove('show');
    await loadLinks();
  } catch (e) { alertDlg(e.message); }
});

/* ============ 设置（签名 + 封面图 + 头像 + 昵称，合并成一个表单一次保存） ============ */
/* 只落到本地 settings 与预览图上，不发 PUT：四件事必须一起保存，
   免得"换完图以为已经好了"——保存键就摆在同一个表单里。 */
async function applyPicked(url, imgId, key) {
  settings[key] = url; $(`#${imgId}`).src = url;
}
async function pickAndPreview(input, imgId, key) {
  const file = input.files && input.files[0]; input.value = ''; if (!file) return;
  try { const r = await uploadImageFile(file); await applyPicked(r.url, imgId, key); }
  catch (e) { alertDlg(e.message || '上传失败'); }
}
/* 裁剪出来的成图已经是目标尺寸 + JPEG，不需要再过一遍前端压缩，直接上传 */
async function uploadDataUrl(dataUrl) {
  return api('/api/upload', { method: 'POST', body: { mime: 'image/jpeg', data: dataUrl.slice(dataUrl.indexOf(',') + 1) } });
}
async function pickAndCropCover(input) {
  const file = input.files && input.files[0]; input.value = ''; if (!file) return;
  if (!window.Crop) {   // 裁剪器没加载成功时退回直接上传，不要让换封面这条路整个断掉
    try { const r = await uploadImageFile(file); await applyPicked(r.url, 'pickCoverImg', 'cover'); }
    catch (e) { alertDlg(e.message || '上传失败'); }
    return;
  }
  Crop.open({
    file, spec: Crop.SPECS.cover,
    onDone: async (dataUrl) => {
      try {
        const r = await uploadDataUrl(dataUrl);
        await applyPicked(r.url, 'pickCoverImg', 'cover');
        showToast('封面已裁剪到 ' + Crop.SPECS.cover.w + '×' + Crop.SPECS.cover.h + '，点「保存设置」生效');
      } catch (e) { alertDlg(e.message || '上传失败'); }
    },
  });
}
$('#pickCover').addEventListener('click', () => $('#fileCover').click());
$('#fileCover').addEventListener('change', (e) => pickAndCropCover(e.target));
$('#pickAvatar').addEventListener('click', () => $('#fileAvatar').click());
$('#fileAvatar').addEventListener('change', (e) => pickAndPreview(e.target, 'pickAvatarImg', 'avatar'));

$('#btnSetSave').addEventListener('click', async () => {
  // 取数失败时禁止保存：否则会把空值写回去覆盖真实配置（合并前两个弹窗各自都有这道闸）
  if (!settingsOk) { alertDlg('设置未能加载，为避免把已有配置覆盖成空值，已阻止保存。请刷新页面重试'); return; }
  const nick = $('#setNickInput').value.trim();
  if (!nick) { alertDlg('昵称不能为空'); return; }
  const btn = $('#btnSetSave');
  btn.disabled = true; // 保存中禁用：连点会发两遍 PUT，第二遍带着同一份值，还会叠两个成功提示
  try {
    const r = await api('/api/settings', {
      method: 'PUT',
      // 七项一次写完：合并成一个设置页之后再拆开保存就白合了
      body: {
        cover: settings.cover, avatar: settings.avatar, nickname: nick, sign: $('#signInput').value.trim(),
        fx: fxValue(), player: playerValue(),
        // 送草稿而不是送 settings：编辑还没保存前，页面上看到的就该是即将生效的内容
        playlist: plDraft,
      },
    });
    settings = r.settings; // 服务端回的是合并后的完整值，不再需要本地默认值兜底
    renderSettings();
    showToast('设置已保存');
  } catch (e) { alertDlg(e.message || '保存失败'); }
  finally { btn.disabled = false; }
});

/* ============ 新评论轮询提示 ============ */
function updateBadge(pending) {
  const b = $('#navCmtBadge');
  if (pending > 0) { b.textContent = pending > 99 ? '99+' : pending; b.style.display = 'inline-flex'; } else b.style.display = 'none';
}
async function poll() {
  try {
    const { stats } = await api('/api/comments/stats');
    updateBadge(stats.pending);
    if (lastCmtTotal !== null && stats.total > lastCmtTotal) {
      const delta = stats.total - lastCmtTotal;
      showToast(stats.pending > 0 ? `有 ${delta} 条新评论，${stats.pending} 条待审核` : `有 ${delta} 条新评论`);
    }
    lastCmtTotal = stats.total;
    if (!$('#viewComments').hidden) { const list = await api(`/api/comments?status=${cmtFilter}&limit=100`); renderCmtStats(stats); renderCmtTable(list); }
    /* 访客视图开着就顺带刷新（含正在浏览的人数）。
     * 不弹 toast："有人来了"不是需要处理的告警，一天几十次会把提示刷成噪音。
     * 只重建统计卡与侧栏在线数，不重建表格——否则正要点展开的行会被换掉，勾选也会丢。 */
    if (!$('#viewVisits').hidden) {
      const vst = await api('/api/visits/stats');
      renderVisitStats(vst);
      if (visitOnline !== vst.online) { visitOnline = vst.online; loadVisits(); }
    }
  } catch (e) { /* 静默 */ }
}
function startPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = setInterval(poll, 25000); }

/* ============ 退出 & 菜单 ============ */
$('#btnLogout').addEventListener('click', async () => { try { await fetch('/api/logout', { method: 'POST' }); } catch (e) {} location.href = '/login'; });
$('#btnMenu').addEventListener('click', () => $('#side').classList.toggle('open'));

load();

/* 支持从其它页面用 #hash 直达视图。旧的 #sign / #settings 两个"开弹窗"入口
   现在都指向同一个设置视图，别删：外部可能还留着这两个书签链接。 */
(function routeHash() {
  const h = (location.hash || '').replace('#', '');
  if (h === 'sign' || h === 'settings') switchView('settings');
  else if (VIEW_TITLE[h]) switchView(h);
})();
