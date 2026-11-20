import { readServerEnvironment } from './server-config'

/**
 * Environment variable that CDK sets to `disabled` when the stack is deployed without the
 * Software factory module. Any other value, including unset for local runs, keeps it on.
 */
export const SOFTWARE_FACTORY_ENVIRONMENT = 'SOFTWARE_FACTORY'

/**
 * Error code returned while the Software factory module is not deployed.
 */
export const SOFTWARE_FACTORY_NOT_DEPLOYED_CODE = 'SoftwareFactoryNotDeployed'

/**
 * Reads whether this deployment serves Agent Runs, Agent settings, personal agent
 * credentials, and the Agent Run triage job.
 *
 * @param environment - Environment to read; defaults to the live runtime environment.
 * @returns `false` only when the deployment turned the module off.
 */
export function isSoftwareFactoryDeployed(
  environment: Readonly<Record<string, string | undefined>> = readServerEnvironment(),
): boolean {
  return environment[SOFTWARE_FACTORY_ENVIRONMENT]?.trim() !== 'disabled'
}
