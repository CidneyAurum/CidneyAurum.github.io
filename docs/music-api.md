# 音乐 API 进阶：VIP 全曲点播（Cloudflare Workers 自建源）

> 这是**可选**的进阶配置。不配置时，Miku 点播走公共 Meting 源（非 VIP 曲目全部可用，VIP 歌曲只能试听或失败）。
> 自建源后，Miku 点播可以播放**你会员账号可听的完整曲目**。

## 原理

Miku 点播用的是 Meting 协议（`?type=search|url|playlist&server=netease&id=…`）。
公共源是别人部署的服务；你在 Cloudflare Workers 上部署一份同协议 API，并在服务端带上
**你自己的网易云登录凭证（MUSIC_U cookie）**，NetEase 就会把你的会员权益应用到取链请求上——
于是点播 VIP 歌也能拿到完整播放地址。

## 部署步骤（约 10 分钟）

1. **拿 cookie**：浏览器登录 `music.163.com` → F12 → Network → 任意请求的 Request Headers
   → 复制 Cookie 里 `MUSIC_U=xxxxxxxx` 这一整段（只要 MUSIC_U 这一项）。
2. **部署 API**：GitHub 上搜索 `NeteaseCloudMusicApi` 的 Cloudflare Workers 移植版
   （这类项目较多，选 Star 较多、最近有更新的），按其 README 用
   **Deploy to Cloudflare** 按钮或 `wrangler deploy` 部署。
3. **配置凭证**：在 Cloudflare Dashboard → 你的 Worker → Settings → Variables，
   添加环境变量（不同移植版变量名不同，常见为 `NETEASE_COOKIE`），
   值填第 1 步的 `MUSIC_U=xxxxxxxx`。
4. **验收**：浏览器访问 `https://你的-worker.workers.dev/?type=url&server=netease&id=某VIP歌曲ID`，
   返回的 `url` 能播放完整歌曲即为成功。
5. **接入本站**：看板娘 ⚙️ 设置 → 「音乐 API（可选）」填 `https://你的-worker.workers.dev/` → 保存。

## ⚠️ 必读风险

- 这相当于**用你的会员账号给所有访客供曲**。网易云对共享/脚本行为有风控，
  **账号有被限制甚至封禁的可能**。请自行斟酌，建议：
  - 设置 Worker 的访问频率限制，或只在小范围使用
  - 使用小号而非主号
  - cookie 有效期有限（几周~几个月），失效后重复第 1、3 步即可
- 凭证只存在你自己的 Worker 环境变量里，**不会出现在本仓库代码中**
- 本站的公共源回落逻辑不受影响：Worker 挂了自动回落公共源

## 换歌单

歌单 ID 在 `js/music.js` 顶部的 `CFG.playlistId`（当前 `18205251703`）。
首页 iframe 的歌单在 `index.html` 搜索 `outchain/player` 同步修改。
