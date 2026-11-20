import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_WORK_ITEM_TYPE, createDefaultUnscheduledWorkItemSchedule } from '@mukuroji/contracts'
import { createTranslator } from '../src/shared/i18n/i18n'
import { referoTaskFixtures } from '../src/tasks/fixtures'
import { createTaskHandoffBrief } from '../src/work-items/model/taskHandoff'
import { TaskHandoffPanel } from '../src/work-items/ui/TaskHandoffPanel'
import { TaskDetailPane, type TaskDetailPaneProps } from '../src/tasks/ui/TaskDetailPane'
import { IssueDetailPane } from '../src/issues/ui/TeamIssueDetailPane'
import { teamWorkItemConfigurationFixture } from '../src/work-items/fixtures'

const t = createTranslator('en')
const task = {
  ...referoTaskFixtures[0],
  description: 'Implement the keyboard flow and verify narrow layouts.',
  customFieldValues: { internal: 'hidden-custom-context' },
  relationIds: ['blockedBy:restricted-target'],
}

/** Renders the selected task detail with safe, transport-free fixture inputs. */
function renderDetail(overrides: Partial<TaskDetailPaneProps> = {}) {
  return renderToStaticMarkup(<TaskDetailPane
    assigneeOptions={[]}
    detail={{ issue: task, activity: [] }}
    isLoading={false}
    isRelationCandidatesLoading={false}
    locale="en"
    projects={[]}
    relationCandidates={[]}
    t={t}
    task={task}
    workspaceMembers={[]}
    {...overrides}
  />)
}

