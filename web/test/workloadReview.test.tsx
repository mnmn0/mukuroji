import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WorkloadSnapshot } from '@mukuroji/contracts'
import { createTranslator } from '../src/shared/i18n/i18n'
import { TeamWorkloadView } from '../src/workload/ui/TeamWorkloadView'
import { WorkloadTimeOffList } from '../src/workload/ui/WorkloadTimeOffList'

const t = createTranslator('en')

const day = { enabled: true, minutes: 480 }
const schedule: WorkloadSnapshot['members'][number]['schedule'] = {
  monday: day, tuesday: day, wednesday: day, thursday: day, friday: day, saturday: day, sunday: day,
}

/** Creates a one-member snapshot with pending time off and a tentative assignment. */
function createSnapshot(viewer: WorkloadSnapshot['viewer']): WorkloadSnapshot {
  return {
    schemaVersion: 1,
    workspaceId: 'workspace-1',
    teamId: 'team-1',
    fromDate: '2026-08-03',
    toDate: '2026-08-03',
    granularity: 'day',
    members: [{
      memberId: 'hana',
      displayName: 'Hanako',
      skills: [],
      timeZone: 'UTC',
      schedule,
      holidays: [],
      profileRevision: 2,
      timeOff: [
        { id: 'approved', fromDate: '2026-08-10', toDate: '2026-08-10', status: 'approved', revision: 2 },
        { id: 'pending', fromDate: '2026-08-03', toDate: '2026-08-03', status: 'planned', revision: 1 },
      ],
      cells: [{
        fromDate: '2026-08-03', toDate: '2026-08-03', label: '2026-08-03', capacityMinutes: 480, pendingTimeOffMinutes: 480,
        allocatedMinutes: 240, tentativeAllocatedMinutes: 240, plannedEffortMinutes: 240, actualMinutes: 0,
        remainingEffortMinutes: 240, utilizationPercent: 50, varianceMinutes: 240, status: 'under',
      }],
      capacityMinutes: 480,
      allocatedMinutes: 240,
      plannedEffortMinutes: 240,
      actualMinutes: 0,
      remainingEffortMinutes: 240,
      overloaded: false,
    }],
    requests: [],
    assignments: [{
      id: 'assignment-1', workspaceId: 'workspace-1', teamId: 'team-1', memberId: 'hana', workItemId: 'WI-1', skillIds: [],
      fromDate: '2026-08-03', toDate: '2026-08-03', allocationMinutes: 240, plannedEffortMinutes: 240, confidential: false,
      status: 'tentative', revision: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    }],
    redactedAssignmentCount: 0,
    redactedRequestCount: 0,
    revision: 3,
    generatedAt: '2026-08-02T00:00:00.000Z',
    ...(viewer ? { viewer } : {}),
  }
}

describe('workload review surfaces', () => {
  test('lists pending time off first with approve and reject actions for a manager', () => {
    const html = renderToStaticMarkup(
      <WorkloadTimeOffList isSaving={false} memberNames={new Map()} onReview={() => undefined} snapshot={createSnapshot({ memberId: 'mike', canManage: true })} t={t} />,
    )

    expect(html.indexOf('Awaiting approval')).toBeLessThan(html.indexOf('>Approved<'))
    expect(html).toContain('>Approve<')
    expect(html).toContain('>Reject<')
    expect(html).toContain('1 awaiting approval')
  })

  test('lets the member withdraw their own time off without review actions', () => {
    const html = renderToStaticMarkup(
      <WorkloadTimeOffList isSaving={false} memberNames={new Map()} onReview={() => undefined} snapshot={createSnapshot({ memberId: 'hana', canManage: false })} t={t} />,
    )

    expect(html).not.toContain('>Approve<')
    expect(html).not.toContain('>Reject<')
    expect(html).toContain('>Withdraw<')
  })

  test('marks tentative allocation and pending time off in the heatmap and offers confirm to a manager', () => {
    const render = (viewer: WorkloadSnapshot['viewer']) => renderToStaticMarkup(
      <TeamWorkloadView
        granularity="day"
        isLoading={false}
        onChangeAssignmentStatus={() => undefined}
        onGranularityChange={() => undefined}
        onMoveAssignment={() => undefined}
        onRetry={() => undefined}
        snapshot={createSnapshot(viewer)}
        t={t}
      />,
    )
    const manager = render({ memberId: 'mike', canManage: true })
    const member = render({ memberId: 'hana', canManage: false })

    expect(manager).toContain('4h tentative')
    expect(manager).toContain('8h time off pending')
    expect(manager).toContain('data-status="tentative"')
    expect(manager).toContain('>Confirm<')
    expect(member).not.toContain('>Confirm<')
  })

  test('shows status actions without the move form when only status changes are wired', () => {
    const html = renderToStaticMarkup(
      <TeamWorkloadView
        granularity="day"
        isLoading={false}
        onChangeAssignmentStatus={() => undefined}
        onGranularityChange={() => undefined}
        onRetry={() => undefined}
        snapshot={createSnapshot({ memberId: 'mike', canManage: true })}
        t={t}
      />,
    )

    expect(html).toContain('>Confirm<')
    expect(html).not.toContain('>Move assignment<')
    expect(html).not.toContain('draggable="true"')
  })

  test('lets the member resubmit their own rejected time off', () => {
    const snapshot = createSnapshot({ memberId: 'hana', canManage: false })
    const member = snapshot.members[0]
    if (!member) throw new Error('fixture member missing')
    member.timeOff = [{ id: 'rejected', fromDate: '2026-08-03', toDate: '2026-08-03', status: 'rejected', revision: 2 }]
    const html = renderToStaticMarkup(
      <WorkloadTimeOffList isSaving={false} memberNames={new Map()} onReview={() => undefined} snapshot={snapshot} t={t} />,
    )

    expect(html).toContain('>Resubmit<')
    expect(html).not.toContain('>Withdraw<')
  })
})
