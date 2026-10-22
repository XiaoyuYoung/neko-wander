import { expect, it } from 'vitest'
import { navigationLinks } from '../src/client/navigation.ts'

const origin = { lng: 112.123456789, lat: 37.987654321 }
const destination = { lng: 112.6, lat: 38 }
const via = { lng: 112.5, lat: 37.9 }

it.each([
  ['driving', 'car'], ['walking', 'walk'], ['cycling', 'ride'], ['transit', 'bus'], ['ebike', 'ride'],
] as const)('opens %s in AMap using the requested coordinates without credentials', (mode, expected) => {
  const links = navigationLinks({ mode, origin, destination })
  const url = new URL(links.primary)
  expect(url.origin + url.pathname).toBe('https://uri.amap.com/navigation')
  expect(Object.fromEntries(url.searchParams)).toEqual({
    from: '112.123457,37.987654', to: '112.6,38', mode: expected,
    src: 'neko_wander', coordinate: 'gaode', callnative: '1',
  })
  expect(links.onward).toBeUndefined()
})

it('retains a driving waypoint in the full-route link', () => {
  const links = navigationLinks({ mode: 'driving', origin, destination, via })
  const url = new URL(links.primary)
  expect(url.searchParams.get('via')).toBe('112.5,37.9')
  expect(url.searchParams.get('to')).toBe('112.6,38')
  expect(links.onward).toBeUndefined()
})

it.each(['walking', 'cycling', 'ebike'] as const)('preserves a %s waypoint through two explicit navigation legs', mode => {
  const links = navigationLinks({ mode, origin, destination, via })
  const first = new URL(links.primary), second = new URL(links.onward!)
  expect(first.searchParams.get('to')).toBe('112.5,37.9')
  expect(second.searchParams.get('from')).toBe('112.5,37.9')
  expect(second.searchParams.get('to')).toBe('112.6,38')
  expect(first.searchParams.has('via')).toBe(false)
  expect(second.searchParams.get('mode')).toBe(first.searchParams.get('mode'))
})
