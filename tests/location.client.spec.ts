import { afterEach, expect, it, vi } from 'vitest'
import { locateUser, type LocationResult, type LocationSdk } from '../src/client/location.ts'

afterEach(() => { vi.useRealTimers() })

function fixture() {
  let callback: (status: string, result: LocationResult) => void = () => { throw new Error('Lookup has not started') }
  let options: object | undefined
  const api: LocationSdk = {
    plugin: (_name, ready) => { ready() },
    Geolocation: class {
      constructor(value: object) { options = value }
      getCurrentPosition(accept: typeof callback) { callback = accept }
    },
  }
  return { api, complete: (status: string, result: LocationResult) => { callback(status, result) }, options: () => options }
}

it.each(['html5', 'ip'])('returns %s location in map coordinates and identifies IP approximation', async source => {
  const f = fixture()
  const result = locateUser(f.api, 10000, new AbortController().signal)
  expect(f.options()).toMatchObject({ convert: true, GeoLocationFirst: true, panToLocation: false, timeout: 10000 })
  f.complete('complete', { position: { getLng: () => 112.55, getLat: () => 37.87 }, location_type: source })
  await expect(result).resolves.toEqual({ point: { lng: 112.55, lat: 37.87 }, approximate: source === 'ip' })
})

it('rejects denied or failed lookup without substituting a fixed location', async () => {
  const f = fixture()
  const result = locateUser(f.api, 10000, new AbortController().signal)
  f.complete('error', {})
  await expect(result).rejects.toMatchObject({ code: 'failed' })
})

it('bounds a plugin load that never completes and does not start it after timeout', async () => {
  vi.useFakeTimers()
  let ready = () => {}
  const construct = vi.fn()
  const f = fixture()
  f.api.plugin = (_name, accept) => { ready = accept }
  f.api.Geolocation = class { constructor() { construct() } getCurrentPosition() {} }
  const result = locateUser(f.api, 1000, new AbortController().signal)
  const failure = expect(result).rejects.toMatchObject({ code: 'timeout' })
  await vi.advanceTimersByTimeAsync(1000)
  await failure
  ready()
  expect(construct).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('discards a late callback after cancellation and releases its timeout', async () => {
  vi.useFakeTimers()
  const f = fixture(), cancel = new AbortController()
  const result = locateUser(f.api, 1000, cancel.signal)
  const failure = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  cancel.abort()
  f.complete('complete', { position: { getLng: () => 112, getLat: () => 38 } })
  await failure
  expect(vi.getTimerCount()).toBe(0)
})
