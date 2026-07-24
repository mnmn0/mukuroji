import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type AnalyticsExportInput,
  type AnalyticsQueryInput,
  type ApprovalRequest,
  type CustomFieldValue,
  type FileAnnotation,
  type FileAttachment,
  type FileVersion,
  type WorkItemConfiguration,
  type WorkItemRelation,
  type WorkItemRelationType,
} from '@mukuroji/contracts'
import { readFile } from 'node:fs/promises'
import {
  analyticsReportFixtures,
  analyticsSnapshotFixture,
} from '../src/analytics/fixtures'
import type { TeamIssue, TeamIssueActivity, TeamIssueComment } from '../src/issues/api'
import type { InboxNotification, NotificationPreferences } from '../src/notifications/api'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import type { ProjectDirectoryTeam, ProjectMember, ProjectMemberRole, ProjectUser } from '../src/projects/api'
import type { ProjectTask } from '../src/tasks/api'
import type { WorkspaceAccess } from '../src/workspace/api'
import { referoTaskFixtures } from '../src/tasks/fixtures'
import {
  teamWorkItemConfigurationFixture,
  workspaceWorkItemConfigurationFixture,
} from '../src/work-items/fixtures'

const authSession = {
  accessToken: 'test-access-token',
  expiresAt: Date.now() + 60 * 60 * 1000,
  tokenType: 'Bearer',
  remember: true,
}
const workItemConflictMessage =
  '別のメンバーが先に更新しました。最新の内容を確認してから、もう一度保存してください。'
const notificationFixtureNow = new Date('2026-07-12T12:00:00.000Z')

const defaultWorkItemConfiguration = {
  scopeType: 'workspace',
  scopeId: 'workspace-demo',
  schemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  revision: 1,
  updatedAt: '2026-07-12T00:00:00.000Z',
  workflow: {
    id: 'default-workflow',
    name: 'Default workflow',
    initialStatusId: 'todo',
    statuses: [
      { id: 'todo', name: '未着手', category: 'unstarted', sortOrder: 0 },
      { id: 'in-progress', name: '進行中', category: 'started', sortOrder: 1 },
      { id: 'review', name: 'レビュー', category: 'started', sortOrder: 2 },
      { id: 'done', name: '完了', category: 'completed', sortOrder: 3 },
    ],
    transitions: [
      { fromStatusId: 'todo', toStatusId: 'in-progress' },
      { fromStatusId: 'todo', toStatusId: 'review' },
      { fromStatusId: 'todo', toStatusId: 'done' },
      { fromStatusId: 'in-progress', toStatusId: 'todo' },
      { fromStatusId: 'in-progress', toStatusId: 'review' },
      { fromStatusId: 'in-progress', toStatusId: 'done' },
      { fromStatusId: 'review', toStatusId: 'todo' },
      { fromStatusId: 'review', toStatusId: 'in-progress' },
      { fromStatusId: 'review', toStatusId: 'done' },
      { fromStatusId: 'done', toStatusId: 'todo' },
      { fromStatusId: 'done', toStatusId: 'in-progress' },
      { fromStatusId: 'done', toStatusId: 'review' },
    ],
  },
  customFields: [],
} satisfies WorkItemConfiguration

const reciprocalWorkItemRelationTypes = {
  parent: 'child',
  child: 'parent',
  blocks: 'blockedBy',
  blockedBy: 'blocks',
  related: 'related',
  duplicate: 'duplicate',
} as const satisfies Record<WorkItemRelationType, WorkItemRelationType>

/**
 * API stub が受けた request 数です。
 */
type MockRequestCounts = {
  /**
   * チーム/プロジェクト一覧 API の request 数です。
   */
  projectDirectory: number
  /**
   * プロジェクト別タスク API の request 数です。
   */
  projectTasks: Record<string, number>
  /**
   * Workspace 全体の Work Item 一覧 API request 数です。
   */
  workspaceWorkItems: number
  /**
   * 通知一覧 API の request 数です。
   */
  notificationReads: number
  /**
   * 通知状態 mutation API の request 数です。
   */
  notificationUpdates: number
  /**
   * 通知設定保存 API の request 数です。
   */
  notificationPreferenceUpdates: number
  /**
   * チーム作成 API の request 数です。
   */
  teamCreates: number
  /**
   * プロジェクト作成 API の request 数です。
   */
  projectCreates: number
  /**
   * チームアーカイブ API の request 数です。
   */
  teamArchives: number
  /**
   * プロジェクトアーカイブ API の request 数です。
   */
  projectArchives: number
  /**
   * プロジェクトメンバー一覧 API の request 数です。
   */
  projectMemberReads: number
  /**
   * Cognito user 一覧 API の request 数です。
   */
  projectUserReads: number
  /**
   * プロジェクトメンバー更新 API の request 数です。
   */
  projectMemberUpdates: number
  /**
   * プロジェクトメンバー削除 API の request 数です。
   */
  projectMemberRemoves: number
  /**
   * チーム Issue 一覧 API の request 数です。
   */
  issueReads: number
  /**
   * チーム Issue 作成 API の request 数です。
   */
  issueCreates: number
  /**
   * チーム Issue 更新 API の request 数です。
   */
  issueUpdates: number
  /**
   * チーム Issue コメント API の request 数です。
   */
  issueComments: number
  /**
   * タスク作成 API の request 数です。
   */
  taskCreates: number
  /**
   * タスク状態更新 API の request 数です。
   */
  taskStatusUpdates: number
  /**
   * Work Item configuration 取得 API の request 数です。
   */
  workItemConfigurationReads: number
  /**
   * Work Item configuration 保存 API の request 数です。
   */
  workItemConfigurationWrites: number
  /**
   * Work Item relation 作成 API の request 数です。
   */
  workItemRelationCreates: number
  /**
   * Work Item relation 削除 API の request 数です。
   */
  workItemRelationDeletes: number
}

const mockRequestCountsByPage = new WeakMap<Page, MockRequestCounts>()

/**
 * 認証済みユーザー API を指定したユーザーへ差し替えます。
 *
 * @param page - API route を差し替える Playwright page です。
 * @param username - username と email に使う識別子です。
 * @param name - 画面に表示するユーザー名です。
 * @param workspaceId - ユーザーの Workspace ID です。
 */
async function mockCurrentUser(
  page: Page,
  username: string,
  name: string,
  workspaceId?: string,
) {
  await page.unroute('**/api/auth/me')
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      json: {
        username,
        attributes: {
          'custom:workspace_id': workspaceId,
          email: username,
          name,
        },
        groups: ['mukuroji-system-admins'],
        isSystemAdmin: true,
        workspaceRole: 'owner',
        workspaceMemberStatus: 'active',
      },
    })
  })
}

/**
 * 認証済みタスク画面 mock の追加設定です。
 */
type MockAuthenticatedTaskPageOptions = {
  /**
   * Team ID ごとに Sidebar の初期展開状態を上書きする値です。
   */
  teamExpandedById?: Partial<Record<string, boolean>>
  /**
   * Team と Project ID ごとに directory 表示名を上書きする値です。
   */
  projectNamesByTeam?: Partial<Record<string, Partial<Record<string, string>>>>
  /**
   * チーム Issue API が初期状態として返す保存済み Issue 一覧です。
   */
  teamIssuesByTeam?: Partial<Record<string, TeamIssue[]>>
  /**
   * 初回更新を revision conflict にする `teamId\0issueId` key の一覧です。
   */
  revisionConflictIssueKeys?: readonly string[]
  /**
   * Notification API が初期状態として返す recipient 通知です。
   */
  notifications?: InboxNotification[]
  /**
   * Notification preferences API が初期状態として返す設定です。
   */
  notificationPreferences?: NotificationPreferences
  /**
   * Workspace scope で取得・保存する Work Item configuration です。
   */
  workspaceWorkItemConfiguration?: WorkItemConfiguration
  /**
   * Team scope の override として取得・保存する configuration です。
   */
  teamWorkItemConfigurations?: Partial<Record<string, WorkItemConfiguration>>
  /**
   * Work Item configuration 取得を 500 にする Team ID です。
   */
  failedWorkItemConfigurationTeamIds?: readonly string[]
  /**
   * `teamId\0issueId` ごとの初期 Work Item relation です。
   */
  workItemRelationsByIssue?: Partial<Record<string, readonly WorkItemRelation[]>>
}

/**
 * 認証済みタスク画面を開くため、localStorage に session を注入し、
 * `/api/auth/me` と canonical Work Item API を stub します。
 */
