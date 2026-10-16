import { describe, expect, it } from 'vitest'
import { AMapService, parsePoint } from '../src/map-service.ts'

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
    expect(fake.calls[1]?.searchParams.get('waypoints')).toBe('116.5,39.8')
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
    const fake = fakeFetch([{ status: '0', info: 'INVALID_USER_KEY', infocode: '10001' }])
    await expect(new AMapService('test-key', fake.request).search('松林')).rejects.toThrow('INVALID_USER_KEY')
    expect(() => parsePoint('NaN,39.9')).toThrow('坐标')
    expect(() => parsePoint(',')).toThrow('坐标')
  })
})
