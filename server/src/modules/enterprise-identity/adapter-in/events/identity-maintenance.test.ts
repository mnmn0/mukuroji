import { expect, test } from 'bun:test'
import {
  processEnterpriseIdentityMaintenanceBatch,
  readEnterpriseIdentityControlWorkspace,
} from './identity-maintenance'

test('dispatches only validated enterprise identity CONTROL stream records', async () => {
  const workspaceIds: string[] = []
  const record = {
    eventName: 'MODIFY',
    dynamodb: {
      SequenceNumber: 'sequence-1',
      NewImage: {
        scopeKey: { S: 'WORKSPACE#workspace-1' },
        recordKey: { S: 'CONTROL' },
        entryType: { S: 'enterprise-identity-control' },
        workspaceId: { S: 'workspace-1' },
      },
    },
  }
  expect(readEnterpriseIdentityControlWorkspace(record)).toBe('workspace-1')
  await expect(processEnterpriseIdentityMaintenanceBatch({
    Records: [
      record,
      {
        eventName: 'INSERT',
        dynamodb: {
          SequenceNumber: 'sequence-ignored',
          NewImage: {
            scopeKey: { S: 'WORKSPACE_STATE#workspace-1#generation-1' },
            recordKey: { S: 'GENERATION' },
            entryType: { S: 'enterprise-identity-generation' },
            workspaceId: { S: 'workspace-1' },
          },
        },
      },
    ],
  }, {
    async maintainWorkspace(workspaceId) {
      workspaceIds.push(workspaceId)
    },
  })).resolves.toEqual({ batchItemFailures: [] })
  expect(workspaceIds).toEqual(['workspace-1'])
})

test('returns the failed CONTROL sequence for partial stream retry', async () => {
  await expect(processEnterpriseIdentityMaintenanceBatch({
    Records: [{
      eventName: 'INSERT',
      dynamodb: {
        SequenceNumber: 'sequence-failed',
        NewImage: {
          scopeKey: { S: 'WORKSPACE#workspace-1' },
          recordKey: { S: 'CONTROL' },
          entryType: { S: 'enterprise-identity-control' },
          workspaceId: { S: 'workspace-1' },
        },
      },
    }],
  }, {
    async maintainWorkspace() {
      throw new Error('Injected maintenance failure')
    },
  })).resolves.toEqual({
    batchItemFailures: [{ itemIdentifier: 'sequence-failed' }],
  })
})
