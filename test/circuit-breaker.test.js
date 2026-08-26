import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CircuitBreaker } from "../lib/circuit-breaker.js";

describe("CircuitBreaker", () => {
  let cb;

  beforeEach(() => {
    cb = new CircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 1000,
      halfOpenMaxConcurrent: 1,
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("默认状态为 CLOSED，允许请求", () => {
    expect(cb.allowRequest("a")).toBe(true);
    expect(cb.getState("a")).toBe("CLOSED");
  });

  it("记录成功，failures 不增加", () => {
    cb.recordFailure("a");
    cb.recordFailure("a");
    cb.recordSuccess("a"); // 重置
    expect(cb.getState("a")).toBe("CLOSED");
  });

  it("连续失败达阈值后进入 OPEN", () => {
    cb.recordFailure("a");
    cb.recordFailure("a");
    expect(cb.getState("a")).toBe("CLOSED");
    cb.recordFailure("a"); // 第 3 次
    expect(cb.getState("a")).toBe("OPEN");
    expect(cb.allowRequest("a")).toBe(false);
  });

  it("OPEN 冷却后允许探测（HALF_OPEN）", () => {
    cb.recordFailure("a");
    cb.recordFailure("a");
    cb.recordFailure("a"); // → OPEN
    expect(cb.allowRequest("a")).toBe(false);

    vi.advanceTimersByTime(1001); // 冷却时间过了
    expect(cb.allowRequest("a")).toBe(true); // HALF_OPEN
  });

  it("HALF_OPEN 探测成功 → CLOSED", () => {
    cb.recordFailure("a");
    cb.recordFailure("a");
    cb.recordFailure("a"); // → OPEN
    vi.advanceTimersByTime(1001);
    cb.allowRequest("a"); // → HALF_OPEN
    cb.recordSuccess("a");
    expect(cb.getState("a")).toBe("CLOSED");
  });

  it("HALF_OPEN 探测失败 → OPEN（重新计时）", () => {
    cb.recordFailure("a");
    cb.recordFailure("a");
    cb.recordFailure("a"); // → OPEN
    vi.advanceTimersByTime(1001);
    cb.allowRequest("a"); // → HALF_OPEN
    cb.recordFailure("a"); // → OPEN
    expect(cb.getState("a")).toBe("OPEN");
    // 冷却重置，还没过
    expect(cb.allowRequest("a")).toBe(false);
  });

  it("429 不计入熔断失败", () => {
    cb.recordFailure("a");
    cb.recordFailure("a");
    cb.recordRateLimit("a"); // 不增加 failures
    cb.recordRateLimit("a");
    expect(cb.getState("a")).toBe("CLOSED");
    cb.recordFailure("a"); // 第 3 次 failure
    expect(cb.getState("a")).toBe("OPEN");
  });

  it("getStatus 返回详情", () => {
    cb.recordFailure("a");
    const status = cb.getStatus("a");
    expect(status.state).toBe("CLOSED");
    expect(status.failures).toBe(1);
    expect(status.threshold).toBe(3);
    expect(status.cooldownRemaining).toBe(0);
  });

  it("getStatus OPEN 时显示冷却剩余", () => {
    cb.recordFailure("a");
    cb.recordFailure("a");
    cb.recordFailure("a"); // → OPEN
    vi.advanceTimersByTime(500);
    const status = cb.getStatus("a");
    expect(status.state).toBe("OPEN");
    expect(status.cooldownRemaining).toBeGreaterThan(0);
    expect(status.cooldownRemaining).toBeLessThanOrEqual(1000);
  });

  it("getAllStatus 返回所有上游状态", () => {
    cb.recordFailure("a");
    cb.recordFailure("a");
    cb.recordFailure("a"); // a → OPEN
    cb.recordFailure("b"); // b 1 次
    const all = cb.getAllStatus();
    expect(all.a).toBeDefined();
    expect(all.a.state).toBe("OPEN");
    expect(all.b).toBeDefined();
    expect(all.b.failures).toBe(1);
  });

  it("不同 upstreamId 独立计数", () => {
    cb.recordFailure("a");
    cb.recordFailure("a");
    cb.recordFailure("a"); // a → OPEN
    expect(cb.getState("a")).toBe("OPEN");
    expect(cb.getState("b")).toBe("CLOSED");
    expect(cb.allowRequest("b")).toBe(true);
  });
});
