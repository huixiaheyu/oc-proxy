import { describe, it, expect } from "vitest";

describe("AbortSignal 兜底（req.signal undefined 防护）", () => {
  it("AbortSignal.any 遇 undefined 会抛错（原 bug 根因）", () => {
    const ac = new AbortController();
    // 复现用户报错：signals[1] 为 undefined
    expect(() => AbortSignal.any([ac.signal, undefined])).toThrow(
      /must be an instance of AbortSignal/
    );
  });

  it("req.signal 为 undefined 时，兜底只用 ac.signal，不抛错", () => {
    const ac = new AbortController();
    const reqSignal = undefined; // 模拟部分环境下 req.signal 不存在
    const merged = reqSignal ? AbortSignal.any([ac.signal, reqSignal]) : ac.signal;
    expect(merged).toBe(ac.signal);
    expect(merged.aborted).toBe(false);
  });

  it("req.signal 正常存在时，AbortSignal.any 正常组合", () => {
    const ac = new AbortController();
    const reqSignal = new AbortController().signal;
    const merged = reqSignal ? AbortSignal.any([ac.signal, reqSignal]) : ac.signal;
    expect(merged).not.toBe(ac.signal);
    expect(merged.aborted).toBe(false);
  });

  it("任一信号 abort 后 merged 也 abort", () => {
    const ac = new AbortController();
    const reqSignal = new AbortController();
    const merged = AbortSignal.any([ac.signal, reqSignal.signal]);
    reqSignal.abort();
    expect(merged.aborted).toBe(true);
  });
});
