import { createMemberSignInSecurityPorts } from '../../app/composition/member-sign-in-security'
import { authenticationDependencies, workspaceDependencies } from './app-dependencies'
import { isEnterpriseSsoConfigured } from './enterprise-access'

/**
 * Checks whether an email address signs in through an enforced enterprise SSO domain.
 *
 * Members of such a domain have no password in mukuroji and get MFA from their identity
 * provider, so password and MFA management does not apply to them.
 *
 * @param email - Email address of the member.
 * @returns Whether the domain enforces SSO.
 */
export async function isSsoManagedEmail(email: string) {
  if (!isEnterpriseSsoConfigured()) return false
  const discovery = await workspaceDependencies.enterpriseIdentity.ssoDiscovery.discoverSso(email)
  return discovery !== undefined
}

/**
 * Connects the member sign-in security use cases to the request's dependencies.
 *
 * @returns The ports.
 */
export function createRequestMemberSignInSecurityPorts() {
  return createMemberSignInSecurityPorts({
    cognito: authenticationDependencies.cognito,
    workspaceAccess: workspaceDependencies.workspaceAccess,
    isSsoManagedEmail,
  })
}
