// 聊天直通反代模块：按模型前缀路由到对应上游（内置 opencode / 自定义 OpenAI 兼容 API）
import crypto from "crypto";
import { getUpstreamByPrefix } from "./upstreams.js";

function randomId(prefix) {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "")}`;
}

// 解析模型名为 { prefix, modelId }，格式 "前缀/模型名"
function parseModel(model) {
  const idx = typeof model === "string" ? model.indexOf("/") : -1;
  if (idx <= 0) return { prefix: null, modelId: model };
  return { prefix: model.slice(0, idx), modelId: model.slice(idx + 1) };
}

function buildChatUrl(upstream) {
  // 内置/特殊上游可显式指定完整 chat 端点（如 opencode 的 /zen/v1/chat/completions）
  if (upstream.chatUrl) return upstream.chatUrl;
  const base = String(upstream.baseUrl || "").replace(/\/$/, "");
  // 若 baseUrl 以 /v1 结尾，则 chat 端点为 base + /chat/completions；否则补 /v1
  if (base.endsWith("/v1")) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

// opencode 内置上游：免鉴权 + 指纹头
function buildOpencodeHeaders(req) {
  const lower = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) lower[k.toLowerCase()] = v;
  }
  const downstreamUa = lower["user-agent"] || "";
  const isOpencode = downstreamUa.toLowerCase().includes("opencode");
  return {
    "Content-Type": "application/json",
    "Authorization": "Bearer public",
    "User-Agent": isOpencode ? downstreamUa : "opencode",
    "x-opencode-client": lower["x-opencode-client"] || "desktop",
    "x-opencode-session": lower["x-opencode-session"] || randomId("ses_"),
    "x-opencode-request": lower["x-opencode-request"] || randomId("msg_"),
    "x-opencode-project": lower["x-opencode-project"] || "global",
    "Accept": "text/event-stream",
  };
}

// 自定义上游：Bearer apiKey 鉴权
function buildGenericHeaders(upstream) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "User-Agent": "oc-proxy",
  };
  if (upstream.apiKey) headers["Authorization"] = `Bearer ${upstream.apiKey}`;
  return headers;
}

// 解析模型 + 校验上游（共用逻辑），返回 { prefix, modelId, upstream }
function resolveModel(model) {
  const { prefix, modelId } = parseModel(model);
  const upstream = getUpstreamByPrefix(prefix);
  return { prefix, modelId, upstream };
}

// 发起一次上游调用（供测试接口使用，非流式、带超时）
async function callUpstream(upstream, modelId, messages, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = upstream.builtin ? buildOpencodeHeaders({ headers: {} }) : buildGenericHeaders(upstream);
    const body = { model: modelId, messages, stream: false };
    const upstreamRes = await fetch(buildChatUrl(upstream), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await upstreamRes.text();
    return { status: upstreamRes.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /v1/models/test —— 测试某模型连通性（前端"测试"按钮用）。
 * body: { model: "前缀/模型名", prompt?: string }
 * 返回：{ ok, latency_ms, reply, status }
 */
function registerTestRoute(app) {
  app.post("/v1/models/test", async (req, res) => {
    const { model, prompt } = req.body || {};
    if (!model) {
      return res.status(400).json({ error: { message: "missing model", type: "invalid_request_error" } });
    }
    const { prefix, modelId, upstream } = resolveModel(model);
    if (!upstream) {
      return res.status(400).json({
        error: { message: `未知上游前缀 "${prefix}"。模型格式应为 "前缀/模型名"，如 oc/deepseek-v4-flash-free`, type: "invalid_request_error" },
      });
    }

    const start = Date.now();
    const messages = [
      { role: "system", content: "You are a connectivity test helper. Reply with exactly one word: pong" },
      { role: "user", content: prompt || "ping" },
    ];
    try {
      const { status, text } = await callUpstream(upstream, modelId, messages, 30000);
      const latency = Date.now() - start;
      let reply = text.slice(0, 200);
      let ok = status >= 200 && status < 300;
      // 尝试从 JSON 提取回复
      try {
        const json = JSON.parse(text);
        const content = json?.choices?.[0]?.message?.content;
        if (content) reply = typeof content === "string" ? content.slice(0, 200) : JSON.stringify(content).slice(0, 200);
        ok = ok && !json?.error;
      } catch {}
      res.json({ ok, status, latency_ms: latency, reply });
    } catch (err) {
      res.json({
        ok: false,
        status: 0,
        latency_ms: Date.now() - start,
        reply: err.name === "AbortError" ? "请求超时（30s）" : `错误: ${err.message}`,
      });
    }
  });
}

/**
 * POST /v1/chat/completions —— 按模型前缀路由到对应上游直通反代。
 * 支持流式（stream:true → SSE 透传）与非流式（JSON 透传）。
 */
export function registerChatRoutes(app) {
  registerTestRoute(app);
  app.post("/v1/chat/completions", async (req, res) => {
    const body = req.body || {};
    const model = typeof body.model === "string" ? body.model : null;
    if (!model) {
      return res.status(400).json({ error: { message: "missing model", type: "invalid_request_error" } });
    }

    const { prefix, modelId } = parseModel(model);
    const upstream = getUpstreamByPrefix(prefix);
    if (!upstream) {
      return res.status(400).json({
        error: { message: `未知上游前缀 "${prefix}"。模型格式应为 "前缀/模型名"，如 oc/deepseek-v4-flash-free`, type: "invalid_request_error" },
      });
    }

    // 传给上游时，去掉前缀只留模型名
    const upstreamBody = { ...body, model: modelId };

    try {
      const headers = upstream.builtin ? buildOpencodeHeaders(req) : buildGenericHeaders(upstream);
      const upstreamRes = await fetch(buildChatUrl(upstream), {
        method: "POST",
        headers,
        body: JSON.stringify(upstreamBody),
        signal: req.signal,
      });

      // 透传上游状态码与内容类型
      res.status(upstreamRes.status);
      const contentType = upstreamRes.headers.get("content-type") || "";
      if (contentType) res.setHeader("Content-Type", contentType);
      for (const name of ["x-request-id", "ratelimit-remaining", "ratelimit-reset"]) {
        const v = upstreamRes.headers.get(name);
        if (v) res.setHeader(name, v);
      }

      if (upstreamRes.body) {
        for await (const chunk of upstreamRes.body) {
          res.write(chunk);
        }
      }
      res.end();
    } catch (err) {
      if (err.name === "AbortError" || res.writableEnded) return;
      console.error("[oc-proxy] chat upstream error:", err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: { message: `upstream error: ${err.message}`, type: "upstream_error" } });
      } else {
        res.end();
      }
    }
  });
}