async function mockAuthenticatedTaskPage(
  page: Page,
  taskResponse = referoTaskFixtures,
  onTaskStatusUpdate?: (
    taskId: string,
    workflowStatusId: string,
  ) => Promise<'fail' | undefined> | 'fail' | undefined,
  options: MockAuthenticatedTaskPageOptions = {},
) {
  const requestCounts: MockRequestCounts = {
    projectDirectory: 0,
    projectTasks: {},
    workspaceWorkItems: 0,
    notificationReads: 0,
    notificationUpdates: 0,
    notificationPreferenceUpdates: 0,
    teamCreates: 0,
    projectCreates: 0,
    teamArchives: 0,
    projectArchives: 0,
    projectMemberReads: 0,
    projectUserReads: 0,
    projectMemberUpdates: 0,
    projectMemberRemoves: 0,
    issueReads: 0,
    issueCreates: 0,
    issueUpdates: 0,
    issueComments: 0,
    taskCreates: 0,
    taskStatusUpdates: 0,
    workItemConfigurationReads: 0,
    workItemConfigurationWrites: 0,
    workItemRelationCreates: 0,
    workItemRelationDeletes: 0,
  }
  const projectDirectory: ProjectDirectoryTeam[] = projectDirectoryFixtures.map((team) => ({
    ...team,
    expanded: options.teamExpandedById?.[team.id] ?? team.expanded,
    projects: team.projects.map((project) => ({ ...project })),
  }))
  for (const [teamId, projectNames] of Object.entries(options.projectNamesByTeam ?? {})) {
    const team = projectDirectory.find((candidate) => candidate.id === teamId)

    if (!team || !projectNames) {
      continue
    }

    team.projects = team.projects.map((project) => ({
      ...project,
      name: projectNames[project.id] ?? project.name,
    }))
  }
  const taskResponsesByProject: Record<string, ProjectTask[]> = {
    refero: taskResponse.map((task) => ({ ...task })),
    'product-roadmap': [],
    'brand-refresh': [],
    'shared-launch': [],
  }
  const teamIssuesByTeam: Record<string, TeamIssue[]> = {
    'core-team': [...(options.teamIssuesByTeam?.['core-team'] ?? [])],
    'design-team': [...(options.teamIssuesByTeam?.['design-team'] ?? [])],
  }
  const pendingRevisionConflictIssueKeys = new Set(options.revisionConflictIssueKeys ?? [])
  const failedWorkItemConfigurationTeamIds = new Set(
    options.failedWorkItemConfigurationTeamIds ?? [],
  )
  const issueCommentsByIssue: Record<string, TeamIssueComment[]> = {}
  const issueActivityByIssue: Record<string, TeamIssueActivity[]> = {}
  let notifications = (options.notifications ?? createDefaultNotifications()).map((notification) => ({
    ...notification,
    reasons: [...notification.reasons],
  }))
  let notificationPreferences = cloneNotificationPreferences(
    options.notificationPreferences ?? createDefaultNotificationPreferences(),
  )
  let workspaceWorkItemConfiguration = structuredClone(
    options.workspaceWorkItemConfiguration ?? defaultWorkItemConfiguration,
  )
  const teamWorkItemConfigurations: Partial<Record<string, WorkItemConfiguration>> =
    Object.fromEntries(
      Object.entries(options.teamWorkItemConfigurations ?? {}).map(([teamId, configuration]) => [
        teamId,
        structuredClone(configuration),
      ]),
    )
  const workItemRelationsByIssue: Record<string, WorkItemRelation[]> = Object.fromEntries(
    Object.entries(options.workItemRelationsByIssue ?? {}).map(([issueKey, relations]) => [
      issueKey,
      structuredClone([...(relations ?? [])]),
    ]),
  )
  const relationGraphRevisionByTeam: Record<string, number> = {
    'core-team': 1,
    'design-team': 1,
  }
  const projectMembersByProject: Record<string, ProjectMember[]> = {
    refero: [
      {
        id: 'demo@example.com',
        email: 'demo@example.com',
        name: 'Demo User',
        role: 'manager',
        updatedAt: '2026-06-08T00:00:00.000Z',
        workspaceStatus: 'active',
      },
      {
        id: 'sato@example.com',
        email: 'sato@example.com',
        name: '佐藤 花子',
        role: 'member',
        updatedAt: '2026-06-08T00:00:00.000Z',
        workspaceStatus: 'active',
      },
      {
        id: 'inactive@example.com',
        email: 'inactive@example.com',
        enabled: false,
        name: 'Inactive User',
        role: 'member',
        updatedAt: '2026-07-11T00:00:00.000Z',
        workspaceStatus: 'deactivated',
      },
    ],
    'product-roadmap': [
      {
        id: 'demo@example.com',
        email: 'demo@example.com',
        name: 'Demo User',
        role: 'manager',
        updatedAt: '2026-06-08T00:00:00.000Z',
        workspaceStatus: 'active',
      },
      {
        id: 'viewer2@example.com',
        email: 'viewer2@example.com',
        name: 'Viewer Two',
        role: 'viewer',
        updatedAt: '2026-06-08T00:00:00.000Z',
        workspaceStatus: 'active',
      },
    ],
  }
  const projectUsers: ProjectUser[] = [
    {
      id: 'demo@example.com',
      username: 'demo@example.com',
      email: 'demo@example.com',
      name: 'Demo User',
      enabled: true,
      status: 'CONFIRMED',
      workspaceStatus: 'active',
    },
    {
      id: 'sato@example.com',
      username: 'sato@example.com',
      email: 'sato@example.com',
      name: '佐藤 花子',
      enabled: true,
      status: 'CONFIRMED',
      workspaceStatus: 'active',
    },
    {
      id: 'viewer2@example.com',
      username: 'viewer2@example.com',
      email: 'viewer2@example.com',
      name: 'Viewer Two',
      enabled: true,
      status: 'CONFIRMED',
      workspaceStatus: 'active',
    },
    {
      id: 'inactive@example.com',
      username: 'inactive@example.com',
      email: 'inactive@example.com',
      name: 'Inactive User',
      enabled: false,
      status: 'CONFIRMED',
      workspaceStatus: 'deactivated',
    },
  ]
  const workspaceAccess = {
    capabilities: {
      canInvite: true,
      canManageAdmins: true,
      canManageMembers: true,
    },
    currentMember: {
      createdAt: '2026-07-01T00:00:00.000Z',
      email: 'demo@example.com',
      id: 'workspace-member-demo',
      memberKey: 'demo@example.com',
      name: 'Demo User',
      role: 'owner',
      status: 'active',
      updatedAt: '2026-07-11T00:00:00.000Z',
      version: 4,
    },
    invitations: [
      {
        createdAt: '2026-07-11T01:00:00.000Z',
        deliveryStatus: 'failed',
        email: 'failed@example.com',
        expiresAt: '2026-07-18T01:00:00.000Z',
        failureMessage: 'Delivery failed.',
        id: 'invitation-failed',
        identityOwnership: 'workspace-created',
        role: 'member',
        status: 'delivery-failed',
        updatedAt: '2026-07-11T01:01:00.000Z',
        version: 2,
      },
      {
        createdAt: '2026-07-01T01:00:00.000Z',
        deliveryStatus: 'sent',
        email: 'expired@example.com',
        expiresAt: '2026-07-08T01:00:00.000Z',
        id: 'invitation-expired',
        identityOwnership: 'ambiguous',
        lastSentAt: '2026-07-01T01:01:00.000Z',
        role: 'guest',
        status: 'expired',
        updatedAt: '2026-07-08T01:00:00.000Z',
        version: 3,
      },
    ],
    members: [
      {
        createdAt: '2026-07-01T00:00:00.000Z',
        email: 'demo@example.com',
        id: 'workspace-member-demo',
        memberKey: 'demo@example.com',
        name: 'Demo User',
        role: 'owner',
        status: 'active',
        updatedAt: '2026-07-11T00:00:00.000Z',
        version: 4,
      },
      {
        createdAt: '2026-07-02T00:00:00.000Z',
        email: 'sato@example.com',
        id: 'workspace-member-sato',
        memberKey: 'sato@example.com',
        name: '佐藤 花子',
        role: 'member',
        status: 'active',
        updatedAt: '2026-07-10T00:00:00.000Z',
        version: 2,
      },
    ],
  } satisfies WorkspaceAccess

  mockRequestCountsByPage.set(page, requestCounts)

  await page.addInitScript((session) => {
    window.localStorage.setItem('mukuroji.locale', 'ja')
    window.localStorage.setItem('mukuroji.auth', JSON.stringify(session))
  }, authSession)

  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      json: {
        username: 'demo@example.com',
        attributes: {
          'custom:workspace_id': 'workspace-demo',
          email: 'demo@example.com',
          name: 'Demo User',
        },
        groups: ['mukuroji-system-admins'],
        isSystemAdmin: true,
        workspaceMemberStatus: 'active',
        workspaceRole: 'owner',
      },
    })
  })

  await page.route('**/api/workspace/access', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')
    await route.fulfill({ json: workspaceAccess })
  })

  await page.route('**/api/work-item-configuration', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    if (route.request().method() === 'GET') {
      requestCounts.workItemConfigurationReads += 1
      await route.fulfill({
        json: {
          configuration: structuredClone(workspaceWorkItemConfiguration),
        },
      })
      return
    }

    if (route.request().method() === 'PUT') {
      requestCounts.workItemConfigurationWrites += 1
      const body = route.request().postDataJSON() as WorkItemConfiguration

      workspaceWorkItemConfiguration = {
        ...structuredClone(body),
        scopeType: 'workspace',
        scopeId: workspaceWorkItemConfiguration.scopeId,
        revision: body.revision + 1,
        updatedAt: '2026-07-12T12:00:00.000Z',
      }
      await route.fulfill({
        json: {
          configuration: structuredClone(workspaceWorkItemConfiguration),
        },
      })
      return
    }

    await route.fallback()
  })

  await page.route(/.*\/api\/teams\/[^/]+\/work-item-configuration$/, async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    const teamId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] ?? '')
    const teamConfiguration = teamWorkItemConfigurations[teamId]

    if (route.request().method() === 'GET') {
      requestCounts.workItemConfigurationReads += 1
      if (failedWorkItemConfigurationTeamIds.has(teamId)) {
        await route.fulfill({ json: { message: 'configuration unavailable' }, status: 500 })
        return
      }
      await route.fulfill({
        json: teamConfiguration
          ? { configuration: structuredClone(teamConfiguration) }
          : {
              configuration: structuredClone(workspaceWorkItemConfiguration),
              inheritedFrom: 'workspace',
            },
      })
      return
    }

    if (route.request().method() === 'PUT') {
      requestCounts.workItemConfigurationWrites += 1
      const body = route.request().postDataJSON() as WorkItemConfiguration
      const savedConfiguration = {
        ...structuredClone(body),
        scopeType: 'team',
        scopeId: teamId,
        revision: body.revision + 1,
        updatedAt: '2026-07-12T12:00:00.000Z',
      } satisfies WorkItemConfiguration

      teamWorkItemConfigurations[teamId] = savedConfiguration
      await route.fulfill({
        json: {
          configuration: structuredClone(savedConfiguration),
        },
      })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/teams/projects**', async (route) => {
    requestCounts.projectDirectory += 1

    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    await route.fulfill({
      json: {
        teams: projectDirectory,
      },
    })
  })

  await page.route('**/api/teams', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback()
      return
    }

    requestCounts.teamCreates += 1
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    const body = route.request().postDataJSON() as { name?: string }
    const name = body.name ?? '新規チーム'
    const team = {
      id: 'new-team',
      name,
      expanded: true,
      projects: [],
    }

    projectDirectory.push(team)

    await route.fulfill({
      status: 201,
      json: {
        team,
      },
    })
  })

  await page.route('**/api/teams/core-team/projects', async (route) => {
    requestCounts.projectCreates += 1
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    const body = route.request().postDataJSON() as { name?: string; tone?: string }
    const name = body.name ?? '新規プロジェクト'
    const project = {
      id: 'new-project',
      name,
      tone: 'green' as const,
    }

    projectDirectory[0]?.projects.push(project)
    taskResponsesByProject[project.id] = []
    projectMembersByProject[project.id] = [
      {
        id: 'demo@example.com',
        email: 'demo@example.com',
        name: 'Demo User',
        role: 'manager',
        updatedAt: '2026-06-08T00:00:00.000Z',
        workspaceStatus: 'active',
      },
    ]

    await route.fulfill({
      status: 201,
      json: {
        project,
      },
    })
  })

  await page.route(/.*\/api\/teams\/[^/]+\/archive$/, async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fallback()
      return
    }

    requestCounts.teamArchives += 1
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    const teamId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] ?? '')
    const teamIndex = projectDirectory.findIndex((team) => team.id === teamId)

    if (teamIndex >= 0) {
      projectDirectory.splice(teamIndex, 1)
    }

    await route.fulfill({
      json: {
        teamId,
        archivedAt: '2026-06-06T00:00:00.000Z',
      },
    })
  })

  await page.route(/.*\/api\/teams\/[^/]+\/projects\/[^/]+\/archive$/, async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fallback()
      return
    }

    requestCounts.projectArchives += 1
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    const pathSegments = new URL(route.request().url()).pathname.split('/')
    const teamId = decodeURIComponent(pathSegments[3] ?? '')
    const projectId = decodeURIComponent(pathSegments[5] ?? '')
    const team = projectDirectory.find((candidate) => candidate.id === teamId)

    if (team) {
      team.projects = team.projects.filter((project) => project.id !== projectId)
    }

    await new Promise((resolve) => setTimeout(resolve, 150))

    await route.fulfill({
      json: {
        teamId,
        projectId,
        archivedAt: '2026-06-06T00:00:00.000Z',
      },
    })
  })

  await page.route('**/api/projects/refero/tasks', async (route) => {
    recordProjectTaskRequest(requestCounts, 'refero')

    expect(route.request().headers().authorization).toBe('Bearer test-access-token')
    expect(route.request().method()).toBe('GET')

    await route.fulfill({
      json: {
        projectId: 'refero',
        tasks: [],
      },
    })
  })

  await page.route(/.*\/api\/projects\/[^/]+\/issues$/, async (route) => {
    const pathSegments = new URL(route.request().url()).pathname.split('/')
    const projectId = decodeURIComponent(pathSegments[3] ?? '')
    recordProjectTaskRequest(requestCounts, projectId)

    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    const projectIssues = taskResponsesByProject[projectId] ?? []
    const assignedIssues = Object.values(teamIssuesByTeam)
      .flat()
      .filter((issue) => issue.assignedProjectId === projectId)

    await route.fulfill({
      json: {
        projectId,
        issues: [...projectIssues, ...assignedIssues],
      },
    })
  })

  await page.route('**/api/work-items', async (route) => {
    requestCounts.workspaceWorkItems += 1
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    const projectWorkItems = Object.values(taskResponsesByProject).flat()

    await route.fulfill({
      json: {
        workItems: [...projectWorkItems, ...Object.values(teamIssuesByTeam).flat()],
      },
    })
  })

  await page.route('**/api/notifications/unread-count', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')
    await route.fulfill({
      json: {
        unreadCount: countUnreadNotifications(notifications),
      },
    })
  })

  await page.route('**/api/notifications/mark-all-read', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback()
      return
    }

    requestCounts.notificationUpdates += 1
    const updatedCount = countUnreadNotifications(notifications)
    const readAt = new Date().toISOString()
    notifications = notifications.map((notification) =>
      notification.state === 'unread'
        ? { ...notification, readAt, state: 'read' }
        : notification,
    )
    await route.fulfill({
      json: {
        unreadCount: countUnreadNotifications(notifications),
        updatedCount,
      },
    })
  })

  await page.route(/.*\/api\/notifications\/[^/?]+$/, async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fallback()
      return
    }

    requestCounts.notificationUpdates += 1
    const notificationId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1) ?? '')
    const body = route.request().postDataJSON() as {
      action?: 'archive' | 'mark-read' | 'mark-unread' | 'restore' | 'snooze'
      snoozedUntil?: string
    }
    const notification = notifications.find((candidate) => candidate.id === notificationId)

    if (!notification || !body.action) {
      await route.fulfill({ status: 404, json: { message: 'Notification not found.' } })
      return
    }

    const updatedStateFields = {
      ...notification,
      ...(body.action === 'mark-read' ? { readAt: new Date().toISOString() } : {}),
      ...(body.action === 'mark-unread' ? { readAt: undefined } : {}),
      ...(body.action === 'archive'
        ? { archivedAt: new Date().toISOString(), snoozedUntil: undefined }
        : {}),
      ...(body.action === 'restore'
        ? { archivedAt: undefined, snoozedUntil: undefined }
        : {}),
      ...(body.action === 'snooze'
        ? { archivedAt: undefined, snoozedUntil: body.snoozedUntil }
        : {}),
    }
    const updatedNotification: InboxNotification = {
      ...updatedStateFields,
      state: resolveMockNotificationState(updatedStateFields),
    }
    notifications = notifications.map((candidate) =>
      candidate.id === notificationId ? updatedNotification : candidate,
    )
    await route.fulfill({ json: updatedNotification })
  })

  await page.route(/.*\/api\/notifications(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback()
      return
    }

    requestCounts.notificationReads += 1
    const url = new URL(route.request().url())
    const filter = url.searchParams.get('filter') ?? 'all'
    const eventType = url.searchParams.get('type')
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '30', 10)
    const cursor = url.searchParams.get('cursor')
    const offset = cursor?.startsWith('offset:')
      ? Number.parseInt(cursor.slice('offset:'.length), 10)
      : 0
    const filteredNotifications = notifications.filter((notification) => {
      if (eventType && notification.eventType !== eventType) {
        return false
      }

      if (filter === 'archived') {
        return notification.state === 'archived'
      }
      if (filter === 'snoozed') {
        return notification.state === 'snoozed'
      }
      if (filter === 'unread') {
        return notification.state === 'unread'
      }
      if (filter === 'read') {
        return notification.state === 'read'
      }

      return notification.state === 'unread' || notification.state === 'read'
    })
    const pageNotifications = filteredNotifications.slice(offset, offset + limit)
    const nextOffset = offset + pageNotifications.length

    await route.fulfill({
      json: {
        notifications: pageNotifications,
        ...(nextOffset < filteredNotifications.length ? { nextCursor: `offset:${nextOffset}` } : {}),
        unreadCount: countUnreadNotifications(notifications),
      },
    })
  })

  await page.route('**/api/notification-preferences', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    if (route.request().method() === 'PUT') {
      requestCounts.notificationPreferenceUpdates += 1
      const input = route.request().postDataJSON() as NotificationPreferences
      notificationPreferences = {
        ...cloneNotificationPreferences(input),
        updatedAt: new Date().toISOString(),
        version: notificationPreferences.version + 1,
      }
    }

    await route.fulfill({ json: notificationPreferences })
  })

  await page.route(/.*\/api\/teams\/[^/]+\/issues$/, async (route) => {
    const teamId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] ?? '')
    const projects = projectDirectory.find((team) => team.id === teamId)?.projects ?? []

    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    if (route.request().method() === 'POST') {
      requestCounts.issueCreates += 1
      const body = route.request().postDataJSON() as {
        assignedProjectId?: string
        assigneeUserId?: string
        customFieldValues?: Record<string, CustomFieldValue>
        description?: string
        dueDate?: string
        priority?: TeamIssue['priority']
        title?: string
        workflowStatusId?: string
      }
      expect(body).not.toHaveProperty('status')
      const assigneeUser = projectUsers.find((user) => user.id === body.assigneeUserId)
      const configuration = teamWorkItemConfigurations[teamId] ?? workspaceWorkItemConfiguration
      const workflowStatus = configuration.workflow.statuses.find(
        (status) => status.id === body.workflowStatusId,
      )
      const issue = {
        schemaVersion: WORK_ITEM_SCHEMA_VERSION,
        revision: 1,
        id: body.title === '新規タスク' ? 'new-task' : createIssueId(body.title ?? '新規 Issue'),
        teamId,
        assignedProjectId: body.assignedProjectId || undefined,
        title: body.title ?? '新規 Issue',
        description: body.description,
        assigneeUserId: assigneeUser?.id ?? 'sato@example.com',
        creatorMemberKey: 'demo@example.com',
        assigneeEmail: assigneeUser?.email ?? 'sato@example.com',
        assigneeName: assigneeUser?.name ?? '佐藤 花子',
        workflowStatusId: workflowStatus?.id ?? configuration.workflow.initialStatusId,
        statusCategory: workflowStatus?.category ?? configuration.workflow.statuses.find(
          (status) => status.id === configuration.workflow.initialStatusId,
        )!.category,
        workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
        customFieldValues: structuredClone(body.customFieldValues ?? {}),
        relationIds: [],
        dueDate: body.dueDate ?? '2026/06/20',
        priority: body.priority ?? 'medium',
        createdAt: '2026-06-08T00:00:00.000Z',
        updatedAt: '2026-06-08T00:00:00.000Z',
        source: 'dynamodb',
      } satisfies TeamIssue

      teamIssuesByTeam[teamId] = [...(teamIssuesByTeam[teamId] ?? []), issue]

      await route.fulfill({
        status: 201,
        json: {
          issue,
        },
      })
      return
    }

    requestCounts.issueReads += 1
    const projectIssues = projects.flatMap((project) =>
      (taskResponsesByProject[project.id] ?? []).filter((issue) => issue.teamId === teamId),
    )

    await route.fulfill({
      json: {
        teamId,
        issues: [...projectIssues, ...(teamIssuesByTeam[teamId] ?? [])],
      },
    })
  })

  await page.route(/.*\/api\/teams\/[^/]+\/issues\/[^/]+$/, async (route) => {
    const pathSegments = new URL(route.request().url()).pathname.split('/')
    const teamId = decodeURIComponent(pathSegments[3] ?? '')
    const issueId = decodeURIComponent(pathSegments[5] ?? '')
    const issue = findTeamIssue(teamIssuesByTeam, teamId, issueId)
      ?? Object.values(taskResponsesByProject)
        .flat()
        .find((candidate) => candidate.teamId === teamId && candidate.id === issueId)

    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    if (!issue) {
      await route.fulfill({
        status: 404,
        json: {
          message: 'Issue was not found.',
        },
      })
      return
    }

    if (route.request().method() === 'PATCH') {
      requestCounts.issueUpdates += 1
      const body = route.request().postDataJSON() as Partial<TeamIssue> & {
        assignedProjectId?: string | null
        expectedRevision?: number
      }
      expect(body).not.toHaveProperty('status')
      const { expectedRevision, ...patch } = body

      expect(expectedRevision).toBe(issue.revision)
      const conflictIssueKey = createIssueCollaborationKey(teamId, issueId)

      if (pendingRevisionConflictIssueKeys.delete(conflictIssueKey)) {
        replaceStoredWorkItem(taskResponsesByProject, teamIssuesByTeam, teamId, {
          ...issue,
          description: '別のメンバーが更新した最新内容です。',
          revision: issue.revision + 1,
          statusCategory: 'started',
          workflowStatusId: 'review',
          updatedAt: '2026-06-08T02:30:00.000Z',
        })
        await route.fulfill({
          status: 409,
          json: {
            code: 'WorkItemRevisionConflict',
            message: 'Work Item changed after it was loaded.',
          },
        })
        return
      }

      const updateResult = body.workflowStatusId
        ? await onTaskStatusUpdate?.(issueId, body.workflowStatusId)
        : undefined

      if (updateResult === 'fail') {
        await route.fulfill({
          status: 500,
          json: {
            message: 'issues.error.update',
          },
        })
        return
      }

      const updatedWorkflowStatus = (
        teamWorkItemConfigurations[teamId] ?? workspaceWorkItemConfiguration
      ).workflow.statuses.find((status) => status.id === body.workflowStatusId)
      const updatedIssue = {
        ...issue,
        ...patch,
        assignedProjectId: body.assignedProjectId === null
          ? undefined
          : body.assignedProjectId ?? issue.assignedProjectId,
        statusCategory: updatedWorkflowStatus?.category ?? issue.statusCategory,
        workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
        revision: issue.revision + 1,
        updatedAt: '2026-06-08T02:00:00.000Z',
      } satisfies TeamIssue
      replaceStoredWorkItem(taskResponsesByProject, teamIssuesByTeam, teamId, updatedIssue)

      await route.fulfill({
        json: {
          issue: updatedIssue,
        },
      })
      return
    }

    const teamConfiguration = teamWorkItemConfigurations[teamId]
    const collaborationKey = createIssueCollaborationKey(teamId, issueId)

    await route.fulfill({
      json: {
        issue,
        comments: issueCommentsByIssue[createIssueCollaborationKey(teamId, issueId)] ?? [
          {
            id: 'comment-1',
            actorUserId: 'demo@example.com',
            body: '背景を確認します。',
            createdAt: '2026-06-08T01:00:00.000Z',
          },
        ],
        activity: issueActivityByIssue[createIssueCollaborationKey(teamId, issueId)] ?? [
          {
            id: 'activity-1',
            type: 'created',
            actorUserId: 'demo@example.com',
            summary: 'Issue was created.',
            createdAt: '2026-06-08T00:00:00.000Z',
          },
        ],
        resolvedConfiguration: teamConfiguration
          ? { configuration: structuredClone(teamConfiguration) }
          : {
              configuration: structuredClone(workspaceWorkItemConfiguration),
              inheritedFrom: 'workspace',
            },
        relations: structuredClone(workItemRelationsByIssue[collaborationKey] ?? []),
        relationGraphRevision: relationGraphRevisionByTeam[teamId] ?? 0,
      },
    })
  })

  await page.route(/.*\/api\/teams\/[^/]+\/issues\/[^/]+\/files$/, async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')
    await route.fulfill({
      status: 200,
      json: {
        approvals: [],
        capabilities: { canRequestApproval: true, canUpload: true },
        files: [],
      },
    })
  })

  await page.route(/.*\/api\/teams\/[^/]+\/issues\/[^/]+\/relations$/, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback()
      return
    }

    requestCounts.workItemRelationCreates += 1
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    const pathSegments = new URL(route.request().url()).pathname.split('/')
    const teamId = decodeURIComponent(pathSegments[3] ?? '')
    const sourceWorkItemId = decodeURIComponent(pathSegments[5] ?? '')
    const body = route.request().postDataJSON() as {
      expectedGraphRevision?: number
      targetWorkItemId?: string
      type?: WorkItemRelationType
    }
    const targetWorkItemId = body.targetWorkItemId ?? ''
    const relationType = body.type ?? 'related'
    const currentGraphRevision = relationGraphRevisionByTeam[teamId] ?? 0

    expect(body.expectedGraphRevision).toBe(currentGraphRevision)

    const relation = {
      sourceWorkItemId,
      targetWorkItemId,
      type: relationType,
      createdAt: '2026-07-12T12:30:00.000Z',
    } satisfies WorkItemRelation
    const reciprocalRelation = {
      sourceWorkItemId: targetWorkItemId,
      targetWorkItemId: sourceWorkItemId,
      type: reciprocalWorkItemRelationTypes[relationType],
      createdAt: relation.createdAt,
    } satisfies WorkItemRelation
    const sourceKey = createIssueCollaborationKey(teamId, sourceWorkItemId)
    const targetKey = createIssueCollaborationKey(teamId, targetWorkItemId)

    workItemRelationsByIssue[sourceKey] = [
      ...(workItemRelationsByIssue[sourceKey] ?? []).filter(
        (candidate) =>
          candidate.type !== relation.type || candidate.targetWorkItemId !== targetWorkItemId,
      ),
      relation,
    ]
    workItemRelationsByIssue[targetKey] = [
      ...(workItemRelationsByIssue[targetKey] ?? []).filter(
        (candidate) =>
          candidate.type !== reciprocalRelation.type ||
          candidate.targetWorkItemId !== sourceWorkItemId,
      ),
      reciprocalRelation,
    ]
    relationGraphRevisionByTeam[teamId] = currentGraphRevision + 1

    await route.fulfill({
      status: 201,
      json: {
        relation,
        reciprocalRelation,
        graphRevision: relationGraphRevisionByTeam[teamId],
      },
    })
  })

  await page.route(/.*\/api\/teams\/[^/]+\/projects\/[^/]+\/files$/, async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')
    await route.fulfill({
      status: 200,
      json: {
        approvals: [],
        capabilities: { canRequestApproval: false, canUpload: true },
        files: [],
      },
    })
  })

  await page.route(
    /.*\/api\/teams\/[^/]+\/issues\/[^/]+\/relations\/[^/]+\/[^/]+$/,
    async (route) => {
      if (route.request().method() !== 'DELETE') {
        await route.fallback()
        return
      }

      requestCounts.workItemRelationDeletes += 1
      expect(route.request().headers().authorization).toBe('Bearer test-access-token')

      const pathSegments = new URL(route.request().url()).pathname.split('/')
      const teamId = decodeURIComponent(pathSegments[3] ?? '')
      const sourceWorkItemId = decodeURIComponent(pathSegments[5] ?? '')
      const targetWorkItemId = decodeURIComponent(pathSegments[7] ?? '')
      const relationType = decodeURIComponent(pathSegments[8] ?? '') as WorkItemRelationType
      const body = route.request().postDataJSON() as { expectedGraphRevision?: number }
      const currentGraphRevision = relationGraphRevisionByTeam[teamId] ?? 0

      expect(body.expectedGraphRevision).toBe(currentGraphRevision)

      const relation = {
        sourceWorkItemId,
        targetWorkItemId,
        type: relationType,
      } satisfies WorkItemRelation
      const reciprocalRelation = {
        sourceWorkItemId: targetWorkItemId,
        targetWorkItemId: sourceWorkItemId,
        type: reciprocalWorkItemRelationTypes[relationType],
      } satisfies WorkItemRelation
      const sourceKey = createIssueCollaborationKey(teamId, sourceWorkItemId)
      const targetKey = createIssueCollaborationKey(teamId, targetWorkItemId)

      workItemRelationsByIssue[sourceKey] = (workItemRelationsByIssue[sourceKey] ?? []).filter(
        (candidate) =>
          candidate.type !== relation.type || candidate.targetWorkItemId !== targetWorkItemId,
      )
      workItemRelationsByIssue[targetKey] = (workItemRelationsByIssue[targetKey] ?? []).filter(
        (candidate) =>
          candidate.type !== reciprocalRelation.type ||
          candidate.targetWorkItemId !== sourceWorkItemId,
      )
      relationGraphRevisionByTeam[teamId] = currentGraphRevision + 1

      await route.fulfill({
        json: {
          relation,
          reciprocalRelation,
          graphRevision: relationGraphRevisionByTeam[teamId],
        },
      })
    },
  )

  await page.route(/.*\/api\/teams\/[^/]+\/issues\/[^/]+\/collaboration(?:\?.*)?$/, async (route) => {
    const pathSegments = new URL(route.request().url()).pathname.split('/')
    const teamId = decodeURIComponent(pathSegments[3] ?? '')
    const issueId = decodeURIComponent(pathSegments[5] ?? '')
    const collaborationKey = createIssueCollaborationKey(teamId, issueId)

    await route.fulfill({
      json: {
        comments: issueCommentsByIssue[collaborationKey] ?? [
          {
            id: 'comment-1',
            rootCommentId: 'comment-1',
            authorMemberKey: 'demo@example.com',
            bodyMarkdown: '背景を確認します。',
            version: 1,
            createdAt: '2026-06-08T01:00:00.000Z',
            updatedAt: '2026-06-08T01:00:00.000Z',
            mentionMemberKeys: [],
            reactions: [],
            capabilities: { canEdit: true, canDelete: true, canResolve: true },
          },
        ],
        watch: {
          subscribed: false,
          explicit: false,
          automatic: false,
          reasons: [],
          watcherCount: 0,
        },
        presence: [],
        capabilities: { canComment: true, canReact: true, canWatch: true },
      },
    })
  })

  await page.route(/.*\/api\/teams\/[^/]+\/issues\/[^/]+\/activity(?:\?.*)?$/, async (route) => {
    const pathSegments = new URL(route.request().url()).pathname.split('/')
    const teamId = decodeURIComponent(pathSegments[3] ?? '')
    const issueId = decodeURIComponent(pathSegments[5] ?? '')
    const collaborationKey = createIssueCollaborationKey(teamId, issueId)

    await route.fulfill({
      json: {
        events: (issueActivityByIssue[collaborationKey] ?? []).map((activity) => ({
          eventId: activity.id,
          eventType: activity.type === 'commented' ? 'comment.created' : `work-item.${activity.type}`,
          occurredAt: activity.createdAt,
          actorUserId: activity.actorUserId,
          summary: activity.summary,
        })),
      },
    })
  })

  await page.route(/.*\/api\/teams\/[^/]+\/issues\/[^/]+\/watch$/, async (route) => {
    await route.fulfill({
      json: {
        watch: {
          subscribed: route.request().method() === 'PUT',
          explicit: route.request().method() === 'PUT',
          automatic: false,
          reasons: [],
          watcherCount: route.request().method() === 'PUT' ? 1 : 0,
        },
      },
    })
  })

  await page.route(/.*\/api\/teams\/[^/]+\/issues\/[^/]+\/presence(?:\/[^/?]+)?$/, async (route) => {
    await route.fulfill({ json: {} })
  })

  await page.route('**/api/realtime/tickets', async (route) => {
    await route.fulfill({ status: 503, json: { message: 'Use polling fallback.' } })
  })

  await page.route(/.*\/api\/teams\/[^/]+\/issues\/[^/]+\/comments$/, async (route) => {
    requestCounts.issueComments += 1
    const pathSegments = new URL(route.request().url()).pathname.split('/')
    const teamId = decodeURIComponent(pathSegments[3] ?? '')
    const issueId = decodeURIComponent(pathSegments[5] ?? '')
    const collaborationKey = createIssueCollaborationKey(teamId, issueId)
    const body = route.request().postDataJSON() as { body?: string; bodyMarkdown?: string }
    const comment = {
      id: `comment-${requestCounts.issueComments + 1}`,
      rootCommentId: `comment-${requestCounts.issueComments + 1}`,
      authorMemberKey: 'demo@example.com',
      bodyMarkdown: body.bodyMarkdown ?? body.body ?? '追加コメント',
      version: 1,
      createdAt: '2026-06-08T02:00:00.000Z',
      updatedAt: '2026-06-08T02:00:00.000Z',
      mentionMemberKeys: [],
      reactions: [],
      capabilities: { canEdit: true, canDelete: true, canResolve: true },
    } satisfies TeamIssueComment
    const activity = {
      id: `activity-${requestCounts.issueComments + 1}`,
      type: 'commented',
      actorUserId: 'demo@example.com',
      summary: 'Comment was added.',
      createdAt: '2026-06-08T02:00:00.000Z',
    } satisfies TeamIssueActivity

    issueCommentsByIssue[collaborationKey] = [...(issueCommentsByIssue[collaborationKey] ?? []), comment]
    issueActivityByIssue[collaborationKey] = [...(issueActivityByIssue[collaborationKey] ?? []), activity]

    await route.fulfill({
      status: 201,
      json: {
        comment,
        activity,
      },
    })
  })

  await page.route(/.*\/api\/projects\/[^/]+\/users(?:\?.*)?$/, async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    const url = new URL(route.request().url())
    const query = url.searchParams.get('query')?.trim().toLowerCase() ?? ''
    const nextToken = url.searchParams.get('nextToken')
    let users = query
      ? projectUsers.filter((user) => user.email.toLowerCase().startsWith(query))
      : projectUsers
    const responseNextToken = !query && !nextToken ? 'project-users-page-2' : undefined

    if (!query && !nextToken) {
      users = projectUsers.slice(0, 2)
    } else if (!query && nextToken === 'project-users-page-2') {
      users = projectUsers.slice(2)
    }

    requestCounts.projectUserReads += 1

    await route.fulfill({
      json: {
        nextToken: responseNextToken,
        users,
      },
    })
  })

  await page.route(/.*\/api\/projects\/[^/]+\/members(?:\/[^/]+)?$/, async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    const pathSegments = new URL(route.request().url()).pathname.split('/')
    const projectId = decodeURIComponent(pathSegments[3] ?? '')
    const memberKey = pathSegments[5] ? decodeURIComponent(pathSegments[5]) : undefined
    const members = projectMembersByProject[projectId] ?? []

    if (route.request().method() === 'GET') {
      requestCounts.projectMemberReads += 1
      await route.fulfill({
        json: {
          projectId,
          members,
        },
      })
      return
    }

    if (route.request().method() === 'PATCH' && memberKey) {
      requestCounts.projectMemberUpdates += 1
      const body = route.request().postDataJSON() as {
        role?: ProjectMemberRole
      }
      const existingMember = members.find((member) => member.id === memberKey)
      const projectUser = projectUsers.find((user) => user.id === memberKey)
      const member = {
        id: memberKey,
        email: projectUser?.email ?? memberKey,
        name: projectUser?.name,
        username: projectUser?.username,
        enabled: projectUser?.enabled,
        status: projectUser?.status,
        role: body.role ?? 'viewer',
        updatedAt: '2026-06-08T00:00:00.000Z',
      } satisfies ProjectMember

      if (existingMember) {
        Object.assign(existingMember, member)
      } else {
        members.push(member)
        projectMembersByProject[projectId] = members
      }

      await route.fulfill({
        json: {
          member,
        },
      })
      return
    }

    if (route.request().method() === 'DELETE' && memberKey) {
      requestCounts.projectMemberRemoves += 1
      projectMembersByProject[projectId] = members.filter((member) => member.id !== memberKey)
      await route.fulfill({
        json: {
          projectId,
          memberId: memberKey,
        },
      })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/projects/product-roadmap/tasks', async (route) => {
    recordProjectTaskRequest(requestCounts, 'product-roadmap')

    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    await route.fulfill({
      json: {
        projectId: 'product-roadmap',
        tasks: [],
      },
    })
  })

  await page.route('**/api/projects/brand-refresh/tasks', async (route) => {
    recordProjectTaskRequest(requestCounts, 'brand-refresh')

    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    await route.fulfill({
      json: {
        projectId: 'brand-refresh',
        tasks: [],
      },
    })
  })

  await page.route('**/api/projects/shared-launch/tasks', async (route) => {
    recordProjectTaskRequest(requestCounts, 'shared-launch')

    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    await route.fulfill({
      json: {
        projectId: 'shared-launch',
        tasks: [],
      },
    })
  })

  await page.route('**/api/projects/new-project/tasks', async (route) => {
    recordProjectTaskRequest(requestCounts, 'new-project')

    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    await route.fulfill({
      json: {
        projectId: 'new-project',
        tasks: [],
      },
    })
  })

}

