import { expect, test } from 'bun:test'
import {
  TRIAGE_CONFIGURATION_SCHEMA_VERSION,
  TRIAGE_ENTRY_SCHEMA_VERSION,
  type TriageConfiguration,
  type TriageEntry,
} from '@mukuroji/contracts'
import { createTriageAdmissionValidator } from './api-dependencies'

const NOW = '2026-08-09T00:00:00.000Z'

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

test('rejects Team-level admission when the strongly read Team is missing', async () => {
  let directoryReads = 0
  let memberReads = 0
  const validateAdmission = createTriageAdmissionValidator({
    /** Returns a current directory without the target Team. */
    async getProjectDirectory(directoryId, locale, consistentRead) {
      directoryReads += 1
      expect({ directoryId, locale, consistentRead }).toEqual({
        directoryId: 'workspace-1',
        locale: 'en',
        consistentRead: true,
      })
      return { teams: [] }
    },
  }, {
    /** Records unexpected member reads after Team validation fails. */
    async getActiveMember() {
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
