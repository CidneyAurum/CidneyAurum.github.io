# CidneyAurum の 小窝 🌌

一个深空玻璃风格的个人网站，包含手记、说说、相册、音乐、看板娘与 Limbus 歌词演出。前端使用纯 HTML/CSS/JS，不依赖框架或打包器；Markdown 与图片由 Python 生成，GitHub Actions 在回归检查通过后构建发布。

**线上地址**：[cidneyaurum.github.io](https://cidneyaurum.github.io/)。新版已上线并通过正式域名浏览器验收，AI 由公网 Worker 提供，直接访问即可使用。

本次维护的功能结果与外部依赖见 [功能验收](docs/functional-acceptance.md)，界面修改位置见 [界面维护](docs/ui-redesign.md)，运行测试和发布设置见 [构建与部署](docs/build-and-deploy.md)。

首页「初音的值班室」可以带逛真实内容、比心、试听日语角色短句，或进入「耳机分你一半」听歌房。角色语音使用现成短音频，AI 长回复只显示文字。操作与维护见 [Miku 的陪伴体验](docs/miku-companion.md)。

「问问 Miku」支持 DeepSeek 聊天、文章总结与选段解释、带出处的站内问答、内容与歌曲推荐，以及写作台拟标题、摘要和润色。写作建议先审阅再手动应用，可以撤销；日语短语音用于互动，长回复以文字呈现。

公网网关：[cidney-miku-ai.1562614833.workers.dev](https://cidney-miku-ai.1562614833.workers.dev)。全站每日 100 次额度已生效（UTC 日），Pages 使用 GitHub Actions 发布；[本次构建与部署](https://github.com/CidneyAurum/CidneyAurum.github.io/actions/runs/40171647787)均成功，186 项 CI 检查通过。正式域名的文章总结、真实引用、手机侧栏及写作标题应用/撤销均已验证。访客无需运行本机脚本或填写模型密钥，凭据由 Workers Secrets 管理。使用见 [AI 使用说明](docs/ai-api.md)，发布记录见 [公网 AI 部署](server/DEPLOYMENT.md)。

文章、说说和照片经 GitHub Actions 发布后，Worker 从 Pages 的公共知识索引在线同步，采用 60 秒缓存、到期后由后续请求刷新。日常内容更新无需重启本机服务或重新部署 Worker。

## 目录结构

```
├── index.html          # 主页（资料卡 / 网易云歌单 / 环境电台 / 打字横幅 / 时钟条）
├── blog.html           # 拾光档案：搜索 + 标签 + 时间轴/网格双视图
├── says.html           # 说说：朋友圈式时间轴
├── photos.html         # 光影画廊：拍立得照片墙
├── limbus.html         # Limbus 风格歌词演出模拟器（网页版）
├── about.html          # 关于：足迹时间线 / 技能 / 联系方式
├── admin.html          # 写作台：发文 / 发说说 / 发图（站主专用）
├── 404.html            # 404 页
├── posts/
│   ├── posts.json      # 文章目录（build.py 自动生成）
│   └── *.html          # 每篇文章一个 HTML 文件（build.py 自动生成）
├── css/style.css       # 全站样式（主题色在这里改）
├── css/garden.css      # 新版全站视觉、深浅主题和手机适配
├── js/garden.js        # 主题卡、首页数据、图标和看板娘按需加载
├── js/main.js          # 流萤 / 打字横幅 / 时钟 / 归档双视图 / 说说 / 照片墙
├── js/music.js         # MikuMusic 点播引擎（歌单 / 歌词 / Limbus 弹词）
├── js/kanban.js        # 看板娘：Live2D + AI 多协议对话 + 点歌联动
├── js/player.js        # 环境电台：Web Audio 合成音乐
├── js/limbus.js        # 歌词演出引擎（手动 / 自动 / 音乐同步）
├── js/admin.js         # 写作台逻辑（GitHub Contents API 发布）
├── data/playlist.json  # 网易云歌单快照（107 首，含封面）
├── data/knowledge.json # 构建生成的公共知识索引，供公网 AI 在线同步
├── data/ai-config.json # 公网网关地址，不保存模型密钥
├── server/worker.mjs   # Cloudflare AI 网关与持久请求额度
├── tools/build.py      # 内容构建（md → 文章页 / RSS / sitemap）
├── tools/version_pin.py# CI 资源版本号指纹（git 短 SHA，根治 CDN 缓存）
└── assets/             # 头像、背景图（background.png）、照片墙（gallery/）、Live2D 模型
```

> **版本号机制**：页面的静态资源引用带 `?v=N`；CI 构建时会用本次提交的 git 短 SHA 更新版本号（`tools/version_pin.py`），让新资源获得新的 URL。等待测试、构建与 Pages 部署成功后，再刷新检查线上版本，无需手动改版本号。

## 可选：本机开发预览

网站用了 `fetch` 加载文章列表，**直接双击 HTML 打开是不行的**，需要起一个本地服务器：

```bash
# 在仓库根目录执行（任选其一）
python -m http.server 8000
npx serve .
```

然后浏览器打开 `http://localhost:8000`。

## 怎么改成自己的内容

代码里所有需要改的地方都标了 `✏️` 注释，搜一下就能找到：

| 想改什么 | 去哪里改 |
|---|---|
| 名字 / 自我介绍 | `index.html` 资料卡和「关于我」板块 |
| 站名（logo） | 每个 HTML 的 `<a class="logo">` |
| 联系方式 / GitHub 链接 | 各页面 `<nav>` 和资料卡 |
| 头像 | 头像文件是 `assets/avatar.jpg`，想换就同名替换它 |
| 全站背景 | `assets/background.png`（CSS 自动做模糊+压暗处理，想换就同名替换；删掉它则回退极光渐变） |
| 照片墙 | 改 `photos.html` 里的 figure 列表，图片放 `assets/gallery/` |
| 环境电台 | `js/player.js` 顶部的和弦/速度参数；也可点「📁 本地」用自己的 mp3 |
| 打字横幅文案 / 网站生日 / 粒子开关 | `js/main.js` 顶部的 `SITE_CONFIG` |
| 主题配色 | `css/style.css` 顶部的 `:root` 变量（默认夜间，`body.light` 为日间） |

## 怎么发新文章（三种方式，从易到难）

**方式零：写作台（最简单）**

打开网站页脚的 [✍️ 写作台](https://cidneyaurum.github.io/admin.html)：填标题、写 Markdown（带实时预览）、点「一键发布」；发图则直接拖拽上传，标题日期自动处理。首次使用需在「设置」粘贴一次 GitHub 令牌（Fine-grained PAT，仅授权本仓库 Contents: Read and write）。

**方式一：GitHub 网页上直接写（无需令牌）**

1. 打开本仓库 → `_posts/` 文件夹 → **Add file → Create new file**
2. 文件名用英文，如 `my-first-note.md`，按这个格式写：

```markdown
---
title: 文章标题
date: 2026-09-01
tags: 日常, 笔记
emoji: 🪐
summary: 一句话摘要
---

正文用 Markdown 写，## 标题、**加粗**、列表、引用、代码块都支持。
```

3. Commit 提交 → GitHub Actions 自动生成文章页并更新归档 → 等待该次提交的 Pages 部署成功后检查线上页面

**方式二：本地**

往 `_posts/` 写好 `.md`，然后 `python tools/build.py` → commit → push。

详细语法见站内文章《如何发布一篇新文章 / 新照片》。

## 怎么发新照片（零登记）

把图片传进 `assets/gallery/`（GitHub 网页支持拖拽上传），构建时自动扫描上墙。

文件名用「标题_年-月」格式可自动识别标题和日期，如 `泡面_2026-08.jpg`；没有日期则显示 MEMORY。

> 原理：GitHub Action（`.github/workflows/build.yml`）在 `_posts/` 或 `assets/gallery/` 变化时自动运行 `python tools/build.py`，生成 `posts/*.html`、`posts/posts.json`、`assets/gallery/gallery.json`。本地没有 Python 也没关系，走方式一即可。

## Limbus 歌词演出模拟器

`limbus.html` 是网页版歌词演出工具：

- **手动模式**：空格 / 点击舞台推进，每第 3 句触发红色斩击 + 震屏
- **自动模式**：定时逐句演出（速度可调）
- **音乐同步**：本地选择音频文件 + 带 `[mm:ss.xx]` 时间轴的 LRC 歌词即可同步演出，音频不会上传
- 桌面版项目：[YouRanCoder/LimbusLyricSimulator](https://github.com/YouRanCoder/LimbusLyricSimulator)（GPL-3.0）

## 部署说明

- Pages 来源已通过 GET 确认为 **GitHub Actions**（`build_type: workflow`）。
- 本轮运行时发布提交为 9e93c7d838a0969a9a833bf44c6120436fa6ddac；[Actions](https://github.com/CidneyAurum/CidneyAurum.github.io/actions/runs/40171647787) 的 build/deploy 均成功，公网页面和 AI 链路已验收。日后推送仍以对应提交的部署结果为准，维护步骤见 [构建与部署](docs/build-and-deploy.md)。
- 公网 AI 使用独立 Worker，后端 Secret 不进入 Pages artifact；内容知识由 Pages 公共索引在线同步。
- 想绑自定义域名：在仓库根目录加一个 `CNAME` 文件（内容写域名），并在域名处配置解析

## 可选：开启看板娘

Miku 已内置。点击右下角猫形按钮按需加载；资源失败时可以在组件里重试。点击 💬 聊天、⚙️ 配置个人接口，▾ 收起后可再次展开。连接站点 AI 网关后，访客无需填写 Key；网关不可用时仍可使用本地简短互动。

## 致谢

- 设计风格参考：[xmyl-153/xingmengyouling-blog](https://github.com/xmyl-153/xingmengyouling-blog)（深空玻璃拟态布局思路，代码均为本站原创实现）
- [Tempura3 / Limbus-Like-Lyric-Simulator](https://github.com/TempuraYMY0728/Limbus-Like-Lyric-Simulator) — 歌词演出方案的开山之作
- [YouRanCoder / LimbusLyricSimulator](https://github.com/YouRanCoder/LimbusLyricSimulator)（GPL-3.0）— 桌面版歌词模拟器
- [imsyy/home](https://github.com/imsyy/home)（MIT）— 一言 API 用法
- 一言 API：[hitokoto.cn](https://hitokoto.cn/)

## 说说 💭

碎片想法+图片的朋友圈式时间轴（`says.html`）：

- **发布**：写作台 → 「💭 说说」标签 → 写文字、选图（自动压缩）→ 一键发布
- **原理**：图片传 `assets/says/`、文字进 `says/says.json`（GitHub API），前端渲染
- 需要 GitHub 令牌（设置页一次性配置，之后全程一键）

## 看板娘 🎵

点击右下角猫形按钮后出现的 Live2D 看板娘（Miku）：

- **AI 对话**：点她的 💬 打开对话框。站点网关可用时自动接入带引用的站内问答；文章页另有总结、提问和选段解释入口。⚙️ 中的个人接口配置会覆盖站点网关，个人填写的 Key 仅保存于该浏览器。网关和个人接口均不可用时提供本地简短互动。
- **互动**：点她触发比心、拖拽移动、滚轮缩放、🙈 可以让她躲起来。
- **技术**：pixi.js + pixi-live2d-display 渲染；站点 AI 由服务端调用 DeepSeek，并校验引用、导航与歌曲目标。角色保留表情互动，长回复只显示文字；日语短句使用现成音频并驱动口型。
- **🎵 音乐点播**：跟她聊就行——「放 晴天」「来一首atu」「播放歌单」「下一首」「暂停」。搜索与播放使用音乐服务，模型口型随音频联动。
  - 歌单卡在首页「🎵 我的歌单」标签（官方外链播放器）
  - VIP 歌曲在公共源下只能试听；想全曲点播看 [docs/music-api.md](docs/music-api.md)（Cloudflare Workers 自建 API，可选）
  - 公共源偶尔不稳，可在 ⚙️ 设置里填自己的 Meting 格式 API 地址

### 模型版权说明

`assets/live2d/miku/` 内模型为「初音未来·玄宝酱×怂怂koe 高清版」：

- 人物绘制：**玄宝酱**；人物建模：**怂怂koe**
- 仅供 miku 二创使用，**禁止商用、禁止直播牟利**；本仓库仅个人非商用用途
- 该模型作者条款禁止二次上传与二次分发——本仓库托管模型文件已获站主自行斟酌，**请勿将模型文件再分发**；如需使用请向原作者获取授权

## v2 重制新功能速览

- **全站音乐中枢**：PJAX 无刷新换页——浏览整站音乐不断；任意页面底部玻璃播放条（拖拽进度 / 音量 / 列表循环·单曲·随机 / 上一首 / 队列抽屉 / 歌词面板点击跳播）；系统媒体键可控；刷新自动恢复播放现场；外链断流自动切歌。
- **歌单快照主源**：`data/playlist.json`（107 首，含封面）秒开零依赖，公共接口仅作在线搜索兜底。
- **giscus 评论**：文章页与说说页已集成 GitHub Discussions 评论，当前本站服务授权失败，待恢复；界面提供重试和讨论区入口。详见 [功能验收](docs/functional-acceptance.md)。
- **PWA**：可安装到桌面，静态资源离线缓存（`sw.js` 运行时缓存）。
- **视觉动效**：主题切换圆形扩散、进站加载遮罩、导航下滑隐藏、卡片 3D 倾斜光晕、鼠标点击爱心。
- **快捷键**：按住 Shift 出提示条——`D` 主题 / `S` 搜索 / `R` 随便逛逛 / `H` 首页 / `T` 回顶 / `空格` 播放暂停 / `Ctrl+K` 搜索。
- **右键菜单**：随便逛逛 / 复制链接 / 切换日夜 / 回到顶部 / 写作台。
- **文章页**：构建时代码高亮（pygments + monokai）、相关文章推荐（按标签）、上/下一篇、og + JSON-LD。
- **性能**：Live2D 纹理 CI 自动量化（25.6MB→5.8MB）、背景预模糊 WebP（1.8MB→11.5KB）、全站缩略图、版本号自动指纹化（git 短 SHA 根治 CDN 缓存）。
