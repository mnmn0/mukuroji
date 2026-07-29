import server, { handler as apiHandler } from '../app/composition/api-runtime'

/**
 * Dispatches an API Gateway or Lambda Function URL event to the shared Hono app.
 *
 * @param event - API Gateway or Lambda Function URL event.
 * @param lambdaContext - Optional Lambda invocation context.
 * @returns The Hono Lambda response.
 */
export const handler = apiHandler

/** Bun development-server entrypoint. */
export default server
