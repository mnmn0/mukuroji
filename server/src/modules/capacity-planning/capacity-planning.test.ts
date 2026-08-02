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
      role: 'Engineer',
      skills: ['typescript'],
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
    expect(memberSummary).toMatchObject({
      role: 'Engineer',
      skills: ['typescript'],
      holidays: [{ date: '2026-08-04', label: 'Company day' }],
    })
    expect(memberSummary.schedule).toEqual(schedule)
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

  test('preserves the rounded entry duration when splitting across local midnight', () => {
    const snapshot = buildWorkloadSnapshot(
      createState([profile]),
      [{
        memberId: 'member-1',
        workItemId: 'work-item-1',
        startAt: '2026-08-03T23:59:40.000Z',
        endAt: '2026-08-04T00:00:20.000Z',
        durationMinutes: 1,
        status: 'approved',
      }],
      [],
      createInput({ fromDate: '2026-08-03', toDate: '2026-08-04' }),
    )

    expect(snapshot.members[0]?.actualMinutes).toBe(1)
  })

  test('distributes an assignment over its full range before selecting the view slice', () => {
    const snapshot = buildWorkloadSnapshot(
      createState([profile], [createAssignment('long-assignment', false, '2026-08-03', '2026-08-14', 480)]),
      [],
      [],
      createInput({ fromDate: '2026-08-10', toDate: '2026-08-10' }),
    )

    expect(snapshot.members[0]?.allocatedMinutes).toBe(48)
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

  test('filters project-scoped assignments from a restricted workload view', () => {
    const assignment = { ...createAssignment('project-secret', false), projectId: 'project-secret' }
    const snapshot = buildWorkloadSnapshot(
      createState([profile], [assignment]),
      [],
      [],
      createInput({ visibleProjectIds: new Set(['project-visible']) }),
    )

    expect(snapshot.assignments).toEqual([])
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

  test('keeps remaining effort when an earlier assignment for the Work Item is outside the range', () => {
    const assignments = [
      { ...createAssignment('outside-range', false, '2026-08-01'), workItemId: 'work-item-1' },
      { ...createAssignment('inside-range', false), workItemId: 'work-item-1' },
    ]
    const snapshot = buildWorkloadSnapshot(
      createState([profile], assignments),
      [],
      [{ workItemId: 'work-item-1', estimateMinutes: 480 }],
      createInput(),
    )

    expect(snapshot.members[0]?.remainingEffortMinutes).toBe(480)
  })

  test('distributes one Work Item remaining effort across multiple member assignments', () => {
    const secondMember = createProfile('member-2', 'UTC')
    const assignments = [
      { ...createAssignment('assignment-a', false), workItemId: 'work-item-1', plannedEffortMinutes: 240 },
      { ...createAssignment('assignment-b', false), memberId: 'member-2', workItemId: 'work-item-1', plannedEffortMinutes: 240 },
    ]
    const snapshot = buildWorkloadSnapshot(
      createState([profile, secondMember], assignments),
      [],
      [{ workItemId: 'work-item-1', estimateMinutes: 480 }],
      createInput(),
    )

    expect(snapshot.members.map((member) => member.remainingEffortMinutes)).toEqual([240, 240])
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

  test('updates a request timestamp only when its fill status changes', async () => {
    const repository = new InMemoryCapacityPlanningRepository()
    let now = new Date('2026-08-01T00:00:00.000Z')
    const service = new CapacityPlanningService(
      repository,
      { listTimeEntries: async () => [], listEstimates: async () => [] },
      { now: () => now, createId: () => 'generated-id' },
    )
    await service.saveMemberProfile({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      memberId: 'member-1',
      skills: [],
      timeZone: 'UTC',
      schedule: createDefaultWorkingSchedule(),
      holidays: [],
      expectedRevision: 0,
      expectedTeamRevision: 0,
      actorMemberId: 'member-1',
    })
    const request = await service.createRequest({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      title: 'Release support',
      skillIds: [],
      fromDate: '2026-08-03',
      toDate: '2026-08-03',
      requestedMinutes: 480,
      confidential: false,
      expectedTeamRevision: 1,
      actorMemberId: 'member-1',
    })
    now = new Date('2026-08-02T00:00:00.000Z')
    await service.createAssignment({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      requestId: request.id,
      memberId: 'member-1',
      skillIds: [],
      fromDate: '2026-08-03',
      toDate: '2026-08-03',
      allocationMinutes: 480,
      plannedEffortMinutes: 480,
      confidential: false,
      status: 'confirmed',
      expectedTeamRevision: 2,
      actorMemberId: 'member-1',
    })

    const snapshot = await service.getSnapshot({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      fromDate: '2026-08-03',
      toDate: '2026-08-03',
      granularity: 'day',
      canViewConfidential: true,
    })
    expect(snapshot.requests[0]).toMatchObject({
      status: 'filled',
      revision: 2,
      updatedAt: '2026-08-02T00:00:00.000Z',
    })
  })

  test('keeps an assignment aligned with its resource request Project', async () => {
    const service = new CapacityPlanningService(
      new InMemoryCapacityPlanningRepository(),
      { listTimeEntries: async () => [], listEstimates: async () => [] },
      { createId: () => 'generated-id' },
    )
    await service.saveMemberProfile({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      memberId: 'member-1',
      skills: [],
      timeZone: 'UTC',
      schedule: createDefaultWorkingSchedule(),
      holidays: [],
      expectedRevision: 0,
      expectedTeamRevision: 0,
      actorMemberId: 'member-1',
    })
    const request = await service.createRequest({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      projectId: 'project-a',
      title: 'Project A support',
      skillIds: [],
      fromDate: '2026-08-03',
      toDate: '2026-08-03',
      requestedMinutes: 480,
      confidential: false,
      expectedTeamRevision: 1,
      actorMemberId: 'member-1',
    })

    await expect(service.createAssignment({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      requestId: request.id,
      projectId: 'project-b',
      memberId: 'member-1',
      skillIds: [],
      fromDate: '2026-08-03',
      toDate: '2026-08-03',
      allocationMinutes: 480,
      plannedEffortMinutes: 480,
      confidential: false,
      status: 'confirmed',
      expectedTeamRevision: 2,
      actorMemberId: 'member-1',
    })).rejects.toMatchObject({ code: 'InvalidResourceAssignment', status: 400 })

    const assignment = await service.createAssignment({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      requestId: request.id,
      memberId: 'member-1',
      skillIds: [],
      fromDate: '2026-08-03',
      toDate: '2026-08-03',
      allocationMinutes: 480,
      plannedEffortMinutes: 480,
      confidential: false,
      status: 'confirmed',
      expectedTeamRevision: 2,
      actorMemberId: 'member-1',
    })

    expect(assignment.projectId).toBe('project-a')
  })

  test('rejects a state payload that would exceed the DynamoDB item safety budget', async () => {
    const repository = new InMemoryCapacityPlanningRepository()
    const service = new CapacityPlanningService(repository, {
      listTimeEntries: async () => [],
      listEstimates: async () => [],
    })
    const holidays = Array.from({ length: 2_000 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
      label: 'Company holiday '.repeat(20),
    }))

    await expect(service.saveMemberProfile({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      memberId: 'member-1',
      skills: [],
      timeZone: 'UTC',
      schedule: createDefaultWorkingSchedule(),
      holidays,
      expectedRevision: 0,
      expectedTeamRevision: 0,
      actorMemberId: 'member-1',
    })).rejects.toMatchObject({
      code: 'CapacityPlanningLimitExceeded',
      status: 413,
    })
    expect((await repository.getState('workspace-1', 'team-1')).profiles).toEqual([])
  })
})

/** Creates a deterministic member profile fixture. */
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

/** Creates a deterministic resource assignment fixture. */
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

/** Creates a deterministic capacity-planning state fixture. */
function createState(
  profiles: WorkloadMemberProfile[],
  assignments: ReturnType<typeof createAssignment>[] = [],
): CapacityPlanningState {
  return { revision: 1, profiles, requests: [], assignments }
}

/** Creates a snapshot input fixture with optional overrides. */
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
