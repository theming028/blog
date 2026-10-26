# 朝夕光年

微信朋友圈风格的个人博客。零 npm 依赖，只用 Node 内置模块，`node server.js` 即可运行。

## 运行

```bash
node server.js            # 默认 http://localhost:8081
PORT=3000 HOST=127.0.0.1 node server.js
```

要求 Node ≥ 18（云端运行时是 Node 22）。无需 `npm install`。

| 路由 | 说明 |
| --- | --- |
| `/` | 信息流（点赞、评论、回复、大图查看、分页、友链、飘雪） |
| `/admin` | 后台：内容 / 评论审核 / 访客记录 / 友链 / 设置 |
| `/edit` | 发布与编辑 |
| `/login` | 后台登录 |

## 存储

`lib/store.js` 有两个驱动，暴露同一套异步接口，业务代码不感知：

- **LocalStore** — 读写 `data/db.json`；图片以 base64 内联在该文件里（不是 `data/images/`，那个目录没在用）。每次写入是整文件重写（先写 `.tmp` 再 `rename`，避免写坏）。
- **SupabaseStore** — 当环境里有 `SUPABASE_URL` + `SUPABASE_ANON_KEY` 时自动启用，走 PostgREST。QW Pages 发布后由运行时注入这两个变量。

首次启动若库里没有帖子：`store.kind === 'supabase'` 且存在随包的 `data/db.json` 快照时，`lib/migrate.js` 会把快照导入云端并重建 id 映射（评论、点赞、帖子图片的外键都会重挂），成功后写 `settings._migrated` 标记；之后重启不再导入。库完全为空时走 `lib/seed.js` 写示例内容。

> ⚠️ 跨环境同步图片要按**字节内容哈希**匹配，不能按 id 比对：导入会重新生成所有图片 id，按 id 判"目标端没有"会造成重复上传。

## 后台口令

`server.js` 顶部 `ADMIN_USER` / `ADMIN_PASS_HASH`。改口令：

```bash
node -e "console.log(require('crypto').createHash('sha256').update('tm-blog-salt:新密码').digest('hex'))"
```

把输出替换 `ADMIN_PASS_HASH` 并重启。会话存在进程内存，重启后后台需重新登录。
`/api/login` 有限流：同 IP+用户名 60 秒内累计 5 次失败锁 429。

## 前端约定

- **默认设置只有一处**：`server.js` 的 `DEFAULT_SETTINGS`。`GET /api/settings` 只回 `cover/avatar/nickname/sign/snow` 五个键（白名单 `PUBLIC_SETTING_KEYS`）；前台不写死任何兜底值。（历史上它散在四个文件，改封面必漏。）
- **缓存**：`html/css/js` 是 `no-cache` + `ETag`/`Last-Modified`（命中返回 304），改完**普通刷新即生效**；`public/` 下图片 `max-age=300`；`/api/images/*` 因 id 内容寻址，用 `immutable` 一年。
- **CSP 为 `script-src 'self'`**：不要往 HTML 里加内联 `<script>`，会被拦。内联样式属性可以用（`style-src` 允许 `unsafe-inline`）。
- **全局字体**在两份 CSS 的 `body` 上（`wx.css` 前台，`admin.css` 后台/发布/登录），表单控件靠 `font-family: inherit` 跟上。
- 评论反垃圾在 `lib/spam.js`，命中转 `pending` 进后台待审，前台不展示。
- **点赞是累加模型**：`POST /api/posts/:id/like` 每次记一行（双击可累加），`DELETE` 清空该访客在这条下的全部赞；
  按 `IP+帖子` 节流（1 秒 3 次 / 60 秒 60 次）。**不要**给 `likes` 加唯一索引或在应用层恢复去重查询。
- **访客计数**：`POST /api/visit`（公开）只存 `sha256(固定盐 + IP)` 截 32 位，不落原始 IP。取 IP 依次试
  `ali-swift-real-client-ip` / `x-real-ip` / `cf-connecting-ip` → `x-forwarded-for` 首段 → socket，
  每段都过 `net.isIP`；并按**不可伪造的 socket IP** 节流（60 秒 20 次）。云端计数缓存 60 秒，
  兜底查询恒带 `limit=1`，绝不做全表拉取。CDN 后可能因共享出口 IP 而少计。

## 访客记录

后台「访客记录」= **会话表 + 行为流水**，采集端 `public/js/track.js`，服务端 `lib/visit.js`，
IP 归属地 `lib/geoip.js`。记录 IP、省市、设备/浏览器、进入与末次时间、停留时长、行为动作。

**这是一次有意的隐私口径转向**：原先只存 `sha256(盐+IP)` 的独立访客数（见上一节「访客计数」，
页脚那行仍按老口径走，两者互不影响），现在**原始 IP 明文入库**、后台可见。数据只存在自己的库里、
只有登录后的后台能读，但请把它当成"你在收集访客地理位置"来对待。

