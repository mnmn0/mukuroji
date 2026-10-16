import { loadServerConfig } from '../../infrastructure/config/server-config'

/**
 * Reads the AWS region from the server configuration.
 *
 * @returns The configured AWS region.
 */
export function getAwsRegion() {
  return loadServerConfig().awsRegion
}

/**
 * Reads a server environment variable from the loaded server configuration.
 *
 * @param name - Environment variable name.
 * @returns The variable value, or `undefined` when it is not set.
 */
export function getEnv(name: string) {
  return loadServerConfig().environment[name]
}

/**
 * Removes trailing slashes from a URL or path.
 *
 * @param value - URL or path to trim.
 * @returns The value without trailing slashes.
 */
export function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
