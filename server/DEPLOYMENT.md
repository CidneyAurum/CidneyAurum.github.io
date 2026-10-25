# 公网 AI 部署与维护

网站：https://cidneyaurum.github.io/

网关：https://cidney-miku-ai.1562614833.workers.dev

状态：https://cidney-miku-ai.1562614833.workers.dev/api/status

## 已完成的发布与验收

Pages 来源已通过 GET 确认为 GitHub Actions（build_type=workflow）。公网 Worker 已启用，/api/status 返回 configured=true；workers_dev=true、AI_PUBLIC_ENABLED=true、AI_DAILY_REQUEST_LIMIT=100 已生效。前端使用上面的 HTTPS 公网地址，凭据由 Workers Secrets 托管。

当前 Pages 运行时发布提交为 2012e8c2d3f9e88a2672cb0fc29b3a97a42ad4bb，对应 [Actions](https://github.com/CidneyAurum/CidneyAurum.github.io/actions/runs/40181021376) 的 build/deploy 均成功，83 项 Node 与 127 项 Python/Chromium 共 210 项检查全部通过。正式域名确认脚本版本 2012e8c2d3f9，以真实《勾指起誓》验证整页歌词与跨页续播，详见 [功能验收](../docs/functional-acceptance.md)。本轮没有 Worker 代码或 Secret 变更，无需重新部署；Worker 仍为 e58ef309-a7e1-41b6-9731-262734ab4e8b。

页面由 GitHub Pages 提供，推理由 Cloudflare Worker 调用 DeepSeek；访客无需运行本机服务。既有 AI 验收中，正式域名浏览器的文章总结返回 1 条真实引用，手机侧栏位于视口内，写作标题应用与撤销成功；本机 API 请求、浏览器直连模型供应商、发往网关的鉴权头和 GitHub 写入均为 0，页面脚本错误为空。这些是既有 AI 记录，本轮歌词发布未新增付费 AI 验收调用。

此前公网 AI 部署验收结束时，曾停止本机 8000/8787 服务并删除该轮 DPAPI 临时凭据文件；这是历史操作记录，不表示当前开发端口状态。模型凭据由 Workers Secrets 管理，不写入前端、公开 JSON 或版本库。

## 内容更新与代码部署

文章、说说、照片通过 GitHub Actions 构建并发布公共 data/knowledge.json。Worker 固定读取 Pages 上的索引，缓存 60 秒，到期后由后续请求刷新。日常内容更新无需本机服务、网关重启或重新部署 Worker。本轮公网 GET 公共索引返回 200，确认含新版整页背景文案且不含 limbus.html；没有观测 Worker 缓存到期后的读取与刷新。

修改网关代码、模型或预算时，重新构建并部署 Worker：

~~~powershell
python tools/build.py
wrangler deploy --dry-run --config server/wrangler.jsonc --env-file <empty-env-file> --outdir <review-directory>
wrangler deploy --config server/wrangler.jsonc
~~~

更换后端凭据时使用 Workers Secret 提示输入，不把值写入 vars：

~~~powershell
wrangler secret put DEEPSEEK_API_KEY --config server/wrangler.jsonc
~~~

前端 data/ai-config.json 保持上面的 HTTPS 网关 URL。部署后应检查 /api/status、允许来源的 CORS、Pages 实际前端配置，以及聊天、真实章节引用和写作提案的应用/撤销。不要把提交成功或本机请求成功当作公网验收。

## 请求额度与停用

上线配置为全站每天 100 次已接受请求，按 UTC 日计数；每客户端每分钟 6 次，并发 2 次。失败的已接受请求也占用次数，不自动重试。上游超时 25 秒，输出最多 900 tokens，写作最多 1,500 tokens。

AI_BUDGET 使用 SQLite Durable Object 保存计数，跨部署和运行时重启保留。保持同一个命名空间、绑定、AIBudget 类及迁移 v1。缺少 Secret、绑定、启用标记或有效额度时关闭模型调用。

需要停用时部署显式关闭参数：

~~~powershell
wrangler deploy --config server/wrangler.jsonc --var AI_PUBLIC_ENABLED:false --var AI_DAILY_REQUEST_LIMIT:0
~~~

额度限制模型尝试次数；Cloudflare 请求/存储与模型服务分别计量。预算 reserve/release 有两秒截止时间；未能预留额度时不调用模型，释放为受控后台任务，lease 在 45 秒后失效。

## 已有技术验证

Wrangler 4.146.0 已完成打包检查，本机原生 workerd + SQLite 验证了并发限制、分钟限流、每日额度、lease 释放及重启后计数保留。原生预算测试未调用付费接口。兼容日期为 2026-10-08，显式 upload_source_maps=false，避免上传带本机路径的 source map。

参考：[SQLite 存储与迁移](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)、[命名空间绑定](https://developers.cloudflare.com/durable-objects/api/namespace/)、[source map](https://developers.cloudflare.com/workers/observability/source-maps/)、[额度与计量](https://developers.cloudflare.com/durable-objects/platform/pricing/)。
