# 看板娘 AI 接入指南（含「基元律动 / TokenRhythm」）

> 为什么看板娘填了 key 还是「连接不上」？——因为 `tokenrhythm.studio` 的 API **没有开放跨域（CORS）**。
> 浏览器里前端直连一个不开放 CORS 的接口，请求会被浏览器直接拦截（控制台报
> `blocked by CORS policy` / `Failed to fetch`）。这跟 key 对不对、协议对不对都无关。
> 解决办法是加一层**你自己的 CORS 代理**（免费 Cloudflare Worker）。

---

## 一、哪些接口可以直接连（不用代理）

支持浏览器跨域的 OpenAI 兼容接口，看板娘能**直连**，比如：

- DeepSeek：`https://api.deepseek.com`（模型 `deepseek-chat`）
- 多数 one-api/new-api 系的中转站如果开了 CORS 也能直连

凡是在看板娘 ⚙️ 设置里填完 key、点 🔄 能读到模型列表的，就是能直连的。

## 二、哪些需要代理（如基元律动）

`tokenrhythm.studio` 这类不开放 CORS 的，必须走代理。本站已内置「基元律动（TokenRhythm）」预设：

- Base URL：`https://tokenrhythm.studio/v1`
- 协议：OpenAI 兼容（`/chat/completions`）
- 可用模型：`glm-5`、`glm-5.1`、`minimax-m2.7` 等（点 🔄 可读取）

---

## 三、部署 CORS 代理（约 3 分钟，一次性）

1. 打开 <https://dash.cloudflare.com/> → 左侧 **Workers & Pages** → **创建** → **创建 Worker**。
2. 起个名字（如 `ai-proxy`），点「部署」（先随便部署一个默认的也行）。
3. 点 **编辑代码**，把默认内容清空，粘贴下方完整代码，点 **部署**。
4. 记住你的 Worker 地址，形如 `https://ai-proxy.你的账号.workers.dev`。

### Worker 完整代码

```js
// Cloudflare Worker：AI API CORS 代理
// 用法：浏览器请求 https://你的worker.workers.dev/?url=<encodeURIComponent(目标API完整URL)>
// 效果：Worker 转发请求（含 Authorization 等 header），并补上 CORS 头，绕过浏览器跨域限制。

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access",
  "Access-Control-Max-Age": "86400",
};

// 只转发这些 header，避免把 Origin/Referer/Cookie 带给上游
const FORWARD = [
  "authorization",
  "content-type",
  "x-api-key",
  "anthropic-version",
  "anthropic-dangerous-direct-browser-access",
];

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get("url");
    if (!target || !/^https?:\/\//.test(target)) {
      return new Response(JSON.stringify({ error: "缺少 url 参数" }), {
        status: 400,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const headers = new Headers();
    for (const k of FORWARD) {
      const v = request.headers.get(k);
      if (v) headers.set(k, v);
    }

    const res = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
    });

    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: {
        ...CORS,
        "Content-Type": res.headers.get("Content-Type") || "application/json",
      },
    });
  },
};
```

---

## 四、接入本站

1. 打开网站右下角看板娘 → ⚙️ 设置。
2. 「接口协议」选 **基元律动（TokenRhythm）**（会自动填好 Base URL 和默认模型 `glm-5`）。
3. 「API Key」填你的 `sk_tr_...`。
4. 「CORS 代理地址」填第 3 步的 Worker 地址（如 `https://ai-proxy.你的账号.workers.dev`）。
5. 点 🔄 读取模型列表，能看到 `glm-5` 等就说明通了；跟 Miku 说句话试试。

---

## 五、安全说明

- API key 只保存在**你自己浏览器**的 localStorage 里，不会进仓库代码。
- 代理是你**自己**的 Cloudflare Worker，key 只在你浏览器 → 你的 Worker → tokenrhythm 之间传输，
  **不经过任何公共第三方代理**。
- 本站对 OpenAI 兼容 / Gemini / Claude 三种协议都支持代理字段：填了代理就走代理，留空则直连。
