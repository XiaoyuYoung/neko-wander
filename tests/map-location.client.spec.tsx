// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, expect, it, vi } from 'vitest'
import { MapBody } from '../src/client/MapBody.tsx'
import { zh, type MapKey } from '../src/client/locales.ts'
import type { LocationResult } from '../src/client/location.ts'
import type { MapArea, Place, Route } from '../src/map-service.ts'
import css from '../src/client/MapBody.module.css'
import { parseLocationReport, type LocationReport } from '../src/current-location.ts'

const t: Translate<MapKey> = (key, params) => Object.entries(params ?? {})
  .reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), zh[key])
const sessionId = 'location-test' as ComponentProps<typeof MapBody>['sessionId']

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.AMap; delete window.__NEKO_WANDER_AMAP__ })

it('draws bus and walking legs separately and shows transfer instructions with a bus handoff', async () => {
  const route: Route = { mode: 'transit', origin: { lng: 112, lat: 38 }, destination: { lng: 112.01, lat: 38.01 },
    durationMinutes: 30, distanceKm: 5, path: [{ lng: 112, lat: 38 }, { lng: 112.01, lat: 38.01 }],
    sections: [
      { mode: 'walking', path: [{ lng: 112, lat: 38 }, { lng: 112.001, lat: 38.001 }] },
      { mode: 'transit', path: [{ lng: 112.002, lat: 38.002 }, { lng: 112.01, lat: 38.01 }] },
    ], transit: { transfers: 0, walkingMeters: 200, fareYuan: 2,
      legs: [{ line: '公交1路', boardingStop: '起点站', alightingStop: '终点站', stops: 3 }] } }
  const f = await fixture(false, undefined, route)
  await waitFor(() => { expect(f.polylines).toHaveLength(2) })
  expect(f.polylines.map(line => line.options)).toMatchObject([
    { path: [[112, 38], [112.001, 38.001]], strokeColor: '#165DDE', strokeStyle: 'dashed' },
    { path: [[112.002, 38.002], [112.01, 38.01]], strokeColor: '#087F5B', strokeStyle: 'solid' },
  ])
  const link = screen.getByRole('link', { name: /在高德查看/ })
  expect(new URL(link.getAttribute('href')!).searchParams.get('mode')).toBe('bus')
  expect(screen.getByText('公交1路：起点站 上车，终点站 下车')).toBeTruthy()
  expect(screen.getByText('预计票价：¥2')).toBeTruthy()
  expect(screen.getByText('换乘 0 次 · 步行 200 米')).toBeTruthy()
  expect(screen.queryByRole('link', { name: /导航后半程/ })).toBeNull()
  expect(screen.getByText('公交路线：约 30 分钟，5 公里').textContent).toMatchInlineSnapshot('"公交路线：约 30 分钟，5 公里"')
})