- **时长由服务端累计，不信客户端秒数**：前端每 30 秒 ping 一次，服务端给 `now - last_seen` 记账，
  单次上限 90 秒（后台标签页的定时器会被浏览器节流到分钟级，不设上限会漏算，设了也没法伪造）。
  页面切到后台时前端停止心跳，切回来先补一次 `sync`（只拨时钟、不计入），否则"合上电脑十分钟再打开"
  会被算成十分钟浏览。
- **sid 由服务端签发**：客户端带的 sid 只是"想接着这个会话记"的凭据。认得、且归属同一
  `visitor_hash`、且 30 分钟内活跃过才复用，否则另发一个——否则谁都能猜个 sid 把动作记到别人头上。
- **公开写端点全限流 + 白名单**：`start` 每分钟 20 次、`ping`/`event` 合计每分钟 90 次（按不可伪造的
  socket IP），动作类型走 `EVENT_LABEL` 白名单（`pv/post_read/like/unlike/comment/cmt_edit/cmt_del/image_view/blogroll_click/page_turn`），
  `target` 截 64 字、`detail` 截 200 字，单会话动作上限 500 条。
- **留存**：默认 90 天滚动 + 会话 2 万 / 动作 5 万行上限，启动时清一次、之后每 6 小时一次
  （`lib/visit.js` 顶部三个常量可改）。后台另有单条与批量删除。
- **归属地**：只在**新建会话**时查，结果按 IP 落库缓存 30 天，失败负缓存 1 小时，连续失败 3 次熔断 10 分钟；
  查询异步补写、不挡首屏；查不到就显示"未知"，绝不因此丢记录。内网/回环 IP 不查。
  - ⚠️ **会把访客 IP 交给第三方接口**（默认 ip-api.com 免费版，仅 http）。不想外发就设
    `GEOIP_OFF=1`；也可用 `GEOIP_ENDPOINT` 换成自建服务（模板含 `{ip}` 占位）。
  - CDN/代理后拿到的是出口 IP，省市可能只精确到机房。
- **track.js 不往 feed.js 里插任何调用**（两个设备并行改 feed.js 时最容易冲突），只用三个对外面：
  覆写 `common.js` 的全局 `api()`（只记**成功**的动作）、观察 `#viewer` 的 class 变化与 `#feed` 的节点变化、
  友链/页码的委托点击。**若 feed.js 将来改成 ES module，`api` 不再是可覆写的 global，第 1 条会静默失效**，
  届时把 `installApiHook()` 换成显式调用点。
- **管理员自己在前台的访问会被标 `admin`**，后台可勾「隐藏我自己」过滤；`bot`（UA 命中爬虫特征）同理打标，
  且机器人不做在线归属地查询。
- 表格用 `table-layout: fixed` + `colgroup` 钉死列宽：展开行的 UA / 动作明细都是不换行长文本，
  自动布局会把表的 min-content 撑宽、超出面板后被 `.adm-panel` 的 `overflow:hidden` 裁掉，
  症状是"明细列凭空消失"。窄屏隐藏"进入时间"列后 `col` 会整体左移一位，媒体查询里按 5 列重排过。

**云端建表**（发布前先执行）：

```sql
CREATE TABLE IF NOT EXISTS visit_sessions (
  id text PRIMARY KEY, visitor_hash text, ip text,
  geo_label text, geo_country text, geo_region text, geo_city text, geo_isp text,
  ua text, device text, browser text, os text,
  bot boolean NOT NULL DEFAULT false, admin boolean NOT NULL DEFAULT false,
  referrer text, page text,
  started_at timestamptz NOT NULL DEFAULT now(), last_seen timestamptz,
  duration_ms bigint NOT NULL DEFAULT 0, pv integer NOT NULL DEFAULT 0,
  event_count integer NOT NULL DEFAULT 0, ended boolean NOT NULL DEFAULT false);
CREATE INDEX IF NOT EXISTS vs_started_idx ON visit_sessions (started_at DESC);
CREATE INDEX IF NOT EXISTS vs_last_seen_idx ON visit_sessions (last_seen DESC);
CREATE INDEX IF NOT EXISTS vs_ip_idx ON visit_sessions (ip);

CREATE TABLE IF NOT EXISTS visit_events (
  id text PRIMARY KEY, session_id text NOT NULL, visitor_hash text, ip text,
  type text NOT NULL, target text, detail text,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS ve_session_idx ON visit_events (session_id, created_at);
CREATE INDEX IF NOT EXISTS ve_created_idx ON visit_events (created_at);

-- 未命中时 value 存 {"miss": true} 哨兵：jsonb 里的 SQL NULL 和本地 null 回读时区分不开
CREATE TABLE IF NOT EXISTS ip_geo_cache (
  ip text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
```

三张表都以 text 主键 + 客户端生成的 id 落地（与 `images` 同一做法），批量删与按 offset 裁剪才不需要 RPC。
`visit_sessions` 的列名改动要同步 `lib/store.js` 的 `SESSION_COLS` 白名单——PostgREST 遇到未知列是把整条
PATCH 打回 400，而不是忽略那一列。


## 音视频

一条内容可挂最多 3 段 HTML5 音视频，**只存外链地址，本站不托管媒体文件**：
`post.media = [{ kind: 'video'|'audio', url, poster?, autoplay }]`。

