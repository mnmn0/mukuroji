import { describe, expect, test } from 'bun:test'
import type {
  PlanningSnapshot,
  WorkItemScheduleChangePreview,
  WorkItemScheduleDependency,
} from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTranslator } from '../src/shared/i18n/i18n'
import { collaborationWorkspaceMemberFixtures } from '../src/issues/fixtures'
import {
  teamWorkItemConfigurationFixture,
  workItemCustomFieldValueFixture,
} from '../src/work-items/fixtures'
import { createTaskKey } from '../src/tasks/model/taskView'
import { createDefaultDueDateTaskSchedule } from '../src/tasks/model/taskSchedule'
import { CreateTaskPanel } from '../src/tasks/ui/CreateTaskPanel'
import { TaskBoardView } from '../src/tasks/ui/TaskBoardView'
import { TaskCalendarView } from '../src/tasks/ui/TaskCalendarView'
import { TaskDetailPane } from '../src/tasks/ui/TaskDetailPane'
import { TaskFileView } from '../src/tasks/ui/TaskFileView'
import { TaskGanttView } from '../src/tasks/ui/TaskGanttView'
import { TaskPermissionsView } from '../src/tasks/ui/TaskPermissionsView'
import { TaskSchedulePreviewMetadata } from '../src/tasks/ui/TaskSchedulePreviewMetadata'
import { TaskTableView } from '../src/tasks/ui/TaskTableView'
import { TaskStatusBadge } from '../src/tasks/ui/TaskViewPrimitives'
import type { TaskViewPresentationSettings } from '../src/task-views/model/taskViewPresentation'
import { createTaskViewItemKey } from '../src/task-views/model/taskViewSelection'
import {
  createBuiltInTaskViewDefinition,
  taskViewDefinitionToPresentationSettings,
} from '../src/task-views/model/taskViewSurfaceState'
import { MyTasksWorkspaceView } from '../src/workspace/ui/MyTasksWorkspaceView'
import {
  taskViewStoryConfigurationsByTeam,
  taskViewStoryProjectFiles,
  taskViewStoryProjectMembers,
  taskViewStoryProjectUsers,
  taskViewStoryPlanningSnapshot,
  taskViewStorySelectedIssueDetail,
  taskViewStoryStatusColumns,
  taskViewStoryTasks,
} from '../src/tasks/ui/TaskView.stories.fixtures'

const t = createTranslator('ja')
const personLabels = {
  'sato@example.com': '佐藤 花子',
  'suzuki@example.com': '鈴木 大輔',
}

