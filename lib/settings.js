// 运行时设置管理模块：持久化到 data/settings.json（如自定义 API Key）
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

// 默认 API Key（与 server.js 一致）
const DEFAULT_API_KEY = process.env.API_KEY || "sk_9router";

let cache = null;

function readFile() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeFile(data) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2));
}

// 获取当前 API Key：优先运行时持久化值，其次环境变量，最后默认值
export function getApiKey() {
  if (cache && typeof cache.apiKey === "string") return cache.apiKey;
  const data = readFile();
  cache = data;
  const { apiKey } = data;
  return typeof apiKey === "string" && apiKey ? apiKey : DEFAULT_API_KEY;
}

// 设置新的 API Key 并持久化
export function setApiKey(apiKey) {
  const clean = String(apiKey || "").trim();
  if (!clean) throw new Error("API Key 不能为空");
  const data = readFile();
  data.apiKey = clean;
  writeFile(data);
  cache = data;
  return clean;
}

// 是否已通过网页自定义过 API Key
export function isApiKeyCustomized() {
  const { apiKey } = readFile();
  return typeof apiKey === "string" && apiKey.length > 0;
}

export { SETTINGS_PATH };