不托管的两条硬理由：① 发布包 = 项目目录全部内容，而 `data/db.json` 已有 4MB 纯图片 base64，
几十 MB 的视频一旦进库会让每次发布都重传；② base64 内联的接口给不出 HTTP Range，
iOS Safari 对不能拖动进度的视频源直接拒绝播放。所以拖动进度条要求**源站支持 Range**。

- 服务端 `sanitizeMedia()` 与访客主页共用 `safeHttpUrl()` 白名单：非 http(s)、无点主机、
  未知 kind、超过 2048 字符的条目**静默丢弃**（一个贴错的链接不该挡住整条发布），
  并回传被丢条数；编辑页在提交前会把非法地址**指名报错**，避免"保存后悄悄没了"。
  更新时若一批条目被全部丢光，**不会**覆盖原有媒体（真要清空请显式传 `media: []`）。
- **CSP 放开两条是硬前提**：`media-src http: https:` 与 `img-src` 补 `http: https:`（封面图）。
  只写 `default-src 'self'` 会把外链媒体整个拦死，症状是代码全对、线上一个字节都拉不到，
  控制台报 `media-src` 违规 + `MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check`。
- 地址必须是 https：站点在 https 下，http 的媒体会被浏览器按混合内容拦掉。
- `PUT /api/posts/:id` 只在请求体含 `media` 时才更新它，所以只改正文不会冲掉已有媒体。
- 空正文 + 只有音视频 允许发布（纯视频动态是主用途）。
- 自动播放只对**视频**开放：音频若自动播放必然静音（浏览器策略），只剩进度条在走没声音，
  所以编辑页里音频行的勾选框是禁用的，渲染层也不给 audio 加 `data-autoplay`。
- 自动播放刻意**不写** `autoplay` 属性，改成 `data-autoplay` 交给 `feed.js` 的 IntersectionObserver
  在元素**进入视口 25% 面积**时才 `play()`，且只在 play 真正成功后记一次标记（iOS 上非手势的
  play() 可能被拒一次，提前记标记会让这条视频此后永不再自动起播）；另有 autoTried 防止反复重试。
- 视频 `preload="none"`（刷列表零流量），音频 `preload="metadata"`（要文件头才画得出时长与进度条）。
- 同一时刻只允许一个在播（`play` 事件不冒泡，监听走捕获阶段）；滚出视口自动暂停；
  帖子节点被重建前会先 `unobserve` + `pause` 并保留播放位置，避免"点个赞视频就从头播"。
- `video` / `audio` 在双击点赞的排除列表里：原生双击是切全屏，不该被当成点赞。

**云端建列**（发布前先执行）：

```sql
ALTER TABLE posts ADD COLUMN IF NOT EXISTS media jsonb NOT NULL DEFAULT '[]'::jsonb;
UPDATE posts SET media = '[]'::jsonb WHERE media IS NULL;
```

缺列时 `SupabaseStore.supportsMedia()` 会探测到并**降级为不带 media 字段照发**，
同时在响应里回 `warning`、编辑页当面提示"视频未保存"——否则这个可选功能会把全站
发帖与编辑打成 500（`createPost` 无条件带 media，缺列就是整条写入被 PostgREST 打回）。
## 发布

QW Pages（动态页）：`category: "dynamic"`、`entrypoint: "server.js"`、`port: 8081`、`with_database: true`，先 provision 再建表。
同一项目重复发布会发到**同一域名并递增版本号**，不会新开站点。

建表需覆盖 **10 张表**：`posts / comments / likes / images / settings / links / visitors`
+ 访客记录的 `visit_sessions / visit_events / ip_geo_cache`（DDL 见上文「访客记录」）。
注意 `createPost`/`addComment`/`addLike`/`createLink` **不下发 `id`**，评论/点赞/友链也不下发 `created_at`，
所以这些列必须有数据库默认值，否则写入直接失败；`visitors` 以 `hash` 作主键，重复上报靠
`Prefer: resolution=ignore-duplicates` 去重。

> ⚠️ **不要给 `likes(post_id, client_key)` 建唯一索引。** 点赞是"双击可累加"模型
> （`POST /api/posts/:id/like` 每次都记一行，取消则清空该访客在这条下的全部赞）。
> 唯一索引会让第二次及以后的赞被数据库静默丢弃——不报错、界面只是"点不动"，极难排查。
> 同理，别在应用层恢复"是否已赞"的去重查询。

## 已知待办

- 线上（Supabase）与本地（LocalStore）是两套数据，会各自演化；发布不会覆盖线上内容，但线上也不会回流本地。若长期双轨，需要定一个主数据源。
- `LocalStore` 删帖不会回收 `images` 表里的图片行，孤儿数据会累积（线上同理）。
- 封面图目前是 1.31MB 的 PNG 插画，转 JPEG/WebP 可显著变小；封面槽位是 640×280 横条、`object-position: center bottom`（这张插画主体在底部，居中裁切会把人和狗裁掉），换主体居中的图时记得改回 `center`。
