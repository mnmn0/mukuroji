import { describe, expect, test } from 'bun:test'
import { WORK_ITEM_SCHEMA_VERSION } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { notificationInboxControllerFixture } from '../src/notifications/fixtures'
import { WorkspaceScreen } from '../src/pages/WorkspacePage'
import { projectDirectoryFixtures } from '../src/projects/fixtures'

describe('Workspace approval Inbox', () => {
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
            dueDate: '2099/12/31',
            id: 'approval-proof',
            priority: 'low',
            revision: 1,
            schemaVersion: WORK_ITEM_SCHEMA_VERSION,
            source: 'dynamodb',
            status: 'todo',
            teamId: 'core-team',
            title: '承認待ち成果物',
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
            dueDate: '2099/12/31',
            id: 'approval-history-only',
            priority: 'low',
            revision: 1,
            schemaVersion: WORK_ITEM_SCHEMA_VERSION,
            source: 'dynamodb',
            status: 'todo',
            teamId: 'core-team',
            title: '過去の承認判断だけがある成果物',
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
})
