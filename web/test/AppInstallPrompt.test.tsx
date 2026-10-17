import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { clearAuthSession, hasStoredAuthSession } from '../src/auth/session'
import {
  clearAppBadgeAndNotifyTabs,
  keepAppBadgePublished,
  refreshAppBadge,
  resolveAppBadgeAction,
  resolveAppBadgeCount,
  subscribeAppBadgeCleared,
  syncAppBadge,
  type AppBadgeChannel,
} from '../src/shared/lib/pwa/appBadge'
import {
  canRequestAppBadgePermission,
  createAppBadgePermissionStore,
  isAppBadgePermissionBlocked,
  isNotificationGatedBadgePlatform,
  requestAppBadgePermission,
  subscribeNotificationPermissionChanges,
  useAppBadgePermission,
  type AppBadgePermissionEnvironment,
  type AppBadgePermissionResult,
  type NotificationPermissionSource,
} from '../src/shared/lib/pwa/badgePermission'
import { createAppInstallPromptStore, resolveAppInstallAnnouncement } from '../src/shared/lib/pwa/installPrompt'
import { isStandaloneDisplay } from '../src/shared/lib/pwa/standaloneDisplay'
import { AppInstallCard, type AppBadgePermissionSectionProps } from '../src/shared/ui/AppInstallCard'

/**
 * Creates a `beforeinstallprompt` event with the browser's prompt API.
 *
 * @param outcome - Choice the fake dialog resolves with.
 * @returns The event and the number of times the dialog was shown.
 */
function createInstallEvent(outcome: 'accepted' | 'dismissed') {
  const shown = { count: 0 }
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt: async () => {
      shown.count += 1
    },
    userChoice: Promise.resolve({ outcome, platform: 'web' }),
  })
  return { event, shown }
}

describe('app install prompt', () => {
  test('keeps the browser prompt for the page and uses it once', async () => {
    const target = new EventTarget()
    const store = createAppInstallPromptStore(target, () => false)
    const statuses: string[] = []
    store.subscribe(() => statuses.push(store.getSnapshot()))
    store.start()
    expect(store.getSnapshot()).toBe('unavailable')

    const { event, shown } = createInstallEvent('accepted')
    target.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(store.getSnapshot()).toBe('available')

    const pending = store.prompt()
    expect(store.getSnapshot()).toBe('prompting')
    expect(await store.prompt()).toBe('unavailable')
    expect(await pending).toBe('accepted')
    expect(shown.count).toBe(1)
    expect(await store.prompt()).toBe('unavailable')
    target.dispatchEvent(new Event('appinstalled'))
    expect(store.getSnapshot()).toBe('installed')
    expect(statuses).toEqual(['available', 'prompting', 'unavailable', 'installed'])
  })

  test('reports a dismissed dialog and ignores events without the prompt API', async () => {
    const target = new EventTarget()
    const store = createAppInstallPromptStore(target, () => false)
    store.start()
    target.dispatchEvent(new Event('beforeinstallprompt', { cancelable: true }))
    expect(store.getSnapshot()).toBe('unavailable')
    target.dispatchEvent(createInstallEvent('dismissed').event)
    expect(await store.prompt()).toBe('dismissed')
  })

  test('reports a rejected browser prompt as failed instead of throwing', async () => {
    const target = new EventTarget()
    const store = createAppInstallPromptStore(target, () => false)
    store.start()
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt: async () => { throw new Error('InvalidStateError') },
      userChoice: new Promise(() => undefined),
    })
    target.dispatchEvent(event)
    expect(await store.prompt()).toBe('failed')
    expect(store.getSnapshot()).toBe('unavailable')
  })

  test('starts as installed inside the installed app', () => {
    const store = createAppInstallPromptStore(new EventTarget(), () => true)
    store.start()
    expect(store.getSnapshot()).toBe('installed')
  })
})

