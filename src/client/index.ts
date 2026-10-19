import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { MapBody, readState } from './MapBody.tsx'
import { en, zh, type MapKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'neko.map': MapKey }
}

const ID = '@deepseek-ai/dsh-experimental-neko-wander'
const KIND = 'neko-map'

export const inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'locale']

/** Register the map tab and reveal it when a map tool first publishes data. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('neko.map', { en, zh }), 'neko-wander: map copy')
  const t = ctx.locale.bind('neko.map')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ID, kind: KIND, title: () => t('title'), keepMounted: true,
    guide: [{ id: 'map', order: 12, title: () => t('title'),
      description: () => t('description') }],
  }), 'neko-wander: map tab')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: ID, locale: 'neko.map',
  }, MapBody)), 'neko-wander: map body')

  const revealed = new Set<string>()
  let alive = true
  const timer = window.setInterval(() => {
    const sessionId = ctx.sidebarRight.mounted.getSnapshot()
    if (!sessionId) return
    if (ctx.sidebarRight.openTabs.getSnapshot().some(tab => tab.sessionId === sessionId && tab.kind === KIND)) {
      revealed.add(sessionId)
      return
    }
    void readState(sessionId).then(state => {
      if (!alive || ctx.sidebarRight.mounted.getSnapshot() !== sessionId ||
        (!state.locationRequestId && (state.revision === 0 || revealed.has(sessionId)))) return
      revealed.add(sessionId)
      ctx.sidebarRight.openTab(KIND)
    }).catch(() => { /* The panel itself reports a persistent read failure after opening. */ })
  }, 2500)
  ctx.effect(() => () => { alive = false; window.clearInterval(timer) }, 'neko-wander: reveal timer')
}
