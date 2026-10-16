import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WorkItemContributorAssignment, WorkItemJobRoleDefinition } from '@mukuroji/contracts'
import {
  createEmptyContributorDraftRow,
  formatContributorMemberLabel,
  formatPlannedEffortHours,
  listSelectableJobRoles,
  parseContributorDraftRows,
  parsePlannedEffortHours,
  readContributorDraftSubmission,
  serializeContributorDraftRows,
  sumContributorPlannedEffort,
  toContributorDraftRows,
} from '../src/work-items/model/contributorAssignments'
import { workspaceWorkItemConfigurationFixture as baseConfiguration } from '../src/work-items/fixtures'
import { normalizeWorkItemConfigurationForSave } from '../src/work-items/model/workItemConfigurationEditor'
import { resolveWorkItemContributorOptions } from '../src/work-items/model/workItemDisplay'
import type { WorkspaceMember } from '../src/workspace/api/access'
import { JobRolesConfigurationSection } from '../src/work-items/ui/JobRolesConfigurationSection'
import { WorkItemContributorsEditor } from '../src/work-items/ui/WorkItemContributorsEditor'

const jobRoles: WorkItemJobRoleDefinition[] = [
  { id: 'designer', name: 'Designer' },
  { id: 'legacy-writer', name: 'Writer', archived: true },
]

const assignments: WorkItemContributorAssignment[] = [
  { assignmentId: 'a'.repeat(32), memberUserId: 'sato@example.com', jobRoleId: 'legacy-writer', plannedEffortMinutes: 90, status: 'in-progress' },
  { assignmentId: 'b'.repeat(32), jobRoleId: 'designer', plannedEffortMinutes: 240, status: 'planned' },
]

describe('contributor draft model', () => {
  test('round-trips stored assignments through editable rows', () => {
    const rows = toContributorDraftRows(assignments)
    expect(rows.map((row) => row.plannedEffortHours)).toEqual(['1.5', '4'])
    expect(parseContributorDraftRows(rows)).toEqual({
      assignments: [
        { assignmentId: 'a'.repeat(32), memberUserId: 'sato@example.com', jobRoleId: 'legacy-writer', plannedEffortMinutes: 90, status: 'in-progress' },
        { assignmentId: 'b'.repeat(32), jobRoleId: 'designer', plannedEffortMinutes: 240, status: 'planned' },
      ],
    })
  })

  test('sends new rows without an assignment ID and omits blank fields', () => {
    expect(parseContributorDraftRows([
      { ...createEmptyContributorDraftRow('new-1'), memberUserId: 'suzuki@example.com' },
    ])).toEqual({ assignments: [{ memberUserId: 'suzuki@example.com', status: 'planned' }] })
  })

  test('reports the row that blocks saving', () => {
    const empty = createEmptyContributorDraftRow('new-1')
    expect(parseContributorDraftRows([empty])).toEqual({ error: 'missing-member-or-role', rowKey: 'new-1' })
    expect(parseContributorDraftRows([
      { ...empty, memberUserId: 'sato@example.com' },
      { ...createEmptyContributorDraftRow('new-2'), memberUserId: 'sato@example.com' },
    ])).toEqual({ error: 'duplicate-member', rowKey: 'new-2' })
    expect(parseContributorDraftRows([{ ...empty, jobRoleId: 'designer', plannedEffortHours: '1.255' }]))
      .toEqual({ error: 'invalid-effort', rowKey: 'new-1' })
    expect(parseContributorDraftRows(Array.from({ length: 21 }, (_, index) => ({
      ...createEmptyContributorDraftRow(`row-${index}`),
      jobRoleId: 'designer',
    })))).toEqual({ error: 'too-many' })
  })

  test('parses planned hours into whole minutes within the server limit', () => {
    expect(parsePlannedEffortHours('')).toBeUndefined()
    expect(parsePlannedEffortHours('0.25')).toBe(15)
    expect(parsePlannedEffortHours('1000')).toBe(60_000)
    expect(parsePlannedEffortHours('1000.01')).toBeNull()
    expect(parsePlannedEffortHours('-1')).toBeNull()
    expect(parsePlannedEffortHours('1e2')).toBeNull()
    expect(formatPlannedEffortHours(20)).toBe('0.33')
  })

  test('offers archived job roles only to rows that already use them', () => {
    expect(listSelectableJobRoles(jobRoles, undefined).map((jobRole) => jobRole.id)).toEqual(['designer'])
    expect(listSelectableJobRoles(jobRoles, 'legacy-writer').map((jobRole) => jobRole.id))
      .toEqual(['designer', 'legacy-writer'])
    expect(sumContributorPlannedEffort(assignments)).toBe(330)
  })
})

