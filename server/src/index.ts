/**
 * Re-exports the server application composition API.
 *
 * Runtime entrypoints import from `handlers/`; this file remains as a stable
 * package-level entrypoint for tests and local tooling.
 */
export { default } from './app/composition/api-runtime'
export {
  app,
  handler,
  validateApiServerConfig,
} from './app/composition/api-runtime'
export {
  createProductionAppDependencies,
  createTestAppDependencies,
} from './app/composition/api-dependencies'
export {
  createApiHandler,
  createApp,
  type AppDependencies,
} from './app/createApp'