async function fixture(withCandidate: boolean | Place[] = false, area?: MapArea, route?: Route) {
  const callbacks: ((status: string, value: LocationResult) => void)[] = []
  const view = { add: vi.fn(), remove: vi.fn(), setFitView: vi.fn(), setZoomAndCenter: vi.fn(), destroy: vi.fn(),
    on: vi.fn(), off: vi.fn() }
  const construct = vi.fn()
  const markers: { options: { content?: HTMLElement; title?: string; anchor?: string }; on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn>; setzIndex: ReturnType<typeof vi.fn> }[] = []
  const intervals = vi.spyOn(window, 'setInterval')
  const circles: { options: object }[] = []
  const polylines: { options: object }[] = []
  const reports: LocationReport[] = []
  window.AMap = {
    Map: class {
      constructor(_element: HTMLElement, options: object) { construct(options) }
      add = view.add; remove = view.remove; setFitView = view.setFitView; setZoomAndCenter = view.setZoomAndCenter
      destroy = view.destroy; on = view.on; off = view.off
    },
    Marker: class {
      on = vi.fn(); off = vi.fn(); setzIndex = vi.fn()
      constructor(readonly options: { content?: HTMLElement; title?: string; anchor?: string }) { markers.push(this) }
    },
    Polyline: class { constructor(readonly options: object) { polylines.push(this) } },
    Circle: class { constructor(readonly options: object) { circles.push(this) } },
    plugin: (_name, ready) => { ready() },
    Geolocation: class { getCurrentPosition(callback: typeof callbacks[number]) { callbacks.push(callback) } },
  }
  window.__NEKO_WANDER_AMAP__ = { key: 'test', securityCode: 'test', locationTimeoutMs: 10000 }
  let responseState = { revision: 1, locationRequestId: 0, area, route, places: Array.isArray(withCandidate) ? withCandidate : withCandidate
    ? [{ id: 'p1', name: '候选步道', address: '山脚', point: { lng: 111, lat: 38 } }] : [] }
  vi.stubGlobal('fetch', vi.fn(async (_input, init?: RequestInit) => {
    if (init?.method === 'POST') {
      reports.push(parseLocationReport(JSON.parse(String(init.body))))
      return new Response(null, { status: 204 })
    }
    return new Response(JSON.stringify(responseState))
  }))
  const component = render(<MapBody sessionId={sessionId} t={t} />)
  await waitFor(() => { expect(callbacks).toHaveLength(1) })
  const complete = async (index = 0) => {
    await act(async () => { callbacks[index]!('complete', { position: { getLng: () => 112.55, getLat: () => 37.87 }, location_type: 'html5' }) })
  }
  const refresh = async (places = responseState.places, nextArea: MapArea | null | undefined = responseState.area,
    locationRequestId = responseState.locationRequestId, nextRoute: Route | null | undefined = responseState.route) => {
    responseState = { ...responseState, revision: responseState.revision + 1, places, area: nextArea ?? undefined, locationRequestId, route: nextRoute ?? undefined }
    const handler = intervals.mock.calls.find(call => call[1] === 2500)![0]
    if (typeof handler !== 'function') throw new Error('Expected a polling callback')
    await act(async () => { handler() })
  }
  return { view, construct, component, callbacks, complete, markers, refresh, circles, polylines, reports }
}

it('opens without a fixed center and centers on the returned user position', async () => {
  const f = await fixture()
  expect(f.construct.mock.calls[0]![0]).not.toHaveProperty('center')
  await f.complete()
  expect(f.view.setZoomAndCenter).toHaveBeenCalledWith(15, [112.55, 37.87])
  const position = f.markers.find(marker => marker.options.title === zh.currentPosition)!
  expect(position.options.anchor).toBe('center')
  expect(position.options.content?.className).toBe(css.positionDot)
  expect(position.options.content?.querySelector('svg')).toBeNull()
  expect(f.reports.at(-1)).toEqual({ requestId: 0, status: 'located', point: { lng: 112.55, lat: 37.87 }, approximate: false })
  const button = screen.getByRole('button', { name: zh.locate })
  expect(button.querySelector('svg')).not.toBeNull()
  expect({ label: button.getAttribute('aria-label'), text: button.textContent,
    status: screen.queryByRole('status')?.textContent ?? null }).toMatchInlineSnapshot(`
      {
        "label": "回到当前位置",
        "status": null,
        "text": "",
      }
    `)
  expect(screen.queryByText('溜达喵 · 地图')).toBeNull()
  expect(screen.queryByText('先看候选地点，选定后再规划路线')).toBeNull()
})

it('keeps candidate framing when the initial location arrives later', async () => {
  const f = await fixture(true)
  expect(screen.queryByRole('link', { name: /开始导航/ })).toBeNull()
  await waitFor(() => { expect(f.view.setFitView).toHaveBeenCalled() })
  await f.complete()
  expect(f.view.setZoomAndCenter).not.toHaveBeenCalled()
  expect(f.view.setFitView.mock.calls[0]![0]).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: zh.locate }))
  await waitFor(() => { expect(f.callbacks).toHaveLength(2) })
  await f.complete(1)
  expect(f.view.setZoomAndCenter).toHaveBeenCalledWith(15, [112.55, 37.87])
})

it('does not recenter after the user drags the map while locating', async () => {
  const f = await fixture()
  const onDrag = f.view.on.mock.calls.find(call => call[0] === 'dragstart')![1]
  onDrag()
  await f.complete()
  expect(f.view.setZoomAndCenter).not.toHaveBeenCalled()
})

it('offers a retry after denied location without centering on an invented point', async () => {
  const f = await fixture()
  await act(async () => { f.callbacks[0]!('error', {}) })
  expect(screen.getByRole('alert').textContent).toBe(zh.locationFailed)
  expect(f.view.setZoomAndCenter).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: zh.locate }).hasAttribute('disabled')).toBe(false)
})

