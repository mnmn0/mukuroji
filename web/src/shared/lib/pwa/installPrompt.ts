import { useSyncExternalStore } from 'react'

/** Whether the app can be installed from inside the page; `prompting` while the browser dialog is open. */
export type AppInstallStatus = 'unavailable' | 'available' | 'prompting' | 'installed'

/** Result of asking the browser to show its install dialog; `failed` when the browser rejected the request. */
export type AppInstallOutcome = 'accepted' | 'dismissed' | 'failed' | 'unavailable'

/** Browser event that lets a page show the install dialog later. */
type DeferredInstallPrompt = Event & {
  /** Shows the browser install dialog. */
  prompt: () => Promise<unknown>
  /** Resolves with the user's choice in the dialog. */
  userChoice: Promise<unknown>
}

/** Install prompt state shared by every subscriber. */
export type AppInstallPromptStore = {
  /** Starts listening for install events; safe to call more than once. */
  start: () => void
  /**
   * Subscribes to status changes.
   *
   * @param listener - Called after the status may have changed.
   * @returns Unsubscribe function.
   */
  subscribe: (listener: () => void) => () => void
  /**
   * Reads the current status.
   *
   * @returns Current install status.
   */
  getSnapshot: () => AppInstallStatus
  /**
   * Shows the browser install dialog once.
   *
   * @returns What the user chose, `failed` when the browser rejected the dialog, or
   * `unavailable` when no prompt is pending.
   */
  prompt: () => Promise<AppInstallOutcome>
}

/**
 * Creates an install prompt store around a window-like event target.
 *
 * Chromium fires `beforeinstallprompt` when the app is installable. The event is kept
 * so the page can offer installation from its own UI; it can be used only once.
 *
 * @param target - Window that receives the install events.
 * @param isInstalled - Reports whether the app already runs as an installed app.
 * @returns The install prompt store.
 */
export function createAppInstallPromptStore(
  target: EventTarget,
  isInstalled: () => boolean,
): AppInstallPromptStore {
  const listeners = new Set<() => void>()
  let deferred: DeferredInstallPrompt | undefined
  let installed = false
  let prompting = false
  let started = false

  /** Notifies every subscriber. */
  const notify = () => {
    for (const listener of listeners) listener()
  }

  return {
    start() {
      if (started) return
      started = true
      installed = isInstalled()
      target.addEventListener('beforeinstallprompt', (event) => {
        if (!isDeferredInstallPrompt(event)) return
        // Keep the browser's own mini-infobar from appearing; the page offers installation instead.
        event.preventDefault()
        deferred = event
        notify()
      })
      target.addEventListener('appinstalled', () => {
        deferred = undefined
        installed = true
        notify()
      })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot() {
      if (installed) return 'installed'
      if (prompting) return 'prompting'
      return deferred ? 'available' : 'unavailable'
    },
    async prompt() {
      const pending = deferred
      if (!pending || prompting) return 'unavailable'
      // The prompt can be used once; keep reporting `prompting` until the user decides.
      deferred = undefined
      prompting = true
      notify()
      try {
        await pending.prompt()
        const choice = await pending.userChoice
        return isRecord(choice) && choice.outcome === 'accepted' ? 'accepted' : 'dismissed'
      } catch {
        // The kept event can expire or the browser can refuse; the caller explains the browser menu.
        return 'failed'
      } finally {
        prompting = false
        notify()
      }
    },
  }
}

/** Install prompt store for the running page, absent outside a browser. */
export const appInstallPrompt: AppInstallPromptStore | undefined = typeof window === 'undefined'
  ? undefined
  : createAppInstallPromptStore(window, () => window.matchMedia?.('(display-mode: standalone)').matches === true)

/** Starts capturing install events as early as possible. */
export function startAppInstallPrompt(): void {
  appInstallPrompt?.start()
}

/**
 * Subscribes a component to the install status.
 *
 * @returns Current status and the action that shows the install dialog.
 */
export function useAppInstallPrompt(): { status: AppInstallStatus; install: () => Promise<AppInstallOutcome> } {
  const status = useSyncExternalStore<AppInstallStatus>(
    (listener) => appInstallPrompt?.subscribe(listener) ?? (() => undefined),
    () => appInstallPrompt?.getSnapshot() ?? 'unavailable',
    () => 'unavailable',
  )
  return { status, install: () => appInstallPrompt?.prompt() ?? Promise.resolve('unavailable') }
}

/**
 * Checks that an event carries the install prompt API.
 *
 * @param event - Event received as `beforeinstallprompt`.
 * @returns Whether the event can show the install dialog.
 */
function isDeferredInstallPrompt(event: Event): event is DeferredInstallPrompt {
  return typeof Reflect.get(event, 'prompt') === 'function' && Reflect.get(event, 'userChoice') instanceof Promise
}

/**
 * Checks for a non-array object.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
