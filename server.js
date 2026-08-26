import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Agent, setGlobalDispatcher } from "undici";
import { registerModelsRoutes } from "./lib/models.js";
import { registerChatRoutes } from "./lib/proxy.js";
import { listCustomUpstreams, addUpstream, updateUpstream, removeUpstream } from "./lib/upstreams.js";
import { getApiKey, setApiKey } from "./lib/settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ===== 环境变量 =====
// PORT              服务监听端口，默认 20128
// API_KEY           对外 API Key（可选）。设置后，/v1/* 需带 Authorization: Bearer <API_KEY>。
//                   前端页面展示的 apiKey 即此值。不设置时默认 "sk_9router"。
// MODEL_CACHE_TTL_MS 模型缓存时长（毫秒），默认 10 分钟
// ALLOW_PUBLIC_API  若为 "true" 则跳过 API Key 校验（仅供内网/本机快速调试）
// DATA_DIR          上游配置存储目录，默认 <项目>/data
// UPSTREAM_KEEP_ALIVE_MS 上游空闲连接保活时长（毫秒），默认 60000。
//                   undici 默认仅 4s，聊天场景请求间隔常超 4s，导致连接被关闭、
//                   下次请求需重新 TCP+TLS 握手（约 100~300ms）。调长后可复用连接。
const PORT = Number(process.env.PORT || 20128);
const HOSTNAME = process.env.HOSTNAME || "0.0.0.0";
const ALLOW_PUBLIC_API = process.env.ALLOW_PUBLIC_API === "true";
const UPSTREAM_KEEP_ALIVE_MS = Number(process.env.UPSTREAM_KEEP_ALIVE_MS || 60_000);

// 上游连接池：复用 TCP/TLS 连接，避免重复握手（对 /v1/chat/completions 与 /v1/models 均生效）
setGlobalDispatcher(new Agent({
  keepAliveTimeout: UPSTREAM_KEEP_ALIVE_MS,
  connections: 64,
}));

const app = express();
app.use(express.json({ limit: "128mb" }));

// 静态资源（前端页面）
app.use(express.static(path.join(__dirname, "public")));

// 服务状态
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "oc-proxy", time: Date.now() });
});

// 前端页面需要知道 apiKey / baseUrl 以便展示复制
app.get("/api/meta", (req, res) => {
  res.json({
    apiKey: getApiKey(),
    canSetApiKey: true,
    baseUrl: `${req.protocol}://${req.get("host")}`,
  });
});

// 网页自定义 API Key（需携带当前 key 鉴权，防止被他人篡改）
app.post("/api/settings/api-key", (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (token !== getApiKey()) {
    return res.status(401).json({ error: "Invalid API key" });
  }
  try {
    const { apiKey } = req.body || {};
    const clean = setApiKey(apiKey);
    res.json({ success: true, apiKey: clean });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// API Key 校验（/v1/* 保护）
function requireAuth(req, res, next) {
  if (ALLOW_PUBLIC_API) return next();
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (token !== getApiKey()) {
    return res.status(401).json({
      error: { message: "Invalid API key. Use Authorization: Bearer <API_KEY>", type: "invalid_request_error" },
    });
  }
  next();
}

app.use("/v1", requireAuth);

// ===== 上游管理 API =====
// 列出所有自定义上游（不含内置 opencode）
app.get("/api/upstreams", (req, res) => {
  res.json({ upstreams: listCustomUpstreams() });
});

// 新增自定义上游
app.post("/api/upstreams", (req, res) => {
  try {
    const { name, prefix, baseUrl, apiKey, modelsUrl } = req.body || {};
    const upstream = addUpstream({ name, prefix, baseUrl, apiKey, modelsUrl });
    res.json({ success: true, upstream });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 更新自定义上游
app.put("/api/upstreams/:id", (req, res) => {
  try {
    const { name, prefix, baseUrl, apiKey, modelsUrl } = req.body || {};
    const upstream = updateUpstream(req.params.id, { name, prefix, baseUrl, apiKey, modelsUrl });
    res.json({ success: true, upstream });
  } catch (err) {
    const status = err.message === "上游不存在" ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

// 删除自定义上游
app.delete("/api/upstreams/:id", (req, res) => {
  const ok = removeUpstream(req.params.id);
  if (!ok) return res.status(404).json({ error: "上游不存在" });
  res.json({ success: true });
});

// 注册路由
registerModelsRoutes(app);
registerChatRoutes(app);

app.listen(PORT, HOSTNAME, () => {
  console.log(`[oc-proxy] listening on http://${HOSTNAME}:${PORT}`);
  console.log(`[oc-proxy] API Key: ${getApiKey()}`);
  console.log(`[oc-proxy] Models:  GET /v1/models | Chat: POST /v1/chat/completions`);
  console.log(`[oc-proxy] Upstreams: GET/POST /api/upstreams | DELETE /api/upstreams/:id`);
});
