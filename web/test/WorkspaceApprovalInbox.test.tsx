import { describe, expect, test } from 'bun:test'
import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type PlanningUpdateTargetSummary,
  type ResolvedWorkItemConfiguration,
} from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { notificationInboxControllerFixture } from '../src/notifications/fixtures'
import { WorkspaceInboxView } from '../src/notifications/ui/WorkspaceInboxView'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import { TeamOverviewView } from '../src/projects/ui/TeamOverviewView'
import { createTranslator } from '../src/shared/i18n/i18n'
import type { ProjectTask } from '../src/tasks/api'
import { createDefaultDueDateTaskSchedule } from '../src/tasks/model/taskSchedule'
import { DashboardWorkspaceView } from '../src/workspace/ui/DashboardWorkspaceView'
import { HomeWorkspaceView } from '../src/workspace/ui/HomeWorkspaceView'
import { MyTasksWorkspaceView } from '../src/workspace/ui/MyTasksWorkspaceView'
import {
  WorkspaceConfigurationLoadNotice,
  WorkspaceTaskLoadNotice,
} from '../src/workspace/ui/WorkspaceDataNotices'

const coreTeam = projectDirectoryFixtures.find((team) => team.id === 'core-team')

if (!coreTeam) {
  throw new Error('The core Team fixture is required for Workspace view tests.')
}

