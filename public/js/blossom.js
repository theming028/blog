/**
 * 桃花飘落特效（含落地堆积、嫩叶、阵风、燕子、春光）。
 *
 * 为什么不塞进 snow.js：那边绑着积雪高度图、六角晶体精灵、按层 bokeh 三件雪专属逻辑。
 * 但**堆积的架构照搬 snow.js**，那套设计是被验证过的：
 *   高度图只管"下一片落在多高"，不负责画任何东西；花瓣落地那一刻被永久"盖章"进独立画布，
 *   之后每帧不再重画堆积 —— 否则上百片逐帧重绘，手机上必掉帧。
 *   换视口时按盖章记录回放重印（位置存成"宽度比例 + 距底边高度"），
 *   高度图与像素必须同源重建，否则会出"堆看不见、却落在半空隐形堆面上"的错位。
 *
 * 春天元素四件，都守同一套安全约定（DPR 预算、触屏降档、reduced-motion 不跑、
 * 页面隐藏时暂停、关掉时连画布都不创建）：
 *   嫩叶  精灵池第二种形状，约 1:4 混落，比花瓣重（落得快、转得慢）
 *   阵风  15–38 秒一次、持续 3–6 秒，只推空中的花瓣（不动花堆，避免重印）
 *   燕子  每 40–85 秒一只横穿画面，带扑翼与起伏，飞完即消失
 *   春光  一层极淡暖光，放在内容之下（负 z-index），不吃正文对比度
 *
 * 与飘雪互斥由 feed.js 的 applyFx() 统一调度，同一时刻只会启用一个。
 */
'use strict';

