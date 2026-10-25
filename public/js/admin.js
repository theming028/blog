/* 朝夕光年 · 管理后台：内容 / 评论（审核+批量删除） / 网上邻居 / 设置（签名+封面+头像+昵称） */
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

const STATUS_LABEL = { visible: '已显示', pending: '待审核', hidden: '已屏蔽' };
const STATUS_CLS = { visible: 'pub', pending: 'warn', hidden: 'off' };

/* ============ 视图切换 ============ */
const VIEW_TITLE = { content: '内容管理', comments: '评论管理', links: '网上邻居', settings: '设置' };
function switchView(view) {
  if (!VIEW_TITLE[view]) view = 'content';
  $('#viewContent').hidden = view !== 'content';
  $('#viewComments').hidden = view !== 'comments';
  $('#viewLinks').hidden = view !== 'links';
  $('#viewSettings').hidden = view !== 'settings';
  $$('.adm-nav-item[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#pageTitle').textContent = VIEW_TITLE[view];
  document.title = `${VIEW_TITLE[view]} · 朝夕光年后台`;
  if (view === 'comments') loadComments();
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

/* 设置表单的唯一填充口：初次加载与保存成功后各调一次。
   不在视图切换时调用——那会冲掉用户写到一半的昵称/签名。 */
function renderSettings() {
  $('#pickCoverImg').src = settings.cover;
  $('#pickAvatarImg').src = settings.avatar;
  $('#setNickInput').value = settings.nickname || '';
  $('#signInput').value = settings.sign || '';
  // 只有明确存过 'off' 才算关；老数据没这个键时按服务端下发的默认值（开）走
  $('#setSnow').checked = settings.snow !== 'off';
}

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
    const text = p.content || (p.images.length ? `[图片] × ${p.images.length}` : '（空内容）');
    const loc = p.location ? `<div class="loc">📍 ${esc(p.location)}</div>` : '';
    return `<tr data-pid="${p.id}">
      <td class="c-content"><div class="txt${p.content ? '' : ' empty'}">${esc(text)}</div>${loc}</td>
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
async function pickAndPreview(input, imgId, key) {
  const file = input.files && input.files[0]; input.value = ''; if (!file) return;
  // 这里只落到本地 settings 与预览图上，不发 PUT：四件事必须一起保存，
  // 免得"换完图以为已经好了"——保存键就摆在同一个表单里。
  try { const r = await uploadImageFile(file); settings[key] = r.url; $(`#${imgId}`).src = r.url; }
  catch (e) { alertDlg(e.message || '上传失败'); }
}
$('#pickCover').addEventListener('click', () => $('#fileCover').click());
$('#fileCover').addEventListener('change', (e) => pickAndPreview(e.target, 'pickCoverImg', 'cover'));
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
      // 五项一次写完：合并成一个设置页之后再拆开保存就白合了
      body: { cover: settings.cover, avatar: settings.avatar, nickname: nick, sign: $('#signInput').value.trim(), snow: $('#setSnow').checked ? 'on' : 'off' },
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
