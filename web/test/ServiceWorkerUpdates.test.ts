import { describe, expect, test } from 'bun:test'
import {
  createServiceWorkerUpdateController,
  serviceWorkerScriptUrl,
  shouldRegisterServiceWorker,
  skipWaitingMessage,
  type ServiceWorkerContainerHandle,
  type ServiceWorkerHandle,
  type ServiceWorkerRegistrationHandle,
} from '../src/app/pwa/serviceWorkerUpdates'
import { isSkipWaitingMessage } from '../src/service-worker/model/requestStrategy'

/** Fake worker that records posted messages and lets tests drive its lifecycle. */
class FakeWorker implements ServiceWorkerHandle {
  /** Current lifecycle state. */
  state = 'installing'
  /** Messages posted by the page. */
  readonly messages: unknown[] = []
  /** Registered lifecycle listeners. */
  private readonly listeners: Array<() => void> = []

  /** @inheritdoc */
  postMessage(message: unknown): void {
    this.messages.push(message)
  }

  /** @inheritdoc */
  addEventListener(_type: 'statechange', listener: () => void): void {
    this.listeners.push(listener)
  }

  /**
   * Moves the worker to a new state and notifies listeners.
   *
   * @param state - Next lifecycle state.
   */
  transition(state: string): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
}

/** Fake registration that lets tests announce a newly found worker. */
class FakeRegistration implements ServiceWorkerRegistrationHandle {
  /** Waiting worker present at registration time. */
  waiting: FakeWorker | null = null
  /** Worker being installed after an update was found. */
  installing: FakeWorker | null = null
  /** Number of update checks requested. */
  updateCalls = 0
  /** Registered update-found listeners. */
  private readonly listeners: Array<() => void> = []

  /** @inheritdoc */
  addEventListener(_type: 'updatefound', listener: () => void): void {
    this.listeners.push(listener)
  }

  /** @inheritdoc */
  update(): Promise<unknown> {
    this.updateCalls += 1
    return Promise.resolve(undefined)
  }

  /**
   * Simulates the browser finding a new worker script.
   *
   * @param worker - Worker that starts installing.
   */
  findUpdate(worker: FakeWorker): void {
    this.installing = worker
    for (const listener of this.listeners) listener()
  }
}

/** Fake container that records registration options and controller hand-off. */
class FakeContainer implements ServiceWorkerContainerHandle {
  /** Current controller; `null` before the first install. */
  controller: unknown = null
  /** Arguments of every register call. */
  readonly registrations: Array<{ scriptUrl: string, options: { scope: string, updateViaCache: 'none' } }> = []
  /** Registered controller-change listeners. */
  readonly controllerListeners: Array<() => void> = []
  /** Registration returned by every `register` call. */
  private readonly registration: FakeRegistration

  /**
   * Creates a container that resolves registration with the given fake.
   *
   * @param registration - Registration returned by `register`.
   */
  constructor(registration: FakeRegistration) {
    this.registration = registration
  }

  /** @inheritdoc */
  register(
    scriptUrl: string,
    options: { scope: string, updateViaCache: 'none' },
  ): Promise<ServiceWorkerRegistrationHandle> {
    this.registrations.push({ scriptUrl, options })
    return Promise.resolve(this.registration)
  }

  /** @inheritdoc */
  addEventListener(_type: 'controllerchange', listener: () => void): void {
    this.controllerListeners.push(listener)
  }
}

/**
 * Creates a controller wired to fresh fakes.
 *
 * @returns The controller with its fakes and observed side effects.
 */
function setup() {
  const registration = new FakeRegistration()
  const container = new FakeContainer(registration)
  const visibilityListeners: Array<() => void> = []
  let reloads = 0
  const controller = createServiceWorkerUpdateController({
    container,
    reload: () => {
      reloads += 1
    },
    onPageVisible: (listener) => {
      visibilityListeners.push(listener)
    },
  })

  return { controller, registration, container, visibilityListeners, reloads: () => reloads }
}

