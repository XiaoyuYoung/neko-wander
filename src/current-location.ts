/** Temporary per-conversation location shared by the browser and map tools. */
import type { Point } from './map-service.ts'
import { parsePoint } from './map-service.ts'

/** Browser reports must identify the location request they answer. Zero is a proactive lookup. */
export type LocationReport =
  | { requestId: number; status: 'locating' | 'failed' }
  | { requestId: number; status: 'located'; point: Point; approximate: boolean }

/** Validate a browser report before changing any stored position.
 * @param value Untrusted browser JSON.
 * @returns A recognized lookup status with valid GCJ-02 coordinates when present.
 * @throws If the request ID, status or coordinates are invalid.
 */
export function parseLocationReport(value: unknown): LocationReport {
  if (typeof value !== 'object' || value === null) throw new TypeError('Invalid location report')
  const data = value as Record<string, unknown>
  if (typeof data.requestId !== 'number' || !Number.isSafeInteger(data.requestId) || data.requestId < 0) throw new TypeError('Invalid request ID')
  if (data.status === 'locating' || data.status === 'failed') return { requestId: data.requestId, status: data.status }
  if (data.status !== 'located' || typeof data.approximate !== 'boolean' || typeof data.point !== 'object' || data.point === null) throw new TypeError('Invalid location result')
  const point = data.point as Record<string, unknown>
  if (typeof point.lng !== 'number' || typeof point.lat !== 'number') throw new TypeError('Invalid coordinates')
  return { requestId: data.requestId, status: 'located', point: parsePoint(`${point.lng},${point.lat}`), approximate: data.approximate }
}

/** Expected failures tell the model how the user can supply a usable origin. */
export class CurrentLocationError extends Error {
  constructor(readonly code: 'failed' | 'approximate' | 'timeout' | 'disposed') {
    super({
      failed: '无法获取当前位置，请打开地图并允许浏览器定位后重试，或提供起点地址。',
      approximate: '目前只有 IP 推测的大致位置，不能作为默认起点；请允许精确定位，或提供起点地址。',
      timeout: '等待当前位置超时，请打开地图并允许定位后重试，或提供起点地址。',
      disposed: '地图插件已关闭，请重新打开后重试。',
    }[code])
  }
}

interface PendingLocation {
  id: number
  promise: Promise<Point>
  resolve: (point: Point) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Own bounded browser lookup requests; only precise, recent positions become default origins. */
export class CurrentLocations {
  private readonly values = new Map<string, { point: Point; expiresAt: number }>()
  private readonly pending = new Map<string, PendingLocation>()
  private sequence = 0
  private disposed = false

  constructor(private readonly maxAgeMs: number, private readonly timeoutMs: number,
    private readonly notify: (sessionId: string, requestId: number) => void) {}

  /** Resolve a recent precise position or ask the browser to locate; caller cancellation does not cancel other callers.
   * @param sessionId Conversation requesting its own location.
   * @param signal Cancels this caller's wait.
   * @returns A recent precise point, never an IP estimate.
   * @throws On cancellation, lookup failure, timeout or disposal.
   */
  async resolve(sessionId: string, signal: AbortSignal): Promise<Point> {
    signal.throwIfAborted()
    if (this.disposed) throw new CurrentLocationError('disposed')
    const value = this.values.get(sessionId)
    if (value && value.expiresAt > Date.now()) return value.point
    this.values.delete(sessionId)
    let pending = this.pending.get(sessionId)
    if (!pending) {
      const deferred = Promise.withResolvers<Point>()
      const id = ++this.sequence
      pending = { ...deferred, id, timer: setTimeout(() => this.finish(sessionId, new CurrentLocationError('timeout')), this.timeoutMs) }
      this.pending.set(sessionId, pending)
      this.notify(sessionId, id)
    }
    let abort: () => void = () => {}
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => { reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
    })
    try { return await Promise.race([pending.promise, cancelled]) }
    finally { signal.removeEventListener('abort', abort) }
  }

  /** Accept a matching report; stale replies cannot overwrite a newer lookup.
   * @param sessionId Conversation receiving the validated report.
   * @param report Browser lookup status or point.
   * @returns Whether the request ID is current and the report was accepted.
   */
  report(sessionId: string, report: LocationReport): boolean {
    if (this.disposed) return false
    const pending = this.pending.get(sessionId)
    if (pending ? pending.id !== report.requestId : report.requestId !== 0) return false
    this.values.delete(sessionId)
    if (report.status === 'locating') return true
    if (report.status === 'located' && !report.approximate) {
      this.values.set(sessionId, { point: report.point, expiresAt: Date.now() + this.maxAgeMs })
      if (pending) this.finish(sessionId, report.point)
    } else if (pending) {
      this.finish(sessionId, new CurrentLocationError(report.status === 'located' ? 'approximate' : 'failed'))
    }
    return true
  }

  private finish(sessionId: string, result: Point | Error): void {
    const pending = this.pending.get(sessionId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(sessionId)
    this.notify(sessionId, 0)
    if (result instanceof Error) pending.reject(result)
    else pending.resolve(result)
  }

  /** Clear positions and settle every outstanding lookup when the plugin unloads. */
  dispose(): void {
    this.disposed = true
    for (const sessionId of this.pending.keys()) this.finish(sessionId, new CurrentLocationError('disposed'))
    this.values.clear()
  }
}
