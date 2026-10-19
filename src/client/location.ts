/** Cancellable AMap location lookup; returned positions use the map's GCJ-02 coordinates. */
import type { Point } from '../map-service.ts'
import type { LocationReport } from '../current-location.ts'

/** Send a browser location report to the authenticated current-conversation endpoint.
 * @param sessionId Conversation receiving this lookup.
 * @param report Lookup status or GCJ-02 position.
 * @param signal Cancels upload when the map closes or another lookup supersedes it.
 * @returns Completion after the Host accepts the report.
 */
export async function postLocation(sessionId: string, report: LocationReport, signal: AbortSignal): Promise<void> {
  const response = await fetch(`/api/neko-wander/location?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report), signal,
  })
  if (!response.ok) throw new Error(`Location report failed: HTTP ${response.status}`)
}

/** Fields consumed from the AMap Geolocation callback. */
export interface LocationResult {
  position?: { getLng(): number; getLat(): number }
  location_type?: string
}

/** Browser SDK methods used to load and request a location. */
export interface LocationSdk {
  plugin(name: string, ready: () => void): void
  Geolocation?: new (options: object) => {
    getCurrentPosition(callback: (status: string, result: LocationResult) => void): void
  }
}

/** A failed lookup never substitutes a fixed point for the user's location. */
export class LocationError extends Error {
  constructor(readonly code: 'failed' | 'timeout' | 'unavailable') { super(code) }
}

/**
 * Request one location, including a bounded plugin load; late callbacks are discarded.
 * @param api - Loaded AMap SDK.
 * @param timeoutMs - Total lookup budget in milliseconds.
 * @param signal - Stops consuming callbacks; the SDK's own timeout bounds its request.
 * @returns a GCJ-02 point and whether the provider used approximate IP positioning.
 */
export function locateUser(api: LocationSdk, timeoutMs: number, signal: AbortSignal): Promise<{ point: Point; approximate: boolean }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    let settled = false
    const cleanup = (): boolean => {
      if (settled) return false
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      return true
    }
    const fail = (error: unknown): void => { if (cleanup()) reject(error) }
    const abort = (): void => { fail(signal.reason) }
    const timer = setTimeout(() => { fail(new LocationError('timeout')) }, timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    try {
      api.plugin('AMap.Geolocation', () => {
        if (settled) return
        if (!api.Geolocation) { fail(new LocationError('unavailable')); return }
        try {
          const locator = new api.Geolocation({
            enableHighAccuracy: true, GeoLocationFirst: true, timeout: timeoutMs, maximumAge: 0,
            convert: true, showButton: false, showMarker: false, showCircle: false,
            panToLocation: false, zoomToAccuracy: false,
          })
          locator.getCurrentPosition((status, result) => {
            if (settled) return
            if (status !== 'complete' || !result.position) { fail(new LocationError('failed')); return }
            const lng = result.position.getLng(), lat = result.position.getLat()
            if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) {
              fail(new LocationError('failed')); return
            }
            if (cleanup()) resolve({ point: { lng, lat }, approximate: result.location_type === 'ip' })
          })
        } catch (cause) { fail(cause) }
      })
    } catch (cause) { fail(cause) }
  })
}
