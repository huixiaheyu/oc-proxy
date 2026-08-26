// 聊天直通反代模块：按模型前缀路由到对应上游（内置 opencode / 自定义 OpenAI 兼容 API）
import crypto from "crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fetch } from "undici";
import { getUpstreamByPrefix } from "./upstreams.js";
import { withRetry, isConnectionError } from "./retry.js";

// 环境变量：上游超时
const UPSTREAM_STREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_STREAM_TIMEOUT_MS || 180_000);
const UPSTREAM_SYNC_TIMEOUT_MS = Number(process.env.UPSTREAM_SYNC_TIMEOUT_MS || 120_000);
// 测试（TTFT 测速）超时：默认 15s，避免测速按钮卡太久
const UPSTREAM_TEST_TIMEOUT_MS = Number(process.env.UPSTREAM_TEST_TIMEOUT_MS || 15_000);

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

// 从增量文本中查找首个有效 data 行，返回 { found, tokenText }
// buffer.text 仅保留尚未凑成完整行的尾部片段，避免重复扫描与跨 chunk 截断丢行
function extractFirstToken(chunk, buffer) {
  buffer.text += chunk;
  // 仅逐行处理已完成的行（以 \n 结尾），保留末尾可能未完成的行
  let nl;
  while ((nl = buffer.text.indexOf("\n")) !== -1) {
    const line = buffer.text.slice(0, nl).replace(/\r$/, "");
    buffer.text = buffer.text.slice(nl + 1);
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
    // 消费到首个有效 token 为止，丢弃其后缓冲
    buffer.text = "";
    return { found: true, tokenText: text };
  }
  return { found: false, tokenText: "" };
}

/**
 * TTFT（Time To First Token）测速：发起 stream:true 请求，读到首个有效 data 块即断开。
 * 返回 { ok, ttft_ms, reply, status }
 */
async function callUpstreamTTFT(upstream, modelId, messages, timeoutMs = UPSTREAM_TEST_TIMEOUT_MS) {
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
      const result = await callUpstreamTTFT(upstream, modelId, messages);
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
 * 接入重试（指数退避）、熔断（三态模型）、独立超时。
 */
export function registerChatRoutes(app, circuitBreaker) {
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

    const stream = !!body.stream;
    const upstreamId = prefix;
    const timeoutMs = stream ? UPSTREAM_STREAM_TIMEOUT_MS : UPSTREAM_SYNC_TIMEOUT_MS;

    // 熔断检查：快速失败
    if (circuitBreaker && !circuitBreaker.allowRequest(upstreamId)) {
      console.log(`[CircuitBreaker] REJECT upstream=${upstreamId} model=${modelId}`);
      return res.status(503).json({
        error: { message: `上游 ${upstream.name} 已熔断，冷却中`, type: "upstream_error" },
      });
    }

    // 传给上游时，去掉前缀只留模型名
    const upstreamBody = { ...body, model: modelId };

    try {
      const result = await withRetry(
        async () => {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), timeoutMs);
          // req.signal 在部分环境下可能为 undefined，需兜底只用 ac.signal
          const merged = req.signal ? AbortSignal.any([ac.signal, req.signal]) : ac.signal;
          try {
            const headers = upstream.builtin ? buildOpencodeHeaders(req) : buildGenericHeaders(upstream);
            const upstreamRes = await fetch(buildChatUrl(upstream), {
              method: "POST",
              headers,
              body: JSON.stringify(upstreamBody),
              signal: merged,
            });

            // 429 单独处理：读取 Retry-After 头，带入自定义错误让 retry.js 解析
            if (upstreamRes.status === 429) {
              const retryAfter = upstreamRes.headers.get("retry-after") || "";
              const text = await upstreamRes.text().catch(() => "");
              const err = new Error(`429 rate limited`);
              err.status = 429;
              err.headers = { "retry-after": retryAfter };
              err.upstreamBody = text;
              throw err;
            }

            // 5xx → 交给重试与熔断（熔断计数在重试全部失败后统一记录，避免一次请求重复计数）
            if (upstreamRes.status >= 500) {
              const text = await upstreamRes.text().catch(() => "");
              const err = new Error(`upstream HTTP ${upstreamRes.status}`);
              err.status = upstreamRes.status;
              err.upstreamBody = text;
              throw err;
            }

            return upstreamRes;
          } finally {
            clearTimeout(timer);
          }
        },
        {
          retryableError: (err) => {
            // 客户端已断开，不重试
            if (req.signal?.aborted) return false;
            // 流式：只有连接阶段错误才重试（连接拒绝、超时无响应）
            if (stream && !isConnectionError(err) && err.status !== 429) return false;
            return true;
          },
          onRetry: (attempt, delay, err) => {
            console.log(`[Retry] ${upstreamId}/${modelId} attempt=${attempt} delay=${delay}ms err=${err.message}`);
          },
        }
      );

      // 重试已成功拿到上游有效响应 → 记录成功
      if (circuitBreaker) circuitBreaker.recordSuccess(upstreamId);

      // 透传上游状态码与内容类型
      res.status(result.status);
      const contentType = result.headers.get("content-type") || "";
      if (contentType) res.setHeader("Content-Type", contentType);
      for (const name of ["x-request-id", "ratelimit-remaining", "ratelimit-reset"]) {
        const v = result.headers.get(name);
        if (v) res.setHeader(name, v);
      }

      if (result.body) {
        await pipeline(Readable.fromWeb(result.body), res);
      } else {
        res.end();
      }
    } catch (err) {
      if (err.name === "AbortError" || err.code === "ERR_STREAM_PREMATURE_CLOSE" || res.writableEnded) return;
      // 重试全部失败（非客户端断开）→ 记一次熔断失败；429 不计入熔断
      if (circuitBreaker && err.status !== 429) circuitBreaker.recordFailure(upstreamId);
      console.error("[oc-proxy] chat upstream error:", err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: { message: `upstream error: ${err.message}`, type: "upstream_error" } });
      } else {
        res.end();
      }
    }
  });
}
