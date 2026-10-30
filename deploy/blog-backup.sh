#!/bin/bash
# 每日备份 /opt/blog/data/db.json —— 全站唯一状态（5MB+，含 base64 图片与访客记录）。
#
# 保留策略用「固定 14 个槽位、按日轮转覆盖」而不是 find -delete：
# 保留期同样有界（约 14 天），但不需要任何删除命令，误配 cron 也不会把历史清空。
#
# 一致性：应用是「写 db.json.tmp 再 rename」的原子落盘，gzip 直接读原文件即可拿到
# 完整快照——rename 不影响已打开的 fd，所以不必先复制一份再删。
#
# 局限（重要）：备份和原库在同一块盘上。上一台新加坡实例整机释放时，若备份只在机内，
# 一样会丢。要真正安全得把槽位同步到机外（OSS 或其它服务器），见手册待办。
set -u
SRC=/opt/blog/data/db.json
DIR=/var/backups/blog
SLOT=$(( 10#$(date +%d) % 14 ))
OUT="$DIR/db-slot$(printf '%02d' "$SLOT").json.gz"
LOG=/var/log/blog-backup.log

mkdir -p "$DIR"
[ -f "$SRC" ] || { echo "$(date '+%F %T') 源文件不存在，跳过" >> "$LOG"; exit 1; }

TMP="$OUT.tmp"
gzip -c "$SRC" > "$TMP" && mv "$TMP" "$OUT"

# 校验：gzip 完整性 + 真能解析成带 posts 数组的合法 JSON（备份不可用等于没备）
SUM=$(gzip -dc "$OUT" 2>/dev/null | node -e '
let s = "";
process.stdin.on("data", (d) => { s += d; });
process.stdin.on("end", () => {
  try {
    const d = JSON.parse(s);
    if (!Array.isArray(d.posts)) { console.log("BAD:no-posts-array"); return; }
    console.log("posts " + d.posts.length + " comments " + (d.comments||[]).length
      + " likes " + (d.likes||[]).length + " visit_events " + ((d.visit_events||[]).length));
  } catch (e) { console.log("BAD:" + e.message.slice(0, 60)); }
});' 2>/dev/null || echo "BAD:node-fail")

case "$SUM" in
  BAD:*|"")
    echo "$(date '+%F %T') 校验失败 slot=$SLOT $SUM" >> "$LOG"; exit 1 ;;
  *)
    echo "$(date '+%F %T') OK slot=$SLOT size=$(du -h "$OUT" | cut -f1) sha256=$(sha256sum "$OUT" | cut -c1-16) $SUM" >> "$LOG"
    ;;
esac