describe('independent task views', () => {
  test('shows legacy affected Project IDs without inventing Team-qualified links', () => {
    const schedule = createDefaultDueDateTaskSchedule('2026-08-08')
    const preview = {
      affectedMilestoneIds: [],
      affectedProjectIds: ['shared-project'],
      affectedProjects: [],
      conflicts: [],
      evaluatedRevisions: [{
        expectedRevision: 4,
        teamId: 'core-team',
        workItemId: 'wireframe',
      }],
      expectedRevision: 4,
      impacts: [{
        after: schedule,
        before: schedule,
        dateDeltaDays: 0,
        expectedRevision: 4,
        kind: 'direct',
        teamId: 'core-team',
        workItemId: 'wireframe',
      }],
      planningRevision: 12,
      relationGraphRevision: 8,
      requiresConfirmation: true,
      warnings: [],
    } satisfies WorkItemScheduleChangePreview

    const html = renderToStaticMarkup(<TaskSchedulePreviewMetadata preview={preview} t={t} />)

    expect(html).toContain('shared-project')
    expect(html).not.toContain('core-team / shared-project')
  })

  test('preserves table row, selection, count, empty, and error contracts', () => {
    const selectedTask = taskViewStoryTasks[0]
    const selectedTaskKey = createTaskKey(selectedTask)
    const html = renderToStaticMarkup(
      <TaskTableView
        bulkProjectOptions={[{ id: 'refero', label: 'Refero' }]}
        bulkWorkspaceId=""
        configuration={teamWorkItemConfigurationFixture}
        configurationsByTeam={taskViewStoryConfigurationsByTeam}
        locale="ja"
        personLabels={personLabels}
        projectId="refero"
        selectedBulkItems={[]}
        selectedDetailTaskKey={selectedTaskKey}
        selectedTaskKeys={[selectedTaskKey]}
        t={t}
        tasks={taskViewStoryTasks}
        visibleBulkItems={[]}
        onBulkOperationComplete={() => undefined}
        onCreateTaskOpen={() => undefined}
        onSelectTask={() => undefined}
        onTaskActionMenuOpen={() => undefined}
        onTaskSelectionChange={() => undefined}
        onVisibleTaskSelectionChange={() => undefined}
      />,
    )

    expect(html).toContain('data-testid="task-row-wireframe"')
    expect(html).toContain('data-task-action="open"')
    expect(html).toContain('data-selected="true"')
    expect(html).toContain('data-testid="tasks-count"')
    expect(html).toContain('4件のタスク')
    expect(html).toContain('data-testid="task-row-add-wireframe"')
    expect(html).toContain('data-testid="task-row-actions-wireframe"')
    expect(html).toContain('aria-label="その他の操作: ワイヤーフレームを確認する"')

    const emptyHtml = renderToStaticMarkup(
      <TaskTableView
        bulkProjectOptions={[]}
        bulkWorkspaceId=""
        configurationsByTeam={{}}
        locale="ja"
        personLabels={{}}
        projectId="refero"
        selectedBulkItems={[]}
        selectedTaskKeys={[]}
        t={t}
        tasks={[]}
        visibleBulkItems={[]}
        onBulkOperationComplete={() => undefined}
        onSelectTask={() => undefined}
        onTaskSelectionChange={() => undefined}
        onVisibleTaskSelectionChange={() => undefined}
      />,
    )
    const errorHtml = renderToStaticMarkup(
      <TaskTableView
        bulkProjectOptions={[]}
        bulkWorkspaceId=""
        configurationsByTeam={{}}
        locale="ja"
        personLabels={{}}
        projectId="refero"
        selectedBulkItems={[]}
        selectedTaskKeys={[]}
        t={t}
        taskErrorMessage="Lambda returned 500."
        tasks={[]}
        visibleBulkItems={[]}
        onBulkOperationComplete={() => undefined}
        onSelectTask={() => undefined}
        onTaskSelectionChange={() => undefined}
        onVisibleTaskSelectionChange={() => undefined}
      />,
    )

    expect(emptyHtml).toContain('data-testid="tasks-empty"')
    expect(errorHtml).toContain('data-testid="tasks-error"')
    expect(errorHtml).toContain('role="alert"')
  })

  test('preserves team-scoped board columns and the unavailable-configuration column', () => {
    const html = renderToStaticMarkup(
      <TaskBoardView
        configuration={teamWorkItemConfigurationFixture}
        configurationFailedTeamIds={[]}
        configurationsByTeam={taskViewStoryConfigurationsByTeam}
        locale="ja"
        personLabels={personLabels}
        selectedDetailTaskKey={createTaskKey(taskViewStoryTasks[0])}
        statusColumns={taskViewStoryStatusColumns}
        t={t}
        tasks={taskViewStoryTasks}
        onSelectTask={() => undefined}
        onTaskActionMenuOpen={() => undefined}
      />,
    )
    const unavailableHtml = renderToStaticMarkup(
      <TaskBoardView
        configurationFailedTeamIds={['core-team']}
        configurationsByTeam={{}}
        locale="ja"
        personLabels={personLabels}
        statusColumns={[]}
        t={t}
        tasks={[taskViewStoryTasks[0]]}
        onSelectTask={() => undefined}
        onTaskActionMenuOpen={() => undefined}
      />,
    )

    expect(html).toContain('aria-label="ボードビュー"')
    expect(html).toContain('data-testid="project-task-column-core-team-active"')
    expect(html).toContain('ワイヤーフレームを確認する')
    expect(html).toContain('data-testid="task-card-actions-wireframe"')
    expect(unavailableHtml).toContain(
      'data-testid="project-task-configuration-unavailable-column"',
    )
    expect(unavailableHtml).toContain('data-testid="task-card-actions-wireframe"')
  })

  test('renders task-view columns, density, wrapping, grouping, and subgrouping', () => {
    const presentation = {
      columns: [
        { field: 'title', pin: 'start', width: 340 },
        { field: 'assignee', width: 180 },
        { field: 'priority', pin: 'end', width: 140 },
      ],
      density: 'compact',
      display: {
        showArchived: false,
        showAssigneeAvatars: true,
        showCompleted: true,
        showEmptyGroups: true,
        showSubtasks: true,
        wrapTitles: true,
      },
      groupBy: 'priority',
      groupDirection: 'desc',
      subgroupBy: 'assignee',
      subgroupDirection: 'asc',
    } satisfies TaskViewPresentationSettings
    const tableHtml = renderToStaticMarkup(
      <TaskTableView
        bulkProjectOptions={[]}
        bulkWorkspaceId=""
        configuration={teamWorkItemConfigurationFixture}
        configurationsByTeam={taskViewStoryConfigurationsByTeam}
        locale="ja"
        personLabels={personLabels}
        presentation={presentation}
        projectId="refero"
        selectedBulkItems={[]}
        selectedTaskKeys={[]}
        t={t}
        tasks={taskViewStoryTasks.slice(0, 2)}
        visibleBulkItems={[]}
        onBulkOperationComplete={() => undefined}
        onSelectTask={() => undefined}
        onTaskSelectionChange={() => undefined}
        onVisibleTaskSelectionChange={() => undefined}
      />,
    )
    const boardHtml = renderToStaticMarkup(
      <TaskBoardView
        configuration={teamWorkItemConfigurationFixture}
        configurationFailedTeamIds={[]}
        configurationsByTeam={taskViewStoryConfigurationsByTeam}
        locale="ja"
        personLabels={personLabels}
        presentation={{
          ...presentation,
          columns: [{ field: 'title' }, { field: 'assignee' }],
          density: 'spacious',
          display: { ...presentation.display, showEmptyGroups: false },
          groupBy: 'status',
          subgroupBy: 'priority',
        }}
        statusColumns={taskViewStoryStatusColumns}
        t={t}
        tasks={taskViewStoryTasks.slice(0, 2)}
        onSelectTask={() => undefined}
      />,
    )

    expect(tableHtml).toContain('data-testid="task-table-group"')
    expect(tableHtml).toContain('data-testid="task-table-subgroup"')
    expect(tableHtml).toContain('py-1.5')
    expect(tableHtml).toContain('whitespace-normal break-words')
    expect(tableHtml).toContain('data-column-pin="start"')
    expect(tableHtml).toContain('data-column-pin="end"')
    expect(tableHtml).toContain('width:340px')
    expect(tableHtml).toContain('data-testid="work-item-assignee-avatar"')
    expect(tableHtml).not.toContain('2026-06-03')
    expect(boardHtml).toContain('p-4')
    expect(boardHtml).toContain('高 (1)')
    expect(boardHtml).toContain('data-testid="work-item-assignee-avatar"')
    expect(boardHtml).not.toContain('project-task-column-core-team-ready')
    expect(boardHtml).not.toContain('project-task-column-core-team-done')
    expect(boardHtml).not.toContain('2026-06-03')
  })

  test('preserves built-in custom-field summaries and renders selected custom columns', () => {
    const task = {
      ...taskViewStoryTasks[0],
      customFieldValues: workItemCustomFieldValueFixture,
    }
    const builtInPresentation = taskViewDefinitionToPresentationSettings(
      createBuiltInTaskViewDefinition(
        'project',
        { kind: 'project', projectId: 'refero' },
        'table',
        ['customFields'],
      ),
    )
    /** Renders the same configured task under one presentation variant. */
    const renderTable = (presentation: TaskViewPresentationSettings) => renderToStaticMarkup(
      <TaskTableView
        bulkProjectOptions={[]}
        bulkWorkspaceId=""
        configuration={teamWorkItemConfigurationFixture}
        configurationsByTeam={taskViewStoryConfigurationsByTeam}
        locale="ja"
        personLabels={personLabels}
        presentation={presentation}
        projectId="refero"
        selectedBulkItems={[]}
        selectedTaskKeys={[]}
        t={t}
        tasks={[task]}
        visibleBulkItems={[]}
        onBulkOperationComplete={() => undefined}
        onSelectTask={() => undefined}
        onTaskSelectionChange={() => undefined}
        onVisibleTaskSelectionChange={() => undefined}
      />,
    )

    const builtInHtml = renderTable(builtInPresentation)
    const customColumnHtml = renderTable({
      ...builtInPresentation,
      columns: [{ field: 'title' }, { field: 'custom:risk-level' }],
    })

    expect(builtInHtml).toContain(t('workItems.fields.title'))
    expect(builtInHtml).toContain('Customer impact')
    expect(customColumnHtml).toContain('Risk level')
    expect(customColumnHtml).toContain('Moderate')
  })

  test('applies My Tasks card fields, density, wrapping, and board section grouping', () => {
    const focusedTask = taskViewStoryTasks[0]
    const focusedTaskKey = createTaskViewItemKey(focusedTask.teamId, focusedTask.id)
    const html = renderToStaticMarkup(
      <MyTasksWorkspaceView
        configurationFailedTeamIds={[]}
        configurationsByTeam={taskViewStoryConfigurationsByTeam}
        focusedTaskKey={focusedTaskKey}
        presentation={{
          columns: [
            { field: 'title' },
            { field: 'assignee' },
            { field: 'project' },
            { field: 'team' },
          ],
          density: 'compact',
          display: {
            showArchived: false,
            showAssigneeAvatars: true,
            showCompleted: true,
            showEmptyGroups: false,
            showSubtasks: true,
            wrapTitles: true,
          },
          groupBy: 'status',
          subgroupBy: 'priority',
        }}
        t={t}
        selectedTaskKeys={[focusedTaskKey]}
        tasks={taskViewStoryTasks.slice(0, 2)}
        teams={[{
          id: 'core-team',
          name: 'コアチーム',
          projects: [{ id: 'refero', name: 'Refero' }],
        }]}
      />,
    )

    expect(html).toContain('高 (1)')
    expect(html).toContain('p-2.5')
    expect(html).toContain('whitespace-normal break-words')
    expect(html).toContain('data-testid="work-item-assignee-avatar"')
    expect(html).toContain('data-task-view-focused="true"')
    expect(html).toContain('data-task-view-selected="true"')
    expect(html).toContain(t('tasks.row.selected'))
    expect(html).toContain('Refero')
    expect(html).toContain('コアチーム')
    expect(html).not.toContain('2026-06-03')
    expect(html).not.toContain('my-tasks-column-core-team-ready')
    expect(html).not.toContain('my-tasks-column-core-team-done')
  })

  test('renders My Tasks custom-field summaries and individual saved-view fields', () => {
    const html = renderToStaticMarkup(
      <MyTasksWorkspaceView
        configurationFailedTeamIds={[]}
        configurationsByTeam={taskViewStoryConfigurationsByTeam}
        locale="ja"
        presentation={{
          columns: [
            { field: 'title' },
            { field: 'customFields' },
            { field: 'custom:risk-level' },
          ],
          density: 'comfortable',
          display: {
            showArchived: false,
            showAssigneeAvatars: true,
            showCompleted: true,
            showEmptyGroups: true,
            showSubtasks: true,
            wrapTitles: false,
          },
        }}
        t={t}
        tasks={[{
          ...taskViewStoryTasks[0],
          customFieldValues: workItemCustomFieldValueFixture,
        }]}
        teams={[{
          id: 'core-team',
          name: 'コアチーム',
          projects: [{ id: 'refero', name: 'Refero' }],
        }]}
      />,
    )

    expect(html).toContain('Customer impact')
    expect(html).toContain('Risk level')
    expect(html).toContain('Moderate')
  })

  test('renders a canonical My Tasks card menu and reveals Move status controls', () => {
    const task = taskViewStoryTasks[0]
    const taskKey = createTaskViewItemKey(task.teamId, task.id)
    const html = renderToStaticMarkup(
      <MyTasksWorkspaceView
        configurationFailedTeamIds={[]}
        configurationsByTeam={taskViewStoryConfigurationsByTeam}
        onMoveTaskStatus={async () => undefined}
        onTaskActionMenuOpen={() => undefined}
        presentation={{
          columns: [{ field: 'title' }],
          density: 'comfortable',
          display: {
            showArchived: false,
            showAssigneeAvatars: false,
            showCompleted: true,
            showEmptyGroups: true,
            showSubtasks: true,
            wrapTitles: false,
          },
        }}
        revealedStatusTaskKey={taskKey}
        t={t}
        tasks={[task]}
        teams={[{
          id: 'core-team',
          name: 'コアチーム',
          projects: [{ id: 'refero', name: 'Refero' }],
        }]}
      />,
    )

    expect(html).toContain(`data-task-view-item-key="${taskKey}"`)
    expect(html).toContain('data-testid="my-tasks-card-refero-wireframe-actions"')
    expect(html).toContain('data-testid="my-tasks-card-refero-wireframe-status-select"')
  })

  test('orders the Gantt view by due date and leaves unscheduled tasks last', () => {
    const html = renderToStaticMarkup(
      <TaskGanttView
        configuration={teamWorkItemConfigurationFixture}
        configurationsByTeam={taskViewStoryConfigurationsByTeam}
        onCreateTaskOpen={() => undefined}
        planningSnapshot={taskViewStoryPlanningSnapshot}
        projectId="refero"
        t={t}
        tasks={[...taskViewStoryTasks].reverse()}
      />,
    )

    expect(html).toContain('aria-label="期限順リスト"')
    expect(html).toContain('data-testid="task-gantt-add-wireframe"')
    expect(html).toContain('data-testid="task-gantt-bar-wireframe"')
    expect(html).toContain('data-testid="task-gantt-resize-wireframe"')
    expect(html).toContain('data-testid="task-gantt-dependencies"')
    expect(html).toContain(t('workItems.dependencies.type.start-to-finish'))
    expect(html).toContain('value="milestone"')
    expect(html).toContain('value="unscheduled"')
    expect(html.indexOf('ワイヤーフレームを確認する')).toBeLessThan(
      html.indexOf('ブランドガイドラインを更新する'),
    )
    expect(html.indexOf('SEOリサーチをまとめる')).toBeLessThan(
      html.indexOf('競合調査レポートを完成する'),
    )
  })

  test('distinguishes filtered Project tasks from external dependency endpoints', () => {
    const sourceWorkItem = taskViewStoryPlanningSnapshot.workItems.find((item) =>
      item.id === 'wireframe'
    )
    const sourceDependency = taskViewStoryPlanningSnapshot.workItemDependencies[0]
    if (!sourceWorkItem || !sourceDependency) {
      throw new Error('Expected the Gantt dependency fixture.')
    }
    const externalPredecessor = {
      ...sourceWorkItem,
      id: 'other-project-a',
      projectId: 'other-project',
      title: 'Other project A',
    }
    const externalSuccessor = {
      ...sourceWorkItem,
      id: 'other-project-b',
      projectId: 'other-project',
      title: 'Other project B',
    }
    const unrelatedDependency = {
      ...sourceDependency,
      id: 'other-project-only-dependency',
      predecessor: { teamId: externalPredecessor.teamId, workItemId: externalPredecessor.id },
      successor: { teamId: externalSuccessor.teamId, workItemId: externalSuccessor.id },
    } satisfies WorkItemScheduleDependency
    const snapshot = {
      ...taskViewStoryPlanningSnapshot,
      workItemDependencies: [sourceDependency, unrelatedDependency],
      workItems: [
        ...taskViewStoryPlanningSnapshot.workItems,
        externalPredecessor,
        externalSuccessor,
      ],
    } satisfies PlanningSnapshot
    const html = renderToStaticMarkup(
      <TaskGanttView
        allProjectTasks={taskViewStoryTasks}
        configurationsByTeam={taskViewStoryConfigurationsByTeam}
        planningSnapshot={snapshot}
        t={t}
        tasks={taskViewStoryTasks.slice(0, 1)}
      />,
    )

    expect(html).toContain('task-gantt-dependency-story-wireframe-brand')
    expect(html).not.toContain(t('workItems.dependencies.external'))
    expect(html).not.toContain('task-gantt-external-lane')
    expect(html).not.toContain(unrelatedDependency.id)
    expect(html).toContain(`${t('workItems.dependencies.predecessor')}: `)
    expect(html).toContain(`${t('workItems.dependencies.successor')}: `)
  })

  test('bounds timeline views across the complete ISO planning horizon', () => {
    const earlyTask = {
      ...taskViewStoryTasks[2],
      dueDate: '1000-01-01',
      id: 'early-schedule',
      schedule: createDefaultDueDateTaskSchedule('1000-01-01'),
      title: 'Earliest schedule',
    }
    const lateTask = {
      ...taskViewStoryTasks[2],
      dueDate: '9999-12-31',
      id: 'late-schedule',
      schedule: createDefaultDueDateTaskSchedule('9999-12-31'),
      title: 'Latest schedule',
    }
    const html = renderToStaticMarkup(
      <TaskGanttView
        configurationsByTeam={taskViewStoryConfigurationsByTeam}
        t={t}
        tasks={[earlyTask, lateTask]}
      />,
    )
    const columnHeaderCount = html.match(/role="columnheader"/gu)?.length ?? 0
    const calendarHtml = renderToStaticMarkup(
      <TaskCalendarView t={t} tasks={[earlyTask, lateTask]} />,
    )

    expect(columnHeaderCount).toBeLessThanOrEqual(181)
    expect(html).toContain('1000-01-01')
    expect(html).toContain('9999-12-31')
    expect(calendarHtml).toContain('1000-01-01')
    expect(calendarHtml).toContain('9999-12-31')
    expect(calendarHtml).not.toContain('0999-12-31')
    expect(calendarHtml).not.toContain('+010000')
  })

  test('groups calendar tasks by due date and preserves the unscheduled bucket', () => {
    const html = renderToStaticMarkup(
      <TaskCalendarView t={t} tasks={taskViewStoryTasks} />,
    )

    expect(html).toContain(`aria-label="${t('tasks.view.calendar')}"`)
    expect(html).toContain('2026-06-03')
    expect(html).toContain('data-testid="task-calendar-item-wireframe"')
    expect(html).toContain('data-testid="task-calendar-item-brand-guideline"')
    expect(html).toContain(t('tasks.schedule.dateRange'))
    expect(html).toContain(t('tasks.schedule.milestone'))
    expect(html).toContain('競合調査レポートを完成する')
    expect(html).toContain(t('tasks.calendar.empty'))
  })

  test('renders both project-file and compatibility fallback branches', () => {
    const projectFilesHtml = renderToStaticMarkup(
      <TaskFileView
        configuration={teamWorkItemConfigurationFixture}
        configurationsByTeam={taskViewStoryConfigurationsByTeam}
        currentWorkspaceMemberKey="demo@example.com"
        locale="ja"
        projectFiles={taskViewStoryProjectFiles}
        t={t}
        tasks={taskViewStoryTasks}
        workspaceMembers={collaborationWorkspaceMemberFixtures}
      />,
    )
    const fallbackHtml = renderToStaticMarkup(
      <TaskFileView
        configuration={teamWorkItemConfigurationFixture}
        configurationsByTeam={taskViewStoryConfigurationsByTeam}
        locale="ja"
        t={t}
        tasks={taskViewStoryTasks}
        workspaceMembers={collaborationWorkspaceMemberFixtures}
      />,
    )

    expect(projectFilesHtml).toContain('data-testid="project-files-panel"')
    expect(fallbackHtml).toContain('aria-label="ファイルビュー"')
    expect(fallbackHtml).toContain('ワイヤーフレームを確認する')
  })

  test('adapts the active project to the existing permissions panel', () => {
    const html = renderToStaticMarkup(
      <TaskPermissionsView
        canManageProjectMembers
        isProjectMembersLoading={false}
        isProjectUsersLoading={false}
        isSystemAdmin={false}
        projectId="refero"
        projectMembers={taskViewStoryProjectMembers}
        projectName="Refero"
        projectUserQuery=""
        projectUsers={taskViewStoryProjectUsers}
        t={t}
        onUpdateProjectMember={async () => undefined}
      />,
    )

    expect(html).toContain('data-testid="permissions-view"')
    expect(html).toContain('Refero')
    expect(html).toContain('data-testid="permission-member-row-sato-example-com"')
  })

  test('renders task creation as an independently testable validated form', () => {
    const html = renderToStaticMarkup(
      <CreateTaskPanel
        assigneeOptions={taskViewStoryProjectMembers}
        configuration={teamWorkItemConfigurationFixture}
        isAssigneeOptionsLoading={false}
        isSubmitting={false}
        locale="ja"
        projectId="refero"
        t={t}
        workspaceMembers={collaborationWorkspaceMemberFixtures}
        onCancel={() => undefined}
        onSubmit={async () => undefined}
      />,
    )

    expect(html).toContain('data-testid="create-task-form"')
    expect(html).toContain('name="workflowStatusId"')
    expect(html).toContain('name="custom-field:customer-impact"')
    expect(html).toContain('佐藤 花子 / sato@example.com')
    expect(html).toContain('name="scheduleMode"')
    expect(html).toContain('<option value="unscheduled" selected="">未計画</option>')
    expect(html).not.toContain('name="scheduleDueDate"')
  })

  test('carries view context into quick capture and exposes shared inline editors', () => {
    const quickHtml = renderToStaticMarkup(
      <CreateTaskPanel
        assigneeOptions={taskViewStoryProjectMembers}
        configuration={teamWorkItemConfigurationFixture}
        context={{
          assigneeUserId: 'sato@example.com',
          projectId: 'refero',
          schedule: createDefaultDueDateTaskSchedule('2026-06-12'),
          source: 'calendar',
          teamId: 'core-team',
          workflowStatusId: 'backlog',
        }}
        isAssigneeOptionsLoading={false}
        isSubmitting={false}
        locale="ja"
        projectId="refero"
        t={t}
        workspaceMembers={collaborationWorkspaceMemberFixtures}
        onCancel={() => undefined}
        onSubmit={async () => undefined}
      />,
    )
    const inlineHtml = renderToStaticMarkup(
      <TaskTableView
        assigneeOptions={taskViewStoryProjectMembers}
        bulkProjectOptions={[]}
        bulkWorkspaceId=""
        configuration={teamWorkItemConfigurationFixture}
        configurationsByTeam={taskViewStoryConfigurationsByTeam}
        locale="ja"
        personLabels={personLabels}
        projectId="refero"
        selectedBulkItems={[]}
        selectedTaskKeys={[]}
        t={t}
        tasks={taskViewStoryTasks.slice(0, 1)}
        visibleBulkItems={[]}
        onBulkOperationComplete={() => undefined}
        onSelectTask={() => undefined}
        onCreateTaskOpen={() => undefined}
        onTaskSelectionChange={() => undefined}
        onUpdateTask={async (task) => task}
        onVisibleTaskSelectionChange={() => undefined}
      />,
    )

    expect(quickHtml).toMatch(new RegExp(
      `<button[^>]*aria-pressed="true"[^>]*>${t('tasks.create.quick')}</button>`,
    ))
    expect(quickHtml).toContain('name="title"')
    expect(quickHtml).toContain('name="dueDate"')
    expect(quickHtml).toContain('value="2026-06-12"')
    expect(quickHtml).not.toContain('name="workflowStatusId"')
    expect(inlineHtml).toContain('data-testid="task-inline-title-wireframe"')
    expect(inlineHtml).toContain('data-testid="task-inline-custom-fields-wireframe"')
    expect(inlineHtml).toContain('data-testid="task-open-detail-wireframe"')
    expect(inlineHtml).toContain('data-testid="task-row-add-wireframe"')
  })

  test('omits a status badge when neither a status nor task is supplied', () => {
    expect(renderToStaticMarkup(<TaskStatusBadge />)).toBe('')
  })

  test('renders editable, error, and empty task details independently', () => {
    const editableHtml = renderToStaticMarkup(
      <TaskDetailPane
        assigneeOptions={taskViewStoryProjectMembers}
        configuration={teamWorkItemConfigurationFixture}
        detail={taskViewStorySelectedIssueDetail}
        isLoading={false}
        isRelationCandidatesLoading={false}
        locale="ja"
        projects={[{ id: 'refero', name: 'Refero' }]}
        relationCandidates={[]}
        t={t}
        task={taskViewStoryTasks[0]}
        workspaceMembers={collaborationWorkspaceMemberFixtures}
        onClose={() => undefined}
        onUpdateIssue={async () => undefined}
      />,
    )
    const errorHtml = renderToStaticMarkup(
      <TaskDetailPane
        assigneeOptions={taskViewStoryProjectMembers}
        errorMessage="Lambda returned 500."
        isLoading={false}
        isRelationCandidatesLoading={false}
        locale="ja"
        projects={[{ id: 'refero', name: 'Refero' }]}
        relationCandidates={[]}
        t={t}
        task={taskViewStoryTasks[0]}
        workspaceMembers={collaborationWorkspaceMemberFixtures}
      />,
    )
    const emptyHtml = renderToStaticMarkup(
      <TaskDetailPane
        assigneeOptions={[]}
        isLoading={false}
        isRelationCandidatesLoading={false}
        locale="ja"
        projects={[]}
        relationCandidates={[]}
        t={t}
        workspaceMembers={[]}
      />,
    )

    expect(editableHtml).toContain('data-testid="task-detail-pane"')
    expect(editableHtml).toContain('data-testid="task-detail-close"')
    expect(editableHtml).toContain('Refero の初回作業面を確認し')
    expect(editableHtml).toContain('name="custom-field:customer-impact"')
    expect(editableHtml).toContain('Enterprise customers can complete setup')
    expect(editableHtml).not.toContain('disabled="" type="submit"')
    const scheduleFormId = editableHtml.match(
      /<form aria-label="[^"]+" class="hidden" id="([^"]+)"/u,
    )?.[1]
    expect(scheduleFormId).toBeDefined()
    expect(editableHtml).toContain(`form="${scheduleFormId}" name="scheduleMode"`)
    expect(editableHtml).toMatch(new RegExp(
      `<input[^>]+form="${scheduleFormId}"[^>]+name="scheduleEffortMinutes"`,
      'u',
    ))
    expect(errorHtml).toContain('Lambda returned 500.')
    expect(errorHtml).toContain('disabled="" type="submit"')
    expect(emptyHtml).toContain(t('tasks.detail.empty'))
  })

  test('ignores a matching detail body when the list snapshot has a newer revision', () => {
    const fresherTask = {
      ...taskViewStoryTasks[0],
      dueDate: '2026-06-10',
      revision: 2,
      schedule: createDefaultDueDateTaskSchedule('2026-06-10'),
      title: '一覧の新しいタイトル',
    }
    const staleDetail = {
      ...taskViewStorySelectedIssueDetail,
      issue: {
        ...taskViewStorySelectedIssueDetail.issue,
        revision: 1,
        title: '詳細の古いタイトル',
      },
    }
    const html = renderToStaticMarkup(
      <TaskDetailPane
        assigneeOptions={taskViewStoryProjectMembers}
        configuration={teamWorkItemConfigurationFixture}
        detail={staleDetail}
        isLoading={false}
        isRelationCandidatesLoading={false}
        locale="ja"
        projects={[{ id: 'refero', name: 'Refero' }]}
        relationCandidates={[]}
        t={t}
        task={fresherTask}
        workspaceMembers={collaborationWorkspaceMemberFixtures}
        onUpdateIssue={async () => undefined}
      />,
    )

    expect(html).toContain('一覧の新しいタイトル')
    expect(html).not.toContain('詳細の古いタイトル')
    expect(html).toContain('value="2026-06-10"')
    expect(html).toContain('<option value="due-date" selected="">期限のみ</option>')
  })
})
