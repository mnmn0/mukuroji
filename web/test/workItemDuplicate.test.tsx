import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createDefaultDueDateWorkItemSchedule } from '@mukuroji/contracts'
import { teamIssueFixtures } from '../src/issues/fixtures'
import { createWorkItemDuplicateDraft } from '../src/issues/model/workItemDuplicate'
import { CreateIssuePanel } from '../src/issues/ui/CreateTeamIssuePanel'
import type { ProjectMember } from '../src/projects/api'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import { createTranslator } from '../src/shared/i18n/i18n'

const [sourceFixture] = teamIssueFixtures
if (!sourceFixture) throw new Error('Expected a Team Issue fixture.')

/** Source Work Item with a contributor plan, acceptance criteria, and custom fields. */
const source = {
  ...sourceFixture,
  description: '元の説明',
  priority: 'low' as const,
  schedule: createDefaultDueDateWorkItemSchedule('2026-12-24'),
  customFieldValues: { 'story-points': 5 },
  contributorAssignments: [
    {
      assignmentId: 'assignment-1',
      memberUserId: 'suzuki@example.com',
      jobRoleId: 'reviewer',
      plannedEffortMinutes: 120,
      status: 'in-progress' as const,
    },
  ],
}

/** Assignee choices that include the source owner. */
const assigneeOptions: ProjectMember[] = [
  {
    id: 'suzuki@example.com',
    email: 'suzuki@example.com',
    role: 'member',
    updatedAt: '2026-06-08T00:00:00.000Z',
    workspaceStatus: 'active',
  },
  {
    id: 'sato@example.com',
    email: 'sato@example.com',
    role: 'member',
    updatedAt: '2026-06-08T00:00:00.000Z',
    workspaceStatus: 'active',
  },
]

describe('Work Item duplicate draft', () => {
  test('copies editable values and resets the contributor plan as new assignments', () => {
    const draft = createWorkItemDuplicateDraft(source)

    expect(draft).toEqual({
      sourceWorkItemId: source.id,
      title: source.title,
      description: '元の説明',
      workItemTypeId: 'default',
      assignedProjectId: 'refero',
      assigneeUserId: 'sato@example.com',
      priority: 'low',
      dueDate: '2026-12-24',
      customFieldValues: { 'story-points': 5 },
      contributorAssignments: [
        { memberUserId: 'suzuki@example.com', jobRoleId: 'reviewer', plannedEffortMinutes: 120 },
      ],
    })
  })

  test('leaves the due date empty for an unscheduled source', () => {
    const draft = createWorkItemDuplicateDraft({
      ...source,
      schedule: { mode: 'unscheduled' },
      contributorAssignments: undefined,
    })

    expect(draft.dueDate).toBe('')
    expect(draft.contributorAssignments).toEqual([])
  })

  test('starts the create panel from the copied values before anything is saved', () => {
    const t = createTranslator('ja')
    const markup = renderToStaticMarkup(
      <CreateIssuePanel
        assigneeOptions={assigneeOptions}
        canCreateUnassignedIssue
        duplicateDraft={createWorkItemDuplicateDraft(source)}
        locale="ja"
        onCancel={() => undefined}
        onSubmit={async () => undefined}
        projects={projectDirectoryFixtures[0]?.projects ?? []}
        t={t}
        workspaceMembers={[]}
      />,
    )

    expect(markup).toContain('data-testid="create-issue-duplicate-note"')
    expect(markup).toContain(`value="${source.title}"`)
    expect(markup).toContain('元の説明')
    expect(markup).toContain('value="2026-12-24"')
    expect(markup).toMatch(/<option value="refero" selected="">/)
    expect(markup).toMatch(/<option value="sato@example.com" selected="">/)
    expect(markup).toMatch(/<option value="low" selected="">/)
    expect(markup).toContain('Contributor の計画 1 件を引き継ぐ')
  })
})
