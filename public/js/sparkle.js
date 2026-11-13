/* 彩色指针拖尾（sparkle trail）
 * 机制与参数复刻自 shawngolden.org 的同名效果（算法为可读重写，非其素材）：
 * 12 颗常驻拖尾（逐颗递减跟随/尺寸/透明度，呼吸脉动）+ 移动甩出的重力粒子。
 * 约定对齐本站特效引擎：DPR≤2、prefers-reduced-motion 不跑、页面隐藏时暂停 rAF。
 * 前台壳（index.html）专用：admin/edit 页面不引用本文件。 */
(function () {
  'use strict';
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // —— 常量（与原站逐项一致）——
  var PALETTE = ['#ff2bd6', '#ffe600', '#00f5d4', '#7bff00', '#ffffff', '#4d9fff', '#ff9f1c', '#ff7ad9'];
  var KINDS = ['star', 'plus', 'diamond', 'glint'];
  var TRAIL_N = 12;   // 常驻拖尾数
  var MAX_P = 90;     // 重力粒子池上限
  var IDLE = 420;     // 静止判定 ms，超过后拖尾在 280ms 内淡出

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  // —— 四种形状（几何与原站一致）——
  function shapeStar(t, e) {
    t.beginPath();
    for (var n = 0; n < 8; n++) {
      var r = n % 2 === 0 ? e : e * 0.28, a = n / 8 * Math.PI * 2;
      var x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (n === 0) t.moveTo(x, y); else t.lineTo(x, y);
    }
    t.closePath(); t.fill();
  }
  function shapePlus(t, e) {
    var n = e * 0.28;
    t.fillRect(-e, -n, e * 2, n * 2);
    t.fillRect(-n, -e, n * 2, e * 2);
  }
  function shapeDiamond(t, e) {
    t.beginPath(); t.moveTo(0, -e); t.lineTo(e * 0.72, 0); t.lineTo(0, e); t.lineTo(-e * 0.72, 0);
    t.closePath(); t.fill();
  }
  function shapeGlint(t, e) {
    t.beginPath();
    t.moveTo(0, -e); t.lineTo(e * 0.14, -e * 0.14); t.lineTo(e, 0); t.lineTo(e * 0.14, e * 0.14);
    t.lineTo(0, e); t.lineTo(-e * 0.14, e * 0.14); t.lineTo(-e, 0); t.lineTo(-e * 0.14, -e * 0.14);
    t.closePath(); t.fill();
  }
  function drawShape(t, kind, size) {
    if (kind === 'star') shapeStar(t, size);
    else if (kind === 'plus') shapePlus(t, size);
    else if (kind === 'diamond') shapeDiamond(t, size);
    else shapeGlint(t, size);
  }

  // —— 画布 ——
  var cv = document.createElement('canvas');
  cv.className = 'sparkle-layer';
  cv.setAttribute('aria-hidden', 'true');
  document.body.appendChild(cv);
  var ctx = cv.getContext('2d');
  if (!ctx) { cv.remove(); return; }
  var W = 0, H = 0;
  function resize() {
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // —— 状态 ——
  var trail = [];
  for (var m = 0; m < TRAIL_N; m++) {
    trail.push({ x: 0, y: 0, color: PALETTE[m % PALETTE.length], kind: pick(KINDS), size: 5.5 - m * 0.18, phase: Math.random() * Math.PI * 2 });
  }
  var particles = [];
  var px = 0, py = 0, lx = 0, ly = 0, active = false, lastMove = 0, colorIdx = 0;
  var now = performance.now();
  var running = false;

  function burst(x, y, count) {
    for (var F = 0; F < count; F++) {
      if (particles.length >= MAX_P) particles.shift();
      var speed = 18 + Math.random() * 70, ang = Math.random() * Math.PI * 2;
      particles.push({
        x: x + (Math.random() - 0.5) * 10, y: y + (Math.random() - 0.5) * 10,
        vx: Math.cos(ang) * speed * 0.35,
        vy: Math.sin(ang) * speed * 0.2 - 12 - Math.random() * 28,
        life: 0, max: 380 + Math.random() * 520,
        size: 2.4 + Math.random() * 5.2,
        color: PALETTE[colorIdx % PALETTE.length], kind: pick(KINDS),
        rot: Math.random() * Math.PI, spin: (Math.random() - 0.5) * 6
      });
      colorIdx++;
    }
  }

  window.addEventListener('pointermove', function (e) {
    if (!e.isPrimary) return;
    px = e.clientX; py = e.clientY;
    if (!active) {
      active = true; lx = px; ly = py;
      for (var i = 0; i < trail.length; i++) { trail[i].x = px; trail[i].y = py; }
    }
    lastMove = performance.now();
    var dx = px - lx, dy = py - ly, dist = Math.hypot(dx, dy);
    if (dist > 5) {
      burst(px, py, dist > 28 ? 3 : dist > 12 ? 2 : 1);
      lx = px; ly = py;
    }
  }, { passive: true });

  function frame(t) {
    if (!running) return;
    var dt = Math.min(0.048, (t - now) / 1000); now = t;
    var fade = (active && t - lastMove < IDLE) ? 1 : Math.max(0, 1 - (t - lastMove - IDLE) / 280);
    ctx.clearRect(0, 0, W, H);

    if (active) {
      for (var m = 0; m < trail.length; m++) {
        var p = trail[m];
        var ease = 0.28 - m * 0.016;
        p.x += (px - p.x) * ease; p.y += (py - p.y) * ease;
        p.phase += dt * (8 + m * 0.4);
        var pulse = 0.75 + Math.sin(p.phase) * 0.25;
        var a = fade * (0.95 - m * 0.045);
        if (a <= 0.02) continue;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.phase * 0.25);
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        drawShape(ctx, p.kind, p.size * pulse);
        ctx.restore();
      }
    }

    for (var k = particles.length - 1; k >= 0; k--) {
      var q = particles[k];
      q.life += dt * 1000;
      if (q.life >= q.max) { particles.splice(k, 1); continue; }
      q.vy += 140 * dt;
      q.x += q.vx * dt; q.y += q.vy * dt; q.rot += q.spin * dt;
      var prog = q.life / q.max;
      var alpha = prog < 0.7 ? 1 : 1 - (prog - 0.7) / 0.3;
      ctx.save();
      ctx.translate(q.x, q.y); ctx.rotate(q.rot);
      ctx.globalAlpha = alpha; ctx.fillStyle = q.color;
      drawShape(ctx, q.kind, q.size * (1 - prog * 0.45));
      ctx.restore();
    }
    requestAnimationFrame(frame);
  }

  function start() { if (!running) { running = true; now = performance.now(); requestAnimationFrame(frame); } }
  function stop() { running = false; }

  // 本站特效约定：页面隐藏时暂停（与 snow/blossom 同口径），回到前台自动恢复
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop(); else start();
  });

  resize();
  window.addEventListener('resize', resize);
  start();
})();
