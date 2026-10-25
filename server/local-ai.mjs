import http from "node:http";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createAIService, createMemoryGate, DEFAULT_MODEL, DEFAULT_ORIGINS } from "./ai-core.mjs";

export function createLocalServer(options = {}) {
  const service = createAIService({
    apiKey: options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "",
    model: options.model ?? process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL,
    allowedOrigins: options.allowedOrigins ?? (process.env.AI_ALLOWED_ORIGINS?.split(",").map(value => value.trim()).filter(Boolean) || DEFAULT_ORIGINS),
    catalog: options.catalog ?? (async () => JSON.parse(await readFile(new URL("../data/knowledge.json", import.meta.url), "utf8"))),
    gate: options.gate ?? createMemoryGate({ perMinute: 10, daily: 100, concurrent: 2 }),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  const server = http.createServer(async (incoming, outgoing) => {
    const port = server.address()?.port || 8787;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes((incoming.headers.host || "").toLowerCase())) {
      outgoing.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      outgoing.end(JSON.stringify({ error: { code: "INVALID_HOST", message: "此服务仅接受本机地址。" } }));
      return;
    }
    const controller = new AbortController();
    incoming.once("aborted", () => controller.abort());
    outgoing.once("close", () => { if (!outgoing.writableEnded) controller.abort(); });
    try {
      const method = incoming.method || "GET";
      const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, {
        method, headers: incoming.headers, signal: controller.signal,
        ...(["GET", "HEAD"].includes(method) ? {} : { body: Readable.toWeb(incoming), duplex: "half" }),
      });
      const response = await service(request, { clientId: incoming.socket.remoteAddress || "loopback" });
      if (outgoing.destroyed) return;
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!outgoing.destroyed && !outgoing.headersSent) {
        outgoing.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        outgoing.end(JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message: "AI 暂时无法连接。" } }));
      }
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createLocalServer().listen(8787, "127.0.0.1", () => {
    console.log("Miku local AI: http://127.0.0.1:8787 (loopback only)");
  });
}
