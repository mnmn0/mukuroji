import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AUTOMATION_SCHEMA_VERSION,
  createDefaultDueDateWorkItemSchedule,
  createDefaultUnscheduledWorkItemSchedule,
  type AutomationTemplate,
} from '@mukuroji/contracts'
import { teamIssueFixtures } from '../src/issues/fixtures'
import {
  createWorkItemDuplicateDraft,
  createWorkItemTemplateDraft,
  listWorkItemTemplatesForTeam,
  type WorkItemTemplate,
} from '../src/issues/model/workItemDuplicate'
import { CreateIssuePanel } from '../src/issues/ui/CreateTeamIssuePanel'
import { CreateTaskPanel } from '../src/tasks/ui/CreateTaskPanel'
import { taskViewStoryProjectMembers } from '../src/tasks/ui/TaskView.stories.fixtures'
import { mergeTaskActionContextMenuRows } from '../src/task-views/model/taskActionContextMenu'
import { teamWorkItemConfigurationFixture } from '../src/work-items/fixtures'
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
      acceptanceCriteria: [],
    })
  })

  test('copies acceptance criteria texts so the copy starts with them unmet', () => {
    const draft = createWorkItemDuplicateDraft({
      ...source,
      acceptanceCriteria: [
        { id: 'a'.repeat(32), text: 'テストが通る', satisfied: true },
        { id: 'b'.repeat(32), text: '手順書を更新する', satisfied: false },
      ],
    })

    expect(draft.acceptanceCriteria).toEqual(['テストが通る', '手順書を更新する'])
    const markup = renderToStaticMarkup(
      <CreateIssuePanel
        assigneeOptions={assigneeOptions}
        canCreateUnassignedIssue
        duplicateDraft={draft}
        locale="ja"
        onCancel={() => undefined}
        onSubmit={async () => undefined}
        projects={projectDirectoryFixtures[0]?.projects ?? []}
        t={createTranslator('ja')}
        workspaceMembers={[]}
      />,
    )
    expect(markup.match(/data-testid="work-item-acceptance-criterion-row"/g)).toHaveLength(2)
    expect(markup).toContain('テストが通る')
    expect(markup).toContain('手順書を更新する')
    expect(markup).toContain('&quot;satisfied&quot;:false')
    expect(markup).not.toContain('&quot;satisfied&quot;:true')
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

  test('starts the Project task panel in detailed mode from the copied values', () => {
    const t = createTranslator('ja')
    const draft = createWorkItemDuplicateDraft({
      ...source,
      customFieldValues: { 'customer-impact': '元の影響' },
    })
    const markup = renderToStaticMarkup(
      <CreateTaskPanel
        assigneeOptions={taskViewStoryProjectMembers}
        configuration={teamWorkItemConfigurationFixture}
        context={{
          assigneeUserId: source.assigneeUserId,
          duplicate: draft,
          projectId: 'refero',
          schedule: source.schedule,
          source: 'duplicate',
          teamId: source.teamId,
          workItemTypeId: draft.workItemTypeId,
        }}
        isAssigneeOptionsLoading={false}
        isSubmitting={false}
        locale="ja"
        projectId="refero"
        t={t}
        workspaceMembers={[]}
        onCancel={() => undefined}
        onSubmit={async () => undefined}
      />,
    )

    expect(markup).toContain('data-testid="create-task-duplicate-note"')
    expect(markup).toContain(`value="${source.title}"`)
    expect(markup).toContain('元の説明')
    expect(markup).toContain('元の影響')
    expect(markup).toContain('value="2026-12-24"')
    expect(markup).toMatch(/<option value="sato@example.com" selected="">/)
    expect(markup).toMatch(/<option value="low" selected="">/)
    expect(markup).toContain('Contributor の計画 1 件を引き継ぐ')
    expect(markup).not.toContain('作業中の列・日付・担当者を引き継いでいます。')
  })
})

test('keeps a Project duplicate in detailed mode and asks for an owner who is no longer a member', () => {
  const t = createTranslator('ja')
  const draft = createWorkItemDuplicateDraft({ ...source, schedule: { mode: 'unscheduled' } })
  const markup = renderToStaticMarkup(
    <CreateTaskPanel
      assigneeOptions={taskViewStoryProjectMembers.filter((member) => member.id !== source.assigneeUserId)}
      configuration={teamWorkItemConfigurationFixture}
      context={{
        assigneeUserId: source.assigneeUserId,
        duplicate: draft,
        projectId: 'refero',
        schedule: { mode: 'unscheduled' },
        source: 'duplicate',
        teamId: source.teamId,
        workItemTypeId: draft.workItemTypeId,
      }}
      initialMode="quick"
      isAssigneeOptionsLoading={false}
      isSubmitting={false}
      locale="ja"
      projectId="refero"
      t={t}
      workspaceMembers={[]}
      onCancel={() => undefined}
      onSubmit={async () => undefined}
    />,
  )

  expect(markup).not.toContain('クイック登録')
  expect(markup).toContain('name="description"')
  expect(markup).toContain('引き継いだ担当者は現在の候補にいません。')
})

