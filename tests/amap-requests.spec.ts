import { afterEach, expect, it, vi } from 'vitest'
import { AMapApiError, AMapService, parsePoint } from '../src/map-service.ts'

const origin = parsePoint('112,38'), destination = parsePoint('112.01,38.01'), via = parsePoint('112.005,38.005')
const policy = { requestIntervalMs: 500, qpsRetries: 2, qpsRetryDelayMs: 1200 }
const route = { errcode: 0, data: { paths: [{ distance: 100, duration: 30, steps: [{ polyline: '112,38;112.01,38.01' }] }] } }
afterEach(() => { vi.useRealTimers() })

function fixture(responses: object[] = []) {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const starts: number[] = []
  const request = vi.fn<typeof fetch>(async () => {
    starts.push(Date.now())
    return Response.json(responses.shift() ?? route)
  })
  return { service: new AMapService('fixture', request, policy), request, starts }
}

it('paces all cycling legs and simultaneous route calls through one queue', async () => {
  const f = fixture()
  const result = Promise.all([
    f.service.compareDetour('cycling', origin, destination, via),
    f.service.plan('cycling', origin, destination),
  ])
  await vi.runAllTimersAsync()
  expect((await result).map(value => 'mode' in value ? value.mode : value.direct.mode)).toEqual(['cycling', 'cycling'])
  expect(f.starts).toEqual([0, 500, 1000, 1500])
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['waypoint', 'detour'] as const)('cancels the remaining %s requests after one leg fails', async kind => {
  const f = fixture([{ errcode: 0, data: [] }])
  const result = (kind === 'waypoint'
    ? f.service.plan('cycling', origin, destination, via)
    : f.service.compareDetour('cycling', origin, destination, via)).catch(error => error)
  await vi.runAllTimersAsync()
  expect((await result).message).toContain('data 应为对象')
  expect(f.request).toHaveBeenCalledTimes(1)
  const next = f.service.plan('cycling', origin, destination)
  await vi.runAllTimersAsync()
  expect((await next).mode).toBe('cycling')
  expect(f.starts).toEqual([0, 500])
  expect(vi.getTimerCount()).toBe(0)
})

it.each([
  { errcode: 10021, errmsg: 'CUQPS_HAS_EXCEEDED_THE_LIMIT' },
  { status: '0', infocode: '10021', info: 'CUQPS_HAS_EXCEEDED_THE_LIMIT' },
])('cools down the whole queue then retries a QPS rejection', async rejection => {
  const f = fixture([rejection, route, route])
  const result = Promise.all([f.service.plan('cycling', origin, destination), f.service.plan('cycling', origin, destination)])
  await vi.runAllTimersAsync()
  expect(await result).toHaveLength(2)
  expect(f.starts).toEqual([0, 1200, 1700])
  expect(vi.getTimerCount()).toBe(0)
})

it('stops after two QPS retries and reports frequency rather than permission', async () => {
  const rejection = { errcode: 10021, errmsg: 'CUQPS_HAS_EXCEEDED_THE_LIMIT' }
  const f = fixture([rejection, rejection, rejection])
  const result = f.service.plan('cycling', origin, destination).catch(error => error)
  await vi.runAllTimersAsync()
  const error = await result
  expect(error).toBeInstanceOf(AMapApiError)
  expect(error.code).toBe('10021')
  expect(error.message).toMatchInlineSnapshot(`"高德请求频率超限：CUQPS_HAS_EXCEEDED_THE_LIMIT（10021）。请稍后重试，并检查同一账号下其他应用的调用频率。"`)
  expect(error.message).not.toContain('fixture')
  expect(error.message).not.toContain('权限和配额')
  expect(f.starts).toEqual([0, 1200, 3600])
  expect(vi.getTimerCount()).toBe(0)
})

it.each([10003, 10012, 10044])('does not retry non-QPS provider error %s', async errcode => {
  const f = fixture([{ errcode, errmsg: 'DENIED' }])
  const result = f.service.plan('cycling', origin, destination).catch(error => error)
  await vi.runAllTimersAsync()
  expect(await result).toMatchObject({ code: String(errcode) })
  expect(f.request).toHaveBeenCalledTimes(1)
  f.service.dispose()
  expect(vi.getTimerCount()).toBe(0)
})

it('cancels queued work immediately and does not consume its sending interval', async () => {
  const f = fixture(), controller = new AbortController()
  const first = f.service.plan('cycling', origin, destination)
  const cancelled = f.service.plan('cycling', origin, destination, undefined, controller.signal).catch(error => error)
  const following = f.service.plan('cycling', origin, destination)
  controller.abort(new Error('cancelled'))
  expect((await cancelled).message).toBe('cancelled')
  await vi.runAllTimersAsync()
  await Promise.all([first, following])
  expect(f.starts).toEqual([0, 500])
  expect(vi.getTimerCount()).toBe(0)
})

it('disposes a cooldown and queued retry without making another request', async () => {
  const f = fixture([{ errcode: 10021, errmsg: 'QPS' }])
  const first = f.service.plan('cycling', origin, destination).catch(error => error)
  const second = f.service.plan('cycling', origin, destination).catch(error => error)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.request).toHaveBeenCalledTimes(1)
  f.service.dispose()
  expect((await first).message).toContain('地图插件已关闭')
  expect((await second).message).toContain('地图插件已关闭')
  await vi.runAllTimersAsync()
  expect(f.request).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('aborts an active fetch and allows later independent calls to continue', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const active = Promise.withResolvers<Response>()
  const request = vi.fn<typeof fetch>().mockImplementationOnce(async (_input, init) => {
    init?.signal?.addEventListener('abort', () => { active.reject(init.signal?.reason) }, { once: true })
    return active.promise
  }).mockResolvedValue(Response.json(route))
  const service = new AMapService('fixture', request, policy)
  const first = service.plan('cycling', origin, destination, undefined, controller.signal).catch(error => error)
  const following = service.plan('cycling', origin, destination)
  await vi.advanceTimersByTimeAsync(0)
  controller.abort(new Error('cancelled'))
  expect((await first).message).toBe('cancelled')
  await vi.runAllTimersAsync()
  expect((await following).mode).toBe('cycling')
  expect(request).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})
