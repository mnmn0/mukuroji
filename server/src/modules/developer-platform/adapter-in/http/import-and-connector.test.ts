import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  resetTestApp,
} = createApiTestHarness()
import {
  canManageWorkItemImports,
  createImportRowCreateIdentity,
  readConnectorSyncOriginPreviousSigningSecrets,
  toWorkItemImportWorkerError,
} from '../../../../api/api-router'
import { WorkspaceAccessError } from '../../../workspace-access/workspace-access'
import {
  WorkItemConfigurationError,
} from '../../../work-items/work-item-configuration'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'
import type { CreateWorkItemInput } from '@mukuroji/contracts'

afterEach(() => {
  resetTestApp()
})

test('validates previous connector origin signing secrets for production rotation', () => {
  const first = 'previous-origin-signing-secret-number-one'
  const second = 'previous-origin-signing-secret-number-two'
  expect(readConnectorSyncOriginPreviousSigningSecrets(
    JSON.stringify([`  ${first}  `, second]),
  )).toEqual([first, second])
  expect(readConnectorSyncOriginPreviousSigningSecrets(undefined)).toEqual([])
  for (const invalid of [
    'not-json',
    '{}',
    JSON.stringify(['short']),
    JSON.stringify([first, second, first, second]),
  ]) {
    expect(() => readConnectorSyncOriginPreviousSigningSecrets(invalid))
      .toThrow(
        'CONNECTOR_SYNC_ORIGIN_PREVIOUS_SIGNING_SECRETS_JSON must be a JSON array of up to three strings containing at least 32 bytes.',
      )
  }
})

test('scopes deterministic import row identities to the Workspace actor', () => {
  const context = {
    requestId: 'request-import-row',
    idempotencyKey: 'import-same-client-key-row-1',
  }
  const input: CreateWorkItemInput = {
    title: 'Imported row',
    assigneeUserId: 'assignee@example.com',
    schedule: {
      calendarPolicy: {
        holidays: [],
        timeZone: 'UTC',
        workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      },
      dueDate: '2026-07-31',
      mode: 'due-date',
    },
    priority: 'medium',
  }
  const firstActor = createImportRowCreateIdentity(
    'workspace-1',
    'user-1',
    context,
    'team-1',
    input,
  )
  const firstActorRetry = createImportRowCreateIdentity(
    'workspace-1',
    'user-1',
    context,
    'team-1',
    input,
  )
  const secondActor = createImportRowCreateIdentity(
    'workspace-1',
    'user-2',
    context,
    'team-1',
    input,
  )
  const changedPayload = createImportRowCreateIdentity(
    'workspace-1',
    'user-1',
    context,
    'team-1',
    { ...input, title: 'Different imported row' },
  )

  expect(firstActorRetry).toEqual(firstActor)
  expect(secondActor.issueId).not.toBe(firstActor.issueId)
  expect(secondActor.requestDigest).not.toBe(firstActor.requestDigest)
  expect(changedPayload.issueId).toBe(firstActor.issueId)
  expect(changedPayload.requestDigest).not.toBe(firstActor.requestDigest)
})

test('requires current Workspace administration for queued import execution', () => {
  expect(canManageWorkItemImports('owner')).toBe(true)
  expect(canManageWorkItemImports('admin')).toBe(true)
  expect(canManageWorkItemImports('member')).toBe(false)
  expect(canManageWorkItemImports('guest')).toBe(false)
})

test('retries import configuration conflicts but terminalizes revoked access', () => {
  expect(toWorkItemImportWorkerError(new WorkItemConfigurationError(
    409,
    'WorkItemConfigurationRevisionConflict',
    'Configuration changed concurrently.',
  ))).toMatchObject({
    code: 'ImportConcurrentMutation',
    retryable: true,
  })
  expect(toWorkItemImportWorkerError(new WorkspaceAccessError(
    403,
    'WorkspaceRoleDenied',
    'Workspace management permission changed.',
  ))).toMatchObject({
    code: 'ImportAuthorizationRejected',
    retryable: false,
  })
  expect(toWorkItemImportWorkerError(new WorkspaceAccessError(
    409,
    'WorkspaceAssigneeInactive',
    'Only active Workspace members can be assigned.',
  ))).toMatchObject({
    code: 'ImportValidationRejected',
    retryable: false,
  })
})
