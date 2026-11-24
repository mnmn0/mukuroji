import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WorkloadSnapshot } from '@mukuroji/contracts'
import { createTranslator } from '../src/shared/i18n/i18n'
import { WorkloadPlanningControls } from '../src/workload/ui/WorkloadPlanningControls'

/**
 * Builds a snapshot whose only member has a saved profile that is off on Monday.
 *
 * @returns The workload snapshot.
 */
function snapshotWithMondayOff(): WorkloadSnapshot {
  return {
    schemaVersion: 1,
    workspaceId: 'workspace-1',
    teamId: 'team-1',
    fromDate: '2026-08-03',
    toDate: '2026-08-14',
    granularity: 'day',
    members: [{
      memberId: 'hana',
      skills: [],
      timeOff: [],
      calendarSource: 'custom',
      timeZone: 'UTC',
      schedule: {
        monday: { enabled: false, minutes: 0 },
        tuesday: { enabled: true, minutes: 360 },
        wednesday: { enabled: true, minutes: 360 },
        thursday: { enabled: true, minutes: 360 },
        friday: { enabled: true, minutes: 360 },
        saturday: { enabled: false, minutes: 0 },
        sunday: { enabled: false, minutes: 0 },
      },
      holidays: [],
      profileRevision: 2,
      cells: [],
      capacityMinutes: 0,
      allocatedMinutes: 0,
      plannedEffortMinutes: 0,
      actualMinutes: 0,
      remainingEffortMinutes: 0,
      overloaded: false,
    }],
    requests: [],
    assignments: [],
    redactedAssignmentCount: 0,
    redactedRequestCount: 0,
    revision: 1,
    generatedAt: '2026-08-02T00:00:00.000Z',
  }
}

describe('workload profile form', () => {
  test('shows the hours of the first working weekday when the member is off on Monday', () => {
    const markup = renderToStaticMarkup(
      <WorkloadPlanningControls
        accessToken="token"
        members={[{ id: 'hana', name: 'Hanako Sato', email: 'hana@example.com' }]}
        onSaved={() => undefined}
        projects={[]}
        snapshot={snapshotWithMondayOff()}
        t={createTranslator('en')}
        teamId="team-1"
      />,
    )

    expect(markup).toContain('max="24" min="0" step="0.5" type="number" value="6"')
  })
})
