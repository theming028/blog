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
| `/` | 信息流（点赞、评论、回复、大图查看、分页、友链） |
| `/admin` | 后台：内容 / 评论审核 / 友链 / 外观设置 |
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

建表需覆盖 **7 张表**：`posts / comments / likes / images / settings / links / visitors`。
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
