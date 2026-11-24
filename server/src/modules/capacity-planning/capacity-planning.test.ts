import { describe, expect, test } from 'bun:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  CAPACITY_PLANNING_SCHEMA_VERSION,
  type ResourceAssignment,
  type WorkloadMemberProfile,
} from '@mukuroji/contracts'
import { createDynamoDbDocumentClient } from '../../infrastructure/aws/dynamodb-client'
import {
  buildWorkloadSnapshot,
  CapacityPlanningService,
  DynamoDbCapacityPlanningRepository,
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

  test('applies the Workspace calendar to a profile that inherits it, keeping personal days off', () => {
    const schedule = createDefaultWorkingSchedule()
    // A part-time member who does not work on Wednesdays.
    schedule.wednesday = { enabled: false, minutes: 0 }
    schedule.saturday = { enabled: true, minutes: 240 }
    const inheriting: WorkloadMemberProfile = {
      ...createProfile('member-1', 'UTC'),
      calendarSource: 'workspace',
      schedule,
      holidays: [{ date: '2026-08-06', label: 'Personal day' }],
    }
    const custom = createProfile('member-2', 'UTC')
    const workspaceCalendar = {
      timeZone: 'Asia/Tokyo',
      workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const,
      holidays: ['2026-08-04'],
    }
    const snapshot = buildWorkloadSnapshot(
      createState([inheriting, custom]),
      // 2026-08-07T16:00Z is Friday in UTC but already Saturday 2026-08-08 in Tokyo.
      [{ memberId: 'member-1', startAt: '2026-08-07T16:00:00.000Z', endAt: '2026-08-07T17:00:00.000Z', durationMinutes: 60, status: 'approved' }],
      [],
      createInput({
        fromDate: '2026-08-03',
        toDate: '2026-08-08',
        workspaceCalendar: { ...workspaceCalendar, workingWeekdays: [...workspaceCalendar.workingWeekdays] },
      }),
    )

    const [member, other] = snapshot.members
    // Monday works; the Workspace holiday on Tuesday, the member's own Wednesday off, the personal
    // day on Thursday; Friday works; Saturday is not a Workspace working day.
    expect(member?.cells.map((cell) => cell.capacityMinutes)).toEqual([480, 0, 0, 0, 480, 0])
    expect(member?.cells.map((cell) => cell.actualMinutes)).toEqual([0, 0, 0, 0, 0, 60])
    // The summary returns the stored profile for editing, not the inherited days off.
    expect(member).toMatchObject({
      calendarSource: 'workspace',
      timeZone: 'UTC',
      effectiveTimeZone: 'Asia/Tokyo',
      holidays: [{ date: '2026-08-06', label: 'Personal day' }],
    })
    expect(member?.schedule).toEqual(schedule)
    // A profile with its own calendar ignores the Workspace holiday.
    expect(other?.calendarSource).toBe('custom')
    expect(other?.cells.map((cell) => cell.capacityMinutes)).toEqual([480, 480, 480, 480, 480, 0])
  })

  test('uses the default Workspace calendar for an inheriting profile when none is given', () => {
    const snapshot = buildWorkloadSnapshot(
      createState([{ ...createProfile('member-1', 'UTC'), calendarSource: 'workspace' }]),
      [],
      [],
      // 2027-01-01 is a bundled Japanese national holiday.
      createInput({ fromDate: '2026-12-31', toDate: '2027-01-01' }),
    )

    expect(snapshot.members[0]?.cells.map((cell) => cell.capacityMinutes)).toEqual([480, 0])
  })

  test('reads the current holidays of a reused custom profile in every snapshot', () => {
    const reused = createProfile('member-1', 'UTC')
    const state = createState([reused])
    const input = createInput({ fromDate: '2026-08-03', toDate: '2026-08-03' })
    expect(buildWorkloadSnapshot(state, [], [], input).members[0]?.capacityMinutes).toBe(480)

    reused.holidays.push({ date: '2026-08-03' })

    expect(buildWorkloadSnapshot(state, [], [], input).members[0]?.capacityMinutes).toBe(0)
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

  test('starts weekly capacity buckets on the Workspace week start day', () => {
    const snapshot = buildWorkloadSnapshot(
      createState([profile], [createAssignment('assignment-1', false, '2026-08-03', '2026-08-14', 4_800)]),
      [],
      [],
      createInput({
        fromDate: '2026-08-02',
        toDate: '2026-08-15',
        granularity: 'week',
        weekStartDay: 0,
      }),
    )

    expect(snapshot.members[0]?.cells.map((cell) => [cell.fromDate, cell.toDate])).toEqual([
      ['2026-08-02', '2026-08-08'],
      ['2026-08-09', '2026-08-15'],
    ])
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

  test('counts Work Item contributor shares in member workload without doubling planned work', () => {
    const secondMember = createProfile('member-2', 'UTC')
    const state = createState([profile, secondMember], [
      // member-2 already plans their part of work-item-1, so their contributor share is not counted again.
      { ...createAssignment('assignment-b', false), memberId: 'member-2', workItemId: 'work-item-1', plannedEffortMinutes: 120, allocationMinutes: 120 },
    ])
    const snapshot = buildWorkloadSnapshot(state, [], [
      {
        workItemId: 'work-item-1',
        estimateMinutes: 480,
        window: { fromDate: '2026-08-03', toDate: '2026-08-03' },
        contributors: [
          { assignmentId: 'share-1', memberId: 'member-1', plannedEffortMinutes: 360 },
          { assignmentId: 'share-2', memberId: 'member-2', plannedEffortMinutes: 360 },
          { assignmentId: 'share-3', memberId: 'outside-team', plannedEffortMinutes: 60 },
        ],
      },
      {
        workItemId: 'unscheduled',
        contributors: [{ assignmentId: 'share-4', memberId: 'member-1', plannedEffortMinutes: 60 }],
      },
    ], createInput())

    expect(snapshot.contributorShares).toEqual([{
      workItemId: 'work-item-1',
      assignmentId: 'share-1',
      memberId: 'member-1',
      fromDate: '2026-08-03',
      toDate: '2026-08-03',
      plannedEffortMinutes: 360,
    }])
    expect(snapshot.assignments.map((assignment) => assignment.id)).toEqual(['assignment-b'])
    expect(snapshot.members.map((member) => member.allocatedMinutes)).toEqual([360, 120])
    expect(snapshot.members.map((member) => member.plannedEffortMinutes)).toEqual([360, 120])
    // The Work Item estimate is shared by planned effort and never added on top of it.
    expect(snapshot.members.map((member) => member.remainingEffortMinutes)).toEqual([360, 120])
  })

  test('leaves out contributor shares of a Project the reader cannot see', () => {
    const snapshot = buildWorkloadSnapshot(createState([profile]), [], [{
      workItemId: 'work-item-1',
      projectId: 'secret',
      window: { fromDate: '2026-08-03', toDate: '2026-08-03' },
      contributors: [{ assignmentId: 'share-1', memberId: 'member-1', plannedEffortMinutes: 60 }],
    }], createInput({ visibleProjectIds: new Set(['public']) }))

    expect(snapshot.contributorShares).toEqual([])
    expect(snapshot.members[0]?.allocatedMinutes).toBe(0)
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

  test('widens the snapshot time-entry query to scheduled contributor shares', async () => {
    const repository = new InMemoryCapacityPlanningRepository()
    await repository.saveState('workspace-1', 'team-1', createState([profile]), 0)
    let observedFrom: string | undefined
    const service = new CapacityPlanningService(repository, {
      listTimeEntries: async (input) => {
        observedFrom = input.from
        return []
      },
      listEstimates: async () => [{
        workItemId: 'work-item-1',
        window: { fromDate: '2026-07-20', toDate: '2026-08-14' },
        contributors: [{ assignmentId: 'share-1', memberId: 'member-1', plannedEffortMinutes: 600 }],
      }],
    })

    await service.getSnapshot(createInput({ fromDate: '2026-08-10', toDate: '2026-08-10' }))

    // Time logged since the share started still counts against its remaining effort.
    expect(observedFrom).toBe('2026-07-19T00:00:00.000Z')
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

  test('keeps the calendar source when a client leaves it out', async () => {
    const service = new CapacityPlanningService(
      new InMemoryCapacityPlanningRepository(),
      { listTimeEntries: async () => [], listEstimates: async () => [] },
      { now: () => new Date('2026-08-01T00:00:00.000Z') },
    )
    const base = {
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      memberId: 'member-1',
      skills: [],
      timeZone: 'UTC',
      schedule: createDefaultWorkingSchedule(),
      holidays: [],
      actorMemberId: 'member-1',
    }
    // A new profile saved without the field keeps its own calendar.
    expect((await service.saveMemberProfile({ ...base, expectedRevision: 0, expectedTeamRevision: 0 })).calendarSource)
      .toBeUndefined()
    expect((await service.saveMemberProfile({
      ...base,
      calendarSource: 'workspace',
      expectedRevision: 1,
      expectedTeamRevision: 1,
    })).calendarSource).toBe('workspace')
    // An older client that leaves the field out does not turn inheritance off.
    expect((await service.saveMemberProfile({ ...base, expectedRevision: 2, expectedTeamRevision: 2 })).calendarSource)
      .toBe('workspace')
    expect((await service.saveMemberProfile({
      ...base,
      calendarSource: 'custom',
      expectedRevision: 3,
      expectedTeamRevision: 3,
    })).calendarSource).toBeUndefined()
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

/** Re-scopes a profile fixture to another Team. */
function inTeam<T extends { teamId: string }>(value: T, teamId: string): T {
  return { ...value, teamId }
}

/** Saves one Team state per entry and returns a service reading them. */
async function createWorkspaceService(states: Record<string, CapacityPlanningState>) {
  const repository = new InMemoryCapacityPlanningRepository()
  for (const [teamId, state] of Object.entries(states)) await repository.saveState('workspace-1', teamId, state, 0)
  return new CapacityPlanningService(
    repository,
    { listTimeEntries: async () => [], listEstimates: async () => [] },
    { now: () => new Date('2026-08-01T00:00:00.000Z') },
  )
}

describe('Workspace-wide workload', () => {
  const twoTeams = () => ({
    'team-1': createState([profile], [createAssignment('assignment-1', false, '2026-08-03', '2026-08-03', 300)]),
    'team-2': createState(
      [inTeam(profile, 'team-2')],
      [inTeam({ ...createAssignment('assignment-2', false, '2026-08-03', '2026-08-03', 300), projectId: 'project-2' }, 'team-2')],
    ),
  })

  test('marks a member over in both Team views when two Teams together exceed capacity', async () => {
    const service = await createWorkspaceService(twoTeams())

    for (const teamId of ['team-1', 'team-2']) {
      const snapshot = await service.getSnapshot(createInput({ teamId }))
      const cell = snapshot.members[0]?.cells[0]
      expect(cell).toMatchObject({
        allocatedMinutes: 300,
        status: 'under',
        workspaceCapacityMinutes: 480,
        workspaceAllocatedMinutes: 600,
        workspaceStatus: 'over',
      })
      expect(snapshot.members[0]?.workspaceOverloaded).toBe(true)
    }
  })

  test('counts contributor shares of every Team in Workspace-wide totals', async () => {
    const repository = new InMemoryCapacityPlanningRepository()
    await repository.saveState('workspace-1', 'team-1', createState([profile], [
      createAssignment('assignment-1', false, '2026-08-03', '2026-08-03', 300),
    ]), 0)
    await repository.saveState('workspace-1', 'team-2', createState([inTeam(profile, 'team-2')], [
      // This assignment already plans the member's part of work-item-planned, so its share is not counted again.
      inTeam({ ...createAssignment('assignment-2', false, '2026-08-03', '2026-08-03', 60), workItemId: 'work-item-planned' }, 'team-2'),
    ]), 0)
    const service = new CapacityPlanningService(repository, {
      listTimeEntries: async () => [],
      listEstimates: async (_workspaceId, teamId) => teamId === 'team-2'
        ? [
            {
              workItemId: 'work-item-shared',
              window: { fromDate: '2026-08-03', toDate: '2026-08-03' },
              contributors: [{ assignmentId: 'share-1', memberId: 'member-1', plannedEffortMinutes: 300 }],
            },
            {
              workItemId: 'work-item-planned',
              window: { fromDate: '2026-08-03', toDate: '2026-08-03' },
              contributors: [{ assignmentId: 'share-2', memberId: 'member-1', plannedEffortMinutes: 120 }],
            },
          ]
        : [],
    }, { now: () => new Date('2026-08-01T00:00:00.000Z') })

    const teamSnapshot = await service.getSnapshot(createInput())
    expect(teamSnapshot.members[0]?.cells[0]).toMatchObject({
      allocatedMinutes: 300,
      workspaceAllocatedMinutes: 660,
      workspaceStatus: 'over',
    })

    const workspace = await service.getWorkspaceSnapshot({
      workspaceId: 'workspace-1',
      fromDate: '2026-08-03',
      toDate: '2026-08-03',
      granularity: 'day',
      viewerMemberId: 'viewer-1',
      teams: [{ teamId: 'team-1', name: 'Team 1', canViewConfidential: false }],
    })
    expect(workspace.members[0]?.cells[0]).toMatchObject({
      allocatedMinutes: 660,
      status: 'over',
      teams: [{ teamId: 'team-1', allocatedMinutes: 300 }],
      hiddenAllocatedMinutes: 360,
    })
  })

  test('lists Workspace totals with visible Team and Project shares and hides the rest', async () => {
    const service = await createWorkspaceService(twoTeams())

    const snapshot = await service.getWorkspaceSnapshot({
      workspaceId: 'workspace-1',
      fromDate: '2026-08-03',
      toDate: '2026-08-03',
      granularity: 'day',
      viewerMemberId: 'viewer-1',
      teams: [{ teamId: 'team-1', name: 'Team 1', canViewConfidential: false }],
    })

    expect(snapshot.teams).toEqual([{ teamId: 'team-1', name: 'Team 1' }])
    expect(snapshot.members).toHaveLength(1)
    expect(snapshot.members[0]).toMatchObject({ memberId: 'member-1', teamIds: ['team-1'], overloaded: true })
    expect(snapshot.members[0]?.cells[0]).toMatchObject({
      capacityMinutes: 480,
      allocatedMinutes: 600,
      status: 'over',
      teams: [{ teamId: 'team-1', allocatedMinutes: 300 }],
      projects: [{ teamId: 'team-1', allocatedMinutes: 300 }],
      hiddenAllocatedMinutes: 300,
    })
  })

  test('keeps confidential rows and invisible Projects out of the breakdown for a Team viewer', async () => {
    const service = await createWorkspaceService({
      'team-1': createState([profile], [
        { ...createAssignment('secret', true, '2026-08-03', '2026-08-03', 120), projectId: 'project-1' },
        { ...createAssignment('other-project', false, '2026-08-03', '2026-08-03', 60), projectId: 'project-9' },
        { ...createAssignment('visible', false, '2026-08-03', '2026-08-03', 30), projectId: 'project-1' },
      ]),
    })
    const read = async (canViewConfidential: boolean) => await service.getWorkspaceSnapshot({
      workspaceId: 'workspace-1',
      fromDate: '2026-08-03',
      toDate: '2026-08-03',
      granularity: 'day',
      viewerMemberId: 'viewer-1',
      teams: [{
        teamId: 'team-1',
        name: 'Team 1',
        visibleMemberIds: new Set(['member-1']),
        visibleProjectIds: new Set(['project-1']),
        canViewConfidential,
      }],
    })

    expect((await read(false)).members[0]?.cells[0]).toMatchObject({
      allocatedMinutes: 210,
      projects: [{ teamId: 'team-1', projectId: 'project-1', allocatedMinutes: 30 }],
      hiddenAllocatedMinutes: 180,
    })
    expect((await read(true)).members[0]?.cells[0]).toMatchObject({
      projects: [{ teamId: 'team-1', projectId: 'project-1', allocatedMinutes: 150 }],
      hiddenAllocatedMinutes: 60,
    })
  })

  test('uses the smallest capacity of the member profiles, so time off in one Team counts everywhere', async () => {
    const service = await createWorkspaceService({
      'team-1': createState([profile]),
      'team-2': createState([{
        ...inTeam(profile, 'team-2'),
        timeOff: [{ id: 'pto', fromDate: '2026-08-03', toDate: '2026-08-03', status: 'approved', revision: 1 }],
      }]),
    })

    const snapshot = await service.getSnapshot(createInput({ teamId: 'team-1' }))

    expect(snapshot.members[0]?.cells[0]).toMatchObject({ capacityMinutes: 480, workspaceCapacityMinutes: 0 })
  })

  test('hides the allocation of a Team whose member allowlist leaves the member out', async () => {
    const service = await createWorkspaceService(twoTeams())

    const snapshot = await service.getWorkspaceSnapshot({
      workspaceId: 'workspace-1',
      fromDate: '2026-08-03',
      toDate: '2026-08-03',
      granularity: 'day',
      viewerMemberId: 'viewer-1',
      teams: [
        { teamId: 'team-1', name: 'Team 1', canViewConfidential: false },
        { teamId: 'team-2', name: 'Team 2', visibleMemberIds: new Set(['viewer-1']), canViewConfidential: true },
      ],
    })

    expect(snapshot.members[0]).toMatchObject({ memberId: 'member-1', teamIds: ['team-1'] })
    expect(snapshot.members[0]?.cells[0]).toMatchObject({
      allocatedMinutes: 600,
      teams: [{ teamId: 'team-1', allocatedMinutes: 300 }],
      hiddenAllocatedMinutes: 300,
    })
  })

  test('labels a member only from the profiles of Teams the viewer may see', async () => {
    const { displayName: _displayName, role: _role, ...unlabeled } = profile
    const service = await createWorkspaceService({
      'team-1': createState([unlabeled]),
      'team-2': createState([{ ...inTeam(profile, 'team-2'), displayName: 'Secret name', role: 'Secret role' }]),
    })

    const snapshot = await service.getWorkspaceSnapshot({
      workspaceId: 'workspace-1',
      fromDate: '2026-08-03',
      toDate: '2026-08-03',
      granularity: 'day',
      viewerMemberId: 'viewer-1',
      teams: [{ teamId: 'team-1', name: 'Team 1', canViewConfidential: false }],
    })

    expect(snapshot.members[0]?.memberId).toBe('member-1')
    expect(snapshot.members[0]?.displayName).toBeUndefined()
    expect(snapshot.members[0]?.role).toBeUndefined()
  })

  test('leaves archived Teams out of Workspace totals', async () => {
    const service = await createWorkspaceService(twoTeams())
    const activeTeamIds = new Set(['team-1'])

    const teamSnapshot = await service.getSnapshot({ ...createInput({ teamId: 'team-1' }), activeTeamIds })
    expect(teamSnapshot.members[0]?.cells[0]).toMatchObject({ workspaceAllocatedMinutes: 300, workspaceStatus: 'under' })

    const workspace = await service.getWorkspaceSnapshot({
      workspaceId: 'workspace-1',
      fromDate: '2026-08-03',
      toDate: '2026-08-03',
      granularity: 'day',
      viewerMemberId: 'viewer-1',
      teams: [{ teamId: 'team-1', name: 'Team 1', canViewConfidential: false }],
      activeTeamIds,
    })
    expect(workspace.members[0]?.cells[0]).toMatchObject({ allocatedMinutes: 300, hiddenAllocatedMinutes: 0 })
  })

  test('leaves out members the viewer cannot see in any viewable Team', async () => {
    const service = await createWorkspaceService(twoTeams())

    const snapshot = await service.getWorkspaceSnapshot({
      workspaceId: 'workspace-1',
      fromDate: '2026-08-03',
      toDate: '2026-08-09',
      granularity: 'week',
      viewerMemberId: 'viewer-1',
      teams: [{ teamId: 'team-2', name: 'Team 2', visibleMemberIds: new Set(['viewer-1']), canViewConfidential: false }],
    })

    expect(snapshot.members).toEqual([])
  })
})

describe('DynamoDbCapacityPlanningRepository', () => {
  test('lists Team states across every Query page', async () => {
    const requests: Record<string, unknown>[] = []
    const lastEvaluatedKey = { workspaceId: { S: 'workspace-1' }, recordKey: { S: 'CAPACITY#TEAM#team-a' } }
    const pages = [
      { Items: [storedStateItem('team-a')], LastEvaluatedKey: lastEvaluatedKey },
      { Items: [storedStateItem('team-b')] },
    ]
    const lowLevelClient = new DynamoDBClient({
      credentials: { accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key' },
      region: 'ap-northeast-1',
      requestHandler: {
        async handle(request: unknown) {
          requests.push(readJsonRequestBody(request))
          const page = pages[requests.length - 1] ?? { Items: [] }
          return {
            response: {
              body: new TextEncoder().encode(JSON.stringify(page)),
              headers: {},
              statusCode: 200,
            },
          }
        },
      },
    })
    const documentClient = createDynamoDbDocumentClient(lowLevelClient)
    try {
      const repository = new DynamoDbCapacityPlanningRepository('capacity-table', documentClient)

      const states = await repository.listStates('workspace-1')

      expect(states.map((state) => state.teamId)).toEqual(['team-a', 'team-b'])
      expect(requests).toHaveLength(2)
      expect(requests[0]?.ExclusiveStartKey).toBeUndefined()
      expect(requests[1]?.ExclusiveStartKey).toEqual(lastEvaluatedKey)
    } finally {
      documentClient.destroy()
    }
  })
})

/** Encodes an empty stored Team state as a low-level DynamoDB item. */
function storedStateItem(teamId: string): Record<string, unknown> {
  return {
    workspaceId: { S: 'workspace-1' },
    recordKey: { S: `CAPACITY#TEAM#${teamId}` },
    revision: { N: '1' },
    profiles: { L: [] },
    requests: { L: [] },
    assignments: { L: [] },
  }
}

/** Parses the JSON body of an AWS SDK request. */
function readJsonRequestBody(request: unknown): Record<string, unknown> {
  if (!isRecord(request)) throw new TypeError('Expected an AWS SDK request object.')
  const body = Reflect.get(request, 'body')
  const text = typeof body === 'string'
    ? body
    : body instanceof Uint8Array
      ? new TextDecoder().decode(body)
      : undefined
  if (text === undefined) throw new TypeError('Expected an AWS SDK request body.')
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) throw new TypeError('Expected an AWS SDK JSON request body.')
  return parsed
}

/** Returns whether an unknown value is a non-array object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
