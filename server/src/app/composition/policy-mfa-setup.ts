import {
  FlociCognitoClient,
  type CognitoClient,
  type GetUserResponse,
  type PolicyMfaSetupPorts,
} from '../../modules/authentication'
import { hasEnabledMfa, readMfaRequirement } from '../../api/shared/account-security'

/**
 * Connects the policy-driven MFA setup decision to Cognito and the Workspace security policy.
 *
 * @param cognito - Cognito client of the request.
 * @returns The ports.
 */
export function createPolicyMfaSetupPorts(cognito: CognitoClient): PolicyMfaSetupPorts<GetUserResponse> {
  return {
    async readUser(accessToken) {
      // The local Floci emulator can issue opaque tokens that GetUser does not accept.
      if (cognito instanceof FlociCognitoClient && accessToken.split('.').length !== 3) {
        return undefined
      }
      return await cognito.getUser(accessToken)
    },
    hasEnabledMfa,
    async isMfaRequiredByPolicy(user, accessToken) {
      return (await readMfaRequirement(user, accessToken)).mfaRequired
    },
  }
}
