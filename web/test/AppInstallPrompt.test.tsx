import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { clearAuthSession, hasStoredAuthSession } from '../src/auth/session'
import {
  clearAppBadgeAndNotifyTabs,
  resolveAppBadgeAction,
  resolveAppBadgeCount,
  subscribeAppBadgeCleared,
  syncAppBadge,
  type AppBadgeChannel,
} from '../src/shared/lib/pwa/appBadge'
import { createAppInstallPromptStore } from '../src/shared/lib/pwa/installPrompt'
import { AppInstallCard } from '../src/shared/ui/AppInstallCard'

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
})

describe('app badge', () => {
  test('keeps the badge while the count is unknown and clears it when signed out', () => {
    expect(resolveAppBadgeCount(true, undefined)).toBeUndefined()
    expect(resolveAppBadgeCount(true, 0)).toBe(0)
    expect(resolveAppBadgeCount(true, 4)).toBe(4)
    expect(resolveAppBadgeCount(false, 4)).toBe(0)
  })

  test('tells other tabs about a loaded zero but not about a sign-out, which already did', () => {
    expect(resolveAppBadgeAction(true, undefined)).toEqual({ kind: 'keep' })
    expect(resolveAppBadgeAction(true, 0)).toEqual({ kind: 'clear', notifyTabs: true })
    expect(resolveAppBadgeAction(false, 3)).toEqual({ kind: 'clear', notifyTabs: false })
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

  test('works without BroadcastChannel', async () => {
    expect(() => subscribeAppBadgeCleared(() => undefined, () => undefined)()).not.toThrow()
    await expect(clearAppBadgeAndNotifyTabs({}, () => undefined)).resolves.toBeUndefined()
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