describe('Task action menu extra actions', () => {
  const registryRows = [
    { destructive: false, id: 'open', label: 'Open', separatorBefore: false },
    { destructive: false, id: 'edit', label: 'Edit', separatorBefore: false },
    { destructive: false, id: 'move', label: 'Move', separatorBefore: true },
    { destructive: true, id: 'archive', label: 'Archive', separatorBefore: true },
  ] as const

  test('places Duplicate after Open and Edit, before the Move section', () => {
    const rows = mergeTaskActionContextMenuRows(registryRows, [
      { id: 'duplicate', label: 'Duplicate', onSelect: () => undefined },
    ])

    expect(rows.map((row) => `${row.source}:${row.id}`)).toEqual([
      'registry:open',
      'registry:edit',
      'extra:duplicate',
      'registry:move',
      'registry:archive',
    ])
  })

  test('appends extra actions when the menu has a single group', () => {
    const rows = mergeTaskActionContextMenuRows(registryRows.slice(0, 2), [
      { disabledReason: 'No access', id: 'duplicate', label: 'Duplicate', onSelect: () => undefined },
    ])

    expect(rows.at(-1)).toMatchObject({ disabledReason: 'No access', id: 'duplicate', source: 'extra' })
  })

  test('keeps registry rows unchanged without extra actions', () => {
    expect(mergeTaskActionContextMenuRows(registryRows).map((row) => row.id)).toEqual([
      'open',
      'edit',
      'move',
      'archive',
    ])
  })
})

/**
 * Builds a Work Item template.
 *
 * @param overrides - Template fields replacing the defaults.
 * @param payload - Payload fields replacing the defaults.
 * @returns The template.
 */
function workItemTemplate(
  overrides: Partial<Pick<WorkItemTemplate, 'id' | 'name' | 'enabled'>> = {},
  payload: Partial<WorkItemTemplate['payload']> = {},
): WorkItemTemplate {
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'release-check',
    workspaceId: 'workspace-1',
    kind: 'work-item',
    name: 'リリース確認',
    enabled: true,
    version: 2,
    revision: 2,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
    payload: {
      title: 'リリースを確認する',
      description: 'リリース前の確認です。',
      priority: 'high',
      customFieldValues: { 'story-points': 3, nested: { not: 'a field value' } },
      acceptanceCriteria: ['テストが通る', '手順書を更新する'],
      schedule: createDefaultDueDateWorkItemSchedule('2025-01-31'),
      ...payload,
    },
  }
}

describe('Work Item template draft', () => {
  test('offers enabled Work Item templates of the Team by name', () => {
    const projectTemplate: AutomationTemplate = {
      ...workItemTemplate({ id: 'project' }),
      kind: 'project',
      payload: { name: 'Project' },
    }
    const templates = listWorkItemTemplatesForTeam([
      workItemTemplate({ id: 'z', name: 'Z' }),
      workItemTemplate({ id: 'a', name: 'A' }),
      workItemTemplate({ id: 'disabled', enabled: false }),
      workItemTemplate({ id: 'other-team' }, { teamId: 'other-team' }),
      workItemTemplate({ id: 'own-team' }, { teamId: 'core-team' }),
      projectTemplate,
    ], 'core-team')

    expect(templates.map((template) => template.id)).toEqual(['a', 'z', 'own-team'])
  })

  test('fills the draft from the template but keeps the form date and leaves odd values out', () => {
    expect(createWorkItemTemplateDraft(workItemTemplate())).toEqual({
      sourceWorkItemId: 'template:release-check:2',
      sourceTemplate: { id: 'release-check', name: 'リリース確認' },
      title: 'リリースを確認する',
      description: 'リリース前の確認です。',
      assigneeUserId: '',
      priority: 'high',
      customFieldValues: { 'story-points': 3 },
      contributorAssignments: [],
      acceptanceCriteria: ['テストが通る', '手順書を更新する'],
    })
  })

  test('starts the create panel from the picked template', () => {
    const t = createTranslator('ja')
    const template = workItemTemplate({}, { schedule: createDefaultUnscheduledWorkItemSchedule() })
    const markup = renderToStaticMarkup(
      <CreateIssuePanel
        assigneeOptions={assigneeOptions}
        canCreateUnassignedIssue
        duplicateDraft={createWorkItemTemplateDraft(template)}
        locale="ja"
        onApplyTemplate={() => undefined}
        onCancel={() => undefined}
        onSubmit={async () => undefined}
        projects={projectDirectoryFixtures[0]?.projects ?? []}
        t={t}
        templates={[template]}
        workspaceMembers={[]}
      />,
    )

    expect(markup).toContain('data-testid="create-issue-template"')
    expect(markup).toMatch(/<option value="release-check" selected="">/)
    expect(markup).toContain('テンプレート「リリース確認」の内容を下書きに入れました。')
    expect(markup).toContain('value="リリースを確認する"')
    expect(markup).toMatch(/<option value="high" selected="">/)
    expect(markup.match(/data-testid="work-item-acceptance-criterion-row"/g)).toHaveLength(2)
    expect(markup).not.toContain('value="2025-01-31"')
  })

  test('hides the template picker for a duplicate and when no template is offered', () => {
    const t = createTranslator('ja')
    const props = {
      assigneeOptions,
      canCreateUnassignedIssue: true,
      locale: 'ja' as const,
      onApplyTemplate: () => undefined,
      onCancel: () => undefined,
      onSubmit: async () => undefined,
      projects: projectDirectoryFixtures[0]?.projects ?? [],
      t,
      workspaceMembers: [],
    }

    expect(renderToStaticMarkup(
      <CreateIssuePanel {...props} duplicateDraft={createWorkItemDuplicateDraft(source)} templates={[workItemTemplate()]} />,
    )).not.toContain('data-testid="create-issue-template"')
    expect(renderToStaticMarkup(<CreateIssuePanel {...props} templates={[]} />))
      .not.toContain('data-testid="create-issue-template"')
    expect(renderToStaticMarkup(<CreateIssuePanel {...props} templateLoadFailed templates={[]} />))
      .toContain('テンプレートを読み込めませんでした')
  })
})
