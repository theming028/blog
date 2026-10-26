/* 分享面板。
 *
 * 先说清楚能做到哪一步，免得对"分享到朋友圈"有错误预期：
 * 网页**不能**替用户发朋友圈。微信只提供两条正路——
 *   ① 用户在微信内置浏览器里点右上角 ··· → 朋友圈（此时卡片上的标题/摘要/缩略图
 *      由 JS-SDK 定制，需要"认证服务号 + 备案在自己名下的域名"，见 README「分享」）；
 *   ② 用户把链接复制到微信里粘贴发送。
 * 所以这个面板做的是 ② + 系统分享面板（iOS/Android 的 navigator.share 里通常有"微信"，
 * 可以直接发给好友），并且保证**链接是这一条内容的直达地址**、标题与缩略图由服务端
 * 写进 HTML（抓链接的平台不执行 JS）。JS-SDK 那条路留到换自有域名后接，接口已经预留。
 */
'use strict';

(function () {
  /* 地址格式必须和 lib/share.js 的 postUrl() 一致，
     否则面板里显示的链接与实际分享出去的不是一个 */
  function urlOf(id) {
    return location.origin + '/?p=' + encodeURIComponent(id);
  }

  function isWeChat() { return /MicroMessenger|WeChat|wxwork/i.test(navigator.userAgent || ''); }

  let current = null;   // { id, url, title, text }

  const $ = (sel) => document.querySelector(sel);

  function flash(btn, msg) {
    const old = btn.textContent;
    btn.textContent = msg;
    btn.disabled = true;
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1600);
  }

  /* 复制：navigator.clipboard 只在安全上下文（https 或 localhost）可用，
     用 http 直接 IP 访问时会没有，必须留 execCommand 这条路。 */
  async function copy(text, btn) {
    let done = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        done = true;
      }
    } catch (e) { done = false; }
    if (!done) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { done = document.execCommand('copy'); } catch (e) { done = false; }
      ta.remove();
    }
    if (btn) flash(btn, done ? '已复制' : '复制失败');
    /* 成功与失败都记 share_copy，失败原因放 detail。
       原来失败时记的是 share，等于把"没复制成功"混进"打开分享"的计数里，
       后台看到的分享次数会凭空多出一截。 */
    if (window.TMTrack) TMTrack.event('share_copy', current ? current.id : null, done ? null : '复制失败，需手动选中链接');
    return done;
  }

  function render() {
    if (!current) return;
    $('#shareUrl').value = current.url;
    const native = $('#btnNativeShare');
    // 不支持系统分享（老浏览器、非安全上下文）就把这一项整个藏掉，而不是点了报错
    const canNative = !!(navigator.share && (!navigator.canShare || navigator.canShare({ title: current.title, text: current.text, url: current.url })));
    native.style.display = canNative ? 'flex' : 'none';
    $('#shareHint').textContent = isWeChat()
      ? '你正在微信里打开：点右上角「···」选择「发送给朋友」或「分享到朋友圈」，卡片上的标题与图片来自服务端写入的页面信息。'
      : '复制链接后打开微信，粘贴给好友或发到朋友圈；也可以直接长按/选中下方地址复制。';
  }

  function open(post) {
    if (!post || !post.id) return;
    const text = (post.content || '').trim();
    const imgs = Array.isArray(post.images) ? post.images : [];
    current = {
      id: post.id,
      url: urlOf(post.id),
      title: text ? text.slice(0, 30) : (post.location || '朝夕光年'),
      // 分享文案里带上站点名：单独一句"照片 × 3"被粘贴到群里时看不出是谁的博客
      text: (text ? text.slice(0, 60) : (imgs.length ? `这组照片共 ${imgs.length} 张` : '一条新的动态'))
        + ' —— 来自 Ming 的「朝夕光年」',
    };
    render();
    $('#dlgShare').classList.add('show');
    if (window.TMTrack) TMTrack.event('share', current.id, null);
  }

  function close() { $('#dlgShare').classList.remove('show'); }

  document.addEventListener('click', (e) => {
    if (e.target.closest('#shareClose')) return close();
    // 点蒙层本体关闭：分享面板是子节点，点它不该被当成外点
    if (e.target === $('#dlgShare')) return close();
    if (e.target.closest('#btnCopyUrl')) return copy(current ? current.url : '', e.target.closest('#btnCopyUrl'));
    if (e.target.closest('#btnNativeShare') && current) {
      navigator.share({ title: current.title, text: current.text, url: current.url })
        .then(() => { if (window.TMTrack) TMTrack.event('share_native', current.id, null); })
        .catch(() => { /* 用户取消分享，不需要任何提示 */ });
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#dlgShare') && $('#dlgShare').classList.contains('show')) close();
  });
  // 链接框点一下就整段选中：手机上长按复制比双击靠谱
  document.addEventListener('focus', (e) => { if (e.target === $('#shareUrl')) e.target.select(); }, true);

  window.Share = { open, close, urlOf, isWeChat };
})();
