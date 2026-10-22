import { expect, it } from 'vitest'
import { AMapService, parsePoint } from '../src/map-service.ts'
import { transitResponse } from './transit-response.ts'

const origin = parsePoint('112,38'), destination = parsePoint('112.01,38.01')
function fixture(result: object = transitResponse(), citycode: unknown = '0351') {
  const calls: { url: URL; signal: AbortSignal | null | undefined }[] = []
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    calls.push({ url, signal: init?.signal })
    return Response.json(url.pathname === '/v3/geocode/regeo'
      ? { status: '1', regeocode: { addressComponent: { citycode } } } : result)
  }
  return { service: new AMapService('fixture', request), calls }
}

it('resolves both cities and returns bus/metro instructions with separate walking geometry', async () => {
  const f = fixture(), controller = new AbortController()
  const route = await f.service.plan('transit', origin, destination, undefined, controller.signal)
  expect(route).toMatchObject({ mode: 'transit', origin, destination, durationMinutes: 30, distanceKm: 5,
    transit: { transfers: 1, walkingMeters: 500, fareYuan: 4, legs: [
      { line: '公交1路', boardingStop: '起点站', alightingStop: '换乘站', stops: 3 },
      { line: '地铁2号线', boardingStop: '换乘站', alightingStop: '终点站', stops: 2 },
    ] } })
  expect(route.sections?.map(section => section.mode)).toEqual(['walking', 'transit', 'walking', 'transit'])
  expect(route.path).toHaveLength(8)
  expect(f.calls.map(call => call.url.pathname)).toEqual(['/v3/geocode/regeo', '/v3/geocode/regeo', '/v3/direction/transit/integrated'])
  expect(Object.fromEntries(f.calls[2]!.url.searchParams)).toMatchObject({ city: '0351', cityd: '0351', extensions: 'all', strategy: '0' })
  controller.abort()
  expect(f.calls.every(call => call.signal?.aborted)).toBe(true)
})

it('leaves an unavailable fare unknown rather than making it free', async () => {
  const response = transitResponse()
  response.route.transits[0]!.cost = ''
  expect((await fixture(response).service.plan('transit', origin, destination)).transit).not.toHaveProperty('fareYuan')
})

it.each([undefined, null, [], {}, '', { trip: [], duration: '0', nested: { stop: '', names: [null, []] } }])(
  'ignores empty railway/taxi placeholders: %j', async placeholder => {
    const response = transitResponse()
    Object.assign(response.route.transits[0]!.segments[0]!, { railway: placeholder, taxi: placeholder })
    const route = await fixture(response).service.plan('transit', origin, destination)
    expect(route.transit?.legs.map(leg => leg.line)).toEqual(['公交1路', '地铁2号线'])
    expect(route.durationMinutes).toBe(30)
  })

it.each(['railway', 'taxi'] as const)('selects a later bus proposal when the first includes actual %s travel', async kind => {
  const response = transitResponse()
  const excluded = structuredClone(response.route.transits[0]!)
  Object.assign(excluded.segments[0]!, { [kind]: kind === 'railway'
    ? { trip: 'G123', departure_stop: { name: '火车站' }, arrival_stop: { name: '另一站' } }
    : { distance: '2000', polyline: '112,38;112.01,38.01' } })
  excluded.duration = '9999'
  response.route.transits.unshift(excluded)
  const f = fixture(response)
  const route = await f.service.plan('transit', origin, destination)
  expect(route.durationMinutes).toBe(30)
  expect(route.transit?.legs[0]?.line).toBe('公交1路')
  expect(f.calls.filter(call => call.url.pathname.includes('/transit/'))).toHaveLength(1)
})

it('reports unavailable supported proposals instead of dropping a real train leg', async () => {
  const response = transitResponse()
  Object.assign(response.route.transits[0]!.segments[0]!, { railway: { trip: 'G123' } })
  await expect(fixture(response).service.plan('transit', origin, destination)).rejects.toThrow('备选方案均包含暂未支持')
})

it('rejects transit stopovers and detour comparison before making provider requests', async () => {
  const f = fixture()
  await expect(f.service.plan('transit', origin, destination, parsePoint('112.005,38.005'))).rejects.toThrow('途经点')
  await expect(f.service.compareDetour('transit', origin, destination, parsePoint('112.005,38.005'))).rejects.toThrow('绕行比较')
  expect(f.calls).toHaveLength(0)
})

it('rejects unresolved cities, empty results and denied quota without a driving fallback', async () => {
  const city = fixture(transitResponse(), [])
  await expect(city.service.plan('transit', origin, destination)).rejects.toThrow('所在城市')
  expect(city.calls).toHaveLength(1)
  const empty = fixture({ status: '1', route: { transits: [] } })
  await expect(empty.service.plan('transit', origin, destination)).rejects.toThrow('未找到可用公交方案')
  const denied = fixture({ status: '0', info: 'USER_DAILY_QUERY_OVER_LIMIT', infocode: '10003' })
  await expect(denied.service.plan('transit', origin, destination)).rejects.toThrow('USER_DAILY_QUERY_OVER_LIMIT')
  expect(denied.calls.some(call => call.url.pathname.includes('driving'))).toBe(false)
})

it.each(['duration', 'polyline', 'station', 'railway', 'walking'] as const)('rejects a partial or unsupported %s result', async kind => {
  const response = transitResponse(), proposal = response.route.transits[0]!
  if (kind === 'duration') proposal.duration = ''
  if (kind === 'polyline') proposal.segments[0]!.bus.buslines[0]!.polyline = ''
  if (kind === 'station') proposal.segments[0]!.bus.buslines[0]!.departure_stop.name = ''
  if (kind === 'railway') Object.assign(proposal.segments[1]!.railway, { name: '列车' })
  if (kind === 'walking') proposal.segments[0]!.walking.steps = []
  await expect(fixture(response).service.plan('transit', origin, destination)).rejects.toThrow()
})
