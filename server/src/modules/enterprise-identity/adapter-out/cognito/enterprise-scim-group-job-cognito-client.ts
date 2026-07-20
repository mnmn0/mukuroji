import {
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider'
import type {
  EnterpriseScimGroupJobCognitoClient,
} from '../../application/ports/scim-group-job-worker-dependencies'
import { WorkspaceAccessError } from '../../../workspace-access'

/**
 * Cognito SDK を利用する SCIM user lifecycle client です。
 */
export class AwsEnterpriseScimGroupJobCognitoClient
  implements EnterpriseScimGroupJobCognitoClient
{
  /** Cognito user pool ID です。 */
  private readonly userPoolId: string
  /** Cognito Identity Provider SDK client です。 */
  private readonly client: CognitoIdentityProviderClient

  /**
   * Cognito user lifecycle client を作成します。
   */
  constructor(
    userPoolId = readRequiredEnvironment('COGNITO_USER_POOL_ID'),
    client = new CognitoIdentityProviderClient({}),
  ) {
    this.userPoolId = userPoolId
    this.client = client
  }

  /** Directory deprovisioning 後に新規認証を停止します。 */
  async disableWorkspaceUser(userId: string) {
    await this.client.send(new AdminDisableUserCommand({
      UserPoolId: this.userPoolId,
      Username: normalizeCognitoUserId(userId),
    }))
  }

  /** Directory reactivation 後に認証を再開します。 */
  async enableWorkspaceUser(userId: string) {
    await this.client.send(new AdminEnableUserCommand({
      UserPoolId: this.userPoolId,
      Username: normalizeCognitoUserId(userId),
    }))
  }

  /** Directory deprovisioning 後に refresh token を全失効させます。 */
  async globallySignOutWorkspaceUser(userId: string) {
    await this.client.send(new AdminUserGlobalSignOutCommand({
      UserPoolId: this.userPoolId,
      Username: normalizeCognitoUserId(userId),
    }))
  }
}

function readRequiredEnvironment(name: string) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new WorkspaceAccessError(
      503,
      'EnterpriseScimGroupJobConfigurationMissing',
      `${name} is required by the Enterprise SCIM group job worker.`,
    )
  }
  return value
}

function normalizeCognitoUserId(value: string) {
  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    throw new WorkspaceAccessError(
      503,
      'EnterpriseScimGroupJobUserInvalid',
      'SCIM group job Cognito user ID is invalid.',
    )
  }
  return normalized
}
