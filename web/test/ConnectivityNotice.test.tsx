import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConnectivityNotice } from '../src/app/pwa/ConnectivityNotice'
import {
  bottomNoticeOffsetProperty,
  createConnectivityStore,
  publishBottomNoticeOffset,
  resolveConnectivityAnnouncement,
  type ConnectivityStore,
} from '../src/shared/lib/pwa/connectivity'

/**
 * Creates a store that always reports one connectivity value.
 *
 * @param online - Reported connectivity.
 * @returns A fixed connectivity store.
 */
function fixedConnectivity(online: boolean): ConnectivityStore {
  return { subscribe: () => () => undefined, getSnapshot: () => online }
}

describe('createConnectivityStore', () => {
  test('follows online and offline events while subscribed', () => {
    const target = new EventTarget()
    let online = true
    const store = createConnectivityStore({ isOnline: () => online, target })
    let notified = 0
    const unsubscribe = store.subscribe(() => { notified += 1 })

    online = false
    target.dispatchEvent(new Event('offline'))
    expect(store.getSnapshot()).toBe(false)
    expect(notified).toBe(1)
    // A repeated event without a change stays silent.
    target.dispatchEvent(new Event('offline'))
    expect(notified).toBe(1)
    online = true
    target.dispatchEvent(new Event('online'))
    expect(store.getSnapshot()).toBe(true)
    expect(notified).toBe(2)

    unsubscribe()
    online = false
    target.dispatchEvent(new Event('offline'))
    expect(notified).toBe(2)
  })

  test('re-reads connectivity when the first subscriber arrives', () => {
    let online = true
    const store = createConnectivityStore({ isOnline: () => online, target: new EventTarget() })
    online = false
    const unsubscribe = store.subscribe(() => undefined)
    expect(store.getSnapshot()).toBe(false)
    unsubscribe()
  })

  test('treats a page without event support as online when the browser says so', () => {
    const store = createConnectivityStore({ isOnline: () => true, target: undefined })
    const unsubscribe = store.subscribe(() => undefined)
    expect(store.getSnapshot()).toBe(true)
    unsubscribe()
  })
})

describe('resolveConnectivityAnnouncement', () => {
  test('announces a loss, and a return only after a loss', () => {
    expect(resolveConnectivityAnnouncement(true, true)).toBeUndefined()
    expect(resolveConnectivityAnnouncement(true, false)).toBe('offline')
    expect(resolveConnectivityAnnouncement(false, false)).toBeUndefined()
    expect(resolveConnectivityAnnouncement(false, true)).toBe('online')
  })
})

describe('ConnectivityNotice', () => {
  test('shows the offline notice only while offline and the update notice is not showing', () => {
    expect(renderToStaticMarkup(<ConnectivityNotice connectivity={fixedConnectivity(true)} />)).toBe('')
    expect(renderToStaticMarkup(<ConnectivityNotice connectivity={fixedConnectivity(false)} isUpdateNoticeShown />)).toBe('')
    const markup = renderToStaticMarkup(<ConnectivityNotice connectivity={fixedConnectivity(false)} />)
    // It shares the update notice's bottom-right slot, clear of the headers and the sidebar's
    // bottom-left navigation, and does not pass taps through.
    expect(markup).toContain('bottom-[max(1rem,env(safe-area-inset-bottom))]')
    expect(markup).toContain('sm:left-auto')
    expect(markup).not.toContain('top-0')
    expect(markup).not.toMatch(/(^|\s)left-4(\s|")/)
    expect(markup).not.toContain('pointer-events-none')
    expect(markup).toContain('data-testid="connectivity-notice"')
    expect(markup).toContain('オフラインです。')
    // The bar itself is not a live region; announcements use the persistent regions.
    expect(markup).not.toContain('role=')
  })
})

describe('publishBottomNoticeOffset', () => {
  test('publishes the notice height plus a gap and clears it once hidden', () => {
    const properties = new Map<string, string>()
    const style = {
      setProperty: (name: string, value: string | null) => { properties.set(name, value ?? '') },
      removeProperty: (name: string) => {
        const previous = properties.get(name) ?? ''
        properties.delete(name)
        return previous
      },
    }

    publishBottomNoticeOffset(style, 40.2)
    expect(properties.get(bottomNoticeOffsetProperty)).toBe('49px')
    publishBottomNoticeOffset(style, undefined)
    expect(properties.has(bottomNoticeOffsetProperty)).toBe(false)
  })
})
