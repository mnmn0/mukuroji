import {
  createServiceWorkerUpdateController,
  shouldRegisterServiceWorker,
  type ServiceWorkerUpdateController,
} from './serviceWorkerUpdates'

/**
 * Update controller bound to this browser, or `null` where service workers are unavailable.
 */
export const appServiceWorkerUpdates: ServiceWorkerUpdateController | null =
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    ? createServiceWorkerUpdateController({
      container: navigator.serviceWorker,
      reload: () => window.location.reload(),
      onPageVisible: (listener) => {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            listener()
          }
        })
      },
    })
    : null

/**
 * Registers the service worker after the page finishes loading in production builds.
 *
 * Registration failures leave the app fully usable online, so they are reported without
 * interrupting the user.
 */
export function startAppServiceWorker(): void {
  const controller = appServiceWorkerUpdates

  if (
    controller === null
    || !shouldRegisterServiceWorker({
      isProduction: import.meta.env.PROD,
      isSecureContext: window.isSecureContext,
      hasServiceWorker: true,
    })
  ) {
    return
  }

  window.addEventListener('load', () => {
    controller.register().catch((error: unknown) => {
      console.error('Service worker registration failed.', error)
    })
  }, { once: true })
}