describe('shouldRegisterServiceWorker', () => {
  test('requires production, a secure context, and browser support', () => {
    expect(shouldRegisterServiceWorker({ isProduction: true, isSecureContext: true, hasServiceWorker: true }))
      .toBe(true)
    expect(shouldRegisterServiceWorker({ isProduction: false, isSecureContext: true, hasServiceWorker: true }))
      .toBe(false)
    expect(shouldRegisterServiceWorker({ isProduction: true, isSecureContext: false, hasServiceWorker: true }))
      .toBe(false)
    expect(shouldRegisterServiceWorker({ isProduction: true, isSecureContext: true, hasServiceWorker: false }))
      .toBe(false)
  })
})

describe('skipWaitingMessage', () => {
  test('matches the message the worker accepts', () => {
    expect(isSkipWaitingMessage(skipWaitingMessage)).toBe(true)
  })
})

describe('createServiceWorkerUpdateController', () => {
  test('registers the root worker with a root scope and bypasses the HTTP cache for update checks', async () => {
    const { controller, container } = setup()

    await controller.register()

    expect(container.registrations).toEqual([
      { scriptUrl: serviceWorkerScriptUrl, options: { scope: '/', updateViaCache: 'none' } },
    ])
    expect(serviceWorkerScriptUrl).toBe('/sw.js')
  })

  test('does not offer an update for the first install', async () => {
    const { controller, registration } = setup()
    await controller.register()
    const worker = new FakeWorker()

    registration.findUpdate(worker)
    worker.transition('installed')

    expect(controller.getSnapshot()).toBe(false)
  })

  test('offers an installed update and reloads only after the user accepts it', async () => {
    const { controller, registration, container, reloads } = setup()
    container.controller = {}
    let notifications = 0
    controller.subscribe(() => {
      notifications += 1
    })
    await controller.register()
    const worker = new FakeWorker()

    registration.findUpdate(worker)
    expect(controller.getSnapshot()).toBe(false)
    worker.transition('installed')

    expect(controller.getSnapshot()).toBe(true)
    expect(notifications).toBe(1)
    expect(container.controllerListeners).toHaveLength(0)

    controller.applyUpdate()
    controller.applyUpdate()

    expect(worker.messages).toEqual([skipWaitingMessage])
    expect(isSkipWaitingMessage(worker.messages[0])).toBe(true)
    expect(container.controllerListeners).toHaveLength(1)
    expect(reloads()).toBe(0)

    for (const listener of container.controllerListeners) listener()
    expect(reloads()).toBe(1)
  })

  test('reloads directly when another tab already activated the update', async () => {
    const { controller, registration, container, reloads } = setup()
    container.controller = {}
    await controller.register()
    const worker = new FakeWorker()
    registration.findUpdate(worker)
    worker.transition('installed')
    worker.transition('activated')

    controller.applyUpdate()

    expect(reloads()).toBe(1)
    expect(worker.messages).toEqual([])
    expect(container.controllerListeners).toHaveLength(0)
  })

  test('surfaces a worker that was already waiting at registration', async () => {
    const { controller, registration, container } = setup()
    container.controller = {}
    registration.waiting = new FakeWorker()

    await controller.register()

    expect(controller.getSnapshot()).toBe(true)
  })

  test('dismissing hides the current update until a newer worker installs', async () => {
    const { controller, registration, container } = setup()
    container.controller = {}
    await controller.register()
    const first = new FakeWorker()
    registration.findUpdate(first)
    first.transition('installed')

    controller.dismiss()
    expect(controller.getSnapshot()).toBe(false)

    const second = new FakeWorker()
    registration.findUpdate(second)
    second.transition('installed')
    expect(controller.getSnapshot()).toBe(true)
  })

  test('checks for updates whenever the page becomes visible', async () => {
    const { controller, registration, visibilityListeners } = setup()
    await controller.register()

    for (const listener of visibilityListeners) listener()

    expect(registration.updateCalls).toBe(1)
  })

  test('unsubscribed listeners stop receiving notifications', async () => {
    const { controller, registration, container } = setup()
    container.controller = {}
    let notifications = 0
    const unsubscribe = controller.subscribe(() => {
      notifications += 1
    })
    unsubscribe()
    await controller.register()
    const worker = new FakeWorker()
    registration.findUpdate(worker)
    worker.transition('installed')

    expect(notifications).toBe(0)
  })
})
