import server, {
  handler as apiHandler,
  validateApiServerConfig,
} from '../app/createApp'

validateApiServerConfig()

/**
 * API Gateway / Lambda Function URL events を共有 Hono app へ渡す handler です。
 */
export const handler = apiHandler

/**
 * Bun のローカル開発サーバー entrypoint です。
 */
export default server
