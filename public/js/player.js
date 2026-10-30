/* 背景音乐播放器：右下角悬浮球，点开在上方弹出卡片面板。
 *
 * 功能面参照 abcdtfk.icu 的 persistent-player（悬浮球 + 封面/曲名/艺人/进度/
 * 循环模式/上下曲/音量），代码与样式全部按本站重写，未使用对方代码或素材。
 *
 * 本站的三条硬约束：
 * 1) 音频只存 https 外链（服务端 safeHttpUrl 把关），db.json 不装音频；
 * 2) 移动端（<720px）只保留悬浮球、不展开面板——点球=播放/暂停；
 * 3) prefers-reduced-motion 下悬浮球不旋转（与雪/花瓣画布同口径）。
 *
 * 挂在 document.body 上而不是 #feed 里：信息流翻页与评论刷新会整块重建 #feed 的
 * innerHTML，播放器若在其内会被连带销毁，正在播的歌就断了。 */
(function () {
  'use strict';

  const PHONE = matchMedia('(max-width: 719px)');
  const LS = { mode: 'tm_mu_mode', vol: 'tm_mu_vol', idx: 'tm_mu_idx' };
  const MODES = [
    { id: 'order', label: '顺序', tip: '列表循环' },
    { id: 'one', label: '单曲', tip: '单曲循环' },
    { id: 'shuffle', label: '随机', tip: '随机播放' },
  ];

  let root = null, audio = null, els = {};
  let tracks = [], idx = -1, mode = 0, playing = false, failed = 0, wantPlay = false;
  let booted = false;   // 本次页面装载是否已尝试过自动播放

  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 隐私模式写入会抛，忽略 */ } },
  };

  /* ---------------- 构建 DOM ---------------- */
  const ICON = {
    note: '<svg viewBox="0 0 24 24"><path d="M20 3.5 9.6 6v9.1a3.6 3.6 0 1 0 1.8 3.1V9.3l7-1.6v4.6a3.6 3.6 0 1 0 1.8 3.1z" fill="currentColor"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M8 5h3v14H8zm5 0h3v14h-3z" fill="currentColor"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M7 6h2v12H7zm11 0v12l-8-6z" fill="currentColor"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M15 6h2v12h-2zM6 6l8 6-8 6z" fill="currentColor"/></svg>',
    order: '<svg viewBox="0 0 24 24"><path d="M7 5h10a4 4 0 0 1 0 8H9m8 0 2.5-2.5M17 13l2.5 2.5" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/><path d="M7 19h10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    one: '<svg viewBox="0 0 24 24"><path d="M7 5h10a4 4 0 0 1 0 8H9m8 0 2.5-2.5M17 13l2.5 2.5" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/><path d="M6.5 16.5 9 15.6V20" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24"><path d="M4 6h3.5l9 12H20M4 18h3.5l2.6-3.5M14 8.5l2.5-2.5H20m0 0-2.5-2.5M20 6l-2.5 2.5" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    vol: '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" fill="currentColor"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.6 7.6 0 0 1 0 11" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/></svg>',
  };

  function build() {
    root = document.createElement('div');
    root.className = 'mu';
    root.innerHTML =
      '<div class="mu-panel" id="musicPanel" role="dialog" aria-label="背景音乐播放器" aria-hidden="true">' +
        '<div class="mu-now">' +
          '<div class="mu-cover" id="musicCover"></div>' +
          '<div class="mu-meta"><div class="mu-title" id="musicTitle">—</div><div class="mu-artist" id="musicArtist"></div></div>' +
        '</div>' +
        '<div class="mu-bar" id="musicBar" role="slider" tabindex="0" aria-label="播放进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">' +
          '<div class="mu-fill" id="musicFill"></div><i class="mu-knob"></i>' +
        '</div>' +
        '<div class="mu-time"><span id="musicCur">0:00</span><span id="musicDur">0:00</span></div>' +
        '<div class="mu-ctrls">' +
          '<button type="button" class="mu-btn mu-mode" id="musicMode" aria-label="播放模式"></button>' +
          '<button type="button" class="mu-btn" id="musicPrev" aria-label="上一首">' + ICON.prev + '</button>' +
          '<button type="button" class="mu-btn mu-play" id="musicPlay" aria-label="播放"></button>' +
          '<button type="button" class="mu-btn" id="musicNext" aria-label="下一首">' + ICON.next + '</button>' +
          '<span class="mu-volwrap">' +
            '<button type="button" class="mu-btn" id="musicVol" aria-label="音量">' + ICON.vol + '</button>' +
            '<input type="range" class="mu-range" id="musicRange" min="0" max="100" step="1" aria-label="音量">' +
          '</span>' +
        '</div>' +
      '</div>' +
      '<button type="button" class="mu-fab" id="musicFab" aria-label="音乐播放器" aria-expanded="false" aria-controls="musicPanel">' +
        '<span class="mu-fab-disc" id="musicFabDisc">' + ICON.note + '</span>' +
      '</button>';
    document.body.appendChild(root);
    els = {
      panel: root.querySelector('#musicPanel'), cover: root.querySelector('#musicCover'),
      title: root.querySelector('#musicTitle'), artist: root.querySelector('#musicArtist'),
      bar: root.querySelector('#musicBar'), fill: root.querySelector('#musicFill'),
      knob: root.querySelector('.mu-knob'),
      cur: root.querySelector('#musicCur'), dur: root.querySelector('#musicDur'),
      mode: root.querySelector('#musicMode'), prev: root.querySelector('#musicPrev'),
      play: root.querySelector('#musicPlay'), next: root.querySelector('#musicNext'),
      vol: root.querySelector('#musicVol'), range: root.querySelector('#musicRange'),
      fab: root.querySelector('#musicFab'), disc: root.querySelector('#musicFabDisc'),
    };
    bind();
  }

  /* ---------------- 渲染 ---------------- */
  const fmt = (s) => {
    if (!Number.isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60), r = Math.floor(s % 60);
    return m + ':' + String(r).padStart(2, '0');
  };

  function paintMode() {
    const m = MODES[mode];
    els.mode.innerHTML = ICON[m.id] + '<span class="mu-mode-label">' + m.label + '</span>';
    els.mode.setAttribute('aria-label', '播放模式：' + m.tip);
    els.mode.title = m.tip;
  }
  function paintPlay() {
    els.play.innerHTML = playing ? ICON.pause : ICON.play;
    els.play.setAttribute('aria-label', playing ? '暂停' : '播放');
    root.classList.toggle('is-playing', playing);
  }
  function paintTrack() {
    const t = tracks[idx];
    // 空歌单也要有明确状态：前台照常显示播放器，只是没有可播内容
    if (!t) {
      els.title.textContent = '歌单为空';
      els.artist.textContent = '在后台「播放器」里添加歌曲';
      els.cover.innerHTML = ICON.note;
      els.disc.innerHTML = ICON.note;
      els.cur.textContent = '0:00'; els.dur.textContent = '0:00';
      els.fill.style.width = '0%'; els.knob.style.left = '0%';
      return;
    }
    els.title.textContent = t.title;
    els.artist.textContent = t.artist || '';
    const img = t.cover ? '<img src="' + t.cover.replace(/"/g, '&quot;') + '" alt="" loading="lazy">' : '';
    els.cover.innerHTML = img || ICON.note;
    els.disc.innerHTML = t.cover ? '<img src="' + t.cover.replace(/"/g, '&quot;') + '" alt="">' : ICON.note;
    els.title.title = t.title + (t.artist ? ' — ' + t.artist : '');
  }
  /* 没有可播内容时把三个动作键置灰——比"点了弹提示"更早地把话说清楚 */
  function paintEnabled() {
    const none = !tracks.length;
    [els.play, els.prev, els.next].forEach((b) => { b.disabled = none; });
    root.classList.toggle('is-empty', none);
  }
  function paintProgress() {
    const d = audio && Number.isFinite(audio.duration) ? audio.duration : 0;
    const c = audio ? audio.currentTime : 0;
    const pct = d ? Math.min(100, (c / d) * 100) : 0;
    els.fill.style.width = pct.toFixed(2) + '%';
    els.knob.style.left = pct.toFixed(2) + '%';
    els.cur.textContent = fmt(c);
    els.dur.textContent = fmt(d);
    els.bar.setAttribute('aria-valuenow', Math.round(pct));
  }

  /* ---------------- 播放控制 ---------------- */
  function ensureAudio() {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = 'metadata';
    audio.volume = Number(ls.get(LS.vol, 0.6));
    els.range.value = String(Math.round(audio.volume * 100));
    audio.addEventListener('loadedmetadata', paintProgress);
    audio.addEventListener('timeupdate', paintProgress);
    audio.addEventListener('ended', () => step(true));
    audio.addEventListener('error', onAudioError);
    audio.addEventListener('play', () => { playing = true; failed = 0; paintPlay(); });
    audio.addEventListener('pause', () => { if (!audio.ended) { playing = false; paintPlay(); } });
    return audio;
  }

  function onAudioError() {
    failed++;
    // 全部曲目都失败一轮就停下：否则 ended/error 互推会变成静默死循环
    if (failed >= tracks.length) {
      playing = false; failed = 0; paintPlay();
      toast('暂时无法播放，请稍后再试');
      return;
    }
    step(true);
  }

  function load(i, autoplay) {
    if (!tracks.length) return;
    idx = ((i % tracks.length) + tracks.length) % tracks.length;
    ls.set(LS.idx, String(idx));
    paintTrack();
    ensureAudio();
    audio.src = tracks[idx].url;
    audio.currentTime = 0;
    paintProgress();
    if (autoplay) attemptPlay(true);
  }
  /* 统一处理"尝试播放"：自动播放被拦时不报错、不弹提示轰炸访客，
     而是挂上首次交互补播 + 一句轻提示；用户手动点击成功则把补播撤掉。 */
  function attemptPlay(auto) {
    const p = audio.play();
    if (!p || !p.then) return;
    p.then(() => { if (auto) disarmGesture(); }, () => {
      if (!auto) return;
      wantAutoplay = true; armGesture();
    });
  }

  function nextIndex() {
    if (tracks.length < 2) return idx;
    if (MODES[mode].id === 'shuffle') {
      let n = idx;
      for (let k = 0; k < 8 && n === idx; k++) n = Math.floor(Math.random() * tracks.length);
      return n;
    }
    return idx + 1;
  }

  function step(fromEnd) {
    if (!tracks.length) return;
    if (fromEnd && MODES[mode].id === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
    load(nextIndex(), true);
  }

  function toggle() {
    if (!tracks.length) { toast('歌单还是空的'); return; }
    if (playing) {
      // 用户主动暂停 = 接管播放，之后不该被"首次交互补播"偷偷恢复
      wantAutoplay = false; disarmGesture(); audio.pause(); return;
    }
    if (idx < 0 || !audio || !audio.src) { wantPlay = true; load(Number(ls.get(LS.idx, 0)) || 0, true); return; }
    audio.play().catch(() => toast('浏览器拦截了自动播放，请再点一次'));
  }

  /* ---------------- 自动播放被拦截后的补救 ----------------
   * 浏览器（Chrome/Safari）一律拦无用户交互的有声播放，所以"自动播放"只能做成：
   * 先试一次，被拦就挂全局首次交互监听补播，并给一句提示——否则访客只会觉得功能坏了。
   * 参考站 abcdtfk.icu 正是这套（wantAutoplay / armGesture / tryResume / 提示条）。 */
  let wantAutoplay = false, gestureArmed = false;

  function tryResume(e) {
    if (!wantAutoplay) { disarmGesture(); return; }
    // 点在播放器自身上时让球自己的逻辑处理，否则 pointerdown 播、click 又把它暂停
    if (e && root && root.contains(e.target)) return;
    if (!audio) { disarmGesture(); return; }
    if (!audio.paused) { disarmGesture(); return; }
    const p = audio.play();
    if (p && p.then) p.then(() => disarmGesture(), () => { /* 仍被拦：留着监听等下一次交互 */ });
    else disarmGesture();
  }
  function armGesture() {
    if (gestureArmed) return;
    gestureArmed = true;
    document.addEventListener('pointerdown', tryResume);
    document.addEventListener('touchstart', tryResume, { passive: true });
    document.addEventListener('click', tryResume);
    document.addEventListener('keydown', tryResume);
    showHint();
  }
  function disarmGesture() {
    if (!gestureArmed) return;
    gestureArmed = false; wantAutoplay = false;
    document.removeEventListener('pointerdown', tryResume);
    document.removeEventListener('touchstart', tryResume);
    document.removeEventListener('click', tryResume);
    document.removeEventListener('keydown', tryResume);
    hideHint();
  }
  let hintEl = null, hintTimer = 0;
  function showHint() {
    if (hintEl || !root) return;
    hintEl = document.createElement('div');
    hintEl.className = 'mu-hint';
    hintEl.textContent = '点一下页面即可播放音乐';
    root.appendChild(hintEl);
    hintTimer = setTimeout(hideHint, 8000);   // 访客不理会也不是一直杵在那儿
  }
  function hideHint() {
    clearTimeout(hintTimer);
    if (hintEl) { hintEl.remove(); hintEl = null; }
  }

  /* ---------------- 面板开合 ---------------- */
  let open = false;
  function setOpen(v) {
    if (PHONE.matches && v) return;             // 移动端不提供展开面板
    open = v;
    if (v) layoutPanel();                       // 先定好朝哪边展开，再显示，避免闪一下错位
    root.classList.toggle('is-open', open);
    els.panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    els.fab.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function seekFromEvent(e) {
    const r = els.bar.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if (audio && Number.isFinite(audio.duration)) {
      audio.currentTime = p * audio.duration;
      paintProgress();
    }
    return p;
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    initDrag();
    els.fab.addEventListener('click', () => {
      if (els.fab._dragSuppressed && els.fab._dragSuppressed()) return;   // 刚拖完，吞掉浏览器补发的 click
      if (PHONE.matches) toggle(); else setOpen(!open);
    });
    els.play.addEventListener('click', toggle);
    els.prev.addEventListener('click', () => load(idx - 1, true));
    els.next.addEventListener('click', () => load(nextIndex(), true));
    els.mode.addEventListener('click', () => { mode = (mode + 1) % MODES.length; ls.set(LS.mode, String(mode)); paintMode(); });
    els.vol.addEventListener('click', () => root.classList.toggle('show-vol'));
    els.range.addEventListener('input', () => {
      const v = Number(els.range.value) / 100;
      ensureAudio().volume = v;
      ls.set(LS.vol, String(v));
    });
    let dragging = false;
    els.bar.addEventListener('pointerdown', (e) => { dragging = true; els.bar.setPointerCapture(e.pointerId); seekFromEvent(e); });
    els.bar.addEventListener('pointermove', (e) => { if (dragging) seekFromEvent(e); });
    els.bar.addEventListener('pointerup', () => { dragging = false; });
    els.bar.addEventListener('keydown', (e) => {
      if (!audio || !Number.isFinite(audio.duration)) return;
      const d = e.key === 'ArrowRight' ? 5 : e.key === 'ArrowLeft' ? -5 : 0;
      if (!d) return;
      e.preventDefault();
      audio.currentTime = Math.min(audio.duration, Math.max(0, audio.currentTime + d));
      paintProgress();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && open) setOpen(false);
    });
    PHONE.addEventListener('change', () => { if (PHONE.matches) setOpen(false); });
  }

  /* ---------------- 拖动（位置不持久化：只写内联 style，刷新回默认） ---------------- */
  const EDGE = 8;               // 距视口边缘的最小留白
  const DRAG_THRESHOLD = 5;     // 位移小于这个数按点击算，否则轻轻一点就被当成拖动

  function clampPos(x, y) {
    const w = root.offsetWidth, h = root.offsetHeight;
    // 层级已高于 .nav，球压在导航上照样点得到，所以顶边界只需留出边缘间距
    const minY = Math.max(EDGE, envTop());
    return {
      x: Math.min(Math.max(x, EDGE), Math.max(EDGE, innerWidth - w - EDGE)),
      y: Math.min(Math.max(y, minY), Math.max(minY, innerHeight - h - EDGE)),
    };
  }
  /* 刘海/状态栏高度：拖到最顶时也要让出来，否则球会盖住系统状态栏文字。
     读一个探针元素的 computed margin-top 拿实际值，比猜像素可靠。 */
  let _envTop = null;
  function envTop() {
    if (_envTop !== null) return _envTop;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;height:0;padding-top:env(safe-area-inset-top)';
    document.body.appendChild(probe);
    _envTop = parseFloat(getComputedStyle(probe).paddingTop) || 0;
    probe.remove();
    return _envTop;
  }
  function place(x, y) {
    const p = clampPos(x, y);
    root.classList.add('is-dragged');
    root.style.left = Math.round(p.x) + 'px';
    root.style.top = Math.round(p.y) + 'px';
    layoutPanel();
  }
  /* 面板默认贴球的右缘向左展开；球靠近左边缘、向左放不下时，改成贴左缘向右展开。
     同时下方空间不够时翻到上方展开。 */
  function layoutPanel() {
    if (!root || PHONE.matches) return;
    const r = root.getBoundingClientRect();
    const ph = els.panel.offsetHeight || 150, pw = els.panel.offsetWidth || 268;
    root.classList.toggle('panel-up', r.bottom + ph + 12 > innerHeight && r.top - ph - 12 > 0);
    root.classList.toggle('panel-left', r.right - pw < EDGE && r.left + pw <= innerWidth - EDGE);
  }

  function initDrag() {
    let start = null, from = null, moved = false, suppress = false;
    els.fab.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const r = root.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY };
      from = { x: r.left, y: r.top };
      moved = false;
      // 合成事件（测试/自动化）没有活动指针，捕获会抛；真实交互不受影响
      try { els.fab.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    els.fab.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        moved = true;
        els.fab.classList.add('is-grabbing');
        setOpen(false);   // 拖着拖着面板还开着会挡住视线，先收起来
      }
      place(from.x + dx, from.y + dy);
    });
    const end = (e) => {
      if (!start) return;
      start = null;
      els.fab.classList.remove('is-grabbing');
      if (moved) { moved = false; suppress = true; }   // 拖动收尾时浏览器还会补一个 click，得吞掉
    };
    els.fab.addEventListener('pointerup', end);
    els.fab.addEventListener('pointercancel', end);
    els.fab._dragSuppressed = () => { if (suppress) { suppress = false; return true; } return false; };
    // 旋转屏幕或窗口变窄时，球可能留在屏幕外：重新夹回可视区
    addEventListener('resize', () => {
      if (!root || !root.classList.contains('is-dragged')) return;
      const r = root.getBoundingClientRect();
      place(r.left, r.top);
    });
  }

  /* ---------------- 对外接口 ---------------- */
  let toastEl = null, toastTimer = 0;
  function toast(msg) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'mu-toast'; document.body.appendChild(toastEl); }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  function destroy() {
    disarmGesture(); hideHint();
    if (audio) { audio.pause(); audio.src = ''; }
    if (root) { root.remove(); root = null; audio = null; els = {}; idx = -1; playing = false; open = false; booted = false; }
  }

  window.MusicPlayer = {
    /* feed.js 读到设置后调用。显示与否只看开关：歌单为空也照常出现，
       面板里明确写"歌单为空"，三个动作键置灰——这样后台一开开关就能看到效果，
       不必先凑够一首歌。 */
    apply(on, list) {
      if (!on) { destroy(); return; }
      if (!root) build();
      const tracks_ = Array.isArray(list) ? list : [];
      const sig = tracks_.map((t) => t.url).join('|');
      const changed = sig !== (root.dataset.sig || '');
      root.dataset.sig = sig;
      tracks = tracks_;
      mode = Math.min(MODES.length - 1, Math.max(0, Number(ls.get(LS.mode, 0)) || 0));
      paintMode(); paintPlay(); paintEnabled();
      if (!tracks.length) { idx = -1; paintTrack(); booted = true; return; }
      /* 自动播放只在本次页面装载时尝试一次：之后后台改设置或重进视图都不该
         突然又冒出一段音乐，那属于"用户没要求的自动出声"。
         选哪首：优先第一首标了 autoplay 的（否则"勾了却没播"完全无法理解），
         没有标记才回到上次记住的位置。 */
      if (changed || !booted) {
        const autoIdx = tracks.findIndex((t) => t && t.autoplay);
        const remembered = Number(ls.get(LS.idx, 0)) || 0;
        const keep = !booted && autoIdx >= 0 ? autoIdx
          : (idx >= 0 && idx < tracks.length ? idx : remembered);
        const auto = !booted && autoIdx >= 0 && keep === autoIdx;
        idx = -1;
        load(keep, playing || auto);
      } else {
        paintTrack();
      }
      booted = true;
    },
  };
})();
