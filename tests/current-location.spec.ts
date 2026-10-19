import { afterEach, expect, it, vi } from 'vitest'
import { CurrentLocations, CurrentLocationError, parseLocationReport } from '../src/current-location.ts'

afterEach(() => { vi.useRealTimers() })
const point = { lng: 112.55, lat: 37.87 }

it('shares a recent precise position only within its conversation and requests a new one after expiry', async () => {
  vi.useFakeTimers()
  const notify = vi.fn()
  const locations = new CurrentLocations(1000, 2000, notify)
  locations.report('a', { requestId: 0, status: 'located', point, approximate: false })
  expect(await locations.resolve('a', new AbortController().signal)).toEqual(point)
  expect(notify).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1001)
  const result = locations.resolve('a', new AbortController().signal)
  expect(notify).toHaveBeenCalledWith('a', 1)
  const fresh = { lng: 113, lat: 38 }
  locations.report('a', { requestId: 1, status: 'located', point: fresh, approximate: false })
  expect(await result).toEqual(fresh)
  const other = locations.resolve('b', new AbortController().signal)
  expect(notify).toHaveBeenCalledWith('b', 2)
  const rejected = expect(other).rejects.toBeInstanceOf(CurrentLocationError)
  locations.dispose()
  await rejected
})

it('coalesces concurrent requests while allowing one caller to cancel', async () => {
  const notify = vi.fn()
  const locations = new CurrentLocations(1000, 2000, notify)
  const cancelled = new AbortController()
  const first = locations.resolve('a', cancelled.signal)
  const second = locations.resolve('a', new AbortController().signal)
  expect(notify).toHaveBeenCalledTimes(1)
  const rejected = expect(first).rejects.toThrow('cancelled')
  cancelled.abort(new Error('cancelled'))
  await rejected
  expect(locations.report('a', { requestId: 99, status: 'located', point, approximate: false })).toBe(false)
  locations.report('a', { requestId: 1, status: 'located', point, approximate: false })
  expect(await second).toEqual(point)
  locations.dispose()
})

it('rejects approximate or failed locations and bounds the wait without inventing an origin', async () => {
  vi.useFakeTimers()
  const locations = new CurrentLocations(1000, 2000, vi.fn())
  const approximate = locations.resolve('a', new AbortController().signal)
  const rejected = expect(approximate).rejects.toMatchObject({ code: 'approximate' })
  locations.report('a', { requestId: 1, status: 'located', point, approximate: true })
  await rejected
  const timeout = locations.resolve('a', new AbortController().signal)
  const timedOut = expect(timeout).rejects.toMatchObject({ code: 'timeout' })
  await vi.advanceTimersByTimeAsync(2000)
  await timedOut
  const failed = locations.resolve('a', new AbortController().signal)
  const failure = expect(failed).rejects.toMatchObject({ code: 'failed' })
  locations.report('a', { requestId: 3, status: 'failed' })
  await failure
  locations.dispose()
})

it('invalidates a previous precise position when a retry starts', async () => {
  const notify = vi.fn()
  const locations = new CurrentLocations(1000, 2000, notify)
  locations.report('a', { requestId: 0, status: 'located', point, approximate: false })
  locations.report('a', { requestId: 0, status: 'locating' })
  const waiting = locations.resolve('a', new AbortController().signal)
  expect(notify).toHaveBeenCalledWith('a', 1)
  const closed = expect(waiting).rejects.toMatchObject({ code: 'disposed' })
  locations.dispose()
  await closed
})

it('validates browser location reports before accepting coordinates', () => {
  expect(parseLocationReport({ requestId: 0, status: 'located', point, approximate: false })).toEqual({ requestId: 0, status: 'located', point, approximate: false })
  for (const invalid of [null, {}, { requestId: -1, status: 'failed' },
    { requestId: 0, status: 'located', approximate: false, point: { lng: 999, lat: 38 } },
    { requestId: 0, status: 'located', approximate: false, point: { lng: '112', lat: 38 } }]) {
    expect(() => parseLocationReport(invalid)).toThrow()
  }
})
