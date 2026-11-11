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

## 致谢

首屏花园背景的素材与几何取自开源项目 [hibi.garden](https://github.com/hibigarden/site)（MIT License），其版权与许可声明保留在 `public/css/garden-bg.css` 头部。