it('ignores a location callback after closing the map', async () => {
  const f = await fixture()
  f.component.unmount()
  const previousAdds = f.view.add.mock.calls.length
  await f.complete()
  expect(f.view.setZoomAndCenter).not.toHaveBeenCalled()
  expect(f.view.add).toHaveBeenCalledTimes(previousAdds)
  expect(f.view.destroy).toHaveBeenCalledOnce()
})

it('answers a tool-requested location refresh in the current conversation', async () => {
  const f = await fixture()
  await f.complete()
  await f.refresh([], null, 7)
  await waitFor(() => { expect(f.callbacks).toHaveLength(2) })
  await f.complete(1)
  expect(f.reports.at(-1)).toEqual({ requestId: 7, status: 'located', point: { lng: 112.55, lat: 37.87 }, approximate: false })
})

it('reports location sync failures while retaining the local position marker', async () => {
  const f = await fixture()
  await f.complete()
  vi.mocked(fetch).mockResolvedValue(new Response('unauthorized', { status: 401 }))
  fireEvent.click(screen.getByRole('button', { name: zh.locate }))
  await waitFor(() => { expect(f.callbacks).toHaveLength(2) })
  await f.complete(1)
  expect(screen.getByText(zh.locationSyncFailed)).toBeTruthy()
  expect(f.markers.at(-1)?.options.title).toBe(zh.currentPosition)
})

const places: Place[] = [
  { id: 'p1', name: '山林步道', address: '山脚路一号', point: { lng: 111, lat: 38 } },
  { id: 'p2', name: '观星草地', address: '山顶路二号', point: { lng: 112, lat: 39 } },
  { id: 'p3', name: '溪边树林', address: '溪水路三号', point: { lng: 113, lat: 40 } },
]

it.each(['walking', 'cycling', 'ebike'] as const)('labels the %s route with the selected travel mode', async mode => {
  const f = await fixture(false, undefined, { mode, durationMinutes: 10, distanceKm: 1.5,
    origin: { lng: 112, lat: 38 }, destination: { lng: 112.01, lat: 38.01 },
    path: [{ lng: 112, lat: 38 }, { lng: 112.01, lat: 38.01 }] })
  expect(screen.getByText(`${zh[mode]}路线：约 10 分钟，1.5 公里`)).toBeTruthy()
  expect(screen.queryByText(/驾车路线/)).toBeNull()
  expect(screen.queryByText(zh.empty)).toBeNull()
  const link = screen.getByRole('link', { name: `${zh.startNavigation} ↗` }) as HTMLAnchorElement
  expect(new URL(link.href).searchParams.get('mode')).toBe(mode === 'walking' ? 'walk' : 'ride')
  expect(link.target).toBe('_blank')
  expect(link.rel).toBe('noopener noreferrer')
  expect(screen.getByText(zh.navigationHint)).toBeTruthy()
  if (mode === 'ebike') expect(screen.getByText(zh.navigationEbike)).toBeTruthy()
  await waitFor(() => { expect(f.view.setFitView).toHaveBeenCalled() })
  expect(f.polylines[0]?.options).toMatchObject({ strokeColor: '#165DDE', strokeWeight: 8,
    strokeOpacity: 1, isOutline: true, outlineColor: '#ffffff', borderWeight: 2 })
})

