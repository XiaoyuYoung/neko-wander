/** AMap-backed business operations. This module has no Harness dependency. */
export interface Point { lng: number; lat: number }
export interface Place { id: string; name: string; address: string; point: Point }
/** A suggested exploration radius, not an administrative or property boundary. */
export interface MapArea { name: string; center: Point; radiusMeters: number }
/** Travel modes supported by the route tools. */
export type TravelMode = 'driving' | 'walking' | 'cycling' | 'transit' | 'ebike'
/** One continuous walking or public-transport line, drawn without connecting unrelated segments. */
export interface RouteSection { mode: 'walking' | 'transit'; path: Point[] }
/** Passenger instructions for one bus or metro leg. */
export interface TransitLeg { line: string; boardingStop: string; alightingStop: string; stops?: number }
/** Summary of the selected public-transport proposal; fares are estimates when supplied. */
export interface TransitInfo { walkingMeters: number; fareYuan?: number; transfers: number; legs: TransitLeg[] }
export interface Route { mode: TravelMode; origin: Point; destination: Point; via?: Point; durationMinutes: number; distanceKm: number; path: Point[]; sections?: RouteSection[]; transit?: TransitInfo }
export interface Detour { direct: Route; via: Route; extraMinutes: number; extraKm: number }
interface RouteData { durationSeconds: number; distanceMeters: number; path: Point[]; sections?: RouteSection[]; transit?: TransitInfo }

type AMapResponse = Record<string, unknown>

/** Sending interval and bounded QPS recovery, shared by all calls on one service instance. */
export interface AMapRequestPolicy { requestIntervalMs: number; qpsRetries: number; qpsRetryDelayMs: number }

/** Provider failures retain their code so retry handling never parses display text. */
export class AMapApiError extends Error {
  constructor(readonly code: string, readonly info: string) {
    super(code === '10021'
      ? `高德请求频率超限：${info}（10021）。请稍后重试，并检查同一账号下其他应用的调用频率。`
      : `高德请求失败：${info}（${code}），请检查 Web 服务 Key 的权限和配额后重试`)
    this.name = 'AMapApiError'
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { reject(signal.reason) }
    if (signal.aborted) { reject(signal.reason); return }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (milliseconds <= 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await abortable(new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds) }), signal) }
  finally { clearTimeout(timer) }
}

function record(value: unknown, field?: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(field ? `高德返回数据格式异常：${field} 应为对象，请重新查询` : '高德返回了无效数据')
  }
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

function parseRoute(raw: unknown, version: 'v3' | 'v4' | 'v5'): RouteData {
  const routeField = version === 'v4' ? 'data' : 'route'
  const route = record(record(raw, '响应')[routeField], routeField)
  if (!Array.isArray(route.paths)) throw new Error(`高德返回数据格式异常：${routeField}.paths 应为路线数组，请重新查询`)
  const paths = route.paths
  if (!paths.length) throw new Error('未找到可用路线，请调整起终点后重试')
  const pathField = `${routeField}.paths[0]`
  const path = record(paths[0], pathField)
  const rawDuration = version === 'v5' ? record(path.cost, `${pathField}.cost`).duration : path.duration
  const duration = Number(rawDuration)
  const distance = Number(path.distance)
  if ((typeof rawDuration !== 'string' && typeof rawDuration !== 'number') || rawDuration === '' ||
      (typeof path.distance !== 'string' && typeof path.distance !== 'number') || path.distance === '' ||
      !Number.isFinite(duration) || !Number.isFinite(distance) || duration < 0 || distance < 0) {
    throw new Error('高德路线缺少有效时长或距离，请重新查询')
  }
  const points: Point[] = []
  for (const step of list(path.steps)) {
    const polyline = record(step, `${pathField}.steps[]`).polyline
    if (typeof polyline !== 'string') continue
    for (const value of polyline.split(';')) {
      if (points.length >= 3000) break
      points.push(parsePoint(value))
    }
  }
  if (!points.length) throw new Error('高德路线缺少轨迹，无法绘制，请重新查询')
  return { durationSeconds: duration, distanceMeters: distance, path: points }
}

function nonNegative(value: unknown): number {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '' ||
      !Number.isFinite(Number(value)) || Number(value) < 0) throw new Error('高德公交路线缺少有效时长、距离或费用，请重新查询')
  return Number(value)
}

function transitPath(value: unknown): Point[] {
  if (typeof value !== 'string' || !value) throw new Error('高德公交路线缺少分段轨迹，请重新查询')
  const points = value.split(';').map(parsePoint)
  if (points.length < 2) throw new Error('高德公交路线轨迹不完整，请重新查询')
  return points
}

