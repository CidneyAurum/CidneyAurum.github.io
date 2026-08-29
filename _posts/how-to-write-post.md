---
title: 如何发布一篇新文章 / 新照片
date: 2026-08-29
tags: 指南
emoji: 📝
summary: 三种方式从易到难：站内写作台一键发布、本地一条命令、GitHub 网页直接写。
---

发文发图已经做到最简单了，按顺手程度选一种：

## 方式零：写作台（最简单，推荐）

打开网站的 [✍️ 写作台](admin.html)：

- **发文**：填标题 → 写 Markdown（右边实时预览）→ 点「一键发布到 GitHub」。发布后 Actions 自动生成文章页并更新归档，约 1~2 分钟上线。
- **发图**：把图片拖进虚线框（可多选）→ 每张图可以改标题 → 点「全部上传」。照片墙自动更新，连文件名都不用改。

首次使用需要到写作台的「设置」页粘贴一次 GitHub 令牌（Fine-grained PAT，只授权本仓库的 Contents: Read and write），之后浏览器会记住。

## 方式一：本地一条命令

在 `_posts/` 里写一个 `xxx.md`（格式见下），然后：

```bash
python tools/build.py
git add -A && git commit -m "发布新文章" && git push
```

## 方式二：GitHub 网页直接写

仓库 → `_posts/` → Add file → Create new file → 文件名用英文（如 `my-first-note.md`）→ 写完提交即可。

## Markdown 文件格式

```markdown
---
title: 文章标题
date: 2026-09-01
tags: 日常, 笔记
emoji: 🪐
summary: 一句话摘要
---

正文用 Markdown 写。
```

**其实只有标题是必须的**：不写日期默认今天，不写摘要会自动截取正文第一段，标签/emoji/封面都能省略。

常用语法：`## 标题`、`**加粗**`、`` `代码` ``、`> 引用`、`[链接](网址)`、`![图](图片路径)`、代码块用三个反引号包裹。

## 发照片的补充说明

- 图片标题默认取文件名，想改可以在写作台上传时填写
- 不写日期的图片会自动使用上传当月
- 封面进阶：front-matter 里写 `cover: assets/xxx.jpg` 可以用图片当文章封面
