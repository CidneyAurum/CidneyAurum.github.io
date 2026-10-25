import knowledge from "../data/knowledge.json" with { type: "json" };
import { createAIService, budgetDeadline, DEFAULT_MODEL, DEFAULT_ORIGINS } from "./ai-core.mjs";
import { createKnowledgeCache } from "./public-knowledge.mjs";

const publicKnowledge = createKnowledgeCache({ fallback: knowledge });

function publicReady(env) {
  const budget = Number(env.AI_DAILY_REQUEST_LIMIT);
  return env.AI_PUBLIC_ENABLED === "true" && !!env.DEEPSEEK_API_KEY
    && typeof env.AI_BUDGET?.getByName === "function" && Number.isSafeInteger(budget) && budget > 0 && budget <= 5000;
}

export default {
  async fetch(request, env, context) {
    const allowedOrigins = env.AI_ALLOWED_ORIGINS?.split(",").map(value => value.trim()).filter(Boolean) || DEFAULT_ORIGINS;
    if (!publicReady(env)) {
      const service = createAIService({ catalog: () => publicKnowledge.get(), model: env.DEEPSEEK_MODEL || DEFAULT_MODEL, allowedOrigins });
      return service(request);
    }
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
    const clientId = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
    const budget = env.AI_BUDGET.getByName("miku-global-budget-v1");
    const gate = {
      async acquire(client, { signal } = {}) {
        try {
          const { status, result } = await budgetDeadline(async requestSignal => {
            const response = await budget.fetch("https://budget.internal/reserve", { method: "POST", body: JSON.stringify({ client }), signal: requestSignal });
            return { status: response.status, result: await response.json() };
          }, { signal });
          if (status < 200 || status >= 300 || !result.lease) return { ok: false, status: status === 429 ? 429 : 503, code: result.code || "BUDGET_UNAVAILABLE", retryAfter: result.retryAfter || 60 };
          return { ok: true, async release({ signal: releaseSignal } = {}) {
            await budgetDeadline(async requestSignal => {
              const response = await budget.fetch("https://budget.internal/release", { method: "POST", body: JSON.stringify({ lease: result.lease }), signal: requestSignal });
              if (!response.ok) throw new Error("Budget release unavailable");
              await response.body?.cancel();
            }, { signal: releaseSignal });
          } };
        } catch { return { ok: false, status: 503, code: "BUDGET_UNAVAILABLE", retryAfter: 60 }; }
      },
    };
    const service = createAIService({ apiKey: env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_MODEL || DEFAULT_MODEL, catalog: () => publicKnowledge.get(), allowedOrigins, gate });
    return service(request, { clientId, ...(context?.waitUntil ? { waitUntil: task => context.waitUntil(task) } : {}) });
  },
};

/* A durable, atomic request budget and active-request lease table. The public
   worker cannot call the paid service when this binding/budget is unavailable. */
export class AIBudget {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    const reply = (data, status = 200) => Response.json(data, { status });
    if (request.method !== "POST") return reply({ code: "METHOD_NOT_ALLOWED" }, 405);
    let body;
    try { const raw = await request.text(); if (raw.length > 1024) return reply({ code: "INVALID_INPUT" }, 400); body = JSON.parse(raw); }
    catch { return reply({ code: "INVALID_INPUT" }, 400); }
    const path = new URL(request.url).pathname;
    if (path === "/release") {
      if (typeof body.lease !== "string") return reply({ code: "INVALID_INPUT" }, 400);
      await this.state.storage.transaction(async tx => {
        const active = await tx.get("active") || {};
        delete active[body.lease]; await tx.put("active", active);
      });
      return reply({ ok: true });
    }
    if (path !== "/reserve" || !/^[a-f0-9]{64}$/.test(body.client || "")) return reply({ code: "INVALID_INPUT" }, 400);
    const limit = Number(this.env.AI_DAILY_REQUEST_LIMIT);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) return reply({ code: "BUDGET_NOT_CONFIGURED" }, 503);
    const result = await this.state.storage.transaction(async tx => {
      const now = Date.now(), day = new Date(now).toISOString().slice(0, 10), minute = Math.floor(now / 60000);
      let usage = await tx.get("daily") || { day, count: 0 };
      if (usage.day !== day) usage = { day, count: 0 };
      if (usage.count >= limit) return { status: 429, code: "DAILY_BUDGET", retryAfter: 3600 };
      let rates = await tx.get("minute") || { minute, clients: {} };
      if (rates.minute !== minute) rates = { minute, clients: {} };
      if ((rates.clients[body.client] || 0) >= 6) return { status: 429, code: "RATE_LIMIT", retryAfter: 60 };
      const active = Object.fromEntries(Object.entries(await tx.get("active") || {}).filter(([, expires]) => expires > now));
      if (Object.keys(active).length >= 2) return { status: 429, code: "BUSY", retryAfter: 10 };
      const lease = crypto.randomUUID(); active[lease] = now + 45000;
      usage.count++; rates.clients[body.client] = (rates.clients[body.client] || 0) + 1;
      await tx.put("daily", usage); await tx.put("minute", rates); await tx.put("active", active);
      return { lease };
    });
    return reply(result, result.status || 200);
  }
}