describe('AppInstallCard', () => {
  const props = {
    title: 'Install as an app',
    description: 'Install mukuroji.',
    installLabel: 'Install',
    pendingLabel: 'Waiting for the browser',
    acceptedMessage: 'Installing.',
    dismissedMessage: 'Installation was cancelled.',
    failedMessage: 'The browser could not open its install dialog.',
    installedMessage: 'Installed.',
    onInstall: () => undefined,
  }

  test('renders nothing until the browser offers in-page installation', () => {
    expect(renderToStaticMarkup(<AppInstallCard {...props} status="unavailable" />)).toBe('')
    expect(renderToStaticMarkup(<AppInstallCard {...props} status="available" />)).toContain('>Install</button>')
    const installed = renderToStaticMarkup(<AppInstallCard {...props} status="installed" />)
    expect(installed).toContain('Installed.')
    expect(installed).not.toContain('<button')
  })

  test('keeps an inert button while the dialog is open and announces the result', () => {
    const prompting = renderToStaticMarkup(<AppInstallCard {...props} status="prompting" />)
    expect(prompting).toContain('aria-disabled="true"')
    expect(prompting).toContain('>Waiting for the browser</button>')
    const dismissed = renderToStaticMarkup(<AppInstallCard {...props} outcome="dismissed" status="unavailable" />)
    expect(dismissed).toContain('role="status"')
    expect(dismissed).toContain('Installation was cancelled.')
    expect(dismissed).not.toContain('<button')
    expect(renderToStaticMarkup(<AppInstallCard {...props} outcome="failed" status="unavailable" />))
      .toContain('The browser could not open its install dialog.')
    // An accepted dialog followed by `appinstalled` keeps an announced, focusable result.
    const installedAfterAccept = renderToStaticMarkup(<AppInstallCard {...props} outcome="accepted" status="installed" />)
    expect(installedAfterAccept).toContain('role="status"')
    expect(installedAfterAccept).toContain('Installed.')
  })

  test('keeps a dismissal announced when the browser offers installation again right away', () => {
    // Chromium can fire a new `beforeinstallprompt` immediately after a dismissal.
    expect(resolveAppInstallAnnouncement({ initialStatus: 'available', status: 'available', outcome: 'dismissed' })).toBe('dismissed')
    expect(resolveAppInstallAnnouncement({ initialStatus: 'available', status: 'available', outcome: 'failed' })).toBe('failed')
    // Only an open dialog hides the previous result; the caller resets it on the next Install press.
    expect(resolveAppInstallAnnouncement({ initialStatus: 'available', status: 'prompting', outcome: 'dismissed' })).toBeUndefined()
    const reoffered = renderToStaticMarkup(<AppInstallCard {...props} outcome="dismissed" status="available" />)
    expect(reoffered).toContain('role="status" tabindex="-1">Installation was cancelled.</p>')
    expect(reoffered).toContain('>Install</button>')
  })

  test('announces an install from the browser menu but not an app that was already installed', () => {
    // Installed from the browser menu while the card was shown: announce without a card outcome.
    expect(resolveAppInstallAnnouncement({ initialStatus: 'available', status: 'installed' })).toBe('installed')
    expect(resolveAppInstallAnnouncement({ initialStatus: 'unavailable', status: 'installed' })).toBe('installed')
    // Already running installed when the card mounted: no announcement and no focus move.
    expect(resolveAppInstallAnnouncement({ initialStatus: 'installed', status: 'installed' })).toBeUndefined()
    expect(resolveAppInstallAnnouncement({ initialStatus: 'available', status: 'available' })).toBeUndefined()
    expect(resolveAppInstallAnnouncement({ initialStatus: 'available', status: 'installed', outcome: 'accepted' })).toBe('installed')
    expect(resolveAppInstallAnnouncement({ initialStatus: 'available', status: 'unavailable', outcome: 'dismissed' })).toBe('dismissed')
  })
})

describe('app badge', () => {
  test('keeps the badge while the count is unknown and clears it when signed out', () => {
    expect(resolveAppBadgeCount(true, undefined)).toBeUndefined()
    expect(resolveAppBadgeCount(true, 0)).toBe(0)
    expect(resolveAppBadgeCount(true, 4)).toBe(4)
    expect(resolveAppBadgeCount(false, 4)).toBe(0)
  })

  test('clears for a loaded zero and leaves the shared badge alone on a signed-out page', () => {
    expect(resolveAppBadgeAction(true, undefined)).toEqual({ kind: 'keep' })
    expect(resolveAppBadgeAction(true, 0)).toEqual({ kind: 'clear' })
    // A fresh signed-out tab must not clear another tab's count; sign-out clears in clearAuthSession.
    expect(resolveAppBadgeAction(false, 3)).toEqual({ kind: 'keep' })
    expect(resolveAppBadgeAction(false, undefined)).toEqual({ kind: 'keep' })
    expect(resolveAppBadgeAction(true, 3)).toEqual({ kind: 'show', count: 3 })
  })

  test('shows positive counts, clears otherwise, and tolerates missing support', async () => {
    const calls: string[] = []
    const navigator = {
      setAppBadge: async (count?: number) => {
        calls.push(`set:${count}`)
      },
      clearAppBadge: async () => {
        calls.push('clear')
        throw new Error('not allowed')
      },
    }
    syncAppBadge(3, navigator)
    syncAppBadge(0, navigator)
    syncAppBadge(undefined, navigator)
    syncAppBadge(2, {})
    syncAppBadge(2, undefined)
    await Promise.resolve()
    expect(calls).toEqual(['set:3', 'clear', 'clear'])
  })
})

