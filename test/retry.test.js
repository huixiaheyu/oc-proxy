import { describe, it, expect, vi, beforeEach } from "vitest";
import { withRetry, isConnectionError, parseRetryAfter } from "../lib/retry.js";

// ===== parseRetryAfter =====
describe("parseRetryAfter", () => {
  it("解析秒数字符串", () => {
    expect(parseRetryAfter("30")).toBe(30000);
  });

  it("解析秒数数字", () => {
    expect(parseRetryAfter("5")).toBe(5000);
  });

  it("负值 clamp 到 0", () => {
    expect(parseRetryAfter("-10")).toBe(0);
  });

  it("非数字返回 0", () => {
    expect(parseRetryAfter("abc")).toBe(0);
  });

  it("空字符串返回 0", () => {
    expect(parseRetryAfter("")).toBe(0);
  });

  it("超过上限 30s 的秒数被截断", () => {
    expect(parseRetryAfter("600")).toBe(30000);
  });

  it("自定义上限", () => {
    expect(parseRetryAfter("100", 5000)).toBe(5000);
  });

  it("解析 HTTP-date 格式", () => {
    const future = new Date(Date.now() + 5000);
    const httpDate = future.toUTCString();
    const result = parseRetryAfter(httpDate);
    expect(result).toBeGreaterThanOrEqual(4000);
    expect(result).toBeLessThanOrEqual(6000);
  });

  it("HTTP-date 已过期返回 0", () => {
    const past = new Date(Date.now() - 10000);
    expect(parseRetryAfter(past.toUTCString())).toBe(0);
  });
});

// ===== isConnectionError =====
describe("isConnectionError", () => {
  it("AbortError 是连接错误", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(isConnectionError(err)).toBe(true);
  });

  it("ECONNREFUSED 是连接错误", () => {
    const err = new Error("connect ECONNREFUSED");
    err.code = "ECONNREFUSED";
    expect(isConnectionError(err)).toBe(true);
  });

  it("ETIMEDOUT 是连接错误", () => {
    const err = new Error("timeout");
    err.code = "ETIMEDOUT";
    expect(isConnectionError(err)).toBe(true);
  });

  it("ENOTFOUND 是连接错误", () => {
    const err = new Error("getaddrinfo ENOTFOUND");
    err.code = "ENOTFOUND";
    expect(isConnectionError(err)).toBe(false); // ENOTFOUND 不在 CONNECTION_ERRORS 中
  });

  it("ECONNRESET 是连接错误", () => {
    const err = new Error("socket hang up");
    err.code = "ECONNRESET";
    expect(isConnectionError(err)).toBe(true);
  });

  it("普通 Error 不是连接错误", () => {
    const err = new Error("some other error");
    expect(isConnectionError(err)).toBe(false);
  });

  it("带 429 status 的错误不是连接错误", () => {
    const err = new Error("429");
    err.status = 429;
    expect(isConnectionError(err)).toBe(false);
  });

  it("5xx status 不算连接错误", () => {
    const err = new Error("500");
    err.status = 500;
    expect(isConnectionError(err)).toBe(false);
  });
});

// ===== withRetry =====
describe("withRetry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("第一次成功不重试", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("失败后重试直到成功（使用 retryableError）", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockResolvedValue("ok");
    const result = await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 10,
      retryableError: () => true,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("默认 retryableStatuses 匹配 503 错误并重试", async () => {
    const err503 = new Error("503");
    err503.status = 503;
    const fn = vi.fn()
      .mockRejectedValueOnce(err503)
      .mockResolvedValue("ok");
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("默认不匹配普通 Error，不重试", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("plain error"));
    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 10 })
    ).rejects.toThrow("plain error");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("耗尽重试次数后抛出最后一个错误", async () => {
    const err503 = new Error("503");
    err503.status = 503;
    const fn = vi.fn().mockRejectedValue(err503);
    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 10 })
    ).rejects.toThrow("503");
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("调用 onRetry 回调", async () => {
    const onRetry = vi.fn();
    const err503 = new Error("503");
    err503.status = 503;
    const fn = vi.fn()
      .mockRejectedValueOnce(err503)
      .mockResolvedValue("ok");
    await withRetry(fn, { maxRetries: 3, baseDelayMs: 10, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Number), expect.objectContaining({ message: "503" }));
  });

  it("retryableError 可阻止重试", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("no-retry"));
    await expect(
      withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 10,
        retryableError: () => false,
      })
    ).rejects.toThrow("no-retry");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retryableError 允许可重试错误", async () => {
    const retryErr = new Error("retryable");
    retryErr.status = 429;
    const fn = vi.fn()
      .mockRejectedValueOnce(retryErr)
      .mockResolvedValue("ok");
    const result = await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 10,
      retryableError: (e) => e.status === 429,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("ECONNREFUSED 错误默认可重试", async () => {
    const connErr = new Error("ECONNREFUSED");
    connErr.code = "ECONNREFUSED";
    const fn = vi.fn()
      .mockRejectedValueOnce(connErr)
      .mockResolvedValue("ok");
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("AbortError 默认不可重试", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const fn = vi.fn().mockRejectedValue(abortErr);
    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 10 })
    ).rejects.toThrow("aborted");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