/** Empty transport placeholders can contain nested objects, arrays and zero-valued measures. */
function hasTransportContent(value: unknown): boolean {
  if (value == null) return false
  if (Array.isArray(value)) return value.some(hasTransportContent)
  if (typeof value === 'object') return Object.values(record(value)).some(hasTransportContent)
  if (typeof value === 'string') {
    const text = value.trim()
    return text !== '' && !/^[+-]?0+(?:\.0+)?$/.test(text)
  }
  if (typeof value === 'number') return value !== 0
  return value === true
}

function parseTransit(data: AMapResponse): RouteData {
  const proposals = list(record(data.route).transits)
  if (!proposals.length) throw new Error('未找到可用公交方案，请调整起终点或出行时间')
  const selected = proposals.find(value => !list(record(value).segments).some(raw => {
    const segment = record(raw)
    return hasTransportContent(segment.railway) || hasTransportContent(segment.taxi)
  }))
  if (!selected) throw new Error('高德返回的备选方案均包含暂未支持的火车或出租车接驳，请在高德查看完整方案或调整起终点后重试')
  const proposal = record(selected)
  const sections: RouteSection[] = [], legs: TransitLeg[] = []
  for (const raw of list(proposal.segments)) {
    const segment = record(raw)
    if (segment.walking && !Array.isArray(segment.walking)) {
      const walking = record(segment.walking), steps = list(walking.steps)
      if (walking.distance !== undefined && nonNegative(walking.distance) > 0 && !steps.length) {
        throw new Error('高德公交路线缺少步行接驳轨迹，请重新查询')
      }
      for (const step of steps) sections.push({ mode: 'walking', path: transitPath(record(step).polyline) })
    }
    if (segment.bus && !Array.isArray(segment.bus)) {
      const lines = list(record(segment.bus).buslines)
      if (lines.length) {
        const line = record(lines[0])
        const boardingStop = label(record(line.departure_stop).name), alightingStop = label(record(line.arrival_stop).name)
        if (!label(line.name) || !boardingStop || !alightingStop) throw new Error('高德公交路线缺少线路或上下车站，请重新查询')
        const stops = line.via_num === undefined ? undefined : nonNegative(line.via_num)
        if (stops !== undefined && !Number.isInteger(stops)) throw new Error('高德公交站数无效，请重新查询')
        legs.push({ line: label(line.name), boardingStop, alightingStop, ...(stops === undefined ? {} : { stops }) })
        sections.push({ mode: 'transit', path: transitPath(line.polyline) })
      }
    }
  }
  if (!legs.length) throw new Error('未找到可乘坐的公交或地铁线路，请改用步行规划或调整起终点')
  const walkingMeters = nonNegative(proposal.walking_distance)
  if (walkingMeters > 0 && !sections.some(section => section.mode === 'walking')) throw new Error('高德公交路线缺少步行接驳轨迹，请重新查询')
  const fare = proposal.cost
  return { durationSeconds: nonNegative(proposal.duration), distanceMeters: nonNegative(proposal.distance),
    path: sections.flatMap(section => section.path), sections,
    transit: { walkingMeters, transfers: legs.length - 1, legs,
      ...(fare === undefined || fare === '' || Array.isArray(fare) ? {} : { fareYuan: nonNegative(fare) }) } }
}

function routeSummary(mode: TravelMode, data: RouteData, origin: Point, destination: Point, via?: Point): Route {
  return { mode, origin, destination, ...(via ? { via } : {}), durationMinutes: Math.round(data.durationSeconds / 60),
    distanceKm: Math.round(data.distanceMeters / 100) / 10, path: data.path,
    ...(data.sections ? { sections: data.sections } : {}), ...(data.transit ? { transit: data.transit } : {}) }
}

/** Make AMap Web Service requests with explicit key ownership and error reporting. */
export class AMapService {
  private pending: Promise<void> = Promise.resolve()
  private nextRequestAt = 0
  private readonly lifetime = new AbortController()

  constructor(private readonly key: string, private readonly request: typeof fetch = fetch,
    private readonly policy: AMapRequestPolicy = { requestIntervalMs: 500, qpsRetries: 2, qpsRetryDelayMs: 1200 }) {
    if (!key) throw new Error('需要配置 AMAP_WEB_KEY')
  }

  /** Cancel queued requests, cooldown waits and active fetches when the plugin is unloaded. */
  dispose(): void { this.lifetime.abort(new Error('地图插件已关闭，请重新打开后重试')) }

  private async complete<T>(caller: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const operation = new AbortController()
    const signal = caller ? AbortSignal.any([caller, operation.signal]) : operation.signal
    try { return await run(signal) }
    catch (error) { operation.abort(error); throw error }
  }

