/**
 * FIFO token bucket used to keep a client under the Realtime message rate limit
 * (ARCHITECTURE §6.1: ≈ 25 msg/s per client). Callers wait for a token; nothing is ever dropped,
 * and waiters are served strictly in arrival order so per-channel message order is preserved.
 */

export interface TokenBucketOptions {
  /** Tokens added per second. */
  ratePerSecond: number
  /** Maximum number of stored tokens (the burst size). The bucket starts full. */
  burst: number
  /** Monotonic clock in milliseconds (injectable for tests). */
  now?: () => number
}

/** Default Realtime send budget for one client connection. */
export const REALTIME_SEND_RATE: TokenBucketOptions = { ratePerSecond: 25, burst: 10 }

export class TokenBucket {
  private readonly rate: number
  private readonly burst: number
  private readonly now: () => number
  private tokens: number
  private last: number
  private readonly waiters: Array<(granted: boolean) => void> = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(opts: TokenBucketOptions) {
    if (!(opts.ratePerSecond > 0) || !(opts.burst >= 1)) throw new Error("TokenBucket: ratePerSecond must be > 0 and burst >= 1")
    this.rate = opts.ratePerSecond / 1000
    this.burst = opts.burst
    this.now = opts.now ?? (() => performance.now())
    this.tokens = opts.burst
    this.last = this.now()
  }

  /** Number of callers waiting for a token. */
  get pending(): number {
    return this.waiters.length
  }

  /**
   * Wait for a token. Resolves true when granted, false if the bucket was disposed while waiting.
   * Grants happen in call order.
   */
  take(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    this.refill()
    if (this.waiters.length === 0 && this.tokens >= 1) {
      this.tokens -= 1
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve)
      this.schedule()
    })
  }

  /** Grant a token immediately if one is available and nobody is queued. */
  tryTake(): boolean {
    if (this.disposed) return false
    this.refill()
    if (this.waiters.length === 0 && this.tokens >= 1) {
      this.tokens -= 1
      return true
    }
    return false
  }

  /** Release every waiter with `false` and refuse further takes. */
  dispose(): void {
    this.disposed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    for (const w of this.waiters.splice(0)) w(false)
  }

  private refill(): void {
    const t = this.now()
    const elapsed = Math.max(0, t - this.last)
    this.last = t
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate)
  }

  private schedule(): void {
    if (this.timer !== null || this.waiters.length === 0) return
    const missing = Math.max(0, 1 - this.tokens)
    const delay = Math.ceil(missing / this.rate)
    this.timer = setTimeout(() => {
      this.timer = null
      this.drain()
    }, delay)
  }

  private drain(): void {
    if (this.disposed) return
    this.refill()
    while (this.waiters.length > 0 && this.tokens >= 1) {
      this.tokens -= 1
      this.waiters.shift()?.(true)
    }
    this.schedule()
  }
}