describe('app badge across tabs', () => {
  /**
   * Creates in-memory broadcast channels that deliver to every other open channel.
   *
   * @returns A channel factory and the number of open channels.
   */
  function createChannelHub() {
    const open = new Set<AppBadgeChannel>()
    const openChannel = (): AppBadgeChannel => {
      const channel: AppBadgeChannel = {
        onmessage: null,
        postMessage: (message) => {
          for (const other of open) {
            if (other !== channel) other.onmessage?.(new MessageEvent('message', { data: message }))
          }
        },
        close: () => {
          open.delete(channel)
        },
      }
      open.add(channel)
      return channel
    }
    return { openChannel, openCount: () => open.size }
  }

  test('lets signed-in tabs republish after another session clears the badge', async () => {
    const hub = createChannelHub()
    const calls: string[] = []
    const navigator = {
      setAppBadge: async (count?: number) => { calls.push(`set:${count}`) },
      clearAppBadge: async () => { calls.push('clear') },
    }
    const republished: number[] = []
    const unsubscribe = subscribeAppBadgeCleared(() => republished.push(3), hub.openChannel)
    // Notices from this page itself, or malformed ones, are ignored.
    hub.openChannel().postMessage({ type: 'other' })
    expect(republished).toEqual([])

    await clearAppBadgeAndNotifyTabs(navigator, hub.openChannel)
    expect(calls).toEqual(['clear'])
    // This page's listener runs once, directly after the clear; its own broadcast is ignored,
    // and the listener's session check decides whether to republish.
    expect(republished).toEqual([3])
    unsubscribe()
    expect(hub.openCount()).toBe(1)
  })

  test('republishes on a clear notice from another page', () => {
    const hub = createChannelHub()
    const republished: number[] = []
    const unsubscribe = subscribeAppBadgeCleared(() => republished.push(3), hub.openChannel)
    hub.openChannel().postMessage({ type: 'cleared', pageId: 'another-page' })
    expect(republished).toEqual([3])
    unsubscribe()
  })

  test('sends the notice only after the clear settles, even when it fails', async () => {
    const order: string[] = []
    let finishClear: () => void = () => undefined
    const navigator = {
      clearAppBadge: () => new Promise<void>((_resolve, reject) => {
        finishClear = () => {
          order.push('cleared')
          reject(new Error('not allowed'))
        }
      }),
    }
    const channel: AppBadgeChannel = {
      onmessage: null,
      postMessage: () => { order.push('notice') },
      close: () => undefined,
    }
    const pending = clearAppBadgeAndNotifyTabs(navigator, () => channel)
    await Promise.resolve()
    expect(order).toEqual([])
    finishClear()
    await pending
    expect(order).toEqual(['cleared', 'notice'])
  })

  test('lets a session started on this page republish after a pending clear settles', async () => {
    let finishClear: () => void = () => undefined
    const navigator = {
      clearAppBadge: () => new Promise<void>((resolve) => { finishClear = resolve }),
    }
    const republished: string[] = []
    const pending = clearAppBadgeAndNotifyTabs(navigator, () => undefined)
    // The new session subscribes while the previous session's clear is still pending.
    const unsubscribe = subscribeAppBadgeCleared(() => republished.push('new session'), () => undefined)
    await Promise.resolve()
    expect(republished).toEqual([])
    finishClear()
    await pending
    expect(republished).toEqual(['new session'])
    unsubscribe()
  })

  test('never publishes a polled count after the shared session was signed out elsewhere', () => {
    const shown: number[] = []
    const stop = keepAppBadgePublished({
      count: 4,
      isSessionStored: () => false,
      refreshCount: async () => 4,
      sync: (count) => shown.push(count),
      subscribeCleared: () => () => undefined,
    })
    expect(shown).toEqual([])
    stop()
  })

  test('republishes after a clear notice, reapplying the known count when the reload fails', async () => {
    const shown: number[] = []
    let notifyCleared: () => void = () => undefined
    let refresh: () => Promise<unknown> = async () => 6
    const stop = keepAppBadgePublished({
      count: 4,
      isSessionStored: () => true,
      refreshCount: () => refresh(),
      sync: (count) => shown.push(count),
      subscribeCleared: (listener) => {
        notifyCleared = listener
        return () => undefined
      },
    })
    expect(shown).toEqual([4])
    notifyCleared()
    await Promise.resolve()
    await Promise.resolve()
    expect(shown).toEqual([4, 6])
    // A failed reload must not leave the badge cleared until the count changes.
    refresh = async () => {
      throw new Error('offline')
    }
    notifyCleared()
    await Promise.resolve()
    await Promise.resolve()
    expect(shown).toEqual([4, 6, 4])
    stop()
    notifyCleared()
    await Promise.resolve()
    await Promise.resolve()
    expect(shown).toEqual([4, 6, 4])
  })

  test('subscribes before the first publication and publishes only the latest refresh', async () => {
    const order: string[] = []
    const shown: number[] = []
    let notifyCleared: () => void = () => undefined
    const pending: ((count: number) => void)[] = []
    const stop = keepAppBadgePublished({
      count: 4,
      isSessionStored: () => true,
      refreshCount: () => new Promise((resolve) => { pending.push(resolve) }),
      sync: (count) => {
        order.push('publish')
        shown.push(count)
      },
      subscribeCleared: (listener) => {
        order.push('subscribe')
        notifyCleared = listener
        return () => undefined
      },
    })
    expect(order).toEqual(['subscribe', 'publish'])
    // Two clear notices start two refreshes; the older one resolves last with a stale count.
    notifyCleared()
    notifyCleared()
    pending[1]?.(7)
    await Promise.resolve()
    pending[0]?.(5)
    await Promise.resolve()
    await Promise.resolve()
    expect(shown).toEqual([4, 7])
    stop()
  })

  test('clears a refreshed zero through the coordinated clear so other tabs republish after it', async () => {
    const hub = createChannelHub()
    const operations: string[] = []
    const finishClears: (() => void)[] = []
    const navigator = {
      setAppBadge: async (count?: number) => { operations.push(`set:${count}`) },
      clearAppBadge: () => new Promise<void>((resolve) => {
        finishClears.push(() => {
          operations.push('cleared')
          resolve()
        })
      }),
    }
    let tabAClears = 0
    /**
     * Starts one tab's publisher on the shared fake badge.
     *
     * @param count - Count the tab loaded.
     * @param refreshed - Count the tab's reload returns.
     * @param clear - Coordinated clear the tab uses for a refreshed zero.
     * @returns Stops the publisher.
     */
    const startTab = (count: number, refreshed: number, clear?: () => Promise<void>) => keepAppBadgePublished({
      count,
      isSessionStored: () => true,
      refreshCount: async () => refreshed,
      sync: (value) => syncAppBadge(value, navigator),
      subscribeCleared: (listener) => subscribeAppBadgeCleared(listener, hub.openChannel),
      ...(clear ? { clear } : {}),
    })
    const settle = async () => {
      for (let index = 0; index < 6; index += 1) await Promise.resolve()
    }
    // Tab A's count drops to zero; tab B keeps five unread items.
    const stopA = startTab(4, 0, () => {
      tabAClears += 1
      return clearAppBadgeAndNotifyTabs(navigator, hub.openChannel)
    })
    const stopB = startTab(5, 5)
    // A third tab cleared the badge; both tabs reload their count.
    hub.openChannel().postMessage({ type: 'cleared', pageId: 'tab-c' })
    await settle()
    expect(operations).toEqual(['set:4', 'set:5', 'set:5'])
    // Tab A's clear lands late, after tab B already republished.
    for (const finish of finishClears.splice(0)) finish()
    await settle()
    // The coordinated clear tells tab B afterwards, so the shared badge ends on B's count.
    expect(operations.at(-1)).toBe('set:5')
    // Tab A ignores its own clear notice instead of re-clearing in a loop.
    expect(tabAClears).toBe(1)
    expect(finishClears).toEqual([])
    stopA()
    stopB()
  })

  test('works without BroadcastChannel', async () => {
    expect(() => subscribeAppBadgeCleared(() => undefined, () => undefined)()).not.toThrow()
    await expect(clearAppBadgeAndNotifyTabs({}, () => undefined)).resolves.toBeUndefined()
  })
})

