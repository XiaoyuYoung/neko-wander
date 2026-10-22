/** Harness adapter for the independent AMap business service and map panel. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import { AMapService, parsePoint, parseArea, parsePlaceMarker, type MapArea, type Place, type Route, type Detour, type TravelMode } from './map-service.ts'
import { CurrentLocations, parseLocationReport } from './current-location.ts'

export const name = 'neko-wander'
export const inject = ['tools', 'webServer', 'connection']

export interface Config { webServiceKey: string; jsApiKey: string; jsSecurityCode: string; locationTimeoutMs: number; currentLocationMaxAgeMs: number; locationRequestTimeoutMs: number; searchRadiusMeters: number; requestIntervalMs: number; qpsRetries: number; qpsRetryDelayMs: number }
export const Config: Schema<Config> = Schema.object({
  webServiceKey: Schema.string().required(),
  jsApiKey: Schema.string().required(),
  jsSecurityCode: Schema.string().required(),
  locationTimeoutMs: Schema.number().min(1000).max(60000).default(10000),
  currentLocationMaxAgeMs: Schema.natural().min(1000).max(600000).default(60000),
  locationRequestTimeoutMs: Schema.natural().min(1000).max(120000).default(20000),
  searchRadiusMeters: Schema.natural().min(1).max(50000).default(3000),
  requestIntervalMs: Schema.natural().min(50).max(60000).default(500),
  qpsRetries: Schema.natural().max(3).default(2),
  qpsRetryDelayMs: Schema.natural().min(1000).max(60000).default(1200),
})

interface ViewState {
  revision: number
  locationRequestId: number
  places: Place[]
  area: MapArea | undefined
  route: Route | undefined
  detour: { mode: TravelMode; point: { lng: number; lat: number }; extraMinutes: number; extraKm: number } | undefined
}

/** Register search, coordinate and route tools and the local map-state read route. */
export function apply(ctx: Context, config: Config): void {
  const amap = new AMapService(config.webServiceKey, fetch, {
    requestIntervalMs: config.requestIntervalMs, qpsRetries: config.qpsRetries, qpsRetryDelayMs: config.qpsRetryDelayMs,
  })
  ctx.effect(() => () => amap.dispose(), 'neko-wander: AMap requests')
  const bySession = new Map<string, ViewState>()
  const stateOf = (sessionId: string): ViewState => bySession.get(sessionId) ?? { revision: 0, locationRequestId: 0, places: [], area: undefined, route: undefined, detour: undefined }
  const publish = (sessionId: string, change: Partial<ViewState>): void => {
    const before = stateOf(sessionId)
    bySession.set(sessionId, { ...before, ...change, revision: before.revision + 1 })
  }
  const updatePlaces = (sessionId: string, places: Place[]): boolean => {
    const routePreserved = stateOf(sessionId).route !== undefined
    publish(sessionId, { places, area: undefined, detour: undefined })
    return routePreserved
  }
  const sessionOf = (exec: ToolRunContext): string => {
    if (!exec.agent) throw new Error('溜达喵地图工具需要在对话中使用')
    return exec.agent.id
  }
  const show = (value: object): string => JSON.stringify(value)
  const output = { schema: { type: 'string' } as const, render: (_args: object, value: string) => [{ type: 'text' as const, text: value }] }
  const locations = new CurrentLocations(config.currentLocationMaxAgeMs, config.locationRequestTimeoutMs,
    (sessionId, locationRequestId) => { publish(sessionId, { locationRequestId }) })
  ctx.effect(() => () => locations.dispose(), 'neko-wander: current locations')
  const originOf = async (origin: string | undefined, exec: ToolRunContext) => origin === undefined
    ? await locations.resolve(sessionOf(exec), exec.signal) : parsePoint(origin)

  ctx.tools.register(defineTool({
    name: 'neko_search_places',
    description: 'Search AMap for places, displayed as pins while keeping the existing route and navigation link. Without an explicit city or search center, search near the user\'s current location automatically; never ask for an origin unless location fails. Use city for an explicitly requested city-wide or named-address search. Return candidates before planning a route. Specific shops and addresses are points, not exploration circles. Use neko_show_place to mark an already resolved point; use neko_show_area only for a vague region or a requested surrounding radius. Search does not add places to the route: only replan when the user chooses a stop. Use neko_clear_route only when asked to remove the route.',
    parameters: {
      keywords: { type: 'string', required: true, description: 'Place, scenery or amenity keyword' },
      city: { type: 'string', description: 'Optional city to narrow the search' },
      center: { type: 'string', description: 'Optional explicit GCJ-02 search center; otherwise uses current location when city is omitted' },
      radiusMeters: { type: 'integer', description: 'Nearby radius, 1–50000 metres; defaults to the configured search radius' },
    }, output,
    async execute(args, exec) {
      const center = args.city && args.center === undefined ? undefined : await originOf(args.center, exec)
      const places = center ? await amap.nearby(center, args.radiusMeters ?? config.searchRadiusMeters, args.keywords, exec.signal)
        : await amap.search(args.keywords, args.city, exec.signal)
      const routePreserved = updatePlaces(sessionOf(exec), places)
      return show({ places, ...(center ? { center } : {}), routePreserved })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'neko_geocode',
    description: 'Find GCJ-02 coordinates for a written address and show candidates as pins, keeping the existing route. A specific address, shop or landmark uses a pin, including questions like "那个店在哪里". If coordinates and address are already known, use neko_show_place. Only for a vague region such as "长风街一带", or an explicitly requested radius around an address, use neko_show_area after resolving its center. Search does not add the address to the route; replan only when the user chooses a stop.',
    parameters: {
      address: { type: 'string', required: true, description: 'Written address or landmark' },
      city: { type: 'string', description: 'Optional city' },
    }, output,
    async execute(args, exec) {
      const places = await amap.geocode(args.address, args.city, exec.signal)
      const routePreserved = updatePlaces(sessionOf(exec), places)
      return show({ places, routePreserved })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'neko_search_nearby',
    description: 'Search nearby places within a radius, keeping the existing route and navigation link. Omit center to use the user\'s current location automatically; never invent a coordinate or ask for an origin unless location fails. Return candidates without adding them to the route; replan only after the user chooses a stop.',
    parameters: {
      center: { type: 'string', description: 'Optional center longitude,latitude in GCJ-02; omitted means current location' },
      radiusMeters: { type: 'number', required: true, description: 'Search radius in metres, 1–50000' },
      keywords: { type: 'string', description: 'Optional place or scenery keyword' },
    }, output,
    async execute(args, exec) {
      const center = await originOf(args.center, exec)
      const places = await amap.nearby(center, args.radiusMeters, args.keywords, exec.signal)
      const routePreserved = updatePlaces(sessionOf(exec), places)
      return show({ places, center, routePreserved })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'neko_show_place',
    description: 'Mark a specific address, shop, entrance or landmark with a pin. Use for "那个店在哪里" or a known point along an existing route. Use coordinates and address already verified by search or geocoding; never invent them. Do not substitute a radius circle for a specific point. Adds or updates the pin, moves its address to the front, clears the previous exploration circle, and keeps other places and the existing route. Does not plan navigation. For vague regions such as "长风街一带" or an explicitly requested surrounding radius, use neko_show_area instead.',
    parameters: {
      name: { type: 'string', required: true, description: 'Specific place name, 1–120 characters' },
      location: { type: 'string', required: true, description: 'Verified point longitude,latitude in GCJ-02' },
      address: { type: 'string', required: true, description: 'Verified specific address, 1–500 characters' },
    }, output,
    async execute(args, exec) {
      const place = parsePlaceMarker(args.name, args.location, args.address)
      const sessionId = sessionOf(exec)
      const before = stateOf(sessionId)
      const matches = (candidate: Place): boolean => candidate.name === place.name &&
        candidate.point.lng === place.point.lng && candidate.point.lat === place.point.lat
      const existing = before.places.find(matches)
      if (existing) place.id = existing.id
      publish(sessionId, { places: [place, ...before.places.filter(candidate => !matches(candidate))], area: undefined })
      return show({ place, marker: 'pin' })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'neko_show_area',
    description: 'Mark a vague region, e.g. "长风街一带" or "这片区域", with a translucent circle. Also use for an explicitly requested surrounding radius, e.g. "店周边500米". A specific shop, address, entrance or landmark is a point: use neko_show_place, NEVER a circle merely to answer "那个店在哪里", even when it is described as nearby or along the route. Resolve the center with AMap search or geocoding first; never invent coordinates. Choose the radius from the user request or explain your estimate. This is an approximate exploration radius, not a verified boundary. Replaces the previous circle, keeps places and routes, and does not generate navigation. Call again to expand or shrink the area.',
    parameters: {
      name: { type: 'string', required: true, description: 'Region name, 1–120 characters, e.g. 长风街一带; not a specific shop or address' },
      center: { type: 'string', required: true, description: 'Resolved center longitude,latitude in GCJ-02' },
      radiusMeters: { type: 'integer', required: true, description: 'Approximate exploration radius in metres, 1–50000; explain an estimated radius in the reply' },
    }, output,
    async execute(args, exec) {
      const area = parseArea(args.name, args.center, args.radiusMeters)
      publish(sessionOf(exec), { area })
      return show({ area, approximate: true })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'neko_clear_area',
    description: 'Remove the highlighted exploration circle while keeping places and routes.',
    parameters: {}, output,
    async execute(_args, exec) {
      publish(sessionOf(exec), { area: undefined })
      return show({ cleared: true })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'neko_clear_route',
    description: 'Remove the displayed route, navigation link and detour comparison only when the user asks to clear the route. Keep place pins and exploration circles. Do not clear a route just to search for shops or other stops along it.',
    parameters: {}, output,
    async execute(_args, exec) {
      publish(sessionOf(exec), { route: undefined, detour: undefined })
      return show({ routeCleared: true })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'neko_reverse_geocode',
    description: 'Look up the address at a GCJ-02 longitude,latitude coordinate.',
    parameters: { location: { type: 'string', required: true, description: 'Longitude,latitude in GCJ-02' } }, output,
    async execute(args, exec) {
      const result = await amap.reverse(parsePoint(args.location), exec.signal)
      return show(result)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'neko_compare_detour',
    description: 'Compare travel time and distance via one candidate against the direct route using the same travel mode. Set mode to match the user: driving, walking, cycling (bicycle), or ebike (electric bicycle). Ask if their mode is unclear. Omitted mode retains legacy driving behavior. This does not start navigation or draw a chosen route.',
    parameters: {
      origin: { type: 'string', description: 'Start longitude,latitude (GCJ-02); omitted means current location, do not invent an origin' },
      destination: { type: 'string', required: true, description: 'End longitude,latitude (GCJ-02)' },
      via: { type: 'string', required: true, description: 'Candidate longitude,latitude (GCJ-02)' },
      mode: { type: 'string', enum: ['driving', 'walking', 'cycling', 'ebike'] as const, description: 'Travel mode; omitted means driving for existing calls' },
    }, output,
    async execute(args, exec) {
      const point = parsePoint(args.via)
      const destination = parsePoint(args.destination)
      const mode = args.mode ?? 'driving'
      const origin = await originOf(args.origin, exec)
      const result: Detour = await amap.compareDetour(mode, origin, destination, point, exec.signal)
      publish(sessionOf(exec), { detour: { mode, point, extraMinutes: result.extraMinutes, extraKm: result.extraKm } })
      return show({ mode, origin, directMinutes: result.direct.durationMinutes, viaMinutes: result.via.durationMinutes,
        extraMinutes: result.extraMinutes, extraKm: result.extraKm })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'neko_plan_route',
    description: 'Calculate and display a route in the user\'s chosen travel mode: driving, walking, cycling (bicycle), transit (bus and metro with walking connections), or ebike (electric bicycle). Omit origin when the user did not specify one: use their current location automatically, asking for a starting address only if location fails. Ask for the mode if unclear; do not assume driving. Only plan after the user asks for a route or chooses a candidate. Transit selects the first provider proposal without actual train or taxi legs; empty transport placeholders do not indicate a transfer. It returns lines, boarding/alighting stops, estimated transfers, walking distance and fare when available; explain these to the user. If no supported proposal remains, report the tool limitation; do not claim there are no buses or infer train/taxi travel from the user request. Cities are resolved automatically. Transit does not support via: plan separate journeys if a stopover is requested, and do not treat independently estimated times as a guaranteed connection. Walking and riding waypoints combine two legs. Provider failure never falls back to another travel mode.',
    parameters: {
      mode: { type: 'string', enum: ['driving', 'walking', 'cycling', 'transit', 'ebike'] as const, required: true, description: 'The user\'s travel mode; transit means public bus or metro' },
      origin: { type: 'string', description: 'Start longitude,latitude (GCJ-02); omitted means current location, ask only if location fails' },
      destination: { type: 'string', required: true, description: 'End longitude,latitude (GCJ-02)' },
      via: { type: 'string', description: 'Optional selected waypoint longitude,latitude (GCJ-02); not supported for transit' },
    }, output,
    async execute(args, exec) {
      const destination = parsePoint(args.destination), via = args.via ? parsePoint(args.via) : undefined
      const route = await amap.plan(args.mode, await originOf(args.origin, exec), destination, via, exec.signal)
      publish(sessionOf(exec), { route, detour: undefined })
      return show({ mode: route.mode, origin: route.origin, durationMinutes: route.durationMinutes, distanceKm: route.distanceKm,
        ...(route.transit ? { transit: route.transit } : {}) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'neko_drive_route',
    description: 'Calculate and display an explicitly requested driving route. For walking, cycling, transit, ebike, or choosing a travel mode, use neko_plan_route. Only plan after the user asks for a route or chooses a candidate.',
    parameters: {
      origin: { type: 'string', description: 'Start longitude,latitude (GCJ-02); omitted means current location, ask only if location fails' },
      destination: { type: 'string', required: true, description: 'End longitude,latitude (GCJ-02)' },
      via: { type: 'string', description: 'Optional selected waypoint longitude,latitude (GCJ-02)' },
    }, output,
    async execute(args, exec) {
      const destination = parsePoint(args.destination), via = args.via ? parsePoint(args.via) : undefined
      const route = await amap.drive(await originOf(args.origin, exec), destination, via, exec.signal)
      publish(sessionOf(exec), { route, detour: undefined })
      return show({ mode: route.mode, origin: route.origin, durationMinutes: route.durationMinutes, distanceKm: route.distanceKm })
    },
  }))

  ctx.connection.fetch.register({
    path: '/api/neko-wander/state', methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      const sessionId = new URL(request.url).searchParams.get('sessionId')
      if (!sessionId || sessionId.length > 200) return new Response('Invalid session', { status: 400 })
      return Response.json(stateOf(sessionId), { headers: { 'Cache-Control': 'no-store' } })
    },
  })
  ctx.connection.fetch.register({
    path: '/api/neko-wander/location', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      const sessionId = new URL(request.url).searchParams.get('sessionId')
      if (!sessionId || sessionId.length > 200) return new Response('Invalid session', { status: 400 })
      if (request.headers.get('content-type')?.split(';', 1)[0] !== 'application/json') return new Response('Expected JSON', { status: 415 })
      let report
      try { report = parseLocationReport(await request.json()) }
      catch (error) { return new Response(error instanceof Error ? error.message : 'Invalid report', { status: 400 }) }
      return new Response(null, { status: locations.report(sessionId, report) ? 204 : 409 })
    },
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/neko-wander/state', handler(req, res) {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
      const remote = req.socket.remoteAddress ?? ''
      if (!/^(?:127\.|::1$|::ffff:127\.)/.test(remote)) { res.writeHead(403); res.end(); return }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId || sessionId.length > 200) { res.writeHead(400); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(stateOf(sessionId)))
    },
  }), 'neko-wander: state route')
  ctx.on('webserver/index-inject', table => {
    table.push({ kind: 'global', name: '__NEKO_WANDER_AMAP__', value: {
      key: config.jsApiKey, securityCode: config.jsSecurityCode, locationTimeoutMs: config.locationTimeoutMs,
    } })
  })
}
