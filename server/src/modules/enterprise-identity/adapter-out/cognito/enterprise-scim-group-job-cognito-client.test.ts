import { describe, expect, test } from 'bun:test'
import {
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminUserGlobalSignOutCommand,
  type CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider'
import { WorkspaceAccessError } from '../../../workspace-access'
import {
  AwsEnterpriseScimGroupJobCognitoClient,
} from './enterprise-scim-group-job-cognito-client'

describe('AwsEnterpriseScimGroupJobCognitoClient', () => {
  test('maps lifecycle operations to the configured Cognito user pool', async () => {
    const commands: unknown[] = []
    const client = {
      async send(command: unknown) {
        commands.push(command)
        return {}
      },
    } as unknown as CognitoIdentityProviderClient
    const adapter = new AwsEnterpriseScimGroupJobCognitoClient(
      'pool-1',
      client,
    )

    await adapter.disableWorkspaceUser(' USER@Example.COM ')
    await adapter.enableWorkspaceUser(' USER@Example.COM ')
    await adapter.globallySignOutWorkspaceUser(' USER@Example.COM ')

    expect(commands).toHaveLength(3)
    expect(commands[0]).toBeInstanceOf(AdminDisableUserCommand)
    expect(commands[1]).toBeInstanceOf(AdminEnableUserCommand)
    expect(commands[2]).toBeInstanceOf(AdminUserGlobalSignOutCommand)
    for (const command of commands as Array<{
      input: { UserPoolId?: string, Username?: string }
    }>) {
      expect(command.input).toEqual({
        UserPoolId: 'pool-1',
        Username: 'user@example.com',
      })
    }
  })

  test('rejects an empty normalized Cognito user ID before sending', async () => {
    let sendCount = 0
    const client = {
      async send() {
        sendCount += 1
        return {}
      },
    } as unknown as CognitoIdentityProviderClient
    const adapter = new AwsEnterpriseScimGroupJobCognitoClient(
      'pool-1',
      client,
    )

    try {
      await adapter.disableWorkspaceUser('   ')
      throw new Error('Expected an invalid user ID error.')
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceAccessError)
      expect((error as WorkspaceAccessError).code).toBe(
        'EnterpriseScimGroupJobUserInvalid',
      )
    }
    expect(sendCount).toBe(0)
  })
})
