/* 飞舞的蝴蝶：随桃花特效（fx=blossom）出现的蝴蝶群。
 * 改编自 hibi.garden — https://github.com/hibigarden/site
 * （src/companion.js 的飞行内核 + src/butterflies.js 的精灵与图层，
 *  MIT License，Copyright (c) 2026 schmayterling）
 *
 * 为什么是 companion.js：原站让人记住的"蝴蝶在随意飞舞"不是 butterflies.js
 * 那套"停在花上、指针靠近才惊飞"的栖息系统（实测线上 data-butterflies=0，
 * 几乎不出场），而是 companion.js——一套 12fps 定格帧上的自由飞模拟：
 * 巡航速度以"身位/秒"计、振翅-滑翔步态（glide 时下沉、下挥时抬起）、
 * 之字形航向漂移、转弯侧倾、翅膀内外差（bank）、影子随升力漂移，
 * 并且永远绕开正文。本文件把这套飞行内核逐行保留，换掉它的"剧情"部分。
 *
 * ---- ADAPTATIONS（对 companion.js 的全部改动）----
 * 1) 一只"伴飞"蝴蝶 → 一群（桌面 10 只，混五种精灵，0.5–0.72 倍体型）；
 * 2) 图层 fixed 在视口（原站跟页面滚动走）：目标点、避障坐标系都在视口内；
 * 3) 去掉 A* 绕文本网格（chamfer/plan/stations/pick/reenter/剧情会面 spiral/chase/
 *    pair/wake/lifttoff）——博客的"正文"是一根固定的信息流列，避障退化为
 *    解析式的"到 .phone 列矩形的带符号距离"，飞行中贴边滑行逻辑（away/keep）原样保留；
 * 4) 目标改选：40% 概率落花园装饰（[data-perch]，落上去晒太阳 bask），
 *    60% 概率在两侧留白里挑一个自由点，到了不停留、缓一拍再飞下一处——"随意飞舞"；
 * 5) 保留指针惊飞（110px 内起飞逃离），去掉 plain/torn 撕纸边淡入与暗色影子；
 * 6) 数量由 feed.js 的 applyFx 驱动：body.dataset.butterflies = 10（桃花）/ 0（其它）；
 * 7) 窄屏（<720px 花园不渲染）与 prefers-reduced-motion 下整层不出现（CSS + JS 双保险）。
 * 12fps 定格帧时钟为原站 clock.js 的内联版（语义相同，命名 onFrame 避免与本文件 tick 撞名）。 */
