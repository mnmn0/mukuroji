import { expect, test } from 'bun:test'
import {
  TRIAGE_CONFIGURATION_SCHEMA_VERSION,
  TRIAGE_ENTRY_SCHEMA_VERSION,
  type TriageConfiguration,
  type TriageEntry,
  type UpdateTriageConfigurationInput,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../../modules/directory'
import {
  createProductionAiAssistanceDependencies,
  createTriageActionReferenceValidator,
  createTriageAdmissionValidator,
  createTriageConfigurationReferenceValidator,
} from './api-dependencies'
import type { AuditEventsClient } from './app-dependencies'

const NOW = '2026-08-09T00:00:00.000Z'

const TEST_AUDIT_EVENTS = {
  async getEvent() {
    return undefined
  },
  async query() {
    return { events: [] }
  },
} satisfies AuditEventsClient

const ENTRY = {
  schemaVersion: TRIAGE_ENTRY_SCHEMA_VERSION,
  id: 'triage-form-1',
  workspaceId: 'workspace-1',
  source: {
    kind: 'form',
    sourceId: 'submission-1',
    formId: 'form-1',
    submissionId: 'submission-1',
  },
  sourcePreview: {
    title: 'Request',
    body: 'Please help.',
    attachmentCount: 0,
    commentCount: 0,
    watcherCount: 0,
    sanitized: true,
    truncated: false,
  },
  requester: { displayName: 'Requester', guest: false },
  receivedAt: NOW,
  lastActivityAt: NOW,
  state: 'pending',
  routing: {
    reason: 'Submitted from Request Intake.',
    candidates: [{
      teamId: 'support',
      reason: 'Form target Team.',
      permitted: true,
    }],
  },
  teamId: 'support',
  permission: {
    visibility: 'full',
    canReply: false,
    guestVisible: false,
    checkedAt: NOW,
  },
  retention: { expiresAt: '2027-08-09T00:00:00.000Z' },
  capabilities: {
    canAssign: true,
    canAcceptCreate: true,
    canAcceptLink: true,
    canMarkDuplicate: true,
    canDecline: true,
    canSnooze: true,
    canRequestInformation: false,
    canReply: false,
    canViewInternalContext: true,
  },
  events: [],
  revision: 1,
  createdAt: NOW,
  updatedAt: NOW,
} satisfies TriageEntry

const CONFIGURATION = {
  schemaVersion: TRIAGE_CONFIGURATION_SCHEMA_VERSION,
  workspaceId: 'workspace-1',
  teamId: 'support',
  rules: [],
  rotations: [],
  slaPolicies: [],
  allowedBulkActions: ['assign', 'decline', 'snooze'],
  retentionDays: 365,
  revision: 0,
  updatedAt: NOW,
} satisfies TriageConfiguration

test('lazily rejects Bedrock bearer-token authentication before creating a provider', () => {
  const originalBearerToken = Bun.env.AWS_BEARER_TOKEN_BEDROCK
  Bun.env.AWS_BEARER_TOKEN_BEDROCK = 'must-not-be-used'
  try {
    const dependencies = createProductionAiAssistanceDependencies(TEST_AUDIT_EVENTS)
    expect(() => dependencies.aiAssistanceService.getPolicy({
      workspaceId: 'workspace-1',
      memberId: 'member-1',
      traceId: 'trace-1',
      canManagePolicy: false,
    })).toThrow('AWS_BEARER_TOKEN_BEDROCK is not supported')
  } finally {
    if (originalBearerToken === undefined) {
      delete Bun.env.AWS_BEARER_TOKEN_BEDROCK
    } else {
      Bun.env.AWS_BEARER_TOKEN_BEDROCK = originalBearerToken
    }
  }
})

test('lazily rejects a non-positive AI generation budget setting', () => {
  const environmentName = 'AI_ASSISTANCE_MEMBER_GENERATIONS_PER_MINUTE'
  const original = Bun.env[environmentName]
  Bun.env[environmentName] = '0'
  try {
    const dependencies = createProductionAiAssistanceDependencies(TEST_AUDIT_EVENTS)
    expect(() => dependencies.aiAssistanceService.getPolicy({
      workspaceId: 'workspace-1',
      memberId: 'member-1',
      traceId: 'trace-1',
      canManagePolicy: false,
    })).toThrow(`${environmentName} must be a positive integer.`)
  } finally {
    if (original === undefined) {
      delete Bun.env[environmentName]
    } else {
      Bun.env[environmentName] = original
    }
  }
})

test('lazily rejects incomplete or invalid Bedrock pricing configuration', () => {
  const inputName = 'AI_ASSISTANCE_BEDROCK_INPUT_PRICE_PER_MILLION_TOKENS_USD'
  const outputName = 'AI_ASSISTANCE_BEDROCK_OUTPUT_PRICE_PER_MILLION_TOKENS_USD'
  const originalInput = Bun.env[inputName]
  const originalOutput = Bun.env[outputName]
  try {
    Bun.env[inputName] = '3'
    delete Bun.env[outputName]
    const incomplete = createProductionAiAssistanceDependencies(TEST_AUDIT_EVENTS)
    expect(() => incomplete.aiAssistanceService.getPolicy({
      workspaceId: 'workspace-1',
      memberId: 'member-1',
      traceId: 'trace-1',
      canManagePolicy: false,
    })).toThrow('input and output token prices must be configured together')

    Bun.env[inputName] = 'not-a-price'
    Bun.env[outputName] = '15'
    const invalid = createProductionAiAssistanceDependencies(TEST_AUDIT_EVENTS)
    expect(() => invalid.aiAssistanceService.getPolicy({
      workspaceId: 'workspace-1',
      memberId: 'member-1',
      traceId: 'trace-1',
      canManagePolicy: false,
    })).toThrow(`${inputName} must be a positive decimal number.`)
  } finally {
    if (originalInput === undefined) delete Bun.env[inputName]
    else Bun.env[inputName] = originalInput
    if (originalOutput === undefined) delete Bun.env[outputName]
    else Bun.env[outputName] = originalOutput
  }
})

test('rejects Team-level admission when the strongly read Team is missing', async () => {
  let directoryReads = 0
  let memberReads = 0
  const validateAdmission = createTriageAdmissionValidator({
    /** Reports that the current active Team row is unavailable. */
    async createActiveReferenceConditionChecks(directoryId, teamId, projectId) {
      directoryReads += 1
      expect({ directoryId, teamId, projectId }).toEqual({
        directoryId: 'workspace-1',
        teamId: 'support',
        projectId: undefined,
      })
      throw new ProjectDataError(404, 'TeamNotFound', 'Team not found.')
    },
    /** Is not reached when the active Team reference is unavailable. */
    async createProjectAccessConditionCheck() {
      throw new Error('Project access should not be read after Team validation fails.')
    },
  }, {
    /** Records unexpected member reads after Team validation fails. */
    async createActiveMemberConditionCheck() {
      memberReads += 1
      return undefined
    },
  })

  await expect(validateAdmission(ENTRY, CONFIGURATION)).rejects.toMatchObject({
    status: 409,
    code: 'TriageAdmissionTeamUnavailable',
  })
  expect(directoryReads).toBe(1)
  expect(memberReads).toBe(0)
})

test('returns distinct Team/Project guards and one version guard for a shared owner', async () => {
  const entry = {
    ...ENTRY,
    projectId: 'project-1',
    ownerUserId: 'Owner@Example.com',
    sla: {
      policyId: 'support-sla',
      dueAt: '2026-08-09T01:00:00.000Z',
      escalationDueAt: '2026-08-09T01:30:00.000Z',
    },
  } satisfies TriageEntry
  const configuration = {
    ...CONFIGURATION,
    slaPolicies: [{
      id: 'support-sla',
      name: 'Support SLA',
      sourceKinds: ['form'],
      responseMinutes: 60,
      escalationMinutes: 30,
      escalationOwnerUserId: 'owner@example.com',
    }],
  } satisfies TriageConfiguration
  let memberReads = 0
  const memberOptions: unknown[] = []
  const projectAccessReads: string[] = []
  const validateAdmission = createTriageAdmissionValidator({
    /** Returns exact active Team and Project row guards. */
    async createActiveReferenceConditionChecks(directoryId, teamId, projectId) {
      expect({ directoryId, teamId, projectId }).toEqual({
        directoryId: 'workspace-1',
        teamId: 'support',
        projectId: 'project-1',
      })
      return [{
        ConditionCheck: {
          TableName: 'ProjectDirectoryTable',
          Key: { directoryId, entryKey: 'TEAM#support' },
          ConditionExpression: '#entryType = :team',
        },
      }, {
        ConditionCheck: {
          TableName: 'ProjectDirectoryTable',
          Key: { directoryId, entryKey: 'PROJECT#project-1' },
          ConditionExpression: '#entryType = :project',
        },
      }]
    },
    /** Returns the exact destination Project membership guard. */
    async createProjectAccessConditionCheck(_workspaceId, projectId, memberUserId) {
      projectAccessReads.push(`${projectId}:${memberUserId}`)
      return {
        ConditionCheck: {
          TableName: 'ProjectDirectoryTable',
          Key: { projectId, memberUserId },
          ConditionExpression: '#entryType = :projectMember',
        },
      }
    },
  }, {
    /** Returns the exact active membership version guard. */
    async createActiveMemberConditionCheck(workspaceId, memberUserId, options) {
      memberReads += 1
      memberOptions.push(options)
      expect({ workspaceId, memberUserId }).toEqual({
        workspaceId: 'workspace-1',
        memberUserId: 'owner@example.com',
      })
      return {
        ConditionCheck: {
          TableName: 'WorkspaceAccessTable',
          Key: { workspaceId, recordKey: 'MEMBER#owner@example.com' },
          ConditionExpression: '#status = :active AND #version = :version',
        },
      }
    },
  })

  const contribution = await validateAdmission(entry, configuration)

  expect(memberReads).toBe(1)
  expect(memberOptions).toEqual([{
    allowedRoles: ['owner', 'admin', 'member'],
  }])
  expect(projectAccessReads).toEqual(['project-1:owner@example.com'])
  expect(contribution.transactItems).toHaveLength(4)
  expect(contribution.transactItems.map((item) => item.ConditionCheck?.TableName)).toEqual([
    'ProjectDirectoryTable',
    'ProjectDirectoryTable',
    'WorkspaceAccessTable',
    'ProjectDirectoryTable',
  ])
})

test('rejects admission when a configured owner lacks destination Project access', async () => {
  const validateAdmission = createTriageAdmissionValidator({
    /** Returns an active destination Project without a membership grant. */
    async createActiveReferenceConditionChecks() {
      return []
    },
    /** Simulates the owner Project membership disappearing before admission. */
    async createProjectAccessConditionCheck() {
      return undefined
    },
  }, {
    /** Keeps Workspace membership valid so the Project check is reached. */
    async createActiveMemberConditionCheck() {
      return {
        ConditionCheck: {
          TableName: 'WorkspaceAccessTable',
          Key: { workspaceId: 'workspace-1', recordKey: 'MEMBER#owner@example.com' },
          ConditionExpression: '#status = :active',
        },
      }
    },
  })

  await expect(validateAdmission({
    ...ENTRY,
    ownerUserId: 'owner@example.com',
    projectId: 'project-1',
  }, CONFIGURATION)).rejects.toMatchObject({
    status: 409,
    code: 'TriageAdmissionOwnerProjectUnavailable',
  })
})

test('binds every configured Project and member reference to settings persistence', async () => {
  const projectReads: (string | undefined)[] = []
  const memberReads: string[] = []
  const projectAccessReads: string[] = []
  const memberOptions: unknown[] = []
  const validate = createTriageConfigurationReferenceValidator({
    async createActiveReferenceConditionChecks(directoryId, teamId, projectId) {
      projectReads.push(projectId)
      return [{
        ConditionCheck: {
          TableName: 'ProjectDirectoryTable',
          Key: { directoryId, entryKey: projectId ? `PROJECT#${projectId}` : `TEAM#${teamId}` },
          ConditionExpression: 'attribute_not_exists(archivedAt)',
        },
      }, ...(projectId ? [{
        ConditionCheck: {
          TableName: 'ProjectDirectoryTable',
          Key: { directoryId, entryKey: `PROJECT#${projectId}` },
          ConditionExpression: 'attribute_not_exists(archivedAt)',
        },
      }] : [])]
    },
    async createProjectAccessConditionCheck(_workspaceId, projectId, memberUserId) {
      projectAccessReads.push(`${projectId}:${memberUserId}`)
      return {
        ConditionCheck: {
          TableName: 'ProjectDirectoryTable',
          Key: { projectId, memberUserId },
          ConditionExpression: '#entryType = :projectMember',
        },
      }
    },
  }, {
    async createActiveMemberConditionCheck(workspaceId, memberKey, options) {
      memberReads.push(memberKey)
      memberOptions.push(options)
      return {
        ConditionCheck: {
          TableName: 'WorkspaceAccessTable',
          Key: { workspaceId, recordKey: `MEMBER#${memberKey}` },
          ConditionExpression: '#status = :active AND #version = :version',
        },
      }
    },
  })
  const input = {
    ...CONFIGURATION,
    expectedRevision: 0,
    rules: [{
      id: 'rule-1',
      name: 'Support',
      enabled: true,
      order: 1,
      sourceKinds: ['form'],
      keywords: [],
      teamId: 'support',
      projectId: 'project-1',
      owner: { type: 'fixed', ownerUserId: 'Fixed@Example.com' },
    }],
    rotations: [{
      id: 'rotation-1',
      name: 'Support rotation',
      memberUserIds: ['Rotate@Example.com'],
      nextIndex: 0,
    }],
    slaPolicies: [{
      id: 'sla-1',
      name: 'Support SLA',
      sourceKinds: ['form'],
      responseMinutes: 60,
      escalationOwnerUserId: 'Escalation@Example.com',
    }],
  } satisfies UpdateTriageConfigurationInput

  const contribution = await validate('workspace-1', 'support', input)

  expect(projectReads).toEqual([undefined, 'project-1'])
  expect(memberReads.sort()).toEqual([
    'escalation@example.com',
    'fixed@example.com',
    'rotate@example.com',
  ])
  expect(memberOptions).toEqual([
    { allowedRoles: ['owner', 'admin', 'member'] },
    { allowedRoles: ['owner', 'admin', 'member'] },
    { allowedRoles: ['owner', 'admin', 'member'] },
  ])
  expect(projectAccessReads).toEqual([
    'project-1:fixed@example.com',
    'project-1:escalation@example.com',
  ])
  expect(contribution.transactItems).toHaveLength(7)
})

test('binds assignment destination and owner references to the action transaction', async () => {
  const validate = createTriageActionReferenceValidator({
    async createActiveReferenceConditionChecks() {
      return [{
        ConditionCheck: {
          TableName: 'ProjectDirectoryTable',
          Key: { entryKey: 'TEAM#support' },
          ConditionExpression: 'attribute_not_exists(archivedAt)',
        },
      }]
    },
  }, {
    async createActiveMemberConditionCheck() {
      return {
        ConditionCheck: {
          TableName: 'WorkspaceAccessTable',
          Key: { recordKey: 'MEMBER#owner@example.com' },
          ConditionExpression: '#status = :active',
        },
      }
    },
  })

  const contribution = await validate('workspace-1', 'support', ENTRY, {
    action: 'assign',
    expectedRevision: 1,
    ownerUserId: 'Owner@Example.com',
    projectId: null,
  })

  expect(contribution.transactItems).toHaveLength(2)
})
