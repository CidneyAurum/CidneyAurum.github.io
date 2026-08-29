---
title: 如何发布一篇新文章 / 新照片
date: 2026-08-29
tags: 指南
emoji: 📝
summary: 两种发文方式和零门槛的发图方式：GitHub 网页直接写，或本地一条命令。
---

这个博客没有后台、没有数据库，但发文发图已经被优化到**几乎零门槛**——不用写 HTML、不用手动登记目录。

## 方式一：在 GitHub 网页上发文（推荐，零工具）

1. 打开本仓库，进入 `_posts/` 文件夹，点 **Add file → Create new file**
2. 文件名用英文加 `.md` 后缀，比如 `my-first-note.md`
3. 按下面的格式写（`---` 之间的信息会被自动读取）：

```markdown
---
title: 文章标题
date: 2026-09-01
tags: 日常, 笔记
emoji: 🪐
summary: 显示在归档列表里的一句话摘要
---

这里开始写正文，**Markdown 语法**都支持：

- 小标题用 `##`
- **加粗**、*斜体*、`行内代码`
- 列表、引用、[链接](https://example.com)、图片都可以
```

4. 点 **Commit changes** 提交 → GitHub Actions 会自动把它变成排版好的文章页、更新归档目录 → 一两分钟后线上就能看到

## 方式二：本地发文

在 `_posts/` 里写好 `.md` 文件，然后：

```bash
python tools/build.py
git add -A && git commit -m "发布新文章" && git push
```

## 发照片：丢图就行

把图片传进仓库的 `assets/gallery/` 文件夹（GitHub 网页上 Add file → Upload 就能拖拽上传），构建时会**自动扫描**生成照片墙。

文件名建议用「标题_年-月」的格式，标题和日期会自动识别：

- `泡面_2026-08.jpg` → 标题「泡面」，日期 2026 · 08
- `summer.png` → 标题「summer」，日期显示 MEMORY

## 正文常用 Markdown 语法

| 写法 | 效果 |
|---|---|
| `## 标题` | 小标题 |
| `**加粗**` | **加粗** |
| `` `代码` `` | 行内代码 |
| `> 引用` | 引用块 |
| ``` 代码块 ``` | 代码块 |
| `[文字](链接)` | 超链接 |
| `![描述](图片路径)` | 插图（图片放 `assets/` 再引用） |

> 进阶：文章的封面默认用 `emoji`，也可以在 front-matter 里写 `cover: assets/xxx.jpg` 用图片当封面。
