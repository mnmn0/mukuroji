/** Page surface used to tell whether the app runs as an installed standalone app. */
export type StandaloneDisplayTarget = {
  /** Evaluates a CSS media query, when the page supports it. */
  matchMedia?: (query: string) => { matches: boolean }
  /** Navigator that may carry WebKit's non-standard `standalone` flag. */
  navigator?: object
}

/**
 * Reports whether the page runs as an installed standalone app.
 *
 * Chromium and recent WebKit match `(display-mode: standalone)`; iOS and iPadOS Home Screen
 * apps are also identified by WebKit's non-standard `navigator.standalone`, so both are
 * checked. The install card and the badge permission opt-in share this check.
 *
 * @param target - Page to inspect; defaults to the running page.
 * @returns Whether the app runs standalone; false outside a browser.
 */
export function isStandaloneDisplay(target: StandaloneDisplayTarget | undefined = readStandaloneDisplayTarget()): boolean {
  if (!target) return false
  if (target.matchMedia?.('(display-mode: standalone)').matches === true) return true
  return target.navigator !== undefined && Reflect.get(target.navigator, 'standalone') === true
}

/**
 * Reads the running page's media query and navigator.
 *
 * @returns The page target, or undefined outside a browser.
 */
function readStandaloneDisplayTarget(): StandaloneDisplayTarget | undefined {
  if (typeof window === 'undefined') return undefined
  return {
    ...(typeof window.matchMedia === 'function' ? { matchMedia: (query: string) => window.matchMedia(query) } : {}),
    ...(typeof navigator === 'undefined' ? {} : { navigator }),
  }
}
