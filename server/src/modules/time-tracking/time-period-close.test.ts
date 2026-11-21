import { describe, expect, test } from 'bun:test'
import {
  InMemoryTimeTrackingRepository,
  TimeTrackingError,
  TimeTrackingService,
  type CreateTimeEntryInput,
} from './time-tracking'
import type { TimePeriodClose } from '@mukuroji/contracts'

/** In-memory repository that closes a month right after a write has read the close list. */
class RacingCloseRepository extends InMemoryTimeTrackingRepository {
  /** Month close to store once, after the next close list read. */
  pendingClose: TimePeriodClose | undefined

  /**
   * Lists closes, then stores the pending close as if another request closed the month.
   *
   * @param workspaceId - Workspace identifier.
   * @param teamId - Team identifier.
   * @returns The closes as they were before the racing close.
   */
  override async listPeriodCloses(workspaceId: string, teamId: string): Promise<TimePeriodClose[]> {
    const closes = await super.listPeriodCloses(workspaceId, teamId)
    const pending = this.pendingClose
    this.pendingClose = undefined
    if (pending) await this.createPeriodClose(pending)
    return closes
  }
}

/** Creates a service with deterministic IDs and a clock in August 2026. */
function createFixture() {
  let id = 0
  const repository = new InMemoryTimeTrackingRepository()
  const service = new TimeTrackingService(repository, {
    now: () => new Date('2026-08-02T12:00:00.000Z'),
    createId: () => `id-${++id}`,
  })
  return { repository, service }
}

/**
 * Builds a manual entry request for member-1 in team-1.
 *
 * @param startAt - Interval start.
 * @param endAt - Interval end.
 * @returns A create request.
 */
function entryInput(startAt: string, endAt: string): CreateTimeEntryInput {
  return {
    workspaceId: 'workspace-1',
    teamId: 'team-1',
    workItemId: 'work-item-1',
    userId: 'member-1',
    startAt,
    endAt,
    billable: true,
    currency: 'JPY',
    source: 'manual',
  }
}

/**
 * Runs an operation and returns the time tracking error code it raised.
 *
 * @param operation - Operation expected to fail.
 * @returns The error code.
 */
async function errorCode(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation()
  } catch (error) {
    if (error instanceof TimeTrackingError) return error.code
    throw error
  }
  throw new Error('Expected the operation to fail.')
}

