/** AMap-backed business operations. This module has no Harness dependency. */
export interface Point { lng: number; lat: number }
export interface Place { id: string; name: string; address: string; point: Point }
/** A suggested exploration radius, not an administrative or property boundary. */
export interface MapArea { name: string; center: Point; radiusMeters: number }
/** Travel modes supported by the route tools. */
export type TravelMode = 'driving' | 'walking' | 'cycling' | 'ebike'
export interface Route { mode: TravelMode; origin: Point; destination: Point; via?: Point; durationMinutes: number; distanceKm: number; path: Point[] }
export interface Detour { direct: Route; via: Route; extraMinutes: number; extraKm: number }
interface RouteData { durationSeconds: number; distanceMeters: number; path: Point[] }

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

/** Format coordinates with the Web Service API's six-decimal precision limit. */
export function pointText(point: Point): string { return `${Number(point.lng.toFixed(6))},${Number(point.lat.toFixed(6))}` }

/** Parse a specific place for pin marking from previously resolved coordinates.
 * @param name Place name, 1–120 characters after trimming.
 * @param location Verified GCJ-02 longitude,latitude.
 * @param address Specific address, 1–500 characters after trimming.
 * @returns A validated place with a deterministic marker id.
 * @throws {RangeError} The name or address is empty or too long.
 * @throws {Error} The coordinate is invalid.
 */
export function parsePlaceMarker(name: string, location: string, address: string): Place {
  const title = name.trim(), detail = address.trim()
  if (!title || title.length > 120) throw new RangeError('地点名称须为 1 至 120 个字符')
  if (!detail || detail.length > 500) throw new RangeError('具体地址须为 1 至 500 个字符')
  const point = parsePoint(location)
  return { id: JSON.stringify(['point', title, point.lng, point.lat]), name: title, address: detail, point }
}

/** Parse a named GCJ-02 exploration circle; invalid inputs leave existing map state unchanged.
 * @param name Human-readable area name, 1–120 characters after trimming.
 * @param center Resolved longitude,latitude; callers must first look up an unknown address.
 * @param radiusMeters Integer radius in metres, 1–50000.
 * @returns The validated circle specification.
 * @throws {RangeError} The name or radius is out of bounds.
 * @throws {Error} The center cannot be parsed as a valid coordinate.
 */
export function parseArea(name: string, center: string, radiusMeters: number): MapArea {
  const title = name.trim()
  if (!title || title.length > 120) throw new RangeError('范围名称须为 1 至 120 个字符')
  if (!Number.isInteger(radiusMeters) || radiusMeters < 1 || radiusMeters > 50000) {
    throw new RangeError('范围半径须为 1 至 50000 米，请调整半径后重试')
  }
  return { name: title, center: parsePoint(center), radiusMeters }
}

function parsePlace(raw: unknown): Place | undefined {
  const row = record(raw)
  if (typeof row.location !== 'string' || typeof row.name !== 'string') return undefined
  return {
    id: label(row.id), name: row.name, address: label(row.address), point: parsePoint(row.location),
  }
}

function parseRoute(raw: unknown, version: 'v3' | 'v5'): RouteData {
  const route = record(record(raw).route)
  const paths = list(route.paths)
  if (!paths.length) throw new Error('未找到可用路线，请调整起终点后重试')
  const path = record(paths[0])
  const rawDuration = version === 'v5' ? record(path.cost).duration : path.duration
  const duration = Number(rawDuration)
  const distance = Number(path.distance)
  if ((typeof rawDuration !== 'string' && typeof rawDuration !== 'number') || rawDuration === '' ||
      (typeof path.distance !== 'string' && typeof path.distance !== 'number') || path.distance === '' ||
      !Number.isFinite(duration) || !Number.isFinite(distance) || duration < 0 || distance < 0) {
    throw new Error('高德路线缺少有效时长或距离，请重新查询')
  }
  const points: Point[] = []
  for (const step of list(path.steps)) {
    const polyline = record(step).polyline
    if (typeof polyline !== 'string') continue
    for (const value of polyline.split(';')) {
      if (points.length >= 3000) break
      points.push(parsePoint(value))
    }
  }
  if (!points.length) throw new Error('高德路线缺少轨迹，无法绘制，请重新查询')
  return { durationSeconds: duration, distanceMeters: distance, path: points }
}

function routeSummary(mode: TravelMode, data: RouteData, origin: Point, destination: Point, via?: Point): Route {
  return { mode, origin, destination, ...(via ? { via } : {}), durationMinutes: Math.round(data.durationSeconds / 60),
    distanceKm: Math.round(data.distanceMeters / 100) / 10, path: data.path }
}

/** Make AMap Web Service requests with explicit key ownership and error reporting. */
export class AMapService {
  constructor(private readonly key: string, private readonly request: typeof fetch = fetch) {
    if (!key) throw new Error('需要配置 AMAP_WEB_KEY')
  }

