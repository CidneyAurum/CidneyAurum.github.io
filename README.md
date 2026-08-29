# CidneyAurum の 小窝 🌌

一个深空玻璃拟态风格的个人网站（主页 + 博客 + Limbus 歌词演出模拟器），纯 HTML/CSS/JS 手写，部署在 GitHub Pages 上，**没有任何构建步骤**——改完代码 push 即上线。

**线上地址**：`https://cidneyaurum.github.io`（部署完成后替换）

## 目录结构

```
├── index.html          # 主页（资料卡 / 环境电台 / 打字横幅 / 最新文章 / 时钟条）
├── blog.html           # 拾光档案：搜索 + 标签 + 时间轴/网格双视图
├── photos.html         # 光影画廊：拍立得照片墙
├── about.html          # 关于：足迹时间线 / 技能 / 联系方式
├── limbus.html         # Limbus 风格歌词演出模拟器（网页版）
├── 404.html            # 404 页
├── posts/
│   ├── posts.json      # 文章目录（发新文章要在这里登记）
│   └── *.html          # 每篇文章一个 HTML 文件
├── css/style.css       # 全站样式（主题色在这里改）
├── js/main.js          # 流萤 / 打字横幅 / 时钟 / 归档双视图
├── js/player.js        # 环境电台：Web Audio 合成音乐 + 全站迷你播放器
├── js/limbus.js        # 歌词演出引擎（手动 / 自动 / 音乐同步）
└── assets/             # 头像、背景图（background.png）、照片墙（gallery/）
```

## 本地预览

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

3. Commit 提交 → GitHub Actions 自动生成文章页并更新归档 → 约 1 分钟后线上可见

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

- 代码推送到 GitHub 后，GitHub Pages 自动部署（约 1 分钟生效）
- 仓库设置在 GitHub 的 **Settings → Pages**，来源是 `main` 分支根目录
- 想绑自定义域名：在仓库根目录加一个 `CNAME` 文件（内容写域名），并在域名处配置解析

## 可选：开启看板娘

想加 Live2D 看板娘，在 `index.html` 的 `</body>` 前加一行（模型资源走公共 CDN）：

```html
<script src="https://fastly.jsdelivr.net/npm/live2d-widgets@1.0.1/dist/autoload.js"></script>
```

> 注意：Live2D 模型版权归模型作者所有，仅供个人非商用。不想要时删掉这行即可。

## 致谢

- 设计风格参考：[xmyl-153/xingmengyouling-blog](https://github.com/xmyl-153/xingmengyouling-blog)（深空玻璃拟态布局思路，代码均为本站原创实现）
- [Tempura3 / Limbus-Like-Lyric-Simulator](https://github.com/TempuraYMY0728/Limbus-Like-Lyric-Simulator) — 歌词演出方案的开山之作
- [YouRanCoder / LimbusLyricSimulator](https://github.com/YouRanCoder/LimbusLyricSimulator)（GPL-3.0）— 桌面版歌词模拟器
- [imsyy/home](https://github.com/imsyy/home)（MIT）— 一言 API 用法
- 一言 API：[hitokoto.cn](https://hitokoto.cn/)

## 看板娘 🎵

右下角的 Live2D 看板娘（Miku）：

- **AI 对话**：点她的 💬 打开对话框。首次使用点 ⚙️ 填三个东西：接口地址（默认 DeepSeek 官方，可换任何 OpenAI 兼容接口）、模型名、API Key（只存你自己浏览器的 localStorage）。没有 Key 也能用本地卖萌语料聊天。
- **互动**：点她触发比心、拖拽移动、滚轮缩放、🙈 可以让她躲起来。
- **技术**：pixi.js + pixi-live2d-display 渲染，AI 走 OpenAI 兼容 `/chat/completions`，回复支持触发表情（让她带【表情:比心】标记即可）。
- **🎵 音乐点播**：跟她聊就行——「放 晴天」「来一首atu」「播放歌单」「下一首」「暂停」。她会搜索网易云并**开口唱**（口型同步）。
  - 歌单卡在首页「🎵 我的歌单」标签（官方外链播放器）
  - VIP 歌曲在公共源下只能试听；想全曲点播看 [docs/music-api.md](docs/music-api.md)（Cloudflare Workers 自建 API，可选）
  - 公共源偶尔不稳，可在 ⚙️ 设置里填自己的 Meting 格式 API 地址

### 模型版权说明

`assets/live2d/miku/` 内模型为「初音未来·玄宝酱×怂怂koe 高清版」：

- 人物绘制：**玄宝酱**；人物建模：**怂怂koe**
- 仅供 miku 二创使用，**禁止商用、禁止直播牟利**；本仓库仅个人非商用用途
- 该模型作者条款禁止二次上传与二次分发——本仓库托管模型文件已获站主自行斟酌，**请勿将模型文件再分发**；如需使用请向原作者获取授权