describe('TimeTrackingService month close', () => {
  test('rejects an entry write when the month is closed after the close check read', async () => {
    const repository = new RacingCloseRepository()
    const service = new TimeTrackingService(repository, {
      now: () => new Date('2026-08-02T12:00:00.000Z'),
      createId: () => 'entry-1',
    })
    repository.pendingClose = {
      schemaVersion: 1,
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      month: '2026-07',
      timeZone: 'UTC',
      closedBy: 'manager-1',
      closedAt: '2026-08-02T12:00:00.000Z',
    }

    expect(await errorCode(() => service.createEntry(entryInput('2026-07-31T01:00:00.000Z', '2026-07-31T02:00:00.000Z'), false)))
      .toBe('TimePeriodClosed')
    expect(await service.listEntries({ workspaceId: 'workspace-1', teamId: 'team-1' })).toHaveLength(0)
  })

  test('rejects creating and editing entries in a closed month and allows them again after reopening', async () => {
    const { service } = createFixture()
    const entry = await service.createEntry(entryInput('2026-07-31T01:00:00.000Z', '2026-07-31T02:00:00.000Z'), false)

    const close = await service.closePeriod({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      month: '2026-07',
      timeZone: 'Asia/Tokyo',
      actorUserId: 'manager-1',
    })
    expect(close).toMatchObject({ month: '2026-07', timeZone: 'Asia/Tokyo', closedBy: 'manager-1' })
    expect(await service.listClosedPeriods('workspace-1', 'team-1')).toEqual([close])

    expect(await errorCode(() => service.createEntry(entryInput('2026-07-15T01:00:00.000Z', '2026-07-15T02:00:00.000Z'), false)))
      .toBe('TimePeriodClosed')
    expect(await errorCode(() => service.updateEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      entryId: entry.id,
      actorUserId: 'member-1',
      canManageRates: false,
      expectedRevision: entry.revision,
      description: 'late fix',
    }))).toBe('TimePeriodClosed')
    expect(await errorCode(() => service.transitionEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      entryId: entry.id,
      actorUserId: 'member-1',
      canApprove: false,
      expectedRevision: entry.revision,
      action: 'submit',
    }))).toBe('TimePeriodClosed')

    expect(await errorCode(() => service.reopenPeriod({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      month: '2026-07',
      actorUserId: 'manager-1',
      reason: '  ',
    }))).toBe('ReopenReasonRequired')
    await service.reopenPeriod({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      month: '2026-07',
      actorUserId: 'manager-1',
      reason: 'Missing a client meeting',
    })
    expect(await service.listClosedPeriods('workspace-1', 'team-1')).toEqual([])
    const updated = await service.updateEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      entryId: entry.id,
      actorUserId: 'member-1',
      canManageRates: false,
      expectedRevision: entry.revision,
      description: 'late fix',
    })
    expect(updated.description).toBe('late fix')
  })

  test('rejects deleting a draft in a closed month and moving date-and-minutes time into one', async () => {
    const { service } = createFixture()
    const closedDraft = await service.createEntry(entryInput('2026-07-20T01:00:00.000Z', '2026-07-20T02:00:00.000Z'), false)
    const openDraft = await service.createEntry(entryInput('2026-08-03T01:00:00.000Z', '2026-08-03T02:00:00.000Z'), false)
    await service.closePeriod({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      month: '2026-07',
      timeZone: 'Asia/Tokyo',
      actorUserId: 'manager-1',
    })

    expect(await errorCode(() => service.deleteEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      entryId: closedDraft.id,
      actorUserId: 'member-1',
      expectedRevision: closedDraft.revision,
    }))).toBe('TimePeriodClosed')
    expect(await errorCode(() => service.updateEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      entryId: openDraft.id,
      actorUserId: 'member-1',
      canManageRates: false,
      expectedRevision: openDraft.revision,
      duration: { date: '2026-07-30', minutes: 60, timeZone: 'Asia/Tokyo' },
    }))).toBe('TimePeriodClosed')
    await expect(service.deleteEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      entryId: openDraft.id,
      actorUserId: 'member-1',
      expectedRevision: openDraft.revision,
    })).resolves.toEqual({ entryId: openDraft.id, deleted: true })
  })

  test('uses the close timezone for month boundaries and keeps other Teams open', async () => {
    const { service } = createFixture()
    await service.closePeriod({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      month: '2026-07',
      timeZone: 'Asia/Tokyo',
      actorUserId: 'manager-1',
    })

    // 2026-07-31T15:00Z is 2026-08-01 00:00 in Tokyo, so this entry is in the open August.
    const august = await service.createEntry(entryInput('2026-07-31T15:00:00.000Z', '2026-07-31T16:00:00.000Z'), false)
    expect(august.status).toBe('draft')
    // 2026-06-30T15:00Z is 2026-07-01 00:00 in Tokyo, so this entry is in the closed July.
    expect(await errorCode(() => service.createEntry(entryInput('2026-06-30T15:00:00.000Z', '2026-06-30T16:00:00.000Z'), false)))
      .toBe('TimePeriodClosed')
    // An entry that crosses into the closed month is rejected too.
    expect(await errorCode(() => service.createEntry(entryInput('2026-06-30T14:00:00.000Z', '2026-06-30T15:30:00.000Z'), false)))
      .toBe('TimePeriodClosed')
    const otherTeam = await service.createEntry({ ...entryInput('2026-07-15T01:00:00.000Z', '2026-07-15T02:00:00.000Z'), teamId: 'team-2' }, false)
    expect(otherTeam.status).toBe('draft')
    // Moving an open entry into the closed month is rejected.
    expect(await errorCode(() => service.updateEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      entryId: august.id,
      actorUserId: 'member-1',
      canManageRates: false,
      expectedRevision: august.revision,
      startAt: '2026-07-20T01:00:00.000Z',
      endAt: '2026-07-20T02:00:00.000Z',
    }))).toBe('TimePeriodClosed')
  })

  test('rejects closing a month twice and validates the month and timezone', async () => {
    const { service } = createFixture()
    const input = { workspaceId: 'workspace-1', teamId: 'team-1', month: '2026-07', timeZone: 'UTC', actorUserId: 'manager-1' }
    await service.closePeriod(input)
    expect(await errorCode(() => service.closePeriod(input))).toBe('TimePeriodAlreadyClosed')
    expect(await errorCode(() => service.closePeriod({ ...input, month: '2026-13' }))).toBe('InvalidMonth')
    // The month after 9999-12 has no four-digit year, so it would break every later overlap check.
    expect(await errorCode(() => service.closePeriod({ ...input, month: '9999-12' }))).toBe('InvalidMonth')
    expect(await service.listClosedPeriods('workspace-1', 'team-1')).toHaveLength(1)
    expect(await errorCode(() => service.closePeriod({ ...input, month: '2026-08', timeZone: 'Not/AZone' }))).toBe('InvalidTimeZone')
    expect(await errorCode(() => service.reopenPeriod({ ...input, month: '2026-06', reason: 'typo' }))).toBe('TimePeriodNotClosed')
  })

  test('returns an approved entry with a reason so the member can correct it', async () => {
    const { service } = createFixture()
    const entry = await service.createEntry(entryInput('2026-08-01T01:00:00.000Z', '2026-08-01T02:00:00.000Z'), false)
    const base = { workspaceId: 'workspace-1', teamId: 'team-1', entryId: entry.id }
    const submitted = await service.transitionEntry({ ...base, actorUserId: 'member-1', canApprove: false, expectedRevision: 1, action: 'submit' })
    const approved = await service.transitionEntry({ ...base, actorUserId: 'manager-1', canApprove: true, expectedRevision: submitted.revision, action: 'approve' })
    const locked = await service.transitionEntry({ ...base, actorUserId: 'manager-1', canApprove: true, expectedRevision: approved.revision, action: 'lock' })

    expect(await errorCode(() => service.transitionEntry({
      ...base, actorUserId: 'manager-1', canApprove: true, expectedRevision: locked.revision, action: 'return',
    }))).toBe('ReturnReasonRequired')
    expect(await errorCode(() => service.transitionEntry({
      ...base, actorUserId: 'member-1', canApprove: false, expectedRevision: locked.revision, action: 'return', reason: 'self',
    }))).toBe('TimesheetApprovalDenied')

    const returned = await service.transitionEntry({
      ...base, actorUserId: 'manager-1', canApprove: true, expectedRevision: locked.revision, action: 'return', reason: 'Wrong Work Item',
    })
    expect(returned.status).toBe('rejected')
    expect(returned.approvedAt).toBeUndefined()
    expect(returned.lockedAt).toBeUndefined()
    const history = await service.listHistory('workspace-1', 'team-1', entry.id)
    expect(history.at(-1)).toMatchObject({ action: 'returned', fromStatus: 'locked', toStatus: 'rejected', reason: 'Wrong Work Item', actorUserId: 'manager-1' })

    const edited = await service.updateEntry({
      ...base, actorUserId: 'member-1', canManageRates: false, expectedRevision: returned.revision, description: 'corrected',
    })
    expect(edited.description).toBe('corrected')
  })

  test('does not return a draft entry or one in a closed month, but still locks approved time there', async () => {
    const { service } = createFixture()
    const draft = await service.createEntry(entryInput('2026-08-01T01:00:00.000Z', '2026-08-01T02:00:00.000Z'), false)
    expect(await errorCode(() => service.transitionEntry({
      workspaceId: 'workspace-1', teamId: 'team-1', entryId: draft.id, actorUserId: 'manager-1', canApprove: true, expectedRevision: 1, action: 'return', reason: 'x',
    }))).toBe('InvalidTimeEntryTransition')

    const july = await service.createEntry(entryInput('2026-07-10T01:00:00.000Z', '2026-07-10T02:00:00.000Z'), false)
    const base = { workspaceId: 'workspace-1', teamId: 'team-1', entryId: july.id }
    const submitted = await service.transitionEntry({ ...base, actorUserId: 'member-1', canApprove: false, expectedRevision: 1, action: 'submit' })
    const approved = await service.transitionEntry({ ...base, actorUserId: 'manager-1', canApprove: true, expectedRevision: submitted.revision, action: 'approve' })
    await service.closePeriod({ workspaceId: 'workspace-1', teamId: 'team-1', month: '2026-07', timeZone: 'UTC', actorUserId: 'manager-1' })

    expect(await errorCode(() => service.transitionEntry({
      ...base, actorUserId: 'manager-1', canApprove: true, expectedRevision: approved.revision, action: 'return', reason: 'x',
    }))).toBe('TimePeriodClosed')
    const locked = await service.transitionEntry({ ...base, actorUserId: 'manager-1', canApprove: true, expectedRevision: approved.revision, action: 'lock' })
    expect(locked.status).toBe('locked')
  })

  test('rejects stopping a timer whose interval falls in a closed month', async () => {
    const { service } = createFixture()
    await service.closePeriod({ workspaceId: 'workspace-1', teamId: 'team-1', month: '2026-07', timeZone: 'UTC', actorUserId: 'manager-1' })
    const timer = await service.startTimer({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      billable: false,
      startedAt: '2026-07-31T23:00:00.000Z',
    })
    expect(await errorCode(() => service.stopTimer({
      workspaceId: 'workspace-1',
      timerId: timer.id,
      userId: 'member-1',
      endedAt: '2026-08-01T01:00:00.000Z',
      currency: 'JPY',
      canManageRates: false,
    }))).toBe('TimePeriodClosed')
  })
})
