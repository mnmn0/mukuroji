/** Root URL of the built service worker; it must stay stable so the browser can detect updates. */
export const serviceWorkerScriptUrl = '/sw.js'

/**
 * Message posted to a waiting worker after the user accepts an update.
 *
 * The worker bundle must not import app modules (a shared chunk would turn it into a module
 * worker), so this value is duplicated from the worker model and kept equal by a contract test.
 */
export const skipWaitingMessage: Readonly<{ type: string }> = Object.freeze({
  type: 'mukuroji:skip-waiting',
})

/** Minimal service worker surface used to deliver the user's update decision. */
export type ServiceWorkerHandle = {
  /** Lifecycle state such as `installing`, `installed`, or `activated`. */
  readonly state: string
  /** Posts a message to the worker. */
  postMessage(message: unknown): void
  /** Subscribes to lifecycle changes. */
  addEventListener(type: 'statechange', listener: () => void): void
}

/** Minimal service worker registration surface used to observe updates. */
export type ServiceWorkerRegistrationHandle = {
  /** Installed worker that is waiting for existing pages to release control. */
  readonly waiting: ServiceWorkerHandle | null
  /** Worker currently being installed after an update was found. */
  readonly installing: ServiceWorkerHandle | null
  /** Subscribes to newly found worker scripts. */
  addEventListener(type: 'updatefound', listener: () => void): void
  /** Asks the browser to check the worker script for changes. */
  update(): Promise<unknown>
}

/** Minimal service worker container surface used for registration and controller hand-off. */
export type ServiceWorkerContainerHandle = {
  /** Worker controlling the current page; `null` until the first worker takes control. */
  readonly controller: unknown
  /** Registers the worker script. */
  register(
    scriptUrl: string,
    options: { scope: string, updateViaCache: 'none' },
  ): Promise<ServiceWorkerRegistrationHandle>
  /** Subscribes to controller replacement. */
  addEventListener(type: 'controllerchange', listener: () => void): void
}

/** Browser capabilities consulted before registering the service worker. */
export type ServiceWorkerEnvironment = {
  /** Whether the bundle was built for production; development servers never register a worker. */
  isProduction: boolean
  /** Whether the page runs in a secure context, which service workers require. */
  isSecureContext: boolean
  /** Whether the browser exposes `navigator.serviceWorker`. */
  hasServiceWorker: boolean
}

/** Dependencies of the update controller, injectable for tests. */
export type ServiceWorkerUpdateDependencies = {
  /** Browser service worker container. */
  container: ServiceWorkerContainerHandle
  /** Reloads the page once the new worker controls it. */
  reload: () => void
  /** Subscribes to the page becoming visible so long-lived installs check for updates. */
  onPageVisible: (listener: () => void) => void
}

/** Store-like controller that exposes whether an accepted update can be applied. */
export type ServiceWorkerUpdateController = {
  /** Registers the worker and starts observing updates. */
  register(): Promise<void>
  /** Subscribes to update availability changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Returns whether an update is waiting and the user has not dismissed it. */
  getSnapshot(): boolean
  /** Activates the waiting worker and reloads once it takes control. */
  applyUpdate(): void
  /** Hides the notice for the currently waiting worker. */
  dismiss(): void
}

/**
 * Decides whether this page should register the service worker.
 *
 * @param environment - Build mode and browser capabilities.
 * @returns `true` only for production builds in secure contexts with service worker support.
 */
export function shouldRegisterServiceWorker(environment: ServiceWorkerEnvironment): boolean {
  return environment.isProduction && environment.isSecureContext && environment.hasServiceWorker
}

/**
 * Creates the controller that registers the worker and lets the user opt into updates.
 *
 * A new worker never takes over open pages by itself: it waits until the user accepts the
 * update, so in-progress edits are not interrupted by a surprise reload.
 *
 * @param dependencies - Browser service worker surface and page hooks.
 * @returns Controller suitable for `useSyncExternalStore`.
 */
export function createServiceWorkerUpdateController(
  dependencies: ServiceWorkerUpdateDependencies,
): ServiceWorkerUpdateController {
  const listeners = new Set<() => void>()
  let waitingWorker: ServiceWorkerHandle | null = null
  let dismissedWorker: ServiceWorkerHandle | null = null
  let reloadRequested = false

  /** Notifies subscribers that the snapshot may have changed. */
  function notify(): void {
    for (const listener of listeners) {
      listener()
    }
  }

  /**
   * Records an installed worker as the pending update when the page already has a controller.
   *
   * @param worker - Installed worker waiting to activate.
   */
  function markWaiting(worker: ServiceWorkerHandle): void {
    // Without a controller this is the first install, which activates on its own.
    if (dependencies.container.controller === null || waitingWorker === worker) {
      return
    }

    waitingWorker = worker
    notify()
  }

  /**
   * Observes a registration for waiting and newly installed workers.
   *
   * @param registration - Registration returned by the browser.
   */
  function observe(registration: ServiceWorkerRegistrationHandle): void {
    if (registration.waiting !== null) {
      markWaiting(registration.waiting)
    }

    registration.addEventListener('updatefound', () => {
      const installing = registration.installing

      if (installing === null) {
        return
      }

      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed') {
          markWaiting(installing)
        }
      })
    })

    dependencies.onPageVisible(() => {
      // Update checks fail while offline; the next visibility change retries.
      registration.update().catch(() => undefined)
    })
  }

  return {
    async register() {
      const registration = await dependencies.container.register(serviceWorkerScriptUrl, {
        scope: '/',
        updateViaCache: 'none',
      })

      observe(registration)
    },
    subscribe(listener) {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot() {
      return waitingWorker !== null && waitingWorker !== dismissedWorker
    },
    applyUpdate() {
      if (waitingWorker === null || reloadRequested) {
        return
      }

      reloadRequested = true
      // Listening only after the user accepts keeps the first install's clients.claim() from reloading.
      dependencies.container.addEventListener('controllerchange', () => {
        dependencies.reload()
      })
      waitingWorker.postMessage(skipWaitingMessage)
    },
    dismiss() {
      if (waitingWorker === null) {
        return
      }

      dismissedWorker = waitingWorker
      notify()
    },
  }
}