function createDefaultNotifications(): InboxNotification[] {
  return [
    {
      actorLabel: '佐藤 花子',
      commentId: 'comment-1',
      eventType: 'comment.mentioned',
      id: 'notification-wireframe',
      issueId: 'wireframe',
      occurredAt: '2026-07-12T03:20:00.000Z',
      projectId: 'refero',
      reasons: ['mention'],
      summary: 'コメントであなたに確認を依頼しました。',
      teamId: 'core-team',
      title: 'ワイヤーフレームを作成',
      state: 'unread',
    },
    {
      actorLabel: 'Demo User',
      eventType: 'work-item.updated',
      id: 'notification-brand-guideline',
      issueId: 'brand-guideline',
      occurredAt: '2026-07-11T05:00:00.000Z',
      projectId: 'refero',
      readAt: '2026-07-11T05:05:00.000Z',
      reasons: ['watcher'],
      summary: '状態がレビュー待ちに更新されました。',
      teamId: 'core-team',
      title: 'ブランドガイドラインを整理',
      state: 'read',
    },
    {
      archivedAt: '2026-07-10T02:00:00.000Z',
      eventType: 'comment.created',
      id: 'notification-archived-unread',
      occurredAt: '2026-07-10T02:00:00.000Z',
      reasons: ['watcher'],
      state: 'archived',
      title: 'アーカイブ済みの未読通知',
    },
    {
      eventType: 'comment.created',
      id: 'notification-snoozed-unread',
      occurredAt: '2026-07-10T01:00:00.000Z',
      reasons: ['watcher'],
      snoozedUntil: '2099-07-12T09:00:00.000Z',
      state: 'snoozed',
      title: 'スヌーズ中の未読通知',
    },
  ]
}

function createDefaultNotificationPreferences(): NotificationPreferences {
  return {
    channels: {
      email: true,
      inApp: true,
      push: false,
    },
    frequency: 'instant',
    quietHours: {
      enabled: true,
      end: '08:00',
      start: '22:00',
      timeZone: 'Asia/Tokyo',
    },
    updatedAt: '2026-07-12T00:00:00.000Z',
    version: 2,
  }
}

function cloneNotificationPreferences(
  preferences: NotificationPreferences,
): NotificationPreferences {
  return {
    ...preferences,
    channels: { ...preferences.channels },
    quietHours: { ...preferences.quietHours },
  }
}

function countUnreadNotifications(notifications: InboxNotification[]) {
  return notifications.filter((notification) => notification.state === 'unread').length
}

function resolveMockNotificationState(
  notification: Pick<
    InboxNotification,
    'archivedAt' | 'readAt' | 'snoozedUntil'
  >,
): InboxNotification['state'] {
  if (notification.archivedAt) {
    return 'archived'
  }
  if (
    notification.snoozedUntil &&
    new Date(notification.snoozedUntil).getTime() > notificationFixtureNow.getTime()
  ) {
    return 'snoozed'
  }
  return notification.readAt ? 'read' : 'unread'
}

function getMockRequestCounts(page: Page) {
  const requestCounts = mockRequestCountsByPage.get(page)

  if (!requestCounts) {
    throw new Error('mockAuthenticatedTaskPage must run before reading request counts.')
  }

  return requestCounts
}

/**
 * Analytics E2E mock が記録する request です。
 */
type MockAnalyticsRequestState = {
  /** Live analytics query API へ送信された入力です。 */
  queryInputs: AnalyticsQueryInput[]
  /** Analytics export API へ送信された入力です。 */
  exportInputs: AnalyticsExportInput[]
}

/**
 * 現行 ReportsPage が利用するAnalytics APIを固定fixtureへ差し替えます。
 *
 * @param page - API routeを差し替えるPlaywright pageです。
 * @returns Queryとexportの送信内容を確認するstateです。
 */
async function mockAnalyticsReportsPage(
  page: Page,
): Promise<MockAnalyticsRequestState> {
  const state: MockAnalyticsRequestState = {
    exportInputs: [],
    queryInputs: [],
  }

  await page.route(
    /.*\/api\/analytics\/reports(?:\?.*)?$/,
    async (route) => {
      await route.fulfill({
        json: {
          reports: [structuredClone(analyticsReportFixtures[0])],
        },
      })
    },
  )

  await page.route(
    /.*\/api\/analytics\/reports\/[^/]+\/snapshots(?:\?.*)?$/,
    async (route) => {
      await route.fulfill({
        json: {
          inspectedCount: 0,
          snapshots: [],
        },
      })
    },
  )

  await page.route('**/api/analytics/query', async (route) => {
    const input = route.request().postDataJSON() as AnalyticsQueryInput
    state.queryInputs.push(structuredClone(input))
    await route.fulfill({
      json: {
        snapshot: {
          ...structuredClone(analyticsSnapshotFixture),
          asOf: input.asOf,
          filter: input.filter,
          timeZone: input.timeZone,
        },
      },
    })
  })

  await page.route('**/api/analytics/export', async (route) => {
    state.exportInputs.push(
      structuredClone(route.request().postDataJSON() as AnalyticsExportInput),
    )
    await route.fulfill({
      body: 'metric,value\nwip,14\noverdue,5\n',
      headers: {
        'Content-Disposition': 'attachment; filename="mukuroji-analytics.csv"',
        'Content-Type': 'text/csv; charset=utf-8',
      },
    })
  })

  return state
}

/**
 * サイドバーの新規登録パネルを開きます。
 */
async function openSidebarCreatePanel(page: Page) {
  await page.getByRole('button', { name: '新規登録' }).click()
  await page.getByRole('button', { name: 'チーム', exact: true }).click()
  await expect(page.getByLabel('チーム名')).toBeVisible()
}

function recordProjectTaskRequest(requestCounts: MockRequestCounts, projectId: string) {
  requestCounts.projectTasks[projectId] = (requestCounts.projectTasks[projectId] ?? 0) + 1
}

async function expectDesktopAppShellScrollsInsideMain(page: Page) {
  await expect(page.getByLabel('メインサイドバー')).toBeVisible()
  await expect.poll(
    async () => (await readDesktopAppShellState(page)).hasScrollableMainContent,
  ).toBe(true)

  const initialState = await readDesktopAppShellState(page)

  expect(Math.abs(initialState.sidebarTop)).toBeLessThanOrEqual(1)
  expect(Math.abs(initialState.sidebarHeight - initialState.viewportHeight)).toBeLessThanOrEqual(1)
  expect(Math.abs(initialState.mainHeight - initialState.viewportHeight)).toBeLessThanOrEqual(1)

  await scrollDesktopMainContent(page)

  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  await expect.poll(async () => (await readDesktopAppShellState(page)).mainScrollTop).toBeGreaterThan(0)

  const scrolledState = await readDesktopAppShellState(page)

  expect(Math.abs(scrolledState.sidebarTop)).toBeLessThanOrEqual(1)
  expect(Math.abs(scrolledState.sidebarHeight - scrolledState.viewportHeight)).toBeLessThanOrEqual(1)
}

async function scrollDesktopMainContent(page: Page) {
  await page.evaluate(() => {
    const scrollContainers = Array.from(
      document.querySelectorAll<HTMLElement>('main section, main div'),
    ).filter((element) => {
      const { overflowY } = window.getComputedStyle(element)

      return (
        (overflowY === 'auto' || overflowY === 'scroll') &&
        element.scrollHeight > element.clientHeight + 1
      )
    })
    const scrollTarget = scrollContainers.reduce<HTMLElement | undefined>((currentTarget, element) => {
      if (!currentTarget) {
        return element
      }

      const currentScrollableHeight = currentTarget.scrollHeight - currentTarget.clientHeight
      const nextScrollableHeight = element.scrollHeight - element.clientHeight

      return nextScrollableHeight > currentScrollableHeight ? element : currentTarget
    }, undefined)

    scrollTarget?.scrollTo({ top: 160 })
  })
}

async function readDesktopAppShellState(page: Page) {
  return page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>('aside[aria-label="メインサイドバー"]')
    const main = document.querySelector<HTMLElement>('main')
    const scrollContainers = Array.from(
      document.querySelectorAll<HTMLElement>('main section, main div'),
    ).filter((element) => {
      const { overflowY } = window.getComputedStyle(element)

      return (
        (overflowY === 'auto' || overflowY === 'scroll') &&
        element.scrollHeight > element.clientHeight + 1
      )
    })
    const sidebarRect = sidebar?.getBoundingClientRect()
    const mainRect = main?.getBoundingClientRect()

    return {
      hasScrollableMainContent: scrollContainers.length > 0,
      mainHeight: mainRect?.height ?? 0,
      mainScrollTop: Math.max(0, ...scrollContainers.map((element) => element.scrollTop)),
      sidebarHeight: sidebarRect?.height ?? 0,
      sidebarTop: sidebarRect?.top ?? Number.NaN,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    }
  })
}

function createStoredTeamIssue(
  overrides: Partial<TeamIssue> & Pick<TeamIssue, 'id' | 'title'>,
): TeamIssue {
  const workflowStatusId = overrides.workflowStatusId ?? 'todo'
  const statusCategory = overrides.statusCategory ?? (
    workflowStatusId === 'done'
      ? 'completed'
      : workflowStatusId === 'in-progress' || workflowStatusId === 'review'
        ? 'started'
        : 'unstarted'
  )

  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    teamId: 'core-team',
    assignedProjectId: 'refero',
    description: 'My Tasks の移動操作を検証する Issue です。',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'sato@example.com',
    assigneeEmail: 'sato@example.com',
    assigneeName: '佐藤 花子',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/06/22',
    priority: 'medium',
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
    source: 'dynamodb',
    statusCategory,
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    workflowStatusId,
    ...overrides,
  }
}

function createIssueId(title: string) {
  return title
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'new-issue'
}

/**
 * 同じ issue ID を持つ別 team の collaboration state を分離します。
 */
function createIssueCollaborationKey(teamId: string, issueId: string) {
  return `${teamId}\u0000${issueId}`
}

function findTeamIssue(
  teamIssuesByTeam: Record<string, TeamIssue[]>,
  teamId: string,
  issueId: string,
) {
  return teamIssuesByTeam[teamId]?.find((candidate) => candidate.id === issueId)
}

/**
 * E2E mock の Team Issue を同じ team/id の最新 revision へ置き換えます。
 *
 * @param teamIssuesByTeam - team ごとの保存済み Issue mock です。
 * @param teamId - 更新対象の team ID です。
 * @param issue - 保存する最新 Issue です。
 */
function replaceStoredTeamIssue(
  teamIssuesByTeam: Record<string, TeamIssue[]>,
  teamId: string,
  issue: TeamIssue,
) {
  const issues = teamIssuesByTeam[teamId] ?? []
  const issueIndex = issues.findIndex((candidate) => candidate.id === issue.id)

  if (issueIndex >= 0) {
    issues[issueIndex] = issue
    return
  }

  teamIssuesByTeam[teamId] = [...issues, issue]
}

/**
 * E2E mock の canonical Work Item を保存元の project または Team store で更新します。
 *
 * @param taskResponsesByProject - project ごとの canonical Work Item mock です。
 * @param teamIssuesByTeam - Team ごとの canonical Work Item mock です。
 * @param teamId - 更新対象の Team ID です。
 * @param issue - 保存する最新 Work Item です。
 */
function replaceStoredWorkItem(
  taskResponsesByProject: Record<string, ProjectTask[]>,
  teamIssuesByTeam: Record<string, TeamIssue[]>,
  teamId: string,
  issue: TeamIssue,
) {
  for (const [projectId, projectIssues] of Object.entries(taskResponsesByProject)) {
    const issueIndex = projectIssues.findIndex(
      (candidate) => candidate.teamId === teamId && candidate.id === issue.id,
    )

    if (issueIndex < 0) {
      continue
    }

    if (issue.assignedProjectId === projectId) {
      projectIssues[issueIndex] = issue
      return
    }

    projectIssues.splice(issueIndex, 1)
    if (issue.assignedProjectId) {
      taskResponsesByProject[issue.assignedProjectId] = [
        ...(taskResponsesByProject[issue.assignedProjectId] ?? []),
        issue,
      ]
    } else {
      replaceStoredTeamIssue(teamIssuesByTeam, teamId, issue)
    }
    return
  }

  replaceStoredTeamIssue(teamIssuesByTeam, teamId, issue)
}

/**
 * チーム Issue 作成フォームと詳細ペインが同じカラム内に収まっていることを検証します。
 *
 * @param page - レイアウト検証対象の Playwright page です。
 */
async function expectTeamIssueLayoutToStayInsideColumns(page: Page) {
  await page.waitForSelector('[data-testid="create-issue-form"]', { state: 'visible' })
  await page.waitForSelector('main > section aside', { state: 'visible' })

  const result = await page.evaluate(() => {
    const createForm = document.querySelector('[data-testid="create-issue-form"]')
    const detailPane = document.querySelector('main > section aside')

    if (!createForm || !detailPane) {
      return {
        detailOverflows: ['missing detail pane or create form'],
        formOverflows: ['missing detail pane or create form'],
      }
    }

    const detailRect = detailPane.getBoundingClientRect()
    const formControls = Array.from(createForm.querySelectorAll('input, select, textarea, button'))
    const detailControls = Array.from(
      detailPane.querySelectorAll<HTMLElement>('input, select, textarea, button'),
    ).filter((element) => element.getClientRects().length > 0)
    const formOverflows = formControls.flatMap((element) => {
      const rect = element.getBoundingClientRect()

      return rect.right > detailRect.left + 1
        ? [`${element.tagName.toLowerCase()} ${Math.round(rect.right)} > ${Math.round(detailRect.left)}`]
        : []
    })
    const detailOverflows = detailControls.flatMap((element) => {
      const rect = element.getBoundingClientRect()

      return rect.left < detailRect.left - 1 || rect.right > detailRect.right + 1
        ? [`${element.tagName.toLowerCase()} "${element.getAttribute('aria-label') ?? element.textContent?.trim() ?? ''}" ${Math.round(rect.left)}-${Math.round(rect.right)} outside ${Math.round(detailRect.left)}-${Math.round(detailRect.right)}`]
        : []
    })

    return { detailOverflows, formOverflows }
  })

  expect(result.formOverflows).toEqual([])
  expect(result.detailOverflows).toEqual([])
}

/**
 * タスク作成パネルと詳細ペインが split-pane の範囲内に収まっていることを検証します。
 *
 * @param page - レイアウト検証対象の Playwright page です。
 */
async function expectTaskSplitPaneLayoutToStayInsideColumns(page: Page) {
  await page.waitForSelector('[data-testid="create-task-form"]', { state: 'visible' })
  await page.waitForSelector('[data-testid="task-detail-pane"]', { state: 'visible' })

  const result = await page.evaluate(() => {
    const createForm = document.querySelector('[data-testid="create-task-form"]')
    const detailPane = document.querySelector('[data-testid="task-detail-pane"]')

    if (!createForm || !detailPane) {
      return {
        detailOverflows: ['missing detail pane or create form'],
        formOverflows: ['missing detail pane or create form'],
      }
    }

    const detailRect = detailPane.getBoundingClientRect()
    const formControls = Array.from(createForm.querySelectorAll('input, select, textarea, button'))
    const detailControls = Array.from(
      detailPane.querySelectorAll<HTMLElement>('input, select, textarea, button'),
    ).filter((element) => element.getClientRects().length > 0)
    const formOverflows = formControls.flatMap((element) => {
      const rect = element.getBoundingClientRect()

      return rect.right > detailRect.left + 1 && detailRect.top < rect.bottom && rect.top < detailRect.bottom
        ? [`${element.tagName.toLowerCase()} ${Math.round(rect.right)} > ${Math.round(detailRect.left)}`]
        : []
    })
    const detailOverflows = detailControls.flatMap((element) => {
      const rect = element.getBoundingClientRect()

      return rect.left < detailRect.left - 1 || rect.right > detailRect.right + 1
        ? [`${element.tagName.toLowerCase()} "${element.getAttribute('aria-label') ?? element.textContent?.trim() ?? ''}" ${Math.round(rect.left)}-${Math.round(rect.right)} outside ${Math.round(detailRect.left)}-${Math.round(detailRect.right)}`]
        : []
    })

    return { detailOverflows, formOverflows }
  })

  expect(result.formOverflows).toEqual([])
  expect(result.detailOverflows).toEqual([])
}

/**
 * Verifies the shared authenticated shell rendered by a direct Workspace route.
 *
 * @param page - Playwright page opened on a Workspace route.
 * @param title - Localized route title shown in the shell header.
 * @returns The visible desktop sidebar for route-specific navigation assertions.
 */
async function expectWorkspaceRouteShell(page: Page, title: string): Promise<Locator> {
  const shell = page.locator('main.workbench-shell')
  const sidebar = shell.locator('aside[aria-label="メインサイドバー"]:visible')

  await expect(shell).toBeVisible()
  await expect(sidebar).toBeVisible()
  await expect(
    shell.getByRole('heading', { level: 1, name: title, exact: true }),
  ).toBeVisible()
  await expect(shell.getByRole('button', { name: 'ログアウト', exact: true })).toBeVisible()
  await expect(page).toHaveTitle(`${title} | mukuroji`)

  return sidebar
}

