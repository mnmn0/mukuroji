import { describe, expect, spyOn, test } from 'bun:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  CAPACITY_PLANNING_SCHEMA_VERSION,
  type ResourceAssignment,
  type UpdateResourceRequestInput,
  type WorkloadMemberProfile,
} from '@mukuroji/contracts'
import {
  buildWorkloadSnapshot,
  CapacityPlanningError,
  CapacityPlanningService,
  createDefaultWorkingSchedule,
  DynamoDbCapacityPlanningRepository,
  InMemoryCapacityPlanningRepository,
  pruneCapacityPlanningState,
  upgradeLegacyTimeOff,
  type CapacityPlanningState,
  type WorkloadTimeEntry,
} from './capacity-planning'
import type { MutationAuditContext } from '../audit'

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

  test('takes remaining effort from the canonical estimate only, never adding assignment planned effort', () => {
    const secondMember = createProfile('member-2', 'UTC')
    const assignments = [
      { ...createAssignment('assignment-a', false), workItemId: 'work-item-1', plannedEffortMinutes: 600 },
      { ...createAssignment('assignment-b', false), memberId: 'member-2', workItemId: 'work-item-1', plannedEffortMinutes: 600 },
    ]
    const state = createState([profile, secondMember], assignments)
    const estimated = buildWorkloadSnapshot(state, [], [{ workItemId: 'work-item-1', estimateMinutes: 480 }], createInput())
    expect(estimated.members.map((member) => member.remainingEffortMinutes)).toEqual([240, 240])

    const recorded = buildWorkloadSnapshot(
      state, [], [{ workItemId: 'work-item-1', estimateMinutes: 480, remainingEffortMinutes: 100 }], createInput(),
    )
    expect(recorded.members.map((member) => member.remainingEffortMinutes)).toEqual([50, 50])

    const unestimated = buildWorkloadSnapshot(state, [], [], createInput())
    expect(unestimated.members.map((member) => member.remainingEffortMinutes)).toEqual([600, 600])
  })

  test('bounds the snapshot time-entry query by the visible assignment horizon', async () => {
    const repository = new InMemoryCapacityPlanningRepository()
    await repository.saveState(
      'workspace-1',
      'team-1',
      createState([profile], [{ ...createAssignment('assignment-1', false, '2026-08-01'), workItemId: 'work-item-1' }]),
      0,
    )
    let observedFrom: string | undefined
    let observedTo: string | undefined
    const service = new CapacityPlanningService(repository, {
      listTimeEntries: async (input) => {
        observedFrom = input.from
        observedTo = input.to
        return []
      },
      listEstimates: async () => [],
    })

    await service.getSnapshot(createInput({ fromDate: '2026-08-10', toDate: '2026-08-10' }))

    expect(observedFrom).toBe('2026-07-31T00:00:00.000Z')
    expect(observedTo).toBe('2026-08-12T00:00:00.000Z')
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

  test('changes a resource request and re-derives its fill status', async () => {
    const service = new CapacityPlanningService(
      new InMemoryCapacityPlanningRepository(),
      { listTimeEntries: async () => [], listEstimates: async () => [] },
      { now: () => new Date('2026-08-01T00:00:00.000Z'), createId: () => 'generated-id' },
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
      role: 'QA',
      skillIds: [],
      fromDate: '2026-08-03',
      toDate: '2026-08-03',
      requestedMinutes: 960,
      confidential: false,
      expectedTeamRevision: 1,
      actorMemberId: 'member-1',
    })
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
      status: 'tentative',
      expectedTeamRevision: 2,
      actorMemberId: 'member-1',
    })

    await expect(service.updateRequest({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      requestId: request.id,
      title: 'Stale',
      expectedRevision: 1,
      expectedTeamRevision: 3,
      actorMemberId: 'member-1',
    }, { canViewConfidential: true })).rejects.toMatchObject({ code: 'ResourceRequestRevisionConflict', status: 409 })

    const updated = await service.updateRequest({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      requestId: request.id,
      title: '  Release hardening  ',
      role: '',
      skillIds: ['qa', 'qa', 'release'],
      toDate: '2026-08-04',
      requestedMinutes: 480,
      expectedRevision: 2,
      expectedTeamRevision: 3,
      actorMemberId: 'member-1',
    }, { canViewConfidential: true })

    expect(updated).toMatchObject({
      title: 'Release hardening',
      skillIds: ['qa', 'release'],
      fromDate: '2026-08-03',
      toDate: '2026-08-04',
      requestedMinutes: 480,
      status: 'filled',
      revision: 4,
    })
    expect(updated.role).toBeUndefined()
    await expect(service.updateRequest({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      requestId: request.id,
      fromDate: '2026-08-05',
      expectedRevision: 4,
      expectedTeamRevision: 4,
      actorMemberId: 'member-1',
    }, { canViewConfidential: true })).rejects.toMatchObject({ status: 400 })
  })

  test('cancels a resource request only after its assignments are canceled and keeps it canceled', async () => {
    let sequence = 0
    const service = new CapacityPlanningService(
      new InMemoryCapacityPlanningRepository(),
      { listTimeEntries: async () => [], listEstimates: async () => [] },
      { now: () => new Date('2026-08-01T00:00:00.000Z'), createId: () => `generated-${++sequence}` },
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

    await expect(service.updateRequest({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      requestId: request.id,
      status: 'canceled',
      expectedRevision: 2,
      expectedTeamRevision: 3,
      actorMemberId: 'member-1',
    }, { canViewConfidential: true })).rejects.toMatchObject({ code: 'ResourceRequestHasActiveAssignments', status: 409 })

    await service.updateAssignment({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      assignmentId: assignment.id,
      status: 'canceled',
      expectedRevision: 1,
      expectedTeamRevision: 3,
      actorMemberId: 'member-1',
    })
    const canceled = await service.updateRequest({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      requestId: request.id,
      status: 'canceled',
      expectedRevision: 3,
      expectedTeamRevision: 4,
      actorMemberId: 'member-1',
    }, { canViewConfidential: true })
    expect(canceled).toMatchObject({ status: 'canceled', revision: 4 })

    await expect(service.updateAssignment({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      assignmentId: assignment.id,
      status: 'tentative',
      expectedRevision: 2,
      expectedTeamRevision: 5,
      actorMemberId: 'member-1',
    })).rejects.toMatchObject({ code: 'ResourceRequestCanceled', status: 409 })
    await expect(service.createAssignment({
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
      status: 'tentative',
      expectedTeamRevision: 5,
      actorMemberId: 'member-1',
    })).rejects.toMatchObject({ code: 'ResourceRequestCanceled', status: 409 })
    await expect(service.updateRequest({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      requestId: request.id,
      title: 'Reopened',
      expectedRevision: 4,
      expectedTeamRevision: 5,
      actorMemberId: 'member-1',
    }, { canViewConfidential: true })).rejects.toMatchObject({ code: 'ResourceRequestCanceled', status: 409 })

    const snapshot = await service.getSnapshot({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      fromDate: '2026-08-03',
      toDate: '2026-08-03',
      granularity: 'day',
      canViewConfidential: true,
    })
    expect(snapshot.requests[0]?.status).toBe('canceled')
    expect(snapshot.members[0]?.allocatedMinutes).toBe(0)

    const confidential = await service.createRequest({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      title: 'Confidential review',
      skillIds: [],
      fromDate: '2026-08-03',
      toDate: '2026-08-03',
      requestedMinutes: 480,
      confidential: true,
      expectedTeamRevision: 5,
      actorMemberId: 'member-1',
    })
    await expect(service.updateRequest({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      requestId: confidential.id,
      status: 'canceled',
      expectedRevision: 1,
      expectedTeamRevision: 6,
      actorMemberId: 'member-1',
    }, { canViewConfidential: false })).rejects.toMatchObject({ code: 'ResourceRequestNotFound', status: 404 })
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


describe('capacity planning reviews and retention', () => {
  test('subtracts only approved time off and reports pending time off and tentative allocation', () => {
    const member = {
      ...profile,
      timeOff: [
        { id: 'approved', fromDate: '2026-08-03', toDate: '2026-08-03', minutesPerDay: 240, reason: 'Clinic', status: 'approved' as const, revision: 1 },
        { id: 'pending', fromDate: '2026-08-03', toDate: '2026-08-04', reason: 'Trip', status: 'planned' as const, revision: 1 },
        { id: 'rejected', fromDate: '2026-08-04', toDate: '2026-08-04', status: 'rejected' as const, revision: 2 },
        { id: 'canceled', fromDate: '2026-08-04', toDate: '2026-08-04', status: 'canceled' as const, revision: 2 },
      ],
    }
    const tentative = { ...createAssignment('tentative', false, '2026-08-04'), status: 'tentative' as const, allocationMinutes: 120 }
    const state = createState([member], [createAssignment('confirmed', false, '2026-08-04', '2026-08-04', 60), tentative])
    const managerView = buildWorkloadSnapshot(state, [], [], createInput({ toDate: '2026-08-04' }))
    const otherView = buildWorkloadSnapshot(state, [], [], createInput({ toDate: '2026-08-04', canViewConfidential: false, viewerMemberId: 'member-2' }))
    const [first, second] = managerView.members[0].cells

    expect(first).toMatchObject({ capacityMinutes: 240, pendingTimeOffMinutes: 240, tentativeAllocatedMinutes: 0 })
    expect(second).toMatchObject({ capacityMinutes: 480, pendingTimeOffMinutes: 480, allocatedMinutes: 180, tentativeAllocatedMinutes: 120 })
    expect(managerView.members[0].timeOff.map((timeOff) => [timeOff.id, timeOff.reason])).toEqual([
      ['approved', 'Clinic'],
      ['pending', 'Trip'],
      ['rejected', undefined],
    ])
    expect(otherView.members[0].timeOff.every((timeOff) => timeOff.reason === undefined)).toBe(true)
  })

  test('reviews time off at its own revision and records who reviewed it', async () => {
    const repository = new InMemoryCapacityPlanningRepository()
    const service = createReviewService(repository)
    await seedMember(service, 'member-2')
    await service.saveTimeOff({
      workspaceId: 'workspace-1', teamId: 'team-1', memberId: 'member-2', actorMemberId: 'member-2',
      id: 'pto-1', fromDate: '2026-08-03', toDate: '2026-08-03', status: 'planned', expectedRevision: 1, expectedTeamRevision: 1,
    }, { auditContext })
    const review = { workspaceId: 'workspace-1', teamId: 'team-1', memberId: 'member-2', timeOffId: 'pto-1', actorMemberId: 'manager-1' }

    await expect(service.reviewTimeOff({ ...review, status: 'approved', expectedRevision: 9, expectedTeamRevision: 2 }))
      .rejects.toMatchObject({ code: 'WorkloadTimeOffRevisionConflict', status: 409 })
    const approved = await service.reviewTimeOff({ ...review, status: 'approved', expectedRevision: 1, expectedTeamRevision: 2 }, { auditContext })
    const reopened = await service.reviewTimeOff({ ...review, status: 'planned', expectedRevision: 2, expectedTeamRevision: 3 })

    expect(approved).toMatchObject({ status: 'approved', reviewedBy: 'manager-1', reviewedAt: '2026-08-01T00:00:00.000Z', revision: 2 })
    expect(reopened.reviewedBy).toBeUndefined()
    expect(reopened.submittedAt).toBe('2026-08-01T00:00:00.000Z')
    expect(upgradeLegacyTimeOff(reopened)).toEqual(reopened)
    expect(repository.auditLog.map((audit) => audit.events[0].eventType)).toEqual([
      'workload.time-off.requested',
      'workload.time-off.approved',
    ])
    expect(repository.auditLog[0].events[0].metadata).not.toHaveProperty('notificationCandidates')
    expect(repository.auditLog[1].events[0].metadata).toMatchObject({
      teamId: 'team-1',
      notificationCandidates: [{ memberKey: 'member-2', reason: 'time-off-review' }],
    })
  })

  test('cancels a request together with its assignments and notifies each assigned member', async () => {
    const repository = new InMemoryCapacityPlanningRepository()
    const service = createReviewService(repository)
    await seedMember(service, 'member-2')
    const request = await service.createRequest({
      workspaceId: 'workspace-1', teamId: 'team-1', title: 'Release', skillIds: [], fromDate: '2026-08-03', toDate: '2026-08-03',
      requestedMinutes: 480, confidential: false, expectedTeamRevision: 1, actorMemberId: 'manager-1',
    })
    const assignment = await service.createAssignment({
      workspaceId: 'workspace-1', teamId: 'team-1', requestId: request.id, memberId: 'member-2', skillIds: [],
      fromDate: '2026-08-03', toDate: '2026-08-03', allocationMinutes: 480, plannedEffortMinutes: 480, confidential: false,
      status: 'tentative', expectedTeamRevision: 2, actorMemberId: 'manager-1',
    })
    const cancel: UpdateResourceRequestInput = {
      workspaceId: 'workspace-1', teamId: 'team-1', requestId: request.id, status: 'canceled', cancelAssignments: true,
      expectedRevision: 2, expectedTeamRevision: 3, actorMemberId: 'manager-1',
    }

    // An assignment the caller did not authorize, such as one added since it checked, stops the cascade.
    await expect(service.updateRequest(cancel, { canViewConfidential: true, authorizedAssignmentIds: new Set() }))
      .rejects.toMatchObject({ code: 'ResourceRequestAssignmentsChanged' })
    expect(await service.listActiveRequestAssignments('workspace-1', 'team-1', request.id)).toEqual([assignment])
    const canceled = await service.updateRequest(cancel, {
      canViewConfidential: true,
      authorizedAssignmentIds: new Set([assignment.id]),
    }, { auditContext })
    const state = await repository.getState('workspace-1', 'team-1')

    expect(canceled.status).toBe('canceled')
    expect(state.assignments.map((assignment) => assignment.status)).toEqual(['canceled'])
    expect(repository.auditLog.at(-1)?.events.map((event) => [event.eventType, event.metadata?.notificationCandidates])).toEqual([
      ['workload.assignment.canceled', [{ memberKey: 'member-2', reason: 'workload-assignment' }]],
      ['workload.request.canceled', undefined],
    ])
  })

  test('records a cascade too large to audit one by one as one event that notifies every member', async () => {
    const repository = new InMemoryCapacityPlanningRepository()
    const service = createReviewService(repository)
    await seedMember(service, 'member-2')
    await service.saveMemberProfile({
      workspaceId: 'workspace-1', teamId: 'team-1', memberId: 'member-3', skills: [], timeZone: 'UTC',
      schedule: createDefaultWorkingSchedule(), holidays: [], expectedRevision: 0, expectedTeamRevision: 1, actorMemberId: 'member-3',
    })
    const request = await service.createRequest({
      workspaceId: 'workspace-1', teamId: 'team-1', title: 'Migration', skillIds: [], fromDate: '2026-08-03', toDate: '2026-08-03',
      requestedMinutes: 99 * 60, confidential: false, expectedTeamRevision: 2, actorMemberId: 'manager-1',
    })
    const ids = new Set<string>()
    for (let index = 0; index < 99; index += 1) {
      const assignment = await service.createAssignment({
        workspaceId: 'workspace-1', teamId: 'team-1', requestId: request.id, memberId: index % 2 === 0 ? 'member-2' : 'member-3',
        skillIds: [], fromDate: '2026-08-03', toDate: '2026-08-03', allocationMinutes: 1, plannedEffortMinutes: 1,
        confidential: false, status: 'tentative', expectedTeamRevision: 3 + index, actorMemberId: 'manager-1',
      })
      ids.add(assignment.id)
    }
    const current = await service.getRequest('workspace-1', 'team-1', request.id)

    await service.updateRequest({
      workspaceId: 'workspace-1', teamId: 'team-1', requestId: request.id, status: 'canceled', cancelAssignments: true,
      expectedRevision: current.revision, expectedTeamRevision: 102, actorMemberId: 'manager-1',
    }, { canViewConfidential: true, authorizedAssignmentIds: ids }, { auditContext })
    const events = repository.auditLog.at(-1)?.events ?? []

    // State Put plus two events stays far below the 100-item transaction limit.
    expect(events.map((event) => event.eventType)).toEqual(['workload.assignment.canceled', 'workload.request.canceled'])
    expect(events[0]?.metadata).toMatchObject({
      requestId: request.id,
      assignmentIds: [...ids],
      notificationCandidates: [
        { memberKey: 'member-2', reason: 'workload-assignment' },
        { memberKey: 'member-3', reason: 'workload-assignment' },
      ],
    })
  })

  test('reports a replayed audit event as a duplicate and keeps other transaction failures as errors', async () => {
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'x' } }))
    const repository = new DynamoDbCapacityPlanningRepository('capacity', client, 'audit-events')
    const state: CapacityPlanningState = { revision: 2, profiles: [], requests: [], assignments: [] }
    const audit = {
      context: auditContext,
      events: [{
        directoryId: 'workspace-1', eventType: 'workload.request.created', entityType: 'team-workload', entityId: 'team-1',
        action: 'resource_request_created',
      }],
    }
    /** Builds a transaction cancellation with the given item reasons. */
    const canceled = (...codes: string[]) => Object.assign(new Error('Transaction cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: codes.map((Code) => ({ Code })),
    })
    const save = async (error: Error) => {
      const send = spyOn(client, 'send').mockImplementation(async () => { throw error })
      try {
        return await repository.saveState('workspace-1', 'team-1', state, 1, audit).then(() => undefined, (cause: unknown) => cause)
      } finally {
        send.mockRestore()
      }
    }

    expect(await save(canceled('ConditionalCheckFailed', 'None'))).toMatchObject({ code: 'CapacityPlanningRevisionConflict' })
    expect(await save(canceled('None', 'ConditionalCheckFailed'))).toMatchObject({ code: 'CapacityPlanningDuplicateRequest' })
    const conflict = await save(canceled('None', 'TransactionConflict'))
    expect(conflict).not.toBeInstanceOf(CapacityPlanningError)
    expect(conflict).toMatchObject({ name: 'TransactionCanceledException' })
    expect(await save(canceled('ThrottlingError', 'ConditionalCheckFailed'))).not.toBeInstanceOf(CapacityPlanningError)
  })

  test('derives request fulfillment again after pruning an old assignment', async () => {
    const repository = new InMemoryCapacityPlanningRepository()
    const service = createReviewService(repository)
    await seedMember(service, 'member-2')
    const state = await repository.getState('workspace-1', 'team-1')
    const timestamp = '2025-01-01T00:00:00.000Z'
    const assignment = (id: string, fromDate: string, toDate: string): ResourceAssignment => ({
      id, workspaceId: 'workspace-1', teamId: 'team-1', requestId: 'request-1', memberId: 'member-2', skillIds: [],
      fromDate, toDate, allocationMinutes: 300, plannedEffortMinutes: 300, confidential: false, status: 'confirmed',
      revision: 1, createdAt: timestamp, updatedAt: timestamp,
    })
    await repository.saveState('workspace-1', 'team-1', {
      ...state,
      revision: 2,
      requests: [{
        id: 'request-1', workspaceId: 'workspace-1', teamId: 'team-1', title: 'Long run', skillIds: [], fromDate: '2025-11-01',
        toDate: '2026-09-30', requestedMinutes: 600, confidential: false, status: 'filled', revision: 3,
        createdAt: timestamp, updatedAt: timestamp,
      }],
      assignments: [assignment('old', '2025-01-01', '2025-01-31'), assignment('recent', '2026-08-03', '2026-08-03')],
    }, 1)

    const changed = await service.updateRequest({
      workspaceId: 'workspace-1', teamId: 'team-1', requestId: 'request-1', title: 'Long run, phase 2',
      expectedRevision: 3, expectedTeamRevision: 2, actorMemberId: 'manager-1',
    }, { canViewConfidential: true }, { auditContext })
    const saved = await repository.getState('workspace-1', 'team-1')

    expect(saved.assignments.map((row) => row.id)).toEqual(['recent'])
    // The response and audit event describe the request as saved, so the next change does not conflict.
    expect(saved.requests[0]).toMatchObject({ status: 'partially-filled', revision: 4, title: 'Long run, phase 2' })
    expect(changed).toEqual(saved.requests[0])
    expect(repository.auditLog.at(-1)?.events[0]?.changes).not.toContainEqual(expect.objectContaining({ field: 'status' }))
  })

  test('reads time off saved before approval existed as approved so capacity does not change', () => {
    const legacy = { id: 'legacy', fromDate: '2026-08-03', toDate: '2026-08-03', status: 'planned' as const, revision: 1 }
    const submitted = { ...legacy, id: 'submitted', submittedAt: '2026-08-01T00:00:00.000Z' }

    expect(upgradeLegacyTimeOff(legacy).status).toBe('approved')
    expect(upgradeLegacyTimeOff(submitted).status).toBe('planned')
    expect(upgradeLegacyTimeOff({ ...legacy, status: 'canceled' }).status).toBe('canceled')
  })

  test('prunes closed rows after 30 days and any row after 400 days, keeping referenced requests', () => {
    const request = (id: string, toDate: string, status: 'open' | 'canceled') => ({
      id, workspaceId: 'workspace-1', teamId: 'team-1', title: id, skillIds: [], fromDate: toDate, toDate,
      requestedMinutes: 60, confidential: false, status, revision: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    })
    const state: CapacityPlanningState = {
      revision: 3,
      profiles: [{
        ...profile,
        timeOff: [
          { id: 'recent-rejected', fromDate: '2026-07-10', toDate: '2026-07-10', status: 'rejected', revision: 1 },
          { id: 'old-rejected', fromDate: '2026-06-01', toDate: '2026-06-01', status: 'rejected', revision: 1 },
          { id: 'old-approved', fromDate: '2025-06-01', toDate: '2025-06-01', status: 'approved', revision: 1 },
          { id: 'approved', fromDate: '2026-06-01', toDate: '2026-06-01', status: 'approved', revision: 1 },
        ],
      }],
      requests: [
        request('old-canceled', '2026-06-01', 'canceled'),
        request('referenced-canceled', '2026-06-01', 'canceled'),
        request('ancient-open', '2025-06-01', 'open'),
        request('open', '2026-06-01', 'open'),
      ],
      assignments: [
        { ...createAssignment('old-canceled', false, '2026-06-01'), status: 'canceled' },
        { ...createAssignment('kept', false, '2026-06-01'), requestId: 'referenced-canceled' },
        createAssignment('ancient', false, '2025-06-01'),
      ],
    }

    pruneCapacityPlanningState(state, '2026-08-01')

    expect(state.profiles[0].timeOff.map((timeOff) => timeOff.id)).toEqual(['recent-rejected', 'approved'])
    expect(state.requests.map((value) => value.id)).toEqual(['referenced-canceled', 'open'])
    expect(state.assignments.map((value) => value.id)).toEqual(['kept'])
  })
})

