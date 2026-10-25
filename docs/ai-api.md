# Miku AI 使用指南

Miku 面向 GitHub Pages 公网访客提供聊天、文章问答、内容推荐和写作建议。页面由 GitHub Pages 提供，AI 在 Cloudflare Worker 执行；访客无需运行本机服务或提供模型密钥。

**已上线并通过公网验收：** Pages 构建与部署成功，Worker 每日 100 次额度已生效。正式域名已验证文章引用、手机侧栏及写作标题应用/撤销，见 [发布记录](https://github.com/CidneyAurum/CidneyAurum.github.io/actions/runs/40176783139)。

- 网站：[cidneyaurum.github.io](https://cidneyaurum.github.io/)
- AI 网关：[cidney-miku-ai.1562614833.workers.dev](https://cidney-miku-ai.1562614833.workers.dev)
- 状态接口：[GET /api/status](https://cidney-miku-ai.1562614833.workers.dev/api/status)

## 怎样使用

| 功能 | 使用方式 |
| --- | --- |
| chat 聊天 | 从 Miku 聊天入口发送问题，继续追问或取消生成。 |
| article 文章问答 | 使用「一句话读懂」「问问这篇」，或选中文字后解释上下文。 |
| discover 内容推荐 | 请 Miku 推荐站内已有的手记、照片、碎片或歌单内容。 |
| write 写作建议 | 写作台「Miku 的写作便签」可拟标题、提炼摘要、润色选段。 |

站点事实依据公共知识索引，引用可跳到真实文章章节。没有相应文章或经历记录时，应说明资料缺口。跳转、听歌、比心等 action 展示为按钮，由你点击后执行。

写作建议先出现在可编辑的建议框。确认后点「应用到标题」「应用到摘要」或「替换选中段落」，也可以复制建议；「撤销这次修改」可恢复应用前的内容。应用后继续编辑过的草稿会受到保护，AI 不会自动发布内容。

欢迎、回应、比心等互动使用已收录的日语角色短句，并显示中文字幕；长 AI 回复以文字呈现。语音可单独试听或静音。

## 额度与资料更新

全站共享每天 100 次已接受请求，按 UTC 日计数；另有每客户端每分钟 6 次、同时 2 个请求的限制。上游失败也计入已接受次数，失败不会自动重复调用。达到额度时稍后再试，正常阅读、音乐和相册仍可使用。

站主发布新文章、说说或照片后，Actions 自动生成并发布公共 data/knowledge.json。Worker 从固定的 Pages 地址读取索引，缓存 60 秒，到期后由后续请求刷新；远端暂不可用时保留最近有效的公开快照。内容更新不需要在本机运行服务、重启网关或再次部署 Worker。

## 连接与故障提示

- 「AI 暂未连接」：先刷新状态或使用重试入口，再查看状态接口和页面错误提示。
- 超时、取消或限流：界面会显示状态，可稍后重试。
- 内容过长：问题最多 4,000 字符，选段最多 8,000 字符，请缩小范围；请求同时受总大小限制。
- 文章尚未被引用：先确认对应 Pages 部署成功，再等待索引缓存到期后的下一次请求。
- 发布状态和后端维护见 [Worker 部署说明](../server/DEPLOYMENT.md)。

## 可选：本机开发

本机调试需要 Node.js 24 和 Python。Windows 开发者可自行配置 DPAPI 凭据并启动回环网关：

~~~powershell
python tools/build.py
powershell -NoProfile -ExecutionPolicy Bypass -File tools/configure_ai.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools/start_ai.ps1
~~~

配置脚本隐藏输入并用当前 Windows 用户的 DPAPI 加密；启动脚本为本次开发进程提供凭据，监听 http://127.0.0.1:8787。另起 8000 端口预览网站时，可在开发副本中临时把 endpoint 指向该回环地址；发布配置保持公网 URL。开发脚本不是线上运行条件。

## 高级个人接口兼容

看板娘设置仍保留 OpenAI 兼容 / TokenRhythm、Gemini 和 Claude 协议以及模型列表读取，供自行配置个人服务时使用：

| 协议 | 支持的地址形式 |
| --- | --- |
| OpenAI 兼容 | 服务根地址或以 /v1 结尾的 Base URL；请求 chat/completions。 |
| Gemini | 服务根地址或 /v1beta；请求模型的 generateContent。 |
| Claude | 服务根地址或 /v1；请求 messages。 |

填写个人 Key 后，看板娘普通聊天优先使用个人接口；文章工具和写作便签继续使用站点网关。个人接口不会自动获得站内知识索引。将个人 Key 留空可使用已连接的站点网关。

个人接口设置保存在当前浏览器的 localStorage；它与本机 DPAPI 网关凭据分别管理。模型名、访问权限和 CORS 以服务提供方的实际配置为准。只有在自己管理的代理服务已正确配置时才填写 CORS 代理地址，本文不再使用任意 URL 转发代理作为站点网关。