test.describe('authenticated task page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthenticatedTaskPage(page)
  })

  test('command menuのquick createは同じ画面から繰り返し作成フォームを開く', async ({ page }) => {
    await page.goto('/projects/refero/issues?teamId=core-team')

    const searchTrigger = page.getByTestId('sidebar-search-trigger')
    await expect(searchTrigger).toBeVisible()
    await searchTrigger.focus()
    await page.keyboard.press('ControlOrMeta+K')
    await expect(page.getByRole('dialog', { name: 'Workspace command menu' }).getByRole('combobox')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(searchTrigger).toBeFocused()

    const openQuickCreate = async () => {
      await expect(page.getByTestId('sidebar-search-trigger')).toBeVisible()
      await page.keyboard.press('ControlOrMeta+K')
      const commandMenu = page.getByRole('dialog', { name: 'Workspace command menu' })
      await expect(commandMenu.getByRole('combobox')).toBeFocused()
      await commandMenu.getByRole('option', { name: /この一覧で Work Item を作成/ }).click()
    }

    await openQuickCreate()
    const createTaskForm = page.getByTestId('create-task-form')
    await expect(createTaskForm).toBeVisible()
    await expect(page).not.toHaveURL(/(?:\?|&)create=1(?:&|$)/)

    await createTaskForm.getByRole('button', { name: 'キャンセル' }).click()
    await expect(createTaskForm).toHaveCount(0)

    await openQuickCreate()
    await expect(createTaskForm).toBeVisible()

    await page.goto('/teams/core-team/issues')
    await openQuickCreate()
    await expect(page.getByTestId('create-issue-form')).toBeVisible()
    await expect(page).not.toHaveURL(/(?:\?|&)create=1(?:&|$)/)
  })

  test('タスク画面で検索、ステータス絞り込み、行選択が動作する', async ({ page }) => {
    await page.goto('/projects/refero/tasks')

    await expect(page.getByTestId('tasks-heading')).toBeVisible()
    await expect(page.getByTestId('task-row-wireframe')).toBeVisible()
    await expect(page.getByTestId('tasks-count')).toContainText('4')

    await page.getByRole('searchbox', { name: '検索...' }).fill('SEO')

    await expect(page.getByTestId('task-row-seo-research')).toBeVisible()
    await expect(page.getByTestId('task-row-brand-guideline')).toBeHidden()
    await expect(page.getByTestId('tasks-count')).toContainText('1')

    const searchbox = page.getByRole('searchbox', { name: '検索...' })
    const statusFilterButton = page.getByRole('button', {
      name: 'ステータス',
    })

    await searchbox.clear()
    await statusFilterButton.click()
    const statusOptions = page.getByRole('menuitemradio')

    await expect(statusOptions.first()).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(statusOptions.nth(1)).toBeFocused()
    await page.keyboard.press('End')
    await expect(statusOptions.last()).toBeFocused()
    await page.keyboard.press('Home')
    await expect(statusOptions.first()).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(statusFilterButton).toBeFocused()
    await expect(statusOptions).toHaveCount(0)

    await statusFilterButton.click()
    await searchbox.click()
    await expect(statusOptions).toHaveCount(0)

    await statusFilterButton.click()
    await expect(statusOptions.first()).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(statusOptions).toHaveCount(0)

    await statusFilterButton.click()
    await page.getByRole('menuitemradio', { name: '未着手' }).click()

    await expect(page.getByTestId('task-row-seo-research')).toBeVisible()
    await expect(page.getByTestId('task-row-wireframe')).toBeHidden()
    await expect(page.getByTestId('tasks-count')).toContainText('1')

    await page.getByRole('checkbox', { name: 'SEO キーワードリサーチ' }).check()

    await expect(page.getByTestId('task-row-seo-research')).toHaveAttribute(
      'data-selected',
      'true',
    )
  })

  test('プロジェクト切り替え時に bulk 選択を引き継がない', async ({ page }) => {
    await mockCurrentUser(page, 'demo@example.com', 'Demo User', 'workspace-demo')
    await page.goto('/projects/refero/issues?teamId=core-team')

    await page.getByRole('checkbox', { name: 'SEO キーワードリサーチ' }).check()
    await expect(page.getByTestId('bulk-selected-count')).toHaveText('1件を選択中')

    await page.getByRole('button', { name: 'ブランド刷新', exact: true }).click()

    await expect(page).toHaveURL('/projects/brand-refresh/issues?teamId=design-team')
    await expect(page.getByTestId('bulk-selected-count')).toHaveText('0件を選択中')
  })

  test('Issue toolbar で検索、ステータス絞り込み、テーブル/ボード切替が動作する', async ({ page }) => {
    await page.goto('/teams/core-team/issues')

    await expect(page.getByTestId('issue-row-wireframe')).toBeVisible()
    await expect(page.getByTestId('team-issues-count')).toContainText('4')

    await page.getByRole('searchbox', { name: 'Issue を検索...' }).fill('SEO')

    await expect(page.getByTestId('issue-row-seo-research')).toBeVisible()
    await expect(page.getByTestId('issue-row-wireframe')).toBeHidden()
    await expect(page.getByTestId('team-issues-count')).toContainText('1')

    await page.getByRole('searchbox', { name: 'Issue を検索...' }).clear()
    await page.getByRole('combobox', { name: 'Issue ステータス' }).selectOption('review')

    await expect(page.getByTestId('issue-row-brand-guideline')).toBeVisible()
    await expect(page.getByTestId('issue-row-wireframe')).toBeHidden()
    await expect(page.getByTestId('team-issues-count')).toContainText('1')

    const boardViewButton = page.getByRole('button', { name: 'ボード', exact: true })

    await boardViewButton.click()

    await expect(boardViewButton).toHaveAttribute('aria-pressed', 'true')
    await expect(
      page.getByRole('region', { name: 'ボード' }).getByText('ブランドガイドラインの更新'),
    ).toBeVisible()
  })

  test('Issue #21: 動的 workflow status と custom field で Team Issue を作成・表示できる', async ({ page }) => {
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      teamWorkItemConfigurations: {
        'core-team': teamWorkItemConfigurationFixture,
      },
    })
    await page.goto('/teams/core-team/issues')
    const requestCounts = getMockRequestCounts(page)

    await page.getByRole('button', { name: '新規 Issue' }).click()
    const createIssueForm = page.getByTestId('create-issue-form')

    await createIssueForm.locator('input[name="title"]').fill('Configurable delivery')
    await createIssueForm.locator('select[name="assignedProjectId"]').selectOption('refero')
    await createIssueForm.locator('select[name="assigneeUserId"]').selectOption('sato@example.com')
    await createIssueForm.locator('select[name="workflowStatusId"]').selectOption('active')
    await createIssueForm.getByLabel('Customer impact').fill(
      'Enterprise-customer-impact',
    )
    await createIssueForm.getByLabel('Story points').fill('8')
    await createIssueForm.getByLabel('Budget').fill('1200000')
    await createIssueForm.getByRole('button', { name: 'Issue を作成' }).click()

    const issueRow = page.getByTestId('issue-row-configurable-delivery').locator('..').locator('..')

    await expect(issueRow).toContainText('In progress')
    await expect(issueRow).toContainText(
      'Customer impact: Enterprise-customer-impact',
    )
    await expect(issueRow).toContainText('Story points: 8')
    await page.getByTestId('team-issues-category-filter').selectOption('started')
    await expect(issueRow).toBeVisible()
    await page.getByTestId('team-issues-custom-field-filter').selectOption('customer-impact')
    await page.locator('#team-issues-custom-field-value-filter').fill('enterprise-customer')
    await expect(issueRow).toBeVisible()
    await page.locator('#team-issues-custom-field-value-filter').fill('does-not-match')
    await expect(issueRow).toBeHidden()
    await page.goto('/projects/refero/issues?teamId=core-team&issueId=configurable-delivery')
    await page.getByTestId('project-tasks-category-filter').selectOption('started')
    await page.getByTestId('project-tasks-custom-field-filter').selectOption('story-points')
    await page.locator('#project-tasks-custom-field-value-filter').fill('8')
    await expect(page.getByTestId('task-row-configurable-delivery')).toBeVisible()
    await page.locator('#project-tasks-custom-field-value-filter').fill('5')
    await expect(page.getByTestId('task-row-configurable-delivery')).toBeHidden()
    await page.getByRole('button', { name: 'ブランド刷新', exact: true }).click()
    await expect(page).toHaveURL('/projects/brand-refresh/issues?teamId=design-team')
    await expect(page.getByTestId('project-tasks-custom-field-filter')).toHaveValue('')
    await expect(page.getByTestId('tasks-empty')).toBeVisible()
    expect(requestCounts.issueCreates).toBe(1)
    expect(requestCounts.workItemConfigurationReads).toBeGreaterThan(0)
  })

  test('Issue #21: configuration 取得失敗時はエラーを表示し更新を無効化する', async ({ page }) => {
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      failedWorkItemConfigurationTeamIds: ['core-team'],
      teamIssuesByTeam: {
        'core-team': [createStoredTeamIssue({
          id: 'configuration-failure',
          title: 'Configuration failure',
          workflowStatusId: 'in-progress',
        })],
      },
    })
    await page.goto('/teams/core-team/issues?issueId=configuration-failure')

    await expect(page.getByRole('alert')).toContainText(
      'Work Item 設定を取得できませんでした。',
    )
    await expect(page.getByRole('button', { name: '新規 Issue' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '変更を保存' })).toBeDisabled()
  })

  test('Issue #21: Team 内 Work Item relation を追加・解除できる', async ({ page }) => {
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      teamIssuesByTeam: {
        'core-team': [
          createStoredTeamIssue({
            id: 'relation-source',
            title: 'Relation source',
            workflowStatusId: 'in-progress',
          }),
          createStoredTeamIssue({
            assignedProjectId: 'product-roadmap',
            id: 'relation-target',
            title: 'Relation target',
            workflowStatusId: 'todo',
          }),
        ],
      },
      workItemRelationsByIssue: {
        [createIssueCollaborationKey('core-team', 'relation-source')]: [
          {
            sourceWorkItemId: 'relation-source',
            targetWorkItemId: 'wireframe',
            type: 'blocks',
            createdAt: '2026-07-12T08:00:00.000Z',
          },
        ],
      },
    })
    await page.goto('/teams/core-team/issues?issueId=relation-source')
    const requestCounts = getMockRequestCounts(page)
    const relationEditor = page.getByTestId('work-item-relations-editor')
    const relationTypeSelect = relationEditor.getByRole('combobox', { name: '関係', exact: true })

    await expect(relationEditor).toBeVisible()
    await relationTypeSelect.selectOption('blocks')
    await expect(
      relationEditor.getByLabel('対象 Work Item').locator('option[value="wireframe"]'),
    ).toHaveCount(0)
    await relationTypeSelect.selectOption('related')
    await expect(
      relationEditor.getByLabel('対象 Work Item').locator('option[value="wireframe"]'),
    ).toHaveCount(1)
    await relationEditor.getByLabel('対象 Work Item').selectOption('relation-target')
    await relationEditor.getByRole('button', { name: '関係を追加' }).click()

    const relationRow = page.getByTestId('work-item-relation-related-relation-target')

    await expect(relationRow).toContainText('関連')
    await expect(relationRow).toContainText('Relation target')
    await expect.poll(() => requestCounts.workItemRelationCreates).toBe(1)

    await relationRow.getByRole('button', { name: 'Relation target との関係を解除' }).click()

    await expect(relationRow).toHaveCount(0)
    await expect(page.getByTestId('work-item-relation-blocks-wireframe')).toBeVisible()
    await expect.poll(() => requestCounts.workItemRelationDeletes).toBe(1)

    await page.goto('/projects/refero/issues?teamId=core-team&issueId=relation-source')
    await expect(
      page.getByTestId('work-item-relations-editor').getByLabel('対象 Work Item'),
    ).toHaveValue('relation-target')
  })

  test('Issue #21: 設定画面で Team scope を選び configuration override を保存できる', async ({ page }) => {
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      workspaceWorkItemConfiguration: workspaceWorkItemConfigurationFixture,
    })
    await page.goto('/settings')
    const requestCounts = getMockRequestCounts(page)
    const configurationPanel = page.getByTestId('work-item-configuration-panel')

    await expect(configurationPanel).toBeVisible()
    await page.getByTestId('work-item-configuration-scope').selectOption('team:core-team')
    await expect(page.getByTestId('work-item-configuration-inherited')).toContainText(
      'Workspace の設定を継承しています。',
    )

    await configurationPanel.getByLabel('ワークフロー名').fill('Core team delivery')
    const riskOptionRows = configurationPanel.locator(
      '[data-testid^="custom-field-option-risk-level-"]',
    )

    await configurationPanel
      .getByTestId('custom-field-option-risk-level-high')
      .getByRole('button', { name: 'High を上へ移動' })
      .click()
    await expect(riskOptionRows).toHaveCount(3)
    await expect(riskOptionRows.nth(1)).toHaveAttribute(
      'data-testid',
      'custom-field-option-risk-level-high',
    )
    await configurationPanel
      .getByTestId('workflow-status-backlog')
      .getByRole('button', { name: 'Backlog を削除' })
      .click()
    await configurationPanel
      .getByTestId('custom-field-definition-target-date')
      .getByRole('button', { name: 'Target date を削除' })
      .click()
    const saveRequestPromise = page.waitForRequest((request) =>
      request.method() === 'PUT' &&
      new URL(request.url()).pathname.endsWith(
        '/api/teams/core-team/work-item-configuration',
      ),
    )

    await configurationPanel.getByRole('button', { name: '設定を保存' }).click()

    const savedConfiguration = (await saveRequestPromise).postDataJSON() as WorkItemConfiguration

    expect(savedConfiguration.workflow.initialStatusId).toBe('ready')
    expect(savedConfiguration.workflow.statuses.map((status) => status.sortOrder)).toEqual(
      savedConfiguration.workflow.statuses.map((_, index) => index),
    )
    expect(savedConfiguration.workflow.transitions.every((transition) =>
      transition.fromStatusId !== 'backlog' && transition.toStatusId !== 'backlog',
    )).toBe(true)
    expect(savedConfiguration.customFields.map((field) => field.sortOrder)).toEqual(
      savedConfiguration.customFields.map((_, index) => index),
    )
    await expect.poll(() => requestCounts.workItemConfigurationWrites).toBe(1)
    await expect(page.getByTestId('work-item-configuration-inherited')).toHaveCount(0)
    await expect(configurationPanel.getByLabel('ワークフロー名')).toHaveValue(
      'Core team delivery',
    )
    await expect(configurationPanel.getByTestId('workflow-status-backlog')).toHaveCount(0)
    await expect(
      configurationPanel.getByTestId('custom-field-definition-target-date'),
    ).toHaveCount(0)
    await expect(configurationPanel.getByTestId('custom-field-option-risk-level-high')).toBeVisible()
  })

  test('Task 詳細は競合後の revision 再取得後も競合メッセージを維持する', async ({ page }) => {
    const issueId = 'task-revision-conflict'

    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      revisionConflictIssueKeys: [createIssueCollaborationKey('core-team', issueId)],
      teamIssuesByTeam: {
        'core-team': [
          createStoredTeamIssue({
            id: issueId,
            title: 'Task 競合確認',
            workflowStatusId: 'todo',
          }),
        ],
      },
    })
    await page.goto(`/projects/refero/issues?teamId=core-team&issueId=${issueId}`)
    const requestCounts = getMockRequestCounts(page)
    const detailPane = page.getByTestId('task-detail-pane')

    await expect(detailPane.getByRole('button', { name: '変更を保存' })).toBeEnabled()
    await detailPane.locator('select[name="workflowStatusId"]').selectOption('done')
    await detailPane.getByRole('button', { name: '変更を保存' }).click()

    await expect.poll(() => requestCounts.issueUpdates).toBe(1)
    await expect.poll(() => requestCounts.projectTasks.refero).toBeGreaterThanOrEqual(2)
    await expect(detailPane.locator('select[name="workflowStatusId"]')).toHaveValue('review')
    await expect(detailPane.locator('textarea[name="description"]')).toHaveValue(
      '別のメンバーが更新した最新内容です。',
    )
    await expect(detailPane.getByText(workItemConflictMessage)).toBeVisible()
  })

  test('Team Issue 詳細は競合後の revision 再取得後も競合メッセージを維持する', async ({ page }) => {
    const issueId = 'team-revision-conflict'

    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      revisionConflictIssueKeys: [createIssueCollaborationKey('core-team', issueId)],
      teamIssuesByTeam: {
        'core-team': [
          createStoredTeamIssue({
            id: issueId,
            title: 'Team Issue 競合確認',
            workflowStatusId: 'todo',
          }),
        ],
      },
    })
    await page.goto('/teams/core-team/issues')
    const requestCounts = getMockRequestCounts(page)

    await page.getByTestId(`issue-row-${issueId}`).click()
    const statusSelect = page.locator('aside select[name="workflowStatusId"]')
    const description = page.locator('aside textarea[name="description"]')

    await expect(page.getByRole('button', { name: '変更を保存' })).toBeEnabled()
    await statusSelect.selectOption('done')
    await page.getByRole('button', { name: '変更を保存' }).click()

    await expect.poll(() => requestCounts.issueUpdates).toBe(1)
    await expect.poll(() => requestCounts.issueReads).toBeGreaterThanOrEqual(2)
    await expect(statusSelect).toHaveValue('review')
    await expect(description).toHaveValue('別のメンバーが更新した最新内容です。')
    await expect(page.getByText(workItemConflictMessage)).toBeVisible()
  })

  test('タスク画面で担当者、優先度、期限、並び替え、詳細コメントが動作する', async ({ page }) => {
    await page.goto('/projects/refero/issues?teamId=core-team&issueId=wireframe')
    const requestCounts = getMockRequestCounts(page)

    const initialDetailPane = page.getByTestId('task-detail-pane')

    await expect(initialDetailPane).toContainText('新しいランディングページのワイヤーフレーム作成')
    await expect(initialDetailPane.getByRole('button', { name: '変更を保存' })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'コメントを追加' })).toBeVisible()

    await page.getByRole('button', { name: '担当者' }).click()
    await page.getByRole('menuitemradio', { name: '佐藤 花子' }).click()

    await expect(page.getByTestId('task-row-wireframe')).toBeVisible()
    await expect(page.getByTestId('task-row-brand-guideline')).toBeHidden()
    await expect(page.getByTestId('tasks-count')).toContainText('1')

    await page.getByRole('button', { name: '担当者' }).click()
    await page.getByRole('menuitemradio', { name: 'すべての担当者' }).click()
    await page.getByRole('button', { name: '優先度' }).click()
    await page.getByRole('menuitemradio', { name: '高' }).click()

    await expect(page.getByTestId('task-row-wireframe')).toBeVisible()
    await expect(page.getByTestId('task-row-seo-research')).toBeHidden()
    await expect(page.getByTestId('tasks-count')).toContainText('1')

    await page.getByRole('button', { name: '優先度' }).click()
    await page.getByRole('menuitemradio', { name: 'すべての優先度' }).click()
    await page.getByRole('button', { name: '期限', exact: true }).click()
    await page.getByRole('menuitemradio', { name: '期限切れ' }).click()

    await expect(page.getByTestId('task-row-wireframe')).toBeVisible()
    await expect(page.getByTestId('task-row-seo-research')).toBeVisible()
    await expect(page.getByTestId('task-row-competitor-report')).toBeHidden()
    await expect(page.getByTestId('tasks-count')).toContainText('3')

    await page.getByRole('button', { name: '期限', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'すべての期限' }).click()
    await page.getByRole('button', { name: /期限が近い順/ }).click()
    await page.getByRole('menuitemradio', { name: '期限が遠い順' }).click()

    await expect(page.getByTestId('task-row-seo-research')).toBeVisible()
    await expect(page.getByTestId('task-row-wireframe')).toBeVisible()
    await expect(page.getByTestId('task-row-seo-research')).toHaveAttribute('data-row-index', '0')

    await page.goto('/teams/core-team/issues')
    await page.getByRole('button', { name: '新規 Issue' }).click()
    const createIssueForm = page.getByTestId('create-issue-form')

    await createIssueForm.locator('input[name="title"]').fill('Execution detail check')
    await createIssueForm.locator('textarea[name="description"]').fill('詳細説明を保持します。')
    await createIssueForm.locator('select[name="assignedProjectId"]').selectOption('refero')
    await createIssueForm.locator('select[name="assigneeUserId"]').selectOption('sato@example.com')
    await createIssueForm.getByRole('button', { name: 'Issue を作成' }).click()
    await expect(page.getByTestId('issue-row-execution-detail-check')).toBeVisible()

    await page.goto('/projects/refero/issues?teamId=core-team&issueId=execution-detail-check')

    await expect(page.getByTestId('task-detail-pane')).toContainText('Execution detail check')
    await expect(page.getByRole('button', { name: '変更を保存' })).toBeEnabled()
    await expect(page.getByTestId('task-detail-pane').locator('textarea[name="description"]')).toHaveValue('詳細説明を保持します。')
    await page.locator('textarea[name="body"]').fill('保存中も残すコメント下書き')
    await page.getByTestId('task-detail-pane').locator('select[name="workflowStatusId"]').selectOption('review')
    await page.getByRole('button', { name: '変更を保存' }).click()
    await expect(page.getByTestId('task-detail-pane').locator('textarea[name="description"]')).toHaveValue('詳細説明を保持します。')
    await expect(page.locator('textarea[name="body"]')).toHaveValue(
      '保存中も残すコメント下書き',
    )
    await page.locator('textarea[name="body"]').fill('')

    await page.getByTestId('task-row-seo-research').getByRole('button').click()

    await expect(page).toHaveURL(/issueId=seo-research/)
    await expect(page.getByTestId('task-detail-pane')).toContainText('SEO キーワードリサーチ')
    await expect(page.getByRole('button', { name: '変更を保存' })).toBeEnabled()

    await page.goto('/projects/refero/issues?teamId=core-team&issueId=execution-detail-check')

    await page.locator('textarea[name="body"]').fill('プロジェクト画面から確認します。')
    await page.getByRole('button', { name: 'コメントを追加' }).click()

    await expect(
      page.getByTestId('comment-thread-comment-2').getByText('プロジェクト画面から確認します。'),
    ).toBeVisible()
    expect(requestCounts.issueComments).toBe(1)
  })

  test('タスク split-pane の作成フォームと詳細ペインが長いラベルでも崩れない', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 860 })
    await page.goto('/projects/refero/issues?teamId=core-team&issueId=wireframe')

    await expect(page.getByTestId('task-detail-pane')).toContainText('新しいランディングページのワイヤーフレーム作成')
    await page.getByRole('button', { name: '新規タスク' }).click()
    await page.getByTestId('create-task-form').locator('input[name="title"]').fill(
      '長いラベルでも split pane と詳細プロパティが重ならないことを確認するタスク',
    )

    await expectTaskSplitPaneLayoutToStayInsideColumns(page)

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByTestId('create-task-form')).toBeVisible()
    await expect(page.getByTestId('task-detail-pane')).toBeVisible()
    await expectTaskSplitPaneLayoutToStayInsideColumns(page)
  })

  test('タブ切り替えとサイドバーの折りたたみが動作する', async ({ page }) => {
    await page.goto('/projects/refero/tasks')

    await page.getByRole('tab', { name: 'ボード' }).click()

    await expect(page.getByRole('tab', { name: 'ボード' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(page.getByText('ボードビュー')).toBeVisible()

    await page.getByRole('tab', { name: '期限順' }).click()
    await expect(page.getByText('期限順リスト')).toBeVisible()

    await page.getByRole('tab', { name: 'ファイル' }).click()
    await expect(page.getByRole('heading', { name: 'ファイルビュー' })).toBeVisible()
    await expect(page.getByRole('tabpanel').getByRole('searchbox')).toHaveCount(0)
    await expect(page.getByTestId('task-detail-pane')).toHaveCount(0)

    await page.getByRole('button', { name: 'サイドバーを折りたたむ' }).click()

    await expect(page.getByLabel('メインサイドバー')).toHaveAttribute('data-collapsed', 'true')
    await expect(page.getByRole('button', { name: 'サイドバーを展開する' })).toBeVisible()
  })

  test('サイドバーと main 領域のスクロール境界がずれない', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 640 })
    await page.goto('/dashboard')

    await expectDesktopAppShellScrollsInsideMain(page)

    await page.goto('/projects/refero/tasks')
    await expect(page.getByTestId('tasks-heading')).toBeVisible()

    await expectDesktopAppShellScrollsInsideMain(page)

    await page.goto('/teams/core-team/issues')
    await expect(page.getByTestId('team-issues-heading')).toBeVisible()
    await page.getByTestId('issue-row-wireframe').click()

    await expectDesktopAppShellScrollsInsideMain(page)
  })

  test('モバイルサイドバーは viewport 内に収まり body をスクロールさせない', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/dashboard')

    await page.getByRole('button', { name: 'サイドバーを開く' }).click()

    const drawer = page.getByRole('dialog', { name: 'モバイルサイドバー' })
    const sidebar = page.locator('aside[aria-label="メインサイドバー"]:visible')

    await expect(drawer).toBeVisible()
    await expect(sidebar).toBeVisible()

    const drawerState = await sidebar.evaluate((element) => {
      const rect = element.getBoundingClientRect()

      return {
        bodyOverflow: window.getComputedStyle(document.body).overflow,
        height: rect.height,
        top: rect.top,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        width: rect.width,
      }
    })

    expect(drawerState.bodyOverflow).toBe('hidden')
    expect(Math.abs(drawerState.top)).toBeLessThanOrEqual(1)
    expect(Math.abs(drawerState.height - drawerState.viewportHeight)).toBeLessThanOrEqual(1)
    expect(drawerState.width).toBeLessThanOrEqual(drawerState.viewportWidth - 32)

    const archiveButton = page.getByRole('button', { name: 'Refero をアーカイブ' })

    await archiveButton.click()
    const archiveDialog = page.getByRole('dialog', { name: 'アーカイブの確認' })
    const archiveConfirmButton = archiveDialog.getByRole('button', { name: 'アーカイブ' })

    await expect(archiveDialog).toContainText('現在この画面からは復元できません')
    await expect(archiveDialog.getByRole('button', { name: 'キャンセル' })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(archiveConfirmButton).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(archiveDialog).toHaveCount(0)
    await expect(drawer).toBeVisible()
    await expect(archiveButton).toBeFocused()

    await archiveButton.click()
    await archiveDialog.getByRole('button', { name: 'アーカイブ' }).click()
    await expect(archiveDialog).toHaveCount(0)
    await expect(drawer).toBeVisible()
    await expect(sidebar).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(sidebar.getByRole('button', { name: 'サイドバーを折りたたむ' })).toBeFocused()

    await page.mouse.move(180, 620)
    await page.mouse.wheel(0, 700)

    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  })

  test('390px 幅で Task と Issue の主要操作が viewport 内で使える', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })

    await page.goto('/projects/refero/issues?teamId=core-team&issueId=wireframe')
    await expect(page.getByTestId('tasks-heading')).toBeVisible()
    await page.getByTestId('task-row-brand-guideline').getByRole('button').click()
    await expect(page.getByTestId('task-detail-pane')).toContainText('ブランドガイドラインの更新')

    await page.goto('/teams/core-team/issues')
    await expect(page.getByTestId('team-issues-heading')).toBeVisible()
    await page.getByRole('button', { name: 'ボード' }).click()
    await expect(page.getByRole('button', { name: 'ボード' })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: '新規 Issue' }).click()
    await expect(page.getByTestId('create-issue-form')).toBeVisible()

    const hasDocumentOverflow = await page.evaluate(() =>
      document.documentElement.scrollWidth > window.innerWidth + 1,
    )

    expect(hasDocumentOverflow).toBe(false)
  })

  test('DB のチーム別プロジェクトをサイドバーに表示し、選択したプロジェクトのタスクへ遷移する', async ({
    page,
  }) => {
    await page.goto('/dashboard')
    const requestCounts = getMockRequestCounts(page)

    await expect(page.getByRole('button', { name: 'コアチーム', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'デザインチーム', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '共通ローンチ', exact: true })).toHaveCount(2)
    expect(requestCounts.projectDirectory).toBe(1)
    await expect.poll(() => requestCounts.workspaceWorkItems).toBe(1)
    expect(requestCounts.projectTasks).toEqual({})

    await page.getByRole('button', { name: 'ブランド刷新', exact: true }).click()

    await expect(page).toHaveURL('/projects/brand-refresh/issues?teamId=design-team')
    await expect(page.getByTestId('tasks-heading')).toHaveText('ブランド刷新')
    await expect(page.getByTestId('tasks-empty')).toBeVisible()
    expect(requestCounts.projectDirectory).toBe(1)
  })

  test('チーム所有 Issue を作成し、プロジェクトへ割り当ててコメントできる', async ({ page }) => {
    await page.goto('/dashboard')
    const requestCounts = getMockRequestCounts(page)

    await page.getByRole('button', { name: 'Issues' }).first().click()

    await expect(page).toHaveURL('/teams/core-team/issues')
    await expect(page.getByTestId('team-issues-heading')).toHaveText('コアチーム')
    await expect(page.getByTestId('issue-row-wireframe')).toBeVisible()

    await page.getByTestId('issue-row-wireframe').click()
    await expect(page.getByRole('button', { name: '変更を保存' })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'コメントを追加' })).toBeVisible()
    expect(requestCounts.issueUpdates).toBe(0)

    await page.getByRole('button', { name: '新規 Issue' }).click()
    const createIssueForm = page.getByTestId('create-issue-form')
    await expectTeamIssueLayoutToStayInsideColumns(page)
    await page.setViewportSize({ width: 1800, height: 900 })
    await expectTeamIssueLayoutToStayInsideColumns(page)
    await createIssueForm.locator('input[name="title"]').fill('割当待ち Issue')
    await createIssueForm.locator('select[name="assigneeUserId"]').selectOption('sato@example.com')
    await createIssueForm.getByRole('button', { name: 'Issue を作成' }).click()

    await expect(page.getByTestId('issue-row-割当待ち-issue')).toBeVisible()
    expect(requestCounts.issueCreates).toBe(1)

    await page.getByTestId('issue-row-割当待ち-issue').click()
    await page.locator('aside select[name="assignedProjectId"]').selectOption('refero')
    await page.getByRole('button', { name: '変更を保存' }).click()

    await expect.poll(() => requestCounts.issueUpdates).toBe(1)

    await page.locator('textarea[name="body"]').fill('プロジェクト側で着手します。')
    await page.getByRole('button', { name: 'コメントを追加' }).click()

    await expect(
      page.getByTestId('comment-thread-comment-2').getByText('プロジェクト側で着手します。'),
    ).toBeVisible()
    await expect(page.getByText('Demo User がコメントしました。')).toBeVisible()
    expect(requestCounts.issueComments).toBe(1)

    await page.goto('/projects/refero/issues?teamId=core-team')

    await expect(page.getByTestId('task-row-割当待ち-issue')).toContainText('割当待ち Issue')
  })

  test('成果物を API body 経由せず upload し、annotation と approval を保存できる', async ({ page }) => {
    const proofingIssue = createStoredTeamIssue({
      assignedProjectId: 'refero',
      id: 'proofing-issue',
      source: 'dynamodb',
      teamId: 'core-team',
      title: '成果物レビュー',
    })
    const files: FileAttachment[] = []
    const approvals: ApprovalRequest[] = []
    const annotations: FileAnnotation[] = []
    let objectPutCount = 0
    let startAnnotationSave: (() => void) | undefined
    let releaseAnnotationSave: (() => void) | undefined
    const annotationSaveStarted = new Promise<void>((resolve) => {
      startAnnotationSave = resolve
    })
    const annotationSaveHold = new Promise<void>((resolve) => {
      releaseAnnotationSave = resolve
    })
    let startPreviewAccess: (() => void) | undefined
    let releasePreviewAccess: (() => void) | undefined
    const previewAccessStarted = new Promise<void>((resolve) => {
      startPreviewAccess = resolve
    })
    const previewAccessHold = new Promise<void>((resolve) => {
      releasePreviewAccess = resolve
    })
    let previewAccessRequestCount = 0
    let workItemUploadSessionCount = 0
    const version: FileVersion = {
      contentType: 'image/png',
      createdAt: '2026-07-12T03:00:00.000Z',
      createdByMemberKey: 'demo@example.com',
      fileName: 'proof.png',
      id: 'version-proof-1',
      number: 1,
      previewKind: 'image',
      scanStatus: 'pending',
      sizeBytes: 5,
    }
    const blockedVersion: FileVersion = {
      ...version,
      createdAt: '2026-07-12T03:05:00.000Z',
      fileName: 'proof-blocked.png',
      id: 'version-proof-blocked',
      number: 2,
      scanStatus: 'blocked',
    }
    const file: FileAttachment = {
      capabilities: {
        canAnnotate: true,
        canDelete: true,
        canDownload: true,
        canRequestApproval: true,
        canUploadVersion: true,
      },
      createdAt: '2026-07-12T03:00:00.000Z',
      currentVersion: version,
      id: 'file-proof-1',
      name: 'proof.png',
      targetId: proofingIssue.id,
      targetType: 'work-item',
      updatedAt: '2026-07-12T03:00:00.000Z',
      versionCount: 1,
      versions: [version],
    }
    const failedUploadVersion: FileVersion = {
      ...version,
      fileName: 'later-failure.png',
      id: 'version-upload-failure',
      scanStatus: 'pending',
    }
    const failedUploadFile: FileAttachment = {
      ...file,
      currentVersion: failedUploadVersion,
      id: 'file-upload-failure',
      name: failedUploadVersion.fileName,
      versions: [failedUploadVersion],
    }
    const commentVersion: FileVersion = {
      ...version,
      fileName: 'comment-proof.png',
      id: 'version-comment-proof-1',
    }
    const commentFile: FileAttachment = {
      ...file,
      currentVersion: commentVersion,
      id: 'file-comment-proof-1',
      name: 'comment-proof.png',
      targetId: 'comment-1',
      targetType: 'comment',
      versions: [commentVersion],
    }

    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      teamIssuesByTeam: { 'core-team': [proofingIssue] },
    })

    await page.route('**/api/teams/core-team/issues/proofing-issue/files', async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          approvals,
          capabilities: { canGrantGuestAccess: true, canRequestApproval: true, canUpload: true },
          files,
        },
      })
    })
    await page.route('**/api/teams/core-team/issues/proofing-issue/files/uploads', async (route) => {
      workItemUploadSessionCount += 1
      if (workItemUploadSessionCount > 1) {
        files.push(failedUploadFile)
        await route.fulfill({
          status: 200,
          json: {
            file: failedUploadFile,
            upload: {
              expiresAt: '2026-07-12T04:00:00.000Z',
              headers: { 'Content-Type': 'image/png' },
              maxSizeBytes: 1_000,
              method: 'PUT',
              url: '/mock-object/failed-upload',
            },
            version: failedUploadVersion,
          },
        })
        return
      }

      await route.fulfill({
        status: 200,
        json: {
          file,
          upload: {
            expiresAt: '2026-07-12T04:00:00.000Z',
            headers: { 'Content-Type': 'image/png' },
            maxSizeBytes: 1_000,
            method: 'PUT',
            url: '/mock-object/proof-upload',
          },
          version,
        },
      })
    })
    await page.route('**/mock-object/proof-upload', async (route) => {
      expect(route.request().method()).toBe('PUT')
      expect(route.request().headers()).not.toHaveProperty('authorization')
      objectPutCount += 1
      await route.fulfill({ status: 200, body: '' })
    })
    await page.route('**/mock-object/failed-upload', async (route) => {
      expect(route.request().method()).toBe('PUT')
      await route.fulfill({ status: 500, body: 'Object upload failed.' })
    })
    await page.route(
      '**/api/teams/core-team/issues/proofing-issue/comments/comment-1/files/uploads',
      async (route) => {
        expect(route.request().postDataJSON()).toMatchObject({ guestAccess: true })
        await route.fulfill({
          status: 200,
          json: {
            file: commentFile,
            upload: {
              expiresAt: '2026-07-12T04:00:00.000Z',
              headers: { 'Content-Type': 'image/png' },
              maxSizeBytes: 1_000,
              method: 'PUT',
              url: '/mock-object/comment-proof-upload',
            },
            version: commentVersion,
          },
        })
      },
    )
    await page.route('**/mock-object/comment-proof-upload', async (route) => {
      expect(route.request().method()).toBe('PUT')
      expect(route.request().headers()).not.toHaveProperty('authorization')
      objectPutCount += 1
      await route.fulfill({ status: 200, body: '' })
    })
    await page.route(
      '**/api/teams/core-team/issues/proofing-issue/files/file-proof-1/versions/version-proof-1/complete',
      async (route) => {
        const availableVersion = { ...version, scanStatus: 'available' as const }
        file.currentVersion = availableVersion
        file.versionCount = 2
        file.versions = [availableVersion, blockedVersion]
        if (!files.some((candidate) => candidate.id === file.id)) {
          files.push(file)
        }
        await route.fulfill({ status: 200, json: { file, version: availableVersion } })
      },
    )
    await page.route(
      '**/api/teams/core-team/issues/proofing-issue/files/file-comment-proof-1/versions/version-comment-proof-1/complete',
      async (route) => {
        const availableVersion = { ...commentVersion, scanStatus: 'available' as const }
        commentFile.currentVersion = availableVersion
        commentFile.versions = [availableVersion]
        if (!files.some((candidate) => candidate.id === commentFile.id)) {
          files.push(commentFile)
        }
        await route.fulfill({ status: 200, json: { file: commentFile, version: availableVersion } })
      },
    )
    await page.route(
      /.*\/api\/teams\/core-team\/issues\/proofing-issue\/files\/file-proof-1\/versions\/version-proof-1\/access\?.*/,
      async (route) => {
        previewAccessRequestCount += 1
        if (previewAccessRequestCount === 1) {
          startPreviewAccess?.()
          await previewAccessHold
        }
        await route.fulfill({
          status: 200,
          json: { expiresAt: '2026-07-12T04:00:00.000Z', url: '/mock-preview/proof.svg' },
        })
      },
    )
    await page.route('**/mock-preview/proof.svg', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#d9f8ed"/></svg>',
      })
    })
    await page.route(
      '**/api/teams/core-team/issues/proofing-issue/files/file-proof-1/versions/version-proof-1/annotations',
      async (route) => {
        if (route.request().method() === 'POST') {
          if (annotations.length > 0) {
            await route.fulfill({ status: 500, json: { message: 'Annotation save failed.' } })
            return
          }

          startAnnotationSave?.()
          await annotationSaveHold
          const body = route.request().postDataJSON() as {
            anchor: FileAnnotation['anchor']
            bodyMarkdown: string
          }
          const annotation = {
            anchor: body.anchor,
            authorMemberKey: 'demo@example.com',
            bodyMarkdown: body.bodyMarkdown,
            capabilities: { canResolve: true },
            createdAt: '2026-07-12T03:10:00.000Z',
            fileId: file.id,
            id: 'annotation-proof-1',
            versionId: version.id,
          } satisfies FileAnnotation
          annotations.push(annotation)
          await route.fulfill({ status: 200, json: { annotation } })
          return
        }

        await route.fulfill({ status: 200, json: { annotations } })
      },
    )
    await page.route('**/api/teams/core-team/issues/proofing-issue/approvals', async (route) => {
      const body = route.request().postDataJSON() as {
        dueAt: string
        fileId: string
        reviewerMemberKeys: string[]
        versionId: string
      }
      const approval = {
        capabilities: { canCancel: false, canDecide: true },
        createdAt: '2026-07-12T03:20:00.000Z',
        dueAt: body.dueAt,
        fileId: body.fileId,
        id: `approval-proof-${approvals.length + 1}`,
        subjectType: 'file-version' as const,
        requestedByMemberKey: 'demo@example.com',
        requestedByKind: 'member' as const,
        reviewers: body.reviewerMemberKeys.map((memberKey) => ({ memberKey, status: 'pending' as const })),
        revision: 1,
        status: 'pending' as const,
        updatedAt: '2026-07-12T03:20:00.000Z',
        versionId: body.versionId,
      } satisfies ApprovalRequest
      approvals.push(approval)
      await route.fulfill({ status: 200, json: { approval } })
    })
    await page.route(
      /.*\/api\/teams\/core-team\/issues\/proofing-issue\/approvals\/approval-proof-\d+\/decisions$/,
      async (route) => {
        const approvalId = route.request().url().match(/\/approvals\/([^/]+)\/decisions$/)?.[1]
        const approvalIndex = approvals.findIndex((approval) => approval.id === approvalId)
        const current = approvals[approvalIndex]
        if (!current || approvalIndex < 0) {
          await route.fulfill({ status: 404, json: { message: 'Approval not found.' } })
          return
        }

        const body = route.request().postDataJSON() as {
          decision?: string
          expectedRevision?: number
        }

        expect(body.decision).toBe('approve')
        expect(body.expectedRevision).toBe(current.revision)

        approvals[approvalIndex] = {
          ...current,
          completedAt: '2026-07-12T03:30:00.000Z',
          reviewers: current.reviewers.map((reviewer) => ({
            ...reviewer,
            decidedAt: '2026-07-12T03:30:00.000Z',
            status: 'approved',
          })),
          revision: 2,
          status: 'approved',
          updatedAt: '2026-07-12T03:30:00.000Z',
        }
        await route.fulfill({ status: 200, json: { approval: approvals[approvalIndex] } })
      },
    )
    await page.route(
      /.*\/api\/teams\/core-team\/issues\/proofing-issue\/approvals\/approval-proof-\d+\/cancel$/,
      async (route) => {
        const approvalId = route.request().url().match(/\/approvals\/([^/]+)\/cancel$/)?.[1]
        const approvalIndex = approvals.findIndex((approval) => approval.id === approvalId)
        const current = approvals[approvalIndex]
        const body = route.request().postDataJSON() as { expectedRevision: number }
        if (!current || approvalIndex < 0) {
          await route.fulfill({ status: 404, json: { message: 'Approval not found.' } })
          return
        }

        expect(body.expectedRevision).toBe(current.revision)
        approvals[approvalIndex] = {
          ...current,
          completedAt: '2026-07-12T03:25:00.000Z',
          revision: current.revision + 1,
          status: 'cancelled',
          updatedAt: '2026-07-12T03:25:00.000Z',
        }
        await route.fulfill({ status: 200, json: { approval: approvals[approvalIndex] } })
      },
    )

    await page.goto('/projects/refero/issues?teamId=core-team&issueId=proofing-issue')
    await page.getByTestId('file-upload-input').setInputFiles([
      {
        buffer: Buffer.from('proof'),
        mimeType: 'image/png',
        name: 'proof.png',
      },
      {
        buffer: Buffer.from('later failure'),
        mimeType: 'image/png',
        name: 'later-failure.png',
      },
    ])

    await expect.poll(() => objectPutCount).toBe(1)
    await expect(page.getByTestId('file-row-file-proof-1')).toContainText('利用可能')
    await expect(page.getByTestId('file-row-file-upload-failure')).toContainText('later-failure.png')
    await page.getByTestId('comment-files-comment-1').getByLabel('Guest 閲覧を許可').check()
    await page.getByTestId('comment-file-input-comment-1').setInputFiles({
      buffer: Buffer.from('comment proof'),
      mimeType: 'image/png',
      name: 'comment-proof.png',
    })
    await expect.poll(() => objectPutCount).toBe(2)
    await expect(page.getByTestId('comment-files-comment-1')).toContainText('comment-proof.png')
    await page.getByTestId('file-row-file-proof-1').getByRole('button', { name: 'プレビュー' }).click()
    await expect(page.getByTestId('file-preview-dialog')).toBeVisible()
    await previewAccessStarted
    await page.locator('#file-preview-version').selectOption(blockedVersion.id)
    await expect(page.getByTestId('file-preview-dialog')).toContainText('ブロック済み')
    releasePreviewAccess?.()
    await page.locator('#file-preview-version').selectOption(version.id)
    await expect(page.getByTestId('file-preview-canvas')).toBeVisible()
    await page.getByRole('button', { name: '位置を指定' }).click()
    await page.getByTestId('file-preview-canvas').click({ position: { x: 180, y: 120 } })
    await page.getByLabel('レビューコメント').fill('CTA の位置を確認してください。')
    await page.getByRole('button', { name: 'Annotation を追加' }).click()
    await annotationSaveStarted
    await expect(page.locator('#file-preview-version')).toBeDisabled()
    await expect(page.getByRole('button', { name: '位置指定中' })).toBeDisabled()
    await expect(page.getByLabel('レビューコメント')).toBeDisabled()
    releaseAnnotationSave?.()
    await expect(page.getByTestId('file-preview-dialog')).toContainText('CTA の位置を確認してください。')
    await expect(page.locator('#file-preview-version')).toBeEnabled()

    await page.getByRole('button', { name: '位置を指定' }).click()
    await page.getByTestId('file-preview-canvas').click({ position: { x: 240, y: 160 } })
    await page.getByLabel('レビューコメント').fill('保存失敗を表示します。')
    await page.getByRole('button', { name: 'Annotation を追加' }).click()
    await expect(page.getByTestId('file-preview-dialog').getByRole('alert')).toContainText(
      'ファイル操作を完了できませんでした。',
    )
    await expect(page.locator('#file-preview-version')).toBeEnabled()
    await page.getByRole('button', { name: 'Preview を閉じる' }).click()

    await page.getByRole('button', { name: '承認を依頼' }).click()
    await page.getByTestId('approval-request-form').getByText('Demo User').click()
    const firstDueAtInput = page.getByTestId('approval-request-form').locator('input[name="dueAt"]')
    const localToday = await page.evaluate(() => {
      const today = new Date()
      const year = today.getFullYear()
      const month = String(today.getMonth() + 1).padStart(2, '0')
      const day = String(today.getDate()).padStart(2, '0')

      return `${year}-${month}-${day}`
    })

    await expect(firstDueAtInput).toHaveAttribute('min', localToday)
    await firstDueAtInput.fill('2099-12-31')
    await page.getByRole('button', { name: 'Request を作成' }).click()
    await expect(page.getByTestId('approval-approval-proof-1')).toBeVisible()
    await page.getByTestId('approval-approval-proof-1').getByRole('button', { name: 'Request をキャンセル' }).click()
    await expect(page.getByTestId('approval-approval-proof-1')).toContainText('キャンセル済み')

    await page.getByRole('button', { name: '承認を依頼' }).click()
    await page.getByTestId('approval-request-form').getByText('Demo User').click()
    await page.getByTestId('approval-request-form').locator('input[name="dueAt"]').fill('2099-12-31')
    await page.getByRole('button', { name: 'Request を作成' }).click()
    await expect(page.getByTestId('approval-approval-proof-2')).toBeVisible()
    const secondApproval = page.getByTestId('approval-approval-proof-2')

    await expect(secondApproval.locator('textarea')).toHaveAttribute('maxlength', '2000')
    await secondApproval.getByRole('button', { name: '承認' }).click()
    await expect(page.getByTestId('approval-approval-proof-2')).toContainText('承認済み')
  })

  test('Issue 切替後は以前の file mutation 結果と panel state を引き継がない', async ({ page }) => {
    const firstIssue = createStoredTeamIssue({
      assignedProjectId: 'refero',
      id: 'file-scope-first',
      source: 'dynamodb',
      teamId: 'core-team',
      title: '切替前成果物',
    })
    const secondIssue = createStoredTeamIssue({
      assignedProjectId: 'refero',
      id: 'file-scope-second',
      source: 'dynamodb',
      teamId: 'core-team',
      title: '切替後成果物',
    })
    const version = {
      contentType: 'image/png',
      createdAt: '2026-07-12T04:00:00.000Z',
      createdByMemberKey: 'demo@example.com',
      fileName: 'scope-first.png',
      id: 'version-scope-first',
      number: 1,
      previewKind: 'image',
      scanStatus: 'available',
      sizeBytes: 120,
    } satisfies FileVersion
    const file = {
      capabilities: {
        canAnnotate: true,
        canDelete: true,
        canDownload: true,
        canRequestApproval: true,
        canUploadVersion: true,
      },
      createdAt: '2026-07-12T04:00:00.000Z',
      currentVersion: version,
      id: 'file-scope-first',
      name: 'scope-first.png',
      targetId: firstIssue.id,
      targetType: 'work-item',
      updatedAt: '2026-07-12T04:00:00.000Z',
      versionCount: 1,
      versions: [version],
    } satisfies FileAttachment
    let startStaleAccess: (() => void) | undefined
    let releaseStaleAccess: (() => void) | undefined
    let staleAccessCompleted = false
    const staleAccessStarted = new Promise<void>((resolve) => {
      startStaleAccess = resolve
    })
    const staleAccessHold = new Promise<void>((resolve) => {
      releaseStaleAccess = resolve
    })

    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      teamIssuesByTeam: { 'core-team': [firstIssue, secondIssue] },
    })
    await page.route('**/api/teams/core-team/issues/file-scope-first/files', async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          approvals: [],
          capabilities: { canGrantGuestAccess: true, canRequestApproval: true, canUpload: true },
          files: [file],
        },
      })
    })
    await page.route('**/api/teams/core-team/issues/file-scope-second/files', async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          approvals: [],
          capabilities: { canGrantGuestAccess: true, canRequestApproval: true, canUpload: true },
          files: [],
        },
      })
    })
    await page.route(
      /.*\/api\/teams\/core-team\/issues\/file-scope-first\/files\/file-scope-first\/versions\/version-scope-first\/access\?.*/,
      async (route) => {
        startStaleAccess?.()
        await staleAccessHold
        staleAccessCompleted = true
        await route.fulfill({
          status: 409,
          json: { code: 'FileRevisionConflict', message: 'Stale file scope.' },
        })
      },
    )

    await page.goto('/projects/refero/issues?teamId=core-team&issueId=file-scope-first')
    const firstPanel = page.getByTestId('issue-artifacts-panel')
    await expect(firstPanel.getByText('scope-first.png')).toBeVisible()
    await firstPanel.getByLabel('Guest 閲覧を許可').check()
    await firstPanel.getByRole('button', { name: 'ダウンロード' }).click()
    await staleAccessStarted

    await page.getByTestId('task-row-file-scope-second').getByRole('button').click()
    await expect(page).toHaveURL(/issueId=file-scope-second/)
    const secondPanel = page.getByTestId('issue-artifacts-panel')
    await expect(secondPanel.getByText('scope-first.png')).toHaveCount(0)
    await expect(secondPanel.getByTestId('file-upload-input')).toBeAttached()
    await expect(secondPanel.getByLabel('Guest 閲覧を許可')).not.toBeChecked()

    releaseStaleAccess?.()
    await expect.poll(() => staleAccessCompleted).toBe(true)
    await expect(secondPanel.getByText('別の操作で状態が変わりました。最新の表示を確認してください。')).toHaveCount(0)
  })

  test('サイドバーからマイタスクへ移動するとタスクをカンバンで表示する', async ({ page }) => {
    await mockCurrentUser(page, 'sato@example.com', '佐藤 花子')
    await page.goto('/dashboard')
    const requestCounts = getMockRequestCounts(page)

    await page.getByRole('button', { name: 'マイタスク', exact: true }).click()

    await expect(page).toHaveURL('/my-tasks')
    await expect(page.getByTestId('my-tasks-kanban')).toBeVisible()
    await expect(page.getByTestId('my-tasks-column-core-team-todo')).toContainText('未着手')
    await expect(page.getByTestId('my-tasks-column-core-team-in-progress')).toContainText('進行中')
    await expect(page.getByTestId('my-tasks-column-core-team-review')).toContainText('レビュー')
    await expect(page.getByTestId('my-tasks-column-core-team-done')).toContainText('完了')
    await expect(
      page.getByTestId('my-tasks-column-core-team-in-progress').getByTestId('my-tasks-card-refero-wireframe'),
    ).toBeVisible()
    await expect(
      page.getByTestId('my-tasks-card-refero-seo-research'),
    ).toHaveCount(0)
    await expect(page.getByTestId('my-tasks-card-refero-brand-guideline')).toHaveCount(0)
    await expect(page.getByTestId('my-tasks-card-refero-competitor-report')).toHaveCount(0)

    await expect(
      page.getByTestId('my-tasks-card-refero-brand-guideline-status-select'),
    ).toHaveCount(0)
    const wireframeCard = page.getByTestId('my-tasks-card-refero-wireframe')

    await expect(
      page.getByTestId('my-tasks-card-refero-wireframe-status-select'),
    ).toBeVisible()
    await expect(wireframeCard).toHaveAttribute('draggable', 'true')
    await expect(
      page.getByTestId('my-tasks-column-core-team-in-progress').getByTestId('my-tasks-card-refero-wireframe'),
    ).toBeVisible()
    const boardGeometry = await page.getByTestId('my-tasks-kanban').evaluate((element) => {
      const columnRects = Array.from(element.children).map((column) => column.getBoundingClientRect())

      return {
        hasOverlap: columnRects.slice(1).some((rect, index) => columnRects[index].right > rect.left),
        isScrollable: element.scrollWidth > element.clientWidth,
      }
    })

    expect(boardGeometry.hasOverlap).toBe(false)
    expect(boardGeometry.isScrollable).toBe(true)
    expect(requestCounts.taskStatusUpdates).toBe(0)
  })

  test('Team configuration 取得失敗中も canonical My Task を明示的な列へ保持する', async ({
    page,
  }) => {
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      failedWorkItemConfigurationTeamIds: ['core-team'],
      teamIssuesByTeam: {
        'core-team': [
          createStoredTeamIssue({
            id: 'configuration-unavailable-task',
            title: '設定取得失敗中の担当タスク',
            workflowStatusId: 'active',
          }),
        ],
      },
    })
    await mockCurrentUser(page, 'sato@example.com', '佐藤 花子')

    await page.goto('/my-tasks')

    const unavailableColumn = page.getByTestId('my-tasks-configuration-unavailable-column')
    const taskCard = page.getByTestId('my-tasks-card-refero-configuration-unavailable-task')

    await expect(page.getByTestId('my-tasks-configuration-error')).toContainText(
      'Work Item 設定を取得できませんでした。',
    )
    await expect(unavailableColumn).toBeVisible()
    await expect(unavailableColumn.getByText('設定取得失敗中の担当タスク')).toBeVisible()
    await expect(taskCard).toHaveAttribute('draggable', 'false')
    await expect(
      page.getByTestId('my-tasks-card-refero-configuration-unavailable-task-status-select'),
    ).toHaveCount(0)

    const readsBeforeRetry = getMockRequestCounts(page).workItemConfigurationReads
    await page.getByTestId('my-tasks-configuration-error').getByRole('button', {
      name: '再読み込み',
    }).click()
    await expect.poll(() => getMockRequestCounts(page).workItemConfigurationReads).toBeGreaterThan(
      readsBeforeRetry,
    )
    await expect(taskCard).toBeVisible()
  })

  test('My Tasks は取得済み Work Item がない Team の configuration を要求しない', async ({
    page,
  }) => {
    const requestedConfigurationTeamIds: string[] = []

    page.on('request', (request) => {
      const match = new URL(request.url()).pathname.match(
        /^\/api\/teams\/([^/]+)\/work-item-configuration$/,
      )

      if (match?.[1]) {
        requestedConfigurationTeamIds.push(decodeURIComponent(match[1]))
      }
    })
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      failedWorkItemConfigurationTeamIds: ['design-team'],
      teamIssuesByTeam: {
        'core-team': [
          createStoredTeamIssue({
            id: 'accessible-team-task',
            title: '閲覧可能な Team の担当タスク',
            workflowStatusId: 'todo',
          }),
        ],
      },
    })
    await mockCurrentUser(page, 'sato@example.com', '佐藤 花子')

    await page.goto('/my-tasks')

    await expect(page.getByTestId('my-tasks-card-refero-accessible-team-task')).toBeVisible()
    await expect.poll(() => Array.from(new Set(requestedConfigurationTeamIds))).toEqual([
      'core-team',
    ])
    await expect(page.getByTestId('my-tasks-configuration-error')).toHaveCount(0)
  })

  test('My Tasks は複数 Team の同名 workflow 列を Team 名で区別する', async ({ page }) => {
    await mockAuthenticatedTaskPage(page, [], undefined, {
      teamIssuesByTeam: {
        'core-team': [
          createStoredTeamIssue({
            id: 'core-team-task',
            title: 'コアチームの担当タスク',
          }),
        ],
        'design-team': [
          createStoredTeamIssue({
            assignedProjectId: 'brand-refresh',
            id: 'design-team-task',
            teamId: 'design-team',
            title: 'デザインチームの担当タスク',
          }),
        ],
      },
    })
    await mockCurrentUser(page, 'sato@example.com', '佐藤 花子')

    await page.goto('/my-tasks')

    const coreColumn = page.getByTestId('my-tasks-column-core-team-todo')
    const designColumn = page.getByTestId('my-tasks-column-design-team-todo')

    await expect(coreColumn).toContainText('コアチーム · 未着手')
    await expect(designColumn).toContainText('デザインチーム · 未着手')
    await expect(coreColumn.getByText('コアチームの担当タスク')).toBeVisible()
    await expect(designColumn.getByText('デザインチームの担当タスク')).toBeVisible()
  })

  test('プロジェクト画面の権限タブでメンバーのロールを変更できる', async ({ page }) => {
    await page.unroute('**/api/auth/me')
    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        json: {
          username: 'demo@example.com',
          attributes: {
            email: 'demo@example.com',
            name: 'Demo User',
          },
          groups: [],
          isSystemAdmin: false,
          workspaceMemberStatus: 'active',
          workspaceRole: 'member',
        },
      })
    })
    await page.goto('/projects/refero/tasks?teamId=core-team')
    const requestCounts = getMockRequestCounts(page)

    await expect(page.getByRole('button', { name: '権限管理', exact: true })).toHaveCount(0)
    await page.getByRole('tab', { name: /権限/ }).click()
    await expect(page.getByTestId('permissions-view')).toBeVisible()
    await expect(page.getByTestId('permissions-project-select')).toHaveCount(0)
    await expect(page.getByTestId('permission-role-select-demo-example-com')).toBeDisabled()
    await expect(page.getByTestId('permission-remove-demo-example-com')).toBeDisabled()
    await expect(page.getByTestId('permission-member-row-sato-example-com')).toBeVisible()
    await expect.poll(() => requestCounts.projectUserReads).toBeGreaterThanOrEqual(1)
    await expect(page.getByTestId('permissions-load-more-users')).toBeVisible()
    await page.getByTestId('permissions-load-more-users').click()
    await expect.poll(() => requestCounts.projectUserReads).toBeGreaterThanOrEqual(2)

    await page.getByTestId('permission-role-select-sato-example-com').selectOption('manager')

    await expect.poll(() => requestCounts.projectMemberUpdates).toBe(1)

    await page.getByTestId('permissions-user-search').fill('viewer2')
    await expect.poll(() => requestCounts.projectUserReads).toBeGreaterThanOrEqual(3)
    await page.getByTestId('permissions-user-select').selectOption('viewer2@example.com')
    await page.locator('#permissions-member-role').selectOption('viewer')
    await page.getByTestId('permissions-submit').click()

    await expect(page.getByTestId('permission-member-row-viewer2-example-com')).toBeVisible()
    await expect.poll(() => requestCounts.projectMemberUpdates).toBe(2)

    await page.getByTestId('permission-remove-sato-example-com').click()

    await expect(page.getByTestId('permission-member-row-sato-example-com')).toHaveCount(0)
    await expect.poll(() => requestCounts.projectMemberRemoves).toBe(1)
  })

  test('ダッシュボードからチームとプロジェクトを新規登録できる', async ({ page }) => {
    await page.goto('/dashboard')
    const requestCounts = getMockRequestCounts(page)

    await openSidebarCreatePanel(page)
    await page.getByLabel('チーム名').fill('新規チーム')
    await page.getByRole('button', { name: 'チームを登録' }).click()

    await expect(page.getByRole('button', { name: '新規チーム', exact: true })).toBeVisible()
    expect(requestCounts.teamCreates).toBe(1)

    await page.getByRole('button', { name: '新規登録' }).click()
    await page.getByRole('button', { name: 'プロジェクト', exact: true }).click()
    await page.getByLabel('プロジェクト名').fill('新規プロジェクト')
    await page.getByRole('button', { name: 'プロジェクトを登録' }).click()

    await expect(page.getByRole('button', { name: '新規プロジェクト', exact: true })).toBeVisible()
    expect(requestCounts.projectCreates).toBe(1)

    await page.getByRole('button', { name: '新規プロジェクト', exact: true }).click()
    await expect(page).toHaveURL('/projects/new-project/issues?teamId=core-team')
    await page.getByRole('tab', { name: /権限/ }).click()
    await expect(page.getByTestId('permission-member-row-demo-example-com')).toBeVisible()
    await expect(page.getByTestId('permission-role-select-demo-example-com')).toHaveValue('manager')
    await expect(page.getByTestId('permission-role-select-demo-example-com')).toBeDisabled()
    await expect(page.getByTestId('permission-remove-demo-example-com')).toBeDisabled()
  })

  test('ダッシュボードからプロジェクトをアーカイブできる', async ({ page }) => {
    await page.goto('/dashboard')
    const requestCounts = getMockRequestCounts(page)

    await page.getByRole('button', { name: 'Refero をアーカイブ' }).click()
    await expect(page.getByRole('dialog', { name: 'アーカイブの確認' })).toBeVisible()
    expect(requestCounts.projectArchives).toBe(0)

    await page.getByRole('button', { name: 'キャンセル', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Refero', exact: true })).toHaveCount(1)

    await page.getByRole('button', { name: 'Refero をアーカイブ' }).click()
    const archiveDialog = page.getByRole('dialog', { name: 'アーカイブの確認' })

    await archiveDialog.getByRole('button', { name: 'アーカイブ', exact: true }).click()
    await expect(archiveDialog).toHaveAttribute('aria-busy', 'true')
    await expect(archiveDialog).toBeFocused()

    await expect(page.getByRole('button', { name: 'Refero', exact: true })).toHaveCount(0)
    expect(requestCounts.projectArchives).toBe(1)
  })

  test('ダッシュボードからチームをアーカイブできる', async ({ page }) => {
    await page.goto('/dashboard')
    const requestCounts = getMockRequestCounts(page)

    await expect(page.getByRole('button', { name: '共通ローンチ', exact: true })).toHaveCount(2)

    await page.getByRole('button', { name: 'デザインチーム をアーカイブ' }).click()
    await page.getByRole('button', { name: 'アーカイブ', exact: true }).click()

    await expect(page.getByRole('button', { name: 'デザインチーム', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '共通ローンチ', exact: true })).toHaveCount(1)
    expect(requestCounts.teamArchives).toBe(1)
  })

  test('ダッシュボードの登録フォームは空白のみの名前を API に送信しない', async ({ page }) => {
    await page.goto('/dashboard')
    const requestCounts = getMockRequestCounts(page)

    await openSidebarCreatePanel(page)
    await page.getByLabel('チーム名').fill('   ')
    await page.getByRole('button', { name: 'チームを登録' }).click()

    await expect(page.getByText('チーム名を入力してください。')).toBeVisible()
    expect(requestCounts.teamCreates).toBe(0)

    await page.getByRole('button', { name: 'プロジェクト', exact: true }).click()
    await page.getByLabel('プロジェクト名').fill('   ')
    await page.getByRole('button', { name: 'プロジェクトを登録' }).click()

    await expect(page.getByText('プロジェクト名を入力してください。')).toBeVisible()
    expect(requestCounts.projectCreates).toBe(0)
  })

  test('同じプロジェクトが複数チームにある場合、選択元チームを Issue 画面へ引き継ぐ', async ({
    page,
  }) => {
    await page.goto('/dashboard')

    const sharedLaunchButtons = page.getByRole('button', { name: '共通ローンチ', exact: true })

    await expect(sharedLaunchButtons).toHaveCount(2)
    await sharedLaunchButtons.nth(1).click()

    await expect(page).toHaveURL('/projects/shared-launch/issues?teamId=design-team')
    await expect(page.getByTestId('tasks-heading')).toHaveText('共通ローンチ')
    await expect(page.getByLabel('プロジェクトのパンくずリスト')).toContainText(
      'デザインチーム',
    )
  })

  test('同じ issueId が複数 team にある deep-link でも teamId 側の詳細を選択する', async ({ page }) => {
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      teamIssuesByTeam: {
        'core-team': [
          createStoredTeamIssue({
            id: 'duplicate-issue',
            title: '重複 Issue',
            description: 'core team detail',
            assignedProjectId: 'shared-launch',
            teamId: 'core-team',
            workflowStatusId: 'in-progress',
          }),
        ],
        'design-team': [
          createStoredTeamIssue({
            id: 'duplicate-issue',
            title: '重複 Issue',
            description: 'design team detail',
            assignedProjectId: 'shared-launch',
            teamId: 'design-team',
            workflowStatusId: 'review',
          }),
        ],
      },
    })

    await page.goto('/projects/shared-launch/issues?teamId=design-team&issueId=duplicate-issue')

    await expect(page.getByTestId('tasks-heading')).toHaveText('共通ローンチ')
    await expect(page.getByLabel('プロジェクトのパンくずリスト')).toContainText('デザインチーム')
    await expect(page.getByTestId('task-detail-pane').locator('textarea[name="description"]')).toHaveValue('design team detail')

    await page.goto('/projects/shared-launch/issues?teamId=core-team&issueId=duplicate-issue')

    await expect(page.getByLabel('プロジェクトのパンくずリスト')).toContainText('コアチーム')
    await expect(page.getByTestId('task-detail-pane').locator('textarea[name="description"]')).toHaveValue('core team detail')
  })

  test('teamId のない曖昧な issueId deep-link は Team Issue 詳細 API を呼ばず aggregate URL へ戻す', async ({
    page,
  }) => {
    const teamScopedIssueRequestPaths: string[] = []

    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname

      if (/^\/api\/teams\/(?:core-team|design-team)\/issues(?:\/|$)/.test(pathname)) {
        teamScopedIssueRequestPaths.push(pathname)
      }
    })

    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      teamIssuesByTeam: {
        'core-team': [
          createStoredTeamIssue({
            assignedProjectId: 'shared-launch',
            description: 'core ambiguous detail',
            id: 'ambiguous-issue',
            workflowStatusId: 'in-progress',
            teamId: 'core-team',
            title: 'Core ambiguous issue',
          }),
        ],
        'design-team': [
          createStoredTeamIssue({
            assignedProjectId: 'shared-launch',
            description: 'design ambiguous detail',
            id: 'ambiguous-issue',
            workflowStatusId: 'review',
            teamId: 'design-team',
            title: 'Design ambiguous issue',
          }),
        ],
      },
    })

    await page.goto('/projects/shared-launch/issues?issueId=ambiguous-issue')

    await expect(page).toHaveURL('/projects/shared-launch/issues')
    await expect(page.getByTestId('task-row-ambiguous-issue')).toHaveCount(2)
    await expect(page.getByRole('button', { name: 'Core ambiguous issue' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Design ambiguous issue' })).toBeVisible()
    expect(teamScopedIssueRequestPaths).toEqual([])

    await page.getByRole('button', { name: 'Design ambiguous issue' }).click()

    await expect(page).toHaveURL(
      '/projects/shared-launch/issues?teamId=design-team&issueId=ambiguous-issue',
    )
    await expect(
      page.getByTestId('task-detail-pane').locator('textarea[name="description"]'),
    ).toHaveValue('design ambiguous detail')
    expect(
      teamScopedIssueRequestPaths.some((path) =>
        path === '/api/teams/design-team/issues/ambiguous-issue',
      ),
    ).toBe(true)
    expect(
      teamScopedIssueRequestPaths.some((path) => path.startsWith('/api/teams/core-team/issues')),
    ).toBe(false)
  })

  test('teamId のない共有 Project URL は全 Team の Issue を保持する', async ({ page }) => {
    const requestedConfigurationTeamIds: string[] = []

    page.on('request', (request) => {
      const match = new URL(request.url()).pathname.match(
        /^\/api\/teams\/([^/]+)\/work-item-configuration$/,
      )

      if (match?.[1]) {
        requestedConfigurationTeamIds.push(decodeURIComponent(match[1]))
      }
    })

    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      projectNamesByTeam: {
        'core-team': { 'shared-launch': 'Core shared launch' },
        'design-team': { 'shared-launch': 'Design shared launch' },
      },
      teamExpandedById: {
        'core-team': false,
        'design-team': false,
      },
      teamIssuesByTeam: {
        'core-team': [
          createStoredTeamIssue({
            assignedProjectId: 'shared-launch',
            id: 'core-shared-issue',
            teamId: 'core-team',
            title: 'Core shared issue',
          }),
        ],
        'design-team': [
          createStoredTeamIssue({
            assignedProjectId: 'shared-launch',
            id: 'design-shared-issue',
            teamId: 'design-team',
            title: 'Design shared issue',
          }),
        ],
      },
    })

    await page.goto('/projects/shared-launch/issues')

    await expect(page.getByTestId('task-row-core-shared-issue')).toBeVisible()
    await expect(page.getByTestId('task-row-design-shared-issue')).toBeVisible()
    await expect(page.getByTestId('tasks-heading')).toHaveText('shared-launch')
    await expect(page.getByLabel('プロジェクトのパンくずリスト')).toContainText(
      'プロジェクト',
    )
    await expect(page.getByLabel('プロジェクトのパンくずリスト')).not.toContainText(
      'コアチーム',
    )
    const coreTeamGroup = page.getByTestId('sidebar-team-core-team').first()
    const designTeamGroup = page.getByTestId('sidebar-team-design-team').first()
    const coreTeamButton = coreTeamGroup.getByRole('button', {
      name: 'コアチーム',
      exact: true,
    })
    const designTeamButton = designTeamGroup.getByRole('button', {
      name: 'デザインチーム',
      exact: true,
    })

    await expect(coreTeamGroup).toHaveAttribute('data-project-ancestor', 'false')
    await expect(coreTeamGroup).toHaveAttribute('data-team-active', 'false')
    await expect(designTeamGroup).toHaveAttribute('data-project-ancestor', 'false')
    await expect(designTeamGroup).toHaveAttribute('data-team-active', 'false')
    await expect(coreTeamButton).toHaveAttribute('aria-expanded', 'false')
    await expect(designTeamButton).toHaveAttribute('aria-expanded', 'false')
    await expect(coreTeamButton).not.toHaveClass(/bg-white\/8|bg-teal-500\/20/)
    await expect(designTeamButton).not.toHaveClass(/bg-white\/8|bg-teal-500\/20/)
    await expect(coreTeamGroup.locator(':scope > div.relative > span.absolute')).toHaveCount(0)
    await expect(designTeamGroup.locator(':scope > div.relative > span.absolute')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '新規タスク' })).toHaveCount(0)
    await expect.poll(() => [...new Set(requestedConfigurationTeamIds)].sort()).toEqual([
      'core-team',
      'design-team',
    ])
  })

  test('共有 Project の一部 Team configuration 取得失敗を明示し Work Item を保持する', async ({
    page,
  }) => {
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      failedWorkItemConfigurationTeamIds: ['core-team'],
      teamIssuesByTeam: {
        'core-team': [
          createStoredTeamIssue({
            assignedProjectId: 'shared-launch',
            id: 'core-configuration-unavailable',
            teamId: 'core-team',
            title: 'Core configuration unavailable',
            workflowStatusId: 'core-active',
          }),
        ],
        'design-team': [
          createStoredTeamIssue({
            assignedProjectId: 'shared-launch',
            id: 'design-configuration-available',
            teamId: 'design-team',
            title: 'Design configuration available',
            workflowStatusId: 'todo',
          }),
        ],
      },
    })

    await page.goto('/projects/shared-launch/issues')

    await expect(page.getByTestId('task-row-core-configuration-unavailable')).toBeVisible()
    await expect(page.getByTestId('task-row-design-configuration-available')).toBeVisible()
    await expect(page.getByTestId('project-configuration-error')).toContainText(
      'Work Item 設定を取得できませんでした。',
    )

    await page.getByRole('tab', { name: 'ボード', exact: true }).click()
    const unavailableColumn = page.getByTestId('project-task-configuration-unavailable-column')

    await expect(unavailableColumn).toContainText('Core configuration unavailable')
    await expect(page.getByTestId('project-task-column-design-team-todo')).toContainText(
      'Design configuration available',
    )
  })

  test('共有 Project は別 Team の configuration 取得失敗で正常な Work Item の更新を無効化しない', async ({
    page,
  }) => {
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      failedWorkItemConfigurationTeamIds: ['core-team'],
      teamIssuesByTeam: {
        'core-team': [],
        'design-team': [
          createStoredTeamIssue({
            assignedProjectId: 'shared-launch',
            id: 'design-editable-with-partial-failure',
            teamId: 'design-team',
            title: 'Design remains editable',
            workflowStatusId: 'todo',
          }),
        ],
      },
    })

    await page.goto('/projects/shared-launch/issues')

    const detailPane = page.getByTestId('task-detail-pane')

    await expect(detailPane).toContainText('Design remains editable')
    await expect(detailPane.locator('select[name="assignedProjectId"]')).toHaveValue(
      'shared-launch',
    )
    await expect(detailPane.getByRole('button', { name: '変更を保存' })).toBeEnabled()

    const updateRequestPromise = page.waitForRequest((request) =>
      request.method() === 'PATCH' &&
      new URL(request.url()).pathname ===
        '/api/teams/design-team/issues/design-editable-with-partial-failure',
    )

    await detailPane.getByRole('button', { name: '変更を保存' }).click()

    const updateBody = (await updateRequestPromise).postDataJSON() as {
      assignedProjectId?: string | null
    }

    expect(updateBody.assignedProjectId).toBe('shared-launch')
  })

  test('共有 Project の選択状態は Team-local な同一 Work Item ID を区別する', async ({ page }) => {
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      teamIssuesByTeam: {
        'core-team': [
          createStoredTeamIssue({
            assignedProjectId: 'shared-launch',
            id: 'same-local-id',
            teamId: 'core-team',
            title: 'Core same local ID',
          }),
        ],
        'design-team': [
          createStoredTeamIssue({
            assignedProjectId: 'shared-launch',
            id: 'same-local-id',
            teamId: 'design-team',
            title: 'Design same local ID',
          }),
        ],
      },
    })

    await page.goto('/projects/shared-launch/issues')

    const duplicateRows = page.getByTestId('task-row-same-local-id')
    const coreRow = duplicateRows.filter({ hasText: 'Core same local ID' })
    const designRow = duplicateRows.filter({ hasText: 'Design same local ID' })

    await coreRow.getByRole('checkbox', { name: 'Core same local ID' }).check()

    await expect(coreRow).toHaveAttribute('data-selected', 'true')
    await expect(designRow).toHaveAttribute('data-selected', 'false')
  })

  test('共有 Project はタスクがない Team の workflow 列も表示する', async ({ page }) => {
    await mockAuthenticatedTaskPage(page, [], undefined, {
      teamIssuesByTeam: {
        'core-team': [
          createStoredTeamIssue({
            assignedProjectId: 'shared-launch',
            id: 'core-only-shared-issue',
            title: 'Core only shared issue',
          }),
        ],
      },
    })

    await page.goto('/projects/shared-launch/issues')
    await page.getByRole('tab', { name: 'ボード', exact: true }).click()

    await expect(page.getByTestId('project-task-column-core-team-todo')).toContainText(
      'コアチーム · 未着手',
    )
    const emptyDesignColumn = page.getByTestId('project-task-column-design-team-todo')

    await expect(emptyDesignColumn).toContainText('デザインチーム · 未着手')
    await expect(emptyDesignColumn).toContainText('この状態のタスクはありません。')
  })

  test('teamId のない共有 Project deep-link は選択 Issue の Team 設定と関連候補だけを詳細へ適用する', async ({
    page,
  }) => {
    const coreConfiguration = {
      ...teamWorkItemConfigurationFixture,
      scopeId: 'core-team',
      workflow: {
        ...teamWorkItemConfigurationFixture.workflow,
        id: 'core-shared-workflow',
        initialStatusId: 'core-active',
        statuses: [
          { id: 'core-active', name: 'Core configured', category: 'started', sortOrder: 0 },
        ],
        transitions: [],
      },
      customFields: [
        {
          id: 'core-context',
          name: 'Core-only field',
          type: 'text',
          sortOrder: 0,
          required: false,
        },
      ],
    } satisfies WorkItemConfiguration
    const designConfiguration = {
      ...teamWorkItemConfigurationFixture,
      scopeId: 'design-team',
      workflow: {
        ...teamWorkItemConfigurationFixture.workflow,
        id: 'design-shared-workflow',
        initialStatusId: 'design-active',
        statuses: [
          { id: 'design-active', name: 'Design configured', category: 'started', sortOrder: 0 },
        ],
        transitions: [],
      },
      customFields: [
        {
          id: 'design-context',
          name: 'Design-only field',
          type: 'text',
          sortOrder: 0,
          required: false,
        },
      ],
    } satisfies WorkItemConfiguration
    const requestedConfigurationTeamIds: string[] = []
    const requestedIssueListTeamIds: string[] = []

    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname
      const configurationMatch = pathname.match(
        /^\/api\/teams\/([^/]+)\/work-item-configuration$/,
      )
      const issueListMatch = pathname.match(/^\/api\/teams\/([^/]+)\/issues$/)

      if (configurationMatch?.[1]) {
        requestedConfigurationTeamIds.push(decodeURIComponent(configurationMatch[1]))
      }
      if (issueListMatch?.[1]) {
        requestedIssueListTeamIds.push(decodeURIComponent(issueListMatch[1]))
      }
    })

    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      projectNamesByTeam: {
        'core-team': { 'shared-launch': 'Core shared launch' },
        'design-team': { 'shared-launch': 'Design shared launch' },
      },
      teamExpandedById: {
        'core-team': false,
        'design-team': false,
      },
      teamIssuesByTeam: {
        'core-team': [
          createStoredTeamIssue({
            assignedProjectId: 'shared-launch',
            customFieldValues: { 'core-context': 'Core list value' },
            id: 'core-shared-issue',
            statusCategory: 'started',
            teamId: 'core-team',
            title: 'Core shared issue',
            workflowStatusId: 'core-active',
          }),
          createStoredTeamIssue({
            assignedProjectId: 'shared-launch',
            id: 'core-relation-candidate',
            teamId: 'core-team',
            title: 'Core relation candidate',
            workflowStatusId: 'core-active',
          }),
        ],
        'design-team': [
          createStoredTeamIssue({
            assignedProjectId: 'shared-launch',
            customFieldValues: { 'design-context': 'Design detail value' },
            description: 'design team selected detail',
            id: 'design-selected-issue',
            statusCategory: 'started',
            teamId: 'design-team',
            title: 'Design selected issue',
            workflowStatusId: 'design-active',
          }),
          createStoredTeamIssue({
            assignedProjectId: 'shared-launch',
            id: 'design-relation-candidate',
            teamId: 'design-team',
            title: 'Design relation candidate',
            workflowStatusId: 'design-active',
          }),
        ],
      },
      teamWorkItemConfigurations: {
        'core-team': coreConfiguration,
        'design-team': designConfiguration,
      },
    })

    await page.goto('/projects/shared-launch/issues?issueId=design-selected-issue')

    const coreRow = page.getByTestId('task-row-core-shared-issue')
    const designRow = page.getByTestId('task-row-design-selected-issue')
    const detailPane = page.getByTestId('task-detail-pane')

    await expect(coreRow).toBeVisible()
    await expect(designRow).toBeVisible()
    await expect(page.getByTestId('tasks-heading')).toHaveText('Design shared launch')
    const breadcrumb = page.getByLabel('プロジェクトのパンくずリスト')

    await expect(breadcrumb).toContainText('デザインチーム')
    await expect(breadcrumb).toContainText('Design shared launch')
    await expect(page.getByTestId('sidebar-team-core-team').first()).toHaveAttribute(
      'data-project-ancestor',
      'false',
    )
    await expect(page.getByTestId('sidebar-team-design-team').first()).toHaveAttribute(
      'data-project-ancestor',
      'true',
    )
    await expect(
      page.getByTestId('sidebar-team-design-team').first().getByRole('button', {
        name: 'デザインチーム',
        exact: true,
      }),
    ).toHaveAttribute('aria-expanded', 'true')
    await expect(coreRow).toContainText('Core configured')
    await expect(designRow).toContainText('Design configured')
    await expect(detailPane.locator('textarea[name="description"]')).toHaveValue(
      'design team selected detail',
    )
    await expect(detailPane.locator('select[name="workflowStatusId"]')).toHaveValue(
      'design-active',
    )
    await expect(detailPane.getByText('Design-only field')).toBeVisible()
    await expect(detailPane.getByText('Core-only field')).toHaveCount(0)
    await expect(detailPane.getByLabel('対象 Work Item').locator('option')).toHaveText([
      'Design relation candidate',
    ])
    await expect.poll(() => [...new Set(requestedConfigurationTeamIds)].sort()).toEqual([
      'core-team',
      'design-team',
    ])
    await expect.poll(() => [...new Set(requestedIssueListTeamIds)]).toEqual([
      'design-team',
    ])

    const statusFilterButton = page.getByRole('button', { name: 'ステータス', exact: true })

    await statusFilterButton.click()
    await expect(page.getByRole('menuitemradio', {
      name: 'コアチーム · Core configured',
    })).toBeVisible()
    await expect(page.getByRole('menuitemradio', {
      name: 'デザインチーム · Design configured',
    })).toBeVisible()
    await statusFilterButton.click()
    await page.getByRole('tab', { name: 'ボード', exact: true }).click()
    await expect(page.getByTestId('project-task-column-core-team-core-active')).toContainText(
      'Core configured',
    )
    await expect(page.getByTestId('project-task-column-design-team-design-active')).toContainText(
      'Design configured',
    )
  })

  test('未割り当て Work Item を My Tasks と通知 Inbox から Team 詳細へ開ける', async ({ page }) => {
    const issueId = 'unassigned-work-item'
    const issueDescription = '未割り当て Work Item の詳細です。'

    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      teamIssuesByTeam: {
        'core-team': [
          createStoredTeamIssue({
            assignedProjectId: undefined,
            assigneeEmail: 'demo@example.com',
            assigneeName: 'Demo User',
            assigneeUserId: 'demo@example.com',
            description: issueDescription,
            id: issueId,
            priority: 'high',
            workflowStatusId: 'review',
            title: '未割り当て Work Item',
          }),
        ],
      },
      notifications: [
        {
          eventType: 'work-item.assigned',
          id: 'notification-unassigned-work-item',
          issueId,
          occurredAt: '2026-07-12T02:00:00.000Z',
          reasons: ['assignee'],
          state: 'unread',
          summary: 'この Work Item の担当者に設定されました。',
          teamId: 'core-team',
          title: '未割り当て Work Item',
        },
      ],
    })

    await page.goto('/my-tasks')
    const card = page.getByTestId(`my-tasks-card-unassigned-${issueId}`)

    await expect(card).toBeVisible()
    await card.getByTestId(`my-tasks-card-unassigned-${issueId}-open`).click()
    await expect(page).toHaveURL(`/teams/core-team/issues?issueId=${issueId}`)
    await expect(page.locator('aside textarea[name="description"]')).toHaveValue(issueDescription)
    await expect(page.getByTestId('issue-collaboration-panel')).toContainText('背景を確認します。')

    await page.getByTestId('issue-row-wireframe').click()
    await expect(page).toHaveURL('/teams/core-team/issues?issueId=wireframe')
    await page.goBack()
    await expect(page).toHaveURL(`/teams/core-team/issues?issueId=${issueId}`)
    await expect(page.locator('aside textarea[name="description"]')).toHaveValue(issueDescription)

    await page.goto('/inbox')
    const inboxRow = page.getByTestId('notification-row-notification-unassigned-work-item')

    await expect(inboxRow).toBeVisible()
    await inboxRow.getByRole('button').first().click()
    await expect(page).toHaveURL(`/teams/core-team/issues?issueId=${issueId}`)
    await expect(page.locator('aside textarea[name="description"]')).toHaveValue(issueDescription)
  })

  test('Workspace 直下ルート間の遷移でサイドバーの手動状態を保持する', async ({ page }) => {
    await page.goto('/home')
    const homeSidebar = await expectWorkspaceRouteShell(page, 'ホーム')
    const coreTeamButton = homeSidebar
      .getByTestId('sidebar-team-core-team')
      .getByRole('button', { name: 'コアチーム', exact: true })

    await expect(coreTeamButton).toHaveAttribute('aria-expanded', 'true')
    await coreTeamButton.click()
    await expect(coreTeamButton).toHaveAttribute('aria-expanded', 'false')

    await homeSidebar.getByRole('button', { name: 'サイドバーを折りたたむ' }).click()
    await expect(homeSidebar).toHaveAttribute('data-collapsed', 'true')

    await homeSidebar.getByRole('button', { name: 'ダッシュボード', exact: true }).click()
    await expect(page).toHaveURL('/dashboard')

    const dashboardSidebar = await expectWorkspaceRouteShell(page, 'ダッシュボード')

    await expect(dashboardSidebar).toHaveAttribute('data-collapsed', 'true')
    await dashboardSidebar.getByRole('button', { name: 'サイドバーを展開する' }).click()
    await expect(dashboardSidebar).toHaveAttribute('data-collapsed', 'false')
    await expect(
      dashboardSidebar
        .getByTestId('sidebar-team-core-team')
        .getByRole('button', { name: 'コアチーム', exact: true }),
    ).toHaveAttribute('aria-expanded', 'false')
  })

  test('チーム概要では選択チームのプロジェクトタスクだけを集計する', async ({ page }) => {
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      teamIssuesByTeam: {
        'core-team': [
          createStoredTeamIssue({
            id: 'core-shared-launch-risk',
            title: 'コアチームだけの共通ローンチ確認',
            assignedProjectId: 'shared-launch',
            priority: 'high',
            workflowStatusId: 'review',
            teamId: 'core-team',
          }),
        ],
      },
    })

    await page.goto('/teams/design-team/overview')
    const sidebar = await expectWorkspaceRouteShell(page, 'デザインチーム の概要')

    await expect(
      sidebar
        .getByTestId('sidebar-team-design-team')
        .getByRole('button', { name: 'チーム概要', exact: true }),
    ).toHaveAttribute('aria-current', 'page')

    await expect(page.getByTestId('team-overview-projects').locator('p').last()).toHaveText('2')
    await expect(page.getByTestId('team-overview-open-tasks').locator('p').last()).toHaveText('0')
    await expect(page.getByTestId('team-overview-blocked').locator('p').last()).toHaveText('0')
    await expect(page.getByTestId('team-overview-project-table')).toBeVisible()

    const brandRefreshRow = page.getByTestId('team-overview-project-brand-refresh')

    await expect(brandRefreshRow).toContainText('ブランド刷新')
    await expect(brandRefreshRow).toContainText('0%')
    await expect(brandRefreshRow).toContainText('次の対応はありません')

    await brandRefreshRow.getByRole('button', { name: 'プロジェクトを開く' }).click()
    await expect(page).toHaveURL(/\/projects\/brand-refresh\/issues\?teamId=design-team$/)
  })

  test('チームメンバー画面ではプロジェクト横断の権限と負荷を確認できる', async ({ page }) => {
    const requestCounts = getMockRequestCounts(page)

    await page.goto('/teams/core-team/members')
    const sidebar = await expectWorkspaceRouteShell(page, 'コアチーム のメンバー')

    await expect(
      sidebar
        .getByTestId('sidebar-team-core-team')
        .getByRole('button', { name: 'メンバー', exact: true }),
    ).toHaveAttribute('aria-current', 'page')

    await expect(page.getByTestId('team-members-directory')).toBeVisible()
    await expect.poll(() => requestCounts.projectMemberReads).toBeGreaterThanOrEqual(3)

    const demoRow = page.getByTestId('team-member-row-demo-example-com')
    const satoRow = page.getByTestId('team-member-row-sato-example-com')

    await expect(demoRow).toContainText('Demo User')
    await expect(demoRow).toContainText('manager')
    await expect(demoRow).toContainText('Refero')
    await expect(demoRow).toContainText('プロダクトロードマップ')
    await expect(satoRow).toContainText('佐藤 花子')
    await expect(satoRow).toContainText('未完了 1 件')
    await expect(satoRow).toContainText('要確認 1 件')

    await page.getByTestId('team-members-search').fill('viewer')
    await expect(page.getByTestId('team-member-row-viewer2-example-com')).toBeVisible()
    await expect(page.getByTestId('team-member-row-sato-example-com')).toHaveCount(0)

    await page.getByTestId('team-members-role-filter').selectOption('viewer')
    await expect(page.getByTestId('team-member-row-viewer2-example-com')).toContainText('viewer')

    await page.getByTestId('team-member-project-viewer2-example-com-product-roadmap').click()
    await expect(page).toHaveURL(/\/projects\/product-roadmap\/issues\?teamId=core-team$/)
  })

  test('通知 Inbox で既読・archive・snooze を永続化し実未読件数へ反映する', async ({ page }) => {
    await page.clock.setFixedTime(notificationFixtureNow)
    const requestCounts = getMockRequestCounts(page)

    await page.goto('/inbox')
    const sidebar = await expectWorkspaceRouteShell(page, '受信箱')

    await expect(
      sidebar
        .getByRole('navigation', { name: 'グローバルナビゲーション' })
        .getByRole('button', { name: /^受信箱/ }),
    ).toHaveAttribute('aria-current', 'page')

    await expect(page.getByTestId('notification-inbox')).toBeVisible()
    const wireframeNotification = page.getByTestId('notification-row-notification-wireframe')
    const brandNotification = page.getByTestId('notification-row-notification-brand-guideline')

    await expect(wireframeNotification).toBeVisible()
    await expect(brandNotification).toBeVisible()
    await expect(page.getByLabel('1件の未読')).toBeVisible()
    await expect(page.getByRole('heading', { name: '今日', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '昨日', exact: true })).toBeVisible()

    await page.getByTestId('notification-type-filter').selectOption('work-item.updated')
    await expect(brandNotification).toBeVisible()
    await expect(wireframeNotification).toHaveCount(0)
    await page.getByTestId('notification-type-filter').selectOption('')

    await page.getByTestId('notification-filter-unread').click()
    await expect(wireframeNotification).toBeVisible()
    await expect(brandNotification).toHaveCount(0)
    await wireframeNotification.getByRole('button', { name: '既読にする' }).click()
    await expect(wireframeNotification).toHaveCount(0)
    await expect(page.getByTestId('notification-mark-all-read')).toBeDisabled()

    await page.getByTestId('notification-filter-read').click()
    await expect(wireframeNotification).toBeVisible()
    await expect(brandNotification).toBeVisible()

    await page.getByTestId('notification-filter-all').click()
    await brandNotification.getByRole('button', { name: 'アーカイブ' }).click()
    await expect(brandNotification).toHaveCount(0)
    await page.getByTestId('notification-filter-archived').click()
    await expect(brandNotification).toBeVisible()
    const archivedUnreadNotification = page.getByTestId(
      'notification-row-notification-archived-unread',
    )
    await expect(archivedUnreadNotification).toBeVisible()
    await expect(archivedUnreadNotification.getByLabel('未読')).toHaveCount(0)
    await expect(
      archivedUnreadNotification.getByRole('button', { name: '既読にする' }),
    ).toBeVisible()

    await page.reload()
    await page.getByTestId('notification-filter-archived').click()
    await expect(brandNotification).toBeVisible()
    await brandNotification.getByRole('button', { name: '戻す', exact: true }).click()

    await page.getByTestId('notification-filter-all').click()
    await page.getByTestId('notification-snooze-notification-wireframe').selectOption('one-hour')
    await expect(wireframeNotification).toHaveCount(0)
    await page.getByTestId('notification-filter-snoozed').click()
    await expect(wireframeNotification).toBeVisible()
    const snoozedUnreadNotification = page.getByTestId(
      'notification-row-notification-snoozed-unread',
    )
    await expect(snoozedUnreadNotification).toBeVisible()
    await expect(snoozedUnreadNotification.getByLabel('未読')).toHaveCount(0)
    await expect.poll(() => requestCounts.notificationUpdates).toBeGreaterThanOrEqual(4)
  })

  test('コメント通知から Work Item と対象コメントへ deep link できる', async ({ page }) => {
    const issueId = 'notification-comment-target'

    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      teamIssuesByTeam: {
        'core-team': [
          createStoredTeamIssue({
            id: issueId,
            workflowStatusId: 'in-progress',
            title: '通知のコメント確認',
          }),
        ],
      },
      notifications: [
        {
          commentId: 'comment-1',
          eventType: 'comment.mentioned',
          id: 'notification-comment-deep-link',
          issueId,
          occurredAt: '2026-07-12T03:20:00.000Z',
          projectId: 'refero',
          reasons: ['mention'],
          rootCommentId: 'comment-1',
          state: 'unread',
          summary: 'コメントであなたに確認を依頼しました。',
          teamId: 'core-team',
          title: '通知のコメント確認',
        },
      ],
    })
    await page.goto('/inbox')

    const notification = page.getByTestId('notification-row-notification-comment-deep-link')

    await notification.getByRole('button').first().click()
    await expect(page).toHaveURL(
      `/projects/refero/issues?teamId=core-team&issueId=${issueId}&commentId=comment-1&rootCommentId=comment-1`,
    )
    const focusedComment = page.locator('#comment-comment-1')

    await expect(focusedComment).toHaveAttribute('data-focused', 'true')
    await expect(focusedComment).toBeFocused()

    const watchButton = page.getByRole('button', { name: /ウォッチ/ }).first()
    const collaborationRefresh = page.waitForResponse((response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname.endsWith(`/teams/core-team/issues/${issueId}/collaboration`),
    )

    await watchButton.click()
    await collaborationRefresh
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
    await expect(watchButton).toBeFocused()
  })

  test('通知 Inbox は opaque cursor の次 page を追記する', async ({ page }) => {
    const notifications = Array.from({ length: 31 }, (_, index): InboxNotification => ({
      eventType: index % 2 === 0 ? 'comment.created' : 'work-item.updated',
      id: `pagination-${index + 1}`,
      occurredAt: new Date(Date.UTC(2026, 6, 12, 2, 0, 0) - index * 60_000).toISOString(),
      reasons: ['watcher'],
      state: 'unread',
      summary: `${index + 1}件目の通知`,
      title: `Cursor notification ${index + 1}`,
    }))

    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, { notifications })
    await page.goto('/inbox')

    await expect(page.getByTestId('notification-row-pagination-30')).toBeVisible()
    await expect(page.getByTestId('notification-row-pagination-31')).toHaveCount(0)
    await page.getByTestId('notification-load-more').click()
    await expect(page.getByTestId('notification-row-pagination-31')).toBeVisible()
  })

  test('Project と Team 画面のサイドバーも同じ実未読件数を表示する', async ({ page }) => {
    await page.goto('/projects/refero/issues?teamId=core-team&issueId=wireframe')
    await expect(page.getByLabel('1件の未読')).toBeVisible()

    await page.goto('/teams/core-team/issues?issueId=wireframe')
    await expect(page.getByLabel('1件の未読')).toBeVisible()
  })

  test('受信箱は同じ projectId と issueId を teamId で区別する', async ({ page }) => {
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      teamIssuesByTeam: {
        'core-team': [
          createStoredTeamIssue({
            id: 'duplicate-issue',
            title: '重複 Issue',
            assignedProjectId: 'shared-launch',
            assigneeUserId: 'demo@example.com',
            assigneeEmail: 'demo@example.com',
            assigneeName: 'Demo User',
            teamId: 'core-team',
            workflowStatusId: 'in-progress',
          }),
        ],
        'design-team': [
          createStoredTeamIssue({
            id: 'duplicate-issue',
            title: '重複 Issue',
            assignedProjectId: 'shared-launch',
            teamId: 'design-team',
            workflowStatusId: 'review',
          }),
        ],
      },
      notifications: [
        {
          eventType: 'work-item.updated',
          id: 'notification-core-duplicate',
          issueId: 'duplicate-issue',
          occurredAt: '2026-07-12T03:00:00.000Z',
          projectId: 'shared-launch',
          reasons: ['watcher'],
          state: 'unread',
          teamId: 'core-team',
          title: 'コアチームの重複 Issue',
        },
        {
          eventType: 'work-item.updated',
          id: 'notification-design-duplicate',
          issueId: 'duplicate-issue',
          occurredAt: '2026-07-12T02:00:00.000Z',
          projectId: 'shared-launch',
          reasons: ['watcher'],
          state: 'unread',
          teamId: 'design-team',
          title: 'デザインチームの重複 Issue',
        },
      ],
    })

    await page.goto('/inbox')

    const coreTeamRow = page.getByTestId('notification-row-notification-core-duplicate')
    const designTeamRow = page.getByTestId('notification-row-notification-design-duplicate')

    await expect(coreTeamRow).toBeVisible()
    await expect(designTeamRow).toBeVisible()

    await designTeamRow.getByRole('button').first().click()
    await expect(page).toHaveURL(
      '/projects/shared-launch/issues?teamId=design-team&issueId=duplicate-issue',
    )
  })

  test('保存済みAnalyticsレポートのKPIを再現可能なquery結果から表示する', async ({ page }) => {
    const analyticsState = await mockAnalyticsReportsPage(page)

    await page.goto('/reports')

    await expect(page.getByRole('heading', { name: 'Delivery health' })).toBeVisible()
    await expect(page.getByTestId('analytics-report-selector')).toHaveValue(
      'delivery-health',
    )
    await expect(page.getByTestId('analytics-widget-metric-wip')).toContainText('14')
    await expect(page.getByTestId('analytics-widget-metric-overdue')).toContainText('5')
    await expect.poll(() => analyticsState.queryInputs.at(-1)?.widgets.map(
      (widget) => widget.id,
    )).toEqual(analyticsReportFixtures[0].widgets.map((widget) => widget.id))
  })

  test('Analyticsレポートはchart groupとtable evidenceを表示する', async ({ page }) => {
    await mockAnalyticsReportsPage(page)

    await page.goto('/reports')

    await expect(page.getByTestId('analytics-widget-chart-cycle-time')).toContainText(
      'Core team',
    )
    await expect(page.getByTestId('analytics-widget-chart-cycle-time')).toContainText(
      'Design team',
    )
    await expect(page.getByTestId('analytics-widget-table-overdue')).toContainText(
      'Harden billing webhook retries',
    )
  })

  test('AnalyticsレポートをProjectで絞り込みCSV出力できる', async ({ page }) => {
    const analyticsState = await mockAnalyticsReportsPage(page)
    await page.goto('/reports')

    await expect(page.getByTestId('analytics-widget-metric-wip')).toBeVisible()
    const referoCheckbox = page.getByTestId('analytics-project-filter').getByRole(
      'checkbox',
      { name: 'Refero' },
    )

    await referoCheckbox.click()
    await expect(referoCheckbox).toBeChecked()
    await expect(page).toHaveURL(/(?:[?&])project=refero(?:&|$)/u)
    await expect.poll(() =>
      analyticsState.queryInputs.at(-1)?.filter.projectIds
    ).toEqual(['refero'])

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'CSV', exact: true }).click()
    const download = await downloadPromise
    const downloadPath = await download.path()

    expect(download.suggestedFilename()).toBe('mukuroji-analytics.csv')
    expect(downloadPath).not.toBeNull()
    if (!downloadPath) {
      throw new Error('CSV download path was not available.')
    }

    const csv = await readFile(downloadPath, 'utf8')

    expect(csv).toContain('wip,14')
    await expect.poll(() => analyticsState.exportInputs.at(-1)).toEqual(
      expect.objectContaining({
        format: 'csv',
        locale: 'ja',
        query: expect.objectContaining({
          filter: expect.objectContaining({
            projectIds: ['refero'],
          }),
        }),
      }),
    )
  })

  test('Analyticsレポートのcustom field条件をqueryへ反映する', async ({ page }) => {
    const analyticsState = await mockAnalyticsReportsPage(page)
    await page.goto('/reports')

    await expect(page.getByTestId('analytics-widget-metric-wip')).toBeVisible()
    await page.getByText('詳細フィルター', { exact: true }).click()
    const customFieldFilters = page.getByTestId('analytics-custom-field-filters')
    await customFieldFilters.getByLabel('フィールドID').fill('budget')
    await customFieldFilters.getByLabel('比較方法').selectOption(
      'greater-than-or-equal',
    )
    await customFieldFilters.getByLabel('値').fill('1200000')
    await customFieldFilters.getByRole('button', { name: '条件を追加' }).click()

    await expect.poll(() =>
      analyticsState.queryInputs.at(-1)?.filter.customFields
    ).toEqual([
      {
        fieldId: 'budget',
        operator: 'greater-than-or-equal',
        value: 1_200_000,
      },
    ])
  })

  test('設定画面でフォントサイズを変更して保存できる', async ({ page }) => {
    await page.goto('/settings')

    await expect(page.getByTestId('font-size-preference-control')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-font-size', 'standard')
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('15px')
    const settingsHeading = page.getByRole('heading', { name: '設定', exact: true })
    const standardHeadingFontSize = await settingsHeading.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).fontSize),
    )

    await page.getByTestId('font-size-preference-comfortable').click()

    await expect(page.locator('html')).toHaveAttribute('data-font-size', 'comfortable')
    await expect(page.getByTestId('font-size-preference-comfortable')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem('mukuroji.fontSize'))).toBe('comfortable')
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('16px')
    await expect.poll(() =>
      settingsHeading.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
    ).toBeGreaterThan(standardHeadingFontSize)

    await page.reload()

    await expect(page.locator('html')).toHaveAttribute('data-font-size', 'comfortable')
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('16px')
    await page.getByRole('button', { name: 'マイタスク', exact: true }).click()
    await expect(page).toHaveURL('/my-tasks')
    await expect(page.getByTestId('my-tasks-kanban')).toBeVisible()
  })

  test('設定画面で通知 channel・frequency・quiet hours を保存できる', async ({ page }) => {
    const requestCounts = getMockRequestCounts(page)

    await page.goto('/settings')
    await expect(page.getByTestId('notification-settings')).toBeVisible()
    await expect(page.getByTestId('notification-channel-inApp')).toBeChecked()
    await expect(page.getByTestId('notification-channel-email')).toBeChecked()
    await expect(page.getByTestId('notification-channel-push')).not.toBeChecked()

    await page.getByTestId('notification-channel-push').check()
    await page.getByTestId('notification-frequency').selectOption('daily')
    await page.getByTestId('notification-quiet-hours-start').fill('21:30')
    await page.getByTestId('notification-quiet-hours-end').fill('07:30')
    await page.getByTestId('notification-time-zone').fill('Asia/Tokyo')
    await page.getByTestId('notification-settings-save').click()

    await expect.poll(() => requestCounts.notificationPreferenceUpdates).toBe(1)
    await expect(page.getByText('通知設定を保存しました。')).toBeVisible()

    await page.reload()
    await expect(page.getByTestId('notification-channel-push')).toBeChecked()
    await expect(page.getByTestId('notification-frequency')).toHaveValue('daily')
    await expect(page.getByTestId('notification-quiet-hours-start')).toHaveValue('21:30')
    await expect(page.getByTestId('notification-quiet-hours-end')).toHaveValue('07:30')
  })

  test('設定画面で Workspace member と invitation lifecycle を確認付きで管理できる', async ({ page }) => {
    let invitationCreates = 0
    let invitationActions = 0
    let memberUpdateAttempts = 0

    await page.route('**/api/workspace/invitations', async (route) => {
      invitationCreates += 1
      expect(route.request().method()).toBe('POST')
      expect(route.request().postDataJSON()).toEqual({
        email: 'new.member@example.com',
        name: 'New Member',
        role: 'member',
      })
      await route.fulfill({
        status: 201,
        json: {
          invitation: {
            createdAt: '2026-07-11T04:00:00.000Z',
            deliveryStatus: 'pending',
            email: 'new.member@example.com',
            expiresAt: '2026-07-18T04:00:00.000Z',
            id: 'invitation-new',
            identityOwnership: 'workspace-created',
            name: 'New Member',
            role: 'member',
            status: 'pending',
            updatedAt: '2026-07-11T04:00:00.000Z',
            version: 1,
          },
        },
      })
    })
    await page.route(/.*\/api\/workspace\/invitations\/[^/]+\/(?:resend|revoke|reinvite)$/, async (route) => {
      invitationActions += 1
      expect(route.request().method()).toBe('POST')
      await route.fulfill({ json: { invitation: {} } })
    })
    await page.route(/.*\/api\/workspace\/members\/[^/]+$/, async (route) => {
      memberUpdateAttempts += 1
      expect(route.request().method()).toBe('PATCH')
      expect(route.request().postDataJSON()).toEqual({
        expectedVersion: 2,
        role: 'guest',
      })

      if (memberUpdateAttempts === 1) {
        await route.fulfill({ status: 409, json: { message: 'workspace.member.version_conflict' } })
        return
      }

      await route.fulfill({ json: { member: {} } })
    })

    await page.goto('/settings')

    await expect(page.getByTestId('workspace-access-panel')).toBeVisible()
    await expect(page.getByTestId('workspace-invitation-invitation-failed')).toContainText('配信失敗')
    await expect(page.getByTestId('workspace-invitation-invitation-expired')).toContainText('期限切れ')
    await expect(page.getByTestId('workspace-member-demo-example-com').getByRole('button', { name: '利用停止' })).toBeDisabled()

    const inviteForm = page.getByTestId('workspace-invite-form')
    await inviteForm.locator('input[name="email"]').fill('new.member@example.com')
    await inviteForm.locator('input[name="name"]').fill('New Member')
    await inviteForm.getByRole('button', { name: '招待を作成' }).click()
    await expect.poll(() => invitationCreates).toBe(1)

    await page.getByTestId('workspace-member-role-sato-example-com').selectOption('guest')
    const roleDialog = page.getByRole('dialog', { name: 'Workspace ロールを変更しますか？' })
    await expect(roleDialog).toBeVisible()
    await roleDialog.getByRole('button', { name: 'ロールを変更' }).click()
    await expect(roleDialog.getByRole('alert')).toContainText('別の管理者が先に更新しました')
    await roleDialog.getByRole('button', { name: 'ロールを変更' }).click()
    await expect(roleDialog).toHaveCount(0)
    expect(memberUpdateAttempts).toBe(2)

    const failedInvitation = page.getByTestId('workspace-invitation-invitation-failed')
    await failedInvitation.getByRole('button', { name: '再送' }).click()
    const resendDialog = page.getByRole('dialog', { name: '招待を再送しますか？' })
    await resendDialog.getByRole('button', { name: '再送' }).click()
    await expect(resendDialog).toHaveCount(0)

    const expiredInvitation = page.getByTestId('workspace-invitation-invitation-expired')
    await expiredInvitation.getByRole('button', { name: '再招待' }).click()
    const reinviteDialog = page.getByRole('dialog', { name: '新しい招待を作成しますか？' })
    await reinviteDialog.getByRole('button', { name: '再招待' }).click()
    await expect(reinviteDialog).toHaveCount(0)
    expect(invitationActions).toBe(2)
  })

  test('タスク画面から新規タスクを登録できる', async ({ page }) => {
    await page.goto('/projects/refero/tasks')
    const requestCounts = getMockRequestCounts(page)

    await page.getByRole('button', { name: '新規タスク' }).click()
    const createTaskForm = page.getByTestId('create-task-form')

    await createTaskForm.locator('input[name="title"]').fill('新規タスク')
    await createTaskForm.locator('select[name="assigneeUserId"]').selectOption('sato@example.com')
    await createTaskForm.locator('input[name="dueDate"]').fill('2026-06-20')
    await createTaskForm.getByRole('button', { name: '登録', exact: true }).click()

    await expect(page.getByTestId('task-row-new-task').getByText('新規タスク')).toBeVisible()
    expect(requestCounts.issueCreates).toBe(1)
  })

  test('タスク本文をスクロール後に新規タスクを開いても作成パネルを表示する', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 520 })
    await page.goto('/projects/refero/tasks')

    const mainScroll = page.getByTestId('task-main-scroll')

    await mainScroll.evaluate((element) => {
      element.scrollTo({ top: element.scrollHeight })
    })
    await expect.poll(() => mainScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

    await page.getByRole('button', { name: '新規タスク' }).click()

    await expect(page.getByTestId('create-task-form').locator('input[name="title"]')).toBeVisible()
    await expect.poll(() => mainScroll.evaluate((element) => element.scrollTop)).toBe(0)
  })

  test('担当者を選択しない新規タスク登録は送信しない', async ({ page }) => {
    await page.goto('/projects/refero/tasks')
    const requestCounts = getMockRequestCounts(page)

    await page.getByRole('button', { name: '新規タスク' }).click()
    const createTaskForm = page.getByTestId('create-task-form')

    await createTaskForm.locator('input[name="title"]').fill('担当者未選択タスク')
    await createTaskForm.locator('input[name="dueDate"]').fill('2026-06-20')
    await createTaskForm.getByRole('button', { name: '登録', exact: true }).click()

    await expect(createTaskForm.locator('select[name="assigneeUserId"]')).toHaveValue('')
    expect(requestCounts.issueCreates).toBe(0)
  })

  test('担当者候補 API 失敗時は空状態と分けて表示する', async ({ page }) => {
    await page.route(/.*\/api\/projects\/refero\/members$/, async (route) => {
      await route.fulfill({
        status: 500,
        json: {
          message: 'projects.error.loading',
        },
      })
    })

    await page.goto('/projects/refero/tasks')
    await page.getByRole('button', { name: '新規タスク' }).click()

    await expect(page.getByText('担当者候補を取得できませんでした')).toBeVisible()
    await expect(page.getByText('担当者にできるプロジェクトメンバーがいません。')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '登録', exact: true })).toBeDisabled()
  })

  test('利用停止中の Workspace member を project と担当者の追加候補から除外する', async ({ page }) => {
    await page.goto('/projects/refero/tasks?teamId=core-team')
    await page.getByRole('button', { name: '新規タスク' }).click()

    const assigneeSelect = page.getByTestId('create-task-form').locator('select[name="assigneeUserId"]')

    await expect(assigneeSelect.locator('option[value="inactive@example.com"]')).toHaveCount(0)

    await page.getByRole('tab', { name: /権限/ }).click()
    await expect(page.getByTestId('permission-member-row-inactive-example-com')).toBeVisible()
    await page.getByTestId('permissions-user-search').fill('inactive')
    await expect(page.getByTestId('permissions-user-select').locator('option[value="inactive@example.com"]')).toHaveCount(0)
  })

  test('タスク API 失敗時にエラーを表示する', async ({ page }) => {
    await page.route('**/api/projects/refero/issues', async (route) => {
      await route.fulfill({
        status: 500,
        json: {
          message: 'Lambda returned 500.',
        },
      })
    })

    await page.goto('/projects/refero/tasks')

    await expect(page.getByTestId('tasks-error')).toHaveText(
      'タスク一覧を取得できませんでした: Lambda returned 500.',
    )
  })

  test('タスクが空の場合に empty 表示を出す', async ({ page }) => {
    await page.route('**/api/projects/refero/issues', async (route) => {
      await route.fulfill({
        json: {
          projectId: 'refero',
          issues: [],
        },
      })
    })

    await page.goto('/projects/refero/tasks')

    await expect(page.getByTestId('tasks-empty')).toBeVisible()
    await expect(page.getByTestId('tasks-count')).toContainText('0')
  })
})

