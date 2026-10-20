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
  guardPushDeviceApi,
  loadPushDevice,
  refreshPushDevice,
  trackPushRegistration,
  type PushDeviceApi,
} from '../src/notifications/queries/usePushDeviceStatus'
import { readAccessTokenSubject } from '../src/auth/session'
import { NotificationsApiError } from '../src/notifications/api/errors'
import { getPushConfiguration } from '../src/notifications/api/push'
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
  createRegisteredEndpointMemory,
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

/**
 * Creates endpoint memory backed by a map.
 *
 * @returns The memory.
 */
function createMemory() {
  const values = new Map<string, string>()
  return createRegisteredEndpointMemory({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  })
}

/**
 * Creates an unsigned JWT-shaped access token for a subject.
 *
 * @param subject - Token subject.
 * @returns The token.
 */
function createToken(subject: string): string {
  return `h.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.s`
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
    // A stalled removal of the old endpoint never holds up the replacement.
    const stalled = createEnvironment({ existingKey: otherKey })
    const hanging: PushDeviceApi = { ...createApi().api, remove: () => new Promise<void>(() => undefined) }
    expect(await enablePushDevice('t', vapidPublicKey, stalled.environment, hanging)).toBe('enabled')
    expect(stalled.log).toEqual(['request', 'unsubscribe old', 'subscribe 65'])
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

  test('drops an existing subscription the server refuses, but keeps it through a network failure', async () => {
    const refused = createEnvironment({ permission: 'granted', existingKey: vapidPublicKey })
    const limit: PushDeviceApi = {
      ...createApi().api,
      register: async () => { throw new NotificationsApiError(409, 'limit', 'PushSubscriptionLimitExceeded') },
    }
    expect(await enablePushDevice('t', vapidPublicKey, refused.environment, limit)).toBe('failed')
    // The device then reads as off instead of on without a registration.
    expect(refused.log).toEqual(['unsubscribe current'])

    const unreachable = createEnvironment({ permission: 'granted', existingKey: vapidPublicKey })
    const down: PushDeviceApi = {
      ...createApi().api,
      register: async () => { throw new NotificationsApiError(503, 'down') },
    }
    expect(await enablePushDevice('t', vapidPublicKey, unreachable.environment, down)).toBe('failed')
    expect(unreachable.log).toEqual([])
  })

  test('disables on the server and in the browser', async () => {
    const { environment, log } = createEnvironment({ permission: 'granted', existingKey: vapidPublicKey })
    const { api, calls } = createApi()
    expect(await disablePushDevice('t', environment, api)).toBe('disabled')
    expect(calls).toEqual([`remove t ${endpoint}`])
    expect(log).toEqual(['unsubscribe current'])
  })

  test('reports a disable as failed and keeps the remembered endpoint when nothing was cancelled', async () => {
    const memory = createMemory()
    memory.write({ endpoint })
    const { api } = createApi()
    const subscription = { ...createSubscription(vapidPublicKey, []), unsubscribe: async () => false }
    const result = await disablePushDevice('t', {
      supported: true,
      notification: { permission: 'granted', requestPermission: async () => 'granted' },
      getPushManager: async () => ({ getSubscription: async () => subscription, subscribe: async () => subscription }),
      registeredEndpoint: memory,
    }, api)
    expect(result).toBe('failed')
    expect(memory.read()).toEqual({ endpoint })
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

    // A registration still in flight is settled before the removal, so it cannot recreate the
    // registration afterwards; notifications on screen are closed and the browser unsubscribes at once.
    const racing = createEnvironment({ permission: 'granted', existingKey: vapidPublicKey })
    const closed: string[] = []
    const racingApi = createApi()
    let finishRefresh: () => void = () => undefined
    void trackPushRegistration(new Promise<void>((resolve) => { finishRefresh = resolve }))
    const signingOut = disconnectPushDeviceOnSignOut('t', {
      ...racing.environment,
      getDisplayedNotifications: async () => [{ close: () => { closed.push('closed') } }],
    }, racingApi.api)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(racing.log).toEqual(['unsubscribe current'])
    expect(closed).toEqual(['closed'])
    // The removal starts at once, so it is sent even if the registration never settles, and is
    // sent again once the registration has settled.
    expect(racingApi.calls).toEqual([`remove t ${endpoint}`])
    finishRefresh()
    await signingOut
    expect(racingApi.calls).toEqual([`remove t ${endpoint}`, `remove t ${endpoint}`])

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

describe('push configuration and cleanup fallbacks', () => {
  test('reads only the two configuration shapes and rejects anything else as retryable', async () => {
    const previousFetch = globalThis.fetch
    /**
     * Answers the configuration request with a fixed body.
     *
     * @param body - Response body text.
     */
    const respondWith = (body: string) => {
      globalThis.fetch = Object.assign(async () => new Response(body, { status: 200 }), { preconnect: () => undefined })
    }
    try {
      respondWith(JSON.stringify({ enabled: false }))
      expect(await getPushConfiguration('t')).toEqual({ enabled: false })
      respondWith(JSON.stringify({ enabled: true, vapidPublicKey }))
      expect(await getPushConfiguration('t')).toEqual({ enabled: true, vapidPublicKey })
      for (const broken of [
        '',
        '<html>',
        '{}',
        JSON.stringify({ enabled: 'yes' }),
        JSON.stringify({ enabled: true }),
        JSON.stringify({ enabled: true, vapidPublicKey: 'x' }),
        JSON.stringify({ enabled: true, vapidPublicKey: `${vapidPublicKey}=` }),
        JSON.stringify({ enabled: true, vapidPublicKey: Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 7)]).toString('base64url') }),
      ]) {
        respondWith(broken)
        await expect(getPushConfiguration('t'), broken).rejects.toMatchObject({ code: 'InvalidPushConfiguration' })
      }
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test('disabling unsubscribes without waiting for a stalled server removal', async () => {
    const { environment, log } = createEnvironment({ permission: 'granted', existingKey: vapidPublicKey })
    const stalled: PushDeviceApi = { ...createApi().api, remove: () => new Promise<void>(() => undefined) }
    expect(await disablePushDevice('t', environment, stalled)).toBe('disabled')
    expect(log).toEqual(['unsubscribe current'])
  })

  test('removes the remembered endpoint on sign-out when the push store cannot be read', async () => {
    const memory = createMemory()
    memory.write({ endpoint })
    const { environment } = createEnvironment({ permission: 'granted' })
    const { api, calls } = createApi()
    await disconnectPushDeviceOnSignOut('t', {
      ...environment,
      getPushManager: async () => { throw new Error('storage') },
      registeredEndpoint: memory,
    }, api)
    expect(calls).toEqual([`remove t ${endpoint}`])
    // The memory is cleared with the sign-out, so the next member never removes it again.
    expect(memory.read()).toBeUndefined()
  })

  test('leaves the subscription to another account that registered it later in another tab', async () => {
    const ada = createToken('ada')
    const bob = createToken('bob')
    const memory = createMemory()
    memory.write({ endpoint, registrant: 'bob' })
    const shared = createEnvironment({ permission: 'granted', existingKey: vapidPublicKey })
    const { api, calls } = createApi()
    await disconnectPushDeviceOnSignOut(ada, { ...shared.environment, registeredEndpoint: memory }, api)
    // Ada's own registration is removed on the server, but Bob keeps the browser subscription.
    expect(calls).toEqual([`remove ${ada} ${endpoint}`])
    expect(shared.log).toEqual([])
    expect(memory.read()).toEqual({ endpoint, registrant: 'bob' })
    // The account that registered it last unsubscribes as usual.
    await disconnectPushDeviceOnSignOut(bob, { ...shared.environment, registeredEndpoint: memory }, api)
    expect(shared.log).toEqual(['unsubscribe current'])
    expect(memory.read()).toBeUndefined()
  })

  test('sends the follow-up removal once registrations settle, even when the first removal stalls', async () => {
    const { environment } = createEnvironment({ permission: 'granted', existingKey: vapidPublicKey })
    const removals: string[] = []
    let finishRefresh: () => void = () => undefined
    void trackPushRegistration(new Promise<void>((resolve) => { finishRefresh = resolve }))
    void disconnectPushDeviceOnSignOut('t', environment, {
      ...createApi().api,
      remove: (_token, removal) => {
        removals.push(removal.endpoint)
        // The first removal never answers.
        return removals.length === 1 ? new Promise<void>(() => undefined) : Promise.resolve()
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(removals).toEqual([endpoint])
    finishRefresh()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(removals).toEqual([endpoint, endpoint])
  })

  test('claims the shared subscription before the registration request is answered', async () => {
    const memory = createMemory()
    memory.write({ endpoint, registrant: 'ada' })
    const bob = createToken('bob')
    const { environment } = createEnvironment({ permission: 'granted', existingKey: vapidPublicKey })
    let claimedDuringRequest: unknown
    const api: PushDeviceApi = {
      ...createApi().api,
      register: async () => { claimedDuringRequest = memory.read() },
    }
    expect(await enablePushDevice(bob, vapidPublicKey, { ...environment, registeredEndpoint: memory }, api)).toBe('enabled')
    expect(claimedDuringRequest).toEqual({ endpoint, registrant: 'bob' })
    // A refused registration gives the claim up with the subscription.
    const refusing: PushDeviceApi = {
      ...createApi().api,
      register: async () => { throw new NotificationsApiError(409, 'limit', 'PushSubscriptionLimitExceeded') },
    }
    expect(await enablePushDevice(bob, vapidPublicKey, { ...environment, registeredEndpoint: memory }, refusing)).toBe('failed')
    expect(memory.read()).toBeUndefined()
  })

  test('reports push request failures to the session guard and keeps the rejection', async () => {
    const reported: unknown[] = []
    const expired = new NotificationsApiError(401, 'expired')
    const guarded = guardPushDeviceApi({
      getConfiguration: async () => { throw expired },
      register: async () => undefined,
      remove: async () => undefined,
    }, async (request) => {
      try {
        return await request
      } catch (error) {
        reported.push(error)
        throw error
      }
    })
    await expect(guarded.getConfiguration('t')).rejects.toBe(expired)
    await guarded.register('t', { endpoint, keys: { p256dh: 'p', auth: 'a' } })
    expect(reported).toEqual([expired])
  })

  test('reads the registrant from the token and the memory, ignoring malformed values', () => {
    expect(readAccessTokenSubject(createToken('ada'))).toBe('ada')
    expect(readAccessTokenSubject('t')).toBeUndefined()
    expect(readAccessTokenSubject('a.b.c')).toBeUndefined()
    const values = new Map<string, string>([['mukuroji.push.registeredEndpoint', endpoint]])
    const memory = createRegisteredEndpointMemory({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value) },
      removeItem: (key) => { values.delete(key) },
    })
    expect(memory.read()).toBeUndefined()
    values.set('mukuroji.push.registeredEndpoint', JSON.stringify({ endpoint: 1 }))
    expect(memory.read()).toBeUndefined()
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
    // Permission changes outside the app, so a blocked device offers a recheck.
    expect(blocked).toContain('data-testid="push-device-recheck"')
    expect(blocked).toContain('通知の許可を再確認')
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