  private async get(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<AMapResponse> {
    const url = new URL(path, 'https://restapi.amap.com')
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
    const data = await this.get('/v3/place/text', { keywords, ...(city ? { city } : {}), offset: '15', page: '1' }, signal)
    return list(data.pois).map(parsePlace).filter((place): place is Place => place !== undefined)
  }

  /** Search places around a GCJ-02 point within a metre radius. */
  async nearby(center: Point, radiusMeters: number, keywords?: string, signal?: AbortSignal): Promise<Place[]> {
    if (!Number.isInteger(radiusMeters) || radiusMeters < 1 || radiusMeters > 50000) {
      throw new Error('搜索半径须为 1 至 50000 米')
    }
    const data = await this.get('/v3/place/around', {
      location: pointText(center), radius: String(radiusMeters),
      ...(keywords ? { keywords } : {}), offset: '15', page: '1',
    }, signal)
    return list(data.pois).map(parsePlace).filter((place): place is Place => place !== undefined)
  }

  /** Resolve a written address to candidate GCJ-02 points. */
  async geocode(address: string, city?: string, signal?: AbortSignal): Promise<Place[]> {
    if (!address.trim()) throw new Error('请输入地址')
    const data = await this.get('/v3/geocode/geo', { address, ...(city ? { city } : {}) }, signal)
    return list(data.geocodes).map((item, index) => {
      const row = record(item)
      if (typeof row.location !== 'string') return undefined
      return { id: `geocode-${index}`, name: label(row.formatted_address) || address,
        address: label(row.formatted_address), point: parsePoint(row.location) }
    }).filter((place): place is Place => place !== undefined)
  }

  /** Resolve coordinates to an address, preserving the original coordinate. */
  async reverse(point: Point, signal?: AbortSignal): Promise<{ point: Point; address: string }> {
    const data = await this.get('/v3/geocode/regeo', { location: pointText(point), extensions: 'base' }, signal)
    return { point, address: label(record(data.regeocode).formatted_address) }
  }

  /** Calculate a driving route, optionally passing through one chosen candidate. */
  async drive(origin: Point, destination: Point, via?: Point, signal?: AbortSignal): Promise<Route> {
    return this.plan('driving', origin, destination, via, signal)
  }

  /** Plan travel in an explicit mode. Non-driving waypoints combine two independently planned legs.
   * @param mode Requested travel mode; no mode is inferred from coordinates.
   * @param origin GCJ-02 start point.
   * @param destination GCJ-02 endpoint.
   * @param via Optional waypoint, visited between the start and endpoint.
   * @param signal Cancels all provider requests belonging to this plan.
   * @returns A complete route with mode, rounded totals and map geometry.
   * @throws If any leg fails; callers must retain their previous map state.
   */
  async plan(mode: TravelMode, origin: Point, destination: Point, via?: Point, signal?: AbortSignal): Promise<Route> {
    return routeSummary(mode, await this.routeData(mode, origin, destination, via, signal), origin, destination, via)
  }

  private async routeData(mode: TravelMode, origin: Point, destination: Point, via?: Point, signal?: AbortSignal): Promise<RouteData> {
    if (mode === 'driving') {
      const data = await this.get('/v3/direction/driving', {
        origin: pointText(origin), destination: pointText(destination), strategy: '0',
        ...(via ? { waypoints: pointText(via) } : {}),
      }, signal)
      return parseRoute(data, 'v3')
    }
    if (via) {
      const [first, second] = await Promise.all([
        this.routeData(mode, origin, via, undefined, signal),
        this.routeData(mode, via, destination, undefined, signal),
      ])
      return { durationSeconds: first.durationSeconds + second.durationSeconds,
        distanceMeters: first.distanceMeters + second.distanceMeters, path: [...first.path, ...second.path] }
    }
    const endpoint = { walking: 'walking', cycling: 'bicycling', ebike: 'electrobike' }[mode]
    const data = await this.get(`/v5/direction/${endpoint}`, {
      origin: pointText(origin), destination: pointText(destination), show_fields: 'cost,polyline',
    }, signal)
    return parseRoute(data, 'v5')
  }

  /** Compare a candidate against the direct route, not against a straight line. */
  async detour(origin: Point, destination: Point, via: Point, signal?: AbortSignal): Promise<Detour> {
    return this.compareDetour('driving', origin, destination, via, signal)
  }

  /** Compare direct travel and travel via a candidate using the same explicit mode.
   * @param mode Travel mode for both plans.
   * @param origin GCJ-02 start point.
   * @param destination GCJ-02 endpoint.
   * @param via Candidate to visit on the alternative plan.
   * @param signal Cancels provider requests for both plans.
   * @returns Plans and their time and distance difference, rounded after comparison.
   * @throws If either complete plan cannot be calculated; no partial comparison is returned.
   */
  async compareDetour(mode: TravelMode, origin: Point, destination: Point, via: Point, signal?: AbortSignal): Promise<Detour> {
    const [direct, through] = await Promise.all([
      this.routeData(mode, origin, destination, undefined, signal),
      this.routeData(mode, origin, destination, via, signal),
    ])
    return {
      direct: routeSummary(mode, direct, origin, destination), via: routeSummary(mode, through, origin, destination, via),
      extraMinutes: Math.max(0, Math.round((through.durationSeconds - direct.durationSeconds) / 60)),
      extraKm: Math.max(0, Math.round((through.distanceMeters - direct.distanceMeters) / 100) / 10),
    }
  }
}
