/** Right-sidebar map tab for the Neko Wander Web prototype. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { Place, Point, Route } from '../map-service.ts'

interface MapState {
  revision: number
  places: Place[]
  route?: Route
  detour?: { point: Point; extraMinutes: number; extraKm: number }
}
interface AMapView {
  add(value: object | object[]): void
  remove(value: object | object[]): void
  setFitView(): void
  destroy(): void
}
interface AMapSdk {
  Map: new (element: HTMLElement, options: object) => AMapView
  Marker: new (options: object) => object
  Polyline: new (options: object) => object
}
declare global {
  interface Window {
    __NEKO_WANDER_AMAP__?: { key: string; securityCode: string }
    _AMapSecurityConfig?: { securityJsCode: string }
    AMap?: AMapSdk
  }
}

let sdkLoad: Promise<AMapSdk> | undefined
function loadSdk(): Promise<AMapSdk> {
  if (window.AMap) return Promise.resolve(window.AMap)
  if (sdkLoad) return sdkLoad
  const config = window.__NEKO_WANDER_AMAP__
  if (!config?.key || !config.securityCode) return Promise.reject(new Error('缺少高德 JS API 配置'))
  window._AMapSecurityConfig = { securityJsCode: config.securityCode }
  sdkLoad = new Promise<AMapSdk>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(config.key)}`
    script.onload = () => window.AMap ? resolve(window.AMap) : reject(new Error('高德地图脚本未初始化'))
    script.onerror = () => reject(new Error('高德地图脚本加载失败'))
    document.head.appendChild(script)
  })
  return sdkLoad
}

export async function readState(sessionId: string): Promise<MapState> {
  const response = await fetch(`/neko-wander/state?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`地图状态读取失败：HTTP ${response.status}`)
  return await response.json() as MapState
}

export function MapBody({ sessionId }: PropsRuntime<'sidebar.right.pane.tab'>): ReactNode {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<AMapView>()
  const sdk = useRef<AMapSdk>()
  const overlays = useRef<object[]>([])
  const [state, setState] = useState<MapState>({ revision: 0, places: [] })
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!container.current) return
    let alive = true
    void loadSdk().then(api => {
      if (!alive || !container.current) return
      sdk.current = api
      map.current = new api.Map(container.current, { zoom: 10, center: [116.397, 39.909], resizeEnable: true })
      setReady(true)
    }).catch(cause => { if (alive) setError(String(cause)) })
    return () => { alive = false; map.current?.destroy(); map.current = undefined }
  }, [])

  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      void readState(sessionId).then(next => { if (alive) { setState(current => next.revision === current.revision ? current : next); setError(undefined) } })
        .catch(cause => { if (alive) setError(String(cause)) })
    }
    refresh()
    const timer = window.setInterval(refresh, 2500)
    return () => { alive = false; window.clearInterval(timer) }
  }, [sessionId])

  useEffect(() => {
    const view = map.current
    const api = sdk.current
    if (!view || !api) return
    if (overlays.current.length) view.remove(overlays.current)
    const next: object[] = state.places.map(place => new api.Marker({
      position: [place.point.lng, place.point.lat], title: place.name,
    }))
    if (state.route?.path.length) next.push(new api.Polyline({
      path: state.route.path.map(point => [point.lng, point.lat]),
      strokeColor: '#248cba', strokeWeight: 5, showDir: true,
    }))
    overlays.current = next
    if (next.length) { view.add(next); view.setFitView() }
  }, [state, ready])

  return <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#f7fbf8', color: '#173b3f' }}>
    <div style={{ padding: '12px 16px', borderBottom: '1px solid #dbe8e4' }}>
      <strong>溜达喵 · 地图</strong>
      <div style={{ fontSize: 12, color: '#607b7b' }}>先看候选地点，选定后再规划路线</div>
    </div>
    <div ref={container} aria-label="高德动态地图" style={{ flex: 1, minHeight: 240 }} />
    <div style={{ maxHeight: 190, overflowY: 'auto', padding: '8px 14px', borderTop: '1px solid #dbe8e4' }}>
      {error && <div role="alert" style={{ color: '#a33' }}>{error}</div>}
      {state.route && <div>驾车路线：约 {state.route.durationMinutes} 分钟，{state.route.distanceKm} 公里</div>}
      {state.detour && <div>途经候选点：增加约 {state.detour.extraMinutes} 分钟、{state.detour.extraKm} 公里</div>}
      {state.places.length === 0 && !error && <div>在对话中搜索地点，候选点会显示在这里。</div>}
      {state.places.map(place => <div key={`${place.id}-${place.name}`} style={{ padding: '5px 0', borderBottom: '1px solid #e6efec' }}>
        <strong>{place.name}</strong><div style={{ fontSize: 12 }}>{place.address} · {place.point.lng},{place.point.lat}</div>
      </div>)}
    </div>
  </div>
}
