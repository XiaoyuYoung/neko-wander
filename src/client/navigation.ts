/** Key-free AMap handoff links; AMap replans from the original requested endpoints. */
import { pointText, type Point, type Route, type TravelMode } from '../map-service.ts'

function amapLink(mode: TravelMode, origin: Point, destination: Point, via?: Point): string {
  const url = new URL('https://uri.amap.com/navigation')
  url.searchParams.set('from', pointText(origin))
  url.searchParams.set('to', pointText(destination))
  url.searchParams.set('mode', { driving: 'car', walking: 'walk', cycling: 'ride', transit: 'bus', ebike: 'ride' }[mode])
  if (via) url.searchParams.set('via', pointText(via))
  url.searchParams.set('src', 'neko_wander')
  url.searchParams.set('coordinate', 'gaode')
  url.searchParams.set('callnative', '1')
  return url.href
}

/** Build links for a confirmed route, retaining requested coordinates rather than polyline endpoints.
 * @param route Successful route. Electric bicycle handoff opens riding and requires mode confirmation in AMap.
 * @returns The full driving route or first non-driving leg; a second link preserves non-driving waypoints.
 */
export function navigationLinks(route: Pick<Route, 'mode' | 'origin' | 'destination' | 'via'>): { primary: string; onward?: string } {
  if (route.via && route.mode !== 'driving') return {
    primary: amapLink(route.mode, route.origin, route.via),
    onward: amapLink(route.mode, route.via, route.destination),
  }
  return { primary: amapLink(route.mode, route.origin, route.destination, route.via) }
}
