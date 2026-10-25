# 内容构建与部署

网站通过 GitHub Pages 公开访问，AI 由独立的 Cloudflare Worker 提供。Pages 来源已通过 GET 确认为 GitHub Actions（build_type=workflow）。

当前 Miku 补丁运行时为 ffa76fc7b27fd97185b61446bc25f2fab2784431，[Actions](https://github.com/CidneyAurum/CidneyAurum.github.io/actions/runs/40185430352) 的 220 项检查及 build/deploy 成功，正式站真实模型滚动、按钮和常驻召回验收通过，见 [修复记录](miku-visibility-fix.md)。下段保留整页歌词发布基线。

整页透明背景歌词已由运行时提交 2012e8c2d3f9e88a2672cb0fc29b3a97a42ad4bb 发布，[Actions](https://github.com/CidneyAurum/CidneyAurum.github.io/actions/runs/40181021376) 的 83 项 Node、127 项 Python/Chromium 共 210 项检查及 build/deploy 均成功。正式域名确认脚本版本 2012e8c2d3f9，以真实《勾指起誓》验证 17 字完整揭示、换句原位残影、透明穿透、暂停开关与 PJAX 同一音频；独立 390×844 手机界面检查也通过。完整证据范围见 [功能验收](functional-acceptance.md)。正式域名文章引用、手机侧栏及写作标题应用/撤销另有既有验证。

- 网站：https://cidneyaurum.github.io/
- AI 网关：https://cidney-miku-ai.1562614833.workers.dev
- 公网 AI 额度：全站每日 100 次已接受请求，按 UTC 日计数。

## 平时怎样发布内容

文章源文件是 _posts/*.md，照片放在 assets/gallery/，说说数据在 says/says.json；也可通过写作台提交。生成的 posts/*.html 会被下次构建覆盖，文章模板在 tools/build.py，样式在 css/style.css 和 css/garden.css。

推送 main 后，.github/workflows/build.yml 运行回归、图片优化、内容构建、资源版本标记和 Pages artifact 部署。Pull Request 只检查和构建。只有对应提交的 build、deploy 成功并能访问新页面，才算上线；写作台也按 github-pages 部署状态显示发布结果。

构建同时生成公共 data/knowledge.json。Worker 从固定的 Pages 索引地址在线同步，缓存 60 秒后由后续请求刷新。因此新文章、说说和照片发布成功后，无需启动本机服务或重新部署 Worker。本轮未修改 Worker 代码或 Secret、未重新部署 Worker，也未单独执行缓存到期刷新验收。

流程只发布 _site/ 中的公共 HTML、样式、脚本、资源、索引、RSS、sitemap、manifest 与 Service Worker；Markdown 源稿、server/、工具、测试、仓库文档、凭据和 Git 目录不打包。Worker 的独立部署见 [公网 AI 部署说明](../server/DEPLOYMENT.md)。

部署失败时，打开仓库 Actions 中的 Build and deploy Pages，先检查 build，再检查 deploy；可从 main 手动 Run workflow。Pages 使用 github-pages 环境，环境分支规则需允许 main。

## 可选：开发构建与回归

开发环境为 Python 3.12、Node.js 24 与 Chromium：

~~~bash
python -m pip install -r requirements-build.txt -r requirements-test.txt
python -m playwright install chromium
node --test tests/*.test.cjs tests/*.test.mjs
python -m unittest discover -s tests -p 'test_*.py' -v
python tools/optimize_assets.py
python tools/build.py
python -m http.server 8000 --bind 127.0.0.1
~~~

Bash 可直接使用通配符；PowerShell 的 Node 命令可写为 node --test (Get-ChildItem tests/*.test.cjs,tests/*.test.mjs).FullName。Ubuntu CI 使用 python -m playwright install --with-deps chromium。

浏览器测试启动临时本地服务器，业务 API 由夹具隔离；GitHub 写入被模拟，不需要真实凭据。离线套件使用真实 Service Worker，音频套件使用浏览器原生解码。测试失败会阻止上传与部署。依赖版本由 requirements-build.txt、requirements-test.txt 固定。

开发预览可以使用本机 AI 网关；Windows DPAPI 脚本见 [AI 使用说明](ai-api.md)。公开网站使用公网入口，不依赖这些开发进程。

## 日期、草稿与缓存

- 文章日期需为有效 YYYY-MM-DD；建议明确填写，避免正文/当天回退日期随构建变化。
- 下划线开头的 Markdown 为草稿。python tools/build.py posts --drafts 仅用于开发预览，公共知识索引仍排除草稿和私有标记。
- 照片文件名末尾的年-月优先；否则取首次 Git 提交年月，未提交的无日期图片使用 MEMORY。
- HTML、JSON 优先联网，离线读取已访问副本；写作台、Live2D、音视频及 AI 请求不进入运行时缓存。
- CI 用本次提交的 SHA 替换静态资源版本号，联网刷新可取得新资源和内容索引。
- data/ai-config.json 只保存公网 endpoint；模型凭据仅由后端 Secret 管理。

GitHub 配置参考：[Using custom workflows with GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。
