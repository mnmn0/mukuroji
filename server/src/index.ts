/**
 * Re-exports the server application composition API.
 *
 * Runtime entrypoints import from `handlers/`; this file remains as a stable
 * package-level entrypoint for tests and local tooling.
 */
export { default } from './app/composition/api-runtime'
export * from './api/api-router'
export * from './app/composition/api-dependencies'
export * from './app/composition/api-runtime'
export * from './app/createApp'
