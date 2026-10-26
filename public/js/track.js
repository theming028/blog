/* 前台访客行为采集。只在 index.html 加载（后台/编辑页不是"访客"，不该进访问日志）。
 *
 * 为什么这个文件不往 feed.js 里插任何调用：feed.js 的点赞、评论、大图、翻页各有一条
 * 自己的状态机，往里点十几个 hook 既容易和另一台设备的改动冲突，也漏一处就少一类行为。
 * 这里改成只用三个稳定的对外面：
 *   1) common.js 的全局 api()——所有写请求都过它，包一层就只记**真正成功**的动作
 *      （点了但被限流/校验打回的，不该记成"点赞了"）；
 *   2) DOM 上的观察：#viewer 的 class 变化 = 打开大图；#feed 的节点变化 = 换页/重建帖子；
 *   3) 少量委托点击：友链、页码。
 * feed.js 若哪天被改成 ES module，api() 不再是可覆写的 global，第 1 条会静默失效——
 * 到时候把下面 installApiHook() 改成显式调用点即可，其余两条不受影响。
 *
 * 时长与动作都只上报"发生了什么"，**时长由服务端累计**（见 lib/visit.js），
 * 客户端没有往时长里加数的入口。
 */
'use strict';

(function () {
  const HEARTBEAT_MS = 30 * 1000;      // 心跳间隔：30 秒的粒度足够看"停留 3 分钟还是 3 小时"
  const FLUSH_MS = 5000;               // 队列最长停留时间
  const FLUSH_AT = 5;                  // 攒够几条立刻发
  const QUEUE_MAX = 20;                // 发不出去时的队列上限，超了丢最老的
  const READ_RATIO = 0.5;              // 正文面积过半
  const READ_MS = 3000;                // 且持续 3 秒，才算"读了这条"

  let sid = '';
  let dead = false;        // 服务端明确不认这个会话后停止一切上报，别对着空气重试
  const queue = [];
  const readSeen = new Set();  // 同一次页面加载里，一条内容只记一次阅读

  const payload = (extra) => Object.assign({ sid }, extra || {});

  function post(url, body, useBeacon, done) {
    if (dead) return false;
    const json = JSON.stringify(body);
    if (useBeacon && navigator.sendBeacon) {
      // sendBeacon 在 pagehide 里是唯一还稳的请求方式（普通 fetch 会被半途掐掉）
      try {
        return navigator.sendBeacon(url, new Blob([json], { type: 'application/json' }));
      } catch (e) { return false; }
    }
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json,
      credentials: 'same-origin',
      keepalive: true,   // 页面正在切走/关掉时也要发得出去
    }).then((r) => r.json()).then((d) => {
      // ok:false = 这个 sid 服务端已经不认了（过期/被清/不是这个访客），继续报只会刷错误日志
      if (d && d.ok === false) dead = true;
      // 服务端是 sid 的唯一权威：它换了就跟着换（比如手上这个已经过期，它另起了新会话）
      if (d && d.sid && d.sid !== sid) sid = d.sid;
      if (done && !dead) done(d || {});
    }).catch(() => { /* 网络失败静默：采集绝不能影响读博客 */ });
    return true;
  }

  /* ---- 动作入队 ---- */
  function track(type, target, detail) {
    if (dead || !sid) return;
    queue.push({ type, target: target || null, detail: detail ? String(detail).slice(0, 200) : null, ts: Date.now() });
    while (queue.length > QUEUE_MAX) queue.shift();
    if (queue.length >= FLUSH_AT) flush();
  }
  function flush(useBeacon) {
    if (!queue.length || !sid) return;
    const events = queue.splice(0, queue.length);
    post('/api/track/event', payload({ events }), useBeacon);
  }
  setInterval(() => flush(false), FLUSH_MS);

  /* ---- 心跳：只在页面真的被人看着时计时 ---- */
  let hb = null;
  function startBeat() {
    if (hb || dead) return;
    hb = setInterval(() => {
      if (document.visibilityState !== 'visible') return; // 后台标签页不计时（浏览器还会把定时器节流到分钟级，那样记的是假时长）
      post('/api/track/ping', payload({}));
    }, HEARTBEAT_MS);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // 先让服务端把时钟拨到此刻、这一拍不计入，再恢复心跳（见 lib/visit.js 的 sync 说明）
      post('/api/track/ping', payload({ sync: true }));
      startBeat();
    } else {
      flush(false);            // 切走之前把攒下的动作发掉，这段时间是真人看着的
      post('/api/track/ping', payload({}), true);
      if (hb) { clearInterval(hb); hb = null; }
    }
  });
  window.addEventListener('pagehide', () => {
    flush(true);
    post('/api/track/ping', payload({}), true);
    post('/api/track/end', payload({}), true);
  });

  /* ---- 写请求的对外面：common.js 的 api() ---- */
  const RX = {
    like: /^\/api\/posts\/([\w-]+)\/like/,
    cmtAdd: /^\/api\/posts\/([\w-]+)\/comments\/?$/,
    cmtOwn: /^\/api\/comments\/([\w-]+)\/?$/,
  };
  function snippet(pid) {
    const el = document.querySelector(`.post[data-pid="${CSS.escape(pid)}"] .p-text`);
    return el ? el.textContent.slice(0, 40) : '';
  }
  function onApiCall(path, opts, res) {
    const method = (opts && opts.method) || 'GET';
    let m;
    if ((m = RX.like.exec(path))) {
      if (method === 'POST') track('like', m[1], snippet(m[1]));
      else if (method === 'DELETE') track('unlike', m[1], snippet(m[1]));
      return;
    }
    if ((m = RX.cmtAdd.exec(path)) && method === 'POST') {
      const st = res && res.comment && res.comment.status;
      track('comment', m[1], (opts.body && opts.body.content ? String(opts.body.content).slice(0, 40) : '')
        + (st === 'pending' ? '（进待审）' : ''));
      return;
    }
    if ((m = RX.cmtOwn.exec(path))) {
      if (method === 'PUT') track('cmt_edit', m[1], null);
      else if (method === 'DELETE') track('cmt_del', m[1], null);
    }
  }
  function installApiHook() {
    if (typeof window.api !== 'function') return; // 拿不到就不包，别让采集把页面打挂
    const orig = window.api;
    window.api = function (path, opts) {
      return Promise.resolve().then(() => orig(path, opts)).then((r) => {
        try { onApiCall(path, opts, r); } catch (e) { /* 埋点异常绝不影响业务返回 */ }
        return r;
      });
    };
  }

  /* ---- 打开大图：盯 #viewer 的 class，不碰查看器本身的逻辑 ---- */
  function watchViewer() {
    const viewer = document.getElementById('viewer');
    if (!viewer) return;
    let was = viewer.classList.contains('show');
    new MutationObserver(() => {
      const now = viewer.classList.contains('show');
      if (now && !was) track('image_view', null, (document.getElementById('vCount') || {}).textContent || '');
      if (now !== was) { was = now; flush(false); }  // 看完一组图就把动作发掉，别等到 5 秒定时器
    }).observe(viewer, { attributes: true, attributeFilter: ['class'] });
  }

  /* ---- 阅读内容：正文过半且停够 3 秒才算 ---- */
  function watchReading() {
    const feed = document.getElementById('feed');
    if (!feed || typeof IntersectionObserver !== 'function') return;
    const pending = new Map(); // el -> timer，进入视口时挂起，够时间才落一条
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        const el = en.target;
        const pid = el.dataset.pid;
        if (en.isIntersecting && en.intersectionRatio >= READ_RATIO) {
          if (pending.has(el) || readSeen.has(pid)) return;
          pending.set(el, setTimeout(() => {
            pending.delete(el);
            // 3 秒里帖子被重建过（点赞/翻页都会整条重建节点），这条就不算了
            if (!el.isConnected || readSeen.has(pid)) return;
            readSeen.add(pid);
            track('post_read', pid, snippet(pid));
          }, READ_MS));
        } else if (pending.has(el)) {
          clearTimeout(pending.get(el));   // 3 秒内又滚走 = 不算读过
          pending.delete(el);
        }
      });
    }, { threshold: [0, READ_RATIO, 1] });
    const scan = () => {
      feed.querySelectorAll('.post[data-pid]').forEach((el) => {
        if (!el.dataset.tmReadObs) { el.dataset.tmReadObs = '1'; io.observe(el); }
      });
    };
    scan();
    // 翻页与点赞都会整条重建帖子节点，所以得跟着 DOM 变化重新登记
    new MutationObserver(scan).observe(feed, { childList: true, subtree: true });
  }

  /* ---- 友链 / 翻页：委托点击 ---- */
  function watchClicks() {
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('#blogrollList a[href]');
      if (a) {
        let host = '';
        try { host = new URL(a.href).host; } catch (err) { return; }
        track('blogroll_click', host, (a.textContent || '').trim().slice(0, 30));
        return;
      }
      const pg = e.target.closest && e.target.closest('#pager [data-page]');
      // 当前页码本身也可点（feed.js 会自己忽略），这里跟着忽略，
      // 否则"在第 1 页点了一下 1"会被记成翻了一次页
      if (pg && !pg.classList.contains('disabled') && !pg.classList.contains('cur')) {
        track('page_turn', pg.dataset.page, `第 ${pg.dataset.page} 页`);
      }
    }, true);
  }

  /* ---- 启动：先建会话，再装观察器。pv 依赖 sid，所以放在回调里 ---- */
  function boot() {
    try { sid = sessionStorage.getItem('tm_sid') || ''; } catch (e) { sid = ''; }
    // pv 必须等 sid 定下来再入队：首访时手上本来就没有 sid，早发一步就被 track() 的 !sid 挡掉了
    post('/api/track/start', payload({
      referrer: document.referrer || '',
      page: location.pathname,
    }), false, () => {
      track('pv', null, location.pathname);
      try { sessionStorage.setItem('tm_sid', sid); } catch (e) { /* 隐私模式下 sessionStorage 会抛 */ }
    });
    startBeat();
    watchViewer();
    watchReading();
    watchClicks();
  }

  installApiHook();
  /* 给同页其它模块一个显式记动作的口子（share.js 记"打开分享/复制链接"）。
   * 走的是同一个队列与同一套服务端白名单，不另开一条上报链路。 */
  window.TMTrack = { event: track };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
