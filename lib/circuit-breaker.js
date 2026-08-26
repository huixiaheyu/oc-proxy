// 三态熔断器：CLOSED → OPEN → HALF_OPEN → CLOSED
// 按 upstreamId 隔离，防多级代理链重试风暴

const STATES = { CLOSED: "CLOSED", OPEN: "OPEN", HALF_OPEN: "HALF_OPEN" };

export class CircuitBreaker {
  #states;
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold ?? Number(process.env.CB_FAILURE_THRESHOLD || 5);
    this.cooldownMs = options.cooldownMs ?? Number(process.env.CB_COOLDOWN_MS || 60_000);
    this.halfOpenMax = options.halfOpenMax ?? Number(process.env.CB_HALF_OPEN_MAX || 1);
    this.#states = new Map();
  }

  #get(id) {
    if (!this.#states.has(id)) {
      this.#states.set(id, {
        state: STATES.CLOSED,
        failures: 0,
        openedAt: 0,
        halfOpenCount: 0,
      });
    }
    return this.#states.get(id);
  }

  /**
   * 判断是否允许请求通过
   * @returns {boolean} true = 放行, false = 拒绝（快速失败）
   */
  allowRequest(id) {
    const s = this.#get(id);

    if (s.state === STATES.CLOSED) return true;

    if (s.state === STATES.OPEN) {
      if (Date.now() - s.openedAt >= this.cooldownMs) {
        // Node.js 单线程，同步操作天然原子，直接切换到 HALF_OPEN
        s.state = STATES.HALF_OPEN;
        s.halfOpenCount = 0;
        return true;
      }
      return false;
    }

    // HALF_OPEN：限制探测请求数
    if (s.halfOpenCount >= this.halfOpenMax) return false;
    s.halfOpenCount++;
    return true;
  }

  /**
   * 记录请求成功 → 恢复到 CLOSED
   */
  recordSuccess(id) {
    const s = this.#get(id);
    if (s.failures !== 0 || s.state !== STATES.CLOSED) {
      console.log(`[CircuitBreaker] CLOSED upstream=${id}`);
    }
    s.failures = 0;
    s.state = STATES.CLOSED;
  }

  /**
   * 记录请求失败（5xx / 连接错误） → 累计失败计数，达到阈值后熔断
   */
  recordFailure(id) {
    const s = this.#get(id);

    if (s.state === STATES.HALF_OPEN) {
      console.log(`[CircuitBreaker] OPEN upstream=${id} (half-open probe failed)`);
      s.state = STATES.OPEN;
      s.openedAt = Date.now();
      return;
    }

    s.failures++;
    if (s.failures >= this.failureThreshold) {
      console.log(`[CircuitBreaker] OPEN upstream=${id} failures=${s.failures}`);
      s.state = STATES.OPEN;
      s.openedAt = Date.now();
    }
  }

  /**
   * 记录 429 限流（不计入熔断失败，仅日志）
   * 429 是限流信号，说明上游健康，只是请求过快
   */
  recordRateLimit(id) {
    // 429 不触发熔断，由 retry.js 的 Retry-After 处理
  }

  getState(id) {
    return this.#get(id).state;
  }

  /**
   * 获取指定上游的熔断状态详情（供前端展示）
   */
  getStatus(id) {
    const s = this.#get(id);
    return {
      state: s.state,
      failures: s.failures,
      threshold: this.failureThreshold,
      cooldownRemaining: s.state === STATES.OPEN
        ? Math.max(0, this.cooldownMs - (Date.now() - s.openedAt))
        : 0,
    };
  }

  /**
   * 获取所有上游的熔断状态（供 API 使用）
   */
  getAllStatus() {
    const result = {};
    for (const [id] of this.#states) {
      result[id] = this.getStatus(id);
    }
    return result;
  }
}
