/** Copy for the map panel and one-shot location request. */
export const en = {
  title: 'Neko Wander map', description: 'Find places and view coordinates and routes',
  mapLabel: 'AMap interactive map', locate: 'Back to my location', locating: 'Locating…',
  approximate: 'Approximate location from IP; this may differ from your actual position.',
  locationFailed: 'Unable to locate you. Allow location access in the browser, check your connection, then try again. You can still explore the map.',
  locationTimeout: 'Location timed out. Check location permission and your connection, then try again.',
  locationSyncFailed: 'Your location could not be shared with this conversation. Click the location icon to retry, or provide a starting address.',
  currentPosition: 'Your location', approximatePosition: 'Approximate location',
  sdkConfigMissing: 'AMap JS API configuration is missing', sdkInitFailed: 'AMap SDK did not initialize',
  sdkLoadFailed: 'AMap SDK could not load', stateReadFailed: 'Unable to read map state (HTTP {status})',
  driving: 'Driving', walking: 'Walking', cycling: 'Cycling', ebike: 'Electric bicycle',
  startNavigation: 'Start navigation', navigateOnward: 'Navigate the next leg',
  navigationTitle: 'Open AMap to confirm your route and start navigation',
  navigationHint: 'Opens AMap. Confirm the route there before starting; AMap may recalculate it.',
  navigationLegs: 'Start navigation goes to the waypoint first. At the waypoint, open the next leg to reach your destination.',
  navigationMobile: 'Continue cycling navigation in AMap on your phone.',
  navigationEbike: 'On your phone, switch to electric bicycle mode in AMap before starting.',
  error: 'Map error: {error}', route: '{mode} route: about {minutes} min, {km} km',
  detour: '{mode} via candidate: about {minutes} extra min, {km} extra km',
  area: '{name} · approx. {radius} m radius (suggested exploration area)',
  empty: 'Search for places in the chat to show candidates here.',
} as const

/** Keys shared by the map's translated dictionaries. */
export type MapKey = keyof typeof en

export const zh: Record<MapKey, string> = {
  title: '溜达喵地图', description: '搜索地点、查看坐标和路线',
  mapLabel: '高德动态地图', locate: '回到当前位置', locating: '正在定位…',
  approximate: '当前显示 IP 推测的大致位置，可能与实际位置有偏差。',
  locationFailed: '无法获取当前位置。请允许浏览器访问位置、检查网络后重试；你仍可手动浏览地图。',
  locationTimeout: '定位超时，请检查浏览器定位权限和网络后重试。',
  locationSyncFailed: '当前位置未能同步到对话，请点击定位图标重试，或提供起点地址。',
  currentPosition: '当前位置', approximatePosition: '大致位置',
  sdkConfigMissing: '缺少高德 JS API 配置', sdkInitFailed: '高德地图脚本未初始化',
  sdkLoadFailed: '高德地图脚本加载失败', stateReadFailed: '地图状态读取失败：HTTP {status}',
  driving: '驾车', walking: '步行', cycling: '骑行', ebike: '电动车骑行',
  startNavigation: '开始导航', navigateOnward: '导航后半程',
  navigationTitle: '在高德中确认路线并开始导航',
  navigationHint: '将在高德打开，请确认路线后开始导航；高德可能重新计算路线。',
  navigationLegs: '“开始导航”先前往途经点，到达后点击“导航后半程”前往终点。',
  navigationMobile: '请在手机高德中继续骑行导航。',
  navigationEbike: '请在手机高德中切换为电动车模式，再开始导航。',
  error: '地图错误：{error}', route: '{mode}路线：约 {minutes} 分钟，{km} 公里',
  detour: '{mode}途经候选点：增加约 {minutes} 分钟、{km} 公里',
  area: '{name} · 约半径 {radius} 米（建议探索范围）',
  empty: '在对话中搜索地点，候选点会显示在这里。',
}
