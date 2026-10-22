/** Per-provider circuit breaker: N failures within a window open it for a cool-down; after that, one failure re-opens it. */

export interface BreakerConfig {
  failures: number;
  windowMs: number;
  coolDownMs: number;
}

export const DEFAULT_BREAKER: BreakerConfig = { failures: 5, windowMs: 60_000, coolDownMs: 5 * 60_000 };

export class CircuitBreaker {
  private fails: number[] = [];
  private openUntil = 0;

  constructor(
    private readonly cfg: BreakerConfig = DEFAULT_BREAKER,
    private readonly now: () => number = Date.now,
  ) {}

  state(): "closed" | "open" | "half-open" {
    if (this.openUntil === 0) return "closed";
    return this.now() < this.openUntil ? "open" : "half-open";
  }

  /** May we call the provider now? After the cool-down (half-open) calls go through; one failure re-opens. */
  allow(): boolean {
    return this.state() !== "open";
  }

  success() {
    this.fails = [];
    this.openUntil = 0;
  }

  failure() {
    const t = this.now();
    if (this.state() === "half-open") {
      this.openUntil = t + this.cfg.coolDownMs;
      return;
    }
    this.fails = this.fails.filter((x) => t - x < this.cfg.windowMs);
    this.fails.push(t);
    if (this.fails.length >= this.cfg.failures) {
      this.openUntil = t + this.cfg.coolDownMs;
      this.fails = [];
    }
  }

  retryInMs(): number {
    return Math.max(0, this.openUntil - this.now());
  }
}
