// 失败重试：指数退避 + 抖动 + Retry-After 支持

// 连接类错误码（可重试）
const CONNECTION_ERRORS = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT",
  "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT", "UND_ERR_ABORTED",
]);

// 判断是否为可重试的错误
function isRetryable(err, retryableStatuses) {
  if (err.code && CONNECTION_ERRORS.has(err.code)) return true;
  if (err.status && retryableStatuses.includes(err.status)) return true;
  if (err.name === "AbortError") return false;
  return false;
}

// 解析 Retry-After 头：支持秒数（"120"）和 HTTP-date（"Wed, 21 Oct 2015 07:28:00 GMT"）
export function parseRetryAfter(value, capMs = 30_000) {
  // 先判断是否像 HTTP-date（包含逗号或 GMT 关键字）
  if (typeof value === "string" && (value.includes(",") || value.includes("GMT"))) {
    const date = Date.parse(value);
    if (!isNaN(date)) {
      return Math.min(Math.max(0, date - Date.now()), capMs);
    }
  }
  return Math.max(0, Math.min((Number(value) || 0) * 1000, capMs));
}

/**
 * withRetry(fn, options) — 指数退避重试
 * @param {Function} fn - 要重试的异步函数
 * @param {Object} options
 * @param {number}   options.maxRetries      - 最大重试次数（默认 2，即最多 3 次尝试）
 * @param {number}   options.baseDelayMs     - 首次退避延迟（默认 1000ms）
 * @param {number}   options.maxDelayMs      - 退避上限（默认 8000ms）
 * @param {number}   options.retryDelayCapMs - Retry-After 最大等待（默认 30s）
 * @param {number}   options.jitterFactor    - 抖动系数（默认 0.3，±30%）
 * @param {number[]} options.retryableStatuses - 可重试 HTTP 状态码
 * @param {Function} options.retryableError  - 自定义判断：(err, attempt) => boolean
 * @param {Function} options.onRetry         - 回调：(attempt, delay, error) => void
 */
export async function withRetry(fn, options = {}) {
  const {
    maxRetries = 2,
    baseDelayMs = 1000,
    maxDelayMs = 8000,
    retryDelayCapMs = 30_000,
    jitterFactor = 0.3,
    retryableStatuses = [429, 500, 502, 503, 504],
    retryableError = null,
    onRetry = null,
  } = options;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const canRetry = retryableError
        ? retryableError(err, attempt)
        : isRetryable(err, retryableStatuses);

      if (!canRetry) throw err;
      if (attempt >= maxRetries) throw err;

      let delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);

      // 429 优先读 Retry-After（支持秒数和 HTTP-date 两种格式）
      if (err.status === 429 && err.headers?.["retry-after"]) {
        delay = parseRetryAfter(err.headers["retry-after"], retryDelayCapMs);
      }

      // 抖动
      delay = Math.round(delay * (1 + (Math.random() * 2 - 1) * jitterFactor));

      onRetry?.(attempt + 1, delay, err);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * 判断是否为连接阶段错误（用于流式重试判断）
 * 连接错误 = 未收到任何数据前的失败，可以安全重试
 */
export function isConnectionError(err) {
  if (err.code && CONNECTION_ERRORS.has(err.code)) return true;
  if (err.name === "AbortError") return true;
  if (err.status && err.status >= 500) return false; // 5xx 可能已部分返回
  return false;
}