describe('contributor draft form submission', () => {
  test('is absent while no draft is open and parses an open draft', () => {
    expect(readContributorDraftSubmission(new FormData())).toBeUndefined()
    const formData = new FormData()
    formData.set('contributorAssignmentsDraft', serializeContributorDraftRows(toContributorDraftRows(assignments)))
    expect(readContributorDraftSubmission(formData)).toEqual({
      assignments: [
        { assignmentId: 'a'.repeat(32), memberUserId: 'sato@example.com', jobRoleId: 'legacy-writer', plannedEffortMinutes: 90, status: 'in-progress' },
        { assignmentId: 'b'.repeat(32), jobRoleId: 'designer', plannedEffortMinutes: 240, status: 'planned' },
      ],
    })
  })

  test('rejects a tampered draft', () => {
    for (const value of ['{', '{}', JSON.stringify([{ key: 'x', memberUserId: 1 }])]) {
      const formData = new FormData()
      formData.set('contributorAssignmentsDraft', value)
      expect(readContributorDraftSubmission(formData)).toEqual({ error: 'invalid-draft' })
    }
  })
})

describe('WorkItemContributorsEditor', () => {
  test('lists contributors separately and marks the owner when they also contribute', () => {
    const markup = renderToStaticMarkup(
      <WorkItemContributorsEditor
        assignments={assignments}
        jobRoles={jobRoles}
        locale="en"
        memberOptions={[{ id: 'sato@example.com', email: 'sato@example.com', name: 'Sato' }]}
        onSave={async () => undefined}
        ownerUserId="sato@example.com"
      />,
    )
    expect(markup).toContain('Contributors')
    expect(markup).toContain('Sato')
    expect(markup).toContain('Owner')
    expect(markup).toContain('Undecided (planned by job role)')
    expect(markup).toContain('Writer')
    expect(markup).toContain('5.5 hours in total')
    expect(markup).toContain('Edit contributors')
  })

  test('hides editing for read-only Work Items and explains an empty list', () => {
    const markup = renderToStaticMarkup(
      <WorkItemContributorsEditor assignments={undefined} jobRoles={[]} locale="ja" memberOptions={[]} ownerUserId="sato@example.com" />,
    )
    expect(markup).toContain('Contributor はまだいません。')
    expect(markup).not.toContain('Contributor を編集')
  })
})

describe('job role configuration', () => {
  test('renders saved roles without a remove action and new roles with one', () => {
    const markup = renderToStaticMarkup(
      <JobRolesConfigurationSection
        configuration={{ ...baseConfiguration, jobRoles }}
        locale="en"
        onChange={() => undefined}
        savedJobRoleIds={new Set(['designer'])}
      />,
    )
    expect(markup).toContain('value="Designer"')
    expect(markup).toContain('value="Writer"')
    expect(markup.match(/>Remove</gu)).toHaveLength(1)
    // Repeated row controls are named after their role.
    expect(markup).toContain('aria-label="Archived: Designer"')
    expect(markup).toContain('aria-label="Archived: Writer"')
    expect(markup).toContain('aria-label="Remove: Writer"')
  })

  test('trims names and drops a false archived flag when saving', () => {
    expect(normalizeWorkItemConfigurationForSave({
      ...baseConfiguration,
      jobRoles: [{ id: 'qa', name: '  QA ', archived: false }, { id: 'legacy', name: 'Legacy', archived: true }],
    }).jobRoles).toEqual([{ id: 'qa', name: 'QA' }, { id: 'legacy', name: 'Legacy', archived: true }])
  })
})

describe('contributor options', () => {
  test('label members with their email so shared names stay distinguishable', () => {
    expect(formatContributorMemberLabel({ name: 'Sato', email: 'sato@example.com' })).toBe('Sato (sato@example.com)')
    expect(formatContributorMemberLabel({ email: 'anon@example.com' })).toBe('anon@example.com')
  })

  test('offer every active non-guest Workspace member, not only Project members', () => {
    const member = (email: string, role: WorkspaceMember['role'], status: WorkspaceMember['status'] = 'active'): WorkspaceMember => ({
      id: email, memberKey: email, email, role, status, version: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    })
    expect(resolveWorkItemContributorOptions([
      member('owner@example.com', 'owner'),
      member('outside-project@example.com', 'member'),
      member('guest@example.com', 'guest'),
      member('former@example.com', 'member', 'deactivated'),
    ]).map((option) => option.id)).toEqual(['owner@example.com', 'outside-project@example.com'])
  })
})
