/* 发布/编辑页：文本、位置、图片上传（前端压缩）、音视频外链、发表/草稿/删除 */
'use strict';

const params = new URLSearchParams(location.search);
const editId = params.get('id');
let images = [];        // 已上传图片 id
let saving = false;

/* ---------- textarea 随内容自适应增高 ---------- */
function autoGrow() {
  const ta = $('#eText');
  ta.style.height = 'auto';
  const min = parseFloat(getComputedStyle(ta).minHeight) || 240;
  ta.style.height = Math.max(ta.scrollHeight, min) + 'px';
}
$('#eText').addEventListener('input', autoGrow);

/* ---------- 图片渲染 ---------- */
function renderPhotos() {
  const box = $('#ePhotos');
  box.innerHTML = images.map((id) => `
    <div class="adm-ph" data-id="${esc(id)}">
      <img src="/api/images/${encodeURIComponent(id)}" alt="">
      <div class="ph-del" title="移除">×</div>
    </div>`).join('');
  if (images.length < 9) {
    box.insertAdjacentHTML('beforeend', '<div class="adm-add" id="eAdd">+<span>添加</span></div>');
  }
}

$('#ePhotos').addEventListener('click', (e) => {
  if (e.target.closest('#eAdd')) { $('#fileInput').click(); return; }
  const del = e.target.closest('.ph-del');
  if (del) {
    const id = del.parentElement.dataset.id;
    images = images.filter((x) => x !== id);
    renderPhotos();
  }
});

/* ---------- 图片上传（压缩逻辑在 common.js） ---------- */
$('#fileInput').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;
  const room = 9 - images.length;
  if (files.length > room) {
    alertDlg(`最多 9 张图片，还可以添加 ${room} 张`);
  }
  const list = files.slice(0, room);
  try {
    for (let i = 0; i < list.length; i++) {
      $('#eUp').textContent = `正在上传第 ${i + 1}/${list.length} 张…`;
      const r = await uploadImageFile(list[i]);
      images.push(r.id);
      renderPhotos();
    }
    $('#eUp').textContent = '';
  } catch (err) {
    $('#eUp').textContent = '';
    alertDlg(err.message || '上传失败');
  }
});

/* ---------- 音视频（外链，本站不托管媒体文件） ---------- */
const MEDIA_MAX = 3;
let media = [];       // { kind, url, poster, autoplay }

/* 与 server.js 的 safeHttpUrl 同一套判断。刻意在前端也做一遍：
   服务端对非法条目是"静默丢弃"（不该让一个贴错的链接挡住整条发布），
   但对正在编辑的人来说，"我明明加了一段视频保存后没了"更难理解，
   所以这里把问题在提交前就指名道姓地报出来。 */
