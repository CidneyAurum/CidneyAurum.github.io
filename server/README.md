# Miku 公网 AI 网关

公网入口为 https://cidney-miku-ai.1562614833.workers.dev，供 GitHub Pages 网站直接调用。模型凭据由 Workers Secrets 提供，不进入前端、公开 JSON 或 Pages artifact。

**公网已启用并完成验收。** Worker 全站每日 100 次额度已生效，/api/status 返回 configured=true，正式域名浏览器已验证真实引用与写作标题应用/撤销。Pages 来源为 workflow，[本次 build/deploy](https://github.com/CidneyAurum/CidneyAurum.github.io/actions/runs/40171647787) 均成功。发布与停用流程见 [DEPLOYMENT.md](DEPLOYMENT.md)，访客使用见 [AI 使用指南](../docs/ai-api.md)。

## 在线知识同步

Worker 固定读取 https://cidneyaurum.github.io/data/knowledge.json，采用 60 秒缓存，到期后由后续请求刷新。文章、说说或照片的正常更新只需经 GitHub Actions 发布 Pages；不依赖本机运行，不需重启或为内容更新重新部署 Worker。

知识索引仅包含公开文章、页面、照片、说说和歌单；草稿、私有标记文章、管理设置、内部文档和环境文件均排除。远端索引暂不可用或校验失败时保留上次有效快照，首次使用打包的公开快照；不接受用户指定任意资料 URL。

## HTTP 接口

| 接口 | 约定 |
| --- | --- |
| GET /api/status | 返回 configured、model、features；不返回凭据。 |
| POST /api/chat | 接受 JSON，返回 reply、emotion、citations、actions，可附 usage。 |
| OPTIONS | 对允许的网站来源返回跨域预检结果。 |

请求示例：

~~~json
{
  "message": "概括这篇文章的核心内容，并给出引用。",
  "mode": "article",
  "history": [],
  "context": {
    "page": "/posts/hello-world.html",
    "slug": "hello-world"
  }
}
~~~

mode 支持 chat、article、discover、write。write 可附 task：title、summary 或 polish。context 仅接受 page、slug、selection；history 仅接受 user/assistant 消息，不允许调用方注入 system 角色或额外字段。

响应中的 emotion 为 neutral、happy、thinking、shy、sad、singing 之一。citations 的标题、站内 URL 和摘录由服务端校验；navigate 只接受索引中的站内目标，listen 只接受真实歌单 ID，heart 为交互建议。前端以文本显示内容，并在用户点击后执行 action。写作模式返回可审阅文本，清空引用和 action，由写作台负责 Apply / Undo 和草稿保存，不触发发布。

日语短句语音由独立的本地静态语音包播放，长 AI 回复保持文字；网关不合成语音。

## 边界与限制

POST 需要匹配允许列表的 Origin 和 application/json。默认允许本机 8000 端口及已配置的公开站点来源；AI_ALLOWED_ORIGINS 可替换列表。CORS 不允许携带凭据，不使用通配符；本机适配器限制 Host 为回环地址。命令行探测 POST 时也需发送允许的 Origin。

单项限制与总限制同时生效：

- 请求体最多 32 KiB；问题最多 4,000 字符。
- history 最多 12 条消息，总文本最多 16,000 字符。
- selection 最多 8,000 字符；page、slug 各最多 160 字符。
- 上游超时 25 秒；输出上限为 900 tokens，写作为 1,500 tokens。
- 每次明确提交最多一次上游调用；失败不自动重试，取消会中止上游请求。

错误格式为 {error:{code,message}}。格式、来源、大小、额度、服务和超时问题分别使用对应的 400/403/413/415/429/502/503/504 状态；取消使用 499。错误不会透传上游正文或凭据。所有 API 响应禁止缓存。

本机限额为每客户端每分钟 10 次、并发 2 次、每进程每 UTC 日 100 次；失败的已接受请求也计数，进程重启会重置本机计数。

## 公网预算与部署

当前上线配置使用 SQLite Durable Object AI_BUDGET：每日全站 100 次已接受请求、每客户端每分钟 6 次、并发 2 次。失败的已接受请求也计数；计数按 UTC 日重置并跨 Worker 重启保存。缺少 Secret、绑定、启用标记或有效额度时，模型调用关闭。

Durable Object 存储哈希客户端标识、计数和短期 lease，不存聊天正文或密钥。请求次数上限不等于金额上限；Cloudflare 与模型服务分别计量。网关代码、模型配置或额度改动需部署 Worker，日常站点内容由在线索引同步。

## 可选：本机开发

本轮公网验收后，本机 8000/8787 开发服务已停止，本轮 DPAPI 凭据文件已删除；线上仅使用 Cloudflare Secret。以下脚本仅供日后按需自行配置开发环境。

需要 Node.js 24。Windows 开发者可用 tools/configure_ai.ps1 隐藏输入并通过当前用户的 DPAPI 保存开发凭据，再用 tools/start_ai.ps1 启动 127.0.0.1:8787；默认模型 deepseek-flash，可用 -Model 参数调整。

跨平台可由受控进程环境提供 DEEPSEEK_API_KEY、可选 DEEPSEEK_MODEL 与 AI_ALLOWED_ORIGINS，再运行 node server/local-ai.mjs。前端开发副本可临时指向回环服务，公开配置始终使用公网入口。线上部署不读取或依赖开发者的 DPAPI 文件。

## 维护验证

以下回归使用假凭据和模拟上游，不调用收费 API：

~~~powershell
node --test tests/ai-core.test.mjs
python -m unittest discover -s tests -p test_miku_ai.py -v
python -m unittest discover -s tests -p test_knowledge.py -v
~~~

协议参考：[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[关闭 thinking](https://api-docs.deepseek.com/guides/thinking_mode/)、[Durable Objects 存储](https://developers.cloudflare.com/durable-objects/api/storage-api/)。
