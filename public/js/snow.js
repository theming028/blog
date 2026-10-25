/* 前台飘雪：三层景深 + 大颗焦外 + 底部积雪。仅 index.html 引用，开关在后台「设置」。
 *
 * 性能约定（这台机器是 Pentium 双核，"看着还行"的写法必须给出实测帧时）：
 *  - 全程一张全屏 canvas，逐帧只做一次 clearRect + N 次 drawImage，不实时算渐变/阴影/filter；
 *    雪花的软边缘靠烘焙精灵时的径向渐变完成，每帧只贴图；
 *  - backing store 有总像素预算（4K 屏不许按 DPR 2 铺满），粒子数按视口面积算并封顶；
 *  - 自适应降级：帧时连续超预算就一档档减粒子，宽裕了再一档档放回去（带迟滞，防抖来抖去）；
 *  - 不逐帧读 DOM（尺寸只在 resize 防抖后取一次），不在循环里 new 对象；
 *  - 页面隐藏时整条 rAF 撤掉，不是"看不见但继续跑"；
 *  - 系统"减弱动态效果"下直接不启动。 */
(function () {
  'use strict';

  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
  const TOUCH = matchMedia('(hover: none) and (pointer: coarse)');
  const now = () => performance.now();
  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /* 景深层。far 最小最暗最慢（视差靠速度差体现），mid 是主体，near 大而软，
     bokeh 是贴到镜头前的失焦大团——只画前三种会像撒糖霜，有这几颗糊掉的大白点
     才有"雪在脸前飘"的空间感。 */
  const LAYERS = [
    { r: [1.0, 1.9], sp: [16, 26], a: [0.46, 0.64], sway: [7, 14], soft: 2.6, mix: 0.42 },
    { r: [2.2, 3.6], sp: [30, 46], a: [0.66, 0.86], sway: [12, 22], soft: 2.1, mix: 0.34 },
    { r: [4.2, 6.4], sp: [56, 82], a: [0.76, 0.94], sway: [18, 30], soft: 1.7, mix: 0.18 },
    { r: [11, 20], sp: [26, 40], a: [0.10, 0.17], sway: [10, 18], soft: 1.25, mix: 0.06 },
  ];
  const BOKEH = 3; // 最后一层的下标：它不参与堆积（前景虚化的雪不是落在地上）

  const RAMP_MS = 90000;     // 约 90 秒从 25% 密度爬到 100%：越飘越多，但有上限
  const START_MIX = 0.25;
  const COL_W = 7;           // 积雪高度图列宽（CSS px）
  const PILE_MAX_VH = 0.16;  // 积雪最多占视口高 16%，再多就把底部评论框埋了
  const PILE_MAX_PX = 130;
  /* 每颗雪粒落地给该列抬高多少：按 r² 计（大颗多占体积），系数 K 每次 settle 前
     按当前粒子群重算，让"堆满上限"这件事与屏宽、密度、层配比解耦。
     推导：设每秒落地 land 次、平均 r² 为 meanR2，则每秒新增列高 = land·K·meanR2，
     要它等于 cols·pileCap / PILE_FULL_S ⇒ K = cols·pileCap / (PILE_FULL_S·land·meanR2)。
     第一版没做这条标定，直接写死"每颗加 0.22+r·0.045 px"：1280×900 下有 183 列、
     满密度约 4.9 次落地/秒，堆到 130px 要一万一千秒——探针截图里积雪恒为 0，就是这个。 */
  const PILE_FULL_S = 75;
  /* 雪不是均匀铺平的：用一个低频正弦给落点加权，风大的那边堆得高，
     才会自己长出几道雪垄；不加这一条，积雪是一整条齐平的白带，一眼假。 */
  const DRIFT_LEN = 0.0105;

  let cv = null, ctx = null, sprites = null, pileFill = null;
  let W = 0, H = 0, dpr = 1, cols = 0, ground = null, pileCap = 0, pileK = 0;
  let flakes = [], target = 0, cap = 0, degrade = 1;
  let raf = 0, lastTs = 0, bootTs = 0, wind = 0, landed = 0, landRate = 0, prewarm = true;
  let frameMs = 12, slowFor = 0, fastFor = 0, settleTick = 0;
  let enabled = false, resizeTimer = 0;

  function pickDpr() {
    // 先按设备 DPR 封顶，再按"总像素预算"收一道：3840×2160 上按 DPR 2 铺满是 1600 万像素，
    // 光 clearRect 就能把这台双核机器打死；预算之外一律降采样（雪花是糊的，看不出损失）。
    const hard = TOUCH.matches ? 1.5 : 2;
    const budget = TOUCH.matches ? 1.7e6 : 3.0e6;
    const byArea = Math.sqrt(budget / Math.max(1, W * H));
    return clamp(Math.min(hard, byArea), 0.75, hard);
  }

  /* 每层烘焙一张软边精灵（中心实心、外缘淡出）。用 canvas 而不是 <img>：
     免解码、也不碰 CSP 的 img-src。soft 越小边缘越炸开（失焦感）。 */
  function bakeSprites() {
    sprites = LAYERS.map((L) => {
      const unit = L.r[1] * 2 * L.soft;
      const c = document.createElement('canvas');
      c.width = c.height = Math.max(2, Math.ceil(unit * dpr));
      const x = c.getContext('2d');
      const half = c.width / 2;
      const g = x.createRadialGradient(half, half, 0, half, half, half);
      /* 雪粒配色：透明度从圆心单调递减，且圆心不是纯白而是冷白。
         前两版都栽在这条上——先试"纯白芯 + 冷灰外晕"，再试"高光芯 + 灰圈"，
         在白卡片上纯白部分等于透明、只剩灰部分可见，于是每颗雪都变成一个气泡环
         （截图里那些甜甜圈）。冷白实心在白底上是一枚软灰点，在深色封面上仍是亮斑，
         两头都不成环。 */
      g.addColorStop(0, 'rgba(240,245,252,.95)');
      g.addColorStop(clamp(0.42 / (L.soft * 0.42), 0.2, 0.62), 'rgba(222,232,246,.55)');
      g.addColorStop(1, 'rgba(210,222,240,0)');
      x.fillStyle = g;
      x.fillRect(0, 0, c.width, c.height);
      return { canvas: c, unit };
    });
  }

  function makeFlake(li, atTop) {
    const L = LAYERS[li];
    return {
      L: li,
      x: rnd(0, W),
      y: atTop ? rnd(-H * 0.4, -6) : rnd(-H * 0.05, H),
      r: rnd(L.r[0], L.r[1]),
      vy: rnd(L.sp[0], L.sp[1]),
      a: rnd(L.a[0], L.a[1]),
      // 相位/频率各颗不同，否则整层会像一块布一起晃
      ph: rnd(0, Math.PI * 2),
      fq: rnd(0.55, 1.5),
      am: rnd(L.sway[0], L.sway[1]),
      // 对风的响应系数逐颗抖动，雪片才不会被吹成一条线
      wk: rnd(0.55, 1.35),
      // 只有大颗看得见反光闪动
      tw: li >= 2 ? rnd(0.5, 1.4) : 0,
    };
  }

  function shares() {
    const out = [];
    let left = target;
    for (let i = 0; i < LAYERS.length; i++) {
      const n = i === LAYERS.length - 1 ? left : Math.round(target * LAYERS[i].mix);
      out.push(Math.max(0, Math.min(left, n)));
      left -= out[i];
    }
    return out;
  }

  /* 补/退粒子：降级时从最费像素的近层与 bokeh 先撤（数量少但每颗覆盖面积大）。
     这里刻意不用 filter/map 重建数组——每帧的分配会让 GC 尖刺直接打在动画上。 */
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
      // 首屏铺满（prewarm）：一上来就让雪粒分布在整个视口里，而不是全从顶上开始下——
      // 否则头十几秒地面上一颗都落不到（诊断实测 landed 到第 14 秒才出现第一个 2），
      // 而且画面像雪刚开始下，不像已经下了一会儿。
      while (have[li] < want[li]) { flakes.push(makeFlake(li, !prewarm)); have[li]++; }
    }
    // 只对"第一次填充"生效：放在层循环之外，否则只有 far 层被铺满、其余三层仍从顶上入画
    prewarm = false;
  }

  function sizeCanvas() {
    W = Math.max(1, window.innerWidth || document.documentElement.clientWidth);
    H = Math.max(1, window.innerHeight || document.documentElement.clientHeight);
    dpr = pickDpr();
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px';
    cv.style.height = H + 'px';
    // 之后所有坐标一律用 CSS px，缩放交给这一层
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    pileCap = Math.min(H * PILE_MAX_VH, PILE_MAX_PX);
    const g = ctx.createLinearGradient(0, H - pileCap, 0, H);
    // 带一点冷调：纯白铺一大片会糊成一块、看不出雪面起伏
    g.addColorStop(0, 'rgba(255,255,255,.96)');
    g.addColorStop(1, 'rgba(232,238,248,.98)');
    pileFill = g;
  }

  /* 积雪高度图重采样：转屏、地址栏收放时按比例把已有的雪搬过去，
     而不是清空——否则手机一转屏"下了半天的雪"瞬间没了，一眼假。 */
  function initGround() {
    const old = ground, oldCols = cols;
    cols = Math.max(8, Math.ceil(W / COL_W));
    ground = new Float32Array(cols);
    if (!old) return;
    if (oldCols === cols) { ground.set(old); return; }
    for (let i = 0; i < cols; i++) {
      const t = (i / (cols - 1)) * (oldCols - 1);
      const a = Math.floor(t), b = Math.min(oldCols - 1, a + 1);
      ground[i] = old[a] + (old[b] - old[a]) * (t - a);
    }
  }

  function driftWeight(x) {
    // 低频空间正弦 + 随风向慢慢平移：雪垄会自己长出来、并随风向缓慢迁移
    return 0.7 + 0.6 * (0.5 + 0.5 * Math.sin(x * DRIFT_LEN + wind * 0.06));
  }

  function deposit(x, amount) {
    const i = clamp(Math.floor(x / COL_W), 0, cols - 1);
    // 一份雪摊给本列和左右邻列，不然会长出一根针
    // 近似高斯地摊到 5 列：只摊 3 列时，一颗大颗能在雪面上砸出 30px 的尖角
    const put = (k, w) => { if (k >= 0 && k < cols) ground[k] += amount * w; };
    put(i, 0.3); put(i - 1, 0.18); put(i + 1, 0.18); put(i - 2, 0.08); put(i + 2, 0.08);
  }

  /* 雪堆会自己垮：相邻列高差过大就下滑，再叠一点点均值平滑。
     不跑这一遍，积雪是一排尖刺。每 0.12 秒跑一次即可，逐帧跑白费。
     顺带在这里重算 pileK：粒子群在爬升期内一直在变，标定跟着走才能稳住"约 75 秒堆满"。 */
  function calibrate() {
    let land = 0, r2 = 0, n = 0;
    for (let i = 0; i < flakes.length; i++) {
      const f = flakes[i];
      if (f.L === BOKEH) continue;         // 焦外那几颗不落地，不参与堆积
      land += f.vy / H;                    // 每秒落地次数（按当前屏高折算）
      r2 += f.r * f.r; n++;
    }
    if (!n || !(land > 0)) { pileK = 0; return; }
    const meanR2 = r2 / n;
    landRate = land; pileK = (cols * pileCap) / (PILE_FULL_S * land * meanR2);
    if (!Number.isFinite(pileK) || pileK < 0) pileK = 0;
  }

  function settle() {
    calibrate();
    for (let i = 1; i < cols; i++) {
      const d = ground[i] - ground[i - 1];
      if (d > 1.6 || d < -1.6) { const move = d * 0.3; ground[i] -= move; ground[i - 1] += move; }
    }
    for (let i = 1; i < cols - 1; i++) ground[i] = ground[i] * 0.8 + (ground[i - 1] + ground[i + 1]) * 0.1;
    for (let i = 0; i < cols; i++) {
      const v = ground[i];
      // 到顶即"化掉"：积雪高度有上限，底部输入框永远露着
      ground[i] = !Number.isFinite(v) ? 0 : v > pileCap ? pileCap : v < 0 ? 0 : v;
    }
  }

  /* 雪面轮廓：以每个列点为控制点、以相邻两列点的中点为终点串二次贝塞尔。
     上一版把控制点写成"列点右移半列"，列高差一大就会走出向下的尖缺口
     （截图里 x≈860、x≈1130 那两个 V 形凹坑）。这条是标准的平滑过点写法，
     曲线恒过中点、凸包不出界，不会再啃出坑。 */
  function pilePath() {
    const base = H + 2;
    const y = (i) => base - ground[clamp(i, 0, cols - 1)];
    const x = (i) => clamp(i * COL_W, 0, W);
    ctx.moveTo(-2, y(0));
    ctx.lineTo(x(0), y(0));
    for (let i = 1; i < cols - 1; i++) {
      ctx.quadraticCurveTo(x(i), y(i), (x(i) + x(i + 1)) / 2, (y(i) + y(i + 1)) / 2);
    }
    ctx.quadraticCurveTo(x(cols - 1), y(cols - 1), W + 2, y(cols - 1));
  }

  function drawPile() {
    const base = H + 2;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    pilePath();
    ctx.lineTo(W + 2, base);
    ctx.lineTo(-2, base);
    ctx.closePath();
    ctx.fillStyle = pileFill;
    ctx.fill();
    // 雪面顶缘提一道亮，只描上沿线：一条 stroke 的代价换掉"涂了一片白"的观感
    ctx.beginPath();
    pilePath();
    ctx.strokeStyle = 'rgba(255,255,255,.95)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  function step() {
    raf = requestAnimationFrame(step);
    const t0 = now();
    let dt = (t0 - lastTs) / 1000;
    lastTs = t0;
    // 切标签页 / 断点回来会给一个巨大的 dt：不夹住的话雪花瞬移出屏、积雪一次涨满
    if (!(dt > 0)) dt = 0.016;
    else if (dt > 0.05) dt = 0.05;
    const t = (t0 - bootTs) / 1000;

    const ramped = cap * (START_MIX + (1 - START_MIX) * clamp(t / (RAMP_MS / 1000), 0, 1));
    const want = Math.round(clamp(ramped * degrade, 12, cap));
    if (want !== target) { target = want; tune(); }

    // 风：长周期那条负责"一阵一阵"的整体走向，短周期是小尺度抖动
    wind = Math.sin(t * 0.09) * 9 + Math.sin(t * 0.031 + 1.7) * 6 + Math.sin(t * 0.37) * 1.8;

    ctx.clearRect(0, 0, W, H);

    for (let i = 0; i < flakes.length; i++) {
      const f = flakes[i];
      const L = LAYERS[f.L];
      const depth = 0.45 + f.r / L.r[1]; // 大颗=离得近=多吃风和多摆幅
      f.x += (wind * f.wk * depth + Math.sin(t * f.fq + f.ph) * f.am * depth) * dt;
      f.y += f.vy * dt;
      if (f.x < -26) f.x += W + 52; else if (f.x > W + 26) f.x -= W + 52;

      const ci = f.x < 0 ? 0 : f.x > W ? cols - 1 : Math.floor(f.x / COL_W);
      const surface = H - ground[ci];
      if (f.y >= surface - f.r * 0.35) {
        // 大颗多占体积；driftWeight 让迎风侧堆得更高，雪垄自己长出来
        if (f.L !== BOKEH) { landed++; deposit(f.x, pileK * f.r * f.r * driftWeight(f.x)); }
        flakes[i] = makeFlake(f.L, true);
        continue;
      }
      ctx.globalAlpha = f.tw ? f.a * (0.72 + 0.28 * Math.sin(t * f.tw + f.ph)) : f.a;
      const sp = sprites[f.L];
      const d = f.r * 2 * L.soft;
      // 落得越快拖得越长：远层几乎还是圆的，近处大颗会拉成一道短促的下落痕
      const dh = d * (1 + f.vy / 240);
      ctx.drawImage(sp.canvas, f.x - d * 0.5, f.y - dh * 0.5, d, dh);
    }

    settleTick += dt;
    if (settleTick > 0.12) { settle(); settleTick = 0; }
    drawPile();

    const ms = now() - t0;
    frameMs = frameMs * 0.9 + ms * 0.1;
    // 迟滞：连续 90 帧超预算才降一档，连续 240 帧宽裕才回升一档，避免在阈值上反复横跳
    slowFor = ms > 13 ? slowFor + 1 : 0;
    fastFor = ms < 5 ? fastFor + 1 : 0;
    if (slowFor > 90 && degrade > 0.35) { degrade = Math.max(0.35, degrade - 0.15); slowFor = 0; }
    else if (fastFor > 240 && degrade < 1) { degrade = Math.min(1, degrade + 0.08); fastFor = 0; }
  }

  function measureCap() {
    /* 密度按视口面积给。第一版用的是 /9000（1280×900 上限 128 颗），探针实测每帧 2D 绘制
       只花 0.23ms（预算 16.7ms）——上限压得太狠，雪稀得像撒盐。
       现在按 /4200 给，1280×900 约 274 颗、线性外推约 1.5ms/帧，仍留十倍余量；
       真超了还有 degrade 那道自适应闸门兜着。 */
    const byArea = Math.round((W * H) / 2600);
    return Math.round(clamp(byArea, 90, TOUCH.matches ? 220 : 430));
  }

  function start() {
    if (!cv || raf) return;
    sizeCanvas();
    initGround();
    bakeSprites();
    cap = measureCap();
    target = 0; degrade = 1; slowFor = 0; fastFor = 0; settleTick = 0;
    landed = 0; prewarm = true; bootTs = lastTs = now();
    raf = requestAnimationFrame(step);
  }

  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  function mount() {
    if (cv) return;
    cv = document.createElement('canvas');
    cv.id = 'snow';
    cv.setAttribute('aria-hidden', 'true');
    document.body.appendChild(cv);
    // alpha:false 会逼着浏览器给画布铺一层不透明底色，正合适我们要半透明叠加的场景不能用
    ctx = cv.getContext('2d', { alpha: true, desynchronized: false });
  }

  function unmount() {
    stop();
    if (cv && cv.parentNode) cv.parentNode.removeChild(cv);
    cv = null; ctx = null; sprites = null; pileFill = null; ground = null; flakes = []; target = cap = 0;
  }

  function relayout() {
    if (!enabled || !cv) return;
    sizeCanvas();
    initGround();
    bakeSprites();
    cap = measureCap();
  }

  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(relayout, 220);
  });

  // 页面不可见时把整条循环撤掉：手机后台不该继续占 CPU
  document.addEventListener('visibilitychange', () => {
    if (!enabled) return;
    if (document.hidden) stop();
    else { lastTs = now(); start(); }
  });

  /* 系统"减弱动态效果"是硬约束：不启动；中途改系统设置也立刻响应。
     老 Safari 的 MediaQueryList 只有 addListener，这里两条都试。 */
  const onReduced = () => { if (enabled) apply(enabled); };
  if (REDUCED.addEventListener) REDUCED.addEventListener('change', onReduced);
  else if (REDUCED.addListener) REDUCED.addListener(onReduced);

  function apply(on) {
    enabled = !!on && !REDUCED.matches;
    if (enabled) { mount(); start(); } else unmount();
  }

  window.Snow = {
    setEnabled: apply,
    // 只读快照，给排障与探针用；不参与渲染路径
    stats: () => ({
      on: enabled, flakes: flakes.length, cap, target, degrade: +degrade.toFixed(2), landed, pileK: +pileK.toFixed(2), landRate: +landRate.toFixed(2),
      dpr: +dpr.toFixed(2), frameMs: +frameMs.toFixed(2), cols,
      pileMax: ground ? Math.round(Math.max.apply(null, ground)) : 0,
    }),
  };
})();