test('マイタスクの片方の移動が失敗しても別 Issue の成功済み移動を維持する', async ({ page }) => {
  let markOnboardingUpdateStarted!: () => void
  let releaseOnboardingFailure!: () => void
  const onboardingUpdateStarted = new Promise<void>((resolve) => {
    markOnboardingUpdateStarted = resolve
  })
  const onboardingFailureReleased = new Promise<void>((resolve) => {
    releaseOnboardingFailure = resolve
  })

  await mockAuthenticatedTaskPage(page, referoTaskFixtures, async (taskId) => {
    if (taskId !== 'onboarding-friction') {
      return undefined
    }

    markOnboardingUpdateStarted()
    await onboardingFailureReleased
    return 'fail'
  }, {
    teamIssuesByTeam: {
      'core-team': [
        createStoredTeamIssue({
          id: 'onboarding-friction',
          title: '初回オンボーディングの離脱要因を減らす',
          workflowStatusId: 'in-progress',
          priority: 'high',
        }),
        createStoredTeamIssue({
          id: 'billing-copy',
          title: '料金導線の説明不足を解消する',
          workflowStatusId: 'todo',
        }),
      ],
    },
  })
  await mockCurrentUser(page, 'sato@example.com', '佐藤 花子')

  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/my-tasks')

  await page
    .getByTestId('my-tasks-card-refero-onboarding-friction-status-select')
    .selectOption('done')
  await onboardingUpdateStarted

  await page
    .getByTestId('my-tasks-card-refero-billing-copy-status-select')
    .selectOption('done')
  await expect(
    page.getByTestId('my-tasks-column-core-team-done').getByTestId('my-tasks-card-refero-billing-copy'),
  ).toBeVisible()

  releaseOnboardingFailure()

  await expect(page.getByTestId('my-tasks-move-error')).toBeVisible()
  await expect(
    page.getByTestId('my-tasks-column-core-team-in-progress').getByTestId('my-tasks-card-refero-onboarding-friction'),
  ).toBeVisible()
  await expect(
    page.getByTestId('my-tasks-column-core-team-done').getByTestId('my-tasks-card-refero-billing-copy'),
  ).toBeVisible()
  await expect(
    page.getByTestId('my-tasks-column-core-team-todo').getByTestId('my-tasks-card-refero-billing-copy'),
  ).toHaveCount(0)
  expect(getMockRequestCounts(page).issueUpdates).toBe(2)
  expect(getMockRequestCounts(page).taskStatusUpdates).toBe(0)
})

