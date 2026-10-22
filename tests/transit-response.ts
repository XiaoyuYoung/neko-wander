/** Keyless AMap v3 bus/metro proposal used by service, panel and Loader tests. */
export function transitResponse() {
  return { status: '1', route: { transits: [{ duration: '1800', distance: '5000', walking_distance: '500', cost: '4', segments: [
    { walking: { distance: '200', steps: [{ polyline: '112,38;112.001,38.001' }] },
      bus: { buslines: [{ name: '公交1路', departure_stop: { name: '起点站' }, arrival_stop: { name: '换乘站' }, via_num: '3',
        polyline: '112.001,38.001;112.005,38.005' }] },
      railway: { id: [], name: [], trip: '', distance: '0', departure_stop: { name: [], location: [] }, arrival_stop: { name: [] }, spaces: [{ cost: [] }] },
      taxi: { distance: '0.00', duration: 0, polyline: [], origin: [], destination: [], price: [] } },
    { walking: { distance: '300', steps: [{ polyline: '112.005,38.005;112.006,38.006' }] },
      bus: { buslines: [{ name: '地铁2号线', departure_stop: { name: '换乘站' }, arrival_stop: { name: '终点站' }, via_num: '2',
        polyline: '112.006,38.006;112.01,38.01' }] }, railway: {}, taxi: [] },
  ] }] } }
}
