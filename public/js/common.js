/* 公共工具：API、时间格式化、访客身份、弹窗 */
'use strict';

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

/* esc / fmtTime 已搬到 render.js（与 SSR 共用一份渲染层，转义与时间格式必须同源）。
   那两个函数由 render.js 挂到全局，所以 render.js 必须排在本文件之前加载。 */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败(${res.status})`);
  return data;
}

/* 访客身份 */
function getClientKey() {
  let k = localStorage.getItem('tm_client_key');
  if (!k) {
    k = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('tm_client_key', k);
  }
  return k;
}
const getNick = () => localStorage.getItem('tm_nick') || '';
const setNick = (n) => localStorage.setItem('tm_nick', n);
const getSite = () => localStorage.getItem('tm_site') || '';
const setSite = (s) => localStorage.setItem('tm_site', s || '');

/* ---- 弹窗：确认 ---- */
function confirmDlg(msg, okText = '确定') {
  return new Promise((resolve) => {
    const mask = $('#dlgConfirm');
    $('#dlgConfirmMsg').textContent = msg;
    $('#dlgConfirmOk').textContent = okText;
    mask.classList.add('show');
    const done = (v) => {
      mask.classList.remove('show');
      $('#dlgConfirmOk').onclick = null;
      $('#dlgConfirmCancel').onclick = null;
      resolve(v);
    };
    $('#dlgConfirmOk').onclick = () => done(true);
    $('#dlgConfirmCancel').onclick = () => done(false);
  });
}

/* ---- 弹窗：提示 ---- */
function alertDlg(msg) {
  return new Promise((resolve) => {
    const mask = $('#dlgAlert');
    $('#dlgAlertMsg').textContent = msg;
    mask.classList.add('show');
    $('#dlgAlertOk').onclick = () => { mask.classList.remove('show'); resolve(); };
  });
}

/* ---- 轻量提示 toast ---- */
function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast'; t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---- 图片：压缩 + 上传（编辑页与管理后台共用） ---- */
function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败，请用 JPG/PNG/WebP')); };
    img.src = url;
  });
}

async function compressImageFile(file) {
  if (file.type === 'image/gif' || file.size < 200 * 1024) {
    // gif 不压缩；小图原样上传
    const mime = file.type === 'image/gif' ? 'image/gif' : (file.type || 'image/jpeg');
    const data = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result.split(',')[1]);
      fr.onerror = () => reject(new Error('读取失败'));
      fr.readAsDataURL(file);
    });
    return { mime, data };
  }
  const img = await readImageFile(file);
  const MAX = 1600;
  let { width: w, height: h } = img;
  if (w > MAX || h > MAX) {
    const r = Math.min(MAX / w, MAX / h);
    w = Math.round(w * r); h = Math.round(h * r);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // PNG 透明底转白底
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { mime: 'image/jpeg', data: canvas.toDataURL('image/jpeg', 0.85).split(',')[1] };
}

async function uploadImageFile(file) {
  const b = await compressImageFile(file);
  return api('/api/upload', { method: 'POST', body: { mime: b.mime, data: b.data } });
}

/* ---- 剥离发布运行时注入的 mulepage 水印 ----
 * 这段页脚不在源码里（grep 全仓零命中），是 Page 运行时注入的，所以只有发布后的页面会出现，
 * 本地预览看不到。CSS 侧另有兜底隐藏（wx.css / admin.css），这里负责真正从 DOM 移除，
 * 免得它继续占位并被屏幕阅读器读出。注入时机可能晚于本脚本，故用 MutationObserver 补齐。 */
(function stripPageWatermark() {
  const SEL = '[id*="mulepage"], [class*="mulepage"]';
  const APP_ROOT = '.phone, .adm, .adm-login'; // 各页正文根，命中即不删，防止平台用同名 wrapper 时清空整页
  let queued = false;
  const strip = () => {
    document.querySelectorAll(SEL).forEach((n) => {
      if (n === document.documentElement || n === document.body) return;
      if (n.matches(APP_ROOT) || n.querySelector(APP_ROOT)) return;
      n.remove();
    });
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; strip(); }); // 合并高频变更，避免每次 mutation 都全表查询
  };
  strip();
  if (typeof MutationObserver === 'function') {
    // 观察 document 而非 documentElement：注入节点也可能落在 <html> 之外
    new MutationObserver(schedule).observe(document, { childList: true, subtree: true });
  }
})();

/* ---- 导航栏：开始滚动即整条渐隐；回到顶部附近再出现 ---- */
(function navScroll() {
  const nav = document.querySelector('.nav');
  if (!nav) return;
  // 阈值取 8px 而不是 0：iOS 回弹和 1px 抖动会让反复淡入淡出
  const onScroll = () => nav.classList.toggle('hide', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  // 点击标题栏回到顶部；导航栏隐藏时点不到，需要的话可另加悬浮"回到顶部"按钮
  nav.addEventListener('click', (e) => {
    if (e.target.closest('a, button, input, .nav-btn, .nav-txt')) return;
    if (window.scrollY <= 0) return;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();

/* 页面背景图轮换：每次刷新随机选取一张（含花园共 5 项），避免连续两次重复 */
(function rotateBg() {
  const BG_LIST = [
    'garden',
    '/assets/background-02.avif',
    '/assets/background-03.avif',
    '/assets/background-04.avif',
  ];
  const last = sessionStorage.getItem('tm_bg_last');
  let idx = Math.floor(Math.random() * BG_LIST.length);
  if (BG_LIST.length > 1 && BG_LIST[idx] === last) {
    idx = (idx + 1) % BG_LIST.length;
  }
  sessionStorage.setItem('tm_bg_last', BG_LIST[idx]);
  const el = document.getElementById('garden-bg');
  if (BG_LIST[idx] === 'garden') {
    el.classList.add('bg-garden');
    document.documentElement.style.setProperty('--bg-photo', 'none');
  } else {
    el.classList.remove('bg-garden');
    document.documentElement.style.setProperty('--bg-photo', `url('${BG_LIST[idx]}')`);
  }
})();
