import server, {
  handler as apiHandler,
  validateApiServerConfig,
} from '../app/composition/api-runtime'

validateApiServerConfig()

/** API Gateway and Lambda Function URL handler backed by the shared Hono app. */
export const handler = apiHandler

/** Bun development-server entrypoint. */
export default server
