# 朝夕光年

一个微信朋友圈风格的个人摄影博客。零 npm 依赖，只用 Node 内置模块，`node server.js` 即可启动。

## 功能

- 朋友圈式信息流：文字 / 图片 / 外链音视频，点赞、评论与回复、大图浏览、分页。
- 后台管理：内容发布与编辑、评论审核、友情链接、站点设置。
- 界面与氛围：分层花园背景、飘雪 / 桃花特效、背景音乐播放器。
- 访客浏览记录与统计（仅登录后的后台可见）。

## 环境要求

- Node.js ≥ 18（推荐 22）
- 无需 `npm install`

## 本地运行

```bash
node server.js                 # 默认 http://localhost:8081
PORT=3000 HOST=127.0.0.1 node server.js
```

首次启动会写入少量示例内容，打开 http://localhost:8081 即可浏览。

## 页面入口

| 路径 | 说明 |
| --- | --- |
| `/` | 前台信息流 |
| `/admin` | 后台管理 |
| `/edit` | 发布 / 编辑 |
| `/login` | 后台登录 |

## 数据存储

两种存储方式对上层代码透明：

- **本地模式（默认）**：数据读写在项目内的 `data/db.json`（该文件不纳入版本控制）。
- **云数据库模式**：当环境提供 `SUPABASE_URL` 与 `SUPABASE_ANON_KEY` 时自动启用。这两个值请交由部署平台注入，**不要写进代码，也不要提交到仓库**。

## 设置后台口令

管理员用户名与口令**不写死在代码里**，运行时注入，二者都缺省时后台拒绝任何登录：

- 生产：环境变量 `ADMIN_USER` 与 `ADMIN_PASS_HASH`（从一个受保护的 env 文件 / 密钥管理注入）。
- 本地开发：也可以用被 Git 忽略的 `data/admin-creds.json`，格式 `{ "user": "...", "passHash": "..." }`。

口令采用内存硬核的 scrypt 存储。生成一条 `ADMIN_PASS_HASH`（口令经标准输入读入，避免进入命令行与 shell 历史）：

```bash
read -rs 'P; printf %s "$P"' | node server.js --hash-password; unset P
```

把输出填入 `ADMIN_PASS_HASH` 后重启服务即可。会话保存在进程内存里，重启后需要重新登录。

## 生产部署

用任意进程管理器（例如 systemd）常驻运行 `node server.js`，前面挂一层反向代理处理 HTTPS。凭据通过环境变量提供（`ADMIN_USER` / `ADMIN_PASS_HASH`，以及可选的 `SUPABASE_URL` / `SUPABASE_ANON_KEY`），只放在受保护的 env 文件中，不要提交进仓库。

## 致谢

首屏花园背景的素材与几何取自开源项目 [hibi.garden](https://github.com/hibigarden/site)（MIT License），其版权与许可声明保留在 `public/css/garden-bg.css` 头部。
