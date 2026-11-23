import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CAPACITY_PLANNING_SCHEMA_VERSION, type WorkloadSnapshot, type WorkspaceWorkloadSnapshot } from '@mukuroji/contracts'
import { getMyTimesheet, submitMyTimesheet } from '../src/features/time-tracking/api/myTimesheet'
import { MyTimesheetPanel } from '../src/features/time-tracking/ui/MyTimesheetPanel'
import { createTranslator } from '../src/shared/i18n/i18n'
import { getWorkspaceWorkload } from '../src/workload/api'
import { TeamWorkloadView } from '../src/workload/ui/TeamWorkloadView'
import { WorkspaceWorkloadView } from '../src/workload/ui/WorkspaceWorkloadView'

const originalFetch = globalThis.fetch
const t = createTranslator('ja')

afterEach(() => {
  globalThis.fetch = originalFetch
})

const workspaceSnapshot: WorkspaceWorkloadSnapshot = {
  schemaVersion: CAPACITY_PLANNING_SCHEMA_VERSION,
  workspaceId: 'workspace-1',
  fromDate: '2026-08-03',
  toDate: '2026-08-03',
  granularity: 'day',
  teams: [{ teamId: 'team-1', name: '開発' }],
  members: [{
    memberId: 'member-1',
    displayName: '花子',
    teamIds: ['team-1'],
    capacityMinutes: 480,
    allocatedMinutes: 600,
    overloaded: true,
    cells: [{
      fromDate: '2026-08-03',
      toDate: '2026-08-03',
      label: '2026-08-03',
      capacityMinutes: 480,
      allocatedMinutes: 600,
      utilizationPercent: 125,
      varianceMinutes: -120,
      status: 'over',
      teams: [{ teamId: 'team-1', allocatedMinutes: 300 }],
      projects: [{ teamId: 'team-1', allocatedMinutes: 300 }],
      hiddenAllocatedMinutes: 300,
    }],
  }],
  generatedAt: '2026-08-01T00:00:00.000Z',
}

/** Replaces fetch with one that answers every request with a JSON body. */
function answerWith(body: unknown, requests: Array<{ url: string; body?: string }> = []) {
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), ...(typeof init?.body === 'string' ? { body: init.body } : {}) })
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }, { preconnect: originalFetch.preconnect })
  return requests
}