test('マイタスクでは同一 Issue の移動中に追加移動を開始できない', async ({ page }) => {
  let markOnboardingDoneUpdateStarted!: () => void
  let releaseOnboardingDoneUpdate!: () => void
  const onboardingDoneUpdateStarted = new Promise<void>((resolve) => {
    markOnboardingDoneUpdateStarted = resolve
  })
  const onboardingDoneUpdateReleased = new Promise<void>((resolve) => {
    releaseOnboardingDoneUpdate = resolve
  })

  await mockAuthenticatedTaskPage(page, referoTaskFixtures, async (taskId, status) => {
    if (taskId !== 'onboarding-friction' || status !== 'done') {
      return undefined
    }

    markOnboardingDoneUpdateStarted()
    await onboardingDoneUpdateReleased
    return undefined
  }, {
    teamIssuesByTeam: {
      'core-team': [
        createStoredTeamIssue({
          id: 'onboarding-friction',
          title: '初回オンボーディングの離脱要因を減らす',
          workflowStatusId: 'in-progress',
          priority: 'high',
        }),
      ],
    },
  })
  await mockCurrentUser(page, 'sato@example.com', '佐藤 花子')

  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/my-tasks')

  await page
    .getByTestId('my-tasks-card-refero-onboarding-friction-status-select')
    .selectOption('done')
  await onboardingDoneUpdateStarted
  await expect(
    page.getByTestId('my-tasks-column-core-team-done').getByTestId('my-tasks-card-refero-onboarding-friction'),
  ).toBeVisible()
  await expect(
    page.getByTestId('my-tasks-card-refero-onboarding-friction-status-select'),
  ).toBeDisabled()
  expect(getMockRequestCounts(page).issueUpdates).toBe(1)

  releaseOnboardingDoneUpdate()

  await expect(
    page.getByTestId('my-tasks-card-refero-onboarding-friction-status-select'),
  ).toBeEnabled()
  expect(getMockRequestCounts(page).issueUpdates).toBe(1)
  expect(getMockRequestCounts(page).taskStatusUpdates).toBe(0)
  expect(getMockRequestCounts(page).workspaceWorkItems).toBe(1)
  expect(getMockRequestCounts(page).projectTasks).toEqual({})
})

test('未認証の場合はログイン画面へ戻す', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('mukuroji.locale', 'ja')
  })

  await page.goto('/projects/refero/tasks')

  await expect(page).toHaveURL('/')
  await expect(page.getByRole('heading', { name: 'ログイン' })).toBeVisible()
})
