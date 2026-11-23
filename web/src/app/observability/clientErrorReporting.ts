import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'
import {
  createClientErrorReporter,
  routePatternFromMatches,
  sendClientErrorReport,
  type ClientErrorReporter,
} from '../../shared/observability/clientErrorReports'
import { readWebBuildInfo } from '../../shared/release/webBuild'

/** Router state the reporting reads: the matched routes. */
type RouterLike = {
  /** Current state. */
  readonly state: { readonly matches: readonly { readonly route: { readonly path?: string } }[] }
  /**
   * Subscribes to state changes.
   *
   * @param listener - Receives each new state.
   * @returns Unsubscribe function.
   */
  readonly subscribe: (listener: (state: RouterLike['state']) => void) => () => void
}

/**
 * The app's reporter, or undefined for local and test builds without an embedded commit, so
 * development errors never reach the operational log.
 */
export const appClientErrorReporter: ClientErrorReporter | undefined = (() => {
  const { commitSha } = readWebBuildInfo()
  if (commitSha === undefined || typeof window === 'undefined') return undefined
  return createClientErrorReporter({
    webCommitSha: commitSha,
    send: (report) => sendClientErrorReport(resolveApiBaseUrl('shared'), report, (...args) => globalThis.fetch(...args)),
    createReportId: () => globalThis.crypto.randomUUID(),
  })
})()

/** Route pattern the router showed last, kept by {@link installClientErrorReporting}. */
let currentRoutePattern = '/unknown'

/**
 * Returns the route pattern the router shows now.
 *
 * @returns The pattern, or `/unknown` before reporting is installed.
 */
export function readCurrentRoutePattern(): string {
  return currentRoutePattern
}

/**
 * Reports whether an error event comes from this app's own scripts.
 *
 * Browser extensions and other origins' scripts also raise `error` events on the page; their
 * errors are not the app's and are not reported.
 *
 * @param event - The error event.
 * @returns Whether the script that failed is served from this origin.
 */
function isOwnScriptError(event: ErrorEvent): boolean {
  if (!event.filename) return false
  try {
    return new URL(event.filename).origin === window.location.origin
  } catch {
    return false
  }
}

/**
 * Reports unhandled errors and promise rejections with the route that was showing.
 *
 * Route errors are reported by the route error boundary instead. Nothing is installed when the
 * build has no embedded commit.
 *
 * @param router - The app's data router.
 * @returns A function that removes the listeners.
 */
export function installClientErrorReporting(router: RouterLike): () => void {
  const reporter = appClientErrorReporter
  if (reporter === undefined) return () => undefined
  currentRoutePattern = routePatternFromMatches(router.state.matches)
  const unsubscribe = router.subscribe((state) => {
    currentRoutePattern = routePatternFromMatches(state.matches)
  })
  /** Reports an uncaught error from this app's scripts. */
  const onError = (event: ErrorEvent) => {
    if (isOwnScriptError(event)) reporter.report({ kind: 'error', route: currentRoutePattern, error: event.error })
  }
  /** Reports a promise rejection nobody handled. */
  const onRejection = (event: PromiseRejectionEvent) => {
    reporter.report({ kind: 'unhandledrejection', route: currentRoutePattern, error: event.reason })
  }
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    unsubscribe()
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}
