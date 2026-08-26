// 聊天直通反代模块：按模型前缀路由到对应上游（内置 opencode / 自定义 OpenAI 兼容 API）
import crypto from "crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fetch } from "undici";
import { getUpstreamByPrefix } from "./upstreams.js";

function randomId(prefix) {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "")}`;
}

// 解析模型名为 { prefix, modelId }，格式 "前缀/模型名"
export function parseModel(model) {
  const idx = typeof model === "string" ? model.indexOf("/") : -1;
  if (idx <= 0) return { prefix: null, modelId: model };
  return { prefix: model.slice(0, idx), modelId: model.slice(idx + 1) };
}

export function buildChatUrl(upstream) {
  // 内置/特殊上游可显式指定完整 chat 端点（如 opencode 的 /zen/v1/chat/completions）
  if (upstream.chatUrl) return upstream.chatUrl;
  const base = String(upstream.baseUrl || "").replace(/\/$/, "");
  // 若 baseUrl 以 /v1 结尾，则 chat 端点为 base + /chat/completions；否则补 /v1
  if (base.endsWith("/v1")) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

// opencode 内置上游：免鉴权 + 指纹头
export function buildOpencodeHeaders(req) {
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
export function buildGenericHeaders(upstream) {
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

// 从一段 SSE 文本中提取首个有效 data 块，返回 { found, tokenText }
// 跳过 keep-alive 注释行、空行与 [DONE]
function extractFirstToken(chunk, buffer) {
  buffer.text += chunk;
  // 只解析最后一段，防止跨 chunk 截断导致漏检（简单起见逐行解析完整缓冲）
  const lines = buffer.text.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let text = "";
    try {
      const json = JSON.parse(payload);
      const delta = json?.choices?.[0]?.delta?.content;
      if (typeof delta === "string") text = delta;
    } catch {
      text = payload;
    }
    return { found: true, tokenText: text, consumed: lines.join("\n") };
  }
  return { found: false, tokenText: "", consumed: "" };
}

/**
 * TTFT（Time To First Token）测速：发起 stream:true 请求，读到首个有效 data 块即断开。
 * 返回 { ok, ttft_ms, reply, status }
 */
async function callUpstreamTTFT(upstream, modelId, messages, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  let ttft = -1;
  try {
    const headers = upstream.builtin ? buildOpencodeHeaders({ headers: {} }) : buildGenericHeaders(upstream);
    const body = { model: modelId, messages, stream: true };
    const upstreamRes = await fetch(buildChatUrl(upstream), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    // 非 2xx 直接失败（首 token 时间记到响应头到达）
    if (!upstreamRes.ok) {
      const text = await upstreamRes.text();
      return { ok: false, ttft_ms: Date.now() - start, reply: text.slice(0, 200) || `HTTP ${upstreamRes.status}`, status: upstreamRes.status };
    }

    if (!upstreamRes.body) {
      return { ok: true, ttft_ms: Date.now() - start, reply: "", status: upstreamRes.status };
    }

    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    const buffer = { text: "" };
    let reply = "";
    let found = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunkText = decoder.decode(value, { stream: true });
      const r = extractFirstToken(chunkText, buffer);
      if (r.found) {
        ttft = Date.now() - start;
        reply = r.tokenText;
        found = true;
        try { await reader.cancel(); } catch {}
        break;
      }
    }

    // 流结束仍未见 token
    if (!found) {
      return { ok: false, ttft_ms: Date.now() - start, reply: "流结束但未收到有效 token", status: upstreamRes.status };
    }
    return { ok: true, ttft_ms: ttft, reply, status: upstreamRes.status };
  } catch (err) {
    return {
      ok: false,
      ttft_ms: Date.now() - start,
      reply: err.name === "AbortError" ? `请求超时（${timeoutMs / 1000}s）` : `错误: ${err.message}`,
      status: 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /v1/models/test —— TTFT 测速某模型（前端"测试"按钮用）。
 * body: { model: "前缀/模型名", prompt?: string }
 * 返回：{ ok, ttft_ms, reply, status }
 * TTFT = Time To First Token，发起 stream:true 请求，读到首个有效 data 块即断开。
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

    const messages = [
      { role: "system", content: "You are a connectivity test helper. Reply with exactly one word: pong" },
      { role: "user", content: prompt || "ping" },
    ];
    try {
      const result = await callUpstreamTTFT(upstream, modelId, messages, 30000);
      res.json(result);
    } catch (err) {
      res.json({
        ok: false,
        status: 0,
        ttft_ms: -1,
        reply: `错误: ${err.message}`,
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
        // pipeline 自动处理背压：客户端消费慢时暂停从上游读取，避免内存堆积；
        // 成功结束后自动 res.end()
        await pipeline(Readable.fromWeb(upstreamRes.body), res);
      } else {
        res.end();
      }
    } catch (err) {
      if (err.name === "AbortError" || err.code === "ERR_STREAM_PREMATURE_CLOSE" || res.writableEnded) return;
      console.error("[oc-proxy] chat upstream error:", err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: { message: `upstream error: ${err.message}`, type: "upstream_error" } });
      } else {
        res.end();
      }
    }
  });
}
