import { describe, expect, it } from 'vitest'
import { AMapService, parseArea, parsePlaceMarker, parsePoint, pointText } from '../src/map-service.ts'

function fakeFetch(responses: object[]) {
  const calls: URL[] = []
  const request = async (input: URL | RequestInfo): Promise<Response> => {
    calls.push(new URL(String(input)))
    const next = responses.shift()
    if (!next) throw new Error('Unexpected AMap request')
    return new Response(JSON.stringify(next), { status: 200 })
  }
  return { request: request as typeof fetch, calls }
}

describe('AMapService', () => {
  it('validates a specific address for pin marking without a radius', () => {
    expect(parsePlaceMarker(' 店铺 ', '112,38', ' 解放路85号 ')).toMatchObject({
      name: '店铺', address: '解放路85号', point: { lng: 112, lat: 38 },
    })
    expect(() => parsePlaceMarker('店'.repeat(121), '112,38', '解放路85号')).toThrow(RangeError)
    expect(() => parsePlaceMarker('店铺', '112,38', '号'.repeat(501))).toThrow(RangeError)
  })
  it('validates an exploration circle before publishing it', () => {
    expect(parseArea(' 军旅苑周边 ', '112,38', 500)).toEqual({
      name: '军旅苑周边', center: { lng: 112, lat: 38 }, radiusMeters: 500,
    })
    for (const radius of [0, -1, 50001, 1.5, Infinity, NaN]) {
      expect(() => parseArea('军旅苑周边', '112,38', radius)).toThrow(RangeError)
    }
    expect(() => parseArea('', '112,38', 500)).toThrow(RangeError)
    expect(() => parseArea('周边', 'NaN,38', 500)).toThrow('坐标')
  })
  it('searches places without requesting a route', async () => {
    const fake = fakeFetch([{ status: '1', pois: [{ id: 'p1', name: '松林', address: '山路旁', location: '116.4,39.9' }] }])
    const service = new AMapService('test-key', fake.request)
    expect(await service.search('松林', '北京')).toEqual([{
      id: 'p1', name: '松林', address: '山路旁', point: { lng: 116.4, lat: 39.9 },
    }])
    expect(fake.calls.map(url => url.pathname)).toEqual(['/v3/place/text'])
    expect(fake.calls[0]?.searchParams.get('city')).toBe('北京')
  })

  it('compares direct and waypoint driving times', async () => {
    const response = (seconds: number, metres: number) => ({
      status: '1', route: { paths: [{ duration: String(seconds), distance: String(metres),
        steps: [{ polyline: '116.4,39.9;116.5,39.8' }] }] },
    })
    const fake = fakeFetch([response(1200, 10000), response(1800, 14000)])
    const service = new AMapService('test-key', fake.request)
    const result = await service.detour(parsePoint('116.4,39.9'), parsePoint('116.6,39.7'), parsePoint('116.5,39.8'))
    expect(result.extraMinutes).toBe(10)
    expect(result.extraKm).toBe(4)
    expect(result.via.path).toHaveLength(2)
    expect(result.via.origin).toEqual({ lng: 116.4, lat: 39.9 })
    expect(result.via.destination).toEqual({ lng: 116.6, lat: 39.7 })
    expect(result.via.via).toEqual({ lng: 116.5, lat: 39.8 })
    expect(fake.calls[1]?.searchParams.get('waypoints')).toBe('116.5,39.8')
  })

  it.each([
    ['walking', 'walking'], ['cycling', 'bicycling'], ['ebike', 'electrobike'],
  ] as const)('plans %s with its own endpoint and requests time and geometry', async (mode, endpoint) => {
    const fake = fakeFetch([{ status: '1', route: { paths: [{ distance: '1500', cost: { duration: '600' },
      steps: [{ polyline: '112,38;112.01,38.01' }] }] } }])
    const route = await new AMapService('test-key', fake.request).plan(mode, parsePoint('112,38'), parsePoint('112.01,38.01'))
    expect(route).toEqual({ mode, origin: { lng: 112, lat: 38 }, destination: { lng: 112.01, lat: 38.01 }, durationMinutes: 10, distanceKm: 1.5,
      path: [{ lng: 112, lat: 38 }, { lng: 112.01, lat: 38.01 }] })
    expect(fake.calls[0]?.pathname).toBe(`/v5/direction/${endpoint}`)
    expect(fake.calls[0]?.searchParams.get('show_fields')).toBe('cost,polyline')
  })

  it('combines cycling legs through a candidate before rounding totals', async () => {
    const response = (polyline: string) => ({ status: '1', route: { paths: [{ distance: '69', cost: { duration: '31' }, steps: [{ polyline }] }] } })
    const fake = fakeFetch([response('112,38;112.01,38.01'), response('112.01,38.01;112.02,38.02')])
    const route = await new AMapService('test-key', fake.request).plan('cycling', parsePoint('112,38'), parsePoint('112.02,38.02'), parsePoint('112.01,38.01'))
    expect(route.durationMinutes).toBe(1)
    expect(route.distanceKm).toBe(0.1)
    expect(route.path.at(-1)).toEqual({ lng: 112.02, lat: 38.02 })
    expect(fake.calls.map(url => [url.searchParams.get('origin'), url.searchParams.get('destination')])).toEqual([
      ['112,38', '112.01,38.01'], ['112.01,38.01', '112.02,38.02'],
    ])
    expect(fake.calls.every(url => !url.searchParams.has('waypoints'))).toBe(true)
  })

  it('compares cycling detours using unrounded times and distances in the same mode', async () => {
    const response = (duration: number, distance: number) => ({ status: '1', route: { paths: [{ distance, cost: { duration }, steps: [{ polyline: '112,38;112.01,38.01' }] }] } })
    const fake = fakeFetch([response(29, 149), response(31, 100), response(31, 100)])
    const detour = await new AMapService('test-key', fake.request).compareDetour('cycling', parsePoint('112,38'), parsePoint('112.02,38.02'), parsePoint('112.01,38.01'))
    expect(detour.extraMinutes).toBe(1)
    expect(detour.extraKm).toBe(0.1)
    expect(detour.direct.mode).toBe('cycling')
    expect(detour.via.mode).toBe('cycling')
    expect(fake.calls.map(url => url.pathname)).toEqual(Array(3).fill('/v5/direction/bicycling'))
  })

  it('reports unavailable routes and provider errors without substituting driving', async () => {
    const fake = fakeFetch([{ status: '0', info: 'USER_NOT_LOGIN', infocode: '10003' }])
    await expect(new AMapService('test-key', fake.request).plan('cycling', parsePoint('112,38'), parsePoint('112.01,38.01'))).rejects.toThrow('USER_NOT_LOGIN')
    expect(fake.calls).toHaveLength(1)
    const noRoute = fakeFetch([{ status: '1', route: { paths: [] } }])
    await expect(new AMapService('test-key', noRoute.request).plan('walking', parsePoint('112,38'), parsePoint('112.01,38.01'))).rejects.toThrow('未找到可用路线')
    const partial = fakeFetch([
      { status: '1', route: { paths: [{ distance: '100', cost: { duration: '30' }, steps: [{ polyline: '112,38;112.01,38.01' }] }] } },
      { status: '0', info: 'NO_ROUTE', infocode: '30003' },
    ])
    await expect(new AMapService('test-key', partial.request).plan('cycling', parsePoint('112,38'), parsePoint('112.02,38.02'), parsePoint('112.01,38.01'))).rejects.toThrow('NO_ROUTE')
  })

  it('searches within a configured radius', async () => {
    const fake = fakeFetch([{ status: '1', pois: [] }])
    const service = new AMapService('test-key', fake.request)
    expect(await service.nearby(parsePoint('116.4,39.9'), 3000, '公园')).toEqual([])
    expect(fake.calls[0]?.pathname).toBe('/v3/place/around')
    expect(fake.calls[0]?.searchParams.get('radius')).toBe('3000')
    await expect(service.nearby(parsePoint('116.4,39.9'), 50001)).rejects.toThrow('搜索半径')
  })

  it('reports provider errors and rejects invalid coordinates', async () => {
    expect(pointText(parsePoint('112.123456789,37.987654321'))).toBe('112.123457,37.987654')
    const fake = fakeFetch([{ status: '0', info: 'INVALID_USER_KEY', infocode: '10001' }])
    await expect(new AMapService('test-key', fake.request).search('松林')).rejects.toThrow('INVALID_USER_KEY')
    expect(() => parsePoint('NaN,39.9')).toThrow('坐标')
    expect(() => parsePoint(',')).toThrow('坐标')
  })
})
