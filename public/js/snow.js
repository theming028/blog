/* 前台飘雪（参考 toolv.com/zh-CN/app/xiaxue-texiao 的「大雪 · 微风」档，只取这一档，不做可调预设）
 *
 * 从参考实现里学到的三点，这版照做：
 *  1) 雪花不是纯色圆点：小颗是软圆点，较大的颗有一定概率画成旋转的六角晶体，
 *     画面层次靠这个而不是靠"多"；
 *  2) 地面积雪单独一张 canvas，且每帧完全不重绘：每颗雪粒落地时把自己按原形状、
 *     大小、透明度、旋转角永久「盖印」上去，积雪层只在落地与视口尺寸变化时被写。
 *     这既是堆出来的形状来源，也是省下来的大头（实测稳态 4 秒内积雪层 clearRect 0 次）；
 *  3) 雪量档同时决定数量与速度，「大雪」在其 80→600 片的区间里约为 430 片。
 *
 * 我们页面与参考场景最大的差别：参考是深色夜景（夜空/极光/松林/村庄），发光就够；
 * 我们是白卡片 + 浅灰底，纯白雪粒等于看不见、加对称冷灰外晕又会变成一圈气泡
 * （上一版就是栽在这里）。所以雪粒的轮廓靠「烘焙进精灵里的偏心投影」来给：
 * 阴影往左上偏（代码里是 half - off），白芯在深底上是亮点、在白底上靠投影显形，
 * 且不会出现环形边。
 *
 * 性能护栏（这台机器是 Pentium 双核且 GPU 合成被策略禁用，是最坏样本）：
 *  数量按视口面积给并封顶；backing store 的像素预算钉在实测悬崖以下（见 pickDpr）；
 *  页面隐藏撤掉整条 rAF；系统「减弱动态效果」下不启动；
 *  唯一的运行时自适应是「整屏铺不动就降到 30Hz 绘制」，单向锁存到下次刷新
 *  （不降分辨率、不减粒子，也不回试——30Hz 档下帧间隔天然≈33ms，
 *   任何基于帧间隔的「有余量」判据都无法区分「是我们在隔帧」和「设备真跟得上」）；
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
    // r 半径(px)  vy 落速(px/s)  a 不透明度  sway 摆动幅度  soft 精灵外扩倍率  mix 占比  cry 成晶体概率
    { r: [0.9, 1.7], vy: [55, 85], a: [0.50, 0.72], sway: [6, 12], soft: 2.4, mix: 0.40, cry: 0 },
    { r: [1.9, 3.1], vy: [95, 140], a: [0.66, 0.86], sway: [10, 18], soft: 2.1, mix: 0.34, cry: 0.14 },
    { r: [3.4, 5.4], vy: [150, 215], a: [0.80, 0.96], sway: [14, 24], soft: 1.8, mix: 0.19, cry: 0.42 },
    // 贴镜头的失焦大团：只负责"雪在脸前"，不参与堆积
    { r: [9, 17], vy: [40, 62], a: [0.10, 0.16], sway: [8, 16], soft: 1.3, mix: 0.07, cry: 0 },
  ];
  const BOKEH = 3;
  const NL = LAYERS.length;

  /* 「微风」档：参考站风力滑块 −3…+3 取 +1，表现为右向基流 + 慢周期阵风。
     用户看过实机后要求加大一档：基流 26→42 px/s、慢阵风 ±17→±24。
     仍远小于最近层落速（150–215 px/s），所以是"斜着飘"而不是"横着吹"。 */
  const BREEZE_BASE = 42;     // 右向基流 px/s
  const BREEZE_GUST = 24;     // 慢阵风幅度
  const CRYSTAL_SPIN = 0.9;   // 六角晶体自转 rad/s 上限

  const COL_W = 7;            // 积雪高度图列宽（CSS px）
  const PILE_MAX_VH = 0.16;   // 积雪最多占视口高 16%，再多会埋掉底部内容
  const PILE_MAX_PX = 130;
  /* 每颗雪粒把自己那一列抬高「自身高度的 PACK 倍」。
     上一版按"70 秒堆满"反推体积系数，结果堆叠轮廓比画出来的雪粒密得多，
     只能再补一条平滑雪带才像样——那条雪带就是被判"太假"的东西。
     现在堆叠高度与盖印形状是同一件事，不需要标定：实测约 2–3 分钟堆到上限。 */
  const PACK = 1.35;
  /* 盖印记录环形缓冲上限。实测落地约 41 次/秒，12000 条覆盖≈4.9 分钟，
     而堆到上限要 2–3 分钟——必须留够余量，否则 resize 重印只能恢复顶上那一截。
     用类型化数组而非对象数组：12000 个对象约 1.3MB 且是 12000 次分配，
     类型化数组约 276KB 且一次分配完。 */
  const STAMP_MAX = 12000;
  const DRIFT_LEN = 0.0105;   // 雪垄的低频空间周期

  let sky = null, skyCtx = null, gnd = null, gndCtx = null;
  let dotSprites = null, crystalSprite = null;
  let W = 0, H = 0, dpr = 1, cols = 0, ground = null, pileCap = 0;
  let flakes = [], target = 0, cap = 0, prewarm = true;
  let raf = 0, lastTs = 0, wind = BREEZE_BASE, landed = 0;
  // 每条盖印记录：层号、横向位置(视口宽度比例)、距底边高度、半径、透明度、旋转角、是否晶体
  let stL = null, stX = null, stY = null, stR = null, stA = null, stRot = null, stCry = null;
  let stampHead = 0, stampCount = 0;
  let frameMs = 12, settleTick = 0;
  /* emaDt：帧间隔的滑动平均（不是中位数——掉帧是双峰的，中位数会骗人）。
     halfRate 只有一档：true 表示隔帧不画，即 30Hz。 */
  let emaDt = 16.7, slowRun = 0, halfRate = false, lastDraw = 0;
  /* enabled 是「实际在跑」，wanted 是「用户想要它在跑」，两者必须分开：
     上一版 onReduced 里写 if (enabled) apply(enabled)，而 enabled 在减弱动效开着时恒为 false，
     于是用户把系统设置改回去之后雪永远回不来，只能刷新。 */
  let enabled = false, wanted = false, resizeTimer = 0;

  function pickDpr() {
    // 先按设备 DPR 封顶，再按总像素预算收一道：4K 屏按 DPR 2 铺满光 clearRect 就能压垮双核
    const hard = TOUCH.matches ? 1.5 : 2;
    /* 预算钉在「无 GPU 合成」的悬崖以下。本机对照实测：每帧铺 1.83M px 掉到 30fps，
       1.08M px 起就是满 60fps。宁可从保守值起步；慢机器或不想看雪的人用后台
       「设置」里的开关关，而不是让代码自己猜。 */
    const budget = TOUCH.matches ? 0.8e6 : 1.0e6;
    return clamp(Math.min(hard, Math.sqrt(budget / Math.max(1, W * H))), 0.6, hard);
  }

  /* ---- 精灵烘焙 ---- */

  /* 圆点雪粒：先画一层偏左上的冷灰投影，再画白芯。
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
    return c;
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
        // 每臂一对枝杈：从 0.58R 处向外分叉
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
    for (let i = 0; i < NL; i++) {
      const n = i === NL - 1 ? left : Math.round(target * LAYERS[i].mix);
      out.push(Math.max(0, Math.min(left, n))); left -= out[i];
    }
    return out;
  }

  /* 补/退粒子到目标数。降级时从最费像素的近层与 bokeh 先撤。 */
  function tune() {
    const want = shares();
    const have = new Array(NL).fill(0);   // 硬编码长度会在加第 5 层时静默不产粒
    for (let i = 0; i < flakes.length; i++) have[flakes[i].L]++;
    /* 判据只放在内层。上一版把 have[li] > want[li] 也写进外层 for 条件，
       于是只要最上层不超发，外层就直接终止、下面几层永不检查（cap 微降时基本不删）。 */
    for (let li = NL - 1; li >= 0; li--) {
      for (let i = flakes.length - 1; i >= 0 && have[li] > want[li]; i--) {
        if (flakes[i].L === li) { flakes.splice(i, 1); have[li]--; }
      }
    }
    for (let li = 0; li < NL; li++) {
      // 首屏铺满：一上来就让雪粒分布在整个视口里，否则前十几秒地面一颗都落不到，
      // 画面也像"雪刚开始下"而不是"已经下了一会儿"。
      while (have[li] < want[li]) { flakes.push(makeFlake(li, !prewarm)); have[li]++; }
    }
    prewarm = false; // 放在层循环之外：写在里面就只有第一层被铺满
  }

  /* ---- 尺寸、高度图与盖印 ---- */

  function sizeOne(el, ctx2) {
    // 用 ceil：每帧 clearRect 覆盖 W×H CSS px，若 backing store 向下取整，
    // dpr 非整数时右缘与下缘会留下不到 1px 从不被清的旧像素。
    el.width = Math.ceil(W * dpr);
    el.height = Math.ceil(H * dpr);
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
  }

  function initGround() {
    cols = Math.max(8, Math.ceil(W / COL_W));
    ground = new Float32Array(cols);
  }

  /* 迎风侧堆得更高：给落点乘一个低频权重，雪垄会自己长出来 */
  function driftWeight(x) {
    return 0.7 + 0.6 * (0.5 + 0.5 * Math.sin(x * DRIFT_LEN + wind * 0.012));
  }

  function deposit(x, amount) {
    const i = clamp(Math.floor(x / COL_W), 0, cols - 1);
    // 摊到 5 列，避免单颗砸出尖角；amount 已经是"自身高度"量级
    const put = (k, w) => { if (k >= 0 && k < cols) ground[k] += amount * w; };
    put(i, 0.3); put(i - 1, 0.18); put(i + 1, 0.18); put(i - 2, 0.08); put(i + 2, 0.08);
  }

  /* 高度图只管"下一颗落在多高"，不再负责画任何东西：
     相邻列高差过大就下滑 + 轻微平滑 + 封顶。每 0.25 秒跑一次即可。 */
  function settle() {
    for (let i = 1; i < cols; i++) {
      const d = ground[i] - ground[i - 1];
      if (d > 1.6 || d < -1.6) { const move = d * 0.3; ground[i] -= move; ground[i - 1] += move; }
    }
    for (let i = 1; i < cols - 1; i++) ground[i] = ground[i] * 0.86 + (ground[i - 1] + ground[i + 1]) * 0.07;
    for (let i = 0; i < cols; i++) {
      const v = ground[i];
      ground[i] = !Number.isFinite(v) ? 0 : v > pileCap ? pileCap : v < 0 ? 0 : v;
    }
  }

  function initStamps() {
    stL = new Uint8Array(STAMP_MAX); stCry = new Uint8Array(STAMP_MAX);
    stX = new Float32Array(STAMP_MAX); stY = new Float32Array(STAMP_MAX);
    stR = new Float32Array(STAMP_MAX); stA = new Float32Array(STAMP_MAX); stRot = new Float32Array(STAMP_MAX);
    stampHead = 0; stampCount = 0;
  }

  const stampD = (i) => stCry[i] ? stR[i] * 2 * 1.55 : stR[i] * 2 * LAYERS[stL[i]].soft;

  function paint(i) {
    // 位置存成「宽度比例 + 距底边高度」：换视口后重印，雪堆仍贴着新的底边、按新的宽度铺开，
    // 而不是带着旧视口的绝对坐标错位。
    const x = stX[i] * W, y = H - stY[i], d = stampD(i);
    if (stCry[i]) {
      const u = crystalSprite.unit, k = d / u, co = Math.cos(stRot[i]), si = Math.sin(stRot[i]);
      gndCtx.setTransform(dpr * co * k, dpr * si * k, -dpr * si * k, dpr * co * k, dpr * x, dpr * y);
      gndCtx.globalAlpha = stA[i];
      gndCtx.drawImage(crystalSprite.canvas, -u / 2, -u / 2, u, u);
      gndCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    } else {
      gndCtx.globalAlpha = stA[i];
      gndCtx.drawImage(dotSprites[stL[i]], x - d * 0.5, y - d * 0.5, d, d);
    }
  }

  /* 把落下的雪粒按它自己的形状、大小、透明度、角度永久画进积雪层。
     yb 是"距底边多高"，由调用方从当前雪面算出。 */
  function stamp(f, yb) {
    stL[stampHead] = f.L; stCry[stampHead] = f.crystal ? 1 : 0;
    stX[stampHead] = f.x / W; stY[stampHead] = yb; stR[stampHead] = f.r;
    stA[stampHead] = f.a; stRot[stampHead] = f.rot;
    paint(stampHead);
    stampHead = (stampHead + 1) % STAMP_MAX;
    if (stampCount < STAMP_MAX) stampCount++;
  }

  /* 重印：先按记录回放 deposit() 重建高度图，再把每颗雪粒画回去。
     两者必须同源——上一版只重画像素、高度图另走一条等比重采样的路，会失同步：
     切标签页回来时像素被 sizeOne 清空而高度图原样保留，于是雪堆看不见、
     但 surface 仍按老高度算，雪粒落在半空中的隐形雪面上。 */
  function restampAll() {
    if (!gndCtx || !stL || !ground) return;
    gndCtx.clearRect(0, 0, W, H);
    ground.fill(0);
    for (let i = 0; i < stampCount; i++) {
      const x = stX[i] * W;
      deposit(x, stR[i] * PACK * driftWeight(x));
    }
    for (let k = 0; k < 6; k++) settle();     // 回放时补几轮垮塌，逼近历史形状
    for (let i = 0; i < stampCount; i++) paint(i);
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

    /* 两趟遍历：第一趟算物理并画圆点（无需 transform），第二趟专画要旋转的晶体。
       上一版为了"避免逐颗 save/restore"把晶体收进一个临时数组，结果每帧新建一个数组
       （约 54 个元素 × 60 次/秒），正好违反本文件自己写的"运行期零分配"。 */
    for (let i = 0; i < flakes.length; i++) {
      const f = flakes[i], L = LAYERS[f.L];
      const depth = 0.45 + f.r / L.r[1];
      f.x += (wind * f.wk * depth + Math.sin(t * f.fq + f.ph) * f.am * depth) * dt;
      f.y += f.vy * dt;
      if (f.x < -30) f.x += W + 60; else if (f.x > W + 30) f.x -= W + 60;

      const ci = f.x < 0 ? 0 : f.x > W ? cols - 1 : Math.floor(f.x / COL_W);
      const surface = H - ground[ci];
      if (f.y >= surface - f.r * 0.35) {
        if (f.L !== BOKEH) {
          landed++;
          // 停在雪面上：中心落在面下 self 半径附近，看起来是"压进去"而不是浮着
          stamp(f, ground[ci] + f.r * 0.55);
          deposit(f.x, f.r * PACK * driftWeight(f.x));
        }
        flakes[i] = makeFlake(f.L, true);
        continue;
      }
      if (f.crystal) continue;
      skyCtx.globalAlpha = f.a;
      const d = f.r * 2 * L.soft;
      skyCtx.drawImage(dotSprites[f.L], f.x - d * 0.5, f.y - d * 0.5, d, d);
    }
    {
      const cs = crystalSprite, s = cs.unit;
      for (let i = 0; i < flakes.length; i++) {
        const f = flakes[i];
        if (!f.crystal) continue;
        f.rot += f.spin * dt;
        const d = f.r * 2 * 1.55;                 // 晶体本体比等径圆点"占地方"小，外扩给投影留位
        const k = d / s;
        skyCtx.setTransform(dpr * Math.cos(f.rot) * k, dpr * Math.sin(f.rot) * k,
          -dpr * Math.sin(f.rot) * k, dpr * Math.cos(f.rot) * k, dpr * f.x, dpr * f.y);
        skyCtx.globalAlpha = f.a;
        skyCtx.drawImage(cs.canvas, -s / 2, -s / 2, s, s);
      }
      skyCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // 高度图只需慢慢整平，不需要重画任何像素（积雪层的像素是盖印上去的）
    settleTick += dt;
    if (settleTick > 0.25) { settle(); settleTick = 0; }

    const ms = now() - t0;
    frameMs = frameMs * 0.9 + ms * 0.1;      // step 自身耗时，仅作诊断
    /* 判据：真实帧间隔。>21ms 说明整屏半透明图层每帧铺不出来（本机实测是合成开销，
       与 backing store 分辨率无关）。单向锁存：降到 30Hz 后保持到下次刷新，
       重新加载会重新按 60Hz 起测。不回试是因为帧间隔在 30Hz 档下天然≈33ms，
       任何基于它的「有余量」判据都区分不了「我们在隔帧」和「设备跟得上」。 */
    emaDt = emaDt * 0.9 + (raw > 0 && raw < 250 ? raw : 16.7) * 0.1;
    slowRun = emaDt > 21 ? slowRun + 1 : 0;
    if (!halfRate && slowRun > 90) { halfRate = true; slowRun = 0; }
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
    emaDt = 16.7; slowRun = 0; halfRate = false; lastDraw = 0;
    settleTick = 0; landed = 0;
    lastTs = now();
    // sizeOne 重写 canvas.width 会清空积雪层的全部像素，而切标签页回来走的正是这条路
    // （visibilitychange → start）。不重印就会出现"雪堆消失、高度图还在"的隐形雪面。
    // 首次启动时记录为空，这里等价于空操作。
    restampAll();
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
    initStamps();
    skyCtx = sky.getContext('2d', { alpha: true });
    gndCtx = gnd.getContext('2d', { alpha: true });
  }

  function unmount() {
    stop();
    [sky, gnd].forEach((el) => { if (el && el.parentNode) el.parentNode.removeChild(el); });
    sky = skyCtx = gnd = gndCtx = null; dotSprites = crystalSprite = null;
    ground = null; flakes = []; stL = stX = stY = stR = stA = stRot = stCry = null;
    stampCount = 0; target = cap = 0;
  }

  function relayout() {
    if (!enabled || !sky) return;
    sizeCanvas(); initGround(); bakeAll(); cap = measureCap();
    // 画布尺寸一变像素就没了：按记录重建高度图并把堆好的雪重新印出来
    restampAll();
  }

  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(relayout, 220); });

  // 页面不可见时撤掉整条循环，不是"看不见但继续跑"
  document.addEventListener('visibilitychange', () => {
    if (!enabled) return;
    if (document.hidden) stop(); else { lastTs = now(); start(); }
  });

  /* 系统"减弱动态效果"是硬约束；中途改系统设置要能双向响应，所以按 wanted 重评。
     老 Safari 的 MediaQueryList 只有 addListener，两条都试。 */
  const onReduced = () => { if (wanted) apply(wanted); };
  if (REDUCED.addEventListener) REDUCED.addEventListener('change', onReduced);
  else if (REDUCED.addListener) REDUCED.addListener(onReduced);

  function apply(on) {
    wanted = !!on;
    enabled = wanted && !REDUCED.matches;
    if (enabled) { mount(); start(); } else unmount();
  }

  window.Snow = {
    setEnabled: apply,
    // 只读快照，给排障与探针用，不参与渲染路径
    stats: () => ({
      on: enabled, wanted, flakes: flakes.length, cap, target,
      dpr: +dpr.toFixed(2), frameMs: +frameMs.toFixed(2), emaDt: +emaDt.toFixed(1), halfRate,
      cols, landed, stamps: stampCount,
      crystals: flakes.reduce((a, f) => a + (f.crystal ? 1 : 0), 0),
      pileMax: ground ? Math.round(Math.max.apply(null, ground)) : 0,
      wind: Math.round(wind),
    }),
  };
})();