  private async enqueue<T>(work: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> {
    const signal = caller ? AbortSignal.any([caller, this.lifetime.signal]) : this.lifetime.signal
    signal.throwIfAborted()
    const job = this.pending.then(async () => {
      signal.throwIfAborted()
      await delay(this.nextRequestAt - Date.now(), signal)
      signal.throwIfAborted()
      this.nextRequestAt = Date.now() + this.policy.requestIntervalMs
      return abortable(work(signal), signal)
    })
    // Each caller receives its own failure; a rejected request must not block subsequent calls.
    this.pending = job.then(() => undefined, () => undefined)
    return abortable(job, signal)
  }

  private async get(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<AMapResponse> {
    const url = new URL(path, 'https://restapi.amap.com')
    url.searchParams.set('key', this.key)
    url.searchParams.set('output', 'JSON')
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.enqueue(async requestSignal => {
          const response = await this.request(url, { signal: requestSignal })
          if (!response.ok) throw new Error(`高德请求失败：HTTP ${response.status}`)
          const data = record(await response.json(), '响应')
          // AMap v4 cycling uses errcode/data instead of the v3/v5 status/route fields.
          const cyclingV4 = path === '/v4/direction/bicycling'
          const success = cyclingV4 ? data.errcode === 0 || data.errcode === '0' : data.status === '1'
          if (!success) {
            const info = cyclingV4 ? label(data.errdetail) || label(data.errmsg) || label(data.info) : label(data.info)
            const rawCode = cyclingV4 ? data.errcode ?? data.infocode : data.infocode
            const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : '未提供错误码'
            if (code === '10021') this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + this.policy.qpsRetryDelayMs * (attempt + 1))
            throw new AMapApiError(code, info || '未知错误')
          }
          return data
        }, signal)
      } catch (error) {
        if (!(error instanceof AMapApiError) || error.code !== '10021' || attempt >= this.policy.qpsRetries) throw error
      }
    }
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

  /** Plan travel in an explicit mode. Walking and riding waypoints combine two independently planned legs; transit requires a direct origin and destination.
   * @param mode Requested travel mode; no mode is inferred from coordinates.
   * @param origin GCJ-02 start point.
   * @param destination GCJ-02 endpoint.
   * @param via Optional waypoint, visited between the start and endpoint.
   * @param signal Cancels all provider requests belonging to this plan.
   * @returns A complete route with mode, rounded totals and map geometry.
   * @throws If any leg fails; callers must retain their previous map state.
   */
  async plan(mode: TravelMode, origin: Point, destination: Point, via?: Point, signal?: AbortSignal): Promise<Route> {
    return this.complete(signal, async operationSignal =>
      routeSummary(mode, await this.routeData(mode, origin, destination, via, operationSignal), origin, destination, via))
  }

  private async routeData(mode: TravelMode, origin: Point, destination: Point, via?: Point, signal?: AbortSignal): Promise<RouteData> {
    if (mode === 'transit') {
      if (via) throw new Error('公交暂不支持途经点，请分别规划到途经点和终点的公交路线')
      const [city, cityd] = await Promise.all([this.cityCode(origin, signal), this.cityCode(destination, signal)])
      return parseTransit(await this.get('/v3/direction/transit/integrated', {
        origin: pointText(origin), destination: pointText(destination), city, cityd, extensions: 'all', strategy: '0',
      }, signal))
    }
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
    if (mode === 'cycling') {
      const data = await this.get('/v4/direction/bicycling', {
        origin: pointText(origin), destination: pointText(destination),
      }, signal)
      return parseRoute(data, 'v4')
    }
    const endpoint = { walking: 'walking', ebike: 'electrobike' }[mode]
    const data = await this.get(`/v5/direction/${endpoint}`, {
      origin: pointText(origin), destination: pointText(destination), show_fields: 'cost,polyline',
    }, signal)
    return parseRoute(data, 'v5')
  }

  private async cityCode(point: Point, signal?: AbortSignal): Promise<string> {
    const data = await this.get('/v3/geocode/regeo', { location: pointText(point), extensions: 'base' }, signal)
    const code = label(record(record(data.regeocode).addressComponent).citycode)
    if (!/^\d{2,4}$/.test(code)) throw new Error('无法确定公交起终点所在城市，请换用具体地址后重试')
    return code
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
    if (mode === 'transit') throw new Error('公交暂不支持途经点绕行比较，请分别查询各段公交路线')
    return this.complete(signal, async operationSignal => {
      const [direct, through] = await Promise.all([
        this.routeData(mode, origin, destination, undefined, operationSignal),
        this.routeData(mode, origin, destination, via, operationSignal),
      ])
      return {
        direct: routeSummary(mode, direct, origin, destination), via: routeSummary(mode, through, origin, destination, via),
        extraMinutes: Math.max(0, Math.round((through.durationSeconds - direct.durationSeconds) / 60)),
        extraKm: Math.max(0, Math.round((through.distanceMeters - direct.distanceMeters) / 100) / 10),
      }
    })
  }
}