describe('task handoff brief', () => {
  test('provides canonical identity and fresh-read guidance without exporting unrelated context', () => {
    const brief = createTaskHandoffBrief({ task, includeDescription: true, t })
    expect(brief).toContain('Task ID: wireframe')
    expect(brief).toContain('Team ID: core-team')
    expect(brief).toContain('Assignee member ID: sato@example.com')
    expect(brief).toContain('Observed revision: 1')
    expect(brief).toContain('Workflow status ID: in-progress')
    expect(brief).toContain('get_configuration, get_task, and list_progress')
    expect(brief).toContain('explicit handoff')
    expect(brief).toContain('Begin implementation only after success')
    expect(brief).toContain(task.description)
    expect(brief).not.toContain('hidden-custom-context')
    expect(brief).not.toContain('restricted-target')
  })

  test('encodes task identity in an application path and does not accept external destinations', () => {
    const brief = createTaskHandoffBrief({ task: { ...task, teamId: 'team/a', id: 'task?x=1#y' }, includeDescription: true, t })
    expect(brief).toContain('Task path in mukuroji: /teams/team%2Fa/issues?issueId=task%3Fx%3D1%23y')
    expect(brief).not.toContain('https://')
  })

  test('pairs the configured status label with the unchanged agent command status ID', () => {
    const configuration = {
      ...teamWorkItemConfigurationFixture,
      workflow: {
        ...teamWorkItemConfigurationFixture.workflow,
        statuses: teamWorkItemConfigurationFixture.workflow.statuses.map((status) => status.id === 'active'
          ? { ...status, name: 'Implementation review' }
          : status),
      },
    }
    const brief = createTaskHandoffBrief({ task: { ...task, workflowStatusId: 'active' }, configuration, includeDescription: true, t })
    expect(brief).toContain('Current status: Implementation review')
    expect(brief).toContain('Workflow status ID: active')
  })

  test('omits hidden descriptions and identifies empty saved fields', () => {
    const brief = createTaskHandoffBrief({
      task: { ...task, assignedProjectId: undefined, assigneeUserId: '', assigneeName: undefined, dueDate: '', schedule: createDefaultUnscheduledWorkItemSchedule() },
      includeDescription: false,
      t,
    })
    expect(brief).not.toContain(task.description)
    expect(brief).toContain('not visible on this screen is not included')
    expect(brief).toContain('Project ID: Not set')
    expect(brief).toContain('Assignee member ID: Not set')
    expect(brief).toContain('Due date: Not set')
  })

  test('previews the same selectable brief that the copy control exports', () => {
    const html = renderToStaticMarkup(<TaskHandoffPanel includeDescription task={task} t={t} />)
    expect(html).toContain('readOnly=""')
    expect(html).toContain('Select all text')
    expect(html).toContain('Copying leaves the assignee and task state unchanged.')
    expect(html).toContain('Observed revision: 1')
    expect(html).not.toContain('hidden-custom-context')
  })

  test('withholds the control before matching detail loads or after the detail is retained', () => {
    expect(renderDetail()).toContain('data-testid="task-handoff-panel"')
    expect(renderDetail({ detail: undefined })).not.toContain('data-testid="task-handoff-panel"')
    expect(renderDetail({ detail: { issue: { ...task, teamId: 'other-team' }, activity: [] } })).not.toContain('data-testid="task-handoff-panel"')
    expect(renderDetail({ isRetainedDetail: true })).not.toContain('data-testid="task-handoff-panel"')
  })

  test('respects a Work Item layout that does not expose the description', () => {
    const configuration = {
      ...teamWorkItemConfigurationFixture,
      workItemTypes: [{ ...DEFAULT_WORK_ITEM_TYPE, detailSections: DEFAULT_WORK_ITEM_TYPE.detailSections.filter((section) => section !== 'description') }],
    }
    const html = renderDetail({ configuration })
    expect(html).toContain('data-testid="task-handoff-panel"')
    expect(html).not.toContain(task.description)
  })

  test('lists acceptance criteria and says why an agent should not start yet', () => {
    const brief = createTaskHandoffBrief({ task, includeDescription: true, t })
    expect(brief).toContain('## Acceptance criteria')
    expect(brief).toContain('No acceptance criteria are saved.')
    expect(brief).toContain('No. Do not start until a human resolves the following:')
    expect(brief).toContain('so completion cannot be judged')
    expect(brief).toContain('already in progress')
    expect(brief).toContain('1 blockedBy relation(s) are recorded')
    expect(brief).not.toContain('restricted-target')
  })

  test('marks a criteria-backed, unblocked, unstarted task as ready to start', () => {
    const brief = createTaskHandoffBrief({
      task: {
        ...task,
        statusCategory: 'unstarted',
        relationIds: ['related:other'],
        acceptanceCriteria: [
          { id: 'a'.repeat(32), text: 'Keyboard flow works\non narrow layouts', satisfied: false },
          { id: 'b'.repeat(32), text: 'Docs updated', satisfied: true },
        ],
      },
      includeDescription: true,
      t,
    })
    expect(brief).toContain('- [ ] Keyboard flow works on narrow layouts')
    expect(brief).toContain('- [x] Docs updated')
    expect(brief).toContain('Yes. Re-read the task with get_task')
    expect(brief).not.toContain('blockedBy relation')
  })

  test('offers the same handoff for a Team Work Item without a Project', () => {
    const html = renderToStaticMarkup(<IssueDetailPane
      assigneeOptions={[]}
      canAssignUnassigned={false}
      canManageExternalLinks={false}
      isAiSummaryOperationPending={false}
      isRelationsLoading={false}
      issue={{ ...task, assignedProjectId: undefined }}
      locale="en"
      projects={[]}
      relationCandidates={[]}
      relations={[]}
      t={t}
      workspaceMembers={[]}
    />)
    expect(html).toContain('data-testid="task-handoff-panel"')
    expect(html).toContain('Project ID: Not set')
  })

  test('names the active run and blocks a start while another agent holds the task', () => {
    const brief = createTaskHandoffBrief({
      task: { ...task, statusCategory: 'started', relationIds: [], acceptanceCriteria: [{ id: 'a'.repeat(32), text: 'Done', satisfied: false }] },
      includeDescription: true,
      agentRuns: {
        status: 'loaded',
        value: { active: { runId: 'run_1', agentName: 'codex\nbot', runtime: 'codex', startedAt: '2026-11-20T01:00:00.000Z', stalled: false } },
      },
      t,
    })
    expect(brief).toContain('## Agent Run')
    expect(brief).toContain('Active run: Running')
    expect(brief).toContain('Run ID: run_1')
    expect(brief).toContain('Agent: codex bot (codex)')
    expect(brief).toContain('Agent codex bot holds an active run (run_1).')
    expect(brief).not.toContain('confirmed Agent Run state')
  })

  test('tells the agent not to take over a stalled run without a handoff', () => {
    const brief = createTaskHandoffBrief({
      task,
      includeDescription: true,
      agentRuns: {
        status: 'loaded',
        value: { active: { runId: 'run_2', agentName: 'claude', runtime: 'claude-code', startedAt: '2026-11-20T01:00:00.000Z', stalled: true } },
      },
      t,
    })
    expect(brief).toContain('Active run: Stalled (lease expired)')
    expect(brief).toContain('The active run of agent claude (run_2) is stalled.')
  })

  test('keeps a ready verdict when no run holds the task and lists linked Documents without content', () => {
    const brief = createTaskHandoffBrief({
      task: { ...task, statusCategory: 'unstarted', relationIds: [], acceptanceCriteria: [{ id: 'a'.repeat(32), text: 'Done', satisfied: false }] },
      includeDescription: true,
      agentRuns: { status: 'loaded', value: {} },
      documents: {
        status: 'loaded',
        value: { items: [{ documentId: 'doc/1', documentTitle: 'Design\nnotes' }], hasMore: true },
      },
      t,
    })
    expect(brief).toContain('Yes. Re-read the task with get_task')
    expect(brief).toContain('No agent holds an active run on this task.')
    expect(brief).toContain('## Related Documents')
    expect(brief).toContain('- Design notes (Document ID: doc/1, path: /documents/doc%2F1)')
    expect(brief).toContain('More linked Documents exist.')
    expect(brief).toContain('Document content is not part of this brief.')
  })

  test('says when runs and Documents were not read instead of implying there are none', () => {
    const unread = createTaskHandoffBrief({ task, includeDescription: true, t })
    expect(unread).toContain('This brief does not include a confirmed Agent Run state.')
    expect(unread).toContain('Agent Runs could not be read on this screen.')
    expect(unread).toContain('Related Documents could not be read on this screen.')
    expect(unread).not.toContain('No agent holds an active run')
    const loading = createTaskHandoffBrief({
      task,
      includeDescription: true,
      agentRuns: { status: 'loading' },
      documents: { status: 'loading' },
      t,
    })
    expect(loading).toContain('Agent Runs were still loading')
    expect(loading).toContain('Related Documents were still loading')
    const empty = createTaskHandoffBrief({
      task,
      includeDescription: true,
      documents: { status: 'loaded', value: { items: [], hasMore: false } },
      t,
    })
    expect(empty).toContain('No Documents you can view are linked to this task.')
  })

  test('uses Japanese labels for the new sections', () => {
    const brief = createTaskHandoffBrief({
      task,
      includeDescription: true,
      agentRuns: { status: 'loaded', value: {} },
      documents: { status: 'loaded', value: { items: [], hasMore: false } },
      t: createTranslator('ja'),
    })
    expect(brief).toContain('## Agent Run')
    expect(brief).toContain('## 関連 Document')
  })
})