describe('Workspace approval Inbox', () => {
  test('uses Team configuration names for status labels on every Workspace summary surface', () => {
    const task: ProjectTask = {
      assignedProjectId: 'refero',
      assigneeUserId: 'demo@example.com',
      creatorMemberKey: 'demo@example.com',
      createdAt: '2026-07-16T00:00:00.000Z',
      customFieldValues: {},
      dueDate: '2026-01-01',
      id: 'configured-status',
      priority: 'high',
      relationIds: [],
      revision: 1,
      schedule: createDefaultDueDateTaskSchedule('2026-01-01'),
      schemaVersion: WORK_ITEM_SCHEMA_VERSION,
      source: 'dynamodb',
      statusCategory: 'started',
      teamId: 'core-team',
      title: 'Configured status task',
      updatedAt: '2026-07-16T00:00:00.000Z',
      workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
      workflowStatusId: 'active',
    }
    const workItemConfigurationsByTeam: Readonly<
      Record<string, ResolvedWorkItemConfiguration>
    > = {
      'core-team': {
        configuration: {
          customFields: [],
          revision: 1,
          schemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
          scopeId: 'core-team',
          scopeType: 'team',
          workflow: {
            id: 'core-workflow',
            initialStatusId: 'active',
            name: 'Core workflow',
            statuses: [{
              category: 'started',
              id: 'active',
              name: 'Configured active',
              sortOrder: 0,
            }],
            transitions: [],
          },
        },
      },
    }
    const summary = {
      blocked: 1,
      projects: 1,
      tasks: 1,
    }
    const t = createTranslator('en')
    const views = [
      <HomeWorkspaceView
        summary={summary}
        t={t}
        tasks={[task]}
        teams={projectDirectoryFixtures}
        workItemConfigurationsByTeam={workItemConfigurationsByTeam}
        onOpenTask={() => undefined}
      />,
      <DashboardWorkspaceView
        summary={summary}
        t={t}
        tasks={[task]}
        teams={projectDirectoryFixtures}
        workItemConfigurationsByTeam={workItemConfigurationsByTeam}
        onOpenTask={() => undefined}
      />,
      <WorkspaceInboxView
        locale="en"
        notificationInbox={notificationInboxControllerFixture}
        t={t}
        tasks={[task]}
        teams={projectDirectoryFixtures}
        workItemConfigurationsByTeam={workItemConfigurationsByTeam}
        onOpenTask={() => undefined}
      />,
      <TeamOverviewView
        isTeamProjectMembersLoading={false}
        t={t}
        tasks={[task]}
        team={coreTeam}
        teamProjectMembers={[]}
        teamProjectMembersFailedProjectIds={[]}
        workItemConfigurationsByTeam={workItemConfigurationsByTeam}
        onOpenTask={() => undefined}
      />,
    ]

    for (const view of views) {
      expect(renderToStaticMarkup(view)).toContain('Configured active')
    }
  })

  test('keeps reported health separate from overdue freshness in Project portfolio rows', () => {
    const planningUpdateTargets: PlanningUpdateTargetSummary[] = [{
      target: { type: 'project', teamId: 'core-team', projectId: 'refero' },
      cadence: {
        updateOwnerMemberKey: 'demo@example.com',
        cadence: { unit: 'week', count: 1 },
        timeZone: 'UTC',
        nextDueAt: '2026-08-08T09:00:00.000Z',
        reminderHoursBefore: 24,
      },
      updateState: 'overdue',
      latestVersion: 2,
      latestUpdate: {
        id: 'dashboard-update-2',
        version: 2,
        health: 'on-track',
        risk: 'low',
        summary: 'Launch scope remains healthy.',
        progressSnapshot: { percent: 75, linkedWorkItemCount: 4 },
        authorMemberKey: 'demo@example.com',
        coveredDueAt: '2026-08-01T09:00:00.000Z',
        createdAt: '2026-08-01T08:30:00.000Z',
      },
      updatedAt: '2026-08-01T08:30:00.000Z',
    }]
    const html = renderToStaticMarkup(
      <DashboardWorkspaceView
        planningUpdateTargets={planningUpdateTargets}
        summary={{ blocked: 0, projects: 1, tasks: 0 }}
        t={createTranslator('en')}
        tasks={[]}
        teams={projectDirectoryFixtures}
        workItemConfigurationsByTeam={{}}
      />,
    )

    expect(html).toContain('On track')
    expect(html).toContain('Overdue')
    expect(html).toContain('Launch scope remains healthy.')
    expect(html).toContain('data-testid="dashboard-update-summary-core-team-refero"')
    expect(html).toContain('demo@example.com')
    expect(html).toContain('2026-08-01')
    expect(html).toContain('2026-08-08')
    expect(html).toContain('min-[761px]:min-w-[1180px]')
    expect(html).not.toContain('Off track')
  })

  test('keeps durable notifications while exposing only actionable approval summaries', () => {
    const tasks: ProjectTask[] = [
      {
        approvalSummary: {
          approvedCount: 0,
          changesRequestedCount: 0,
          overdueCount: 1,
          pendingCount: 2,
          rejectedCount: 0,
        },
        assignedProjectId: 'refero',
        assigneeUserId: 'demo@example.com',
        creatorMemberKey: 'demo@example.com',
        customFieldValues: {},
        createdAt: '2026-07-14T00:00:00.000Z',
        dueDate: '2099-12-31',
        id: 'approval-proof',
        priority: 'low',
        relationIds: [],
        revision: 1,
        schedule: createDefaultDueDateTaskSchedule('2099-12-31'),
        schemaVersion: WORK_ITEM_SCHEMA_VERSION,
        source: 'dynamodb',
        statusCategory: 'unstarted',
        teamId: 'core-team',
        title: '承認待ち成果物',
        updatedAt: '2026-07-14T00:00:00.000Z',
        workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
        workflowStatusId: 'todo',
      },
      {
        approvalSummary: {
          approvedCount: 1,
          changesRequestedCount: 1,
          overdueCount: 0,
          pendingCount: 0,
          rejectedCount: 1,
        },
        assignedProjectId: 'refero',
        assigneeUserId: 'demo@example.com',
        creatorMemberKey: 'demo@example.com',
        customFieldValues: {},
        createdAt: '2026-07-14T00:00:00.000Z',
        dueDate: '2099-12-31',
        id: 'approval-history-only',
        priority: 'low',
        relationIds: [],
        revision: 1,
        schedule: createDefaultDueDateTaskSchedule('2099-12-31'),
        schemaVersion: WORK_ITEM_SCHEMA_VERSION,
        source: 'dynamodb',
        statusCategory: 'unstarted',
        teamId: 'core-team',
        title: '過去の承認判断だけがある成果物',
        updatedAt: '2026-07-14T00:00:00.000Z',
        workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
        workflowStatusId: 'todo',
      },
    ]
    const html = renderToStaticMarkup(
      <WorkspaceInboxView
        locale="ja"
        notificationInbox={notificationInboxControllerFixture}
        t={createTranslator('ja')}
        tasks={tasks}
        teams={projectDirectoryFixtures}
        workItemConfigurationsByTeam={{}}
        onOpenTask={() => undefined}
      />,
    )

    expect(html).toContain('data-testid="inbox-filter-approval"')
    expect(html).toContain('data-testid="inbox-task-core-team-refero-approval-proof"')
    expect(html).not.toContain('data-testid="inbox-task-core-team-refero-approval-history-only"')
    expect(html).toContain('Approval 期限超過')
    expect(html).toContain('data-testid="notification-row-notification-mention-1"')
    expect(html).toContain('data-testid="notification-load-more"')
  })

  test('keeps durable notifications visible beside a Work Item partial error', () => {
    const t = createTranslator('ja')
    const html = renderToStaticMarkup(
      <>
        <WorkspaceTaskLoadNotice failedProjectCount={1} t={t} />
        <WorkspaceInboxView
          locale="ja"
          notificationInbox={notificationInboxControllerFixture}
          t={t}
          tasks={[]}
          teams={projectDirectoryFixtures}
          workItemConfigurationsByTeam={{}}
        />
      </>,
    )

    expect(html).toContain('data-testid="workspace-task-partial-error"')
    expect(html).toContain('タスク一覧を取得できませんでした (1)')
    expect(html).toContain('data-testid="notification-row-notification-mention-1"')
    expect(html).toContain('data-testid="notification-load-more"')
  })

  test('keeps canonical My Tasks visible when its Team configuration is unavailable', () => {
    const task: ProjectTask = {
      assignedProjectId: 'refero',
      assigneeUserId: 'demo@example.com',
      creatorMemberKey: 'demo@example.com',
      createdAt: '2026-07-16T00:00:00.000Z',
      customFieldValues: {},
      dueDate: '2099-12-31',
      id: 'configuration-unavailable',
      priority: 'high',
      relationIds: [],
      revision: 1,
      schedule: createDefaultDueDateTaskSchedule('2099-12-31'),
      schemaVersion: WORK_ITEM_SCHEMA_VERSION,
      source: 'dynamodb',
      statusCategory: 'started',
      teamId: 'core-team',
      title: '設定取得失敗中も表示するタスク',
      updatedAt: '2026-07-16T00:00:00.000Z',
      workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
      workflowStatusId: 'active',
    }
    const t = createTranslator('ja')
    const html = renderToStaticMarkup(
      <>
        <WorkspaceConfigurationLoadNotice
          failedTeamCount={1}
          t={t}
          onRetry={() => undefined}
        />
        <MyTasksWorkspaceView
          configurationFailedTeamIds={['core-team']}
          configurationsByTeam={{}}
          t={t}
          tasks={[task]}
          teams={projectDirectoryFixtures}
        />
      </>,
    )

    expect(html).toContain('data-testid="my-tasks-configuration-error"')
    expect(html).toContain('data-testid="my-tasks-configuration-unavailable-column"')
    expect(html).toContain('data-testid="my-tasks-card-refero-configuration-unavailable"')
    expect(html).toContain('設定取得失敗中も表示するタスク')
    expect(html).toContain('再読み込み')
    expect(html).not.toContain('my-tasks-card-refero-configuration-unavailable-status-select')
  })
})
