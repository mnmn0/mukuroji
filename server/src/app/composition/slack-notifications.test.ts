import { expect, spyOn, test } from 'bun:test'
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import { DynamoDbEnterpriseIdentityReadClient } from '../../modules/enterprise-identity'
import type { EnterpriseIdentitySnapshot } from '@mukuroji/contracts'
import * as notifications from '../../modules/notifications'
import type { SlackDelivery } from '../../modules/notifications/application/slack-delivery'
import * as tenants from './tenant-administration'
import { createProductionSlackNotificationHandler } from './slack-notifications'

test('production Slack authorization reloads Directory and Enterprise after revocation within one batch', async () => {
  const keys = ['NOTIFICATIONS_TABLE_NAME', 'ENTERPRISE_IDENTITY_TABLE_NAME', 'FILE_PROOFING_TABLE_NAME',
    'WORKSPACE_ACCESS_TABLE_NAME', 'PROJECT_DIRECTORY_TABLE_NAME', 'COGNITO_USER_POOL_ID']
  const previous = keys.map((key) => process.env[key])
  keys.forEach((key) => { process.env[key] = key })
  const memberKey = 'member@example.com'
  let revoked = false
  let source = 'directory'
  let directoryReads = 0
  let enterpriseReads = 0
  const tenant = spyOn(tenants, 'createProductionTenantAvailability').mockReturnValue({
    isActive: async () => true,
    createActiveWriteCondition: () => { throw new Error('Unexpected mutation') },
  })
  const groups = spyOn(CognitoIdentityProviderClient.prototype, 'send').mockImplementation(async () => ({ Groups: [], $metadata: {} }))
  const send = spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async (command) => {
    if (command instanceof GetCommand) return { Item: { entryType: 'workspace-member', memberKey, role: 'member', status: 'active' }, $metadata: {} }
    if (!(command instanceof QueryCommand)) throw new Error('Unexpected command')
    directoryReads += 1
    return { Items: [
      { entryType: 'team', teamId: 'core' }, { entryType: 'project', teamId: 'core', projectId: 'project' },
      ...(source !== 'directory' || !revoked ? [{ entryType: 'project-member', teamId: 'core', projectId: 'project', memberKey, role: 'viewer' }] : []),
    ], $metadata: {} }
  })
  const identity = spyOn(DynamoDbEnterpriseIdentityReadClient.prototype, 'getSnapshot').mockImplementation(async (): Promise<EnterpriseIdentitySnapshot> => {
    enterpriseReads += 1
    return { workspaceId: 'workspace-1', identityProviders: [], domains: [], groupMappings: [], scimUsers: [], scimGroups: [],
      scimCredentials: [], serviceAccounts: [], breakGlassAccounts: [], provisioningRuns: [], provisioningLogs: [],
      roleAssignments: source === 'enterprise' ? [{ workspaceId: 'workspace-1', assignmentId: 'assignment', principalKind: 'member',
        principalId: memberKey, roleId: 'custom:reader', source: 'direct', scope: { workspaceId: 'workspace-1', kind: 'workspace' } }] : [],
      customRoles: [{ workspaceId: 'workspace-1', roleId: 'custom:reader', name: 'Reader', permissions: revoked ? ['files.read'] : ['work-items.read'],
        guestAssignable: false, revision: 1, createdAt: '2026-09-26T00:00:00Z', updatedAt: '2026-09-26T00:00:00Z' }],
    }
  })
  const worker = spyOn(notifications, 'deliverDueSlackNotifications').mockImplementation(async (dependencies) => {
    const delivery: SlackDelivery = {
      workspaceId: 'workspace-1', memberKey, recipientKey: `workspace-1#${memberKey}`, notificationKey: 'notification',
      attempts: 0, version: 1, expiresAt: 2_000_000_000, nextAttemptAt: '2026-09-26T00:00:00Z',
      notification: { id: 'notification', eventId: 'event', eventType: 'comment.created', reasons: ['mention'],
        teamId: 'core', projectId: 'project', state: 'unread', occurredAt: '2026-09-26T00:00:00Z' },
    }
    expect(await dependencies.isAuthorized(delivery)).toBe(true)
    revoked = true
    expect(await dependencies.isAuthorized(delivery)).toBe(false)
    return 0
  })
  try {
    for (source of ['directory', 'enterprise']) {
      revoked = false
      await createProductionSlackNotificationHandler()()
    }
    expect(directoryReads).toBe(4)
    expect(enterpriseReads).toBe(4)
  } finally {
    worker.mockRestore()
    identity.mockRestore()
    send.mockRestore()
    groups.mockRestore()
    tenant.mockRestore()
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] })
  }
})