/**
 * Creates a Notification-like object whose permission dialog resolves with a fixed answer.
 *
 * @param permission - Permission reported before the dialog.
 * @param answer - Answer the dialog resolves with, or an error it rejects with.
 * @returns The fake Notification API and how often its dialog was requested.
 */
function createNotification(permission: string, answer: string | Error = 'granted') {
  const requested = { count: 0 }
  const notification: NotificationPermissionSource = {
    permission,
    requestPermission: () => {
      requested.count += 1
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
    },
  }
  return { notification, requested }
}

describe('app badge permission', () => {
  const badgeNavigator = { setAppBadge: async () => undefined, clearAppBadge: async () => undefined }

  test('is offered only in the installed app with the Badging API and an unanswered Notification permission', () => {
    const environment = (overrides: Partial<AppBadgePermissionEnvironment>): AppBadgePermissionEnvironment => ({
      standalone: true,
      badgeRequiresNotificationPermission: true,
      navigator: badgeNavigator,
      notification: createNotification('default').notification,
      ...overrides,
    })
    expect(canRequestAppBadgePermission(environment({}))).toBe(true)
    expect(canRequestAppBadgePermission(environment({ standalone: false }))).toBe(false)
    // Chromium desktop apps show badges without permission, so they are never asked.
    expect(canRequestAppBadgePermission(environment({ badgeRequiresNotificationPermission: false }))).toBe(false)
    expect(canRequestAppBadgePermission(environment({ navigator: {} }))).toBe(false)
    expect(canRequestAppBadgePermission(environment({ navigator: undefined }))).toBe(false)
    expect(canRequestAppBadgePermission(environment({ notification: undefined }))).toBe(false)
    expect(canRequestAppBadgePermission(environment({ notification: createNotification('granted').notification }))).toBe(false)
    expect(canRequestAppBadgePermission(environment({ notification: createNotification('denied').notification }))).toBe(false)
  })

  test('treats only Apple WebKit as needing notification permission for the badge', () => {
    const chromeWindows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
    const chromeMac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
    const chromeOs = 'Mozilla/5.0 (X11; CrOS x86_64 16181.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
    const iPhone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    const iPadDesktop = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
    expect(isNotificationGatedBadgePlatform({ userAgent: chromeWindows, platform: 'Win32', maxTouchPoints: 0, hasStandaloneProperty: false })).toBe(false)
    expect(isNotificationGatedBadgePlatform({ userAgent: chromeMac, platform: 'MacIntel', maxTouchPoints: 0, hasStandaloneProperty: false })).toBe(false)
    expect(isNotificationGatedBadgePlatform({ userAgent: chromeOs, platform: 'Linux x86_64', maxTouchPoints: 10, hasStandaloneProperty: false })).toBe(false)
    expect(isNotificationGatedBadgePlatform({ userAgent: iPhone, platform: 'iPhone', maxTouchPoints: 5, hasStandaloneProperty: true })).toBe(true)
    expect(isNotificationGatedBadgePlatform({ userAgent: iPhone, hasStandaloneProperty: false })).toBe(true)
    // iPadOS requesting the desktop site reports a Mac user agent but has touch points.
    expect(isNotificationGatedBadgePlatform({ userAgent: iPadDesktop, platform: 'MacIntel', maxTouchPoints: 5, hasStandaloneProperty: false })).toBe(true)
    expect(isNotificationGatedBadgePlatform({ userAgent: iPadDesktop, platform: 'MacIntel', maxTouchPoints: 0, hasStandaloneProperty: true })).toBe(true)
    // macOS Safari web apps badge only with notification permission; other macOS browsers do not need it.
    const safariMac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
    const edgeMac = `${chromeMac} Edg/140.0.0.0`
    const firefoxMac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0'
    expect(isNotificationGatedBadgePlatform({ userAgent: safariMac, platform: 'MacIntel', maxTouchPoints: 0, hasStandaloneProperty: false })).toBe(true)
    expect(isNotificationGatedBadgePlatform({ userAgent: edgeMac, platform: 'MacIntel', maxTouchPoints: 0, hasStandaloneProperty: false })).toBe(false)
    expect(isNotificationGatedBadgePlatform({ userAgent: firefoxMac, platform: 'MacIntel', maxTouchPoints: 0, hasStandaloneProperty: false })).toBe(false)
  })

  test('shows blocked guidance after a reload when notifications were denied earlier, only where the badge needs them', () => {
    const denied = createNotification('denied')
    const environment = {
      standalone: true,
      badgeRequiresNotificationPermission: true,
      navigator: badgeNavigator,
      notification: denied.notification,
    }
    expect(isAppBadgePermissionBlocked(environment)).toBe(true)
    expect(isAppBadgePermissionBlocked({ ...environment, badgeRequiresNotificationPermission: false })).toBe(false)
    expect(isAppBadgePermissionBlocked({ ...environment, standalone: false })).toBe(false)
    expect(isAppBadgePermissionBlocked({ ...environment, notification: createNotification('default').notification })).toBe(false)
    // A fresh store on a reloaded page derives the block without asking.
    const store = createAppBadgePermissionStore({
      readEnvironment: () => environment,
      subscribeLifecycle: () => () => undefined,
      refreshBadge: () => undefined,
    })
    expect(store.getSnapshot()).toEqual({ offered: false, pending: false, blocked: true })
    expect(denied.requested.count).toBe(0)
    const chromeDesktop = createAppBadgePermissionStore({
      readEnvironment: () => ({ ...environment, badgeRequiresNotificationPermission: false }),
      subscribeLifecycle: () => () => undefined,
    })
    expect(chromeDesktop.getSnapshot()).toEqual({ offered: false, pending: false, blocked: false })
  })

  test('detects standalone from the display-mode query or iOS navigator.standalone', () => {
    const query = (matches: boolean) => () => ({ matches })
    expect(isStandaloneDisplay({ matchMedia: query(true), navigator: {} })).toBe(true)
    // An iOS Home Screen app identified only by `navigator.standalone`.
    expect(isStandaloneDisplay({ matchMedia: query(false), navigator: { standalone: true } })).toBe(true)
    expect(isStandaloneDisplay({ navigator: { standalone: true } })).toBe(true)
    expect(isStandaloneDisplay({ matchMedia: query(false), navigator: { standalone: false } })).toBe(false)
    expect(isStandaloneDisplay({ matchMedia: query(false) })).toBe(false)
    expect(isStandaloneDisplay(undefined)).toBe(false)
  })

  test('asks within the calling click and refreshes the badge only after a grant', async () => {
    const granted = createNotification('default', 'granted')
    let refreshed = 0
    const pending = requestAppBadgePermission(granted.notification, () => { refreshed += 1 })
    // The dialog is requested synchronously, while the user gesture is still active.
    expect(granted.requested.count).toBe(1)
    expect(await pending).toBe('granted')
    expect(refreshed).toBe(1)

    const answers: [string, AppBadgePermissionResult][] = [['denied', 'denied'], ['default', 'dismissed'], ['prompt', 'unsupported']]
    for (const [answer, expected] of answers) {
      expect(await requestAppBadgePermission(createNotification('default', answer).notification, () => { refreshed += 1 })).toBe(expected)
    }
    expect(await requestAppBadgePermission(createNotification('default', new TypeError('no gesture')).notification, () => { refreshed += 1 }))
      .toBe('unsupported')
    expect(await requestAppBadgePermission(undefined, () => { refreshed += 1 })).toBe('unsupported')
    expect(refreshed).toBe(1)
  })

  test('never asks for permission while rendering', () => {
    const { notification, requested } = createNotification('default')
    /**
     * Renders the opt-in state as text.
     *
     * @returns Whether the opt-in is offered.
     */
    function Probe() {
      const state = useAppBadgePermission({
        readEnvironment: () => ({ standalone: true, badgeRequiresNotificationPermission: true, navigator: badgeNavigator, notification }),
        subscribeLifecycle: () => () => undefined,
      })
      return <span>{String(state.offered)}</span>
    }
    expect(renderToStaticMarkup(<Probe />)).toBe('<span>true</span>')
    expect(requested.count).toBe(0)
  })

  test('clears the previous answer when a retry starts so a repeated dismissal is announced again', async () => {
    const { notification, requested } = createNotification('default', 'default')
    const store = createAppBadgePermissionStore({
      readEnvironment: () => ({ standalone: true, badgeRequiresNotificationPermission: true, navigator: badgeNavigator, notification }),
      subscribeLifecycle: () => () => undefined,
      refreshBadge: () => undefined,
    })
    const results: (string | undefined)[] = []
    const unsubscribe = store.subscribe(() => results.push(store.getSnapshot().result))
    store.request()
    // The dialog is requested within the click, before any state is published.
    expect(requested.count).toBe(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getSnapshot()).toEqual({ offered: true, pending: false, blocked: false, result: 'dismissed' })
    store.request()
    expect(store.getSnapshot()).toEqual({ offered: true, pending: true, blocked: false })
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getSnapshot().result).toBe('dismissed')
    // Each attempt passes through an unanswered state, so the status remounts and is announced.
    expect(results).toEqual([undefined, 'dismissed', undefined, 'dismissed'])
    unsubscribe()
  })

  test('clears a stale denied answer and refreshes the badge after notifications are allowed in device settings', async () => {
    const notification = {
      permission: 'default',
      requestPermission: async () => {
        notification.permission = 'denied'
        return 'denied'
      },
    }
    let lifecycleChanged: () => void = () => undefined
    let lifecycleStopped = 0
    let refreshed = 0
    const store = createAppBadgePermissionStore({
      readEnvironment: () => ({ standalone: true, badgeRequiresNotificationPermission: true, navigator: badgeNavigator, notification }),
      subscribeLifecycle: (onChange) => {
        lifecycleChanged = onChange
        return () => { lifecycleStopped += 1 }
      },
      refreshBadge: () => { refreshed += 1 },
    })
    const unsubscribe = store.subscribe(() => undefined)
    store.request()
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getSnapshot()).toEqual({ offered: false, pending: false, blocked: true, result: 'denied' })
    // Returning without a permission change keeps the answer and the same snapshot.
    const before = store.getSnapshot()
    lifecycleChanged()
    expect(store.getSnapshot()).toBe(before)
    expect(refreshed).toBe(0)
    // The user allows notifications in the device settings and returns without reloading.
    notification.permission = 'granted'
    lifecycleChanged()
    expect(store.getSnapshot()).toEqual({ offered: false, pending: false, blocked: false })
    expect(refreshed).toBe(1)
    // A reset back to "ask" offers the button again.
    notification.permission = 'default'
    lifecycleChanged()
    expect(store.getSnapshot()).toEqual({ offered: true, pending: false, blocked: false })
    unsubscribe()
    expect(lifecycleStopped).toBe(1)
  })

  test('watches focus, visibility, and Permissions API changes until unsubscribed', async () => {
    const windowTarget = new EventTarget()
    const documentTarget = new EventTarget()
    const permissionStatus = new EventTarget()
    let changes = 0
    const stop = subscribeNotificationPermissionChanges(() => { changes += 1 }, {
      window: windowTarget,
      document: documentTarget,
      permissions: { query: async () => permissionStatus },
    })
    await Promise.resolve()
    windowTarget.dispatchEvent(new Event('focus'))
    documentTarget.dispatchEvent(new Event('visibilitychange'))
    permissionStatus.dispatchEvent(new Event('change'))
    expect(changes).toBe(3)
    stop()
    windowTarget.dispatchEvent(new Event('focus'))
    documentTarget.dispatchEvent(new Event('visibilitychange'))
    permissionStatus.dispatchEvent(new Event('change'))
    expect(changes).toBe(3)
    // Browsers that cannot query `notifications` still reconcile on focus.
    const fallback = subscribeNotificationPermissionChanges(() => { changes += 1 }, {
      window: windowTarget,
      document: undefined,
      permissions: { query: () => Promise.reject(new TypeError('unsupported')) },
    })
    await Promise.resolve()
    windowTarget.dispatchEvent(new Event('focus'))
    expect(changes).toBe(4)
    fallback()
  })

  test('republishes the signed-in count when the badge is refreshed after a grant', async () => {
    const shown: number[] = []
    const stop = keepAppBadgePublished({
      count: 4,
      isSessionStored: () => true,
      refreshCount: async () => 5,
      sync: (count) => shown.push(count),
      subscribeCleared: (listener) => subscribeAppBadgeCleared(listener, () => undefined),
    })
    expect(shown).toEqual([4])
    refreshAppBadge()
    await Promise.resolve()
    await Promise.resolve()
    expect(shown).toEqual([4, 5])
    stop()
    refreshAppBadge()
    await Promise.resolve()
    await Promise.resolve()
    expect(shown).toEqual([4, 5])
  })

  test('shows the opt-in in the install card and announces each answer', () => {
    const cardProps = {
      title: 'Install as an app',
      description: 'Install mukuroji.',
      installLabel: 'Install',
      pendingLabel: 'Waiting for the browser',
      acceptedMessage: 'Installing.',
      dismissedMessage: 'Installation was cancelled.',
      failedMessage: 'The browser could not open its install dialog.',
      installedMessage: 'Installed.',
      onInstall: () => undefined,
    }
    const badge: AppBadgePermissionSectionProps = {
      offered: true,
      pending: false,
      description: 'Allow notifications to show the badge. No push notifications are sent.',
      actionLabel: 'Allow icon badge',
      pendingLabel: 'Waiting for your choice',
      grantedMessage: 'Badge allowed.',
      deniedMessage: 'Badge blocked.',
      dismissedMessage: 'No choice.',
      unsupportedMessage: 'Cannot ask.',
      onRequest: () => undefined,
    }
    const offered = renderToStaticMarkup(<AppInstallCard {...cardProps} badgePermission={badge} status="installed" />)
    expect(offered).toContain('>Allow icon badge</button>')
    expect(offered).toContain('No push notifications are sent.')
    expect(offered).not.toContain('role="status"')
    // Not offered and not yet answered: no opt-in row, and an unavailable card stays hidden.
    expect(renderToStaticMarkup(<AppInstallCard {...cardProps} badgePermission={{ ...badge, offered: false }} status="installed" />))
      .not.toContain('app-badge-permission')
    expect(renderToStaticMarkup(<AppInstallCard {...cardProps} badgePermission={{ ...badge, offered: false }} status="unavailable" />)).toBe('')
    // A Home Screen app that the install store does not report as installed still offers the opt-in.
    expect(renderToStaticMarkup(<AppInstallCard {...cardProps} badgePermission={badge} status="unavailable" />)).toContain('>Allow icon badge</button>')
    // A block found on load shows the guidance as static text, without a live region or button.
    const blocked = renderToStaticMarkup(<AppInstallCard {...cardProps} badgePermission={{ ...badge, offered: false, blocked: true }} status="installed" />)
    expect(blocked).toContain('<p class="mt-1 text-sm text-[var(--workbench-text)]">Badge blocked.</p>')
    expect(blocked).not.toContain('role="status"')
    expect(blocked).not.toContain('>Allow icon badge</button>')
    const pending = renderToStaticMarkup(<AppInstallCard {...cardProps} badgePermission={{ ...badge, pending: true }} status="installed" />)
    expect(pending).toContain('aria-disabled="true"')
    expect(pending).toContain('>Waiting for your choice</button>')
    const results: [AppBadgePermissionResult, string][] = [['granted', 'Badge allowed.'], ['denied', 'Badge blocked.'], ['dismissed', 'No choice.'], ['unsupported', 'Cannot ask.']]
    for (const [result, message] of results) {
      // After a grant or a block the permission is no longer `default`, so only the status remains.
      const answered = renderToStaticMarkup(<AppInstallCard {...cardProps} badgePermission={{ ...badge, offered: result === 'dismissed', result }} status="installed" />)
      expect(answered).toContain(`role="status" tabindex="-1">${message}</p>`)
      expect(answered.includes('>Allow icon badge</button>')).toBe(result === 'dismissed')
    }
  })
})

