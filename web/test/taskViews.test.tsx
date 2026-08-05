import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTranslator } from '../src/shared/i18n/i18n'
import { collaborationWorkspaceMemberFixtures } from '../src/issues/fixtures'
import { teamWorkItemConfigurationFixture } from '../src/work-items/fixtures'
import { createTaskKey } from '../src/tasks/model/taskView'
import { createDefaultDueDateTaskSchedule } from '../src/tasks/model/taskSchedule'
import { CreateTaskPanel } from '../src/tasks/ui/CreateTaskPanel'
import { TaskBoardView } from '../src/tasks/ui/TaskBoardView'
import { TaskCalendarView } from '../src/tasks/ui/TaskCalendarView'
import { TaskDetailPane } from '../src/tasks/ui/TaskDetailPane'
import { TaskFileView } from '../src/tasks/ui/TaskFileView'
import { TaskGanttView } from '../src/tasks/ui/TaskGanttView'
import { TaskPermissionsView } from '../src/tasks/ui/TaskPermissionsView'
import { TaskTableView } from '../src/tasks/ui/TaskTableView'
import { TaskStatusBadge } from '../src/tasks/ui/TaskViewPrimitives'
import {
  taskViewStoryConfigurationsByTeam,
  taskViewStoryProjectFiles,
  taskViewStoryProjectMembers,
  taskViewStoryProjectUsers,
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
        onTaskSelectionChange={() => undefined}
        onVisibleTaskSelectionChange={() => undefined}
      />,
    )

    expect(html).toContain('data-testid="task-row-wireframe"')
    expect(html).toContain('data-selected="true"')
    expect(html).toContain('data-testid="tasks-count"')
    expect(html).toContain('4件のタスク')
    expect(html).toContain('data-testid="task-row-add-wireframe"')

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
      />,
    )

    expect(html).toContain('aria-label="ボードビュー"')
    expect(html).toContain('data-testid="project-task-column-core-team-active"')
    expect(html).toContain('ワイヤーフレームを確認する')
    expect(unavailableHtml).toContain(
      'data-testid="project-task-configuration-unavailable-column"',
    )
  })

  test('orders the Gantt view by due date and leaves unscheduled tasks last', () => {
    const html = renderToStaticMarkup(
      <TaskGanttView
        configuration={teamWorkItemConfigurationFixture}
        configurationsByTeam={taskViewStoryConfigurationsByTeam}
        onCreateTaskOpen={() => undefined}
        projectId="refero"
        t={t}
        tasks={[...taskViewStoryTasks].reverse()}
      />,
    )

    expect(html).toContain('aria-label="期限順リスト"')
    expect(html).toContain('data-testid="task-gantt-add-wireframe"')
    expect(html).toContain('data-testid="task-gantt-bar-wireframe"')
    expect(html).toContain('data-testid="task-gantt-resize-wireframe"')
    expect(html).toContain('value="milestone"')
    expect(html).toContain('value="unscheduled"')
    expect(html.indexOf('ワイヤーフレームを確認する')).toBeLessThan(
      html.indexOf('ブランドガイドラインを更新する'),
    )
    expect(html.indexOf('SEOリサーチをまとめる')).toBeLessThan(
      html.indexOf('競合調査レポートを完成する'),
    )
  })

  test('bounds the Gantt timeline across the complete ISO planning horizon', () => {
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

    expect(columnHeaderCount).toBeLessThanOrEqual(181)
    expect(html).toContain('1000-01-01')
    expect(html).toContain('9999-12-31')
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
