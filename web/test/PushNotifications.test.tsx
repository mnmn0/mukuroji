import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  disablePushDevice,
  disconnectPushDeviceOnSignOut,
  enablePushDevice,
  signOutWithPushCleanup,
  type PushDeviceController,
} from '../src/notifications/mutations/usePushDevice'
import {
  loadPushDevice,
  refreshPushDevice,
  type PushDeviceApi,
} from '../src/notifications/queries/usePushDeviceStatus'
import { NotificationsApiError } from '../src/notifications/api/errors'
import { PushDeviceSettings } from '../src/notifications/ui/PushDeviceSettings'
import {
  defaultNotificationPath,
  defaultNotificationTitle,
  readNotificationClickPath,
  readNotificationPath,
  readPushNotification,
  selectNotificationClient,
} from '../src/service-worker/model/pushNotification'
import { isSafeApplicationPath } from '../src/shared/routing/applicationPath'
import {
  decodeBase64Url,
  readServiceWorkerRegistration,
  matchesApplicationServerKey,
  readPushSubscriptionInput,
  type BrowserPushManager,
  type BrowserPushSubscription,
  type PushEnvironment,
} from '../src/shared/lib/pwa/pushSubscription'

const vapidPublicKey = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)]).toString('base64url')
const otherKey = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 8)]).toString('base64url')
const endpoint = 'https://fcm.googleapis.com/fcm/send/device'

/**
 * Creates a fake browser subscription.
 *
 * @param key - Application server key it is bound to.
 * @param log - Records unsubscribe calls.
 * @returns The subscription.
 */
function createSubscription(key: string, log: string[]): BrowserPushSubscription {
  return {
    endpoint,
    options: { applicationServerKey: decodeBase64Url(key).buffer },
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: async () => {
      log.push(`unsubscribe ${key === vapidPublicKey ? 'current' : 'old'}`)
      return true
    },
  }
}

/**
 * Creates a fake environment with a scripted permission and subscription.
 *
 * @param options - Permission, existing subscription key, and the permission answer.
 * @returns The environment and the calls it received.
 */
function createEnvironment(options: { permission?: string, existingKey?: string, answer?: string } = {}) {
  const log: string[] = []
  let current = options.existingKey ? createSubscription(options.existingKey, log) : null
  const pushManager: BrowserPushManager = {
    getSubscription: async () => current,
    subscribe: async ({ applicationServerKey }) => {
      log.push(`subscribe ${applicationServerKey.length}`)
      current = createSubscription(vapidPublicKey, log)
      return current
    },
  }
  const notification = {
    permission: options.permission ?? 'default',
    requestPermission: async () => {
      log.push('request')
      return options.answer ?? 'granted'
    },
  }
  const environment: PushEnvironment = {
    supported: true,
    notification,
    getPushManager: async () => pushManager,
  }
  return { environment, log }
}

/**
 * Creates fake server calls.
 *
 * @param options - Whether push is enabled and whether registration fails.
 * @returns The API and the calls it received.
 */
function createApi(options: { enabled?: boolean, registerFails?: boolean } = {}) {
  const calls: string[] = []
  const api: PushDeviceApi = {
    getConfiguration: async () => (options.enabled === false ? { enabled: false } : { enabled: true, vapidPublicKey }),
    register: async (token, subscription) => {
      calls.push(`register ${token} ${subscription.endpoint}`)
      if (options.registerFails) throw new Error('rejected')
    },
    remove: async (token, removal) => {
      calls.push(`remove ${token} ${removal.endpoint}`)
    },
  }
  return { api, calls }
}

describe('push subscription helpers', () => {
  test('decodes base64url keys and matches the bound key', () => {
    expect(Buffer.from(decodeBase64Url(vapidPublicKey)).toString('base64url')).toBe(vapidPublicKey)
    const subscription = createSubscription(vapidPublicKey, [])
    expect(matchesApplicationServerKey(subscription, vapidPublicKey)).toBe(true)
    expect(matchesApplicationServerKey(subscription, otherKey)).toBe(false)
    expect(readPushSubscriptionInput(subscription)).toEqual({ endpoint, keys: { p256dh: 'p', auth: 'a' } })
    expect(readPushSubscriptionInput({ ...subscription, toJSON: () => ({ endpoint }) })).toBeUndefined()
  })
})