describe('workload across Teams', () => {
  test('reads and validates the Workspace workload', async () => {
    const requests = answerWith(workspaceSnapshot)
    const snapshot = await getWorkspaceWorkload('token', { fromDate: '2026-08-03', toDate: '2026-08-03', granularity: 'day' })
    expect(snapshot.members[0]?.cells[0]?.hiddenAllocatedMinutes).toBe(300)
    expect(requests[0]?.url).toEndWith('/workload?from=2026-08-03&to=2026-08-03&granularity=day')

    answerWith({ ...workspaceSnapshot, members: [{ ...workspaceSnapshot.members[0], cells: [{ status: 'over' }] }] })
    await expect(getWorkspaceWorkload('token', { fromDate: '2026-08-03', toDate: '2026-08-03', granularity: 'day' }))
      .rejects.toMatchObject({ status: 502 })
  })

  test('renders totals with each visible Team and the hidden remainder', () => {
    const html = renderToStaticMarkup(
      <WorkspaceWorkloadView failed={false} granularity="day" isLoading={false} onGranularityChange={() => {}} onRetry={() => {}} snapshot={workspaceSnapshot} t={t} />,
    )
    expect(html).toContain('花子')
    expect(html).toContain('10h')
    expect(html).toContain('開発: 5h')
    expect(html).toContain('非公開 5h')
  })

  test('marks a Team view cell over when only the Teams together exceed capacity', () => {
    const snapshot: WorkloadSnapshot = {
      schemaVersion: CAPACITY_PLANNING_SCHEMA_VERSION,
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      fromDate: '2026-08-03',
      toDate: '2026-08-03',
      granularity: 'day',
      members: [{
        memberId: 'member-1',
        skills: [],
        timeZone: 'UTC',
        schedule: {
          monday: { enabled: true, minutes: 480 },
          tuesday: { enabled: true, minutes: 480 },
          wednesday: { enabled: true, minutes: 480 },
          thursday: { enabled: true, minutes: 480 },
          friday: { enabled: true, minutes: 480 },
          saturday: { enabled: false, minutes: 0 },
          sunday: { enabled: false, minutes: 0 },
        },
        holidays: [],
        profileRevision: 1,
        cells: [{
          fromDate: '2026-08-03',
          toDate: '2026-08-03',
          label: '2026-08-03',
          capacityMinutes: 480,
          allocatedMinutes: 300,
          plannedEffortMinutes: 300,
          actualMinutes: 0,
          remainingEffortMinutes: 300,
          utilizationPercent: 63,
          varianceMinutes: 180,
          status: 'under',
          workspaceCapacityMinutes: 480,
          workspaceAllocatedMinutes: 600,
          workspaceStatus: 'over',
        }],
        capacityMinutes: 480,
        allocatedMinutes: 300,
        plannedEffortMinutes: 300,
        actualMinutes: 0,
        remainingEffortMinutes: 300,
        overloaded: false,
        workspaceOverloaded: true,
      }],
      requests: [],
      assignments: [],
      redactedAssignmentCount: 0,
      redactedRequestCount: 0,
      revision: 1,
      generatedAt: '2026-08-01T00:00:00.000Z',
    }
    const html = renderToStaticMarkup(
      <TeamWorkloadView granularity="day" isLoading={false} onGranularityChange={() => {}} onRetry={() => {}} snapshot={snapshot} t={t} />,
    )
    expect(html).toContain('他 Team を含めて超過')
    expect(html).toContain('全 Team の割り当て 10h / キャパシティ 8h')
  })
})

describe('personal timesheet across Teams', () => {
  const timesheet = {
    timeZone: 'UTC',
    teams: [{
      teamId: 'team-1',
      name: '開発',
      timesheet: {
        from: '2026-08-03T00:00:00.000Z',
        to: '2026-08-10T00:00:00.000Z',
        timeZone: 'UTC',
        days: [{ key: '2026-08-03', label: '2026-08-03', minutes: 90, billableMinutes: 0, entryCount: 1 }],
        weeks: [],
        costsRedacted: true,
        canManageTeam: false,
      },
      entries: [],
    }],
  }

  test('reads the timesheet and submits every Team at once', async () => {
    answerWith(timesheet)
    const read = await getMyTimesheet('token', { from: '2026-08-03T00:00:00.000Z', to: '2026-08-10T00:00:00.000Z', timeZone: 'UTC' })
    expect(read.teams[0]?.name).toBe('開発')

    const requests = answerWith({ count: 2, failedEntryIds: [], partialFailure: false, teams: [{ teamId: 'team-1', count: 2, failedEntryIds: [] }] })
    const entries = [{ teamId: 'team-1', entryId: 'entry-1', expectedRevision: 2 }]
    const result = await submitMyTimesheet('token', { from: 'a', to: 'b', entries }, { idempotencyKey: 'key', correlationId: 'id' })
    expect(result.count).toBe(2)
    expect(requests[0]?.url).toEndWith('/time-tracking/my-timesheet/submit')
    expect(requests[0]?.body).toBe(JSON.stringify({ from: 'a', to: 'b', entries }))
  })

  test('renders one row per Team with the week totals', () => {
    const html = renderToStaticMarkup(
      <MyTimesheetPanel
        days={['2026-08-03', '2026-08-04']}
        failed={false}
        isLoading={false}
        isSubmitting={false}
        notice={{ kind: 'partial', count: 1, failed: 1 }}
        onMoveWeek={() => {}}
        onRetry={() => {}}
        onSubmit={() => {}}
        t={t}
        timesheet={timesheet}
      />,
    )
    expect(html).toContain('開発')
    expect(html).toContain('1:30')
    expect(html).toContain('1 件は提出できなかった')
  })
})
