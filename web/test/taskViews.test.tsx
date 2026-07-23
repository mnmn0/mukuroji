import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTranslator } from '../src/shared/i18n/i18n'
import { collaborationWorkspaceMemberFixtures } from '../src/issues/fixtures'
import { teamWorkItemConfigurationFixture } from '../src/work-items/fixtures'
import { createTaskKey } from '../src/tasks/model/taskView'
import { TaskBoardView } from '../src/tasks/ui/TaskBoardView'
import { TaskCalendarView } from '../src/tasks/ui/TaskCalendarView'
import { TaskFileView } from '../src/tasks/ui/TaskFileView'
import { TaskGanttView } from '../src/tasks/ui/TaskGanttView'
import { TaskPermissionsView } from '../src/tasks/ui/TaskPermissionsView'
import { TaskTableView } from '../src/tasks/ui/TaskTableView'
import {
  taskViewStoryConfigurationsByTeam,
  taskViewStoryProjectFiles,
  taskViewStoryProjectMembers,
  taskViewStoryProjectUsers,
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
        t={t}
        tasks={[...taskViewStoryTasks].reverse()}
      />,
    )

    expect(html).toContain('aria-label="期限順リスト"')
    expect(html.indexOf('ワイヤーフレームを確認する')).toBeLessThan(
      html.indexOf('ブランドガイドラインを更新する'),
    )
    expect(html.indexOf('SEOリサーチをまとめる')).toBeLessThan(
      html.indexOf('競合調査レポートを完成する'),
    )
  })

  test('groups calendar tasks by due date and preserves the unscheduled bucket', () => {
    const html = renderToStaticMarkup(
      <TaskCalendarView t={t} tasks={taskViewStoryTasks} />,
    )

    expect(html).toContain(`aria-label="${t('tasks.view.calendar')}"`)
    expect(html).toContain('2026/06/03')
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
})
