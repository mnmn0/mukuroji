import { useMemo } from 'react'
import { isRouteErrorResponse, useRouteError } from 'react-router'
import { RouteErrorPage } from '../pages/public/RouteErrorPage'
import { appClientErrorReporter, readCurrentRoutePattern } from './observability/clientErrorReporting'

/**
 * Route `errorElement` that reports the failure once and shows {@link RouteErrorPage} with the
 * report ID, so a user can quote it to an operator.
 *
 * The report is made while rendering so the ID shows in the first paint. The reporter returns the
 * first ID for a repeated failure, so a re-render or a Strict Mode double render sends nothing more.
 *
 * @returns The route error page.
 */
export function RouteErrorBoundary() {
  const error = useRouteError()
  const reportId = useMemo(() => appClientErrorReporter?.report({
    kind: 'route-error',
    route: readCurrentRoutePattern(),
    error,
    ...(isRouteErrorResponse(error) ? { status: error.status } : {}),
  }), [error])

  return <RouteErrorPage reportId={reportId} />
}
