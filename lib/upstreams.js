// 上游管理模块：管理多个 OpenAI 兼容上游（内置 opencode + 自定义第三方），JSON 持久化
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const CONFIG_PATH = path.join(DATA_DIR, "upstreams.json");

// 内置 opencode 上游（免鉴权，特殊指纹头；API 端点在 /zen/v1 下）
export const BUILTIN_OPENCODE = {
  prefix: "oc",
  name: "OpenCode Free",
  baseUrl: "https://opencode.ai",
  modelsUrl: "https://opencode.ai/zen/v1/models",
  chatUrl: "https://opencode.ai/zen/v1/chat/completions",
  apiKey: "",
  builtin: true,
  freeOnly: true, // opencode 只展示免费模型
};

let cache = null; // 内存缓存已加载的配置

function readFile() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { upstreams: [] };
  }
}

function writeFile(data) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
}

// 加载所有上游：内置 opencode + 自定义
export function getUpstreams() {
  if (cache) return cache;
  const { upstreams = [] } = readFile();
  cache = [BUILTIN_OPENCODE, ...upstreams];
  return cache;
}

// 重新加载（修改后调用）
export function reloadUpstreams() {
  cache = null;
  return getUpstreams();
}

// 按前缀查找上游
export function getUpstreamByPrefix(prefix) {
  return getUpstreams().find((u) => u.prefix === prefix) || null;
}

// 前缀是否已被占用
function prefixTaken(prefix, excludeId) {
  return getUpstreams().some((u) => u.prefix === prefix && u.id !== excludeId);
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/$/, "");
}

// 推导模型列表地址：以 /v1 结尾 → {base}/models；否则 → {base}/v1/models
function inferModelsUrl(baseUrl) {
  const base = normalizeBaseUrl(baseUrl);
  if (base.endsWith("/v1")) return `${base}/models`;
  return `${base}/v1/models`;
}

function normalizePrefix(prefix) {
  return String(prefix || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .toLowerCase();
}

// 列出自定义上游（不含内置 opencode，前端管理用）
export function listCustomUpstreams() {
  const { upstreams = [] } = readFile();
  return upstreams;
}

// 新增自定义上游
export function addUpstream({ name, prefix, baseUrl, apiKey, modelsUrl }) {
  const cleanPrefix = normalizePrefix(prefix);
  if (!name || !cleanPrefix || !baseUrl) {
    throw new Error("name, prefix, baseUrl 均为必填");
  }
  if (prefixTaken(cleanPrefix, null)) {
    throw new Error(`前缀 "${cleanPrefix}" 已被占用`);
  }
  const upstream = {
    id: `u_${Date.now().toString(36)}`,
    name,
    prefix: cleanPrefix,
    baseUrl: normalizeBaseUrl(baseUrl),
    apiKey: apiKey || "",
    modelsUrl: modelsUrl || inferModelsUrl(baseUrl),
    builtin: false,
    freeOnly: false,
    createdAt: Date.now(),
  };
  const { upstreams = [] } = readFile();
  upstreams.push(upstream);
  writeFile({ upstreams });
  reloadUpstreams();
  return upstream;
}

// 删除自定义上游
export function removeUpstream(id) {
  const { upstreams = [] } = readFile();
  const next = upstreams.filter((u) => u.id !== id);
  if (next.length === upstreams.length) return false;
  writeFile({ upstreams: next });
  reloadUpstreams();
  return true;
}

export { CONFIG_PATH };
