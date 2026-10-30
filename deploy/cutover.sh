#!/bin/bash
# 备案通过后的域名切换：本地自检 → （外部确认）→ 签发 → 装证书 → 切 HTTPS → 外部复核
#
# 为什么必须带 --confirmed：
#   阿里云的未备案拦截只作用于「从公网进入 80/443」的流量。在服务器自己身上 curl 域名，
#   走的是内网回环，会绕过拦截拿到 200 —— 自测必然假绿（本脚本第一版就栽在这里）。
#   所以外部可达性由操作者从公网侧确认后，用 --confirmed 显式传给脚本。
set -uo pipefail
DOMAIN=shaoym.me
ACME=/root/.acme.sh/acme.sh
WEBROOT=/var/www/certbot
STAGE=/root/deploy
CONFIRMED=0
[ "${1:-}" = "--confirmed" ] && CONFIRMED=1

fail() { echo "❌ $*"; exit 1; }

echo "=== 1/5 本地自检：Nginx 能否正确吐出 ACME 挑战文件 ==="
mkdir -p "$WEBROOT/.well-known/acme-challenge"
TOKEN="selfcheck-$(date +%s)"
echo ok > "$WEBROOT/.well-known/acme-challenge/$TOKEN"
BODY=$(curl -s --max-time 15 -H "Host: $DOMAIN" "http://127.0.0.1/.well-known/acme-challenge/$TOKEN" || true)
rm -f "$WEBROOT/.well-known/acme-challenge/$TOKEN"
[ "$BODY" = "ok" ] || fail "Nginx 未能返回挑战文件（得到：${BODY:0:80}）——先修 ACME location"
echo "  ✅ 挑战路径可用（此项只证明本机配置正确，不代表公网可达）"

echo "=== 2/5 外部可达性确认 ==="
if [ "$CONFIRMED" != "1" ]; then
  cat <<'HINT'
  未带 --confirmed，已停止（不会尝试签发，不消耗 Let's Encrypt 配额）。
  请在公网侧执行下面两行，第二行必须输出 ok：
    ssh -i deploy_key root@8.137.115.150 'echo ok > /var/www/certbot/.well-known/acme-challenge/p.txt'
    curl -s http://shaoym.me/.well-known/acme-challenge/p.txt      # 从本机/手机流量发起，不能从服务器发起
  看到 ok 后再跑：/root/deploy/_cutover.sh --confirmed
  若返回 Non-compliance ICP Filing 拦截页，说明备案仍未生效。
HINT
  exit 2
fi
echo "  操作者已确认公网可达，继续"

echo "=== 3/5 签发证书（HTTP-01 / webroot）==="
if [ -f "/root/.acme.sh/$DOMAIN/$DOMAIN.cer" ]; then
  echo "  已有证书，强制续签"
  $ACME --renew -d "$DOMAIN" --force --webroot "$WEBROOT" || fail "续签失败"
else
  $ACME --issue -d "$DOMAIN" -d "www.$DOMAIN" -w "$WEBROOT" --server letsencrypt --keylength 2048 || fail "签发失败"
fi

echo "=== 4/5 安装证书到 Nginx 路径并绑定 reload ==="
mkdir -p "/etc/letsencrypt/live/$DOMAIN"
$ACME --install-cert -d "$DOMAIN" \
  --key-file       "/etc/letsencrypt/live/$DOMAIN/privkey.pem" \
  --fullchain-file "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" \
  --reloadcmd      "systemctl reload nginx" || fail "安装证书失败"
chmod 600 "/etc/letsencrypt/live/$DOMAIN/privkey.pem"

echo "=== 5/5 切 HTTPS 并复核 ==="
[ -f "$STAGE/shaoym.me.https.conf" ] || fail "缺少 $STAGE/shaoym.me.https.conf"
cp "$STAGE/shaoym.me.https.conf" /etc/nginx/conf.d/shaoym.me.conf
if ! nginx -t >/dev/null 2>&1; then
  cp "$STAGE/shaoym.me.http.conf" /etc/nginx/conf.d/shaoym.me.conf
  nginx -t && systemctl reload nginx
  fail "HTTPS 配置校验失败，已回滚到 HTTP 版"
fi
systemctl reload nginx
sleep 2
printf "  https://%-16s -> %s\n" "$DOMAIN/"      "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 --resolve $DOMAIN:443:127.0.0.1 https://$DOMAIN/)"
printf "  证书到期: %s\n" "$(openssl x509 -enddate -noout -in /etc/letsencrypt/live/$DOMAIN/fullchain.pem 2>/dev/null)"
echo "  最后一步请从公网侧确认： curl -sI https://shaoym.me/ | head -1"
echo "DONE"
