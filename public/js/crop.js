/**
 * 比例锁定的图片裁剪器（零依赖，Canvas 手写）。
 *
 * 交互模型选的是「可视区即裁剪框」而不是「图上拖一个选框」：
 * 封面槽位是固定比例（见 SPECS.cover），用户能改的只有平移和缩放，改不了框的比例 ——
 * 这样不可能裁出一个填不满槽位的尺寸，也就不需要再校验"你裁的比例不对"。
 *
 * 几何全部收在纯函数 layout() 里，不碰 DOM，可以在 Node 侧直接 require 做单测
 * （见文件末的 module.exports 兜底）。
 */
'use strict';

(function (root) {
  /* 各图位的最佳尺寸。比例必须与 wx.css 的槽位保持一致：
     cover  = --phone-w(760px) × .cover height(280px) = 19:7，取 2 倍图 1520×560
     avatar = .cover-avatar 68×68 方图，取 3 倍约 200×200
     ⚠️ 改那两个 CSS 值时必须同步这里，否则裁出来仍要object-fit 二次裁切。 */
  var SPECS = {
    cover: { w: 1520, h: 560, label: '封面图', slot: '760×280' },
    avatar: { w: 200, h: 200, label: '头像', slot: '68×68' },
  };

  /** 图片要铺满裁剪框所需的最小缩放（等价于 CSS 的 object-fit: cover） */
  function coverScale(imgW, imgH, boxW, boxH) {
    return Math.max(boxW / imgW, boxH / imgH);
  }

  /**
   * 算出当前视图的绘制位置与对应的原图裁切矩形。
   * userScale ≥ 1（1 = 刚好铺满），pan 是用户拖动的显示像素偏移。
   * 返回的 sx/sy/sw/sh 是原图像素坐标，且保证不越界（图始终盖住框）。
   */
  function layout(imgW, imgH, boxW, boxH, userScale, panX, panY) {
    var k = coverScale(imgW, imgH, boxW, boxH) * Math.max(1, userScale);
    var dw = imgW * k, dh = imgH * k;
    // 居中基准 + 用户平移，再把平移量夹住：图片右缘不能离开框右边，左缘不能越过框左边
    var dx = (boxW - dw) / 2 + (panX || 0);
    var dy = (boxH - dh) / 2 + (panY || 0);
    var minDx = boxW - dw, minDy = boxH - dh;   // ≤ 0
    dx = Math.min(0, Math.max(minDx, dx));
    dy = Math.min(0, Math.max(minDy, dy));
    return { k: k, dx: dx, dy: dy, dw: dw, dh: dh,
      sx: -dx / k, sy: -dy / k, sw: boxW / k, sh: boxH / k };
  }

  /** 把选中的区域画成固定尺寸的成图（导出尺寸与槽位比例严格一致） */
  function render(img, lo, outW, outH) {
    var c = document.createElement('canvas');
    c.width = outW; c.height = outH;
    var ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    // toDataURL('image/jpeg') 没有 alpha 通道：不铺白底的话，
    // 透明 PNG 的空明区会变成纯黑
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(img, lo.sx, lo.sy, lo.sw, lo.sh, 0, 0, outW, outH);
    return c;
  }

  var el = function (id) { return document.getElementById(id); };
  var state = null;
  var HINT = '拖动图片调整位置，滑杆或滚轮缩放；框的比例就是成图比例';

  function draw() {
    var box = el('cropBox'), cv = el('cropCanvas');
    var r = box.getBoundingClientRect();
    var dpr = Math.min(3, window.devicePixelRatio || 1);
    // 只设后备缓冲分辨率，显示尺寸交给 CSS 的 width/height:100%。
    // 原来这里还写了内联 px 尺寸：弹窗刚展开时布局会变（遮罩出现→页面滚动条消失→弹窗重新居中变宽），
    // 内联值停在旧宽度上，右侧就露出一条约 14px 的盒子底色黑边；交给 CSS 就永远铺满。
    // 注意 cv.width 必须在：不设的话画布停在默认 300×150，被 CSS 拉伸后预览会糊且比例失真。
    // ⚠️ r 是 getBoundingClientRect，量的是变换后的视觉尺寸：所以 .crop-modal 的入场动画
    // 只能淡入+上移，不能带 scale（admin.css 的 admPopNoScale 就是为此），否则画布按 0.98 建。
    var w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }   // 赋值会重分配 backing store，只在尺寸真变了时做
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    var lo = layout(state.img.naturalWidth, state.img.naturalHeight, r.width, r.height, state.scale, state.panX, state.panY);
    ctx.drawImage(state.img, lo.dx, lo.dy, lo.dw, lo.dh);
    el('cropZoomVal').textContent = Math.round(state.scale * 100) + '%';
    // 已经铺满到不能再平移时，把滑杆归零，避免"拖着没反应"的错觉
    el('cropHint').textContent = HINT + ' ｜ 原图 ' + state.img.naturalWidth + '×' + state.img.naturalHeight
      + ' · 成图 ' + state.spec.w + '×' + state.spec.h + '（比例 ' + (state.spec.w / state.spec.h).toFixed(2) + '）' + ' · 槽位 ' + state.spec.slot;
  }

  function open(opts) {
    if (state) close();          // 先释放上一次的 objectURL 与 ResizeObserver
    var spec = opts.spec || SPECS.cover;
    var img = new Image();
    var url = URL.createObjectURL(opts.file);
    el('cropTitle').textContent = '裁剪' + spec.label;
    // 裁剪框比例由 spec 注入，CSS 里不写死任何比例数字——两处各写迟早会不一致
    el('cropBox').style.aspectRatio = spec.w + ' / ' + spec.h;
    el('cropMask').classList.add('show');
    state = { spec: spec, img: img, scale: 1, panX: 0, panY: 0, onDone: opts.onDone, url: url };
    img.onload = function () {
      // 竖图塞进横槽位时，默认给一点缩放会让"平移空间"过小；从 1 开始即"刚好铺满"
      state.scale = 1; state.panX = 0; state.panY = 0;
      var z = el('cropZoom');
      z.value = '1'; z.min = '1'; z.max = '4'; z.step = '0.01';
      draw();
      watchResize();
    };
    img.onerror = function () {
      URL.revokeObjectURL(url); close();
      if (typeof alertDlg === 'function') alertDlg('图片解码失败，请用 JPG/PNG/WebP');
      else window.alert('图片解码失败，请用 JPG/PNG/WebP');
    };
    img.src = url;
  }

  function close() {
    el('cropMask').classList.remove('show');
    if (state && state.ro) state.ro.disconnect();
    if (state && state.url) URL.revokeObjectURL(state.url);
    state = null;
  }

  // 交互与 DOM 相关，Node 侧单测纯几何函数时整段跳过（typeof document 兜底）
  if (typeof document !== 'undefined') {
  /* ---- 交互：拖动平移、滑杆/滚轮缩放 ---- */
  /* 弹窗展开、窗口缩放、移动端地址栏收放都会改变盒子尺寸；尺寸一变就按新宽度重画，
     否则画布与框不同宽，边缘会露底色。 */
  function watchResize() {
    if (typeof ResizeObserver !== 'undefined') {
      if (state && !state.ro) { state.ro = new ResizeObserver(function () { if (state) draw(); }); state.ro.observe(el('cropBox')); }
    } else {
      window.addEventListener('resize', function onr() { if (!state) { window.removeEventListener('resize', onr); return; } draw(); });
    }
  }

  var drag = null;
  document.addEventListener('pointerdown', function (e) {
    if (!state || !e.target.closest || !e.target.closest('#cropCanvas')) return;
    drag = { x: e.clientX, y: e.clientY, panX: state.panX, panY: state.panY };
    e.target.setPointerCapture && e.target.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  document.addEventListener('pointermove', function (e) {
    if (!state || !drag) return;
    state.panX = drag.panX + (e.clientX - drag.x);
    state.panY = drag.panY + (e.clientY - drag.y);
    draw();
  });
  document.addEventListener('pointerup', function () { drag = null; });
  document.addEventListener('pointercancel', function () { drag = null; });
  document.addEventListener('input', function (e) {
    if (!state || e.target !== el('cropZoom')) return;
    state.scale = parseFloat(e.target.value) || 1;
    draw();
  });
  document.addEventListener('wheel', function (e) {
    if (!state || !e.target.closest || !e.target.closest('#cropCanvas')) return;
    e.preventDefault();
    state.scale = Math.min(4, Math.max(1, state.scale * (e.deltaY > 0 ? 0.92 : 1.08)));
    el('cropZoom').value = String(state.scale);
    draw();
  }, { passive: false });

  function confirm() {
    if (!state) return;
    var box = el('cropBox').getBoundingClientRect();
    var lo = layout(state.img.naturalWidth, state.img.naturalHeight, box.width, box.height, state.scale, state.panX, state.panY);
    var canvas = render(state.img, lo, state.spec.w, state.spec.h);
    var dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    var done = state.onDone;
    close();
    if (done) done(dataUrl);
  }

  document.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    if (e.target.closest('#cropCancel')) close();
    else if (e.target.closest('#cropOk')) confirm();
    else if (e.target === el('cropMask')) close();   // 点蒙层本体关闭
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && el('cropMask') && el('cropMask').classList.contains('show')) close();
  });

  }

  var Crop = { SPECS: SPECS, coverScale: coverScale, layout: layout, render: render, open: open, close: close };
  root.Crop = Crop;
  // 让纯几何函数在 Node 里也能被 require，便于单测（浏览器路径不受影响）
  if (typeof module !== 'undefined' && module.exports) module.exports = Crop;
})(typeof window !== 'undefined' ? window : globalThis);
