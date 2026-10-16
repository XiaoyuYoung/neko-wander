import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { MapBody, readState } from './MapBody.tsx'

const ID = '@deepseek-ai/dsh-experimental-neko-wander'
const KIND = 'neko-map'

export const inject = ['slots', 'sidebarRight', 'sidebarRightTabs']

/** Register the map tab and reveal it when a map tool first publishes data. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ID, kind: KIND, title: () => '溜达喵地图', keepMounted: true,
    guide: [{ id: 'map', order: 12, title: () => '溜达喵地图',
      description: () => '搜索地点、查看坐标和路线' }],
  }), 'neko-wander: map tab')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: ID,
  }, MapBody)), 'neko-wander: map body')

  const revealed = new Set<string>()
  const timer = window.setInterval(() => {
    const sessionId = ctx.sidebarRight.mounted.getSnapshot()
    if (!sessionId || revealed.has(sessionId)) return
    if (ctx.sidebarRight.openTabs.getSnapshot().some(tab => tab.sessionId === sessionId && tab.kind === KIND)) {
      revealed.add(sessionId)
      return
    }
    void readState(sessionId).then(state => {
      if (state.revision === 0 || ctx.sidebarRight.mounted.getSnapshot() !== sessionId) return
      revealed.add(sessionId)
      ctx.sidebarRight.openTab(KIND)
    }).catch(() => { /* The panel itself reports a persistent read failure after opening. */ })
  }, 2500)
  ctx.effect(() => () => window.clearInterval(timer), 'neko-wander: reveal timer')
}
