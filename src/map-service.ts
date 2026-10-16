/** AMap-backed business operations. This module has no Harness dependency. */
export interface Point { lng: number; lat: number }
export interface Place { id: string; name: string; address: string; point: Point }
export interface Route { durationMinutes: number; distanceKm: number; path: Point[] }
export interface Detour { direct: Route; via: Route; extraMinutes: number; extraKm: number }

type AMapResponse = Record<string, unknown>

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('高德返回了无效数据')
  return value as Record<string, unknown>
}

function list(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function label(value: unknown): string { return typeof value === 'string' ? value : '' }

/** Parse a GCJ-02 coordinate supplied by AMap or a tool caller. */
export function parsePoint(value: string): Point {
  const parts = value.split(',')
  if (parts.length !== 2 || parts.some(part => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(part.trim()))) {
    throw new Error('坐标须为“经度,纬度”')
  }
  const lng = Number(parts[0])
  const lat = Number(parts[1])
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    throw new Error('经纬度超出有效范围')
  }
  return { lng, lat }
}

export function pointText(point: Point): string { return `${point.lng},${point.lat}` }

function parsePlace(raw: unknown): Place | undefined {
  const row = record(raw)
  if (typeof row.location !== 'string' || typeof row.name !== 'string') return undefined
  return {
    id: label(row.id), name: row.name, address: label(row.address), point: parsePoint(row.location),
  }
}

function parseRoute(raw: unknown): Route {
  const route = record(record(raw).route)
  const path = record(list(route.paths)[0])
  const duration = Number(path.duration)
  const distance = Number(path.distance)
  if (!Number.isFinite(duration) || !Number.isFinite(distance)) throw new Error('高德路线缺少时长或距离')
  const points: Point[] = []
  for (const step of list(path.steps)) {
    const polyline = record(step).polyline
    if (typeof polyline !== 'string') continue
    for (const value of polyline.split(';')) {
      if (points.length >= 3000) break
      points.push(parsePoint(value))
    }
  }
  return { durationMinutes: Math.round(duration / 60), distanceKm: Math.round(distance / 100) / 10, path: points }
}

/** Make AMap Web Service requests with explicit key ownership and error reporting. */
export class AMapService {
  constructor(private readonly key: string, private readonly request: typeof fetch = fetch) {
    if (!key) throw new Error('需要配置 AMAP_WEB_KEY')
  }

  private async get(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<AMapResponse> {
    const url = new URL(`https://restapi.amap.com/v3/${path}`)
    url.searchParams.set('key', this.key)
    url.searchParams.set('output', 'JSON')
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
    const response = await this.request(url, signal ? { signal } : {})
    if (!response.ok) throw new Error(`高德请求失败：HTTP ${response.status}`)
    const data = record(await response.json())
    if (data.status !== '1') throw new Error(`高德请求失败：${label(data.info) || '未知错误'}（${label(data.infocode)}）`)
    return data
  }

  /** Search named places without committing to navigation. */
  async search(keywords: string, city?: string, signal?: AbortSignal): Promise<Place[]> {
    if (!keywords.trim()) throw new Error('请输入地点关键词')
    const data = await this.get('place/text', { keywords, ...(city ? { city } : {}), offset: '15', page: '1' }, signal)
    return list(data.pois).map(parsePlace).filter((place): place is Place => place !== undefined)
  }

  /** Search places around a GCJ-02 point within a metre radius. */
  async nearby(center: Point, radiusMeters: number, keywords?: string, signal?: AbortSignal): Promise<Place[]> {
    if (!Number.isInteger(radiusMeters) || radiusMeters < 1 || radiusMeters > 50000) {
      throw new Error('搜索半径须为 1 至 50000 米')
    }
    const data = await this.get('place/around', {
      location: pointText(center), radius: String(radiusMeters),
      ...(keywords ? { keywords } : {}), offset: '15', page: '1',
    }, signal)
    return list(data.pois).map(parsePlace).filter((place): place is Place => place !== undefined)
  }

  /** Resolve a written address to candidate GCJ-02 points. */
  async geocode(address: string, city?: string, signal?: AbortSignal): Promise<Place[]> {
    if (!address.trim()) throw new Error('请输入地址')
    const data = await this.get('geocode/geo', { address, ...(city ? { city } : {}) }, signal)
    return list(data.geocodes).map((item, index) => {
      const row = record(item)
      if (typeof row.location !== 'string') return undefined
      return { id: `geocode-${index}`, name: label(row.formatted_address) || address,
        address: label(row.formatted_address), point: parsePoint(row.location) }
    }).filter((place): place is Place => place !== undefined)
  }

  /** Resolve coordinates to an address, preserving the original coordinate. */
  async reverse(point: Point, signal?: AbortSignal): Promise<{ point: Point; address: string }> {
    const data = await this.get('geocode/regeo', { location: pointText(point), extensions: 'base' }, signal)
    return { point, address: label(record(data.regeocode).formatted_address) }
  }

  /** Calculate a driving route, optionally passing through one chosen candidate. */
  async drive(origin: Point, destination: Point, via?: Point, signal?: AbortSignal): Promise<Route> {
    const data = await this.get('direction/driving', {
      origin: pointText(origin), destination: pointText(destination), strategy: '0',
      ...(via ? { waypoints: pointText(via) } : {}),
    }, signal)
    return parseRoute(data)
  }

  /** Compare a candidate against the direct route, not against a straight line. */
  async detour(origin: Point, destination: Point, via: Point, signal?: AbortSignal): Promise<Detour> {
    const [direct, through] = await Promise.all([
      this.drive(origin, destination, undefined, signal),
      this.drive(origin, destination, via, signal),
    ])
    return {
      direct, via: through,
      extraMinutes: Math.max(0, through.durationMinutes - direct.durationMinutes),
      extraKm: Math.max(0, Math.round((through.distanceKm - direct.distanceKm) * 10) / 10),
    }
  }
}
