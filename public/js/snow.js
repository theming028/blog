/* 前台飘雪（参考 toolv.com/zh-CN/app/xiaxue-texiao 的「大雪 · 微风」档，只取这一档，不做可调预设）
 *
 * 从参考实现里学到的三点，我这版照做：
 *  1) 雪花不是纯色圆点：小颗是发光软圆点，较大的颗有一定概率画成旋转的六角晶体，
 *     画面层次靠这个而不是靠"多"；
 *  2) 地面积雪单独一张 canvas：它只在雪堆形状变化时重绘（约 8 次/秒），
 *     不跟着雪花层每帧重画，这是参考站的架构，也是省下来的大头；
 *  3) 雪量档决定数量也决定速度，「大雪」在其 80→600 的区间里约为 430 片。
 *
 * 我们页面与参考场景最大的差别：参考是深色夜景（夜空/极光/松林/村庄），发光就够；
 * 我们是白卡片 + 浅灰底，纯白雪粒等于看不见、加对称冷灰外晕又会变成一圈气泡
 * （上一版就是栽在这里）。所以雪粒的轮廓靠"烘焙进精灵里的偏心投影"来给：
 * 阴影往左下偏，白芯在深底上是亮点、在白底上靠投影显形，且不会出现环形边。
 *
 * 性能护栏（这台机器是 Pentium 双核，最坏样本）：
 *  数量按视口面积给并封顶；backing store 的像素预算钉在实测悬崖以下（见 pickDpr）；
 *  页面隐藏撤掉整条 rAF；系统"减弱动态效果"下不启动；
 *  唯一的运行时自适应是"整屏铺不动就降到 30Hz 绘制"这一档，不降分辨率也不减粒子；
 *  两层画布都 pointer-events:none，一律不吃点击。 */