it.each([
  ['driving', 'car'], ['cycling', 'ride'], ['walking', 'walk'], ['transit', 'bus'], ['ebike', 'ride'],
] as const)('keeps the %s route, geometry and navigation when shop results refresh', async (mode, handoff) => {
  const path = [{ lng: 112, lat: 38 }, { lng: 112.01, lat: 38.01 }]
  const route: Route = { mode, origin: path[0]!, destination: path[1]!, path, durationMinutes: 20, distanceKm: 3,
    ...(mode === 'transit' ? {
      sections: [{ mode: 'walking' as const, path }, { mode: 'transit' as const, path }],
      transit: { transfers: 0, walkingMeters: 200, legs: [{ line: '地铁2号线', boardingStop: '起点站', alightingStop: '终点站' }] },
    } : {}) }
  const f = await fixture(true, undefined, route)
  const lineCount = mode === 'transit' ? 2 : 1
  await waitFor(() => { expect(f.polylines).toHaveLength(lineCount) })
  const originalLines = f.polylines.slice()
  const shop: Place = { id: 'cake', name: '沿途蛋糕店', address: '测试街1号', point: { lng: 112.002, lat: 38.002 } }
  await f.refresh([shop])
  await waitFor(() => { expect(f.polylines).toHaveLength(lineCount * 2) })
  expect(screen.getByRole('button', { name: /沿途蛋糕店/ })).toBeTruthy()
  expect(screen.getByText(`${zh[mode]}路线：约 20 分钟，3 公里`)).toBeTruthy()
  const link = screen.getByRole('link', { name: mode === 'transit' ? /在高德查看/ : /开始导航/ })
  expect(new URL(link.getAttribute('href')!).searchParams.get('mode')).toBe(handoff)
  for (const line of f.polylines.slice(-lineCount)) {
    expect(f.view.add.mock.lastCall![0]).toContain(line)
    expect(f.view.setFitView.mock.lastCall![0]).toContain(line)
    expect(line.options).toMatchObject({ path: [[112, 38], [112.01, 38.01]], strokeWeight: 8, strokeOpacity: 1 })
  }
  expect(f.view.remove.mock.calls.some(([removed]) => Array.isArray(removed) && originalLines.every(line => removed.includes(line)))).toBe(true)
  if (mode === 'transit') {
    expect(f.polylines.at(-1)!.options).toMatchObject({ strokeColor: '#087F5B', strokeStyle: 'solid' })
    expect(f.polylines.at(-2)!.options).toMatchObject({ strokeColor: '#165DDE', strokeStyle: 'dashed' })
    expect(screen.getByText('地铁2号线：起点站 上车，终点站 下车')).toBeTruthy()
  }
})

it('removes route geometry and navigation after an explicit clear while keeping place markers', async () => {
  const f = await fixture(true, undefined, { mode: 'driving', origin: { lng: 112, lat: 38 }, destination: { lng: 112.01, lat: 38.01 },
    path: [{ lng: 112, lat: 38 }, { lng: 112.01, lat: 38.01 }], durationMinutes: 10, distanceKm: 3 })
  await waitFor(() => { expect(f.polylines).toHaveLength(1) })
  const line = f.polylines[0]!
  await f.refresh(undefined, undefined, undefined, null)
  expect(screen.queryByRole('link', { name: /开始导航/ })).toBeNull()
  expect(screen.queryByText(/驾车路线/)).toBeNull()
  expect(screen.getByRole('button', { name: /候选步道/ })).toBeTruthy()
  expect(f.view.remove.mock.calls.some(([removed]) => Array.isArray(removed) && removed.includes(line))).toBe(true)
  expect(f.view.add.mock.lastCall![0]).not.toContain(line)
})

it('shows navigation to the waypoint and a separate onward link for a cycling route', async () => {
  await fixture(false, undefined, { mode: 'cycling', durationMinutes: 20, distanceKm: 3,
    origin: { lng: 112, lat: 38 }, destination: { lng: 113, lat: 39 }, via: { lng: 112.5, lat: 38.5 },
    path: [{ lng: 112, lat: 38 }, { lng: 113, lat: 39 }] })
  const links = screen.getAllByRole('link') as HTMLAnchorElement[]
  expect(links.map(link => ({ label: link.textContent, to: new URL(link.href).searchParams.get('to') }))).toMatchInlineSnapshot(`
    [
      {
        "label": "开始导航 ↗",
        "to": "112.5,38.5",
      },
      {
        "label": "导航后半程 ↗",
        "to": "113,39",
      },
    ]
  `)
  expect(screen.getByText(zh.navigationLegs)).toBeTruthy()
})