const auditContext: MutationAuditContext = {
  workspaceId: 'workspace-1',
  actor: { id: 'actor-1', kind: 'user' },
  source: { kind: 'api' },
  idempotencyKeyHash: 'hash-1',
  requestFingerprint: 'fingerprint-1',
  correlationId: 'correlation-1',
  occurredAt: '2026-08-01T00:00:00.000Z',
}

/** Creates a service with a fixed clock and sequential identifiers. */
function createReviewService(repository: InMemoryCapacityPlanningRepository): CapacityPlanningService {
  let sequence = 0
  return new CapacityPlanningService(
    repository,
    { listTimeEntries: async () => [], listEstimates: async () => [] },
    { now: () => new Date('2026-08-01T00:00:00.000Z'), createId: () => `generated-${++sequence}` },
  )
}

/** Saves a default profile for one member as the first Team write. */
async function seedMember(service: CapacityPlanningService, memberId: string): Promise<void> {
  await service.saveMemberProfile({
    workspaceId: 'workspace-1', teamId: 'team-1', memberId, skills: [], timeZone: 'UTC',
    schedule: createDefaultWorkingSchedule(), holidays: [], expectedRevision: 0, expectedTeamRevision: 0, actorMemberId: memberId,
  })
}

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
): ResourceAssignment {
  return {
    id,
    workspaceId: 'workspace-1',
    teamId: 'team-1',
    memberId: 'member-1',
    skillIds: [],
    workItemId: undefined,
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
  assignments: ResourceAssignment[] = [],
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
