/* 登录页逻辑。原先写在 login.html 的内联 <script> 中，为满足 CSP（script-src 'self'）
   搬到独立文件。本页不加载 common.js，保持自包含。 */
'use strict';

/* ?next= 只允许站内绝对路径。旧写法直接把用户提供的值赋给 location.href，
 * /login?next=https://evil.example 就能在登录成功后把人带走（开放重定向，常用于钓鱼）。
 * 顺带拒掉 //host（协议相对）和含反斜杠的变体。 */
function safeNext(raw) {
  const v = String(raw || '');
  if (!v || v.charAt(0) !== '/' || v.charAt(1) === '/' || v.indexOf('\\') >= 0) return '/admin';
  try {
    const u = new URL(v, location.origin);
    if (u.origin !== location.origin) return '/admin';
    return u.pathname + u.search;
  } catch (e) { return '/admin'; }
}

const next = safeNext(new URLSearchParams(location.search).get('next'));

async function doLogin() {
  const btn = document.getElementById('lBtn');
  const err = document.getElementById('lErr');
  const user = document.getElementById('lUser').value.trim();
  const pass = document.getElementById('lPass').value;
  if (!user || !pass) { err.textContent = '请输入用户名和密码'; return; }
  btn.disabled = true; err.textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, pass }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) { location.href = next; return; }
    err.textContent = data.error || '登录失败';
    if (res.status === 429) { btn.disabled = false; return; } // 限流中：保留服务端给的秒数提示
  } catch (e) { err.textContent = '网络错误，请重试'; }
  btn.disabled = false;
}

document.getElementById('lBtn').addEventListener('click', doLogin);
document.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
