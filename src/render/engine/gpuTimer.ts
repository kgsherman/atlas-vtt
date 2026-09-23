/**
 * GPU frame time via EXT_disjoint_timer_query_webgl2 (when the browser exposes it). Results arrive a
 * few frames late; `latestMs` is the most recent completed measurement or null when unsupported.
 * Used to feed adaptive quality with real GPU cost on displays where rAF deltas are vsync-locked.
 */
interface TimerExt {
  TIME_ELAPSED_EXT: number
  GPU_DISJOINT_EXT: number
}

export class GpuTimer {
  private readonly gl: WebGL2RenderingContext
  private readonly ext: TimerExt | null
  private pending: WebGLQuery[] = []
  private free: WebGLQuery[] = []
  private active: WebGLQuery | null = null
  latestMs: number | null = null

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    this.ext = (gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExt | null) ?? null
  }

  get supported(): boolean {
    return this.ext !== null
  }

  begin(): void {
    if (!this.ext || this.active || this.pending.length > 4) return
    const q = this.free.pop() ?? this.gl.createQuery()
    if (!q) return
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q)
    this.active = q
  }

  end(): void {
    if (!this.ext || !this.active) return
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT)
    this.pending.push(this.active)
    this.active = null
  }

  /** Collect finished queries (call once per frame, outside begin/end). */
  poll(): void {
    if (!this.ext) return
    const gl = this.gl
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean
    while (this.pending.length > 0) {
      const q = this.pending[0]
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number
      this.pending.shift()
      this.free.push(q)
      if (!disjoint) this.latestMs = ns / 1e6
    }
  }

  /** Forget in-flight queries (context loss). */
  reset(): void {
    this.pending = []
    this.free = []
    this.active = null
    this.latestMs = null
  }

  dispose(): void {
    for (const q of [...this.pending, ...this.free]) this.gl.deleteQuery(q)
    this.reset()
  }
}
