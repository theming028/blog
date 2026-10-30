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
    if (!t) return;
    els.title.textContent = t.title;
    els.artist.textContent = t.artist || '';
    const img = t.cover ? '<img src="' + t.cover.replace(/"/g, '&quot;') + '" alt="" loading="lazy">' : '';
    els.cover.innerHTML = img || ICON.note;
    els.disc.innerHTML = t.cover ? '<img src="' + t.cover.replace(/"/g, '&quot;') + '" alt="">' : ICON.note;
    els.title.title = t.title + (t.artist ? ' — ' + t.artist : '');
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
    if (autoplay) audio.play().catch(() => { playing = false; paintPlay(); });
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
    if (playing) { audio.pause(); return; }
    if (idx < 0 || !audio || !audio.src) { wantPlay = true; load(Number(ls.get(LS.idx, 0)) || 0, true); return; }
    audio.play().catch(() => toast('浏览器拦截了自动播放，请再点一次'));
  }

  /* ---------------- 面板开合 ---------------- */
  let open = false;
  function setOpen(v) {
    if (PHONE.matches && v) return;             // 移动端不提供展开面板
    open = v;
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
    els.fab.addEventListener('click', () => { if (PHONE.matches) toggle(); else setOpen(!open); });
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
    if (audio) { audio.pause(); audio.src = ''; }
    if (root) { root.remove(); root = null; audio = null; els = {}; idx = -1; playing = false; open = false; }
  }

  window.MusicPlayer = {
    /* feed.js 读到设置后调用：on=false 或歌单为空时整个组件不出现 */
    apply(on, list) {
      const want = !!on && Array.isArray(list) && list.length > 0;
      if (!want) { destroy(); return; }
      const sig = list.map((t) => t.url).join('|');
      if (!root) build();
      const changed = sig !== (root.dataset.sig || '');
      root.dataset.sig = sig;
      tracks = list;
      mode = Math.min(MODES.length - 1, Math.max(0, Number(ls.get(LS.mode, 0)) || 0));
      paintMode(); paintPlay();
      if (changed) {
        const keep = idx >= 0 && idx < tracks.length ? idx : Number(ls.get(LS.idx, 0)) || 0;
        idx = -1;
        load(keep, playing);          // 后台改了歌单：正在播就续播，没在播只准备好首曲
      } else if (idx < 0) {
        paintTrack();
      }
    },
  };
})();