describe('push device controller', () => {
  test('reports unsupported, disabled, blocked, and load errors without asking for permission', async () => {
    const { api } = createApi()
    expect(await loadPushDevice('t', { supported: false, notification: undefined, getPushManager: async () => undefined }, api))
      .toEqual({ status: 'unsupported' })
    expect((await loadPushDevice('t', createEnvironment().environment, createApi({ enabled: false }).api)).status).toBe('disabled')
    const blocked = createEnvironment({ permission: 'denied' })
    expect((await loadPushDevice('t', blocked.environment, api)).status).toBe('blocked')
    expect(blocked.log).toEqual([])
    const failing: PushDeviceApi = { ...api, getConfiguration: async () => { throw new Error('offline') } }
    expect((await loadPushDevice('t', createEnvironment().environment, failing)).status).toBe('load-error')
  })

  test('refreshes an active registration and treats a subscription for an old key as off', async () => {
    const active = createApi()
    expect((await loadPushDevice('t', createEnvironment({ permission: 'granted', existingKey: vapidPublicKey }).environment, active.api)).status).toBe('on')
    expect(active.calls).toEqual([`register t ${endpoint}`])
    const stale = createApi()
    expect((await loadPushDevice('t', createEnvironment({ permission: 'granted', existingKey: otherKey }).environment, stale.api)).status).toBe('off')
    expect(stale.calls).toEqual([])
  })

  test('shows what a refused refresh reveals and keeps the device on after transient failures', async () => {
    const environment = () => createEnvironment({ permission: 'granted', existingKey: vapidPublicKey }).environment
    const failing = (error: unknown): PushDeviceApi => ({
      ...createApi().api,
      register: async () => { throw error },
    })
    const statusAfter = async (error: unknown) => (await loadPushDevice('t', environment(), failing(error))).status
    expect(await statusAfter(new Error('offline'))).toBe('on')
    expect(await statusAfter(new NotificationsApiError(503, 'down'))).toBe('on')
    expect(await statusAfter(new NotificationsApiError(409, 'off', 'PushNotificationsDisabled'))).toBe('disabled')
    for (const code of ['InvalidPushSubscription', 'PushSubscriptionForbidden', 'PushSubscriptionLimitExceeded', 'PushSubscriptionConflict']) {
      expect(await statusAfter(new NotificationsApiError(code === 'InvalidPushSubscription' ? 400 : 409, code, code)), code).toBe('off')
    }
    expect(await statusAfter(new NotificationsApiError(401, 'expired'))).toBe('load-error')
  })

  test('enables after permission, replacing a subscription made for an old key', async () => {
    const { environment, log } = createEnvironment({ existingKey: otherKey })
    const { api, calls } = createApi()
    expect(await enablePushDevice('t', vapidPublicKey, environment, api)).toBe('enabled')
    expect(log).toEqual(['request', 'unsubscribe old', 'subscribe 65'])
    // The old endpoint is removed on the server too, so it stops counting and receiving.
    expect(calls).toEqual([`remove t ${endpoint}`, `register t ${endpoint}`])
  })

  test('recreates an existing subscription whose keys the browser no longer exposes', async () => {
    const { environment, log } = createEnvironment({ permission: 'granted' })
    const keyless: BrowserPushSubscription = {
      ...createSubscription(vapidPublicKey, log),
      toJSON: () => ({ endpoint }),
    }
    const pushManager: BrowserPushManager = {
      getSubscription: async () => keyless,
      subscribe: async () => {
        log.push('subscribe')
        return createSubscription(vapidPublicKey, log)
      },
    }
    const { api, calls } = createApi()
    expect(await enablePushDevice('t', vapidPublicKey, { ...environment, getPushManager: async () => pushManager }, api)).toBe('enabled')
    expect(log).toEqual(['unsubscribe current', 'subscribe'])
    expect(calls).toEqual([`remove t ${endpoint}`, `register t ${endpoint}`])
  })

  test('reports an unreadable push store as a retryable load error', async () => {
    const { environment } = createEnvironment({ permission: 'granted' })
    const failing: BrowserPushManager = {
      getSubscription: async () => { throw new Error('unavailable') },
      subscribe: async () => { throw new Error('unused') },
    }
    expect((await loadPushDevice('t', { ...environment, getPushManager: async () => failing }, createApi().api)).status)
      .toBe('load-error')
  })

  test('reports a failed service worker lookup as a retryable load error, not as unsupported', async () => {
    const { environment } = createEnvironment({ permission: 'granted' })
    const failing: PushEnvironment = { ...environment, getPushManager: async () => { throw new Error('storage') } }
    expect((await loadPushDevice('t', failing, createApi().api)).status).toBe('load-error')
  })

  test('waits for the first service worker registration, but not forever', async () => {
    const registration = { pushManager: {} }
    const later = {
      getRegistration: async (): Promise<typeof registration | undefined> => undefined,
      ready: Promise.resolve(registration),
    }
    expect(await readServiceWorkerRegistration(later, 50)).toBe(registration)
    const never = {
      getRegistration: async (): Promise<typeof registration | undefined> => undefined,
      ready: new Promise<typeof registration>(() => undefined),
    }
    expect(await readServiceWorkerRegistration(never, 10)).toBeUndefined()
  })

  test('reports a dismissed or denied permission without subscribing', async () => {
    const dismissed = createEnvironment({ answer: 'default' })
    expect(await enablePushDevice('t', vapidPublicKey, dismissed.environment, createApi().api)).toBe('dismissed')
    const denied = createEnvironment({ answer: 'denied' })
    expect(await enablePushDevice('t', vapidPublicKey, denied.environment, createApi().api)).toBe('denied')
    expect([...dismissed.log, ...denied.log]).toEqual(['request', 'request'])
  })

  test('cancels a new subscription the server rejected', async () => {
    const { environment, log } = createEnvironment({ permission: 'granted' })
    expect(await enablePushDevice('t', vapidPublicKey, environment, createApi({ registerFails: true }).api)).toBe('failed')
    expect(log).toEqual(['subscribe 65', 'unsubscribe current'])
  })

  test('disables on the server and in the browser', async () => {
    const { environment, log } = createEnvironment({ permission: 'granted', existingKey: vapidPublicKey })
    const { api, calls } = createApi()
    expect(await disablePushDevice('t', environment, api)).toBe('disabled')
    expect(calls).toEqual([`remove t ${endpoint}`])
    expect(log).toEqual(['unsubscribe current'])
  })

  test('removes the device on sign-out and refreshes only opted-in devices', async () => {
    const signedOut = createEnvironment({ permission: 'granted', existingKey: vapidPublicKey })
    const removal = createApi()
    await disconnectPushDeviceOnSignOut('t', signedOut.environment, removal.api)
    expect(removal.calls).toEqual([`remove t ${endpoint}`])
    expect(signedOut.log).toEqual(['unsubscribe current'])

    // The browser subscription is cancelled even when the server removal hangs.
    const hanging = createEnvironment({ permission: 'granted', existingKey: vapidPublicKey })
    const pending = disconnectPushDeviceOnSignOut('t', hanging.environment, {
      ...createApi().api,
      remove: () => new Promise<void>(() => undefined),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(hanging.log).toEqual(['unsubscribe current'])
    void pending

    const notOptedIn = createApi()
    await refreshPushDevice('t', createEnvironment({ permission: 'granted' }).environment, notOptedIn.api)
    await refreshPushDevice('t', createEnvironment({ existingKey: vapidPublicKey }).environment, notOptedIn.api)
    expect(notOptedIn.calls).toEqual([])
    const optedIn = createApi()
    await refreshPushDevice('t', createEnvironment({ permission: 'granted', existingKey: vapidPublicKey }).environment, optedIn.api)
    expect(optedIn.calls).toEqual([`register t ${endpoint}`])
  })
})

describe('sign-out with push cleanup', () => {
  /**
   * Runs a sign-out against in-memory session storage.
   *
   * @param cleanup - Push cleanup to wait for.
   * @param waitMilliseconds - Longest wait for the cleanup.
   * @returns The order of cleanup and session clearing.
   */
  async function signOut(cleanup: () => Promise<void>, waitMilliseconds: number): Promise<string[]> {
    const order: string[] = []
    const storage = { removeItem: () => { order.push('session cleared') } }
    const previousWindow = Reflect.get(globalThis, 'window')
    Reflect.set(globalThis, 'window', { localStorage: storage, sessionStorage: storage })
    try {
      await signOutWithPushCleanup('t', async () => {
        await cleanup()
        order.push('push cleaned')
      }, waitMilliseconds)
    } finally {
      Reflect.set(globalThis, 'window', previousWindow)
    }
    return order
  }

  test('clears the session only after the push cleanup, so the page cannot go away first', async () => {
    expect(await signOut(async () => undefined, 1_000)).toEqual(['push cleaned', 'session cleared', 'session cleared'])
  })

  test('stops waiting for a hung cleanup and still signs out', async () => {
    expect(await signOut(() => new Promise<void>(() => undefined), 10)).toEqual(['session cleared', 'session cleared'])
  })
})

describe('push device settings card', () => {
  const controller: PushDeviceController = {
    status: 'off',
    pending: false,
    enable: () => undefined,
    disable: () => undefined,
    retry: () => undefined,
  }

  test('offers the toggle only when it can change, and announces outcomes', () => {
    const off = renderToStaticMarkup(<PushDeviceSettings controller={controller} locale="en" />)
    expect(off).toContain('Receive on this device')
    const on = renderToStaticMarkup(<PushDeviceSettings controller={{ ...controller, status: 'on', result: 'enabled' }} locale="en" />)
    expect(on).toContain('Stop on this device')
    expect(on).toContain('This device is registered.')
    const pending = renderToStaticMarkup(<PushDeviceSettings controller={{ ...controller, pending: true }} locale="en" />)
    expect(pending).toContain('aria-disabled="true"')
    const blocked = renderToStaticMarkup(<PushDeviceSettings controller={{ ...controller, status: 'blocked' }} locale="ja" />)
    expect(blocked).not.toContain('data-testid="push-device-toggle"')
    expect(blocked).toContain('通知がブロックされています')
    const loadError = renderToStaticMarkup(<PushDeviceSettings controller={{ ...controller, status: 'load-error' }} locale="en" />)
    expect(loadError).toContain('Could not load the push notification status.')
  })
})

describe('service worker push notifications', () => {
  test('always shows a notification and only opens same-origin paths', () => {
    expect(readPushNotification({ title: ' New comment ', body: 'Ada replied', path: '/inbox?n=1', tag: 'notification:1' })).toEqual({
      title: 'New comment',
      body: 'Ada replied',
      path: '/inbox?n=1',
      tag: 'notification:1',
    })
    expect(readPushNotification(undefined)).toEqual({ title: defaultNotificationTitle, path: defaultNotificationPath })
    expect(readPushNotification({ title: 'x'.repeat(200), path: 'https://evil.example', tag: 'bad tag' })).toEqual({
      title: `${'x'.repeat(119)}…`,
      path: defaultNotificationPath,
    })
    expect(readNotificationClickPath({ path: '//evil.example/x' })).toBe(defaultNotificationPath)
    expect(readNotificationClickPath({ path: '/teams/t/issues/1' })).toBe('/teams/t/issues/1')
  })

  test('accepts exactly the paths the app treats as safe deep links', () => {
    for (const path of ['/inbox', '/a?b=c#d', '//evil.example', '/\\evil', '/a\nb', 'https://x.example/', 'inbox', '/%2F%2Fx', '/\u0085']) {
      expect(readNotificationPath(path) === path, path).toBe(isSafeApplicationPath(path))
    }
  })

  test('reuses a focused app window first', () => {
    const origin = 'https://app.example'
    const windows = [
      { url: 'https://other.example/', focused: true },
      { url: `${origin}/a`, focused: false },
      { url: `${origin}/b`, focused: true },
    ]
    expect(selectNotificationClient(windows, origin)?.url).toBe(`${origin}/b`)
    expect(selectNotificationClient(windows.slice(0, 2), origin)?.url).toBe(`${origin}/a`)
    expect(selectNotificationClient([], origin)).toBeUndefined()
  })
})