(function () {
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
  const TOUCH = matchMedia('(hover: none) and (pointer: coarse)');
  const now = () => performance.now();
  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /* ---- 下落 ---- */
  const PER_100K_PX = 13;
  const COUNT_MIN = 26;
  const COUNT_MAX = TOUCH.matches ? 70 : 110;
  const SWAY_MS = [2600, 5400];
  const FALL = [26, 74];
  const SPIN = 0.85;
  const LEAF_RATIO = 0.22;          // 约 1:4 混一片新叶
  const LEAF_FALL = 1.28;           // 叶子重，落得快
  const LEAF_SPIN = 0.5;            // 也转得慢
  const LEAF_SWAY = 0.68;

  /* ---- 阵风 ---- */
  const GUST_EVERY = [15000, 38000];
  const GUST_LEN = [3000, 6000];
  const GUST_PEAK = [26, 68];       // px/s 水平推力峰值

  /* ---- 燕子 ---- */
  const BIRD_FIRST = [6000, 20000];
  const BIRD_EVERY = [40000, 85000];
  const BIRD_SPEED = [95, 150];
  const BIRD_SCALE = 1.5;           // 实测 1.0 时剪影只有 25×19px，在千像素画面里近乎一个点

  /* ---- 堆积（对照 snow.js 同名量，按花瓣特性调过） ---- */
  const COL_W = 9;              // 雪是 7：花瓣更宽，列不必那么细
  const PILE_MAX_VH = 0.11;     // 雪 0.16：花瓣堆得比雪矮，否则会埋掉底部内容
  const PILE_MAX_PX = 90;       // 雪 130
  const PACK = 0.6;             // 雪 1.35：花瓣躺平，一颗只贡献很薄一层
  const PACK_LEAF = 0.8;        // 叶子边缘翘，堆得比花瓣略高
  const REPOSE = 2.4;           // 雪 1.6：扁的东西更容易滑塌摊平
  const SETTLE_MS = 250;
  const STAMP_MAX = TOUCH.matches ? 5200 : 9000;
  const DRIFT_LEN = 0.013;

  let sky = null, skyCtx = null, gnd = null, gndCtx = null;
  let W = 0, H = 0, dpr = 1, cols = 0, ground = null, pileCap = 0;
  let items = [], raf = 0, last = 0, sprites = null, lastSettle = 0;
  /* enabled 是「实际在跑」，wanted 是「用户想要它在跑」，两者必须分开（与 snow.js 同一口径）：
     写成 apply(enabled) 的话，减弱动效开着时 enabled 恒为 false，
     用户之后把系统设置改回去 → apply(false)，桃花永不恢复，只能刷新。 */
  let enabled = false, wanted = false, resizeTimer = 0;
  /* 帧率降级与 snow.js 同一套判据、同一档结论：emaDt 是帧间隔的滑动平均（不用中位数，
     掉帧是双峰的，中位数会骗人），连续 90 帧 >21ms 就锁存成隔帧不画（30Hz）。
     单向锁存不回试的理由也和雪一样：30Hz 档下帧间隔天然≈33ms，任何基于它的
     「有余量」判据都区分不了「我们在隔帧」和「设备跟得上」。 */
  let emaDt = 16.7, slowRun = 0, halfRate = false, lastDraw = 0, frameMs = 12;
  let stX = null, stY = null, stR = null, stA = null, stRot = null, stKind = null;
  let stampHead = 0, stampCount = 0;
  let wind = 0, gustStart = 0, gustLen = 0, gustPeak = 0, windPhase = 0;
  let bird = null, birdNext = 0;

  function bakePetal(size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const x = c.getContext('2d');
    const h = size / 2;
    x.beginPath();
    x.moveTo(h, h * 1.62);
    x.bezierCurveTo(h * 0.18, h * 1.16, h * 0.30, h * 0.30, h * 0.96, h * 0.34);
    x.bezierCurveTo(h * 1.42, h * 0.37, h * 1.70, h * 0.92, h * 1.58, h * 1.24);
    x.bezierCurveTo(h * 1.44, h * 1.62, h * 1.12, h * 1.72, h, h * 1.62);
    x.closePath();
    const g = x.createLinearGradient(h * 0.3, h * 0.3, h * 1.5, h * 1.6);
    g.addColorStop(0, 'rgba(255, 226, 235, 0.98)');
    g.addColorStop(0.55, 'rgba(250, 186, 203, 0.96)');
    g.addColorStop(1, 'rgba(233, 148, 173, 0.92)');
    x.fillStyle = g;
    x.fill();
    x.strokeStyle = 'rgba(255, 245, 248, .55)';
    x.lineWidth = Math.max(1, 1.1 * dpr);
    x.beginPath();
    x.moveTo(h, h * 1.58);
    x.quadraticCurveTo(h * 0.86, h * 1.0, h * 0.98, h * 0.42);
    x.stroke();
    return c;
  }

  /* 嫩叶：细长、两头尖、黄绿到翠绿，比花瓣窄 —— 混在粉色里做对比色 */
  function bakeLeaf(size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const x = c.getContext('2d');
    const h = size / 2;
    x.beginPath();
    x.moveTo(h, h * 0.22);
    x.bezierCurveTo(h * 1.52, h * 0.72, h * 1.42, h * 1.42, h, h * 1.80);
    x.bezierCurveTo(h * 0.58, h * 1.42, h * 0.48, h * 0.72, h, h * 0.22);
    x.closePath();
    const g = x.createLinearGradient(h * 0.5, h * 0.3, h * 1.4, h * 1.7);
    g.addColorStop(0, 'rgba(226, 240, 196, 0.97)');
    g.addColorStop(0.5, 'rgba(168, 213, 133, 0.95)');
    g.addColorStop(1, 'rgba(108, 168, 96, 0.92)');
    x.fillStyle = g;
    x.fill();
    x.strokeStyle = 'rgba(240, 250, 224, .6)';
    x.lineWidth = Math.max(1, 1 * dpr);
    x.beginPath();
    x.moveTo(h, h * 0.30);
    x.lineTo(h, h * 1.72);
    x.stroke();
    return c;
  }

  function bakeSprites() {
    const size = Math.ceil(48 * dpr);
    return { petal: bakePetal(size), leaf: bakeLeaf(size), unit: size / dpr };
  }

  function targetCount() {
    return Math.max(COUNT_MIN, Math.min(COUNT_MAX, Math.round((W * H) / 100000 * PER_100K_PX)));
  }

  /* 深度用「尺寸 + 透明度 + 下落速度」一起表达：只改大小会像同一层里的小点点 */
  function makeItem(anywhere) {
    const z = Math.random();
    const leaf = Math.random() < LEAF_RATIO;
    return {
      kind: leaf ? 1 : 0,
      x: rnd(-40, W + 40),
      y: anywhere ? rnd(0, H * 0.7) : rnd(-90, -10),
      z,
      r: rnd(7, 15) * (0.55 + z * 0.75) * (leaf ? 0.92 : 1),
      rot: rnd(0, Math.PI * 2),
      spin: rnd(-SPIN, SPIN) * (leaf ? LEAF_SPIN : 1),
      fall: (FALL[0] + (FALL[1] - FALL[0]) * (0.35 + z * 0.65)) * (leaf ? LEAF_FALL : 1) * rnd(0.85, 1.15),
      swayA: rnd(12, 46) * (0.5 + z) * (leaf ? LEAF_SWAY : 1),
      swayT: rnd(SWAY_MS[0], SWAY_MS[1]),
      phase: rnd(0, Math.PI * 2),
      alpha: 0.42 + z * 0.5,
      drag: 0.35 + z * 0.9,      // 近处的大花瓣更吃风
    };
  }

  function sync() {
    const want = targetCount();
    while (items.length < want) items.push(makeItem(items.length < want * 0.7));
    if (items.length > want) items.length = want;
  }

  function pickDpr() { return Math.min(TOUCH.matches ? 1.5 : 2, window.devicePixelRatio || 1); }

  function sizeOne(cv, ctx) {
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function initGround() {
    cols = Math.max(8, Math.ceil(W / COL_W));
    ground = new Float32Array(cols);
  }

  function initStamps() {
    stX = new Float32Array(STAMP_MAX); stY = new Float32Array(STAMP_MAX);
    stR = new Float32Array(STAMP_MAX); stA = new Float32Array(STAMP_MAX);
    stRot = new Float32Array(STAMP_MAX); stKind = new Uint8Array(STAMP_MAX);
    stampHead = 0; stampCount = 0;
  }

  /* 迎风侧堆得更高，花垄会自己长出来；相位跟着阵风走，风长期往哪边吹垄就往哪边偏 */
  function driftWeight(x) {
    return 0.72 + 0.5 * (0.5 + 0.5 * Math.sin(x * DRIFT_LEN + windPhase));
  }

  function surfaceAt(x) {
    if (!ground || !cols) return 0;
    const v = ground[clamp(Math.floor(x / COL_W), 0, cols - 1)];
    return Number.isFinite(v) ? v : 0;
  }

  /* 摊到 5 列，避免单颗砸出尖角 */
  function deposit(x, amount) {
    if (!ground) return;
    const i = clamp(Math.floor(x / COL_W), 0, cols - 1);
    const put = (k, w) => { if (k >= 0 && k < cols) ground[k] += amount * w; };
    put(i, 0.3); put(i - 1, 0.18); put(i + 1, 0.18); put(i - 2, 0.08); put(i + 2, 0.08);
  }

  /* 高度图只管"下一片落在多高"，不负责画任何东西 */
  function settle() {
    if (!ground) return;
    for (let i = 1; i < cols; i++) {
      const d = ground[i] - ground[i - 1];
      if (d > REPOSE || d < -REPOSE) { const move = d * 0.34; ground[i] -= move; ground[i - 1] += move; }
    }
    for (let i = 1; i < cols - 1; i++) ground[i] = ground[i] * 0.84 + (ground[i - 1] + ground[i + 1]) * 0.08;
    for (let i = 0; i < cols; i++) {
      const v = ground[i];
      ground[i] = !Number.isFinite(v) ? 0 : v > pileCap ? pileCap : v < 0 ? 0 : v;
    }
  }

  function paint(i) {
    const x = stX[i] * W, y = H - stY[i], r = stR[i];
    const sp = stKind[i] ? sprites.leaf : sprites.petal;
    const u = sprites.unit;
    const k = (r * 2) / u;
    const co = Math.cos(stRot[i]), si = Math.sin(stRot[i]);
    gndCtx.setTransform(dpr * co * k, dpr * si * k, -dpr * si * k, dpr * co * k, dpr * x, dpr * y);
    gndCtx.globalAlpha = stA[i] * 0.92;
    gndCtx.drawImage(sp, -u / 2, -u / 2, u, u);
    gndCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* 落地那一刻永久盖章。躺平：旋转压向水平，只留一点余角，不像贴地砖 */
  function stamp(p, yb) {
    const flat = Math.round(p.rot / Math.PI) * Math.PI;
    stX[stampHead] = p.x / W;
    stY[stampHead] = yb;
    stR[stampHead] = p.r;
    stA[stampHead] = Math.min(1, p.alpha + 0.12);
    stRot[stampHead] = flat + (p.rot - flat) * 0.35;
    stKind[stampHead] = p.kind;
    paint(stampHead);
    stampHead = (stampHead + 1) % STAMP_MAX;
    if (stampCount < STAMP_MAX) stampCount++;
  }

  /* 重印：先回放 deposit() 重建高度图，再把每片画回去。
     两者必须同源——只重画像素会失同步（切回标签页时像素被清空而高度图还在，
     于是花堆看不见、花瓣却落在半空中的隐形堆面上）。 */
  function restampAll() {
    if (!gndCtx || !ground || !sprites) return;
    gndCtx.clearRect(0, 0, W, H);
    ground.fill(0);
    for (let i = 0; i < stampCount; i++) {
      const x = stX[i] * W;
      deposit(x, stR[i] * (stKind[i] ? PACK_LEAF : PACK) * 2 * driftWeight(x));
    }
    for (let k = 0; k < 6; k++) settle();
    for (let i = 0; i < stampCount; i++) paint(i);
  }

  /* ---- 阵风：缓入缓出，只在阵风期间有水平推力 ---- */
  function updateWind(t) {
    if (gustLen === 0 && t >= gustStart) {
      gustLen = rnd(GUST_LEN[0], GUST_LEN[1]);
      gustPeak = rnd(GUST_PEAK[0], GUST_PEAK[1]) * (Math.random() < 0.5 ? -1 : 1);
    }
    if (gustLen > 0) {
      const e = (t - gustStart) / gustLen;
      if (e >= 1) {
        gustLen = 0; wind = 0;
        gustStart = t + rnd(GUST_EVERY[0], GUST_EVERY[1]);
      } else wind = gustPeak * Math.sin(Math.PI * e);
    }
  }

  /* ---- 燕子：一次一只，飞完消失，隔 40–85 秒再来 ---- */
  function updateBird(t, dt) {
    if (!bird && t >= birdNext) {
      const dir = Math.random() < 0.5 ? 1 : -1;
      bird = {
        dir, x: dir > 0 ? -70 : W + 70, y: rnd(H * 0.10, H * 0.42),
        v: rnd(BIRD_SPEED[0], BIRD_SPEED[1]) * dir, s: rnd(0.8, 1.25),
        phase: rnd(0, 6.28), t0: t,
      };
    }
    if (bird) {
      bird.x += bird.v * dt;
      bird.y += Math.sin((t - bird.t0) / 900 + bird.phase) * 26 * dt;   // 起伏
      if (bird.x < -110 || bird.x > W + 110) {
        bird = null;
        birdNext = t + rnd(BIRD_EVERY[0], BIRD_EVERY[1]);
      }
    }
  }

  /* 剪影：身体椭圆 + 剪刀尾 + 两片二次曲线翅膀，扑动时翼尖上下摆。
     只画一只、只在飞行期间画，成本可忽略。 */
  function drawBird(t) {
    if (!bird) return;
    const flap = Math.sin(t / 105 + bird.phase);
    const s = bird.s * BIRD_SCALE * (TOUCH.matches ? 0.82 : 1);
    skyCtx.save();
    skyCtx.translate(bird.x, bird.y);
    skyCtx.scale(bird.dir * s, s);
    skyCtx.fillStyle = 'rgba(58, 68, 84, .82)';
    skyCtx.beginPath();
    skyCtx.ellipse(0, 0, 9, 3.1, 0, 0, Math.PI * 2);
    skyCtx.fill();
    skyCtx.beginPath();
    skyCtx.moveTo(-8, 0); skyCtx.lineTo(-16, -3.4); skyCtx.lineTo(-11, 0); skyCtx.lineTo(-16, 3.4);
    skyCtx.closePath(); skyCtx.fill();
    const wy = -13 * flap;
    skyCtx.beginPath();
    skyCtx.moveTo(-1, -1);
    skyCtx.quadraticCurveTo(-6, wy * 0.6 - 4, 2, wy);
    skyCtx.quadraticCurveTo(6, wy * 0.45, 3, -0.5);
    skyCtx.closePath(); skyCtx.fill();
    skyCtx.beginPath();
    skyCtx.moveTo(-1, 1);
    skyCtx.quadraticCurveTo(-6, -wy * 0.6 + 4, 2, -wy * 0.86);
    skyCtx.quadraticCurveTo(6, -wy * 0.38, 3, 0.5);
    skyCtx.closePath(); skyCtx.fill();
    skyCtx.restore();
  }

  function relayout() {
    if (!enabled || !sky || !gnd) return;   // 特效已关/已摘，迟到的防抖回调不该再动画布
    const oldW = W, oldH = H;
    W = Math.max(1, window.innerWidth || document.documentElement.clientWidth);
    H = Math.max(1, window.innerHeight || document.documentElement.clientHeight);
    dpr = pickDpr();
    pileCap = Math.min(H * PILE_MAX_VH, PILE_MAX_PX);
    sizeOne(sky, skyCtx);
    sizeOne(gnd, gndCtx);
    sprites = bakeSprites();
    const sizeChanged = !ground || W !== oldW || H !== oldH;
    if (sizeChanged) {
      const had = stampCount > 0 && oldW > 0;
      initGround();
      if (had) restampAll();   // 按盖章记录回放，高度图与像素同源重建
      else { stampCount = 0; stampHead = 0; }
    }
    sync();
  }

  /* resize 必须防抖：手机地址栏收放、软键盘开合、旋转屏幕会连发一串 resize，
     每次都要重烘焙精灵并最多回放 9000 个盖章记录（restampAll），逐条处理必然卡顿。
     与 snow.js 同一口径——静默 220ms 后再重排一次。 */
  function resize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(relayout, 220);
  }

  /* 一帧的推进逻辑。与 rAF 解耦成独立函数，是为了能被自检显式调用：
     rAF 走真实时钟，无头环境里 --virtual-time-budget 推不动它，
     堆积与燕子要几十秒才看得见，靠截图时序根本验不了。 */
  function advance(t) {
    const dt = Math.min(64, t - last) / 1000;   // 切回前台可能一次跳很久，夹住避免瞬移
    last = t;
    updateWind(t);
    updateBird(t, dt);
    windPhase += wind * dt * 0.0006;
    if (t - lastSettle > SETTLE_MS) { settle(); lastSettle = t; }
    skyCtx.clearRect(0, 0, W, H);
    for (const p of items) {
      p.y += p.fall * dt;
      p.x += wind * p.drag * dt;                          // 阵风推空中的一切（花堆不动）
      p.rot += p.spin * dt * (1 + Math.abs(wind) / 30);   // 起风时翻得更急
      const sway = Math.sin((t / p.swayT) * Math.PI * 2 + p.phase)
        * p.swayA * (1 + Math.abs(wind) / 90);
      const px = p.x + sway;
      if (px < -80 || px > W + 80) { Object.assign(p, makeItem(false)); continue; }
      const surf = surfaceAt(px);
      if (p.y + p.r * 0.45 >= H - surf) {                 // 落到堆面 → 盖章 + 补一片
        deposit(px, p.r * (p.kind ? PACK_LEAF : PACK) * driftWeight(px));
        stamp(p, Math.max(p.r * 0.35, surf + p.r * 0.35));
        Object.assign(p, makeItem(false));
        continue;
      }
      if (p.y - p.r > H) { Object.assign(p, makeItem(false)); continue; }
      skyCtx.save();
      skyCtx.globalAlpha = p.alpha;
      skyCtx.translate(px, p.y);
      skyCtx.rotate(p.rot);
      // 侧翻时压扁一点，模拟花瓣绕竖直轴转动（纯 2D 也能骗过眼睛）
      const squash = 0.55 + 0.45 * Math.abs(Math.cos(t / 900 + p.phase));
      skyCtx.scale(1, squash);
      const d = p.r * 2;
      skyCtx.drawImage(p.kind ? sprites.leaf : sprites.petal, -d / 2, -d / 2, d, d);
      skyCtx.restore();
    }
    drawBird(t);
  }

  /* 主循环。降级判据放在这里而不是 advance 里：advance 要能被自检 pump() 直接调用，
     那条路径不该被帧率状态影响（无头环境里 rAF 推不动，只能靠 pump 补帧）。 */
  function frame(t) {
    raf = requestAnimationFrame(frame);
    // 30Hz 档隔帧直接返回：跳过时不能碰 last（last 由 advance 内部更新），
    // 否则下一帧拿到的 dt 少算一半，花瓣会掉速一半。
    if (halfRate && t - lastDraw < 31) return;
    lastDraw = t;
    const raw = t - last;      // advance() 会把 last 推到 t，判据必须先用旧值算
    const t0 = now();
    advance(t);
    frameMs = frameMs * 0.9 + (now() - t0) * 0.1;   // 单帧自身耗时，仅作诊断
    emaDt = emaDt * 0.9 + (raw > 0 && raw < 250 ? raw : 16.7) * 0.1;
    slowRun = emaDt > 21 ? slowRun + 1 : 0;
    if (!halfRate && slowRun > 90) { halfRate = true; slowRun = 0; }
  }
  function start() {
    if (raf) return;
    emaDt = 16.7; slowRun = 0; halfRate = false; lastDraw = 0; frameMs = 12;
    last = now(); raf = requestAnimationFrame(frame);
  }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

  function mount() {
    if (sky) return;
    sky = document.createElement('canvas'); sky.id = 'blossom';
    gnd = document.createElement('canvas'); gnd.id = 'blossom-ground';
    [sky, gnd].forEach((n) => n.setAttribute('aria-hidden', 'true'));
    skyCtx = sky.getContext('2d');
    gndCtx = gnd.getContext('2d');
    document.body.appendChild(sky);
    document.body.appendChild(gnd);
    initStamps();
    const t = now();
    gustStart = t + rnd(6000, 16000);
    birdNext = t + rnd(BIRD_FIRST[0], BIRD_FIRST[1]);
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVis);
    relayout();   // 首次量尺直接执行，不能被防抖推迟——否则前 220ms 画布尺寸还是 0
  }

  /* 关掉时三层整个摘掉：不画 ≠ 不占内存，堆里几千片的像素也一并释放 */
  function unmount() {
    stop();
    /* 关掉特效前可能已经排了一个 220ms 的重排：不清掉它，回调会在画布已被摘掉之后跑，
       sizeOne(null) 直接抛异常 */
    clearTimeout(resizeTimer);
    window.removeEventListener('resize', resize);
    document.removeEventListener('visibilitychange', onVis);
    [sky, gnd].forEach((n) => { if (n) n.remove(); });
    sky = skyCtx = gnd = gndCtx = sprites = null;
    ground = null; items = []; bird = null; wind = 0; gustLen = 0;
    stampCount = 0; stampHead = 0;
  }

  function apply(on) {
    wanted = !!on;
    enabled = wanted && !REDUCED.matches;
    if (enabled) { mount(); start(); } else unmount();
  }

  /* 页面不可见时不画，也不推进堆积计时 */
  function onVis() {
    if (!enabled) return;
    if (document.visibilityState === 'visible') { lastSettle = now(); start(); } else stop();
  }

  /* 系统「减弱动态效果」是硬约束，中途改设置要能双向恢复，所以按 wanted 重评。
     老 Safari 的 MediaQueryList 只有 addListener，两条都试（与 snow.js 同一口径）。 */
  const onReduced = () => { if (wanted) apply(wanted); };
  if (REDUCED.addEventListener) REDUCED.addEventListener('change', onReduced);
  else if (REDUCED.addListener) REDUCED.addListener(onReduced);

  window.Blossom = {
    setEnabled: apply,
    /* 只给自检用：把 ms 毫秒的动画按 16ms 一帧补跑完（不占真实时间）。生产路径不调它。 */
    pump: (ms) => {
      if (!gndCtx) return;
      let t = last || now();
      const end = t + ms;
      while (t < end) { t += 16; advance(t); }
      last = t;
    },
    stats: () => ({
      on: enabled, wanted,
      emaDt: +emaDt.toFixed(1), halfRate, frameMs: +frameMs.toFixed(2),
      petals: items.reduce((n, p) => n + (p.kind ? 0 : 1), 0),
      leaves: items.reduce((n, p) => n + (p.kind ? 1 : 0), 0),
      stamps: stampCount, cols,
      pilePx: ground ? Math.round(Math.max.apply(null, Array.from(ground))) : 0,
      cap: Math.round(pileCap),
      wind: Math.round(wind),
      birdX: bird ? Math.round(bird.x) : null,
    }),
  };
})();
