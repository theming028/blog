/* 发布/编辑页：文本、位置、图片上传（前端压缩）、发表/草稿/删除 */
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
  if (!b.content && !b.images.length) {
    alertDlg('写点内容，或至少选一张照片吧');
    return;
  }
  saving = true;
  try {
    if (editId) {
      await api(`/api/posts/${encodeURIComponent(editId)}`, { method: 'PUT', body: { ...b, status } });
    } else {
      await api('/api/posts', { method: 'POST', body: { ...b, status } });
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
    renderPhotos();
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
