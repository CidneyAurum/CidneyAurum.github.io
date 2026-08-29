# CidneyAurum の 小窝 🌌

一个深空玻璃拟态风格的个人网站（主页 + 博客 + Limbus 歌词演出模拟器），纯 HTML/CSS/JS 手写，部署在 GitHub Pages 上，**没有任何构建步骤**——改完代码 push 即上线。

**线上地址**：`https://cidneyaurum.github.io`（部署完成后替换）

## 目录结构

```
├── index.html          # 主页（资料卡 / 最新文章 / 时钟运行条 / 关于我）
├── blog.html           # 博客列表页（搜索 + 标签筛选）
├── limbus.html         # Limbus 风格歌词演出模拟器（网页版）
├── 404.html            # 404 页
├── posts/
│   ├── posts.json      # 文章目录（发新文章要在这里登记）
│   └── *.html          # 每篇文章一个 HTML 文件
├── css/style.css       # 全站样式（主题色在这里改）
├── js/main.js          # 流萤粒子 / 打字横幅 / 时钟 / 博客渲染
├── js/limbus.js        # 歌词演出引擎（手动 / 自动 / 音乐同步）
└── assets/             # 头像、favicon、照片墙（gallery/）、文章图片都放这里
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
| 照片墙 | 同名替换 `assets/gallery/p1~p4.jpg`（想加更多就照着 index.html 的 gallery 板块复制一个 figure） |
| 打字横幅文案 / 网站生日 / 粒子开关 | `js/main.js` 顶部的 `SITE_CONFIG` |
| 主题配色 | `css/style.css` 顶部的 `:root` 变量（默认夜间，`body.light` 为日间） |

## 怎么发新文章

三步，详细教程见站内文章《如何发布一篇新文章》：

1. 复制 `posts/hello-world.html` 为新文件（文件名用英文）
2. 在 `posts/posts.json` 的 `posts` 数组里加一条登记信息
3. `git add` → `commit` → `push`，自动上线

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
