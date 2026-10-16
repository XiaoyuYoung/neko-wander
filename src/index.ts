/** Harness adapter for the independent AMap business service and map panel. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { AMapService, parsePoint, type Place, type Route, type Detour } from './map-service.ts'

export const name = 'neko-wander'
export const inject = ['tools', 'webServer']

export interface Config { webServiceKey: string; jsApiKey: string; jsSecurityCode: string }
export const Config: Schema<Config> = Schema.object({
  webServiceKey: Schema.string().required(),
  jsApiKey: Schema.string().required(),
  jsSecurityCode: Schema.string().required(),
})

interface ViewState {
  revision: number
  places: Place[]
  route: Route | undefined
  detour: { point: { lng: number; lat: number }; extraMinutes: number; extraKm: number } | undefined
}

/** Register search, coordinate and route tools and the local map-state read route. */
export function apply(ctx: Context, config: Config): void {
  const amap = new AMapService(config.webServiceKey)
  const bySession = new Map<string, ViewState>()
  const stateOf = (sessionId: string): ViewState => bySession.get(sessionId) ?? { revision: 0, places: [], route: undefined, detour: undefined }
  const publish = (sessionId: string, change: Partial<ViewState>): void => {
    const before = stateOf(sessionId)
    bySession.set(sessionId, { ...before, ...change, revision: before.revision + 1 })
  }
  const sessionOf = (exec: ToolRunContext): string => {
    if (!exec.agent) throw new Error('溜达喵地图工具需要在对话中使用')
    return exec.agent.id
  }
  const show = (value: object): string => JSON.stringify(value)
  const output = { schema: { type: 'string' } as const, render: (_args: object, value: string) => [{ type: 'text' as const, text: value }] }

  ctx.tools.register(defineTool({
    name: 'neko_search_places',
    description: 'Search AMap for nearby or named places. Return candidates first; do not create a navigation route until the user selects one.',
    parameters: {
      keywords: { type: 'string', required: true, description: 'Place, scenery or amenity keyword' },
      city: { type: 'string', description: 'Optional city to narrow the search' },
    }, output,
    async execute(args, exec) {
      const places = await amap.search(args.keywords, args.city, exec.signal)
      publish(sessionOf(exec), { places, route: undefined, detour: undefined })
      return show({ places })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'neko_geocode',
    description: 'Find GCJ-02 coordinates for a written address. Show candidate locations on the map.',
    parameters: {
      address: { type: 'string', required: true, description: 'Written address or landmark' },
      city: { type: 'string', description: 'Optional city' },
    }, output,
    async execute(args, exec) {
      const places = await amap.geocode(args.address, args.city, exec.signal)
      publish(sessionOf(exec), { places, route: undefined, detour: undefined })
      return show({ places })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'neko_search_nearby',
    description: 'Search places around a GCJ-02 coordinate within a radius; return candidates without making a route.',
    parameters: {
      center: { type: 'string', required: true, description: 'Center longitude,latitude in GCJ-02' },
      radiusMeters: { type: 'number', required: true, description: 'Search radius in metres, 1–50000' },
      keywords: { type: 'string', description: 'Optional place or scenery keyword' },
    }, output,
    async execute(args, exec) {
      const places = await amap.nearby(parsePoint(args.center), args.radiusMeters, args.keywords, exec.signal)
      publish(sessionOf(exec), { places, route: undefined, detour: undefined })
      return show({ places })
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
    description: 'Compare driving time and distance via one candidate against the direct route. This does not start navigation or draw a chosen route.',
    parameters: {
      origin: { type: 'string', required: true, description: 'Start longitude,latitude (GCJ-02)' },
      destination: { type: 'string', required: true, description: 'End longitude,latitude (GCJ-02)' },
      via: { type: 'string', required: true, description: 'Candidate longitude,latitude (GCJ-02)' },
    }, output,
    async execute(args, exec) {
      const point = parsePoint(args.via)
      const result: Detour = await amap.detour(parsePoint(args.origin), parsePoint(args.destination), point, exec.signal)
      publish(sessionOf(exec), { detour: { point, extraMinutes: result.extraMinutes, extraKm: result.extraKm } })
      return show({ directMinutes: result.direct.durationMinutes, viaMinutes: result.via.durationMinutes,
        extraMinutes: result.extraMinutes, extraKm: result.extraKm })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'neko_drive_route',
    description: 'Calculate and display a driving route only after the user asks for a route or chooses a candidate.',
    parameters: {
      origin: { type: 'string', required: true, description: 'Start longitude,latitude (GCJ-02)' },
      destination: { type: 'string', required: true, description: 'End longitude,latitude (GCJ-02)' },
      via: { type: 'string', description: 'Optional selected waypoint longitude,latitude (GCJ-02)' },
    }, output,
    async execute(args, exec) {
      const route = await amap.drive(parsePoint(args.origin), parsePoint(args.destination),
        args.via ? parsePoint(args.via) : undefined, exec.signal)
      publish(sessionOf(exec), { route })
      return show({ durationMinutes: route.durationMinutes, distanceKm: route.distanceKm })
    },
  }))

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
      key: config.jsApiKey, securityCode: config.jsSecurityCode,
    } })
  })
}