it('frames a translucent exploration circle and replaces it when the radius changes', async () => {
  const area: MapArea = { name: '军旅苑周边', center: { lng: 112, lat: 38 }, radiusMeters: 500 }
  const f = await fixture(false, area)
  await waitFor(() => { expect(f.circles).toHaveLength(1) })
  expect(f.circles[0]!.options).toMatchInlineSnapshot(`
    {
      "bubble": true,
      "center": [
        112,
        38,
      ],
      "fillColor": "#83b8ff",
      "fillOpacity": 0.16,
      "radius": 500,
      "strokeColor": "#5f9de9",
      "strokeOpacity": 0.7,
      "strokeWeight": 2,
      "zIndex": 10,
    }
  `)
  expect(screen.getByText('军旅苑周边 · 约半径 500 米（建议探索范围）')).toBeTruthy()
  expect(screen.queryByText(zh.empty)).toBeNull()
  expect(f.view.setFitView).toHaveBeenLastCalledWith([f.circles[0]])
  await f.complete()
  expect(f.view.setZoomAndCenter).not.toHaveBeenCalled()
  await f.refresh([], { ...area, radiusMeters: 300 })
  expect(f.view.remove).toHaveBeenCalledWith([f.circles[0]])
  expect(f.circles.at(-1)!.options).toHaveProperty('radius', 300)
  expect(screen.getByText('军旅苑周边 · 约半径 300 米（建议探索范围）')).toBeTruthy()
  await f.refresh(places, null)
  expect(screen.queryByText(/建议探索范围/)).toBeNull()
  expect(f.view.setFitView.mock.lastCall![0]).toHaveLength(3)
})

it('links marker clicks and address clicks with one red pin and a highlighted first result', async () => {
  const f = await fixture(places)
  await waitFor(() => { expect(f.markers).toHaveLength(3) })
  const first = f.markers[0]!, second = f.markers[1]!
  for (const marker of f.markers) {
    expect(marker.options.anchor).toBe('bottom-center')
    expect(marker.options.content?.querySelector('svg')).not.toBeNull()
    expect(marker.options.content?.classList.contains(css.pinSelected!)).toBe(false)
  }
  const frames = f.view.setFitView.mock.calls.length
  const click = second.on.mock.calls.find(call => call[0] === 'click')![1] as () => void
  act(() => { click() })
  const selected = screen.getByRole('button', { pressed: true })
  expect(selected.textContent).toBe('观星草地山顶路二号 · 112,39')
  expect(selected.classList.contains(css.placeSelected!)).toBe(true)
  expect(selected.parentElement?.querySelector('button')).toBe(selected)
  expect(second.options.content?.classList.contains(css.pinSelected!)).toBe(true)
  expect(first.options.content?.classList.contains(css.pinSelected!)).toBe(false)
  expect(second.setzIndex).toHaveBeenLastCalledWith(300)
  expect(Array.from(selected.parentElement!.querySelectorAll('button')).map(button => ({
    text: button.textContent, selected: button.getAttribute('aria-pressed'),
  }))).toMatchInlineSnapshot(`
    [
      {
        "selected": "true",
        "text": "观星草地山顶路二号 · 112,39",
      },
      {
        "selected": "false",
        "text": "山林步道山脚路一号 · 111,38",
      },
      {
        "selected": "false",
        "text": "溪边树林溪水路三号 · 113,40",
      },
    ]
  `)
  expect(f.view.setFitView).toHaveBeenCalledTimes(frames)

  fireEvent.click(screen.getByRole('button', { name: /山林步道/ }))
  expect(first.options.content?.classList.contains(css.pinSelected!)).toBe(true)
  expect(second.options.content?.classList.contains(css.pinSelected!)).toBe(false)
  expect(screen.getByRole('button', { pressed: true }).parentElement?.querySelector('button')?.textContent).toBe('山林步道山脚路一号 · 111,38')
  expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1)
  expect(first.setzIndex).toHaveBeenLastCalledWith(300)
  expect(second.setzIndex).toHaveBeenLastCalledWith(100)
})

it('preserves a selected candidate across refreshes, resets removed candidates and releases click listeners', async () => {
  const f = await fixture(places)
  await waitFor(() => { expect(f.markers).toHaveLength(3) })
  const old = f.markers.slice()
  fireEvent.click(screen.getByRole('button', { name: /观星草地/ }))
  await f.refresh()
  expect(screen.getByRole('button', { pressed: true }).textContent).toContain('观星草地')
  expect(f.markers[4]!.options.content?.classList.contains(css.pinSelected!)).toBe(true)
  for (const marker of old) expect(marker.off).toHaveBeenCalledWith('click', marker.on.mock.calls[0]![1])
  await f.refresh([places[0]!])
  expect(screen.queryByRole('button', { pressed: true })).toBeNull()
  const latest = f.markers.at(-1)!
  expect(latest.options.content?.classList.contains(css.pinSelected!)).toBe(false)
  f.component.unmount()
  expect(latest.off).toHaveBeenCalledWith('click', latest.on.mock.calls[0]![1])
})
