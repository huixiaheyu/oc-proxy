// 模型列表模块：按上游拉取模型并缓存，带前缀命名空间合并
import { getUpstreams } from "./upstreams.js";

const CACHE_TTL_MS = Number(process.env.MODEL_CACHE_TTL_MS || 10 * 60 * 1000);

// 免费模型识别规则（仅 opencode 内置使用）：id 以 "-free" 结尾，或命中白名单
const KNOWN_FREE_OPENCODE_MODELS = ["big-pickle"];
export function isFreeModel(id) {
  if (typeof id !== "string") return false;
  return id.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.includes(id);
}

// 每个上游独立的缓存
const caches = new Map(); // key: prefix → { data, expiresAt, fetching }

async function fetchOne(upstream) {
  const key = upstream.prefix;
  let c = caches.get(key);
  if (!c) {
    c = { data: null, expiresAt: 0, fetching: null };
    caches.set(key, c);
  }
  const now = Date.now();
  if (c.data && now < c.expiresAt) return c.data;
  if (c.fetching) return c.fetching;

  c.fetching = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const headers = { "Accept": "application/json", "User-Agent": "opencode" };
      if (upstream.apiKey) headers["Authorization"] = `Bearer ${upstream.apiKey}`;
      const res = await fetch(upstream.modelsUrl, { headers, signal: controller.signal });
      if (!res.ok) throw new Error(`${upstream.name} /models returned ${res.status}`);
      const json = await res.json();
      const items = Array.isArray(json?.data) ? json.data : [];
      let models = items
        .filter((m) => m && typeof m.id === "string")
        .map((m) => ({ id: m.id, name: m.id }));

      // opencode 内置只保留免费模型
      if (upstream.builtin && upstream.freeOnly) {
        models = models.filter((m) => isFreeModel(m.id));
      }

      c.data = { upstream, models, fetchedAt: Date.now() };
      c.expiresAt = now + CACHE_TTL_MS;
      return c.data;
    } catch (err) {
      if (c.data) return c.data; // fail-open：用旧缓存
      throw err;
    } finally {
      clearTimeout(timer);
      c.fetching = null;
    }
  })();

  return c.fetching;
}

/**
 * GET /v1/models —— 合并所有上游模型，模型 id 带前缀命名空间（如 oc/xxx、mysrv/xxx）。
 * ?prefix=<p> 只返回指定上游；?raw=1 返回原始无前缀模型。
 */
async function handleListModels(req, res) {
  const { prefix, raw } = req.query;
  const upstreams = getUpstreams();

  try {
    const results = await Promise.allSettled(upstreams.map((u) => fetchOne(u)));
    const list = [];

    for (let i = 0; i < upstreams.length; i++) {
      const u = upstreams[i];
      // 若指定 prefix 则只返回该上游
      if (prefix && u.prefix !== prefix) continue;
      const r = results[i];
      if (r.status !== "fulfilled" || !r.value) continue; // 拉取失败的上游跳过

      for (const m of r.value.models) {
        list.push({
          id: raw === "1" ? m.id : `${u.prefix}/${m.id}`,
          object: "model",
          created: Math.floor(r.value.fetchedAt / 1000),
          owned_by: u.prefix,
          provider: u.prefix,
        });
      }
    }

    // 附带上游信息，方便前端展示
    res.json({
      object: "list",
      upstreams: upstreams.map((u) => ({ prefix: u.prefix, name: u.name, builtin: !!u.builtin })),
      data: list,
    });
  } catch (err) {
    res.status(502).json({ error: { message: `Failed to fetch models: ${err.message}`, type: "upstream_error" } });
  }
}

// 注册模型相关路由
export function registerModelsRoutes(app) {
  app.get("/v1/models", handleListModels);
}
