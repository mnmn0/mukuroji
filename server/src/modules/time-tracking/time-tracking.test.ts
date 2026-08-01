import { describe, expect, test } from 'bun:test'
import {
  InMemoryTimeTrackingRepository,
  TimeTrackingService,
} from './time-tracking'

function createFixture() {
  let id = 0
  const repository = new InMemoryTimeTrackingRepository()
  const service = new TimeTrackingService(repository, {
    now: () => new Date('2026-08-02T12:00:00.000Z'),
    createId: () => `id-${++id}`,
  })
  return { repository, service }
}

describe('TimeTrackingService', () => {
  test('creates, submits, approves, and locks an entry with immutable history', async () => {
    const { service } = createFixture()
    const entry = await service.createEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      projectId: 'project-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      startAt: '2026-08-02T09:00:00.000Z',
      endAt: '2026-08-02T10:30:00.000Z',
      billable: true,
      currency: 'jpy',
      hourlyRateMinor: 2_000,
      source: 'manual',
    }, true)

    const submitted = await service.transitionEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      entryId: entry.id,
      actorUserId: 'member-1',
      canApprove: false,
      expectedRevision: entry.revision,
      action: 'submit',
    })
    const approved = await service.transitionEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      entryId: entry.id,
      actorUserId: 'manager-1',
      canApprove: true,
      expectedRevision: submitted.revision,
      action: 'approve',
    })
    const locked = await service.transitionEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      entryId: entry.id,
      actorUserId: 'manager-1',
      canApprove: true,
      expectedRevision: approved.revision,
      action: 'lock',
    })

    expect(locked.status).toBe('locked')
    expect(locked.durationMinutes).toBe(90)
    expect(locked.actualCostMinor).toBe(3_000)
    expect(await service.listHistory('workspace-1', 'team-1', entry.id)).toHaveLength(4)
  })

  test('rejects confidential rate changes for a general member', async () => {
    const { service } = createFixture()
    await expect(service.createEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      startAt: '2026-08-02T09:00:00.000Z',
      endAt: '2026-08-02T10:00:00.000Z',
      billable: true,
      currency: 'USD',
      hourlyRateMinor: 100,
      source: 'manual',
    }, false)).rejects.toMatchObject({
      code: 'ConfidentialRateDenied',
      status: 403,
    })
  })

  test('allows only one running timer and recovers it before stopping', async () => {
    const { service } = createFixture()
    const timer = await service.startTimer({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      billable: false,
      startedAt: '2026-08-02T09:00:00.000Z',
    })
    await expect(service.startTimer({
      workspaceId: 'workspace-1',
      teamId: 'team-2',
      workItemId: 'work-item-2',
      userId: 'member-1',
      billable: true,
    })).rejects.toMatchObject({ code: 'RunningTimerAlreadyExists' })
    expect((await service.getActiveTimer('workspace-1', 'member-1'))?.id).toBe(timer.id)
    const entry = await service.stopTimer({
      workspaceId: 'workspace-1',
      timerId: timer.id,
      userId: 'member-1',
      endedAt: '2026-08-02T10:15:00.000Z',
      currency: 'USD',
      canManageRates: false,
    })
    expect(entry.source).toBe('timer')
    expect(entry.durationMinutes).toBe(75)
    expect(await service.getActiveTimer('workspace-1', 'member-1')).toBeUndefined()
  })

  test('splits an interval crossing local midnight into daily and weekly timesheets', async () => {
    const { service } = createFixture()
    await service.createEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      startAt: '2026-08-01T14:30:00.000Z',
      endAt: '2026-08-01T16:30:00.000Z',
      billable: true,
      currency: 'USD',
      source: 'manual',
    }, false)
    const sheet = await service.createTimesheet({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      from: '2026-08-01',
      to: '2026-08-02',
      timeZone: 'Asia/Tokyo',
      groupBy: 'day',
      includeCosts: false,
    })
    expect(sheet.days.map((day) => [day.key, day.minutes])).toEqual([
      ['2026-08-01', 30],
      ['2026-08-02', 90],
    ])
    expect(sheet.weeks).toHaveLength(1)
    expect(sheet.costsRedacted).toBe(true)
  })

  test('compares Work Item estimates with project grouped actual time', async () => {
    const { service } = createFixture()
    await service.saveEstimate({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      workItemId: 'work-item-1',
      estimateMinutes: 120,
      updatedBy: 'manager-1',
    })
    await service.createEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      projectId: 'project-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      startAt: '2026-08-02T09:00:00.000Z',
      endAt: '2026-08-02T10:00:00.000Z',
      billable: true,
      currency: 'USD',
      hourlyRateMinor: 5_000,
      source: 'manual',
    }, true)
    await service.createEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      projectId: 'project-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      startAt: '2026-08-02T10:00:00.000Z',
      endAt: '2026-08-02T10:30:00.000Z',
      billable: true,
      currency: 'USD',
      hourlyRateMinor: 5_000,
      source: 'manual',
    }, true)
    const summary = await service.createSummary({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      from: '2026-08-02',
      to: '2026-08-02',
      timeZone: 'UTC',
      groupBy: 'project',
      includeCosts: true,
    })
    expect(summary.groups[0]).toMatchObject({
      key: 'project-1',
      minutes: 90,
      estimateMinutes: 120,
      actualCostMinor: 7_500,
    })
    expect(summary.totalActualCostMinor).toBe(7_500)
    expect(summary.totalEstimateMinutes).toBe(120)

    const workItemSummary = await service.createSummary({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      from: '2026-08-02',
      to: '2026-08-02',
      timeZone: 'UTC',
      groupBy: 'work-item',
      includeCosts: false,
    })
    expect(workItemSummary.groups[0]).toMatchObject({
      key: 'work-item-1',
      minutes: 90,
      estimateMinutes: 120,
    })
    const userSummary = await service.createSummary({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      from: '2026-08-02',
      to: '2026-08-02',
      timeZone: 'UTC',
      groupBy: 'user',
      includeCosts: false,
    })
    expect(userSummary.totalEstimateMinutes).toBe(120)
    expect(await service.getEstimate('workspace-1', 'team-1', 'work-item-1')).toMatchObject({
      estimateMinutes: 120,
    })
  })
})