function urlOk(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v || /\s/.test(v)) return false;
  let u;
  try { u = new URL(/^https?:\/\//i.test(v) ? v : 'https://' + v); } catch (e) { return false; }
  return (u.protocol === 'http:' || u.protocol === 'https:') && /\./.test(u.hostname);
}

function renderMedia() {
  const box = $('#eMedia');
  box.innerHTML = media.map((m, i) => `
    <div class="adm-media-item" data-i="${i}">
      <div class="adm-media-head"><span>${m.kind === 'video' ? '视频' : '音频'} ${i + 1}</span>
        <span class="adm-act danger" data-op="del">移除</span></div>
      <div class="adm-field">
        <label>地址 <span class="hint">${m.kind === 'video' ? 'https://…/a.mp4' : 'https://…/a.mp3'}</span></label>
        <input class="adm-input" data-k="url" type="text" value="${esc(m.url || '')}" placeholder="https://">
      </div>
      ${m.kind === 'video' ? `<div class="adm-field">
        <label>封面图 <span class="hint">选填；不填时视频区域是黑的</span></label>
        <input class="adm-input" data-k="poster" type="text" value="${esc(m.poster || '')}" placeholder="https://…/cover.jpg">
      </div>` : ''}
      ${m.kind === 'video' ? `<div class="adm-field">
        <label class="adm-media-auto"><input type="checkbox" data-k="autoplay" ${m.autoplay ? 'checked' : ''}> 自动播放 <span class="hint">会静音起播，且只在滚到可见时开始</span></label>
      </div>` : `<div class="adm-field">
        <label class="adm-media-auto"><input type="checkbox" data-k="autoplay" disabled> 自动播放 <span class="hint">音频不支持：浏览器只允许静音自动播放，那样就只剩进度条在走、完全没声</span></label>
      </div>`}
    </div>`).join('');
  const full = media.length >= MEDIA_MAX;
  $('#btnAddVideo').disabled = full;
  $('#btnAddAudio').disabled = full;
  $('#btnAddVideo').title = $('#btnAddAudio').title = full ? `最多 ${MEDIA_MAX} 段` : '';
}

function addMedia(kind) {
  if (media.length >= MEDIA_MAX) { alertDlg(`最多 ${MEDIA_MAX} 段音视频`); return; }
  media.push({ kind, url: '', poster: '', autoplay: false });
  renderMedia();
  // 新加的一行直接聚焦地址框，省一次点击
  const rows = $$('#eMedia .adm-media-item');
  const last = rows[rows.length - 1];
  if (last) last.querySelector('[data-k="url"]').focus();
}
$('#btnAddVideo').addEventListener('click', () => addMedia('video'));
$('#btnAddAudio').addEventListener('click', () => addMedia('audio'));

$('#eMedia').addEventListener('input', (e) => {
  const item = e.target.closest('.adm-media-item'); if (!item) return;
  const k = e.target.dataset.k; if (!k) return;
  const m = media[Number(item.dataset.i)]; if (!m) return;
  if (k === 'autoplay') return;                 // 复选框走 change，不在 input 里读
  m[k] = e.target.value;
});
$('#eMedia').addEventListener('change', (e) => {
  const item = e.target.closest('.adm-media-item'); if (!item) return;
  const k = e.target.dataset.k;
  const m = media[Number(item.dataset.i)]; if (!m || k !== 'autoplay') return;
  m.autoplay = e.target.checked;
});
$('#eMedia').addEventListener('click', (e) => {
  const op = e.target.closest('.adm-act'); if (!op || op.dataset.op !== 'del') return;
  const item = e.target.closest('.adm-media-item');
  media.splice(Number(item.dataset.i), 1);
  renderMedia();
});

/* 提交前清洗 + 校验；返回 null 表示有错且已提示。
   strict=true（发表）：空地址行、非法地址都拦下来，让用户当场改。
   strict=false（存草稿）：只跳过空行并明确告知——留了一行没填完不该让草稿也存不了，
   但"非法地址"仍然要拦：那是会静默变成"保存后视频没了"的那类问题。 */
function mediaToSave(strict) {
  const out = [];
  let skipped = 0;
  for (let i = 0; i < media.length; i++) {
    const m = media[i];
    const url = String(m.url || '').trim();
    if (!url) {
      if (strict) { alertDlg(`第 ${i + 1} 段${m.kind === 'video' ? '视频' : '音频'}还没填地址，或先移除它`); return null; }
      skipped++; continue;
    }
    if (!urlOk(url)) { alertDlg(`第 ${i + 1} 段的地址不是合法的 http(s) 直链`); return null; }
    if (m.kind === 'video' && String(m.poster || '').trim() && !urlOk(m.poster)) {
      alertDlg(`第 ${i + 1} 段视频的封面地址不是合法的 http(s) 链接`); return null;
    }
    const one = { kind: m.kind, url, autoplay: !!m.autoplay && m.kind === 'video' };
    if (m.kind === 'video' && String(m.poster || '').trim()) one.poster = String(m.poster).trim();
    out.push(one);
  }
  if (skipped) showToast(`已跳过 ${skipped} 段没填地址的音视频`);
  return out;
}

/* ---------- 保存 ---------- */
function collect() {
  return {
    content: $('#eText').value.trim(),
    location: $('#eLoc').value.trim(),
    images,
  };
}

async function save(status) {
  if (saving) return;
  const b = collect();
  const m = mediaToSave(status !== 'draft');
  if (m === null) return;
  b.media = m;
  if (!b.content && !b.images.length && !b.media.length) {
    alertDlg('写点内容，或至少选一张照片、一段音视频吧');
    return;
  }
  saving = true;
  try {
    const r = editId
      ? await api(`/api/posts/${encodeURIComponent(editId)}`, { method: 'PUT', body: { ...b, status } })
      : await api('/api/posts', { method: 'POST', body: { ...b, status } });
    /* 服务端可能因为云端缺 media 列而把音视频降级掉（帖子照发，视频不存）。
       这种情况必须当面说清楚，跳走就再也看不见了——静默丢内容比报错更糟。 */
    if (r && r.warning && b.media.length) {
      await alertDlg(r.warning);
      saving = false;
      return;   // 留在编辑页，让用户决定是先去建列还是放弃视频
    }
    location.href = '/admin';
  } catch (e) {
    saving = false;
    alertDlg(e.message || '保存失败');
  }
}

$('#btnPublish').addEventListener('click', () => save('published'));
$('#btnDraft').addEventListener('click', () => save('draft'));

$('#btnDelete').addEventListener('click', async () => {
  const ok = await confirmDlg('确定删除这条内容吗？评论和点赞会一并删除。', '删除');
  if (!ok) return;
  try {
    await api(`/api/posts/${encodeURIComponent(editId)}`, { method: 'DELETE' });
    location.href = '/admin';
  } catch (e) { alertDlg(e.message); }
});

/* ---------- 编辑模式初始化 ---------- */
(async () => {
  if (!editId) {
    renderPhotos();
    renderMedia();
    return;
  }
  $('#navTitle').textContent = '编辑内容';
  $('#btnPublish').textContent = '保存';
  $('#btnDraft').textContent = '存为草稿';
  $('#btnDelete').style.display = 'block';
  try {
    const r = await api(`/api/posts/${encodeURIComponent(editId)}`);
    $('#eText').value = r.post.content || '';
    $('#eLoc').value = r.post.location || '';
    images = [...(r.post.images || [])];
    // 老数据没有 media 字段（音视频是后加的），缺字段当空数组处理，不能让编辑页白屏
    media = (Array.isArray(r.post.media) ? r.post.media : []).map((m) => ({
      kind: m && m.kind === 'audio' ? 'audio' : 'video',
      url: (m && m.url) || '', poster: (m && m.poster) || '', autoplay: !!(m && m.autoplay),
    }));
    renderPhotos();
    renderMedia();
    autoGrow();
  } catch (e) {
    alertDlg('内容不存在或已删除');
    location.href = '/admin';
  }
})();

/* 控制台外壳：退出登录与移动端菜单。原先写在 edit.html 的内联 <script> 里，
   为满足 CSP（script-src 'self'）搬到这儿。不能搬进 common.js —— admin.js 已经绑过
   同样两个按钮，重复监听会让菜单一点就一开一关。 */
(function editShell() {
  const out = $('#btnLogout');
  if (out) out.addEventListener('click', async () => {
    try { await fetch('/api/logout', { method: 'POST' }); } catch (e) { /* 退出失败也照常跳转 */ }
    location.href = '/login';
  });
  const menu = $('#btnMenu');
  const side = $('#side');
  if (menu && side) menu.addEventListener('click', () => side.classList.toggle('open'));
})();
