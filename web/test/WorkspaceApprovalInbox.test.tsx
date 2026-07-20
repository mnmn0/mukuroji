import { describe, expect, test } from 'bun:test'
import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
} from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { notificationInboxControllerFixture } from '../src/notifications/fixtures'
import { WorkspaceScreen } from '../src/pages/workspace/WorkspacePage'
import { projectDirectoryFixtures } from '../src/projects/fixtures'

describe('Workspace approval Inbox', () => {
  test('uses Team configuration names for status labels on every Workspace summary surface', () => {
    const task = {
      assignedProjectId: 'refero',
      assigneeUserId: 'demo@example.com',
      creatorMemberKey: 'demo@example.com',
      createdAt: '2026-07-16T00:00:00.000Z',
      customFieldValues: {},
      dueDate: '2026/01/01',
      id: 'configured-status',
      priority: 'high' as const,
      relationIds: [],
      revision: 1,
      schemaVersion: WORK_ITEM_SCHEMA_VERSION,
      source: 'dynamodb' as const,
      statusCategory: 'started' as const,
      teamId: 'core-team',
      title: 'Configured status task',
      updatedAt: '2026-07-16T00:00:00.000Z',
      workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
      workflowStatusId: 'active',
    }
    const workItemConfigurationsByTeam = {
      'core-team': {
        configuration: {
          customFields: [],
          revision: 1,
          schemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
          scopeId: 'core-team',
          scopeType: 'team' as const,
          workflow: {
            id: 'core-workflow',
            initialStatusId: 'active',
            name: 'Core workflow',
            statuses: [{
              category: 'started' as const,
              id: 'active',
              name: 'Configured active',
              sortOrder: 0,
            }],
            transitions: [],
          },
        },
      },
    }

    for (const view of ['home', 'dashboard', 'inbox', 'team-overview'] as const) {
      const html = renderToStaticMarkup(
        <WorkspaceScreen
          activeTeamId="core-team"
          fontSizePreference="standard"
          locale="en"
          notificationInbox={notificationInboxControllerFixture}
          summary={{
            blocked: 1,
            projects: 1,
            source: 'dynamodb',
            tasks: 1,
            updatedAt: '2026-07-16T00:00:00.000Z',
          }}
          tasks={[task]}
          teams={projectDirectoryFixtures}
          userInitial="D"
          userLabel="demo@example.com"
          view={view}
          workItemConfigurationsByTeam={workItemConfigurationsByTeam}
          onFontSizePreferenceChange={() => undefined}
          onOpenTask={() => undefined}
        />,
      )

      expect(html).toContain('Configured active')
    }
  })

  test('keeps durable notifications while exposing only actionable approval summaries', () => {
    const html = renderToStaticMarkup(
      <WorkspaceScreen
        fontSizePreference="standard"
        inboxCount={2}
        locale="ja"
        notificationInbox={notificationInboxControllerFixture}
        summary={{
          blocked: 0,
          projects: 1,
          source: 'dynamodb',
          tasks: 2,
          updatedAt: '2026-07-14T00:00:00.000Z',
        }}
        tasks={[
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
            dueDate: '2099/12/31',
            id: 'approval-proof',
            priority: 'low',
            relationIds: [],
            revision: 1,
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
            dueDate: '2099/12/31',
            id: 'approval-history-only',
            priority: 'low',
            relationIds: [],
            revision: 1,
            schemaVersion: WORK_ITEM_SCHEMA_VERSION,
            source: 'dynamodb',
            statusCategory: 'unstarted',
            teamId: 'core-team',
            title: '過去の承認判断だけがある成果物',
            updatedAt: '2026-07-14T00:00:00.000Z',
            workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
            workflowStatusId: 'todo',
          },
        ]}
        teams={projectDirectoryFixtures}
        userInitial="D"
        userLabel="demo@example.com"
        view="inbox"
        onFontSizePreferenceChange={() => undefined}
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
    const html = renderToStaticMarkup(
      <WorkspaceScreen
        fontSizePreference="standard"
        inboxCount={2}
        locale="ja"
        notificationInbox={notificationInboxControllerFixture}
        summary={{
          blocked: 0,
          projects: 1,
          source: 'dynamodb',
          tasks: 0,
          updatedAt: '2026-07-14T00:00:00.000Z',
        }}
        taskLoadFailedProjectIds={['refero']}
        tasks={[]}
        teams={projectDirectoryFixtures}
        userInitial="D"
        userLabel="demo@example.com"
        view="inbox"
        onFontSizePreferenceChange={() => undefined}
      />,
    )

    expect(html).toContain('data-testid="workspace-task-partial-error"')
    expect(html).toContain('タスク一覧を取得できませんでした (1)')
    expect(html).toContain('data-testid="notification-row-notification-mention-1"')
    expect(html).toContain('data-testid="notification-load-more"')
  })

  test('keeps canonical My Tasks visible when its Team configuration is unavailable', () => {
    const html = renderToStaticMarkup(
      <WorkspaceScreen
        fontSizePreference="standard"
        locale="ja"
        summary={{
          blocked: 0,
          projects: 1,
          source: 'dynamodb',
          tasks: 1,
          updatedAt: '2026-07-16T00:00:00.000Z',
        }}
        tasks={[{
          assignedProjectId: 'refero',
          assigneeUserId: 'demo@example.com',
          creatorMemberKey: 'demo@example.com',
          createdAt: '2026-07-16T00:00:00.000Z',
          customFieldValues: {},
          dueDate: '2099/12/31',
          id: 'configuration-unavailable',
          priority: 'high',
          relationIds: [],
          revision: 1,
          schemaVersion: WORK_ITEM_SCHEMA_VERSION,
          source: 'dynamodb',
          statusCategory: 'started',
          teamId: 'core-team',
          title: '設定取得失敗中も表示するタスク',
          updatedAt: '2026-07-16T00:00:00.000Z',
          workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
          workflowStatusId: 'active',
        }]}
        teams={projectDirectoryFixtures}
        userIdentityAliases={['demo@example.com']}
        userInitial="D"
        userLabel="demo@example.com"
        view="my-tasks"
        workItemConfigurationFailedTeamIds={['core-team']}
        onFontSizePreferenceChange={() => undefined}
        onRetryWorkItemConfigurations={() => undefined}
      />,
    )

    expect(html).toContain('data-testid="my-tasks-configuration-error"')
    expect(html).toContain('data-testid="my-tasks-configuration-unavailable-column"')
    expect(html).toContain('data-testid="my-tasks-card-refero-configuration-unavailable"')
    expect(html).toContain('設定取得失敗中も表示するタスク')
    expect(html).toContain('再読み込み')
    expect(html).not.toContain('my-tasks-card-refero-configuration-unavailable-status-select')
  })
})