(function () {
  'use strict';

  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
  const TOUCH = matchMedia('(hover: none) and (pointer: coarse)');
  const now = () => performance.now();
  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /* 「大雪」档的数量与速度：参考站 1–4 档约 80/250/430/600 片，取第 3 档。
     速度也按这一档给（雪越大落得越快）。 */
  const HEAVY_COUNT = 430;
  const LAYERS = [
    // r 半径(px)  vy 落速(px/s)  a 不透明度  sway 摆动幅度  soft 精灵外扩倍率
    { r: [0.9, 1.7], vy: [55, 85], a: [0.50, 0.72], sway: [6, 12], soft: 2.4, mix: 0.40, cry: 0 },
    { r: [1.9, 3.1], vy: [95, 140], a: [0.66, 0.86], sway: [10, 18], soft: 2.1, mix: 0.34, cry: 0.14 },
    { r: [3.4, 5.4], vy: [150, 215], a: [0.80, 0.96], sway: [14, 24], soft: 1.8, mix: 0.19, cry: 0.42 },
    // 贴镜头的失焦大团：只负责"雪在脸前"，不参与堆积
    { r: [9, 17], vy: [40, 62], a: [0.10, 0.16], sway: [8, 16], soft: 1.3, mix: 0.07, cry: 0 },
  ];
  const BOKEH = 3;

  /* 「微风」档：参考站风力滑块 −3…+3 取 +1。
     表现为一个稳定的右向基流 + 慢周期阵风调制，幅度远小于落速。 */
  const BREEZE_BASE = 26;     // 右向基流 px/s
  const BREEZE_GUST = 17;     // 慢阵风幅度
  const CRYSTAL_SPIN = 0.9;   // 六角晶体自转 rad/s 上限

  const COL_W = 7;            // 积雪高度图列宽（CSS px）
  const PILE_MAX_VH = 0.16;   // 积雪最多占视口高 16%，再多会埋掉底部评论框
  const PILE_MAX_PX = 130;
  const PILE_FULL_S = 70;     // 约 70 秒堆到上限（与屏宽、密度解耦，见 calibrate）
  const DRIFT_LEN = 0.0105;   // 雪垄的低频空间周期

  let sky = null, skyCtx = null, gnd = null, gndCtx = null;
  let dotSprites = null, crystalSprite = null, pileFill = null, pileShade = null;
  let W = 0, H = 0, dpr = 1, cols = 0, ground = null, pileCap = 0, pileK = 0;
  let flakes = [], target = 0, cap = 0, prewarm = true;
  let raf = 0, lastTs = 0, wind = BREEZE_BASE, landed = 0, landRate = 0;
  let frameMs = 12, settleTick = 0, pileDirty = 0, pileDrawn = -1;
  /* emaDt：帧间隔的滑动平均（不是中位数——掉帧是双峰的，中位数会骗人）。
     halfRate 只有一档：true 表示隔帧不画，即 30Hz。 */
  let emaDt = 16.7, slowRun = 0, fastRun = 0, halfRate = false, lastDraw = 0, lastFlip = 0, tries = 0;
  let enabled = false, resizeTimer = 0;

  function pickDpr() {
    // 先按设备 DPR 封顶，再按总像素预算收一道：4K 屏按 DPR 2 铺满光 clearRect 就能压垮双核
    const hard = TOUCH.matches ? 1.5 : 2;
    /* 预算直接设在"无 GPU 合成"的悬崖以下。本机对照实测：每帧铺 1.83M px 掉到 30fps，
       1.08M px 起就是满 60fps。所以钉在 1.0M（触屏 0.8M）保守起步，
       慢机器或不想看雪的人用后台「设置」里的开关关，而不是让代码自己猜。 */
    const budget = TOUCH.matches ? 0.8e6 : 1.0e6;
    return clamp(Math.min(hard, Math.sqrt(budget / Math.max(1, W * H))), 0.6, hard);
  }

  /* ---- 精灵烘焙 ---- */

  /* 圆点雪粒：先画一层偏左下的冷灰投影，再画白芯。
     投影偏心而不是同心外晕——同心晕在白底上会剩下一个环（上一版的气泡就是这个）。 */
  function bakeDot(L) {
    const unit = L.r[1] * 2 * L.soft;
    const c = document.createElement('canvas');
    c.width = c.height = Math.max(4, Math.ceil(unit * dpr));
    const x = c.getContext('2d');
    const half = c.width / 2;
    const off = half * 0.16;
    const rad = half * 0.86;
    let g = x.createRadialGradient(half - off, half - off, 0, half - off, half - off, rad);
    g.addColorStop(0, 'rgba(146,163,190,.40)');
    g.addColorStop(0.65, 'rgba(146,163,190,.16)');
    g.addColorStop(1, 'rgba(146,163,190,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, c.width, c.height);
    g = x.createRadialGradient(half, half, 0, half, half, rad * 0.92);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.55, 'rgba(252,253,255,.94)');
    g.addColorStop(0.85, 'rgba(240,245,252,.55)');
    g.addColorStop(1, 'rgba(240,245,252,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, c.width, c.height);
    return { canvas: c, unit };
  }

  /* 六角晶体：三条过心主线 + 每臂一对小枝杈 + 中心一点高光。
     同样先描一层偏心投影，保证落在白卡片上仍然看得见。 */
  function bakeCrystal() {
    const size = Math.ceil(64 * dpr);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const x = c.getContext('2d');
    const half = size / 2;
    const R = half * 0.82;
    function draw(ox, oy, color, w) {
      x.save();
      x.translate(half + ox, half + oy);
      x.strokeStyle = color;
      x.lineWidth = w;
      x.lineCap = 'round';
      x.beginPath();
      for (let i = 0; i < 6; i++) {
        const ang = (Math.PI / 3) * i;
        const ex = Math.cos(ang) * R, ey = Math.sin(ang) * R;
        x.moveTo(0, 0); x.lineTo(ex, ey);
        // 每臂一对枝杈：从 0.58R 处向外 35° 分叉
        const bx = Math.cos(ang) * R * 0.58, by = Math.sin(ang) * R * 0.58;
        const bl = R * 0.26;
        for (const s of [-1, 1]) {
          const ba = ang + s * 0.62;
          x.moveTo(bx, by); x.lineTo(bx + Math.cos(ba) * bl, by + Math.sin(ba) * bl);
        }
      }
      x.stroke();
      x.beginPath();
      x.arc(0, 0, R * 0.16, 0, Math.PI * 2);
      x.fillStyle = color;
      x.fill();
      x.restore();
    }
    draw(-R * 0.1, -R * 0.1, 'rgba(146,163,190,.34)', 2.6 * dpr);   // 偏心投影
    draw(0, 0, 'rgba(255,255,255,.96)', 2.1 * dpr);                  // 晶体本体
    return { canvas: c, unit: 64 };
  }

  function bakeAll() {
    dotSprites = LAYERS.map(bakeDot);
    crystalSprite = bakeCrystal();
  }

  /* ---- 粒子 ---- */

  function makeFlake(li, atTop) {
    const L = LAYERS[li];
    const r = rnd(L.r[0], L.r[1]);
    return {
      L: li, x: rnd(0, W), y: atTop ? rnd(-H * 0.4, -8) : rnd(-H * 0.05, H),
      r, vy: rnd(L.vy[0], L.vy[1]) * (0.8 + r / L.r[1] * 0.35),
      a: rnd(L.a[0], L.a[1]),
      ph: rnd(0, Math.PI * 2), fq: rnd(0.5, 1.4), am: rnd(L.sway[0], L.sway[1]),
      wk: rnd(0.6, 1.3),
      // 大颗才有几率是晶体（参考站的说法：较大的雪花有一定几率渲染成六角晶体）
      crystal: Math.random() < L.cry,
      rot: rnd(0, Math.PI * 2), spin: rnd(-CRYSTAL_SPIN, CRYSTAL_SPIN),
    };
  }

  function shares() {
    const out = []; let left = target;
    for (let i = 0; i < LAYERS.length; i++) {
      const n = i === LAYERS.length - 1 ? left : Math.round(target * LAYERS[i].mix);
      out.push(Math.max(0, Math.min(left, n))); left -= out[i];
    }
    return out;
  }

  function tune() {
    const want = shares();
    const have = [0, 0, 0, 0];
    for (let i = 0; i < flakes.length; i++) have[flakes[i].L]++;
    for (let li = LAYERS.length - 1; li >= 0 && have[li] > want[li]; li--) {
      for (let i = flakes.length - 1; i >= 0 && have[li] > want[li]; i--) {
        if (flakes[i].L === li) { flakes.splice(i, 1); have[li]--; }
      }
    }
    for (let li = 0; li < LAYERS.length; li++) {
      // 首屏铺满：一上来就让雪粒分布在整个视口里，否则前十几秒地面一颗都落不到，
      // 画面也像"雪刚开始下"而不是"已经下了一会儿"。
      while (have[li] < want[li]) { flakes.push(makeFlake(li, !prewarm)); have[li]++; }
    }
    prewarm = false; // 放在层循环之外：写在里面就只有第一层被铺满
  }

  /* ---- 尺寸与积雪层 ---- */

  function sizeOne(el, ctx2) {
    el.width = Math.round(W * dpr);
    el.height = Math.round(H * dpr);
    el.style.width = W + 'px';
    el.style.height = H + 'px';
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function sizeCanvas() {
    W = Math.max(1, window.innerWidth || document.documentElement.clientWidth);
    H = Math.max(1, window.innerHeight || document.documentElement.clientHeight);
    dpr = pickDpr();
    sizeOne(sky, skyCtx);
    sizeOne(gnd, gndCtx);
    pileCap = Math.min(H * PILE_MAX_VH, PILE_MAX_PX);
    const g = gndCtx.createLinearGradient(0, H - pileCap, 0, H);
    g.addColorStop(0, 'rgba(255,255,255,.99)');
    g.addColorStop(0.55, 'rgba(250,251,254,.99)');
    g.addColorStop(1, 'rgba(236,241,250,.99)');
    pileFill = g;
    // 雪面上沿的冷灰投影带：白底页面上没有它，雪堆的轮廓会直接消失
    const sh = gndCtx.createLinearGradient(0, H - pileCap - 10, 0, H - pileCap + 2);
    sh.addColorStop(0, 'rgba(146,163,190,0)');
    sh.addColorStop(1, 'rgba(146,163,190,.20)');
    pileShade = sh;
    pileDrawn = -1;
  }

  function initGround() {
    const old = ground, oldCols = cols;
    cols = Math.max(8, Math.ceil(W / COL_W));
    ground = new Float32Array(cols);
    if (!old) return;
    if (oldCols === cols) { ground.set(old); return; }
    for (let i = 0; i < cols; i++) {   // 转屏/地址栏收放时按比例搬过去，别把堆好的雪清空
      const t = (i / (cols - 1)) * (oldCols - 1);
      const a = Math.floor(t), b = Math.min(oldCols - 1, a + 1);
      ground[i] = old[a] + (old[b] - old[a]) * (t - a);
    }
  }

  function driftWeight(x) {
    return 0.7 + 0.6 * (0.5 + 0.5 * Math.sin(x * DRIFT_LEN + wind * 0.02));
  }

  function deposit(x, amount) {
    const i = clamp(Math.floor(x / COL_W), 0, cols - 1);
    // 近似高斯摊到 5 列：只摊 3 列时一颗大颗会在雪面砸出尖角
    const put = (k, w) => { if (k >= 0 && k < cols) ground[k] += amount * w; };
    put(i, 0.3); put(i - 1, 0.18); put(i + 1, 0.18); put(i - 2, 0.08); put(i + 2, 0.08);
  }

  /* 每颗落地给该列抬多少：按 r² 计，系数每次平滑前重标定，
     推导：每秒新增列高 = land·K·meanR2，要它等于 cols·pileCap / PILE_FULL_S。 */
  function calibrate() {
    let land = 0, r2 = 0, n = 0;
    for (let i = 0; i < flakes.length; i++) {
      const f = flakes[i];
      if (f.L === BOKEH) continue;
      land += f.vy / H; r2 += f.r * f.r; n++;
    }
    if (!n || !(land > 0)) { pileK = 0; return; }
    landRate = land;
    pileK = (cols * pileCap) / (PILE_FULL_S * land * (r2 / n));
    if (!Number.isFinite(pileK) || pileK < 0) pileK = 0;
  }

  function settle() {
    calibrate();
    for (let i = 1; i < cols; i++) {           // 雪堆自己垮
      const d = ground[i] - ground[i - 1];
      if (d > 1.6 || d < -1.6) { const move = d * 0.3; ground[i] -= move; ground[i - 1] += move; }
    }
    for (let i = 1; i < cols - 1; i++) ground[i] = ground[i] * 0.8 + (ground[i - 1] + ground[i + 1]) * 0.1;
    for (let i = 0; i < cols; i++) {
      const v = ground[i];
      ground[i] = !Number.isFinite(v) ? 0 : v > pileCap ? pileCap : v < 0 ? 0 : v;
    }
    pileDirty = 1;
  }

  function edgePath(x2) {
    const base = H + 2;
    const y = (i) => base - ground[clamp(i, 0, cols - 1)];
    const px = (i) => clamp(i * COL_W, 0, W);
    x2.moveTo(-2, y(0));
    x2.lineTo(px(0), y(0));
    // 以列点为控制点、相邻列点中点为终点：标准平滑过点，不会啃出凹坑
    for (let i = 1; i < cols - 1; i++) {
      x2.quadraticCurveTo(px(i), y(i), (px(i) + px(i + 1)) / 2, (y(i) + y(i + 1)) / 2);
    }
    x2.quadraticCurveTo(px(cols - 1), y(cols - 1), W + 2, y(cols - 1));
  }

  /* 积雪只在这层重绘，且只在形状变化时（约 8 次/秒），不跟雪花层一起每帧画 */
  function drawPile() {
    const maxH = Math.max.apply(null, ground);
    if (!pileDirty || Math.abs(maxH - pileDrawn) < 0.5 && maxH > 0.5 === pileDrawn > 0.5) return;
    pileDrawn = maxH; pileDirty = 0;
    const x2 = gndCtx;
    x2.clearRect(0, 0, W, H);
    if (maxH < 0.3) return;
    const base = H + 2;
    x2.globalAlpha = 1;
    x2.beginPath(); edgePath(x2); x2.lineTo(W + 2, base); x2.lineTo(-2, base); x2.closePath();
    x2.fillStyle = pileFill; x2.fill();
    // 上沿投影带：先沿雪面描一条略粗的冷灰线，再压一条白线当雪面高光
    x2.beginPath(); edgePath(x2);
    x2.strokeStyle = 'rgba(150,167,193,.30)'; x2.lineWidth = 5; x2.stroke();
    x2.beginPath(); edgePath(x2);
    x2.strokeStyle = 'rgba(255,255,255,1)'; x2.lineWidth = 1.6; x2.stroke();
  }

  /* ---- 主循环 ---- */

  function step() {
    raf = requestAnimationFrame(step);
    const t0 = now();
    // 30Hz 模式下隔帧直接返回：注意 lastTs 不能在这里更新，
    // 否则下一帧拿到的 dt 少算一半，雪会掉速一半。
    if (halfRate && t0 - lastDraw < 31) return;
    lastDraw = t0;
    const raw = t0 - lastTs;
    lastTs = t0;
    let dt = raw / 1000;
    if (!(dt > 0)) dt = 0.016; else if (dt > 0.05) dt = 0.05;   // 切标签页回来的巨大 dt 必须夹住
    const t = t0 / 1000;

    const want = cap;
    if (want !== target) { target = want; tune(); }

    // 微风：右向基流 + 慢阵风，幅度始终远小于落速
    wind = BREEZE_BASE + Math.sin(t * 0.11) * BREEZE_GUST + Math.sin(t * 0.43 + 1.2) * 4;

    skyCtx.clearRect(0, 0, W, H);

    // 先画所有圆点（无需 transform），再画需要旋转的晶体，避免逐颗 save/restore
    let crystals = null;
    for (let i = 0; i < flakes.length; i++) {
      const f = flakes[i], L = LAYERS[f.L];
      const depth = 0.45 + f.r / L.r[1];
      f.x += (wind * f.wk * depth + Math.sin(t * f.fq + f.ph) * f.am * depth) * dt;
      f.y += f.vy * dt;
      if (f.x < -30) f.x += W + 60; else if (f.x > W + 30) f.x -= W + 60;

      const ci = f.x < 0 ? 0 : f.x > W ? cols - 1 : Math.floor(f.x / COL_W);
      if (f.y >= H - ground[ci] - f.r * 0.35) {
        if (f.L !== BOKEH) { landed++; deposit(f.x, pileK * f.r * f.r * driftWeight(f.x)); }
        flakes[i] = makeFlake(f.L, true);
        continue;
      }
      if (f.crystal) { if (!crystals) crystals = []; crystals.push(f); continue; }
      skyCtx.globalAlpha = f.a;
      const d = f.r * 2 * L.soft;
      skyCtx.drawImage(dotSprites[f.L].canvas, f.x - d * 0.5, f.y - d * 0.5, d, d);
    }
    if (crystals) {
      const cs = crystalSprite, s = cs.unit;
      for (let i = 0; i < crystals.length; i++) {
        const f = crystals[i];
        f.rot += f.spin * dt;
        const d = f.r * 2 * 1.55;                       // 晶体本体比等径圆点"占地方"小，外扩给投影留位
        const k = d / s;
        skyCtx.setTransform(dpr * Math.cos(f.rot) * k, dpr * Math.sin(f.rot) * k,
          -dpr * Math.sin(f.rot) * k, dpr * Math.cos(f.rot) * k, dpr * f.x, dpr * f.y);
        skyCtx.globalAlpha = f.a;
        skyCtx.drawImage(cs.canvas, -s / 2, -s / 2, s, s);
      }
      skyCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    settleTick += dt;
    if (settleTick > 0.12) { settle(); drawPile(); settleTick = 0; }

    const ms = now() - t0;
    frameMs = frameMs * 0.9 + ms * 0.1;      // step 自身耗时，仅作诊断
    /* 判据：真实帧间隔。>21ms 说明整屏图层每帧铺不出来；<15ms 说明有余量。
       两个方向都要连续够久才动作，且只允许动 halfRate 这一个开关。 */
    emaDt = emaDt * 0.9 + (raw > 0 && raw < 250 ? raw : 16.7) * 0.1;
    /* 阈值跟着当前档位走：60Hz 档下 >21ms 才算铺不动、<15ms 才算有余量；
       30Hz 档下期望值本来就是≈33ms，得用 <40ms 判"跟得上"，否则永远回不去。 */
    slowRun = emaDt > (halfRate ? 45 : 21) ? slowRun + 1 : 0;
    fastRun = emaDt < (halfRate ? 40 : 15) ? fastRun + 1 : 0;
    if (!halfRate && slowRun > 60 && t0 - lastFlip > 2000) {
      halfRate = true; lastFlip = t0; slowRun = 0;      // 试探后又不行 → 计数已在升档时加过
    } else if (halfRate && tries < 2 && fastRun > 240 && t0 - lastFlip > 8000) {
      halfRate = false; tries++; lastFlip = t0; fastRun = 0;   // 最多回试两次，避免来回抖
    }
  }

  function measureCap() {
    // 「大雪」档的绝对数量，按视口面积折算；触屏再压一档，窄屏不该和 4K 一样密
    const ref = 1440 * 900;
    const byArea = Math.round(HEAVY_COUNT * clamp((W * H) / ref, 0.28, 1.15));
    return Math.max(60, TOUCH.matches ? Math.round(byArea * 0.62) : byArea);
  }

  function start() {
    if (!sky || raf) return;
    sizeCanvas(); initGround(); bakeAll();
    cap = measureCap(); target = 0; prewarm = true;
    emaDt = 16.7; slowRun = 0; fastRun = 0; halfRate = false; tries = 0; lastDraw = 0; lastFlip = now();
    settleTick = 0; landed = 0;
    lastTs = now();
    raf = requestAnimationFrame(step);
  }

  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  function mount() {
    if (sky) return;
    sky = document.createElement('canvas'); sky.id = 'snow';
    gnd = document.createElement('canvas'); gnd.id = 'snow-ground';
    sky.setAttribute('aria-hidden', 'true');
    gnd.setAttribute('aria-hidden', 'true');
    document.body.appendChild(sky);
    document.body.appendChild(gnd);
    skyCtx = sky.getContext('2d', { alpha: true });
    gndCtx = gnd.getContext('2d', { alpha: true });
  }

  function unmount() {
    stop();
    [sky, gnd].forEach((el) => { if (el && el.parentNode) el.parentNode.removeChild(el); });
    sky = skyCtx = gnd = gndCtx = null; dotSprites = crystalSprite = pileFill = pileShade = null;
    ground = null; flakes = []; target = cap = 0;
  }

  function relayout() {
    if (!enabled || !sky) return;
    sizeCanvas(); initGround(); bakeAll(); cap = measureCap();
    pileDrawn = -1; settle(); drawPile();
  }

  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(relayout, 220); });

  // 页面不可见时撤掉整条循环，不是"看不见但继续跑"
  document.addEventListener('visibilitychange', () => {
    if (!enabled) return;
    if (document.hidden) stop(); else { lastTs = now(); start(); }
  });

  // 系统"减弱动态效果"是硬约束；中途改系统设置也立刻响应
  const onReduced = () => { if (enabled) apply(enabled); };
  if (REDUCED.addEventListener) REDUCED.addEventListener('change', onReduced);
  else if (REDUCED.addListener) REDUCED.addListener(onReduced);

  function apply(on) {
    enabled = !!on && !REDUCED.matches;
    if (enabled) { mount(); start(); } else unmount();
  }

  window.Snow = {
    setEnabled: apply,
    // 只读快照，给排障与探针用，不参与渲染路径
    stats: () => ({
      on: enabled, flakes: flakes.length, cap, target,
      dpr: +dpr.toFixed(2), frameMs: +frameMs.toFixed(2), emaDt: +emaDt.toFixed(1), halfRate,
      cols, landed,
      crystals: flakes.reduce((a, f) => a + (f.crystal ? 1 : 0), 0),
      pileMax: ground ? Math.round(Math.max.apply(null, ground)) : 0,
      wind: Math.round(wind),
    }),
  };
})();
