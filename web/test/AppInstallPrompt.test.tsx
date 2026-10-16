import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { syncAppBadge } from '../src/shared/lib/pwa/appBadge'
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

    expect(await store.prompt()).toBe('accepted')
    expect(shown.count).toBe(1)
    expect(await store.prompt()).toBe('unavailable')
    target.dispatchEvent(new Event('appinstalled'))
    expect(store.getSnapshot()).toBe('installed')
    expect(statuses).toEqual(['available', 'unavailable', 'installed'])
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
})

describe('app badge', () => {
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
