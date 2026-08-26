// Anthropic Messages API 兼容层：POST /v1/messages
// 将 Anthropic 协议请求转换为 OpenAI Chat Completions 发给上游，
// 并把上游响应（JSON / SSE 流）转换回 Anthropic 协议返回给客户端。
// 复用 proxy.js 的前缀路由与上游鉴权逻辑。
import crypto from "crypto";
import { fetch } from "undici";
import { getUpstreamByPrefix } from "./upstreams.js";
import { parseModel, buildChatUrl, buildOpencodeHeaders, buildGenericHeaders } from "./proxy.js";
import { withRetry, isConnectionError } from "./retry.js";

// 上游超时
const UPSTREAM_STREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_STREAM_TIMEOUT_MS || 180_000);
const UPSTREAM_SYNC_TIMEOUT_MS = Number(process.env.UPSTREAM_SYNC_TIMEOUT_MS || 120_000);

function randomId(prefix) {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "")}`;
}

// 粗略估算 token 数（无真实用量时的兜底）
function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

// ===== 请求转换：Anthropic → OpenAI =====

// system 字段：字符串或 [{type:"text",text}] → 纯文本
function systemToText(system) {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system.filter((b) => b?.type === "text" && b.text).map((b) => b.text).join("\n") || null;
  }
  return null;
}

// messages 数组转换。要点：
// - assistant 的 tool_use 块 → OpenAI assistant 消息的 tool_calls
// - user 的 tool_result 块 → 独立的 role:"tool" 消息（OpenAI 要求紧跟对应 assistant）
// - text/image 块 → content parts（image base64/url → image_url data URI）
function anthropicMessagesToOpenAI(messages) {
  const out = [];
  for (const msg of messages || []) {
    const role = msg?.role === "assistant" ? "assistant" : "user";
    if (typeof msg?.content === "string") {
      out.push({ role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg?.content)) continue;

    if (role === "assistant") {
      let text = "";
      const toolCalls = [];
      for (const b of msg.content) {
        if (b?.type === "text" && b.text) text += (text ? "\n" : "") + b.text;
        else if (b?.type === "tool_use") {
          toolCalls.push({
            id: b.id || randomId("toolu_"),
            type: "function",
            function: { name: b.name || "", arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      }
      const m = { role: "assistant", content: text || null };
      if (toolCalls.length) m.tool_calls = toolCalls;
      out.push(m);
      continue;
    }

    // user 消息
    const parts = [];
    for (const b of msg.content) {
      if (b?.type === "text" && b.text) {
        parts.push({ type: "text", text: b.text });
      } else if (b?.type === "image") {
        const src = b.source || {};
        if (src.type === "base64" && src.data) {
          parts.push({ type: "image_url", image_url: { url: `data:${src.media_type || "image/png"};base64,${src.data}` } });
        } else if (src.type === "url" && src.url) {
          parts.push({ type: "image_url", image_url: { url: src.url } });
        }
      } else if (b?.type === "tool_result") {
        // OpenAI 的 tool 消息必须独立成条：先落盘已积累的 user parts
        if (parts.length) out.push({ role: "user", content: parts.splice(0) });
        let content = "";
        if (typeof b.content === "string") content = b.content;
        else if (Array.isArray(b.content)) {
          content = b.content.filter((x) => x?.type === "text").map((x) => x.text).join("\n");
        }
        out.push({ role: "tool", tool_call_id: b.tool_use_id || "", content });
      }
    }
    if (parts.length) {
      out.push({
        role: "user",
        content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts,
      });
    }
  }
  return out;
}

function anthropicToolsToOpenAI(tools) {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} },
    },
  }));
}

function anthropicToolChoiceToOpenAI(tc) {
  if (!tc || !tc.type) return undefined;
  if (tc.type === "auto") return "auto";
  if (tc.type === "any") return "required";
  if (tc.type === "none") return "none";
  if (tc.type === "tool" && tc.name) return { type: "function", function: { name: tc.name } };
  return undefined;
}

export function anthropicToOpenAI(body) {
  const openai = { model: body.model, stream: !!body.stream };
  const msgs = [];
  const sys = systemToText(body.system);
  if (sys) msgs.push({ role: "system", content: sys });
  msgs.push(...anthropicMessagesToOpenAI(body.messages));
  openai.messages = msgs;
  if (body.max_tokens != null) openai.max_tokens = body.max_tokens;
  if (body.temperature != null) openai.temperature = body.temperature;
  if (body.top_p != null) openai.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) openai.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length) openai.tools = anthropicToolsToOpenAI(body.tools);
  const tc = anthropicToolChoiceToOpenAI(body.tool_choice);
  if (tc !== undefined) openai.tool_choice = tc;
  // 尽量拿到真实 token 用量；上游不支持该字段时会忽略，不影响流式输出
  if (body.stream) openai.stream_options = { include_usage: true };
  return openai;
}

// ===== 响应转换：OpenAI → Anthropic =====

function mapFinishReason(fr) {
  if (fr === "length") return "max_tokens";
  if (fr === "tool_calls") return "tool_use";
  return "end_turn"; // stop / content_filter / 其他一律归为 end_turn
}

export function openAIToAnthropicResponse(oai, reqModel) {
  const choice = oai?.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (typeof msg.content === "string" && msg.content) {
    content.push({ type: "text", text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const p of msg.content) {
      if (p?.type === "text" && p.text) content.push({ type: "text", text: p.text });
    }
  }
  for (const tcall of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tcall.function?.arguments || "{}"); } catch {}
    content.push({ type: "tool_use", id: tcall.id || randomId("toolu_"), name: tcall.function?.name || "", input });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  return {
    id: randomId("msg_"),
    type: "message",
    role: "assistant",
    model: reqModel,
    content,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: oai?.usage?.prompt_tokens ?? 0,
      output_tokens: oai?.usage?.completion_tokens ?? 0,
    },
  };
}

// ===== 流式转换：OpenAI SSE → Anthropic SSE =====

class AnthropicStreamBuilder {
  constructor(res, reqModel, inputTokensEstimate) {
    this.res = res;
    this.reqModel = reqModel;
    this.started = false;
    this.nextIndex = 0;
    this.textIndex = -1;         // 已打开的 text block 下标，-1 表示未打开
    this.toolBlocks = new Map(); // OpenAI tool_call index → Anthropic block index
    this.outputChars = 0;
    this.stopReason = null;
    this.usage = null;
    this.inputTokens = inputTokensEstimate;
  }

  event(name, data) {
    this.res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  ensureStarted() {
    if (this.started) return;
    this.started = true;
    this.event("message_start", {
      type: "message_start",
      message: {
        id: randomId("msg_"),
        type: "message",
        role: "assistant",
        model: this.reqModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.inputTokens, output_tokens: 0 },
      },
    });
  }

  openText() {
    if (this.textIndex !== -1) return;
    this.ensureStarted();
    this.textIndex = this.nextIndex++;
    this.event("content_block_start", {
      type: "content_block_start",
      index: this.textIndex,
      content_block: { type: "text", text: "" },
    });
  }

  closeText() {
    if (this.textIndex === -1) return;
    this.event("content_block_stop", { type: "content_block_stop", index: this.textIndex });
    this.textIndex = -1;
  }

  handleDelta(delta) {
    if (typeof delta?.content === "string" && delta.content) {
      this.openText();
      this.outputChars += delta.content.length;
      this.event("content_block_delta", {
        type: "content_block_delta",
        index: this.textIndex,
        delta: { type: "text_delta", text: delta.content },
      });
    }
    for (const tcall of delta?.tool_calls || []) {
      const key = tcall.index ?? 0;
      let blockIdx = this.toolBlocks.get(key);
      if (blockIdx === undefined) {
        this.closeText(); // Anthropic 中工具块与文本块是并列的 content block
        this.ensureStarted();
        blockIdx = this.nextIndex++;
        this.toolBlocks.set(key, blockIdx);
        this.event("content_block_start", {
          type: "content_block_start",
          index: blockIdx,
          content_block: { type: "tool_use", id: tcall.id || randomId("toolu_"), name: tcall.function?.name || "", input: {} },
        });
      }
      const args = tcall.function?.arguments;
      if (args) {
        this.outputChars += args.length;
        this.event("content_block_delta", {
          type: "content_block_delta",
          index: blockIdx,
          delta: { type: "input_json_delta", partial_json: args },
        });
      }
    }
  }

  finish() {
    this.ensureStarted();
    // 无任何内容时补一个空文本块，保证结构合法
    if (this.textIndex === -1 && this.toolBlocks.size === 0) this.openText();
    this.closeText();
    for (const blockIdx of this.toolBlocks.values()) {
      this.event("content_block_stop", { type: "content_block_stop", index: blockIdx });
    }
    const outputTokens = this.usage?.completion_tokens ?? estimateTokens(String(this.outputChars));
    this.event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: mapFinishReason(this.stopReason), stop_sequence: null },
      usage: { output_tokens: outputTokens },
    });
    this.event("message_stop", { type: "message_stop" });
  }
}

async function streamUpstreamToAnthropic(upstreamRes, res, reqModel, inputTokensEstimate) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const builder = new AnthropicStreamBuilder(res, reqModel, inputTokensEstimate);
  const decoder = new TextDecoder();
  let buf = "";
  let done = false;

  const handleLine = (rawLine) => {
    const line = rawLine.replace(/\r$/, "");
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") { done = true; return; }
    let json;
    try { json = JSON.parse(payload); } catch { return; }
    if (json.usage) builder.usage = json.usage;
    builder.handleDelta(json.choices?.[0]?.delta);
    const fr = json.choices?.[0]?.finish_reason;
    if (fr) builder.stopReason = fr;
  };

  try {
    for await (const chunk of upstreamRes.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handleLine(line);
        if (done) break;
      }
      if (done) break;
    }
    if (!done && buf) handleLine(buf); // 冲掉最后一段未换行的缓冲
    builder.finish();
  } finally {
    res.end();
  }
}

// ===== 错误处理 =====

function anthropicError(type, message) {
  return { type: "error", error: { type, message } };
}

function mapErrorType(status) {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

/**
 * POST /v1/messages —— Anthropic Messages API 兼容端点。
 * 模型名沿用本服务约定："前缀/模型名"（如 oc/deepseek-v4-flash-free），
 * 鉴权沿用 Authorization: Bearer <API_KEY>（anthropic-version 头忽略）。
 */
export function registerMessagesRoute(app, circuitBreaker) {
  app.post("/v1/messages", async (req, res) => {
    const body = req.body || {};
    const model = typeof body.model === "string" ? body.model : null;
    if (!model) {
      return res.status(400).json(anthropicError("invalid_request_error", "missing model"));
    }
    if (!Array.isArray(body.messages)) {
      return res.status(400).json(anthropicError("invalid_request_error", "messages: Field required"));
    }

    const { prefix, modelId } = parseModel(model);
    const upstream = getUpstreamByPrefix(prefix);
    if (!upstream) {
      return res.status(400).json(
        anthropicError("invalid_request_error", `未知上游前缀 "${prefix}"。模型格式应为 "前缀/模型名"，如 oc/deepseek-v4-flash-free`)
      );
    }

    const stream = !!body.stream;
    const upstreamId = prefix;
    const timeoutMs = stream ? UPSTREAM_STREAM_TIMEOUT_MS : UPSTREAM_SYNC_TIMEOUT_MS;

    // 熔断检查
    if (circuitBreaker && !circuitBreaker.allowRequest(upstreamId)) {
      console.log(`[CircuitBreaker] REJECT upstream=${upstreamId} model=${modelId}`);
      return res.status(503).json(
        anthropicError("api_error", `上游 ${upstream.name} 已熔断，冷却中`)
      );
    }

    const openaiBody = anthropicToOpenAI(body);
    openaiBody.model = modelId;
    const inputTokensEstimate = estimateTokens(JSON.stringify(openaiBody.messages));

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
              body: JSON.stringify(openaiBody),
              signal: merged,
            });

            if (upstreamRes.status === 429) {
              const retryAfter = upstreamRes.headers.get("retry-after") || "";
              const text = await upstreamRes.text().catch(() => "");
              const err = new Error("429 rate limited");
              err.status = 429;
              err.headers = { "retry-after": retryAfter };
              err.upstreamBody = text;
              throw err;
            }

            if (upstreamRes.status >= 500) {
              const text = await upstreamRes.text().catch(() => "");
              const err = new Error(`upstream HTTP ${upstreamRes.status}`);
              err.status = upstreamRes.status;
              err.upstreamBody = text;
              throw err;
            }

            if (upstreamRes.status >= 400) {
              // 4xx 非 429 → 不重试
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
            // 流式：只有连接阶段错误才重试
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

      if (openaiBody.stream) {
        await streamUpstreamToAnthropic(result, res, model, inputTokensEstimate);
      } else {
        const json = await result.json();
        res.json(openAIToAnthropicResponse(json, model));
      }
    } catch (err) {
      if (err.name === "AbortError" || err.code === "ERR_STREAM_PREMATURE_CLOSE" || res.writableEnded) return;
      // 重试全部失败（非客户端断开）→ 记一次熔断失败；429 不计入熔断
      if (circuitBreaker && err.status !== 429) circuitBreaker.recordFailure(upstreamId);
      console.error("[oc-proxy] messages upstream error:", err.message);
      if (!res.headersSent) {
        // 带有上游错误体的透传
        const body = err.upstreamBody
          ? err.upstreamBody.slice(0, 500)
          : `upstream error: ${err.message}`;
        res.status(err.status || 502).json(
          anthropicError(mapErrorType(err.status || 502), body)
        );
      } else {
        res.end();
      }
    }
  });
}
