import { describe, expect, test } from 'bun:test'
import {
  type ConfirmWorkItemScheduleChangeResponse,
  type WorkItemSchedule,
  type WorkItemScheduleChangePreview,
} from '@mukuroji/contracts'
import {
  confirmWorkItemScheduleChange,
  type ConfirmWorkItemScheduleChangeCommand,
  type PersistConfirmedWorkItemScheduleChange,
} from './confirm-work-item-schedule-change'

const beforeSchedule = createDueDateSchedule('2026-07-20')
const rootSchedule = createDueDateSchedule('2026-07-21')
const successorSchedule = createDueDateSchedule('2026-07-22')

const expectedImpacts = [{
  teamId: 'core-team',
  workItemId: 'root',
  kind: 'direct',
  expectedRevision: 4,
  before: beforeSchedule,
  after: rootSchedule,
  dateDeltaDays: 1,
}, {
  teamId: 'other-team',
  workItemId: 'successor',
  kind: 'dependency',
  expectedRevision: 2,
  before: beforeSchedule,
  after: successorSchedule,
  dateDeltaDays: 2,
  dependencyId: 'dependency-1',
}] satisfies WorkItemScheduleChangePreview['impacts']

const expectedEvaluatedRevisions = [{
  teamId: 'core-team',
  workItemId: 'root',
  expectedRevision: 4,
}, {
  teamId: 'guard-team',
  workItemId: 'fan-in',
  expectedRevision: 7,
}, {
  teamId: 'other-team',
  workItemId: 'successor',
  expectedRevision: 2,
}]

const command: ConfirmWorkItemScheduleChangeCommand = {
  teamId: 'core-team',
  workItemId: 'root',
  expectedRevision: 4,
  expectedPlanningRevision: 8,
  expectedRelationGraphRevision: 3,
  expectedEvaluatedRevisions,
  expectedImpacts,
  operation: { type: 'move', targetDate: '2026-07-21' },
  reservationRequest: {
    workspaceId: 'workspace-1',
    credentialId: 'user-1',
    idempotencyKey: 'confirm-1',
    requestFingerprint: 'fingerprint-1',
  },
}

const preview: WorkItemScheduleChangePreview = {
  expectedRevision: 4,
  impacts: expectedImpacts,
  evaluatedRevisions: expectedEvaluatedRevisions,
  relationGraphRevision: 3,
  planningRevision: 8,
  conflicts: [],
  affectedProjects: [],
  affectedMilestoneIds: [],
  requiresConfirmation: true,
  warnings: [],
}

const response: ConfirmWorkItemScheduleChangeResponse = {
  workItems: [{
    id: 'root',
    teamId: 'core-team',
    revision: 5,
    schedule: rootSchedule,
    dueDate: '2026-07-21',
  }, {
    id: 'successor',
    teamId: 'other-team',
    revision: 3,
    schedule: successorSchedule,
    dueDate: '2026-07-22',
  }],
}

describe('confirmWorkItemScheduleChange', () => {
  test('persists only an exactly matched fresh preview and guards unchanged inputs', async () => {
    let persisted: PersistConfirmedWorkItemScheduleChange | undefined
    let releaseCount = 0

    const result = await confirmWorkItemScheduleChange(command, {
      async reserve() {
        return { status: 'reserved', reservationId: 'reservation-1' }
      },
      async release() {
        releaseCount += 1
      },
      async replay() {
        throw new Error('Replay must not be used for a new reservation.')
      },
      async recompute() {
        return preview
      },
      async persist(input) {
        persisted = input
        return response
      },
    })

    expect(result).toEqual(response)
    expect(releaseCount).toBe(0)
    expect(persisted).toEqual({
      updates: [{
        teamId: 'core-team',
        workItemId: 'root',
        expectedRevision: 4,
        schedule: rootSchedule,
      }, {
        teamId: 'other-team',
        workItemId: 'successor',
        expectedRevision: 2,
        schedule: successorSchedule,
      }],
      guardedRevisions: [{
        teamId: 'guard-team',
        workItemId: 'fan-in',
        expectedRevision: 7,
      }],
      expectedPlanningRevision: 8,
      expectedRelationGraphRevision: 3,
      authorizationEndpoints: expectedEvaluatedRevisions,
      reservation: {
        ...command.reservationRequest,
        reservationId: 'reservation-1',
      },
    })
  })

  test('releases a new reservation when recomputation no longer matches consent', async () => {
    let releaseCount = 0
    let persistCount = 0

    await expect(confirmWorkItemScheduleChange(command, {
      async reserve() {
        return { status: 'reserved', reservationId: 'reservation-1' }
      },
      async release() {
        releaseCount += 1
      },
      async replay() {
        return response
      },
      async recompute() {
        return {
          ...preview,
          impacts: preview.impacts.map((impact, index) =>
            index === 0 ? { ...impact, dateDeltaDays: 9 } : impact
          ),
        }
      },
      async persist() {
        persistCount += 1
        return response
      },
    })).rejects.toMatchObject({
      code: 'WorkItemSchedulePreviewStale',
      status: 409,
    })

    expect(releaseCount).toBe(1)
    expect(persistCount).toBe(0)
  })

  test('reauthorizes and returns a completed replay without recomputation', async () => {
    let replayValue: unknown
    let recomputeCount = 0
    let releaseCount = 0

    const result = await confirmWorkItemScheduleChange(command, {
      async reserve() {
        return { status: 'replay', response: { stored: true } }
      },
      async release() {
        releaseCount += 1
      },
      async replay(value) {
        replayValue = value
        return response
      },
      async recompute() {
        recomputeCount += 1
        return preview
      },
      async persist() {
        throw new Error('A replay must not persist again.')
      },
    })

    expect(result).toEqual(response)
    expect(replayValue).toEqual({ stored: true })
    expect(recomputeCount).toBe(0)
    expect(releaseCount).toBe(0)
  })
})

/** Creates a deterministic due-date schedule for use-case fixtures. */
function createDueDateSchedule(dueDate: string): WorkItemSchedule {
  return {
    mode: 'due-date',
    dueDate,
    calendarPolicy: {
      timeZone: 'UTC',
      workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      holidays: [],
    },
  }
}
