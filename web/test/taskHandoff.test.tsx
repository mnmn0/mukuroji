import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_WORK_ITEM_TYPE, createDefaultUnscheduledWorkItemSchedule } from '@mukuroji/contracts'
import { createTranslator } from '../src/shared/i18n/i18n'
import { referoTaskFixtures } from '../src/tasks/fixtures'
import { createTaskHandoffBrief } from '../src/tasks/model/taskHandoff'
import { TaskHandoffPanel } from '../src/tasks/ui/TaskHandoffPanel'
import { TaskDetailPane, type TaskDetailPaneProps } from '../src/tasks/ui/TaskDetailPane'
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
})
