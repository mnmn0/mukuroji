import type { Context } from 'hono'
import { SOFTWARE_FACTORY_NOT_DEPLOYED_CODE } from '../config/software-factory'

/** Body format of the response, matching the API family that serves the route. */
export type SoftwareFactoryNotDeployedFormat = 'problem' | 'web'

/**
 * Builds the response for a Software factory route this deployment does not include.
 *
 * Public API routes answer with a problem document so that API clients parse it like their
 * other errors; Web routes use the `{ code, message }` body the Web API already returns.
 *
 * @param context - Request context.
 * @param format - `problem` for Public API routes, `web` for Web API routes.
 * @returns A non-retryable 503 response that is never cached.
 */
export function softwareFactoryNotDeployedResponse(
  context: Context,
  format: SoftwareFactoryNotDeployedFormat,
): Response {
  const message = 'Software factory is not deployed in this environment.'
  context.header('Cache-Control', 'no-store')
  if (format === 'problem') {
    return context.json({
      type: 'https://docs.mukuroji.app/problems/software_factory_not_deployed',
      title: 'Software Factory Not Deployed',
      status: 503,
      code: SOFTWARE_FACTORY_NOT_DEPLOYED_CODE,
      detail: message,
      instance: context.req.path,
      retryable: false,
    }, 503, {
      'Content-Type': 'application/problem+json; charset=utf-8',
    })
  }
  return context.json({ code: SOFTWARE_FACTORY_NOT_DEPLOYED_CODE, message }, 503)
}