(function () {
  'use strict';

  /* ---------------- 12fps 定格帧时钟（原站 clock.js 内联） ---------------- */
  const FRAME = 1000 / 12;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const watchers = new Set();
  const subscribers = new Set();
  let rafClock = 0;
  let held = -1;
  const still = () => reduced.matches || document.documentElement.dataset.motion === 'still';
  function loop(now) {
    rafClock = 0;
    const frame = Math.floor(now / FRAME);
    if (frame !== held) {
      held = frame;
      const time = frame * FRAME;
      for (const fn of [...subscribers]) if (fn(time) === false) subscribers.delete(fn);
    }
    if (subscribers.size && !document.hidden) rafClock = requestAnimationFrame(loop);
  }
  function onFrame(fn) {
    subscribers.add(fn);
    if (!document.hidden) rafClock ||= requestAnimationFrame(loop);
    return () => subscribers.delete(fn);
  }
  function onMotion(fn) {
    watchers.add(fn);
    fn(still());
    return () => watchers.delete(fn);
  }
  function notify() { for (const fn of watchers) fn(still()); }
  reduced.addEventListener('change', notify);
  new MutationObserver(notify).observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && subscribers.size) rafClock ||= requestAnimationFrame(loop);
  });

  /* ---------------- 精灵与飞行参数（原站逐行） ---------------- */
  const SPECIES = [
    { id: 'small-blue', src: '/img/fly/small-blue.webp', w: 121, h: 97 },
    { id: 'morpho', src: '/img/fly/morpho.webp', w: 145, h: 113 },
    { id: 'brimstone', src: '/img/fly/brimstone.webp', w: 129, h: 98 },
    { id: 'cabbage-white', src: '/img/fly/cabbage-white.webp', w: 125, h: 89 },
    { id: 'peacock', src: '/img/fly/peacock.webp', w: 133, h: 94 },
  ];
  const SP = Object.fromEntries(SPECIES.map((s) => [s.id, s]));
  const DEG = Math.PI / 180;
  const phone = matchMedia('(max-width: 719px)');   // 花园与蝴蝶同宽窄屏不出现
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const lerp = (a, b, u) => a + (b - a) * u;
  const turnTo = (from, to) => ((((to - from) % 360) + 540) % 360) - 180;

  // flight, in body widths per second（原站注释：手机上的小蝴蝶按身位飞得一样快）
  const CRUISE = 3.6; // travel speed
  const VMAX = 5;     // 画面上永不超过这个速度（含之字与颠簸）
  const ACCEL = 7;    // 转向加速度，widths/s²
  const SINK = 1.4;   // 滑翔时下漂，widths/s²
  const REACH = 0.5;  // 与障碍保持的最小间距（半个身位）
  const SUB = 5;      // 每个定格帧 5 个固定物理步
  const DT = FRAME / 1000 / SUB;
  const BEATS = { fast: [1, 0.08], cruise: [1, 0.55, 0.04], slow: [1, 0.62, 0.12, 0.5] };

  let seed = (Math.random() * 2 ** 32) >>> 0;
  function random() {   // mulberry32（原站同款，便于 ?flight= 复现；博客不暴露调试口）
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const rand = (lo, hi) => lo + random() * (hi - lo);

  /* ---------------- 图层与演员 ---------------- */
  let layer = null;
  const cast = [];
  let running = false;
  let stopFrame = null;
  let motion;           // 交互监听的中止器（still 时为空）
  let measureTimer;

  function actor(sp, k, x, y) {
    const { w, h, src } = sp;
    layer.insertAdjacentHTML(
      'beforeend',
      `<i class="bf-shadow" style="width:${w + 16}px;height:${h + 16}px;background-image:url(${src.replace('.webp', '-shadow.webp')})"></i>` +
        `<div class="bf" style="width:${w}px;height:${h}px;--src:url(${src})"><div class="bf-stage"><i></i><i></i></div></div>`,
    );
    const el = layer.lastChild;
    const a = { sp, el, shadow: el.previousSibling, wings: [...el.querySelectorAll('.bf-stage i')], w, h, k, kb: k };
    Object.assign(a, { x, y, px: x, py: y, vx: 0, vy: 0, hd: rand(-90, 90), rot: 0, turn: 0, bank: 0 });
    Object.assign(a, { wing: 0, lift: 0, op: 1, mode: 'fly', mt: 0, goal: null });
    Object.assign(a, { gait: 'cruise', beat: 0, glide: false, gaitT: 0, zig: 0, zigTo: 0, zigT: 0, last: {}, dwell: 0 });
    return a;
  }
  function drop(a) { a.el.remove(); a.shadow.remove(); }

  function draw(a) {
    const { w, h, k } = a;
    const set = (el, key, value) => { if (a.last[key] !== value) el.style[key.split(':')[1]] = a.last[key] = value; };
    set(a.el, 'el:transform', `translate3d(${(a.px - w / 2).toFixed(1)}px,${(a.py - h / 2).toFixed(1)}px,0) rotate(${a.rot.toFixed(1)}deg) scale(${k.toFixed(3)})`);
    // banking：转弯内侧的翅膀抬高、外侧放平（原站逐行）
    const left = clamp(a.wing + a.bank, 0, 86).toFixed(0);
    const right = clamp(a.wing - a.bank, 0, 86).toFixed(0);
    a.wings.forEach((wing, i) => {
      const value = `rotateY(${i % 2 ? -right : left}deg)`;
      if (a.last[i] !== value) wing.style.transform = a.last[i] = value;
    });
    const off = (4 + 30 * a.lift) * k;
    set(a.shadow, 'shadow:transform', `translate3d(${(a.px - w / 2 - 8 + off * 0.8).toFixed(1)}px,${(a.py - h / 2 - 8 + off).toFixed(1)}px,0) rotate(${a.rot.toFixed(1)}deg) scale(${(k * Math.cos(Math.max(a.wing, 0) * DEG)).toFixed(3)},${k.toFixed(3)})`);
    set(a.shadow, 'shadow:opacity', String(+(a.op * 0.34 * (1 - 0.5 * a.lift)).toFixed(3)));
    set(a.el, 'el:opacity', String(+a.op.toFixed(3)));
  }

  /* ---------------- 自由空间：视口减去 .phone 信息流列（ADAPTATION 3） ---------------- */
  let W = 0, VH = 0, scale = 1;
  let col = null;   // 内容列矩形（视口坐标），带一点气隙
  const spots = []; // [data-perch] 花园装饰落点（视口坐标）

  function measure() {
    W = document.documentElement.clientWidth;
    VH = innerHeight;
    scale = phone.matches ? 0.7 : 1;
    const el = document.querySelector('.phone');
    const r = el?.getBoundingClientRect();
    col = r && r.width ? { l: r.left - 10, t: -1, r: r.right + 10, b: VH + 1 } : null;
    spots.length = 0;
    for (const p of document.querySelectorAll('[data-perch]')) {
      if (!p.getClientRects().length) continue;
      const q = p.getBoundingClientRect();
      const [fx, fy] = `${p.dataset.perch},`.split(',').map((v) => (v.trim() && isFinite(v) ? +v : 0.5));
      spots.push({ x: q.left + fx * q.width, y: q.top + fy * q.height });
    }
  }
  /** 带符号距离：正=离列多远，负=在列里多深（解析式，替代原站 chamfer 网格） */
  function clearance(x, y) {
    if (!col) return 1e6;
    if (x > col.l && x < col.r && y > col.t && y < col.b) return -Math.min(x - col.l, col.r - x, y - col.t, col.b - y);
    return Math.hypot(Math.max(col.l - x, 0, x - col.r), Math.max(col.t - y, 0, y - col.b));
  }
  function away(x, y) {   // 原站逐行：有限差分梯度，指向远离障碍的单位向量
    const c = 16;
    const gx = clearance(x + c, y) - clearance(x - c, y);
    const gy = clearance(x, y + c) - clearance(x, y - c);
    const len = Math.hypot(gx, gy) || 1;
    return [gx / len, gy / len];
  }
  const reach = (a) => REACH * a.w * a.k;
  const vmax = (a) => VMAX * a.w * a.kb;

  /* ---------------- 目标选择（ADAPTATION 4） ---------------- */
  function pickGoal(a) {
    if (spots.length && random() < 0.4) {
      const s = spots[(random() * spots.length) | 0];
      if (clearance(s.x, s.y) > 0) return { x: s.x, y: s.y, perch: true };
    }
    for (let i = 0; i < 24; i++) {
      const x = rand(24, W - 24), y = rand(48, VH - 40);
      if (clearance(x, y) >= reach(a) + 10) return { x, y };
    }
    const left = col ? col.l - reach(a) - 16 : W * 0.12;
    return { x: clamp(left, 24, W - 24), y: rand(VH * 0.3, VH * 0.7) };
  }
  function launch(a) {
    a.mode = 'takeoff';
    a.mt = 0;
    a.vy -= 1.1 * a.w * a.kb;
  }

  /* ---------------- 物理（companion.js 逐行，去掉 A* 路径部分） ---------------- */
  function physics(a) {
    const w = a.w * a.kb;
    const goal = a.goal;
    a.mt += DT;
    if (!goal) return;
    const left = Math.hypot(goal.x - a.x, goal.y - a.y);
    if (a.mode === 'perch' || a.mode === 'flare' || a.mode === 'settle') {
      if (left > 0.25 * w) launch(a);
      else {
        a.vx = a.vy = 0;
        if (a.mode !== 'perch') {
          a.x += (goal.x - a.x) * Math.min(1, DT * 10);
          a.y += (goal.y - a.y) * Math.min(1, DT * 10);
        }
        if (a.mode === 'flare' && a.mt > 0.17) [a.mode, a.mt] = ['settle', 0];
        if (a.mode === 'settle' && a.mt > 0.25) {
          [a.mode, a.mt] = ['perch', 0];
          a.perchAt = { bask: goal.perch ? rand(1.2, 3.6) : rand(0.25, 0.7), shift: rand(2.5, 6) };
        }
        return;
      }
    }
    if (a.mode === 'takeoff' && a.mt > 0.3) [a.mode, a.mt] = ['fly', 0];
    if (goal.perch && a.mode === 'fly' && left < 0.18 * w) [a.mode, a.mt] = ['hover', 0];
    if (a.mode === 'hover') {
      if (left > 0.6 * w || !goal.perch) a.mode = 'fly';
      else if (a.mt > 0.3 && left < 0.08 * w) { [a.mode, a.mt] = ['flare', 0]; return; }
    }

    let tx = goal.x, ty = goal.y;
    const brake = goal.perch ? clamp(left / (2.4 * w), 0.12, 1) : clamp(left / (1.2 * w), 0, 1);
    let speed = CRUISE * w * (goal.speed ?? 1) * brake;
    if (a.mode === 'hover') speed = Math.min(speed, left * 5);
    let dx = tx - a.x, dy = ty - a.y;
    const dl = Math.hypot(dx, dy) || 1;
    const room = clamp((clearance(a.x, a.y) - reach(a)) / reach(a), 0, 1);
    const zig = a.mode === 'fly' && left > 1.5 * w ? a.zig * room : 0;
    [dx, dy] = [(dx * Math.cos(zig) - dy * Math.sin(zig)) / dl, (dx * Math.sin(zig) + dy * Math.cos(zig)) / dl];
    let ax = dx * speed - a.vx;
    let ay = dy * speed - a.vy;
    const lim = ACCEL * w * (a.glide ? 0.4 : 1) * DT;
    const am = Math.hypot(ax, ay);
    if (am > lim) [ax, ay] = [(ax * lim) / am, (ay * lim) / am];
    a.vx += ax;
    a.vy += ay;
    a.vy += SINK * w * DT;

    // 永不穿字：会把蝴蝶带进禁区的速度分量沿边界滑开（原站逐行）
    const near = Math.hypot(goal.x - a.x, goal.y - a.y) < 2 * reach(a) || a.mode === 'takeoff';
    const keep = near ? Math.min(reach(a), clearance(goal.x, goal.y) - 2, clearance(a.x, a.y)) : reach(a);
    const here = clearance(a.x, a.y);
    if (clearance(a.x + a.vx * DT, a.y + a.vy * DT) < Math.min(keep, here + 0.01)) {
      const [gx, gy] = away(a.x, a.y);
      const into = a.vx * gx + a.vy * gy;
      if (into < 0) [a.vx, a.vy] = [a.vx - into * gx, a.vy - into * gy];
    }
    const v = Math.hypot(a.vx, a.vy);
    const cap = (VMAX - 0.7) * w;
    if (v > cap) [a.vx, a.vy] = [(a.vx * cap) / v, (a.vy * cap) / v];
    a.x += a.vx * DT;
    a.y += a.vy * DT;

    if (v > 0.3 * w) {
      const want = Math.atan2(a.vx, -a.vy) / DEG;
      const step = clamp(turnTo(a.hd, want), -540 * DT, 540 * DT);
      a.hd += step;
      a.turn += (step / DT - a.turn) * Math.min(1, DT * 8);
    } else a.turn *= 1 - Math.min(1, DT * 8);
    a.bank += (clamp(a.turn * 0.1, -28, 28) - a.bank) * Math.min(1, DT * 10);

    if ((a.zigT -= DT) <= 0) {
      a.zigTo = (a.zigTo > 0 ? -1 : 1) * rand(10, 30) * DEG;
      a.zigT = rand(0.25, 0.7);
    }
    a.zig += (a.zigTo - a.zig) * Math.min(1, DT * 6);
    const climbing = a.vy < -0.35 * CRUISE * w;
    const hard = Math.abs(a.turn) > 150;
    const must = a.mode !== 'fly' || climbing || hard || v < 0.5 * CRUISE * w;
    a.gaitT -= DT;
    if (a.glide ? a.gaitT <= 0 || must : a.gaitT <= 0) {
      a.glide = !a.glide && !must && random() < (a.vy > 0.2 * CRUISE * w ? 0.85 : 0.55);
      a.gaitT = a.glide ? rand(0.2, 0.5) : rand(0.35, 0.9);
    }
    a.gait = a.mode === 'takeoff' || climbing || hard ? 'fast' : a.mode === 'hover' ? 'slow' : 'cruise';
  }

  /** 一个定格帧：先跑物理，再摆翅膀、身体与影子（companion.js step 逐行） */
  function step(a) {
    const w = a.w * a.kb;
    const flapping = a.mode === 'fly' || a.mode === 'takeoff' || a.mode === 'hover';
    if (flapping && !a.glide) {
      const beat = BEATS[a.gait];
      a.beat = (a.beat + 1) % beat.length;
      if (beat[a.beat] < beat[(a.beat + beat.length - 1) % beat.length]) a.vy -= (SINK * w * beat.length * FRAME) / 1000;
    }
    for (let i = 0; i < SUB; i++) physics(a);
    const beat = BEATS[a.gait];
    const up = flapping && !a.glide ? beat[a.beat % beat.length] : 0;
    if (a.mode === 'perch') {
      const at = a.perchAt;
      at.bask -= FRAME / 1000;
      at.shift -= FRAME / 1000;
      if (at.wingTo === undefined) at.wingTo = 72;
      if (at.bask <= 0) [at.wingTo, at.bask] = [at.wingTo > 36 ? rand(0, 14) : 72, rand(1.6, 4.5)];
      if (at.shift <= 0) [at.hdTo, at.shift] = [a.hd + (random() < 0.5 ? -1 : 1) * rand(10, 26), rand(3, 7)];
      a.wing += clamp(at.wingTo - a.wing, -22, 22);
      if (at.hdTo !== undefined) a.hd += clamp(turnTo(a.hd, at.hdTo), -9, 9);
      a.lift = 0;
    } else if (a.mode === 'flare') { a.wing = 0; a.lift = 0.3; }
    else if (a.mode === 'settle') { a.wing = 18; a.lift = Math.max(0, a.lift - 0.12); }
    else {
      a.wing = a.glide ? 8 : up * (a.gait === 'fast' ? 78 : 68) + 4;
      a.lift = Math.min(1, a.lift + 0.25) * (a.glide ? 0.9 : 1) - 0.06 * up;
    }
    const kTo = (a.goal?.k ?? a.kb) * (a.mode === 'flare' ? 1.05 : 1);
    a.k += (kTo - a.k) * 0.35;
    a.rot = a.hd + a.bank * 0.4;
    let px = a.x;
    let py = a.y + 0.045 * w * up;
    const most = (vmax(a) * FRAME) / 1000;
    const moved = Math.hypot(px - a.px, py - a.py);
    if (moved > most && a.px > -999) [px, py] = [a.px + ((px - a.px) * most) / moved, a.py + ((py - a.py) * most) / moved];
    a.px = px;
    a.py = py;
  }

  /* ---------------- 建群 / 调群（非破坏式：只增删到目标数） ---------------- */
  const MIX = ['small-blue', 'brimstone', 'cabbage-white', 'small-blue', 'morpho', 'cabbage-white', 'brimstone', 'small-blue', 'peacock', 'small-blue'];
  function spawnOne(i) {
    const sp = SP[MIX[i % MIX.length]];
    const k = rand(0.5, 0.72) * scale;
    const g = pickGoal({ w: sp.w, k });
    const a = actor(sp, k, g.x, g.y);
    a.goal = pickGoal(a);
    a.mode = 'fly';
    draw(a);
    cast.push(a);
  }
  function sync() {
    let want = parseInt(document.body.dataset.butterflies ?? 0) || 0;
    want = clamp(want, 0, 12);
    if (phone.matches) want = 0;   // 窄屏：花园不渲染，蝴蝶同层不出现
    while (cast.length > want) drop(cast.pop());
    while (cast.length < want) spawnOne(cast.length);
    if (cast.length) run();
  }
  function frame() {
    for (const a of cast) {
      if (a.mode === 'perch') {
        if (a.perchAt.bask <= 0 && a.goal && Math.hypot(a.goal.x - a.x, a.goal.y - a.y) < 0.3 * a.w * a.k) {
          a.goal = pickGoal(a);
          launch(a);
        }
      } else if (a.mode === 'fly' && a.goal && Math.hypot(a.goal.x - a.x, a.goal.y - a.y) < 0.12 * a.w * a.k && a.mt > 0.6) {
        a.goal = pickGoal(a);   // 路过型目标：到了缓一拍再飞下一处
        a.mt = 0;
      }
      const m = 0.55 * a.w * a.k + 140;   // 离屏过久：从最近的边回来
      if (a.x < -m || a.x > W + m || a.y < -m || a.y > VH + m) {
        const x = clamp(a.x, 20, W - 20), y = clamp(a.y, 40, VH - 40);
        Object.assign(a, { x, y, px: x, py: y, vx: 0, vy: 0 });
        a.goal = pickGoal(a);
        a.mode = 'fly';
      }
      step(a);
      draw(a);
    }
    return cast.length > 0;
  }
  function run() {
    if (running || still()) return;
    running = true;
    // 群空时 frame() 返回 false 自行退订；running 必须在这里复位，否则下次 run() 永远不再订阅（冻结）
    stopFrame = onFrame(() => {
      const more = frame();
      if (!more) running = false;
      return more;
    });
  }
  function halt() {
    stopFrame?.();
    stopFrame = null;
    running = false;
  }

  function startle(event) {
    const x = event.clientX, y = event.clientY;
    for (const a of cast) {
      if (Math.hypot(a.x - x, a.y - y) < 110) {
        const [gx, gy] = away(a.x, a.y);
        a.goal = { x: clamp(a.x + gx * 260, 24, W - 24), y: clamp(a.y + gy * 260, 48, VH - 40) };
        launch(a);
      }
    }
  }
  function onMove(e) { if (e.pointerType !== 'touch') startle(e); }
  function onTap(e) { if (!e.target?.closest?.('a,button,input,textarea,select,label')) startle(e); }

  function setMotion(isStill) {
    motion?.abort();
    motion = isStill ? null : new AbortController();
    if (motion) {
      const options = { passive: true, signal: motion.signal };
      addEventListener('pointermove', onMove, options);
      addEventListener('click', onTap, options);
      run();
    } else halt();
  }

  function remeasure() {
    clearTimeout(measureTimer);
    measureTimer = setTimeout(() => { measure(); sync(); }, 150);
  }

  /* ---------------- 图层常驻（数量由 dataset 决定，0 即空层） ---------------- */
  layer = document.createElement('div');
  layer.className = 'bf-layer';
  layer.setAttribute('aria-hidden', 'true');
  document.body.append(layer);

  measure();
  sync();
  onMotion(setMotion);
  addEventListener('resize', remeasure);
  addEventListener('butterflies:sync', remeasure);   // feed.js 改完 dataset 后派发（ADAPTATION 6）
  new ResizeObserver(remeasure).observe(document.body);
  if (document.fonts?.ready) document.fonts.ready.then(remeasure);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) run(); });

  window.Butterflies = {
    setEnabled(on) { document.body.dataset.butterflies = on ? '10' : '0'; measure(); sync(); },
    setCount(n) { document.body.dataset.butterflies = String(Math.max(0, n | 0)); sync(); },
  };
})();
