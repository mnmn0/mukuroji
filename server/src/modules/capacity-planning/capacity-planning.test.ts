import { describe, expect, test } from 'bun:test'
import {
  CAPACITY_PLANNING_SCHEMA_VERSION,
  type WorkloadMemberProfile,
} from '@mukuroji/contracts'
import {
  buildWorkloadSnapshot,
  CapacityPlanningService,
  createDefaultWorkingSchedule,
  InMemoryCapacityPlanningRepository,
  type CapacityPlanningState,
  type WorkloadTimeEntry,
} from './capacity-planning'

const profile = createProfile('member-1', 'UTC')

describe('capacity planning calculations', () => {
  test('applies schedules, holidays, time off, and allocation across available dates', () => {
    const schedule = createDefaultWorkingSchedule()
    schedule.saturday = { enabled: true, minutes: 240 }
    const member = {
      ...profile,
      schedule,
      holidays: [{ date: '2026-08-04', label: 'Company day' }],
      timeOff: [{
        id: 'pto-1',
        fromDate: '2026-08-05',
        toDate: '2026-08-05',
        status: 'approved' as const,
        revision: 1,
      }],
    }
    const snapshot = buildWorkloadSnapshot(
      createState([member], [{
        id: 'assignment-1',
        workspaceId: 'workspace-1',
        teamId: 'team-1',
        memberId: 'member-1',
        skillIds: [],
        fromDate: '2026-08-03',
        toDate: '2026-08-06',
        allocationMinutes: 1_440,
        plannedEffortMinutes: 1_440,
        confidential: false,
        status: 'confirmed',
        revision: 1,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      }]),
      [],
      [],
      createInput({ fromDate: '2026-08-03', toDate: '2026-08-06' }),
      '2026-08-01T00:00:00.000Z',
    )

    const memberSummary = snapshot.members[0]
    expect(memberSummary.capacityMinutes).toBe(960)
    expect(memberSummary.allocatedMinutes).toBe(1_440)
    expect(memberSummary.cells.map((cell) => cell.capacityMinutes)).toEqual([480, 0, 0, 480])
    expect(memberSummary.cells.map((cell) => cell.allocatedMinutes)).toEqual([720, 0, 0, 720])
    expect(memberSummary.cells.map((cell) => cell.status)).toEqual(['over', 'unavailable', 'unavailable', 'over'])
  })

  test('splits actual submitted time at a DST-aware local midnight', () => {
    const member = createProfile('member-1', 'America/New_York')
    const entries: WorkloadTimeEntry[] = [{
      memberId: 'member-1',
      workItemId: 'work-item-1',
      startAt: '2026-03-08T06:30:00.000Z',
      endAt: '2026-03-08T08:30:00.000Z',
      durationMinutes: 120,
      status: 'approved',
    }]
    const snapshot = buildWorkloadSnapshot(
      createState([member]),
      entries,
      [{ workItemId: 'work-item-1', estimateMinutes: 240 }],
      createInput({ fromDate: '2026-03-08', toDate: '2026-03-08' }),
    )

    expect(snapshot.members[0]?.cells[0]).toMatchObject({
      actualMinutes: 120,
      remainingEffortMinutes: 0,
    })
  })

  test('redacts confidential assignments while retaining an explicit redaction count', () => {
    const assignment = createAssignment('secret', true)
    const snapshot = buildWorkloadSnapshot(
      createState([profile], [assignment]),
      [],
      [],
      createInput({ fromDate: '2026-08-03', toDate: '2026-08-03', canViewConfidential: false }),
    )

    expect(snapshot.assignments).toEqual([])
    expect(snapshot.redactedAssignmentCount).toBe(1)
    expect(snapshot.members[0]?.allocatedMinutes).toBe(0)
  })

  test('aggregates capacity into Monday-first weeks and preserves over-allocation evidence', () => {
    const snapshot = buildWorkloadSnapshot(
      createState([profile], [createAssignment('assignment-1', false, '2026-08-03', '2026-08-14', 4_800)]),
      [],
      [],
      createInput({
        fromDate: '2026-08-03',
        toDate: '2026-08-14',
        granularity: 'week',
      }),
    )

    expect(snapshot.members[0]?.cells).toHaveLength(2)
    expect(snapshot.members[0]?.cells.map((cell) => cell.fromDate)).toEqual(['2026-08-03', '2026-08-10'])
    expect(snapshot.members[0]?.cells.every((cell) => cell.status === 'balanced')).toBe(true)
  })
})

describe('capacity planning mutations', () => {
  test('uses a Team revision and profile revision to reject stale writes', async () => {
    const repository = new InMemoryCapacityPlanningRepository()
    const service = new CapacityPlanningService(
      repository,
      { listTimeEntries: async () => [], listEstimates: async () => [] },
      { now: () => new Date('2026-08-01T00:00:00.000Z'), createId: () => 'generated-id' },
    )
    await service.saveMemberProfile({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      memberId: 'member-1',
      skills: ['typescript'],
      timeZone: 'UTC',
      schedule: createDefaultWorkingSchedule(),
      holidays: [],
      expectedRevision: 0,
      expectedTeamRevision: 0,
      actorMemberId: 'member-1',
    })

    await expect(service.saveMemberProfile({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      memberId: 'member-1',
      skills: ['typescript'],
      timeZone: 'UTC',
      schedule: createDefaultWorkingSchedule(),
      holidays: [],
      expectedRevision: 1,
      expectedTeamRevision: 0,
      actorMemberId: 'member-1',
    })).rejects.toMatchObject({
      code: 'CapacityPlanningRevisionConflict',
      status: 409,
    })
  })
})

function createProfile(memberId: string, timeZone: string): WorkloadMemberProfile {
  return {
    schemaVersion: CAPACITY_PLANNING_SCHEMA_VERSION,
    workspaceId: 'workspace-1',
    teamId: 'team-1',
    memberId,
    displayName: memberId,
    skills: [],
    timeZone,
    schedule: createDefaultWorkingSchedule(),
    holidays: [],
    timeOff: [],
    revision: 1,
    updatedAt: '2026-08-01T00:00:00.000Z',
  }
}

function createAssignment(
  id: string,
  confidential: boolean,
  fromDate = '2026-08-03',
  toDate = fromDate,
  allocationMinutes = 480,
) {
  return {
    id,
    workspaceId: 'workspace-1',
    teamId: 'team-1',
    memberId: 'member-1',
    skillIds: [],
    fromDate,
    toDate,
    allocationMinutes,
    plannedEffortMinutes: allocationMinutes,
    confidential,
    status: 'confirmed' as const,
    revision: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  }
}

function createState(
  profiles: WorkloadMemberProfile[],
  assignments: ReturnType<typeof createAssignment>[] = [],
): CapacityPlanningState {
  return { revision: 1, profiles, requests: [], assignments }
}

function createInput(overrides: Partial<Parameters<typeof buildWorkloadSnapshot>[3]> = {}) {
  return {
    workspaceId: 'workspace-1',
    teamId: 'team-1',
    fromDate: '2026-08-03',
    toDate: '2026-08-03',
    granularity: 'day' as const,
    canViewConfidential: true,
    ...overrides,
  }
}