describe('hasStoredAuthSession', () => {
  test('requires the same unexpired token in storage', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => { values.delete(key) },
    }
    const previousWindow = Reflect.get(globalThis, 'window')
    Reflect.set(globalThis, 'window', { localStorage: storage, sessionStorage: { getItem: () => null } })
    try {
      expect(hasStoredAuthSession('token-a')).toBe(false)
      values.set('mukuroji.auth', JSON.stringify({ accessToken: 'token-a', expiresAt: Date.now() + 60_000, tokenType: 'Bearer', remember: true }))
      expect(hasStoredAuthSession('token-a')).toBe(true)
      // A shared remembered session signed out elsewhere, or replaced by another sign-in.
      expect(hasStoredAuthSession('token-b')).toBe(false)
      values.set('mukuroji.auth', JSON.stringify({ accessToken: 'token-a', expiresAt: Date.now() - 1, tokenType: 'Bearer', remember: true }))
      expect(hasStoredAuthSession('token-a')).toBe(false)
      // Checking never clears storage.
      expect(values.has('mukuroji.auth')).toBe(true)
    } finally {
      Reflect.set(globalThis, 'window', previousWindow)
    }
  })
})

describe('hasStoredAuthSession across stores', () => {
  test('finds a session-only token even when another remembered session is in localStorage', () => {
    const session = (accessToken: string, remember: boolean) => JSON.stringify({ accessToken, expiresAt: Date.now() + 60_000, tokenType: 'Bearer', remember })
    const previousWindow = Reflect.get(globalThis, 'window')
    Reflect.set(globalThis, 'window', {
      localStorage: { getItem: () => session('token-remembered', true) },
      sessionStorage: { getItem: () => session('token-tab', false) },
    })
    try {
      expect(hasStoredAuthSession('token-tab')).toBe(true)
      expect(hasStoredAuthSession('token-remembered')).toBe(true)
      expect(hasStoredAuthSession('token-other')).toBe(false)
    } finally {
      Reflect.set(globalThis, 'window', previousWindow)
    }
  })
})

describe('clearAuthSession', () => {
  test('clears the app badge on every session destruction', async () => {
    const calls: string[] = []
    const storage = { removeItem: () => undefined }
    const previousWindow = Reflect.get(globalThis, 'window')
    const previousNavigator = Reflect.get(globalThis, 'navigator')
    Reflect.set(globalThis, 'window', { localStorage: storage, sessionStorage: storage })
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clearAppBadge: async () => { calls.push('clear') } },
    })
    try {
      clearAuthSession()
      await Promise.resolve()
      expect(calls).toEqual(['clear'])
    } finally {
      Reflect.set(globalThis, 'window', previousWindow)
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator })
    }
  })
})
