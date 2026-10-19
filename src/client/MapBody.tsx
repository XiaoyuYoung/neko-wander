/** Right-sidebar map tab for the Neko Wander Web prototype. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { MapArea, Place, Point, Route, TravelMode } from '../map-service.ts'
import { locateUser, postLocation, LocationError, type LocationSdk } from './location.ts'
import type { LocationReport } from '../current-location.ts'
import type { MapKey } from './locales.ts'
import css from './MapBody.module.css'
import { navigationLinks } from './navigation.ts'

interface MapState {
  revision: number
  locationRequestId: number
  places: Place[]
  area?: MapArea
  route?: Route
  detour?: { mode: TravelMode; point: Point; extraMinutes: number; extraKm: number }
}
interface AMapView {
  add(value: object | object[]): void
  remove(value: object | object[]): void
  setFitView(overlays: object[]): void
  setZoomAndCenter(zoom: number, center: number[]): void
  on(event: 'dragstart', listener: () => void): void
  off(event: 'dragstart', listener: () => void): void
  destroy(): void
}
interface AMapMarker {
  on(event: 'click', listener: () => void): void
  off(event: 'click', listener: () => void): void
  setzIndex(value: number): void
}
interface AMapSdk extends LocationSdk {
  Map: new (element: HTMLElement, options: object) => AMapView
  Marker: new (options: object) => AMapMarker
  Polyline: new (options: object) => object
  Circle: new (options: object) => object
}

function placeKey(place: Place): string {
  return JSON.stringify([place.id, place.name, place.point.lng, place.point.lat])
}
declare global {
  interface Window {
    __NEKO_WANDER_AMAP__?: { key: string; securityCode: string; locationTimeoutMs: number }
    _AMapSecurityConfig?: { securityJsCode: string }
    AMap?: AMapSdk
  }
}

let sdkLoad: Promise<AMapSdk> | undefined
function loadSdk(t: Translate<MapKey>): Promise<AMapSdk> {
  if (window.AMap) return Promise.resolve(window.AMap)
  if (sdkLoad) return sdkLoad
  const config = window.__NEKO_WANDER_AMAP__
  if (!config?.key || !config.securityCode) return Promise.reject(new Error(t('sdkConfigMissing')))
  window._AMapSecurityConfig = { securityJsCode: config.securityCode }
  sdkLoad = new Promise<AMapSdk>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(config.key)}`
    script.onload = () => window.AMap ? resolve(window.AMap) : reject(new Error(t('sdkInitFailed')))
    script.onerror = () => reject(new Error(t('sdkLoadFailed')))
    document.head.appendChild(script)
  })
  return sdkLoad
}

export async function readState(sessionId: string): Promise<MapState> {
  const response = await fetch(`/api/neko-wander/state?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`地图状态读取失败：HTTP ${response.status}`)
  return await response.json() as MapState
}

export function MapBody({ sessionId, t }: Pick<PropsRuntime<'sidebar.right.pane.tab'>, 'sessionId'> & { t: Translate<MapKey> }): ReactNode {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<AMapView>()
  const sdk = useRef<AMapSdk>()
  const overlays = useRef<object[]>([])
  const candidateMarkers = useRef<{ key: string; marker: AMapMarker; content: HTMLElement; onClick: () => void }[]>([])
  const results = useRef<HTMLDivElement>(null)
  const positionMarker = useRef<object>()
  const locationRequest = useRef<{ controller: AbortController; automatic: boolean; centerAllowed: boolean; id: number }>()
  const [state, setState] = useState<MapState>({ revision: 0, locationRequestId: 0, places: [] })
  const requestId = useRef(0)
  requestId.current = state.locationRequestId
  const [ready, setReady] = useState(false)
  const [selection, setSelection] = useState<{ sessionId: string; key: string }>()
  const selectedKey = selection?.sessionId === sessionId ? selection.key : undefined
  const orderedPlaces = [
    ...state.places.filter(place => placeKey(place) === selectedKey),
    ...state.places.filter(place => placeKey(place) !== selectedKey),
  ]
  const [mapError, setMapError] = useState<string>()
  const [stateError, setStateError] = useState<string>()
  const [locationSyncError, setLocationSyncError] = useState(false)
  const [location, setLocation] = useState<'idle' | 'locating' | 'located' | 'approximate' | 'locationFailed' | 'locationTimeout'>('idle')
  const navigation = state.route ? navigationLinks(state.route) : undefined

  const selectPlace = useCallback((key: string): void => {
    setSelection({ sessionId, key })
    if (results.current) results.current.scrollTop = 0
  }, [sessionId])

  const locate = useCallback((automatic: boolean, id = requestId.current): void => {
    const view = map.current, api = sdk.current
    const config = window.__NEKO_WANDER_AMAP__
    if (!view || !api || !config) return
    locationRequest.current?.controller.abort()
    if (positionMarker.current) { view.remove(positionMarker.current); positionMarker.current = undefined }
    const request = { controller: new AbortController(), automatic, centerAllowed: !automatic || overlays.current.length === 0, id }
    locationRequest.current = request
    setLocation('locating')
    const sync = async (report: LocationReport): Promise<void> => {
      try {
        await postLocation(sessionId, report, request.controller.signal)
        if (!request.controller.signal.aborted) {
          setLocationSyncError(false)
          if (report.status !== 'locating' && id > 0) setState(current => current.locationRequestId === id ? { ...current, locationRequestId: 0 } : current)
        }
      } catch (error) {
        if (!request.controller.signal.aborted) setLocationSyncError(true)
      }
    }
    void (async () => {
      await sync({ requestId: id, status: 'locating' })
      const result = await locateUser(api, config.locationTimeoutMs, request.controller.signal)
      if (request.controller.signal.aborted) return
      const label = t(result.approximate ? 'approximatePosition' : 'currentPosition')
      const content = document.createElement('div')
      content.className = css.positionDot!
      content.setAttribute('aria-label', label)
      positionMarker.current = new api.Marker({ position: [result.point.lng, result.point.lat], title: label,
        content, anchor: 'center', zIndex: 200 })
      view.add(positionMarker.current)
      if (request.centerAllowed) view.setZoomAndCenter(result.approximate ? 11 : 15, [result.point.lng, result.point.lat])
      setLocation(result.approximate ? 'approximate' : 'located')
      await sync({ requestId: id, status: 'located', ...result })
    })().catch(async cause => {
      if (!request.controller.signal.aborted) {
        setLocation(cause instanceof LocationError && cause.code === 'timeout' ? 'locationTimeout' : 'locationFailed')
        await sync({ requestId: id, status: 'failed' })
      }
    })
  }, [sessionId, t])

  useEffect(() => {
    if (!container.current) return
    let alive = true
    let view: AMapView | undefined
    const onDrag = (): void => { if (locationRequest.current) locationRequest.current.centerAllowed = false }
    void loadSdk(t).then(api => {
      if (!alive || !container.current) return
      sdk.current = api
      view = new api.Map(container.current, { zoom: 10, resizeEnable: true })
      map.current = view
      view.on('dragstart', onDrag)
      setReady(true)
      locate(true)
    }).catch(cause => { if (alive) setMapError(String(cause)) })
    return () => {
      alive = false
      locationRequest.current?.controller.abort()
      for (const { marker, onClick } of candidateMarkers.current) marker.off('click', onClick)
      candidateMarkers.current = []
      view?.off('dragstart', onDrag)
      view?.destroy()
      map.current = undefined
      overlays.current = []
      positionMarker.current = undefined
    }
  }, [locate, t])

  useEffect(() => {
    if (ready && state.locationRequestId > 0 && locationRequest.current?.id !== state.locationRequestId) {
      locate(true, state.locationRequestId)
    }
  }, [ready, state.locationRequestId, locate])

  useEffect(() => {
    let alive = true
    let first = true
    const refresh = (): void => {
      void readState(sessionId).then(next => { if (alive) {
        const replace = first
        first = false
        setState(current => !replace && next.revision === current.revision ? current : next)
        setSelection(current => current?.sessionId === sessionId && next.places.some(place => placeKey(place) === current.key) ? current : undefined)
        setStateError(undefined)
      } })
        .catch(cause => { if (alive) setStateError(String(cause)) })
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
    for (const { marker, onClick } of candidateMarkers.current) marker.off('click', onClick)
    candidateMarkers.current = state.places.map(place => {
      const key = placeKey(place)
      const content = document.createElement('div')
      content.className = css.pin!
      content.innerHTML = '<svg width="28" height="36" viewBox="0 0 28 36" fill="none" aria-hidden="true"><path d="M14 35S1 22 1 14a13 13 0 1 1 26 0c0 8-13 21-13 21Z" fill="currentColor" stroke="white" stroke-width="1.5"/><circle cx="14" cy="14" r="4.5" fill="white"/></svg>'
      const marker = new api.Marker({ position: [place.point.lng, place.point.lat], title: place.name,
        content, anchor: 'bottom-center', cursor: 'pointer' })
      const onClick = (): void => { selectPlace(key) }
      marker.on('click', onClick)
      return { key, marker, content, onClick }
    })
    const next: object[] = candidateMarkers.current.map(({ marker }) => marker)
    if (state.area) next.push(new api.Circle({
      center: [state.area.center.lng, state.area.center.lat], radius: state.area.radiusMeters,
      strokeColor: '#5f9de9', strokeOpacity: 0.7, strokeWeight: 2,
      fillColor: '#83b8ff', fillOpacity: 0.16, zIndex: 10, bubble: true,
    }))
    if (state.route?.path.length) next.push(new api.Polyline({
      path: state.route.path.map(point => [point.lng, point.lat]),
      strokeColor: '#165DDE', strokeWeight: 8, strokeOpacity: 1,
      isOutline: true, outlineColor: '#ffffff', borderWeight: 2, lineJoin: 'round', lineCap: 'round', showDir: true,
    }))
    overlays.current = next
    if (next.length) {
      if (locationRequest.current?.automatic) locationRequest.current.centerAllowed = false
      view.add(next); view.setFitView(next)
    }
  }, [state, ready, selectPlace])

  useEffect(() => {
    for (const { key, marker, content } of candidateMarkers.current) {
      const selected = key === selectedKey
      content.classList.toggle(css.pinSelected!, selected)
      marker.setzIndex(selected ? 300 : 100)
    }
  }, [selectedKey, state, ready, selectPlace])

  return <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#f7fbf8', color: '#173b3f' }}>
    <div className={css.mapArea}>
      <div ref={container} aria-label={t('mapLabel')} className={css.canvas} />
      {(location === 'locationFailed' || location === 'locationTimeout') &&
        <div role="alert" className={css.locationError}>{t(location)}</div>}
      <button type="button" className={css.locate} disabled={!ready || location === 'locating'}
        aria-label={t(location === 'locating' ? 'locating' : 'locate')} aria-busy={location === 'locating'}
        title={t(location === 'approximate' ? 'approximate' : location === 'locating' ? 'locating' : 'locate')}
        onClick={() => { locate(false) }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth="1.8" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="12" cy="12" r="2.3" fill="currentColor" />
        </svg>
      </button>
    </div>
    <div ref={results} style={{ maxHeight: 190, overflowY: 'auto', padding: '8px 14px', borderTop: '1px solid #dbe8e4' }}>
      {(mapError || stateError) && <div role="alert" style={{ color: '#a33' }}>{t('error', { error: mapError || stateError })}</div>}
      {locationSyncError && <div role="alert" style={{ color: '#a33' }}>{t('locationSyncFailed')}</div>}
      {state.route && navigation && <div className={css.routeSummary}>
        <div className={css.routeActions}>
          <span>{t('route', { mode: t(state.route.mode), minutes: state.route.durationMinutes, km: state.route.distanceKm })}</span>
          <a className={css.navigate} href={navigation.primary} target="_blank" rel="noopener noreferrer" title={t('navigationTitle')}>{t('startNavigation')} ↗</a>
          {navigation.onward && <a className={css.onward} href={navigation.onward} target="_blank" rel="noopener noreferrer">{t('navigateOnward')} ↗</a>}
        </div>
        <div className={css.navigationHint}>{t('navigationHint')}</div>
        {navigation.onward && <div className={css.navigationHint}>{t('navigationLegs')}</div>}
        {state.route.mode === 'cycling' && <div className={css.navigationHint}>{t('navigationMobile')}</div>}
        {state.route.mode === 'ebike' && <div className={css.navigationHint}>{t('navigationEbike')}</div>}
      </div>}
      {state.detour && <div>{t('detour', { mode: t(state.detour.mode), minutes: state.detour.extraMinutes, km: state.detour.extraKm })}</div>}
      {state.area && <div className={css.areaSummary}>{t('area', { name: state.area.name, radius: state.area.radiusMeters })}</div>}
      {state.places.length === 0 && !state.area && !state.route && !state.detour && !mapError && !stateError && <div>{t('empty')}</div>}
      {orderedPlaces.map(place => <button type="button" key={placeKey(place)}
        className={`${css.place} ${placeKey(place) === selectedKey ? css.placeSelected : ''}`}
        aria-pressed={placeKey(place) === selectedKey} onClick={() => { selectPlace(placeKey(place)) }}>
        <strong>{place.name}</strong><span className={css.address}>{place.address} · {place.point.lng},{place.point.lat}</span>
      </button>)}
    </div>
  </div>
}
