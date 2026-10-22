/** Real Loader, AgentLoop and HTTP state route; only AMap and model responses are scripted. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { transitResponse } from './transit-response.ts'

let context: Context | undefined
let root: string | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  vi.unstubAllGlobals()
  if (root && dirname(root) === resolve(tmpdir()) && basename(root).startsWith('neko-area-composition-')) {
    await rm(root, { recursive: true, force: true })
  }
  context = undefined
  root = undefined
})

it('distinguishes exact place pins from exploration circles while retaining a planned route', async () => {
  root = await mkdtemp(join(tmpdir(), 'neko-area-composition-'))
  const configPath = join(root, 'cordis.yml')
  const plugins = [
    '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection',
    '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop',
  ]
  await writeFile(configPath, [
    '- name: "@deepseek-ai/dsh-credentials-local"', '  config:', `    dshHome: ${JSON.stringify(root)}`, '    watch: false',
    ...plugins.map(name => `- name: '${name}'`),
    '- name: "@deepseek-ai/dsh-client-connection"',
    '- name: "@deepseek-ai/dsh-host-webserver"', '  config:', '    host: 127.0.0.1', '    port: 0',
    `- name: '${new URL('../src/index.ts', import.meta.url).href}'`,
    '  config:', '    webServiceKey: fixture', '    jsApiKey: fixture', '    jsSecurityCode: fixture',
  ].join('\n') + '\n')
  const nativeFetch = fetch
  const providerCalls: URL[] = []
  let transitFails = false
  let transitUnsupported = false
  let cyclingInvalid = false
  let cyclingQps = false
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname !== 'restapi.amap.com') return nativeFetch(input, init)
    providerCalls.push(url)
    if (url.pathname === '/v3/geocode/regeo') return Response.json({ status: '1', regeocode: { addressComponent: { citycode: '0351' } } })
    if (url.pathname === '/v3/direction/transit/integrated') {
      const response = transitResponse()
      if (transitUnsupported) Object.assign(response.route.transits[0]!.segments[0]!, { railway: { trip: 'G123' } })
      return Response.json(transitFails ? { status: '0', info: 'USER_DAILY_QUERY_OVER_LIMIT', infocode: '10003' } : response)
    }
    if (url.pathname === '/v3/place/around') return new Response(JSON.stringify({ status: '1', pois: [
      { id: 'nearby', name: '附近公园', address: '公园入口', location: '112.01,38.01' },
    ] }))
    if (url.pathname === '/v4/direction/bicycling' && cyclingQps) return Response.json({ errcode: 10021, errmsg: 'CUQPS_HAS_EXCEEDED_THE_LIMIT' })
    if (url.pathname === '/v4/direction/bicycling') return Response.json(cyclingInvalid ? { errcode: 0, data: [] } : {
      errcode: 0, errmsg: 'OK', data: { paths: [{ distance: 1500, duration: 600, steps: [{ polyline: '112,38;112.01,38.01' }] }] },
    })
    if (url.pathname !== '/v3/geocode/geo') throw new Error('Unexpected AMap endpoint')
    return new Response(JSON.stringify({ status: '1', geocodes: [
      { formatted_address: '太原市坞城北街52号军旅苑', location: '112,38' },
    ] }))
  }))
  const ctx = context = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = undefined
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const origin = ctx.webServer.getOrigin()
  const login = new URL(ctx.connection.authenticatedUrl(origin))
  let cookie: string | undefined
  ctx.connection.authorizeIndex({ method: 'GET', url: login.pathname + login.search, headers: { host: login.host } }, {
    writeHead(_status, headers) { cookie = headers?.['set-cookie']?.split(';', 1)[0] }, end() {},
  })
  if (!cookie) throw new Error('Missing test browser cookie')
  const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }
  const reportLocation = async (sessionId: string, report: object) => fetch(`${origin}/api/neko-wander/location?sessionId=${sessionId}`, {
    method: 'POST', headers, body: JSON.stringify(report),
  })
  const areaArgs = { name: '军旅苑周边', center: '112,38', radiusMeters: 500 }
  const adapter = new MockAdapter([
    toolCallResponse('resolve-address', 'neko_geocode', { address: '坞城北街52号军旅苑', city: '太原' }),
    toolCallResponse('draw-area', 'neko_show_area', areaArgs), textResponse('已圈出军旅苑周边约500米。'),
    toolCallResponse('shrink-area', 'neko_show_area', { ...areaArgs, radiusMeters: 300 }), textResponse('已缩小到约300米。'),
    toolCallResponse('clear-area', 'neko_clear_area', {}), textResponse('已清除范围。'),
    toolCallResponse('cycle-route', 'neko_plan_route', { mode: 'cycling', destination: '112.01,38.01' }), textResponse('骑行路线已绘制。'),
    toolCallResponse('cycle-detour', 'neko_compare_detour', { mode: 'cycling', origin: '112,38', destination: '112.01,38.01', via: '112.005,38.005' }), textResponse('已比较骑行绕行时间。'),
    toolCallResponse('show-shop', 'neko_show_place', { name: '双象文具（解放路店）', location: '112.005,38.005', address: '解放路85号' }), textResponse('已用大头针标出店铺。'),
    toolCallResponse('show-region', 'neko_show_area', { name: '长风街一带', center: '112,38', radiusMeters: 800 }), textResponse('已圈出长风街一带约800米。'),
    toolCallResponse('show-shop-again', 'neko_show_place', { name: '双象文具（解放路店）', location: '112.005,38.005', address: '解放路85号' }), textResponse('已恢复店铺大头针。'),
    toolCallResponse('nearby-current', 'neko_search_places', { keywords: '公园' }), textResponse('已找到当前位置附近的公园。'),
    toolCallResponse('bus-route', 'neko_plan_route', { mode: 'transit', destination: '112.01,38.01' }), textResponse('公交及地铁换乘路线已显示。'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('area-composition'), { provider: 'mock', model: 'mock' })
  const ask = async (text: string) => {
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  const readState = async (id: string = agent.id) => {
    const response = await fetch(`${origin}/api/neko-wander/state?sessionId=${encodeURIComponent(id)}`, { headers })
    expect(response.status).toBe(200)
    return await response.json()
  }
  await ask('圈出坞城北街52号军旅苑周边约500米。')
  const before = await readState()
  expect(before).toMatchObject({ area: { name: '军旅苑周边', center: { lng: 112, lat: 38 }, radiusMeters: 500 }, places: [{ name: '太原市坞城北街52号军旅苑' }] })
  expect(providerCalls).toHaveLength(1)
  expect(await readState('other-session')).not.toHaveProperty('area')
  const event = agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.source.callId === 'draw-area')
  if (event?.type !== 'tool/result') throw new Error('Missing circle tool result')
  expect(event.data.message.content).toMatchInlineSnapshot(`
    [
      {
        "text": "{\"area\":{\"name\":\"军旅苑周边\",\"center\":{\"lng\":112,\"lat\":38},\"radiusMeters\":500},\"approximate\":true}",
        "type": "text",
      },
    ]
  `)
  const invalid = await ctx.tools.execute({ agent, signal: new AbortController().signal, callId: ToolCallId('invalid-area'),
    name: 'neko_show_area', arguments: { ...areaArgs, radiusMeters: 0 } })
  expect(invalid.isError).toBe(true)
  expect(await readState()).toEqual(before)
  await ask('范围缩小到300米。')
  expect(await readState()).toMatchObject({ area: { radiusMeters: 300 } })
  await ask('清除范围。')
  expect(await readState()).not.toHaveProperty('area')
  expect(await readState()).toHaveProperty('places', before.places)
  const redraw = await ctx.tools.execute({ agent, signal: new AbortController().signal, callId: ToolCallId('redraw-area'),
    name: 'neko_show_area', arguments: areaArgs })
  expect(redraw.isError).toBe(false)
  const search = await ctx.tools.execute({ agent, signal: new AbortController().signal, callId: ToolCallId('new-address'),
    name: 'neko_geocode', arguments: { address: '另一处地址', city: '太原' } })
  expect(search.isError).toBe(false)
  expect(await readState()).not.toHaveProperty('area')
  expect((await reportLocation(agent.id, { requestId: 0, status: 'located', point: { lng: 112, lat: 38 }, approximate: false })).status).toBe(204)
  await ask('规划去这里的骑行路线。')
  const cycleState = await readState()
  expect(cycleState).toMatchObject({ route: { mode: 'cycling', origin: { lng: 112, lat: 38 },
    destination: { lng: 112.01, lat: 38.01 }, durationMinutes: 10, distanceKm: 1.5 } })
  const routeEvent = agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.source.callId === 'cycle-route')
  if (routeEvent?.type !== 'tool/result') throw new Error('Missing cycling result')
  expect(routeEvent.data.message.content).toMatchInlineSnapshot(`
    [
      {
        "text": "{\"mode\":\"cycling\",\"origin\":{\"lng\":112,\"lat\":38},\"durationMinutes\":10,\"distanceKm\":1.5}",
        "type": "text",
      },
    ]
  `)
  const invalidMode = await ctx.tools.execute({ agent, signal: new AbortController().signal, callId: ToolCallId('invalid-mode'),
    name: 'neko_plan_route', arguments: { mode: 'flying', origin: '112,38', destination: '112.01,38.01' } })
  expect(invalidMode.isError).toBe(true)
  expect(await readState()).toEqual(cycleState)
  await ask('按骑行方式比较经过候选点多花多少时间。')
  expect(await readState()).toMatchObject({ detour: { mode: 'cycling', extraMinutes: 10, extraKm: 1.5 } })
  expect(providerCalls.filter(url => url.pathname === '/v4/direction/bicycling')).toHaveLength(4)
  expect(providerCalls.some(url => url.pathname === '/v3/direction/driving')).toBe(false)
  const withRouteAndDetour = await readState()
  const callsBeforeMarking = providerCalls.length
  await ask('途中那个买笔的店在哪里？用一个点标出来。')
  const shopState = await readState()
  expect(shopState).not.toHaveProperty('area')
  expect(shopState.places).toHaveLength(2)
  expect(shopState.places[0]).toMatchObject({ name: '双象文具（解放路店）', address: '解放路85号', point: { lng: 112.005, lat: 38.005 } })
  expect(shopState.route).toEqual(withRouteAndDetour.route)
  expect(shopState.detour).toEqual(withRouteAndDetour.detour)
  const pinEvent = agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.source.callId === 'show-shop')
  if (pinEvent?.type !== 'tool/result') throw new Error('Missing pin tool result')
  expect(pinEvent.data.message.content).toMatchInlineSnapshot(`
    [
      {
        "text": "{"place":{"id":"[\\"point\\",\\"双象文具（解放路店）\\",112.005,38.005]","name":"双象文具（解放路店）","address":"解放路85号","point":{"lng":112.005,"lat":38.005}},"marker":"pin"}",
        "type": "text",
      },
    ]
  `)
  for (const arguments_ of [
    { name: '', location: '112,38', address: '解放路85号' },
    { name: '店铺', location: '999,38', address: '解放路85号' },
    { name: '店铺', location: '112,38', address: '' },
  ]) {
    const invalidPin = await ctx.tools.execute({ agent, signal: new AbortController().signal, callId: ToolCallId('invalid-pin'),
      name: 'neko_show_place', arguments: arguments_ })
    expect(invalidPin.isError).toBe(true)
    expect(await readState()).toEqual(shopState)
  }
  await ask('把长风街一带圈出来。')
  expect(await readState()).toMatchObject({ area: { name: '长风街一带', radiusMeters: 800 }, places: shopState.places, route: shopState.route })
  await ask('还是标出刚才那家具体店铺。')
  expect(await readState()).toMatchObject({ places: shopState.places, route: shopState.route, detour: shopState.detour })
  expect(await readState()).not.toHaveProperty('area')
  expect(providerCalls).toHaveLength(callsBeforeMarking)
  await ask('找找附近的公园。')
  expect(providerCalls.at(-1)?.searchParams.get('location')).toBe('112,38')
  expect(providerCalls.at(-1)?.searchParams.get('radius')).toBe('3000')
  expect(await readState()).toMatchObject({ places: [{ name: '附近公园' }] })
  await ask('从当前位置坐公交去这里。')
  let busState = await readState()
  expect(busState).toMatchObject({ route: { mode: 'transit', origin: { lng: 112, lat: 38 }, transit: { transfers: 1, walkingMeters: 500 } } })
  const busEvent = agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.source.callId === 'bus-route')
  if (busEvent?.type !== 'tool/result') throw new Error('Missing transit tool result')
  expect(busEvent.data.message.content).toMatchInlineSnapshot(`
    [
      {
        "text": "{"mode":"transit","origin":{"lng":112,"lat":38},"durationMinutes":30,"distanceKm":5,"transit":{"walkingMeters":500,"transfers":1,"legs":[{"line":"公交1路","boardingStop":"起点站","alightingStop":"换乘站","stops":3},{"line":"地铁2号线","boardingStop":"换乘站","alightingStop":"终点站","stops":2}],"fareYuan":4}}",
        "type": "text",
      },
    ]
  `)
  for (const search of [
    { name: 'neko_search_places', arguments: { keywords: '蛋糕', center: '112,38' } },
    { name: 'neko_search_nearby', arguments: { keywords: '蛋糕', center: '112,38', radiusMeters: 500 } },
    { name: 'neko_geocode', arguments: { address: '蛋糕店', city: '太原' } },
  ]) {
    const result = await ctx.tools.execute({ agent, signal: new AbortController().signal, callId: ToolCallId(`retain-route-${search.name}`), ...search })
    expect(result.isError).toBe(false)
    expect(await readState()).toHaveProperty('route', busState.route)
    const text = result.content.find(block => block.type === 'text')
    expect(text?.type === 'text' ? JSON.parse(text.text) : null).toHaveProperty('routePreserved', true)
    if (search.name === 'neko_search_nearby') expect(result.content).toMatchInlineSnapshot(`
      [
        {
          "text": "{"places":[{"id":"nearby","name":"附近公园","address":"公园入口","point":{"lng":112.01,"lat":38.01}}],"center":{"lng":112,"lat":38},"routePreserved":true}",
          "type": "text",
        },
      ]
    `)
  }
  busState = await readState()
  const stopover = await ctx.tools.execute({ agent, signal: new AbortController().signal, callId: ToolCallId('bus-stopover'),
    name: 'neko_plan_route', arguments: { mode: 'transit', origin: '112,38', destination: '112.01,38.01', via: '112.005,38.005' } })
  expect(stopover.isError).toBe(true)
  expect(await readState()).toEqual(busState)
  transitUnsupported = true
  const unsupportedTransit = await ctx.tools.execute({ agent, signal: new AbortController().signal, callId: ToolCallId('bus-unsupported'),
    name: 'neko_plan_route', arguments: { mode: 'transit', origin: '112,38', destination: '112.01,38.01' } })
  expect(unsupportedTransit.isError).toBe(true)
  expect(unsupportedTransit.content).toMatchInlineSnapshot(`
    [
      {
        "text": "Error: 高德返回的备选方案均包含暂未支持的火车或出租车接驳，请在高德查看完整方案或调整起终点后重试",
        "type": "text",
      },
    ]
  `)
  expect(await readState()).toEqual(busState)
  transitUnsupported = false
  transitFails = true
  const deniedTransit = await ctx.tools.execute({ agent, signal: new AbortController().signal, callId: ToolCallId('bus-denied'),
    name: 'neko_plan_route', arguments: { mode: 'transit', origin: '112,38', destination: '112.01,38.01' } })
  expect(deniedTransit.isError).toBe(true)
  expect(await readState()).toEqual(busState)

  const unauthenticated = await fetch(`${origin}/api/neko-wander/state?sessionId=${agent.id}`)
  expect(unauthenticated.status).toBe(401)
  const forbidden = await fetch(`${origin}/api/neko-wander/location?sessionId=${agent.id}`, {
    method: 'POST', headers: { ...headers, Origin: 'https://example.invalid' }, body: '{}',
  })
  expect(forbidden.status).toBe(403)
  expect((await reportLocation(agent.id, { requestId: 0, status: 'located', point: { lng: 999, lat: 38 }, approximate: false })).status).toBe(400)

  const waitingAgent = await ctx.agentLoop.create(SessionId('waiting-for-location'), { provider: 'mock', model: 'mock' })
  const pending = ctx.tools.execute({ agent: waitingAgent, signal: new AbortController().signal, callId: ToolCallId('wait-location'),
    name: 'neko_plan_route', arguments: { mode: 'cycling', destination: '112.01,38.01' } })
  let requestId = 0
  await vi.waitFor(async () => {
    requestId = (await readState(waitingAgent.id)).locationRequestId
    expect(requestId).toBeGreaterThan(0)
  })
  expect((await reportLocation(waitingAgent.id, { requestId: requestId + 1, status: 'located', point: { lng: 113, lat: 39 }, approximate: false })).status).toBe(409)
  expect((await reportLocation(waitingAgent.id, { requestId, status: 'located', point: { lng: 113, lat: 39 }, approximate: false })).status).toBe(204)
  expect((await pending).isError).toBe(false)
  expect(await readState(waitingAgent.id)).toMatchObject({ route: { origin: { lng: 113, lat: 39 } }, locationRequestId: 0 })
  const explicit = await ctx.tools.execute({ agent: waitingAgent, signal: new AbortController().signal, callId: ToolCallId('explicit-location'),
    name: 'neko_plan_route', arguments: { mode: 'cycling', origin: '114,40', destination: '112.01,38.01' } })
  expect(explicit.isError).toBe(false)
  expect(await readState(waitingAgent.id)).toMatchObject({ route: { origin: { lng: 114, lat: 40 } } })
  const previousRoute = await readState(waitingAgent.id)
  cyclingInvalid = true
  const badCycling = await ctx.tools.execute({ agent: waitingAgent, signal: new AbortController().signal, callId: ToolCallId('invalid-cycling-response'),
    name: 'neko_plan_route', arguments: { mode: 'cycling', origin: '112.560896,37.885418', destination: '112.565183,37.85012', via: '112.565734,37.866464' } })
  expect(badCycling.isError).toBe(true)
  expect(badCycling.content).toMatchInlineSnapshot(`
    [
      {
        "text": "Error: 高德返回数据格式异常：data 应为对象，请重新查询",
        "type": "text",
      },
    ]
  `)
  expect(await readState(waitingAgent.id)).toEqual(previousRoute)
  cyclingInvalid = false
  cyclingQps = true
  const beforeQps = providerCalls.length
  const qpsFailure = await ctx.tools.execute({ agent: waitingAgent, signal: new AbortController().signal, callId: ToolCallId('cycling-qps'),
    name: 'neko_plan_route', arguments: { mode: 'cycling', origin: '112,38', destination: '112.01,38.01' } })
  expect(qpsFailure.isError).toBe(true)
  expect(qpsFailure.content).toMatchInlineSnapshot(`
    [
      {
        "text": "Error: 高德请求频率超限：CUQPS_HAS_EXCEEDED_THE_LIMIT（10021）。请稍后重试，并检查同一账号下其他应用的调用频率。",
        "type": "text",
      },
    ]
  `)
  expect(providerCalls).toHaveLength(beforeQps + 3)
  expect(await readState(waitingAgent.id)).toEqual(previousRoute)
  const areaBeforeClear = await ctx.tools.execute({ agent, signal: new AbortController().signal, callId: ToolCallId('area-before-clear-route'),
    name: 'neko_show_area', arguments: { name: '蛋糕店周边', center: '112,38', radiusMeters: 300 } })
  expect(areaBeforeClear.isError).toBe(false)
  const beforeClear = await readState()
  const clearRoute = await ctx.tools.execute({ agent, signal: new AbortController().signal, callId: ToolCallId('clear-route'),
    name: 'neko_clear_route', arguments: {} })
  expect(clearRoute.isError).toBe(false)
  expect(clearRoute.content).toMatchInlineSnapshot(`
    [
      {
        "text": "{"routeCleared":true}",
        "type": "text",
      },
    ]
  `)
  expect(await readState()).not.toHaveProperty('route')
  expect(await readState()).not.toHaveProperty('detour')
  expect(await readState()).toHaveProperty('places', beforeClear.places)
  expect(await readState()).toHaveProperty('area', beforeClear.area)
  const tools = ctx.tools
  expect(tools.get('neko_clear_route')).toBeDefined()
  await ctx.fiber.dispose()
  expect(tools.get('neko_clear_route')).toBeUndefined()
}, 30000)
