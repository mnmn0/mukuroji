import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import {
  COLLABORATION_CONTEXT_SCHEMA_VERSION,
  DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY,
  FOCUS_SCHEMA_VERSION,
  PLANNING_SCHEMA_VERSION,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type AnalyticsExportInput,
  type AnalyticsQueryInput,
  type ApprovalRequest,
  type ConfirmWorkItemScheduleChangeInput,
  type CuratedContextItem,
  type CustomFieldValue,
  type FileAnnotation,
  type FileAttachment,
  type FileVersion,
  type FocusItem,
  type FocusPolicy,
  type FocusPolicyOverrides,
  type FocusPolicySettings,
  type FocusQueueResponse,
  type FocusQueueSection,
  type ProjectQuickAccessPreferences,
  type PlanningSnapshot,
  type PreviewWorkItemScheduleInput,
  type WorkItemConfiguration,
  type WorkItemRelation,
  type WorkItemRelationType,
  type WorkItemSchedule,
  type WorkItemScheduleChangePreview,
  type WorkItemScheduleDependency,
  type WorkItemScheduleDependencyConflict,
  type WorkItemScheduleImpact,
  type WorkItemScheduleOperation,
} from '@mukuroji/contracts'
import { readFile } from 'node:fs/promises'
import {
  analyticsReportFixtures,
  analyticsSnapshotFixture,
} from '../src/analytics/fixtures'
import { focusQueueResponseFixture } from '../src/features/focus-queue/fixtures'
import type { TeamIssue, TeamIssueActivity, TeamIssueComment } from '../src/issues/api'
import type { InboxNotification, NotificationPreferences } from '../src/notifications/api'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import type { ProjectDirectoryTeam, ProjectMember, ProjectMemberRole, ProjectUser } from '../src/projects/api'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import type { CanonicalWorkItem } from '../src/tasks/api'
import { referoTaskFixtures } from '../src/tasks/fixtures'
import {
  teamWorkItemConfigurationFixture,
  workspaceWorkItemConfigurationFixture,
} from '../src/work-items/fixtures'
import type { WorkspaceAccess } from '../src/workspace/api'

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

/** Counts requests received by the API stub. */
type MockRequestCounts = {
  /** Number of team and project directory API requests. */
  projectDirectory: number
  /** Number of Issue API requests grouped by project. */
  projectIssues: Record<string, number>
  /**
   * Workspace 全体の Work Item 一覧 API request 数です。
   */
  workspaceWorkItems: number
  /**
   * Focus queue snapshot API request count.
   */
  focusReads: number
  /**
   * Focus snooze mutation API request count.
   */
  focusSnoozeUpdates: number
  /**
   * Focus watch mutation API request count.
   */
  focusWatchUpdates: number
  /**
   * Focus policy mutation API request count.
   */
  focusPolicyUpdates: number
  /**
   * Focus policy replacement inputs observed by the mock API.
   */
  focusPolicyInputs: unknown[]
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
  /** Idempotency keys observed by the task create API stub. */
  issueCreateIdempotencyKeys: string[]
  /**
   * チーム Issue 更新 API の request 数です。
   */
  issueUpdates: number
  /**
   * Work Item schedule preview API の request 数です。
   */
  schedulePreviews: number
  /**
   * Work Item schedule confirm API の request 数です。
   */
  scheduleConfirms: number
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
   * `/api/auth/me` が返す現在ユーザーの上書きです。
   */
  currentUser?: {
    /** Cognito username と project member key です。 */
    username: string
    /** 画面に表示するユーザー名です。 */
    name: string
    /** Workspace 全体を管理できる system admin かどうかです。 */
    isSystemAdmin: boolean
    /** Workspace 内の content mutation を制御する role です。 */
    workspaceRole: 'guest' | 'member' | 'admin' | 'owner'
  }
  /**
   * Team ID ごとに Sidebar の初期展開状態を上書きする値です。
   */
  teamExpandedById?: Partial<Record<string, boolean>>
  /**
   * Team と Project ID ごとに directory 表示名を上書きする値です。
   */
  projectNamesByTeam?: Partial<Record<string, Partial<Record<string, string>>>>
  /**
   * Project ごとの role 判定に使う member 一覧の上書きです。
   */
  projectMembersByProject?: Partial<Record<string, readonly ProjectMember[]>>
  /**
   * チーム Issue API が初期状態として返す保存済み Issue 一覧です。
   */
  teamIssuesByTeam?: Partial<Record<string, TeamIssue[]>>
  /**
   * 初回更新を revision conflict にする `teamId\0issueId` key の一覧です。
   */
  revisionConflictIssueKeys?: readonly string[]
  /**
   * Schedule preview を permission error にする `teamId\0issueId` key の一覧です。
   */
  forbiddenSchedulePreviewIssueKeys?: readonly string[]
  /** One-based Focus snooze request numbers that should fail without mutating state. */
  failedFocusSnoozeRequestNumbers?: readonly number[]
  /**
   * Planning snapshot と schedule preview に使う canonical dependency 一覧です。
   */
  workItemScheduleDependencies?: readonly WorkItemScheduleDependency[]
  /**
   * Planning snapshot と schedule preview に表示する blocking conflict 一覧です。
   */
  workItemScheduleDependencyConflicts?: readonly WorkItemScheduleDependencyConflict[]
  /** Number of initial Planning snapshot requests that should fail before retry succeeds. */
  planningFailureCount?: number
  /** Number of Project Work Item GET requests to fail after schedule confirmation commits. */
  postConfirmProjectIssueFailureCount?: number
  /** Number of Project Work Item GET requests to fail after a task create commits. */
  postCreateProjectIssueFailureCount?: number
  /** HTTP status returned by the post-create Project Work Item GET failure. */
  postCreateProjectIssueFailureStatus?: number
  /** Stable error code returned by the post-create Project Work Item GET failure. */
  postCreateProjectIssueFailureCode?: string
  /** Number of create requests that should fail before a retry succeeds. */
  createIssueFailureCount?: number
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
  /**
   * Focus API snapshot used by Workspace queue and attention previews.
   */
  focusQueue?: FocusQueueResponse
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
    projectIssues: {},
    workspaceWorkItems: 0,
    focusReads: 0,
    focusSnoozeUpdates: 0,
    focusWatchUpdates: 0,
    focusPolicyUpdates: 0,
    focusPolicyInputs: [],
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
    issueCreateIdempotencyKeys: [],
    issueUpdates: 0,
    schedulePreviews: 0,
    scheduleConfirms: 0,
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
  let projectQuickAccess: ProjectQuickAccessPreferences = {
    items: [
      { projectId: 'refero', teamId: 'core-team' },
      { projectId: 'product-roadmap', teamId: 'core-team' },
      { projectId: 'shared-launch', teamId: 'core-team' },
      { projectId: 'brand-refresh', teamId: 'design-team' },
      { projectId: 'shared-launch', teamId: 'design-team' },
    ],
    revision: 1,
  }
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
  const taskResponsesByProject: Record<string, CanonicalWorkItem[]> = {
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
  const forbiddenSchedulePreviewIssueKeys = new Set(
    options.forbiddenSchedulePreviewIssueKeys ?? [],
  )
  const failedFocusSnoozeRequestNumbers = new Set(
    options.failedFocusSnoozeRequestNumbers ?? [],
  )
  const workItemScheduleDependencies = structuredClone([
    ...(options.workItemScheduleDependencies ?? []),
  ])
  const workItemScheduleDependencyConflicts = structuredClone([
    ...(options.workItemScheduleDependencyConflicts ?? []),
  ])
  const currentUser = options.currentUser ?? {
    username: 'demo@example.com',
    name: 'Demo User',
    isSystemAdmin: true,
    workspaceRole: 'owner' as const,
  }
  const planningRevision = 1
  let remainingPlanningFailures = Math.max(0, options.planningFailureCount ?? 0)
  let remainingPostConfirmProjectIssueFailures = Math.max(
    0,
    options.postConfirmProjectIssueFailureCount ?? 0,
  )
  let remainingCreateIssueFailures = Math.max(0, options.createIssueFailureCount ?? 0)
  let remainingPostCreateProjectIssueFailures = Math.max(
    0,
    options.postCreateProjectIssueFailureCount ?? 0,
  )
  let committedIssueCreates = 0
  const failedWorkItemConfigurationTeamIds = new Set(
    options.failedWorkItemConfigurationTeamIds ?? [],
  )
  const issueCommentsByIssue: Record<string, TeamIssueComment[]> = {}
  const issueActivityByIssue: Record<string, TeamIssueActivity[]> = {}
  let notifications = (options.notifications ?? createDefaultNotifications()).map((notification) => ({
    ...notification,
    reasons: [...notification.reasons],
  }))
  let focusQueue = structuredClone(options.focusQueue ?? focusQueueResponseFixture)
  const previousFocusSections = new Map<string, FocusQueueSection>()
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
  for (const [projectId, members] of Object.entries(options.projectMembersByProject ?? {})) {
    if (members) {
      projectMembersByProject[projectId] = structuredClone([...members])
    }
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
        username: currentUser.username,
        attributes: {
          'custom:workspace_id': 'workspace-demo',
          email: currentUser.username,
          name: currentUser.name,
        },
        groups: currentUser.isSystemAdmin ? ['mukuroji-system-admins'] : [],
        isSystemAdmin: currentUser.isSystemAdmin,
        workspaceMemberStatus: 'active',
        workspaceRole: currentUser.workspaceRole,
      },
    })
  })

  await page.route('**/api/workspace/access', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')
    await route.fulfill({ json: workspaceAccess })
  })

  await page.route('**/api/projects/quick-access', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')
    expect(route.request().method()).toBe('GET')
    await route.fulfill({ json: projectQuickAccess })
  })

  await page.route(/.*\/api\/task-views(?:\?.*)?$/, async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')
    expect(route.request().method()).toBe('GET')
    await route.fulfill({
      json: {
        capabilities: {
          canManageSharedViews: true,
          canSetTeamDefault: true,
          canWrite: true,
          writableProjectScopes: projectDirectory.flatMap((team) => team.projects.map((project) => ({
            projectId: project.id,
            teamId: team.id,
          }))),
          writableTeamIds: projectDirectory.map((team) => team.id),
        },
        views: [],
      },
    })
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
      projectQuickAccess = {
        items: projectQuickAccess.items.filter((item) => item.teamId !== teamId),
        revision: projectQuickAccess.revision + 1,
      }
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
      projectQuickAccess = {
        items: projectQuickAccess.items.filter((item) =>
          item.teamId !== teamId || item.projectId !== projectId,
        ),
        revision: projectQuickAccess.revision + 1,
      }
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

  await page.route(/.*\/api\/projects\/[^/]+\/issues(?:\?.*)?$/, async (route) => {
    const pathSegments = new URL(route.request().url()).pathname.split('/')
    const projectId = decodeURIComponent(pathSegments[3] ?? '')
    recordProjectIssueRequest(requestCounts, projectId)

    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    if (requestCounts.scheduleConfirms > 0 && remainingPostConfirmProjectIssueFailures > 0) {
      remainingPostConfirmProjectIssueFailures -= 1
      await route.fulfill({
        json: {
          code: 'ProjectIssuesUnavailable',
          message: 'issues.error.loading',
        },
        status: 503,
      })
      return
    }

    if (committedIssueCreates > 0 && remainingPostCreateProjectIssueFailures > 0) {
      remainingPostCreateProjectIssueFailures -= 1
      await route.fulfill({
        json: {
          code: options.postCreateProjectIssueFailureCode ?? 'ProjectIssuesUnavailable',
          message: options.postCreateProjectIssueFailureStatus === 401
            ? 'Unauthorized'
            : 'issues.error.loading',
        },
        status: options.postCreateProjectIssueFailureStatus ?? 503,
      })
      return
    }

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

  await page.route('**/api/work-items**', async (route) => {
    requestCounts.workspaceWorkItems += 1
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    const projectWorkItems = Object.values(taskResponsesByProject).flat()

    await route.fulfill({
      json: {
        workItems: [...projectWorkItems, ...Object.values(teamIssuesByTeam).flat()],
      },
    })
  })

  await page.route('**/api/planning', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')
    expect(route.request().method()).toBe('GET')

    if (remainingPlanningFailures > 0) {
      remainingPlanningFailures -= 1
      await route.fulfill({
        json: {
          code: 'PlanningUnavailable',
          message: 'Planning dependency data is temporarily unavailable.',
        },
        status: 503,
      })
      return
    }

    await route.fulfill({
      json: createMockPlanningSnapshot(
        taskResponsesByProject,
        teamIssuesByTeam,
        workItemScheduleDependencies,
        workItemScheduleDependencyConflicts,
        planningRevision,
      ),
    })
  })

  await page.route(/.*\/api\/focus(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback()
      return
    }

    requestCounts.focusReads += 1
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')
    await route.fulfill({ json: focusQueue })
  })

  await page.route(
    /.*\/api\/focus\/items\/[^/]+\/[^/]+\/snooze(?:\?.*)?$/,
    async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.fallback()
        return
      }

      requestCounts.focusSnoozeUpdates += 1
      expect(route.request().headers().authorization).toBe('Bearer test-access-token')
      if (failedFocusSnoozeRequestNumbers.has(requestCounts.focusSnoozeUpdates)) {
        await route.fulfill({
          status: 503,
          json: { code: 'FocusSnoozeUnavailable', message: 'Focus snooze failed.' },
        })
        return
      }
      const { teamId, workItemId } = readMockFocusItemRoute(route.request().url())
      const body: unknown = route.request().postDataJSON()
      const item = findMockFocusItem(focusQueue, teamId, workItemId)

      if (!isMockFocusSnoozeInput(body) || !item) {
        await route.fulfill({ status: 404, json: { message: 'Focus item not found.' } })
        return
      }
      if (body.expectedVersion !== item.version) {
        await route.fulfill({ status: 409, json: { message: 'Focus item version conflict.' } })
        return
      }

      const itemKey = createMockFocusItemKey(teamId, workItemId)
      if (body.snoozedUntil) previousFocusSections.set(itemKey, item.section)
      const nextSection = body.snoozedUntil
        ? 'snoozed'
        : previousFocusSections.get(itemKey) ?? 'now'
      const updatedItem = structuredClone(item)
      updatedItem.section = nextSection
      updatedItem.updatedAt = new Date().toISOString()
      updatedItem.version += 1
      updatedItem.snoozeRevision += 1
      if (body.snoozedUntil) updatedItem.snoozedUntil = body.snoozedUntil
      else delete updatedItem.snoozedUntil
      focusQueue = moveMockFocusItem(focusQueue, updatedItem)

      await route.fulfill({ json: { item: updatedItem } })
    },
  )

  await page.route(
    /.*\/api\/focus\/items\/[^/]+\/[^/]+\/watch(?:\?.*)?$/,
    async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.fallback()
        return
      }

      requestCounts.focusWatchUpdates += 1
      expect(route.request().headers().authorization).toBe('Bearer test-access-token')
      const { teamId, workItemId } = readMockFocusItemRoute(route.request().url())
      const body: unknown = route.request().postDataJSON()
      const item = findMockFocusItem(focusQueue, teamId, workItemId)

      if (!isMockFocusWatchInput(body) || !item) {
        await route.fulfill({ status: 404, json: { message: 'Focus item not found.' } })
        return
      }
      if (body.expectedVersion !== item.version) {
        await route.fulfill({ status: 409, json: { message: 'Focus item version conflict.' } })
        return
      }

      const updatedItem: FocusItem = {
        ...item,
        updatedAt: new Date().toISOString(),
        version: item.version + 1,
        watching: body.watching,
      }
      focusQueue = replaceMockFocusItem(focusQueue, updatedItem)
      await route.fulfill({ json: { item: updatedItem } })
    },
  )

  await page.route(/.*\/api\/focus\/policies(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.fallback()
      return
    }

    requestCounts.focusPolicyUpdates += 1
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')
    const body: unknown = route.request().postDataJSON()
    requestCounts.focusPolicyInputs.push(structuredClone(body))
    const target: FocusPolicy['target'] = isMockRecord(body) &&
      isMockRecord(body.target) &&
      body.target.type === 'team' &&
      typeof body.target.teamId === 'string'
      ? { teamId: body.target.teamId, type: 'team' }
      : { type: 'user' }
    const overrides = isMockRecord(body)
      ? readMockFocusPolicyOverrides(body.overrides)
      : undefined
    if (!overrides) {
      await route.fulfill({ status: 400, json: { message: 'Invalid Focus policy overrides.' } })
      return
    }
    const policy: FocusPolicy = {
      id: target.type === 'team'
        ? `mock-team-focus-policy-${target.teamId}`
        : 'mock-user-focus-policy',
      overrides,
      schemaVersion: FOCUS_SCHEMA_VERSION,
      target,
      updatedAt: new Date().toISOString(),
      version: requestCounts.focusPolicyUpdates + 3,
    }
    const effectivePolicies = focusQueue.effectivePolicies.map((effectivePolicy) => {
      const applies = target.type === 'user' || effectivePolicy.teamId === target.teamId
      if (!applies) return effectivePolicy
      return {
        ...effectivePolicy,
        settings: applyMockFocusPolicyOverrides(effectivePolicy.settings, overrides),
        ...(target.type === 'team'
          ? {
              teamSettings: applyMockFocusPolicyOverrides(
                effectivePolicy.teamSettings,
                overrides,
              ),
            }
          : {}),
      }
    })
    focusQueue = {
      ...focusQueue,
      effectivePolicies,
      ...(target.type === 'user'
        ? { userPolicy: policy }
        : {
            teamPolicies: [
              ...focusQueue.teamPolicies.filter((candidate) =>
                candidate.target.type !== 'team' || candidate.target.teamId !== target.teamId
              ),
              policy,
            ],
          }),
    }
    await route.fulfill({
      json: {
        effectivePolicies,
        policy,
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

  await page.route(/.*\/api\/teams\/[^/]+\/issues(?:\?.*)?$/, async (route) => {
    const teamId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] ?? '')
    const projects = projectDirectory.find((team) => team.id === teamId)?.projects ?? []

    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    if (route.request().method() === 'POST') {
      requestCounts.issueCreates += 1
      requestCounts.issueCreateIdempotencyKeys.push(
        route.request().headers()['idempotency-key'] ?? '',
      )
      if (remainingCreateIssueFailures > 0) {
        remainingCreateIssueFailures -= 1
        await route.fulfill({
          status: 500,
          json: { message: 'タスク作成に失敗しました。' },
        })
        return
      }
      const body = route.request().postDataJSON() as {
        assignedProjectId?: string
        assigneeUserId?: string
        customFieldValues?: Record<string, CustomFieldValue>
        description?: string
        priority?: TeamIssue['priority']
        schedule?: WorkItemSchedule
        title?: string
        workflowStatusId?: string
      }
      expect(body).not.toHaveProperty('status')
      expect(body).not.toHaveProperty('dueDate')
      expect(body.schedule).toBeDefined()
      if (!body.schedule) {
        await route.fulfill({ status: 400, json: { message: 'A canonical schedule is required.' } })
        return
      }
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
        dueDate: projectMockScheduleDueDate(body.schedule),
        schedule: structuredClone(body.schedule),
        priority: body.priority ?? 'medium',
        createdAt: '2026-06-08T00:00:00.000Z',
        updatedAt: '2026-06-08T00:00:00.000Z',
        source: 'dynamodb',
      } satisfies TeamIssue

      teamIssuesByTeam[teamId] = [...(teamIssuesByTeam[teamId] ?? []), issue]
      committedIssueCreates += 1

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

  await page.route(/.*\/api\/teams\/[^/]+\/issues\/[^/]+\/schedule\/preview$/, async (route) => {
    requestCounts.schedulePreviews += 1
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')
    expect(route.request().method()).toBe('POST')

    const pathSegments = new URL(route.request().url()).pathname.split('/')
    const teamId = decodeURIComponent(pathSegments[3] ?? '')
    const issueId = decodeURIComponent(pathSegments[5] ?? '')
    const issue = findTeamIssue(teamIssuesByTeam, teamId, issueId)
      ?? Object.values(taskResponsesByProject)
        .flat()
        .find((candidate) => candidate.teamId === teamId && candidate.id === issueId)
    const body: PreviewWorkItemScheduleInput = route.request().postDataJSON()

    if (!issue) {
      await route.fulfill({ status: 404, json: { message: 'Issue was not found.' } })
      return
    }
    if (forbiddenSchedulePreviewIssueKeys.has(createIssueCollaborationKey(teamId, issueId))) {
      await route.fulfill({
        status: 403,
        json: {
          code: 'WorkItemScheduleForbidden',
          message: 'Schedule changes require member permission.',
        },
      })
      return
    }
    if (body.expectedRevision !== issue.revision) {
      await route.fulfill({
        status: 409,
        json: {
          code: 'WorkItemRevisionConflict',
          message: 'Work Item changed after it was loaded.',
        },
      })
      return
    }

    const preview = createMockScheduleChangePreview(
      taskResponsesByProject,
      teamIssuesByTeam,
      workItemScheduleDependencies,
      workItemScheduleDependencyConflicts,
      relationGraphRevisionByTeam[teamId] ?? 0,
      planningRevision,
      teamId,
      issueId,
      body.operation,
    )

    await route.fulfill({
      json: preview,
    })
  })

  await page.route(/.*\/api\/teams\/[^/]+\/issues\/[^/]+\/schedule\/confirm$/, async (route) => {
    requestCounts.scheduleConfirms += 1
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')
    expect(route.request().method()).toBe('POST')

    const pathSegments = new URL(route.request().url()).pathname.split('/')
    const teamId = decodeURIComponent(pathSegments[3] ?? '')
    const issueId = decodeURIComponent(pathSegments[5] ?? '')
    const issue = findStoredWorkItem(taskResponsesByProject, teamIssuesByTeam, teamId, issueId)
    const body: ConfirmWorkItemScheduleChangeInput = route.request().postDataJSON()

    if (!issue) {
      await route.fulfill({ status: 404, json: { message: 'Issue was not found.' } })
      return
    }
    if (body.expectedRevision !== issue.revision) {
      await route.fulfill({
        status: 409,
        json: {
          code: 'WorkItemRevisionConflict',
          message: 'Work Item changed after it was loaded.',
        },
      })
      return
    }
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
    if (
      body.expectedPlanningRevision !== planningRevision ||
      body.expectedRelationGraphRevision !== (relationGraphRevisionByTeam[teamId] ?? 0)
    ) {
      await route.fulfill({
        status: 409,
        json: {
          code: 'PlanningRevisionConflict',
          message: 'Planning changed after the preview was loaded.',
        },
      })
      return
    }

    const preview = createMockScheduleChangePreview(
      taskResponsesByProject,
      teamIssuesByTeam,
      workItemScheduleDependencies,
      workItemScheduleDependencyConflicts,
      relationGraphRevisionByTeam[teamId] ?? 0,
      planningRevision,
      teamId,
      issueId,
      body.operation,
    )
    expect(body.confirmed).toBe(true)
    expect(body.expectedEvaluatedRevisions).toEqual(preview.evaluatedRevisions)
    expect(body.expectedImpacts).toEqual(preview.impacts)

    const updatedIssues = preview.impacts.flatMap((impact) => {
      const currentIssue = findStoredWorkItem(
        taskResponsesByProject,
        teamIssuesByTeam,
        impact.teamId,
        impact.workItemId,
      )

      if (!currentIssue) {
        return []
      }
      const updatedIssue = {
        ...currentIssue,
        dueDate: projectMockScheduleDueDate(impact.after),
        revision: currentIssue.revision + 1,
        schedule: structuredClone(impact.after),
        updatedAt: '2026-06-08T02:00:00.000Z',
      } satisfies TeamIssue
      replaceStoredWorkItem(
        taskResponsesByProject,
        teamIssuesByTeam,
        impact.teamId,
        updatedIssue,
      )
      return [updatedIssue]
    })

    await route.fulfill({
      json: {
        workItems: updatedIssues.map((updatedIssue) => ({
          id: updatedIssue.id,
          teamId: updatedIssue.teamId,
          revision: updatedIssue.revision,
          schedule: updatedIssue.schedule,
          dueDate: updatedIssue.dueDate,
          ...(updatedIssue.assignedProjectId
            ? { assignedProjectId: updatedIssue.assignedProjectId }
            : {}),
        })),
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
      expect(body).not.toHaveProperty('dueDate')
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
        dueDate: patch.schedule
          ? projectMockScheduleDueDate(patch.schedule)
          : issue.dueDate,
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

}

/**
 * Reads the encoded Team and Work Item identifiers from a Focus item mutation URL.
 *
 * @param url - Absolute request URL intercepted by Playwright.
 * @returns Decoded identifiers used to locate the mocked Focus item.
 */
function readMockFocusItemRoute(url: string): { teamId: string; workItemId: string } {
  const pathSegments = new URL(url).pathname.split('/')
  return {
    teamId: decodeURIComponent(pathSegments[4] ?? ''),
    workItemId: decodeURIComponent(pathSegments[5] ?? ''),
  }
}

/**
 * Creates the collision-free key used to retain a pre-snooze section.
 *
 * @param teamId - Canonical Team identifier.
 * @param workItemId - Canonical Work Item identifier.
 * @returns Stable compound Focus item key.
 */
function createMockFocusItemKey(teamId: string, workItemId: string): string {
  return `${teamId}\0${workItemId}`
}

/**
 * Narrows an unknown request body to a property-readable object.
 *
 * @param value - Untrusted JSON value supplied by the browser.
 * @returns Whether the value is a non-null object.
 */
function isMockRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads the numeric fields supported by the Focus policy E2E mock.
 *
 * @param value - Untrusted policy override request value.
 * @returns A validated sparse override or undefined for an invalid field.
 */
function readMockFocusPolicyOverrides(value: unknown): FocusPolicyOverrides | undefined {
  if (!isMockRecord(value)) return undefined
  const scalarFields: readonly (keyof FocusPolicyOverrides)[] = [
    'cycleDueSoonDays',
    'dueSoonDays',
    'nowScoreThreshold',
    'slaHours',
  ]
  if (scalarFields.some((field) =>
    value[field] !== undefined && typeof value[field] !== 'number'
  )) {
    return undefined
  }
  if (value.weights !== undefined && !isMockRecord(value.weights)) return undefined
  const weights = isMockRecord(value.weights) ? value.weights : undefined
  const weightFields: readonly string[] = [
    'approval',
    'blocker',
    'cycle',
    'dueSoon',
    'mention',
    'overdue',
    'reviewRequest',
    'sla',
    'urgent',
  ]
  if (weights && weightFields.some((field) =>
    weights[field] !== undefined && typeof weights[field] !== 'number'
  )) {
    return undefined
  }

  return {
    ...(typeof value.cycleDueSoonDays === 'number'
      ? { cycleDueSoonDays: value.cycleDueSoonDays }
      : {}),
    ...(typeof value.dueSoonDays === 'number' ? { dueSoonDays: value.dueSoonDays } : {}),
    ...(typeof value.nowScoreThreshold === 'number'
      ? { nowScoreThreshold: value.nowScoreThreshold }
      : {}),
    ...(typeof value.slaHours === 'number' ? { slaHours: value.slaHours } : {}),
    ...(weights
      ? {
          weights: {
            ...(typeof weights.approval === 'number' ? { approval: weights.approval } : {}),
            ...(typeof weights.blocker === 'number' ? { blocker: weights.blocker } : {}),
            ...(typeof weights.cycle === 'number' ? { cycle: weights.cycle } : {}),
            ...(typeof weights.dueSoon === 'number' ? { dueSoon: weights.dueSoon } : {}),
            ...(typeof weights.mention === 'number' ? { mention: weights.mention } : {}),
            ...(typeof weights.overdue === 'number' ? { overdue: weights.overdue } : {}),
            ...(typeof weights.reviewRequest === 'number'
              ? { reviewRequest: weights.reviewRequest }
              : {}),
            ...(typeof weights.sla === 'number' ? { sla: weights.sla } : {}),
            ...(typeof weights.urgent === 'number' ? { urgent: weights.urgent } : {}),
          },
        }
      : {}),
  }
}

/**
 * Applies one sparse policy layer to complete mocked effective settings.
 *
 * @param settings - Current complete settings.
 * @param overrides - Sparse replacement observed by the mock endpoint.
 * @returns Complete settings reflecting the submitted values.
 */
function applyMockFocusPolicyOverrides(
  settings: FocusPolicySettings,
  overrides: FocusPolicyOverrides,
): FocusPolicySettings {
  return {
    ...settings,
    ...overrides,
    weights: {
      ...settings.weights,
      ...overrides.weights,
    },
  }
}

/**
 * Validates the revision-bound fields used by the mocked Focus snooze endpoint.
 *
 * @param value - Untrusted request JSON.
 * @returns Whether the input contains a version and nullable ISO timestamp string.
 */
function isMockFocusSnoozeInput(value: unknown): value is {
  expectedVersion: number
  snoozedUntil: string | null
} {
  return isMockRecord(value) &&
    typeof value.expectedVersion === 'number' &&
    (typeof value.snoozedUntil === 'string' || value.snoozedUntil === null)
}

/**
 * Validates the revision-bound fields used by the mocked Focus watch endpoint.
 *
 * @param value - Untrusted request JSON.
 * @returns Whether the input contains a version and watch state.
 */
function isMockFocusWatchInput(value: unknown): value is {
  expectedVersion: number
  watching: boolean
} {
  return isMockRecord(value) &&
    typeof value.expectedVersion === 'number' &&
    typeof value.watching === 'boolean'
}

/**
 * Finds one Focus item without changing the server-provided queue order.
 *
 * @param response - Current mocked Focus snapshot.
 * @param teamId - Canonical Team identifier.
 * @param workItemId - Canonical Work Item identifier.
 * @returns Matching Focus item, if it remains visible.
 */
function findMockFocusItem(
  response: FocusQueueResponse,
  teamId: string,
  workItemId: string,
): FocusItem | undefined {
  return response.sections
    .flatMap((group) => group.items)
    .find((item) =>
      item.workItem.teamId === teamId && item.workItem.id === workItemId)
}

/**
 * Replaces a mocked Focus item in place while preserving its section order.
 *
 * @param response - Current mocked Focus snapshot.
 * @param updatedItem - New server item representation.
 * @returns Updated snapshot with the same item order.
 */
function replaceMockFocusItem(
  response: FocusQueueResponse,
  updatedItem: FocusItem,
): FocusQueueResponse {
  return {
    ...response,
    generatedAt: new Date().toISOString(),
    sections: response.sections.map((group) => ({
      ...group,
      items: group.items.map((item) =>
        isSameMockFocusItem(item, updatedItem) ? updatedItem : item),
    })),
  }
}

/**
 * Moves a mocked Focus item to the leading position of its new section.
 *
 * @param response - Current mocked Focus snapshot.
 * @param updatedItem - Item carrying the server-selected destination section.
 * @returns Updated snapshot with no duplicate item entries.
 */
function moveMockFocusItem(
  response: FocusQueueResponse,
  updatedItem: FocusItem,
): FocusQueueResponse {
  if (!response.sections.some((group) => group.section === updatedItem.section)) {
    throw new Error(`Mock Focus response is missing section ${updatedItem.section}.`)
  }
  return {
    ...response,
    generatedAt: new Date().toISOString(),
    sections: response.sections.map((group) => {
      const remainingItems = group.items.filter((item) =>
        !isSameMockFocusItem(item, updatedItem))
      return {
        ...group,
        items: group.section === updatedItem.section
          ? [updatedItem, ...remainingItems]
          : remainingItems,
      }
    }),
  }
}

/**
 * Compares mocked Focus items by their canonical Team and Work Item identity.
 *
 * @param left - Existing queue item.
 * @param right - Candidate replacement item.
 * @returns Whether both values represent the same canonical item.
 */
function isSameMockFocusItem(left: FocusItem, right: FocusItem): boolean {
  return left.workItem.teamId === right.workItem.teamId &&
    left.workItem.id === right.workItem.id
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
 * Opens the Team or Project registration panel from the sidebar's More menu.
 *
 * @param page - Playwright page containing the authenticated Workspace shell.
 * @param mode - Registration form to display.
 * @returns A promise that resolves once the selected name field is visible.
 */
async function openSidebarCreatePanel(
  page: Page,
  mode: 'team' | 'project' = 'team',
) {
  await page.getByRole('button', { name: 'その他', exact: true }).click()
  await page.getByRole('button', { name: '新規登録' }).click()
  await page.getByRole('button', {
    name: mode === 'team' ? 'チーム' : 'プロジェクト',
    exact: true,
  }).click()
  await expect(page.getByLabel(
    mode === 'team' ? 'チーム名' : 'プロジェクト名',
  )).toBeVisible()
}

/** Records a canonical Project Issue list request for the selected project. */
function recordProjectIssueRequest(requestCounts: MockRequestCounts, projectId: string) {
  requestCounts.projectIssues[projectId] = (requestCounts.projectIssues[projectId] ?? 0) + 1
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
    dueDate: '2026-06-22',
    schedule: {
      calendarPolicy: DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY,
      dueDate: '2026-06-22',
      mode: 'due-date',
    },
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
 * Finds one canonical Work Item across project and unassigned Team stores.
 *
 * @param taskResponsesByProject - Project-scoped canonical Work Item stores.
 * @param teamIssuesByTeam - Team-scoped canonical Work Item stores.
 * @param teamId - Owning Team identifier.
 * @param issueId - Team-local Work Item identifier.
 * @returns Matching canonical Work Item when the mock contains one.
 */
function findStoredWorkItem(
  taskResponsesByProject: Record<string, CanonicalWorkItem[]>,
  teamIssuesByTeam: Record<string, TeamIssue[]>,
  teamId: string,
  issueId: string,
): TeamIssue | CanonicalWorkItem | undefined {
  return findTeamIssue(teamIssuesByTeam, teamId, issueId)
    ?? Object.values(taskResponsesByProject)
      .flat()
      .find((candidate) => candidate.teamId === teamId && candidate.id === issueId)
}

/**
 * Lists each canonical Work Item once across the E2E mock's backing stores.
 *
 * @param taskResponsesByProject - Project-scoped canonical Work Item stores.
 * @param teamIssuesByTeam - Team-scoped canonical Work Item stores.
 * @returns Stable insertion-ordered canonical Work Items keyed by Team and ID.
 */
function listStoredWorkItems(
  taskResponsesByProject: Record<string, CanonicalWorkItem[]>,
  teamIssuesByTeam: Record<string, TeamIssue[]>,
): Array<TeamIssue | CanonicalWorkItem> {
  const workItemsByKey = new Map<string, TeamIssue | CanonicalWorkItem>()

  for (const workItem of [
    ...Object.values(taskResponsesByProject).flat(),
    ...Object.values(teamIssuesByTeam).flat(),
  ]) {
    workItemsByKey.set(createIssueCollaborationKey(workItem.teamId, workItem.id), workItem)
  }
  return [...workItemsByKey.values()]
}

/**
 * Creates the exact Planning snapshot consumed by task and Team Issue dependency surfaces.
 *
 * @param taskResponsesByProject - Project-scoped canonical Work Item stores.
 * @param teamIssuesByTeam - Team-scoped canonical Work Item stores.
 * @param dependencies - Canonical dependency graph configured for the test.
 * @param conflicts - Authoritative dependency conflicts configured for the test.
 * @param revision - Planning graph revision exposed to preview/confirm calls.
 * @returns Contract-valid Planning snapshot projected from current mock state.
 */
function createMockPlanningSnapshot(
  taskResponsesByProject: Record<string, CanonicalWorkItem[]>,
  teamIssuesByTeam: Record<string, TeamIssue[]>,
  dependencies: readonly WorkItemScheduleDependency[],
  conflicts: readonly WorkItemScheduleDependencyConflict[],
  revision: number,
): PlanningSnapshot {
  const storedWorkItems = listStoredWorkItems(taskResponsesByProject, teamIssuesByTeam)
  const workItemByKey = new Map(storedWorkItems.map((workItem) => [
    createIssueCollaborationKey(workItem.teamId, workItem.id),
    workItem,
  ]))
  const criticalWorkItems = dependencies.flatMap((dependency) => [
    dependency.predecessor,
    dependency.successor,
  ]).filter((endpoint, index, endpoints) =>
    endpoints.findIndex((candidate) =>
      candidate.teamId === endpoint.teamId && candidate.workItemId === endpoint.workItemId
    ) === index
  )
  const affectedProjects = criticalWorkItems.flatMap((endpoint) => {
    const workItem = workItemByKey.get(
      createIssueCollaborationKey(endpoint.teamId, endpoint.workItemId),
    )
    return workItem?.assignedProjectId
      ? [{ projectId: workItem.assignedProjectId, teamId: workItem.teamId }]
      : []
  }).filter((project, index, projects) => projects.findIndex((candidate) =>
    candidate.teamId === project.teamId && candidate.projectId === project.projectId
  ) === index)

  return {
    schemaVersion: PLANNING_SCHEMA_VERSION,
    revision,
    entities: [],
    dependencies: [],
    workItemDependencies: structuredClone([...dependencies]),
    workItemLinks: [],
    workItems: storedWorkItems.map((workItem) => ({
      dueDate: workItem.dueDate,
      id: workItem.id,
      projectId: workItem.assignedProjectId,
      revision: workItem.revision,
      schedule: structuredClone(workItem.schedule),
      statusCategory: workItem.statusCategory,
      teamId: workItem.teamId,
      title: workItem.title,
    })),
    updateTargets: [],
    criticalPath: {
      entityIds: [],
      slackByEntityId: {},
      totalDurationDays: 0,
    },
    workItemDependencySummary: {
      affectedMilestoneIds: [],
      affectedProjects,
      conflicts: structuredClone([...conflicts]),
      criticalPath: {
        slackByWorkItemKey: Object.fromEntries(criticalWorkItems.map((endpoint) => [
          `${endpoint.teamId}/${endpoint.workItemId}`,
          0,
        ])),
        totalDurationDays: 0,
        workItems: structuredClone(criticalWorkItems),
      },
      unresolvedBlockerCount: dependencies.filter((dependency) => {
        const predecessor = workItemByKey.get(createIssueCollaborationKey(
          dependency.predecessor.teamId,
          dependency.predecessor.workItemId,
        ))
        return predecessor?.statusCategory !== 'completed'
      }).length,
    },
    updatedAt: '2026-07-12T12:00:00.000Z',
  }
}

/**
 * Creates one revision-bound direct plus dependency-cascade schedule preview.
 *
 * @param taskResponsesByProject - Project-scoped canonical Work Item stores.
 * @param teamIssuesByTeam - Team-scoped canonical Work Item stores.
 * @param dependencies - Canonical dependency graph used for propagation.
 * @param conflicts - Authoritative conflicts that block confirmation.
 * @param relationGraphRevision - Team relation graph revision observed by the preview.
 * @param planningRevision - Planning graph revision observed by the preview.
 * @param teamId - Team that owns the direct Work Item.
 * @param issueId - Direct Work Item identifier.
 * @param operation - Schedule operation being previewed.
 * @returns Contract-valid preview used by both preview and confirm E2E routes.
 */
function createMockScheduleChangePreview(
  taskResponsesByProject: Record<string, CanonicalWorkItem[]>,
  teamIssuesByTeam: Record<string, TeamIssue[]>,
  dependencies: readonly WorkItemScheduleDependency[],
  conflicts: readonly WorkItemScheduleDependencyConflict[],
  relationGraphRevision: number,
  planningRevision: number,
  teamId: string,
  issueId: string,
  operation: WorkItemScheduleOperation,
): WorkItemScheduleChangePreview {
  const directWorkItem = findStoredWorkItem(
    taskResponsesByProject,
    teamIssuesByTeam,
    teamId,
    issueId,
  )
  if (!directWorkItem) {
    throw new Error(`Missing mocked Work Item: ${teamId}/${issueId}`)
  }

  const directAfter = applyMockWorkItemScheduleOperation(directWorkItem.schedule, operation)
  const impacts: WorkItemScheduleImpact[] = [{
    after: directAfter,
    before: structuredClone(directWorkItem.schedule),
    dateDeltaDays: calculateMockScheduleDelta(directWorkItem.schedule, directAfter),
    expectedRevision: directWorkItem.revision,
    kind: 'direct',
    teamId,
    workItemId: issueId,
  }]
  const pendingImpacts = [...impacts]
  const impactedKeys = new Set([createIssueCollaborationKey(teamId, issueId)])

  while (pendingImpacts.length > 0) {
    const predecessorImpact = pendingImpacts.shift()
    if (!predecessorImpact) {
      continue
    }
    const outgoingDependencies = dependencies.filter((dependency) =>
      dependency.predecessor.teamId === predecessorImpact.teamId &&
      dependency.predecessor.workItemId === predecessorImpact.workItemId
    )

    for (const dependency of outgoingDependencies) {
      const successorKey = createIssueCollaborationKey(
        dependency.successor.teamId,
        dependency.successor.workItemId,
      )
      if (impactedKeys.has(successorKey)) {
        continue
      }
      const successor = findStoredWorkItem(
        taskResponsesByProject,
        teamIssuesByTeam,
        dependency.successor.teamId,
        dependency.successor.workItemId,
      )
      if (!successor) {
        continue
      }
      const successorAfter = applyMockDependencyCascade(
        predecessorImpact.after,
        successor.schedule,
        dependency,
      )
      if (!successorAfter || schedulesAreEqual(successor.schedule, successorAfter)) {
        continue
      }
      const successorImpact = {
        after: successorAfter,
        before: structuredClone(successor.schedule),
        dateDeltaDays: calculateMockScheduleDelta(successor.schedule, successorAfter),
        dependencyId: dependency.id,
        expectedRevision: successor.revision,
        kind: 'dependency' as const,
        teamId: successor.teamId,
        workItemId: successor.id,
      }
      impacts.push(successorImpact)
      pendingImpacts.push(successorImpact)
      impactedKeys.add(successorKey)
    }
  }

  const affectedProjects = impacts.flatMap((impact) => {
    const workItem = findStoredWorkItem(
      taskResponsesByProject,
      teamIssuesByTeam,
      impact.teamId,
      impact.workItemId,
    )
    return workItem?.assignedProjectId
      ? [{ projectId: workItem.assignedProjectId, teamId: impact.teamId }]
      : []
  }).filter((project, index, projects) => projects.findIndex((candidate) =>
    candidate.projectId === project.projectId && candidate.teamId === project.teamId
  ) === index)
  return {
    affectedMilestoneIds: [],
    affectedProjects,
    conflicts: structuredClone([...conflicts]),
    evaluatedRevisions: impacts.map((impact) => ({
      expectedRevision: impact.expectedRevision,
      teamId: impact.teamId,
      workItemId: impact.workItemId,
    })),
    expectedRevision: directWorkItem.revision,
    impacts,
    planningRevision,
    relationGraphRevision,
    requiresConfirmation: true,
    warnings: [],
  }
}

/**
 * Applies one dependency anchor rule to a successor schedule for deterministic E2E propagation.
 *
 * @param predecessorSchedule - Proposed predecessor schedule.
 * @param successorSchedule - Current successor schedule.
 * @param dependency - Dependency whose type and lead/lag select the anchors.
 * @returns Shifted successor schedule, or no value when either anchor is unscheduled.
 */
function applyMockDependencyCascade(
  predecessorSchedule: WorkItemSchedule,
  successorSchedule: WorkItemSchedule,
  dependency: WorkItemScheduleDependency,
): WorkItemSchedule | undefined {
  const predecessorAnchor = dependency.type === 'start-to-start' ||
      dependency.type === 'start-to-finish'
    ? 'start'
    : 'finish'
  const successorAnchor = dependency.type === 'finish-to-finish' ||
      dependency.type === 'start-to-finish'
    ? 'finish'
    : 'start'
  const predecessorDate = resolveMockScheduleAnchor(predecessorSchedule, predecessorAnchor)
  const successorDate = resolveMockScheduleAnchor(successorSchedule, successorAnchor)

  if (!predecessorDate || !successorDate) {
    return undefined
  }
  const dependencyDate = addMockScheduleDays(predecessorDate, dependency.lagDays)
  const targetDate = applyMockScheduleConstraint(
    dependencyDate,
    dependency.constraint?.anchor === successorAnchor ? dependency.constraint : undefined,
  )
  const offsetDays = differenceMockScheduleDays(successorDate, targetDate)

  switch (successorSchedule.mode) {
    case 'unscheduled':
      return undefined
    case 'due-date':
      return { ...structuredClone(successorSchedule), dueDate: targetDate }
    case 'milestone':
      return {
        ...structuredClone(successorSchedule),
        endDate: targetDate,
        startDate: targetDate,
      }
    case 'date-range':
      return {
        ...structuredClone(successorSchedule),
        endDate: addMockScheduleDays(successorSchedule.endDate, offsetDays),
        startDate: addMockScheduleDays(successorSchedule.startDate, offsetDays),
      }
  }
}

/**
 * Applies a matching explicit constraint to one dependency-derived date.
 *
 * @param dependencyDate - Date selected by dependency anchors and lead/lag.
 * @param constraint - Optional constraint for the same successor anchor.
 * @returns Date after enforcing the constraint kind.
 */
function applyMockScheduleConstraint(
  dependencyDate: string,
  constraint: WorkItemScheduleDependency['constraint'],
): string {
  if (!constraint || constraint.kind === 'on') {
    return constraint?.date ?? dependencyDate
  }
  if (constraint.kind === 'not-before') {
    return dependencyDate.localeCompare(constraint.date) < 0 ? constraint.date : dependencyDate
  }
  return dependencyDate.localeCompare(constraint.date) > 0 ? constraint.date : dependencyDate
}

/**
 * Resolves a scheduled Work Item's start or finish anchor.
 *
 * @param schedule - Canonical schedule to inspect.
 * @param anchor - Boundary required by a dependency type.
 * @returns ISO date-only boundary, or no value for an unscheduled Work Item.
 */
function resolveMockScheduleAnchor(
  schedule: WorkItemSchedule,
  anchor: 'start' | 'finish',
): string | undefined {
  switch (schedule.mode) {
    case 'unscheduled':
      return undefined
    case 'due-date':
      return schedule.dueDate
    case 'milestone':
      return schedule.startDate
    case 'date-range':
      return anchor === 'start' ? schedule.startDate : schedule.endDate
  }
}

/**
 * Calculates primary-date movement between two schedules for preview metadata.
 *
 * @param before - Schedule before the operation.
 * @param after - Schedule after the operation.
 * @returns Signed calendar-day delta, or zero when either schedule is unscheduled.
 */
function calculateMockScheduleDelta(
  before: WorkItemSchedule,
  after: WorkItemSchedule,
): number {
  const beforeDate = resolveMockScheduleAnchor(before, 'finish')
  const afterDate = resolveMockScheduleAnchor(after, 'finish')
  return beforeDate && afterDate ? differenceMockScheduleDays(beforeDate, afterDate) : 0
}

/**
 * Compares two detached schedule values in deterministic mock code.
 *
 * @param left - First canonical schedule.
 * @param right - Second canonical schedule.
 * @returns True when both serialized schedules are structurally equal.
 */
function schedulesAreEqual(left: WorkItemSchedule, right: WorkItemSchedule): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
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
 * Applies one schedule operation in the browser API mock.
 *
 * The production calendar rules are covered by server domain tests; this mock only preserves the
 * operation semantics needed to verify that browser interactions preview and persist canonical data.
 *
 * @param schedule - Current canonical schedule held by the mock API.
 * @param operation - Preview operation posted by the browser.
 * @returns The deterministic schedule returned by the mock preview endpoint.
 */
function applyMockWorkItemScheduleOperation(
  schedule: WorkItemSchedule,
  operation: WorkItemScheduleOperation,
): WorkItemSchedule {
  if (operation.type === 'replace') {
    return structuredClone(operation.schedule)
  }
  if (operation.type === 'resize') {
    if (schedule.mode !== 'date-range') {
      return structuredClone(schedule)
    }
    return {
      ...structuredClone(schedule),
      durationDays: Math.max(
        1,
        differenceMockScheduleDays(schedule.startDate, operation.endDate) + 1,
      ),
      endDate: operation.endDate,
    }
  }

  switch (schedule.mode) {
    case 'unscheduled':
      return structuredClone(schedule)
    case 'due-date':
      return { ...structuredClone(schedule), dueDate: operation.targetDate }
    case 'milestone':
      return {
        ...structuredClone(schedule),
        endDate: operation.targetDate,
        startDate: operation.targetDate,
      }
    case 'date-range': {
      const offsetDays = differenceMockScheduleDays(schedule.startDate, operation.targetDate)
      return {
        ...structuredClone(schedule),
        endDate: addMockScheduleDays(schedule.endDate, offsetDays),
        startDate: operation.targetDate,
      }
    }
  }
}

/**
 * Adds UTC calendar days for deterministic browser mock responses.
 *
 * @param date - ISO date-only value.
 * @param days - Signed calendar-day offset.
 * @returns Shifted ISO date-only value.
 */
function addMockScheduleDays(date: string, days: number): string {
  const instant = new Date(`${date}T00:00:00.000Z`)
  instant.setUTCDate(instant.getUTCDate() + days)
  return instant.toISOString().slice(0, 10)
}

/**
 * Calculates a signed UTC calendar-day difference for the browser mock.
 *
 * @param startDate - Start ISO date-only value.
 * @param endDate - End ISO date-only value.
 * @returns Signed number of calendar days from start to end.
 */
function differenceMockScheduleDays(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00.000Z`).getTime()
  const end = new Date(`${endDate}T00:00:00.000Z`).getTime()
  return Math.round((end - start) / 86_400_000)
}

/**
 * Projects a canonical schedule into the derived deadline stored by the browser mock.
 *
 * @param schedule - Canonical schedule persisted by the mocked Work Item API.
 * @returns Its final scheduled date, or an empty value for explicitly unscheduled work.
 */
function projectMockScheduleDueDate(schedule: WorkItemSchedule): string {
  switch (schedule.mode) {
    case 'unscheduled':
      return ''
    case 'due-date':
      return schedule.dueDate
    case 'date-range':
    case 'milestone':
      return schedule.endDate
  }
}

/**
 * Dispatches a native schedule-card drag with one render frame between drag start and drop.
 *
 * React must commit the dragged task identity before the destination handles the drop event. This
 * mirrors a real pointer drag while keeping the E2E independent from layout-sensitive mouse paths.
 *
 * @param page - Playwright page owning the native `DataTransfer` object.
 * @param source - Draggable Calendar task card.
 * @param target - Calendar date or unscheduled bucket receiving the card.
 */
async function dragScheduleCard(page: Page, source: Locator, target: Locator): Promise<void> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer())

  try {
    await source.dispatchEvent('dragstart', { dataTransfer })
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    }))
    await target.dispatchEvent('dragover', { dataTransfer })
    await target.dispatchEvent('drop', { dataTransfer })
    await source.dispatchEvent('dragend', { dataTransfer })
  } finally {
    await dataTransfer.dispose()
  }
}

const ganttDropBottomOffset = 12

/**
 * Uses Playwright's real pointer drag sequence to drop a Gantt control on one visible date.
 *
 * @param page - Browser page containing the Gantt timeline.
 * @param source - Draggable bar or resize handle.
 * @param timeline - Complete row timeline receiving the bubbled native drop.
 * @param date - Exact daily column on which the pointer is released.
 */
async function dragGanttControlToDate(
  page: Page,
  source: Locator,
  timeline: Locator,
  date: string,
): Promise<void> {
  const column = page.getByRole('columnheader', { exact: true, name: date })
  await source.scrollIntoViewIfNeeded()
  const [columnBounds, sourceBounds, timelineBounds] = await Promise.all([
    column.boundingBox(),
    source.boundingBox(),
    timeline.boundingBox(),
  ])

  if (!columnBounds || !sourceBounds || !timelineBounds) {
    throw new Error(`Gantt drag target is not visible: ${date}`)
  }

  const sourceX = sourceBounds.x + sourceBounds.width / 2
  const sourceY = sourceBounds.y + sourceBounds.height / 2
  const targetX = columnBounds.x + columnBounds.width / 2
  const targetY = timelineBounds.y + timelineBounds.height - ganttDropBottomOffset
  const sourceReceivesPointer = await source.evaluate((element, point) => {
    const hitTarget = document.elementFromPoint(point.x, point.y)
    return element === hitTarget || (hitTarget !== null && element.contains(hitTarget))
  }, { x: sourceX, y: sourceY })
  if (!sourceReceivesPointer) {
    throw new Error(`Gantt drag source is covered: ${date}`)
  }

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer())

  try {
    await source.dispatchEvent('dragstart', {
      clientX: sourceX,
      clientY: sourceY,
      dataTransfer,
    })
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    }))
    await timeline.dispatchEvent('dragover', {
      clientX: targetX,
      clientY: targetY,
      dataTransfer,
    })
    await timeline.dispatchEvent('drop', {
      clientX: targetX,
      clientY: targetY,
      dataTransfer,
    })
    await source.dispatchEvent('dragend', {
      clientX: targetX,
      clientY: targetY,
      dataTransfer,
    })
  } finally {
    await dataTransfer.dispose()
  }
}

/**
 * Verifies one persisted date-range schedule across every task planning surface.
 *
 * @param page - Playwright page showing the Refero task workspace.
 * @param startDate - Expected inclusive schedule start.
 * @param endDate - Expected inclusive schedule end.
 */
async function expectWireframeScheduleAcrossTaskViews(
  page: Page,
  startDate: string,
  endDate: string,
): Promise<void> {
  const dateRangeText = `${startDate} – ${endDate}`
  const scheduleText = `期間: ${dateRangeText}`

  await page.getByRole('tab', { name: 'テーブル', exact: true }).click()
  await expect(page.getByTestId('task-row-wireframe')).toContainText(scheduleText)

  await page.getByTestId('task-open-detail-wireframe').click()
  const detailPane = page.getByTestId('task-detail-pane')

  await expect(detailPane.locator('select[name="scheduleMode"]')).toHaveValue('date-range')
  await expect(detailPane.locator('input[name="scheduleStartDate"]')).toHaveValue(startDate)
  await expect(detailPane.locator('input[name="scheduleEndDate"]')).toHaveValue(endDate)
  await detailPane.getByTestId('task-detail-close').click()

  await page.getByRole('tab', { name: 'ボード', exact: true }).click()
  await expect(page.getByTestId('project-task-card-wireframe')).toContainText(scheduleText)

  await page.getByRole('tab', { name: '期限順', exact: true }).click()
  const ganttBar = page.getByTestId('task-gantt-bar-wireframe')
  const ganttRow = page.locator('article').filter({ has: ganttBar })

  await expect(ganttRow.locator('select[id^="gantt-mode-"]')).toHaveValue('date-range')
  await expect(ganttRow.locator('input[id^="gantt-start-"]')).toHaveValue(startDate)
  await expect(ganttRow.locator('input[id^="gantt-end-"]')).toHaveValue(endDate)

  await page.getByRole('tab', { name: '期限カレンダー', exact: true }).click()
  const calendarCard = page.getByTestId('task-calendar-item-wireframe')

  await expect(calendarCard).toContainText('期間')
  await expect(calendarCard).toContainText(dateRangeText)
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
  taskResponsesByProject: Record<string, CanonicalWorkItem[]>,
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

  test('Issue #194: Focus は server 順・理由・keyboard・snooze・Inbox 相関を一続きで扱う', async ({ page }) => {
    const focusQueue = structuredClone(focusQueueResponseFixture)
    const mentionSignal = focusQueue.sections
      .flatMap((group) => group.items)
      .find((item) => item.workItem.id === 'WI-202')
      ?.signals.find((signal) => signal.source.eventId === 'event-WI-202-mention')
    if (!mentionSignal) throw new Error('The Focus fixture requires the WI-202 mention signal.')
    mentionSignal.source.deepLink = '/inbox?eventId=event-WI-202-mention'

    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      focusQueue,
      notifications: [{
        eventId: 'event-WI-202-mention',
        eventType: 'comment.mentioned',
        id: 'notification-focus-wi-202',
        issueId: 'WI-202',
        occurredAt: '2026-08-09T04:21:00.000Z',
        projectId: 'refero',
        reasons: ['mention'],
        state: 'unread',
        summary: 'Enterprise rollout question needs a response.',
        teamId: 'core-team',
        title: 'Answer the enterprise rollout question',
      }],
    })
    const requestCounts = getMockRequestCounts(page)

    await page.goto('/dashboard')
    const sidebar = page.locator('aside[aria-label="メインサイドバー"]:visible')
    await sidebar.getByRole('button', { name: 'フォーカス', exact: true }).click()
    await expect(page).toHaveURL('/focus')

    const queuePanel = page.getByRole('tabpanel', { name: /いま/ })
    const orderedRows = queuePanel.locator('[data-testid^="focus-item-"]')
    const blockedItem = page.getByTestId('focus-item-core-team-WI-194')
    const mentionItem = page.getByTestId('focus-item-core-team-WI-202')

    await expect(orderedRows.nth(0)).toHaveAttribute(
      'data-testid',
      'focus-item-core-team-WI-194',
    )
    await expect(orderedRows.nth(1)).toHaveAttribute(
      'data-testid',
      'focus-item-core-team-WI-202',
    )
    await expect(blockedItem).toContainText('ブロッカー')
    await expect(blockedItem).toContainText('期限超過')
    await expect(blockedItem).toContainText('レビュー依頼')
    await expect(blockedItem).toContainText('先行 Work Item を完了する')

    await blockedItem.getByRole('button', { name: 'スヌーズ', exact: true }).click()
    await blockedItem.getByLabel('再表示する時刻').selectOption('next-week')
    await blockedItem.getByRole('button', { name: '確定', exact: true }).click()
    await expect.poll(() => requestCounts.focusSnoozeUpdates).toBe(1)
    await expect(blockedItem).toHaveCount(0)

    const snoozeFeedback = page.getByRole('status').filter({ hasText: 'スヌーズしました' })
    await expect(snoozeFeedback).toBeVisible()
    await page.getByRole('tab', { name: /スヌーズ中/ }).click()
    await expect(blockedItem).toBeVisible()
    await snoozeFeedback.getByRole('button', { name: '元に戻す', exact: true }).click()
    await expect.poll(() => requestCounts.focusSnoozeUpdates).toBe(2)
    await expect(blockedItem).toHaveCount(0)

    await page.getByRole('tab', { name: /いま/ }).click()
    const blockedPrimary = blockedItem.locator('[data-focus-queue-primary]')
    const mentionPrimary = mentionItem.locator('[data-focus-queue-primary]')
    await blockedPrimary.focus()
    await page.keyboard.press('j')
    await expect(mentionPrimary).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(
      '/projects/refero/issues?teamId=core-team&issueId=WI-202',
    )

    await page.goto('/inbox')
    await expect(page.getByTestId('inbox-task-list')).toHaveCount(0)
    await expect(page.locator('[data-testid^="focus-item-"]')).toHaveCount(0)
    await page.getByTestId('notification-focus-notification-focus-wi-202').click()
    await expect(page).toHaveURL(
      '/focus?teamId=core-team&workItemId=WI-202&sourceEventId=event-WI-202-mention',
    )
    await expect(mentionPrimary).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(() => requestCounts.focusReads).toBeGreaterThanOrEqual(3)
    await blockedPrimary.click()
    await expect(blockedPrimary).toHaveAttribute('aria-expanded', 'true')
    await expect(mentionPrimary).toHaveAttribute('aria-expanded', 'false')
    await mentionPrimary.click()
    await expect(mentionPrimary).toHaveAttribute('aria-expanded', 'true')

    await mentionItem.getByRole('button', { name: '根拠を開く', exact: true }).click()
    await expect(page).toHaveURL('/inbox?eventId=event-WI-202-mention')
    const selectedNotification = page.getByTestId(
      'notification-row-notification-focus-wi-202',
    )
    await expect(selectedNotification).toHaveAttribute('aria-current', 'true')
    await expect(selectedNotification).toBeFocused()
  })

  test('Issue #194: archived mention の根拠は該当 Inbox page まで取得して focus する', async ({ page }) => {
    const focusQueue = structuredClone(focusQueueResponseFixture)
    const nowGroup = focusQueue.sections.find((group) => group.section === 'now')
    const mentionItem = nowGroup?.items.find((item) => item.workItem.id === 'WI-202')
    const mentionSignal = mentionItem?.signals.find((signal) =>
      signal.source.eventId === 'event-WI-202-mention'
    )
    if (!nowGroup || !mentionItem || !mentionSignal) {
      throw new Error('The Focus fixture requires the WI-202 mention signal.')
    }
    nowGroup.items = [mentionItem]
    mentionSignal.source.deepLink =
      '/inbox?eventId=event-WI-202-mention&filter=archived'
    const archivedNotifications: InboxNotification[] = [
      ...Array.from({ length: 30 }, (_, index) => ({
        eventId: `archived-filler-event-${index}`,
        eventType: 'comment.mentioned',
        id: `archived-filler-${index}`,
        occurredAt: `2026-08-08T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
        reasons: ['mention'],
        state: 'archived' as const,
      })),
      {
        eventId: 'event-WI-202-mention',
        eventType: 'comment.mentioned',
        id: 'notification-focus-wi-202-archived',
        issueId: 'WI-202',
        occurredAt: '2026-08-07T04:21:00.000Z',
        reasons: ['mention'],
        state: 'archived',
        teamId: 'core-team',
        title: 'Answer the enterprise rollout question',
      },
    ]

    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      focusQueue,
      notifications: archivedNotifications,
    })
    const requestCounts = getMockRequestCounts(page)
    await page.goto('/focus')

    await page.getByTestId('focus-item-core-team-WI-202')
      .getByRole('button', { name: '根拠を開く', exact: true })
      .click()
    await expect(page).toHaveURL(
      '/inbox?eventId=event-WI-202-mention&filter=archived',
    )
    const selectedNotification = page.getByTestId(
      'notification-row-notification-focus-wi-202-archived',
    )
    await expect(selectedNotification).toHaveAttribute('aria-current', 'true')
    await expect(selectedNotification).toBeFocused()
    await expect.poll(() => requestCounts.notificationReads).toBeGreaterThanOrEqual(2)
  })

  test('Issue #194: 解決済みまたは閲覧不可の deep link は不在理由を表示する', async ({ page }) => {
    await mockAuthenticatedTaskPage(page)
    await page.goto(
      '/focus?teamId=core-team&workItemId=missing-item&sourceEventId=missing-event',
    )

    await expect(page.getByTestId('focus-deep-link-unavailable')).toContainText(
      'リンク先の Work Item はフォーカスにないか、現在の権限では表示できません。',
    )
  })

  test('Issue #194: Focus の inline 操作を閉じると trigger に戻り、最後の行を移すと active tab に戻る', async ({ page }) => {
    const focusQueue = structuredClone(focusQueueResponseFixture)
    const nowGroup = focusQueue.sections.find((group) => group.section === 'now')
    if (!nowGroup?.items[0]) throw new Error('The Focus fixture requires one Now item.')
    nowGroup.items = [nowGroup.items[0]]

    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, { focusQueue })
    const requestCounts = getMockRequestCounts(page)
    await page.goto('/focus')

    const activeTab = page.getByRole('tab', { name: /いま/ })
    const onlyItem = page.getByTestId('focus-item-core-team-WI-194')
    const scheduleTrigger = onlyItem.getByRole('button', {
      name: '期限を設定',
      exact: true,
    })
    const snoozeTrigger = onlyItem.getByRole('button', {
      name: 'スヌーズ',
      exact: true,
    })

    await scheduleTrigger.click()
    await onlyItem.getByLabel('新しい期限').press('Escape')
    await expect(scheduleTrigger).toBeFocused()
    await scheduleTrigger.click()
    await onlyItem.getByRole('button', { name: 'キャンセル', exact: true }).click()
    await expect(scheduleTrigger).toBeFocused()

    await snoozeTrigger.click()
    await onlyItem.getByLabel('再表示する時刻').press('Escape')
    await expect(snoozeTrigger).toBeFocused()
    await snoozeTrigger.click()
    await onlyItem.getByRole('button', { name: 'キャンセル', exact: true }).click()
    await expect(snoozeTrigger).toBeFocused()

    await snoozeTrigger.click()
    await onlyItem.getByRole('button', { name: '確定', exact: true }).click()
    await expect.poll(() => requestCounts.focusSnoozeUpdates).toBe(1)
    await expect(onlyItem).toHaveCount(0)
    await expect(activeTab).toBeFocused()
  })

  test('Issue #194: Focus の schedule preview 失敗は editor 内に理由を表示する', async ({ page }) => {
    await mockAuthenticatedTaskPage(page)
    await page.route(
      /.*\/api\/teams\/[^/]+\/issues\/[^/]+\/schedule\/preview$/,
      async (route) => {
        await route.fulfill({
          status: 503,
          json: { code: 'SchedulePreviewUnavailable', message: 'Preview failed.' },
        })
      },
    )
    await page.goto('/focus')

    const item = page.getByTestId('focus-item-core-team-WI-194')
    await item.getByRole('button', { name: '期限を設定', exact: true }).click()
    await item.getByLabel('新しい期限').fill('2026-08-20')
    await item.getByRole('button', { name: '影響を確認', exact: true }).click()

    await expect(item.getByRole('alert')).toContainText(
      '操作を完了できませんでした。もう一度お試しください。',
    )
    await expect(item.getByLabel('新しい期限')).toBeVisible()
  })

  test('Issue #194: snooze の Undo 失敗後も feedback を復元して再試行できる', async ({ page }) => {
    const focusQueue = structuredClone(focusQueueResponseFixture)
    const nowGroup = focusQueue.sections.find((group) => group.section === 'now')
    if (!nowGroup?.items[0]) throw new Error('The Focus fixture requires one Now item.')
    nowGroup.items = [nowGroup.items[0]]
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      failedFocusSnoozeRequestNumbers: [2],
      focusQueue,
    })
    const requestCounts = getMockRequestCounts(page)
    await page.goto('/focus')

    const item = page.getByTestId('focus-item-core-team-WI-194')
    await item.getByRole('button', { name: 'スヌーズ', exact: true }).click()
    await item.getByRole('button', { name: '確定', exact: true }).click()
    await expect.poll(() => requestCounts.focusSnoozeUpdates).toBe(1)
    const undo = page.getByRole('button', { name: '元に戻す', exact: true })
    await undo.click()
    await expect.poll(() => requestCounts.focusSnoozeUpdates).toBe(2)

    await expect(undo).toBeVisible()
    await expect(page.getByRole('alert').filter({
      hasText: '操作を完了できませんでした。',
    })).toBeVisible()
  })

  test('Issue #194: Focus policy selector は個人と Team の sparse override を正しい target へ送る', async ({ page }) => {
    const focusQueue = structuredClone(focusQueueResponseFixture)
    delete focusQueue.userPolicy
    focusQueue.teamPolicies = []
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, { focusQueue })
    const requestCounts = getMockRequestCounts(page)
    await page.goto('/focus')

    const policyPanel = page.locator('details').filter({
      hasText: 'フォーカスの優先ルール',
    })
    await policyPanel.locator('summary').click()
    await policyPanel.locator('input[name="weight-urgent"]').fill('42')
    await policyPanel.locator('input[name="dueSoonDays"]').fill('366')
    await policyPanel.getByRole('button', { name: 'ルールを保存', exact: true }).click()
    await expect(policyPanel.getByText('許可された範囲の値を入力してください。')).toBeVisible()
    expect(requestCounts.focusPolicyUpdates).toBe(0)
    await expect(policyPanel.locator('input[name="weight-urgent"]')).toHaveValue('42')
    await policyPanel.locator('input[name="dueSoonDays"]').fill('')
    await policyPanel.getByRole('button', { name: 'ルールを保存', exact: true }).click()
    await expect.poll(() => requestCounts.focusPolicyUpdates).toBe(1)

    await policyPanel.getByLabel('ルールの範囲').selectOption('team')
    await policyPanel.locator('input[name="dueSoonDays"]').fill('5')
    await policyPanel.getByRole('button', { name: 'ルールを保存', exact: true }).click()
    await expect.poll(() => requestCounts.focusPolicyUpdates).toBe(2)
    expect(requestCounts.focusPolicyInputs).toEqual([
      {
        expectedVersion: 0,
        overrides: { weights: { urgent: 42 } },
        target: { type: 'user' },
      },
      {
        expectedVersion: 0,
        overrides: { dueSoonDays: 5 },
        target: { teamId: 'core-team', type: 'team' },
      },
    ])
  })

  test('Issue #194: Done の Focus 行は状態 selector から再オープンできる', async ({ page }) => {
    const completedTask = referoTaskFixtures.find((task) => task.id === 'competitor-report')
    const focusQueue = structuredClone(focusQueueResponseFixture)
    const doneGroup = focusQueue.sections.find((group) => group.section === 'done')
    const doneTemplate = doneGroup?.items[0]
    if (!completedTask || !doneGroup || !doneTemplate) {
      throw new Error('The task and Focus fixtures require one completed Work Item.')
    }
    doneGroup.items = [{
      ...doneTemplate,
      id: 'focus-competitor-report',
      rank: {
        ...doneTemplate.rank,
        tieBreaker: 'core-team\0competitor-report',
      },
      workItem: structuredClone(completedTask),
    }]
    let reopenedWorkItemId = ''
    let reopenedStatusId = ''

    await mockAuthenticatedTaskPage(
      page,
      referoTaskFixtures,
      (workItemId, workflowStatusId) => {
        reopenedWorkItemId = workItemId
        reopenedStatusId = workflowStatusId
      },
      { focusQueue },
    )
    const requestCounts = getMockRequestCounts(page)
    await page.goto('/focus?section=done')

    const doneItem = page.getByTestId('focus-item-core-team-competitor-report')
    const statusSelector = doneItem.getByLabel('状態を変更')
    await expect(statusSelector).toHaveValue('done')
    await statusSelector.selectOption('in-progress')

    await expect.poll(() => reopenedWorkItemId).toBe('competitor-report')
    expect(reopenedStatusId).toBe('in-progress')
    expect(requestCounts.issueUpdates).toBe(1)
  })

  test('主要タスクビューの読み上げ構造とキーボードタブ操作を維持する', async ({ page }) => {
    await page.goto('/projects/refero/issues')

    const tablist = page.getByRole('tablist', { name: 'タスクビュー' })
    await expect(tablist).toMatchAriaSnapshot(`
      - tablist "タスクビュー":
        - tab "テーブル" [selected]
        - tab "ボード"
        - tab "期限順"
        - tab "期限カレンダー"
        - tab "ファイル"
        - tab "権限"
    `)

    const tableSnapshot = await page
      .getByRole('region', { name: 'Refero のタスク一覧' })
      .ariaSnapshot()
    expect(tableSnapshot).toContain('- columnheader "タスク名"')
    expect(tableSnapshot).toContain('- columnheader "担当者"')
    expect(tableSnapshot).toContain('- columnheader "ステータス"')
    expect(tableSnapshot).toContain(
      '- checkbox "新しいランディングページのワイヤーフレーム作成"',
    )
    expect(tableSnapshot).toContain(
      '- \'button "タスク詳細: 新しいランディングページのワイヤーフレーム作成"\'',
    )

    const tableTab = tablist.getByRole('tab', { name: 'テーブル' })
    const boardTab = tablist.getByRole('tab', { name: 'ボード' })
    await tableTab.focus()
    await page.keyboard.press('ArrowRight')

    await expect(boardTab).toBeFocused()
    await expect(boardTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tabpanel', { name: 'ボード' })).toContainText('ボードビュー')
  })

  test('Issue #190: Planning 障害でも Task を表示し dependency だけ再試行する', async ({ page }) => {
    const dependency = {
      id: 'dependency-planning-retry',
      predecessor: { teamId: 'core-team', workItemId: 'wireframe' },
      successor: { teamId: 'core-team', workItemId: 'brand-guideline' },
      type: 'finish-to-start',
      lagDays: 1,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    } satisfies WorkItemScheduleDependency
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      planningFailureCount: 1,
      workItemScheduleDependencies: [dependency],
    })
    await page.goto('/projects/refero/issues')

    await expect(page.getByTestId('task-row-wireframe')).toBeVisible()
    const planningError = page.getByTestId('project-planning-error')
    await expect(planningError).toContainText('計画を取得できませんでした。')
    await planningError.getByRole('button', { name: '再試行' }).click()

    await expect(planningError).toHaveCount(0)
    await expect(page.getByTestId('task-row-wireframe')).toContainText('1 件をブロック')
  })

  test('Issue #190: Planning の Project 導線は Team-qualified scope を直接開く', async ({ page }) => {
    const snapshot: PlanningSnapshot = {
      ...structuredClone(planningSnapshotFixture),
      workItemDependencySummary: {
        ...structuredClone(planningSnapshotFixture.workItemDependencySummary),
        affectedProjects: [
          { projectId: 'refero', teamId: 'core-team' },
          { projectId: 'shared-launch', teamId: 'design-team' },
        ],
      },
    }
    await page.unroute('**/api/planning')
    await page.route('**/api/planning', async (route) => {
      await route.fulfill({ json: snapshot })
    })
    await page.goto('/planning/timeline')

    const dependencyPanel = page.getByTestId('planning-work-item-dependencies')
    await dependencyPanel.getByRole('button', {
      name: '影響する Project 2 件: design-team / shared-launch',
    }).click()
    await expect(page).toHaveURL('/projects/shared-launch/issues?teamId=design-team')

    await page.goto('/planning/timeline')
    await dependencyPanel.getByRole('button', {
      name: '影響する Project 2 件: core-team / refero',
    }).click()
    await expect(page).toHaveURL('/projects/refero/issues?teamId=core-team')
  })

  test('Issue #190: filter で隠れた同一 Project endpoint を外部扱いしない', async ({ page }) => {
    const dependency = {
      id: 'dependency-filtered-local',
      predecessor: { teamId: 'core-team', workItemId: 'wireframe' },
      successor: { teamId: 'core-team', workItemId: 'brand-guideline' },
      type: 'finish-to-start',
      lagDays: 1,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    } satisfies WorkItemScheduleDependency
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      workItemScheduleDependencies: [dependency],
    })
    await page.goto('/projects/refero/issues')

    await page.getByRole('searchbox', { name: '検索...' }).fill('ワイヤーフレーム')
    await page.getByRole('tab', { name: '期限順', exact: true }).click()
    const dependencySummary = page.getByTestId(`task-gantt-dependency-${dependency.id}`)

    await expect(dependencySummary).toBeVisible()
    await expect(dependencySummary).not.toContainText('外部 Project')
    await expect(page.getByTestId('task-gantt-external-lane')).toHaveCount(0)
    await expect(dependencySummary).toContainText('先行 Work Item')
    await expect(dependencySummary).toContainText('後続 Work Item')
  })

  test('Issue #190: 依存先への日程波及を preview 後の confirm で一括保存する', async ({ page }) => {
    const dependency = {
      id: 'dependency-wireframe-brand',
      predecessor: { teamId: 'core-team', workItemId: 'wireframe' },
      successor: { teamId: 'core-team', workItemId: 'brand-guideline' },
      type: 'finish-to-start',
      lagDays: 2,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    } satisfies WorkItemScheduleDependency
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      workItemScheduleDependencies: [dependency],
    })
    await page.goto('/projects/refero/issues')
    const requestCounts = getMockRequestCounts(page)

    await page.getByRole('tab', { name: '期限順', exact: true }).click()
    const dependencySummary = page.getByTestId(`task-gantt-dependency-${dependency.id}`)

    await expect(dependencySummary).toContainText('終了から開始')
    await expect(dependencySummary).toContainText('+2日')
    await expect(page.getByTestId(`task-gantt-connector-${dependency.id}`)).toBeVisible()

    const wireframeBar = page.getByTestId('task-gantt-bar-wireframe')
    await wireframeBar.focus()
    await page.keyboard.press('ArrowRight')

    const preview = page.getByRole('dialog', { name: '一括操作の事前確認' })

    await expect(preview).toContainText('wireframe')
    await expect(preview).toContainText('brand-guideline')
    await expect(preview).toContainText('依存関係')
    await expect(preview).toContainText(`依存関係 ${dependency.id} による変更`)
    await expect(preview).toContainText('2026-06-06')
    expect(requestCounts.issueUpdates).toBe(0)
    expect(requestCounts.scheduleConfirms).toBe(0)

    await preview.getByRole('button', { name: '適用', exact: true }).click()

    const wireframeRow = page.locator('article').filter({
      has: page.getByTestId('task-gantt-bar-wireframe'),
    })
    const brandRow = page.locator('article').filter({
      has: page.getByTestId('task-gantt-bar-brand-guideline'),
    })
    await expect(wireframeRow.locator('input[id^="gantt-start-"]')).toHaveValue('2026-06-02')
    await expect(brandRow.locator('input[id^="gantt-date-"]')).toHaveValue('2026-06-06')
    await expect.poll(() => requestCounts.scheduleConfirms).toBe(1)
    expect(requestCounts.issueUpdates).toBe(0)

  })

  test('Issue #190: confirm 後の GET 失敗でも全日程を成功状態へ反映する', async ({ page }) => {
    const dependency = {
      id: 'dependency-wireframe-brand-refresh-failure',
      predecessor: { teamId: 'core-team', workItemId: 'wireframe' },
      successor: { teamId: 'core-team', workItemId: 'brand-guideline' },
      type: 'finish-to-start',
      lagDays: 2,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    } satisfies WorkItemScheduleDependency
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      postConfirmProjectIssueFailureCount: 1,
      workItemScheduleDependencies: [dependency],
    })
    await page.goto('/projects/refero/issues')
    const requestCounts = getMockRequestCounts(page)

    await page.getByRole('tab', { name: '期限順', exact: true }).click()
    const wireframeBar = page.getByTestId('task-gantt-bar-wireframe')

    await wireframeBar.focus()
    await page.keyboard.press('ArrowRight')

    const preview = page.getByRole('dialog', { name: '一括操作の事前確認' })

    await preview.getByRole('button', { name: '適用', exact: true }).click()
    await expect.poll(() => requestCounts.scheduleConfirms).toBe(1)
    await expect.poll(() => requestCounts.projectIssues.refero ?? 0).toBe(3)

    const wireframeRow = page.locator('article').filter({
      has: page.getByTestId('task-gantt-bar-wireframe'),
    })
    const brandRow = page.locator('article').filter({
      has: page.getByTestId('task-gantt-bar-brand-guideline'),
    })

    await expect(page.getByTestId('task-action-feedback')).toContainText('変更を保存しました。')
    await expect(wireframeRow.locator('input[id^="gantt-start-"]')).toHaveValue('2026-06-02')
    await expect(wireframeRow.locator('input[id^="gantt-end-"]')).toHaveValue('2026-06-04')
    await expect(brandRow.locator('input[id^="gantt-date-"]')).toHaveValue('2026-06-06')
    await expect(page.getByTestId('tasks-error')).toHaveCount(0)
    expect(requestCounts.scheduleConfirms).toBe(1)
  })

  test('Issue #190: dependency conflict preview は Gantt と Calendar で Cancel に focus する', async ({ page }) => {
    const dependency = {
      id: 'dependency-wireframe-brand-conflict',
      predecessor: { teamId: 'core-team', workItemId: 'wireframe' },
      successor: { teamId: 'core-team', workItemId: 'brand-guideline' },
      type: 'finish-to-start',
      lagDays: 2,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    } satisfies WorkItemScheduleDependency
    const conflict = {
      code: 'dependency-violation',
      dependencyId: dependency.id,
      workItem: dependency.successor,
      requiredDate: '2026-06-06',
      actualDate: '2026-06-05',
    } satisfies WorkItemScheduleDependencyConflict
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      workItemScheduleDependencies: [dependency],
      workItemScheduleDependencyConflicts: [conflict],
    })
    await page.goto('/projects/refero/issues')
    const requestCounts = getMockRequestCounts(page)

    await page.getByRole('tab', { name: '期限順', exact: true }).click()
    const wireframeBar = page.getByTestId('task-gantt-bar-wireframe')
    await wireframeBar.focus()
    await page.keyboard.press('ArrowRight')

    const preview = page.getByRole('dialog', { name: '一括操作の事前確認' })
    await expect(preview.getByRole('alert')).toContainText('依存関係のルールを満たせません。')
    await expect(preview).toContainText('日程変更を確定する前に競合を解消してください。')
    await expect(preview.getByRole('button', { name: '適用', exact: true })).toBeDisabled()
    const ganttCancel = preview.getByRole('button', { name: 'キャンセル', exact: true })
    await expect(ganttCancel).toBeFocused()
    await ganttCancel.click()

    await page.getByRole('tab', { name: '期限カレンダー', exact: true }).click()
    await dragScheduleCard(
      page,
      page.getByTestId('task-calendar-item-wireframe'),
      page.getByTestId('task-calendar-day-2026-06-07'),
    )

    const calendarPreview = page.getByRole('dialog', { name: '一括操作の事前確認' })
    await expect(calendarPreview.getByRole('alert')).toContainText(
      '依存関係のルールを満たせません。',
    )
    await expect(
      calendarPreview.getByRole('button', { name: '適用', exact: true }),
    ).toBeDisabled()
    await expect(
      calendarPreview.getByRole('button', { name: 'キャンセル', exact: true }),
    ).toBeFocused()
    expect(requestCounts.scheduleConfirms).toBe(0)
    expect(requestCounts.issueUpdates).toBe(0)
  })

  test('Issue #190: 外部 Project 依存の connector と lead/lag を示し両端管理者以外は参照専用にする', async ({ page }) => {
    const externalIssue = createStoredTeamIssue({
      assignedProjectId: 'product-roadmap',
      dueDate: '2026-06-08',
      id: 'external-launch',
      schedule: {
        calendarPolicy: DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY,
        dueDate: '2026-06-08',
        mode: 'due-date',
      },
      title: '外部ローンチ準備',
    })
    const dependency = {
      id: 'dependency-wireframe-external',
      predecessor: { teamId: 'core-team', workItemId: 'wireframe' },
      successor: { teamId: 'core-team', workItemId: externalIssue.id },
      type: 'start-to-finish',
      lagDays: -2,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    } satisfies WorkItemScheduleDependency
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      currentUser: {
        username: 'demo@example.com',
        name: 'Demo User',
        isSystemAdmin: false,
        workspaceRole: 'member',
      },
      projectMembersByProject: {
        'product-roadmap': [{
          id: 'demo@example.com',
          email: 'demo@example.com',
          name: 'Demo User',
          role: 'viewer',
          updatedAt: '2026-06-08T00:00:00.000Z',
          workspaceStatus: 'active',
        }],
      },
      teamIssuesByTeam: { 'core-team': [externalIssue] },
      workItemScheduleDependencies: [dependency],
    })
    await page.goto('/projects/refero/issues')

    await page.getByRole('tab', { name: '期限順', exact: true }).click()
    const dependencySummary = page.getByTestId(`task-gantt-dependency-${dependency.id}`)

    await expect(dependencySummary).toContainText('外部 Project')
    await expect(dependencySummary).toContainText('開始から終了')
    await expect(dependencySummary).toContainText('-2日')
    await expect(page.getByTestId('task-gantt-external-lane')).toBeVisible()
    await expect(page.getByTestId(`task-gantt-external-${dependency.id}`)).toContainText(
      '外部: 外部ローンチ準備',
    )
    await expect(page.getByTestId(`task-gantt-connector-${dependency.id}`)).toBeVisible()

    const dependencyDetails = page.locator('details').filter({
      hasText: 'スケジュール依存関係',
    }).first()
    await dependencyDetails.locator('summary').click()
    const dependencyRow = dependencyDetails.getByTestId(`work-item-dependency-${dependency.id}`)
    await expect(dependencyRow).toContainText('外部ローンチ準備')
    await expect(dependencyRow).toContainText('スケジュール依存関係は参照専用です。')
    await expect(dependencyRow.getByRole('button', { name: /^更新/u })).toHaveCount(0)
    await expect(dependencyRow.getByRole('button', { name: /^削除/u })).toHaveCount(0)
  })

  test('Issue #190: Team Issue の Table・Board・詳細で同じ依存関係を示す', async ({ page }) => {
    const dependency = {
      id: 'dependency-team-surface',
      predecessor: { teamId: 'core-team', workItemId: 'wireframe' },
      successor: { teamId: 'core-team', workItemId: 'brand-guideline' },
      type: 'finish-to-start',
      lagDays: 1,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    } satisfies WorkItemScheduleDependency
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      workItemScheduleDependencies: [dependency],
    })
    await page.goto('/teams/core-team/issues')

    const tableRow = page.locator('tr').filter({ has: page.getByTestId('issue-row-wireframe') })
    await expect(tableRow).toContainText('1 件をブロック')
    await page.getByRole('button', { name: 'ボード', exact: true }).click()
    await expect(page.getByTestId('team-issue-card-wireframe')).toContainText('1 件をブロック')

    await page.getByRole('button', { name: 'テーブル', exact: true }).click()
    await page.getByTestId('issue-row-wireframe').click()
    const detailPanel = page.locator('aside').getByTestId('work-item-dependency-panel')

    await expect(detailPanel.getByTestId(`work-item-dependency-${dependency.id}`)).toContainText(
      '新しいランディングページのワイヤーフレーム作成',
    )
    await expect(detailPanel.getByTestId(`work-item-dependency-${dependency.id}`)).toContainText(
      'ブランドガイドラインの更新',
    )
  })

  test('Issue #188: Table の期限編集も共通 preview を確認してから保存する', async ({ page }) => {
    await page.goto('/projects/refero/issues')
    const requestCounts = getMockRequestCounts(page)
    const dueDateField = page.getByTestId('task-inline-due-date-seo-research')

    await dueDateField.click()
    const dueDateInput = page.getByTestId('task-inline-due-date-seo-research-input')

    await dueDateInput.fill('2026-06-10')
    await dueDateInput.press('Enter')

    const preview = page.getByTestId('task-schedule-update-preview')

    await expect(preview).toHaveAccessibleName('一括操作の事前確認')
    await expect(preview).toContainText('core-team / seo-research')
    await expect(preview).toContainText('変更前: 期限のみ: 2026-06-09')
    await expect(preview).toContainText('変更後: 期限のみ: 2026-06-10')
    await expect.poll(() => requestCounts.schedulePreviews).toBe(1)
    expect(requestCounts.issueUpdates).toBe(0)
    expect(requestCounts.scheduleConfirms).toBe(0)

    await preview.getByRole('button', { name: '適用', exact: true }).click()

    await expect(page.getByTestId('task-inline-due-date-seo-research')).toContainText(
      '期限のみ: 2026-06-10',
    )
    await expect.poll(() => requestCounts.scheduleConfirms).toBe(1)
    expect(requestCounts.issueUpdates).toBe(0)
  })

  test('Issue #188: Gantt はキーボード移動を事前確認し undo・redo・resize できる', async ({ page }) => {
    await page.goto('/projects/refero/issues')
    const requestCounts = getMockRequestCounts(page)

    await page.getByRole('tab', { name: '期限順', exact: true }).click()

    const bar = page.getByTestId('task-gantt-bar-wireframe')
    const row = page.locator('article').filter({ has: bar })
    const startDate = row.locator('input[id^="gantt-start-"]')
    const endDate = row.locator('input[id^="gantt-end-"]')

    await expect(startDate).toHaveValue('2026-06-01')
    await expect(endDate).toHaveValue('2026-06-03')
    await bar.focus()
    await page.keyboard.press('ArrowRight')

    const movePreview = page.getByRole('dialog', { name: '一括操作の事前確認' })

    await expect(movePreview).toContainText('2026-06-01 – 2026-06-03')
    await expect(movePreview).toContainText('2026-06-02 – 2026-06-04')
    await movePreview.getByRole('button', { name: '適用', exact: true }).click()

    await expect(startDate).toHaveValue('2026-06-02')
    await expect(endDate).toHaveValue('2026-06-04')
    await expect.poll(() => requestCounts.schedulePreviews).toBe(1)
    await expect.poll(() => requestCounts.scheduleConfirms).toBe(1)

    const feedback = page.getByTestId('task-action-feedback')

    await feedback.getByRole('button', { name: '元に戻す', exact: true }).click()
    const undoPreview = page.getByTestId('task-schedule-update-preview')
    await expect(undoPreview).toContainText('2026-06-02 – 2026-06-04')
    await expect(undoPreview).toContainText('2026-06-01 – 2026-06-03')
    await undoPreview.getByRole('button', { name: '適用', exact: true }).click()
    await expect(startDate).toHaveValue('2026-06-01')
    await expect(endDate).toHaveValue('2026-06-03')
    await expect.poll(() => requestCounts.schedulePreviews).toBe(2)
    await expect.poll(() => requestCounts.scheduleConfirms).toBe(2)

    await feedback.getByRole('button', { name: 'やり直す', exact: true }).click()
    const redoPreview = page.getByTestId('task-schedule-update-preview')
    await expect(redoPreview).toContainText('2026-06-01 – 2026-06-03')
    await expect(redoPreview).toContainText('2026-06-02 – 2026-06-04')
    await redoPreview.getByRole('button', { name: '適用', exact: true }).click()
    await expect(startDate).toHaveValue('2026-06-02')
    await expect(endDate).toHaveValue('2026-06-04')
    await expect.poll(() => requestCounts.schedulePreviews).toBe(3)
    await expect.poll(() => requestCounts.scheduleConfirms).toBe(3)

    const resizeHandle = page.getByTestId('task-gantt-resize-wireframe')

    await resizeHandle.focus()
    await page.keyboard.press('ArrowRight')

    const resizePreview = page.getByRole('dialog', { name: '一括操作の事前確認' })

    await expect(resizePreview).toContainText('2026-06-02 – 2026-06-04')
    await expect(resizePreview).toContainText('2026-06-02 – 2026-06-05')
    await resizePreview.getByRole('button', { name: '適用', exact: true }).click()

    await expect(endDate).toHaveValue('2026-06-05')
    await expect.poll(() => requestCounts.schedulePreviews).toBe(4)
    await expect.poll(() => requestCounts.scheduleConfirms).toBe(4)
    await expect(resizePreview).toHaveCount(0)

    await expectWireframeScheduleAcrossTaskViews(page, '2026-06-02', '2026-06-05')
    await page.reload()
    await expectWireframeScheduleAcrossTaskViews(page, '2026-06-02', '2026-06-05')
    await page.getByRole('tab', { name: '期限順', exact: true }).click()

    await row.locator('select[id^="gantt-mode-"]').selectOption('due-date')

    const modePreview = page.getByRole('dialog', { name: '一括操作の事前確認' })

    await expect(modePreview).toContainText('2026-06-02 – 2026-06-05')
    await expect(modePreview).toContainText('期限: 2026-06-05')
    await modePreview.getByRole('button', { name: '適用', exact: true }).click()

    await expect(row.locator('input[id^="gantt-date-"]')).toHaveValue('2026-06-05')
    await expect.poll(() => requestCounts.schedulePreviews).toBe(5)
    await expect.poll(() => requestCounts.scheduleConfirms).toBe(5)
  })

  test('Issue #188: Gantt は既存 bar と重なる日へ pointer drag で移動・短縮できる', async ({ page }) => {
    await page.goto('/projects/refero/issues')
    const requestCounts = getMockRequestCounts(page)

    await page.getByRole('tab', { name: '期限順', exact: true }).click()

    const bar = page.getByTestId('task-gantt-bar-wireframe')
    const timeline = page.getByTestId('task-gantt-timeline-wireframe')

    await dragGanttControlToDate(page, bar, timeline, '2026-06-02')

    const movePreview = page.getByRole('dialog', { name: '一括操作の事前確認' })

    await expect(movePreview).toContainText('2026-06-01 – 2026-06-03')
    await expect(movePreview).toContainText('2026-06-02 – 2026-06-04')
    await movePreview.getByRole('button', { name: '適用', exact: true }).click()

    const movedRow = page.locator('article').filter({
      has: page.getByTestId('task-gantt-bar-wireframe'),
    })
    await expect(movedRow.locator('input[id^="gantt-start-"]')).toHaveValue('2026-06-02')
    await expect(movedRow.locator('input[id^="gantt-end-"]')).toHaveValue('2026-06-04')

    await dragGanttControlToDate(
      page,
      page.getByTestId('task-gantt-resize-wireframe'),
      page.getByTestId('task-gantt-timeline-wireframe'),
      '2026-06-03',
    )

    const resizePreview = page.getByRole('dialog', { name: '一括操作の事前確認' })

    await expect(resizePreview).toContainText('2026-06-02 – 2026-06-04')
    await expect(resizePreview).toContainText('2026-06-02 – 2026-06-03')
    await resizePreview.getByRole('button', { name: '適用', exact: true }).click()

    await expect(movedRow.locator('input[id^="gantt-start-"]')).toHaveValue('2026-06-02')
    await expect(movedRow.locator('input[id^="gantt-end-"]')).toHaveValue('2026-06-03')
    await expect.poll(() => requestCounts.schedulePreviews).toBe(2)
    await expect.poll(() => requestCounts.scheduleConfirms).toBe(2)
  })

  test('Issue #188: Gantt は未計画 row の明示日付から bar を作成し再読込後も保持する', async ({ page }) => {
    await page.goto('/projects/refero/issues')
    const requestCounts = getMockRequestCounts(page)

    await page.getByRole('tab', { name: '期限順', exact: true }).click()
    const unscheduledRow = page.locator('article').filter({
      hasText: '競合サイトの分析レポート作成',
    })

    await unscheduledRow.locator('input[id^="gantt-create-"]').fill('2026-06-08')

    const preview = page.getByRole('dialog', { name: '一括操作の事前確認' })

    await expect(preview).toContainText('予定なし')
    await expect(preview).toContainText('2026-06-08')
    await preview.getByRole('button', { name: '適用', exact: true }).click()

    await expect(page.getByTestId('task-gantt-bar-competitor-report')).toBeVisible()
    await expect(unscheduledRow.locator('select[id^="gantt-mode-"]')).toHaveValue('date-range')
    await expect(unscheduledRow.locator('input[id^="gantt-start-"]')).toHaveValue('2026-06-08')
    await expect(unscheduledRow.locator('input[id^="gantt-end-"]')).toHaveValue('2026-06-08')
    await expect.poll(() => requestCounts.schedulePreviews).toBe(1)
    await expect.poll(() => requestCounts.scheduleConfirms).toBe(1)

    await page.reload()
    await page.getByRole('tab', { name: '期限順', exact: true }).click()

    const reloadedBar = page.getByTestId('task-gantt-bar-competitor-report')
    const reloadedRow = page.locator('article').filter({ has: reloadedBar })

    await expect(reloadedBar).toBeVisible()
    await expect(reloadedRow.locator('select[id^="gantt-mode-"]')).toHaveValue('date-range')
    await expect(reloadedRow.locator('input[id^="gantt-start-"]')).toHaveValue('2026-06-08')
    await expect(reloadedRow.locator('input[id^="gantt-end-"]')).toHaveValue('2026-06-08')
  })

  test('Issue #188: Calendar は日付と未計画 bucket の間を drag and drop できる', async ({ page }) => {
    await page.goto('/projects/refero/issues')
    const requestCounts = getMockRequestCounts(page)

    await page.getByRole('tab', { name: '期限カレンダー', exact: true }).click()

    const unscheduledBucket = page.getByTestId('task-calendar-unscheduled')
    const calendarCard = page.getByTestId('task-calendar-item-wireframe')

    await dragScheduleCard(page, calendarCard, unscheduledBucket)

    const unschedulePreview = page.getByRole('dialog', { name: '一括操作の事前確認' })

    await expect(unschedulePreview).toContainText('2026-06-01 – 2026-06-03')
    await expect(unschedulePreview).toContainText('予定なし')
    await unschedulePreview.getByRole('button', { name: '適用', exact: true }).click()

    const unscheduledCard = unscheduledBucket.getByTestId('task-calendar-item-wireframe')

    await expect(unscheduledCard).toBeVisible()
    await expect(unscheduledCard).toBeFocused()
    await expect.poll(() => requestCounts.schedulePreviews).toBe(1)
    await expect.poll(() => requestCounts.scheduleConfirms).toBe(1)

    const targetDay = page.getByTestId('task-calendar-day-2026-06-07')

    await dragScheduleCard(
      page,
      unscheduledBucket.getByTestId('task-calendar-item-wireframe'),
      targetDay,
    )

    const reschedulePreview = page.getByRole('dialog', { name: '一括操作の事前確認' })

    await expect(reschedulePreview).toContainText('予定なし')
    await expect(reschedulePreview).toContainText('2026-06-07')
    await reschedulePreview.getByRole('button', { name: '適用', exact: true }).click()

    const rescheduledCard = targetDay.getByTestId('task-calendar-item-wireframe')

    await expect(rescheduledCard).toBeVisible()
    await expect(rescheduledCard).toBeFocused()
    await expect(unscheduledBucket.getByTestId('task-calendar-item-wireframe')).toHaveCount(0)
    await expect.poll(() => requestCounts.schedulePreviews).toBe(2)
    await expect.poll(() => requestCounts.scheduleConfirms).toBe(2)

    await page.reload()
    await page.getByRole('tab', { name: '期限カレンダー', exact: true }).click()
    await expect(
      page.getByTestId('task-calendar-day-2026-06-07')
        .getByTestId('task-calendar-item-wireframe'),
    ).toBeVisible()
  })

  test('Issue #188: Calendar は2日を選んだ期間 task を作成し再読込後も保持する', async ({ page }) => {
    await page.goto('/projects/refero/issues')
    const requestCounts = getMockRequestCounts(page)

    await page.getByRole('tab', { name: '期限カレンダー', exact: true }).click()
    await page.getByRole('button', {
      name: '2026-06-08 を始点または終点にして期間を作成',
    }).click()
    await page.getByRole('button', {
      name: '2026-06-10 を始点または終点にして期間を作成',
    }).click()

    const createTaskForm = page.getByTestId('create-task-form')

    await expect(createTaskForm.locator('select[name="scheduleMode"]')).toHaveValue('date-range')
    await expect(createTaskForm.locator('input[name="scheduleStartDate"]')).toHaveValue('2026-06-08')
    await expect(createTaskForm.locator('input[name="scheduleEndDate"]')).toHaveValue('2026-06-10')

    await createTaskForm.locator('input[name="title"]').fill('Calendar range task')
    await createTaskForm.locator('select[name="assigneeUserId"]').selectOption('sato@example.com')
    await createTaskForm.getByRole('button', { name: '登録', exact: true }).click()

    const createdCard = page.getByTestId('task-calendar-item-calendar-range-task')

    await expect(createdCard).toContainText('Calendar range task')
    await expect(createdCard).toContainText('期間')
    await expect(createdCard).toContainText('2026-06-08 – 2026-06-10')
    await expect.poll(() => requestCounts.issueCreates).toBe(1)

    await page.reload()
    await page.getByRole('tab', { name: '期限カレンダー', exact: true }).click()
    await expect(page.getByTestId('task-calendar-item-calendar-range-task')).toContainText(
      '2026-06-08 – 2026-06-10',
    )
  })

  test('Issue #188: schedule preview の permission error は理由を表示し更新しない', async ({ page }) => {
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      forbiddenSchedulePreviewIssueKeys: [
        createIssueCollaborationKey('core-team', 'wireframe'),
      ],
    })
    await page.goto('/projects/refero/issues')
    const requestCounts = getMockRequestCounts(page)

    await page.getByRole('tab', { name: '期限順', exact: true }).click()
    const bar = page.getByTestId('task-gantt-bar-wireframe')

    await bar.focus()
    await page.keyboard.press('ArrowRight')

    await expect(page.getByTestId('task-action-feedback')).toContainText(
      'このスケジュールを変更する権限がありません。',
    )
    await expect.poll(() => requestCounts.schedulePreviews).toBe(1)
    expect(requestCounts.issueUpdates).toBe(0)
    expect(requestCounts.scheduleConfirms).toBe(0)
    await expect(page.getByRole('dialog', { name: '一括操作の事前確認' })).toHaveCount(0)
  })

  test('Issue #188: schedule の revision conflict は optimistic 表示を戻して理由を示す', async ({ page }) => {
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      revisionConflictIssueKeys: [createIssueCollaborationKey('core-team', 'wireframe')],
    })
    await page.goto('/projects/refero/issues')
    const requestCounts = getMockRequestCounts(page)

    await page.getByRole('tab', { name: '期限順', exact: true }).click()

    const bar = page.getByTestId('task-gantt-bar-wireframe')
    const row = page.locator('article').filter({ has: bar })
    const startDate = row.locator('input[id^="gantt-start-"]')
    const endDate = row.locator('input[id^="gantt-end-"]')

    await expect(startDate).toHaveValue('2026-06-01')
    await expect(endDate).toHaveValue('2026-06-03')
    await bar.focus()
    await page.keyboard.press('ArrowRight')

    const preview = page.getByRole('dialog', { name: '一括操作の事前確認' })

    await expect(preview).toContainText('2026-06-02 – 2026-06-04')
    await preview.getByRole('button', { name: '適用', exact: true }).click()

    await expect(preview).toHaveCount(0)
    await expect(startDate).toHaveValue('2026-06-01')
    await expect(endDate).toHaveValue('2026-06-03')
    await expect(page.getByTestId('task-action-feedback')).toContainText(
      '別の変更と競合しました。最新の内容を確認してください。',
    )
    await expect.poll(() => requestCounts.schedulePreviews).toBe(1)
    await expect.poll(() => requestCounts.scheduleConfirms).toBe(1)
  })

  test('低速なタスクAPIを読み上げて一度だけ取得し、キーボード操作を保ったまま復帰する', async ({
    page,
  }) => {
    let releaseTaskResponse: () => void = () => undefined
    let markTaskRequestStarted: () => void = () => undefined
    const taskResponseGate = new Promise<void>((resolve) => {
      releaseTaskResponse = resolve
    })
    const taskRequestStarted = new Promise<void>((resolve) => {
      markTaskRequestStarted = resolve
    })
    let interceptedTaskRequestCount = 0

    await page.route('**/api/projects/refero/issues**', async (route) => {
      interceptedTaskRequestCount += 1
      markTaskRequestStarted()
      await taskResponseGate
      await route.fallback()
    })

    try {
      await page.goto('/projects/refero/issues')
      await taskRequestStarted

      const taskMain = page.locator('main.workbench-shell > section.workbench-main')
      await expect(taskMain).toHaveAttribute('aria-busy', 'true')
      await expect(page.getByRole('status')).toHaveText('タスク一覧を確認しています。')
      await expect(page.getByTestId('task-row-wireframe')).toHaveCount(0)

      const searchTrigger = page.getByTestId('sidebar-search-trigger')
      await searchTrigger.focus()
      await page.keyboard.press('ControlOrMeta+K')
      await expect(
        page.getByRole('dialog', { name: 'Workspace command menu' })
          .getByRole('combobox'),
      ).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(searchTrigger).toBeFocused()

      const requestCounts = getMockRequestCounts(page)
      expect(interceptedTaskRequestCount).toBe(1)
      expect(requestCounts.issueCreates).toBe(0)
      expect(requestCounts.issueUpdates).toBe(0)
      expect(requestCounts.taskCreates).toBe(0)
      expect(requestCounts.taskStatusUpdates).toBe(0)

      releaseTaskResponse()

      await expect(page.getByTestId('task-row-wireframe')).toBeVisible()
      await expect(page.getByRole('status')).toHaveCount(0)
      await expect(taskMain).toHaveAttribute('aria-busy', 'false')
      expect(interceptedTaskRequestCount).toBe(1)
      expect(requestCounts.projectIssues.refero).toBe(1)
    } finally {
      releaseTaskResponse()
    }
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
    await page.goto('/projects/refero/issues')

    await expect(page.getByTestId('tasks-heading')).toBeVisible()
    await expect(page.getByTestId('task-row-wireframe')).toBeVisible()
    await expect(page.getByTestId('tasks-count')).toContainText('4')

    await page.getByRole('searchbox', { name: '検索...' }).fill('SEO')

    await expect(page.getByTestId('task-row-seo-research')).toBeVisible()
    await expect(page.getByTestId('task-row-brand-guideline')).toBeHidden()
    await expect(page.getByTestId('tasks-count')).toContainText('1')

    const searchbox = page.getByRole('searchbox', { name: '検索...' })
    const statusFilterButton = page.getByRole('button', {
      exact: true,
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

    const issueSearchbox = page.getByRole('searchbox', { name: 'Issue を検索...' })

    await issueSearchbox.clear()
    await expect(issueSearchbox).toHaveValue('')
    await expect(page.getByTestId('team-issues-count')).toContainText('4')
    await page.getByRole('combobox', { name: 'Issue ステータス' }).selectOption(
      ['core-team', 'default', 'review'].join('\u0000'),
    )

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

    const issueRow = page.locator('tr').filter({
      has: page.getByTestId('issue-row-configurable-delivery'),
    })

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
    await expect.poll(() => requestCounts.projectIssues.refero).toBeGreaterThanOrEqual(2)
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

    await page.getByRole('button', { exact: true, name: '担当者' }).click()
    await page.getByRole('menuitemradio', { name: '佐藤 花子' }).click()

    await expect(page.getByTestId('task-row-wireframe')).toBeVisible()
    await expect(page.getByTestId('task-row-brand-guideline')).toBeHidden()
    await expect(page.getByTestId('tasks-count')).toContainText('1')

    await page.getByRole('button', { exact: true, name: '担当者' }).click()
    await page.getByRole('menuitemradio', { name: 'すべての担当者' }).click()
    await page.getByRole('button', { exact: true, name: '優先度' }).click()
    await page.getByRole('menuitemradio', { name: '高' }).click()

    await expect(page.getByTestId('task-row-wireframe')).toBeVisible()
    await expect(page.getByTestId('task-row-seo-research')).toBeHidden()
    await expect(page.getByTestId('tasks-count')).toContainText('1')

    await page.getByRole('button', { exact: true, name: '優先度' }).click()
    await page.getByRole('menuitemradio', { name: 'すべての優先度' }).click()
    // Wait for the URL-owned task-view override to round-trip before applying
    // the next filter; otherwise the next click can race the previous update.
    await expect(page.getByTestId('task-row-seo-research')).toBeVisible()
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

    await expect(page.getByTestId('task-row-competitor-report')).toBeVisible()
    await expect(page.getByTestId('task-row-seo-research')).toBeVisible()
    await expect(page.getByTestId('task-row-wireframe')).toBeVisible()
    await expect(page.getByTestId('task-row-competitor-report')).toHaveAttribute(
      'data-row-index',
      '0',
    )
    await expect(page.getByTestId('task-row-seo-research')).toHaveAttribute('data-row-index', '1')

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

    await page.getByTestId('task-open-detail-seo-research').click()

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
    await page.goto('/projects/refero/issues')

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

    await page.goto('/projects/refero/issues')
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

    const manageQuickAccessButton = sidebar.getByRole('button', {
      name: 'クイックアクセスを管理',
    })

    await manageQuickAccessButton.click()
    const quickAccessDialog = page.getByRole('dialog', {
      name: 'クイックアクセスを管理',
    })

    await expect(quickAccessDialog).toBeVisible()
    await expect(quickAccessDialog.getByRole('button', { name: '閉じる' })).toBeFocused()
    await quickAccessDialog.getByRole('button', { name: '閉じる' }).click()
    await expect(quickAccessDialog).toHaveCount(0)
    await expect(drawer).toBeVisible()
    await expect(manageQuickAccessButton).toBeFocused()

    await page.mouse.move(180, 620)
    await page.mouse.wheel(0, 700)

    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  })

  test('390px 幅で Task と Issue の主要操作が viewport 内で使える', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })

    await page.goto('/projects/refero/issues?teamId=core-team&issueId=wireframe')
    await expect(page.getByTestId('tasks-heading')).toBeVisible()
    await page.getByTestId('task-open-detail-brand-guideline').click()
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

  test('DB の Quick Access と現在の Team をサイドバーに表示し、選択したプロジェクトのタスクへ遷移する', async ({
    page,
  }) => {
    await page.goto('/dashboard')
    const requestCounts = getMockRequestCounts(page)
    const sidebar = page.getByLabel('メインサイドバー')

    await expect(sidebar.getByRole('button', { name: 'コアチーム', exact: true })).toBeVisible()
    await expect(sidebar.getByRole('button', { name: 'デザインチーム', exact: true })).toHaveCount(0)
    await expect(sidebar.getByRole('button', { name: '共通ローンチ', exact: true })).toHaveCount(2)
    expect(requestCounts.projectDirectory).toBe(1)
    await expect.poll(() => requestCounts.workspaceWorkItems).toBe(1)
    expect(requestCounts.projectIssues).toEqual({})

    await sidebar.getByRole('button', { name: 'ブランド刷新', exact: true }).click()

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
    await createIssueForm.locator('input[name="dueDate"]').fill('')
    await createIssueForm.getByRole('button', { name: 'Issue を作成' }).click()

    await expect(page.getByTestId('issue-row-割当待ち-issue')).toBeVisible()
    expect(requestCounts.issueCreates).toBe(1)

    await page.getByTestId('issue-row-割当待ち-issue').click()
    await expect(page.locator('aside output')).toContainText('未計画')
    await page.locator('aside select[name="assignedProjectId"]').selectOption('refero')
    await page.getByRole('button', { name: '変更を保存' }).click()

    await expect.poll(() => requestCounts.issueUpdates).toBe(1)

    await page.locator('textarea[name="body"]').fill('プロジェクト側で着手します。')
    await page.getByRole('button', { name: 'コメントを追加' }).click()

    await expect(
      page.getByTestId('comment-thread-comment-2').getByText('プロジェクト側で着手します。'),
    ).toBeVisible()
    const collaborationPanel = page.getByTestId('issue-collaboration-panel')
    await collaborationPanel.getByRole('tab', { name: '活動' }).click()
    await expect(collaborationPanel.getByRole('tabpanel', { name: '活動' })).toContainText(
      'Demo User がコメントしました。',
    )
    expect(requestCounts.issueComments).toBe(1)

    await page.goto('/projects/refero/issues?teamId=core-team')

    await expect(page.getByTestId('task-row-割当待ち-issue')).toContainText('割当待ち Issue')
  })

  test('Team Issue の単一期限 editor は range schedule を暗黙に変更しない', async ({ page }) => {
    const rangedIssue = createStoredTeamIssue({
      dueDate: '2026-08-07',
      id: 'ranged-team-issue',
      schedule: {
        calendarPolicy: DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY,
        durationDays: 5,
        endDate: '2026-08-07',
        mode: 'date-range',
        startDate: '2026-08-03',
      },
      title: 'Range schedule を維持する Issue',
    })
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      teamIssuesByTeam: { 'core-team': [rangedIssue] },
    })
    await page.goto('/teams/core-team/issues')
    const requestCounts = getMockRequestCounts(page)

    await page.getByTestId('issue-row-ranged-team-issue').click()
    const detailPane = page.locator('aside')
    const scheduleOutput = detailPane.locator('output')

    await expect(scheduleOutput).toContainText('期間: 2026-08-03 – 2026-08-07')
    await detailPane.locator('input[name="title"]').fill('Range schedule を維持した Issue')
    await detailPane.getByRole('button', { name: '変更を保存' }).click()

    await expect.poll(() => requestCounts.issueUpdates).toBe(1)
    await expect(scheduleOutput).toContainText('期間: 2026-08-03 – 2026-08-07')
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

    await page.getByTestId('task-open-detail-file-scope-second').click()
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
    await expect(page.getByTestId('my-tasks-column-core-team-default-todo')).toContainText('未着手')
    await expect(page.getByTestId('my-tasks-column-core-team-default-in-progress')).toContainText('進行中')
    await expect(page.getByTestId('my-tasks-column-core-team-default-review')).toContainText('レビュー')
    await expect(page.getByTestId('my-tasks-column-core-team-default-done')).toContainText('完了')
    await expect(
      page.getByTestId('my-tasks-column-core-team-default-in-progress').getByTestId('my-tasks-card-refero-wireframe'),
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
      page.getByTestId('my-tasks-column-core-team-default-in-progress').getByTestId('my-tasks-card-refero-wireframe'),
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

    const coreColumn = page.getByTestId('my-tasks-column-core-team-default-todo')
    const designColumn = page.getByTestId('my-tasks-column-design-team-default-todo')

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
    await page.goto('/projects/refero/issues?teamId=core-team')
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

    await page.getByRole('button', { name: 'コアチーム', exact: true }).click()
    await expect(page.getByRole('button', { name: '新規チーム', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    expect(requestCounts.teamCreates).toBe(1)

    await openSidebarCreatePanel(page, 'project')
    await page.getByLabel('プロジェクト名').fill('新規プロジェクト')
    await page.getByRole('button', { name: 'プロジェクトを登録' }).click()

    expect(requestCounts.projectCreates).toBe(1)

    await page.getByRole('button', { name: 'プロジェクト 4', exact: true }).click()
    await page.getByRole('button', { name: '新規プロジェクトを開く' }).click()
    await expect(page).toHaveURL('/projects/new-project/issues?teamId=core-team')
    await page.getByRole('tab', { name: /権限/ }).click()
    await expect(page.getByTestId('permission-member-row-demo-example-com')).toBeVisible()
    await expect(page.getByTestId('permission-role-select-demo-example-com')).toHaveValue('manager')
    await expect(page.getByTestId('permission-role-select-demo-example-com')).toBeDisabled()
    await expect(page.getByTestId('permission-remove-demo-example-com')).toBeDisabled()
  })

  test('ダッシュボードからプロジェクトをアーカイブできる', async ({ page }) => {
    await page.goto('/projects')
    const requestCounts = getMockRequestCounts(page)

    await page.getByRole('button', { name: 'Referoをアーカイブ' }).click()
    await expect(page.getByRole('dialog', { name: 'プロジェクトをアーカイブ' })).toBeVisible()
    expect(requestCounts.projectArchives).toBe(0)

    await page.getByRole('button', { name: 'キャンセル', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Referoを開く' })).toHaveCount(1)

    await page.getByRole('button', { name: 'Referoをアーカイブ' }).click()
    const archiveDialog = page.getByRole('dialog', { name: 'プロジェクトをアーカイブ' })

    await archiveDialog.getByRole('button', { name: 'アーカイブ', exact: true }).click()
    await expect(archiveDialog).toHaveAttribute('aria-busy', 'true')
    await expect(archiveDialog.getByRole('button', { name: 'キャンセル' })).toBeDisabled()

    await expect(page.getByRole('button', { name: 'Referoを開く' })).toHaveCount(0)
    expect(requestCounts.projectArchives).toBe(1)
  })

  test('ダッシュボードからチームをアーカイブできる', async ({ page }) => {
    await page.goto('/dashboard')
    const requestCounts = getMockRequestCounts(page)

    const sidebar = page.locator('aside[aria-label="メインサイドバー"]')
    await expect(sidebar.getByRole('button', { name: '共通ローンチ', exact: true })).toHaveCount(2)

    await page.getByRole('button', { name: 'コアチーム', exact: true }).click()
    await page.getByRole('button', { name: 'デザインチーム', exact: true }).click()
    await page.getByRole('button', { name: 'その他', exact: true }).click()
    await page.getByRole('button', { name: 'デザインチーム をアーカイブ' }).click()
    await page.getByRole('button', { name: 'アーカイブ', exact: true }).click()

    await expect(page.getByRole('button', { name: 'デザインチーム', exact: true })).toHaveCount(0)
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

    // The dashboard portfolio now exposes the same project labels as links to
    // Planning updates. Scope this assertion to the sidebar shortcuts so the
    // test continues to exercise the team-qualified navigation target.
    const sharedLaunchButtons = page
      .locator('aside[aria-label="メインサイドバー"]')
      .getByRole('button', { name: '共通ローンチ', exact: true })

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
    await expect(
      page.getByRole('button', { exact: true, name: 'タスク詳細: Core ambiguous issue' }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { exact: true, name: 'タスク詳細: Design ambiguous issue' }),
    ).toBeVisible()
    expect(teamScopedIssueRequestPaths).toEqual([])

    await page.getByRole('button', { exact: true, name: 'タスク詳細: Design ambiguous issue' }).click()

    await expect.poll(() => {
      const url = new URL(page.url())
      return {
        issueId: url.searchParams.get('issueId'),
        pathname: url.pathname,
        teamId: url.searchParams.get('teamId'),
      }
    }).toEqual({
      issueId: 'ambiguous-issue',
      pathname: '/projects/shared-launch/issues',
      teamId: 'design-team',
    })
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

    await expect(coreTeamGroup).toBeVisible()
    await expect(page.getByTestId('sidebar-team-design-team')).toHaveCount(0)
    await expect(coreTeamGroup.locator('[aria-current="page"]')).toHaveCount(0)
    await expect(page.getByRole('button', {
      name: 'コアチーム',
      exact: true,
    })).toHaveAttribute('aria-expanded', 'false')
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
    await expect(page.getByTestId('project-task-column-design-team-default-todo')).toContainText(
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

    await expect(page.getByTestId('project-task-column-core-team-default-todo')).toContainText(
      'コアチーム · 未着手',
    )
    const emptyDesignColumn = page.getByTestId('project-task-column-design-team-default-todo')

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
    await expect(page.getByTestId('sidebar-team-core-team')).toHaveCount(0)
    await expect(page.getByTestId('sidebar-team-design-team').first()).toBeVisible()
    await expect(page.getByRole('button', {
      name: 'デザインチーム',
      exact: true,
    })).toHaveAttribute('aria-expanded', 'false')
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
    await expect(page.getByTestId('project-task-column-core-team-default-core-active')).toContainText(
      'Core configured',
    )
    await expect(page.getByTestId('project-task-column-design-team-default-design-active')).toContainText(
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

  test('Workspace 直下ルート間の遷移でサイドバーの折りたたみ状態を保持する', async ({ page }) => {
    await page.goto('/home')
    const homeSidebar = await expectWorkspaceRouteShell(page, 'ホーム')

    await homeSidebar.getByRole('button', { name: 'サイドバーを折りたたむ' }).click()
    await expect(homeSidebar).toHaveAttribute('data-collapsed', 'true')

    await homeSidebar.getByRole('button', { name: 'マイタスク', exact: true }).click()
    await expect(page).toHaveURL('/my-tasks')

    const myTasksSidebar = await expectWorkspaceRouteShell(page, 'マイタスク')

    await expect(myTasksSidebar).toHaveAttribute('data-collapsed', 'true')
    await myTasksSidebar.getByRole('button', { name: 'サイドバーを展開する' }).click()
    await expect(myTasksSidebar).toHaveAttribute('data-collapsed', 'false')
    await expect(myTasksSidebar.getByRole('button', {
      name: 'コアチーム',
      exact: true,
    })).toBeVisible()
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

  test('Issue #192 の共同作業タブで判断のページング、採用解決策、利用不能な情報源を操作できる', async ({ page }) => {
    const contextItems = [
      {
        schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
        id: 'context-current',
        teamId: 'core-team',
        workItemId: 'wireframe',
        kind: 'decision',
        state: 'accepted',
        title: 'モバイルでは操作を固定フッターへ置く',
        body: '主要操作は狭い詳細ペインでも常に見える位置へ置きます。',
        source: {
          kind: 'comment',
          sourceId: 'reply-1',
          containerId: 'root-1',
          originalBody: '固定フッターなら狭い画面でも操作を見失いません。',
          quote: { text: '狭い画面でも操作を見失いません' },
          permalink: '?commentId=reply-1&rootCommentId=root-1',
          actor: { id: 'sato@example.com', displayName: '佐藤 花子' },
          occurredAt: '2026-08-09T01:10:00.000Z',
          capturedRevision: 1,
          currentRevision: 1,
          availability: 'available',
        },
        mentionMemberKeys: [],
        createdBy: { id: 'demo@example.com', displayName: 'Demo User' },
        createdAt: '2026-08-09T01:20:00.000Z',
        updatedBy: { id: 'demo@example.com', displayName: 'Demo User' },
        updatedAt: '2026-08-09T01:20:00.000Z',
        revision: 1,
      },
      {
        schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
        id: 'context-unavailable',
        teamId: 'core-team',
        workItemId: 'wireframe',
        kind: 'risk',
        state: 'active',
        title: '顧客チャットのアクセス権が失われた',
        body: '出典の状態を明示し、現在参照できない内容へ誘導しません。',
        source: {
          kind: 'external-chat',
          sourceId: 'external-message-42',
          containerId: 'customer-channel',
          originalBody: 'E2E_SECRET_ORIGINAL',
          quote: { text: 'E2E_SECRET_QUOTE' },
          permalink: 'https://example.invalid/sensitive-message-42',
          actor: {
            id: 'external-participant',
            displayName: 'Research participant',
          },
          occurredAt: '2026-08-08T04:00:00.000Z',
          capturedRevision: '1717556400.000100',
          availability: 'permission-lost',
          availabilityReason: '接続済みアカウントの権限が失われました。',
        },
        mentionMemberKeys: [],
        createdBy: { id: 'demo@example.com', displayName: 'Demo User' },
        createdAt: '2026-08-08T05:00:00.000Z',
        updatedBy: { id: 'demo@example.com', displayName: 'Demo User' },
        updatedAt: '2026-08-08T05:00:00.000Z',
        revision: 1,
      },
    ] satisfies CuratedContextItem[]
    let acceptedSummary: string | undefined
    let threadResolved = false
    let requestedSecondContextPage = false

    await page.route(
      /.*\/api\/teams\/core-team\/issues\/wireframe\/collaboration(?:\?.*)?$/,
      async (route) => {
        await route.fulfill({
          json: {
            comments: [
              {
                id: 'root-1',
                rootCommentId: 'root-1',
                authorMemberKey: 'demo@example.com',
                bodyMarkdown: '狭い詳細ペインの操作位置を決めます。',
                version: threadResolved ? 3 : acceptedSummary ? 2 : 1,
                createdAt: '2026-08-09T01:00:00.000Z',
                updatedAt: '2026-08-09T01:00:00.000Z',
                resolvedAt: threadResolved
                  ? '2026-08-09T01:30:00.000Z'
                  : undefined,
                resolvedByMemberKey: threadResolved
                  ? 'demo@example.com'
                  : undefined,
                acceptedResolutions: acceptedSummary
                  ? [
                      {
                        id: 'resolution-current',
                        sourceCommentId: 'reply-1',
                        sourceRootCommentId: 'root-1',
                        capturedCommentRevision: 1,
                        capturedCommentBody:
                          '固定フッターなら狭い画面でも操作を見失いません。',
                        summary: acceptedSummary,
                        acceptedBy: {
                          id: 'demo@example.com',
                          displayName: 'Demo User',
                        },
                        acceptedAt: '2026-08-09T01:30:00.000Z',
                        state: 'accepted',
                      },
                    ]
                  : [],
                mentionMemberKeys: [],
                reactions: [],
                capabilities: {
                  canEdit: true,
                  canDelete: true,
                  canResolve: true,
                },
              },
              {
                id: 'reply-1',
                rootCommentId: 'root-1',
                parentCommentId: 'root-1',
                authorMemberKey: 'sato@example.com',
                bodyMarkdown:
                  '固定フッターなら狭い画面でも操作を見失いません。',
                version: 1,
                createdAt: '2026-08-09T01:10:00.000Z',
                updatedAt: '2026-08-09T01:10:00.000Z',
                mentionMemberKeys: [],
                reactions: [],
                capabilities: {
                  canEdit: false,
                  canDelete: false,
                  canResolve: false,
                },
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
            capabilities: {
              canComment: true,
              canReact: true,
              canWatch: true,
            },
          },
        })
      },
    )
    await page.route(
      /.*\/api\/teams\/core-team\/issues\/wireframe\/context-items(?:\?.*)?$/,
      async (route) => {
        if (route.request().method() !== 'GET') {
          await route.fallback()
          return
        }

        const cursor = new URL(route.request().url()).searchParams.get('cursor')
        requestedSecondContextPage ||= cursor === 'context-page-2'
        await route.fulfill({
          json: {
            schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
            items: cursor === 'context-page-2'
              ? [contextItems[1]]
              : [contextItems[0]],
            nextCursor: cursor ? undefined : 'context-page-2',
            capabilities: {
              canCreate: true,
              canEdit: true,
              canReplace: true,
              canAcceptResolution: true,
            },
          },
        })
      },
    )
    await page.route(
      /.*\/api\/teams\/core-team\/issues\/wireframe\/comments\/root-1\/accepted-resolution$/,
      async (route) => {
        expect(route.request().method()).toBe('PUT')
        const body: unknown = route.request().postDataJSON()

        expect(body).toEqual({
          commentId: 'reply-1',
          expectedThreadVersion: 1,
          summary: '固定フッターを採用し、両方の viewport で確認する。',
        })
        if (
          typeof body === 'object' &&
          body !== null &&
          'summary' in body &&
          typeof body.summary === 'string'
        ) {
          acceptedSummary = body.summary
        }
        await route.fulfill({ json: {} })
      },
    )
    await page.route(
      /.*\/api\/teams\/core-team\/issues\/wireframe\/comments\/root-1\/resolve$/,
      async (route) => {
        expect(route.request().method()).toBe('POST')
        expect(route.request().postDataJSON()).toEqual({ expectedVersion: 2 })
        threadResolved = true
        await route.fulfill({ json: {} })
      },
    )
    await page.route(/.*\/api\/document-backlinks(?:\?.*)?$/, async (route) => {
      await route.fulfill({
        json: {
          backlinks: [
            {
              documentId: 'document-onboarding-research',
              documentTitle: 'オンボーディング調査',
              relation: {
                id: 'relation-wireframe-research',
                source: { kind: 'document' },
                target: { kind: 'work-item', workItemId: 'wireframe' },
                createdByUserId: 'demo@example.com',
                createdAt: '2026-08-09T00:30:00.000Z',
              },
            },
          ],
        },
      })
    })
    await page.route(
      /.*\/api\/documents\/document-onboarding-research$/,
      async (route) => {
        await route.fulfill({
          json: {
            document: {
              id: 'document-onboarding-research',
              title: 'オンボーディング調査',
              kind: 'page',
              revision: 7,
              createdAt: '2026-08-09T00:20:00.000Z',
              blocks: [
                {
                  id: 'research-summary',
                  type: 'paragraph',
                  text: '初回利用者は次に何をすべきかを最初の画面で判断できる必要があります。',
                },
              ],
            },
          },
        })
      },
    )

    await page.goto('/projects/refero/issues?teamId=core-team&issueId=wireframe')
    const panel = page.getByTestId('issue-collaboration-panel')
    const conversationTab = panel.getByRole('tab', { name: /会話/ })
    const briefTab = panel.getByRole('tab', { name: /Brief/ })
    const decisionsTab = panel.getByRole('tab', { name: /判断/ })
    const sourcesTab = panel.getByRole('tab', { name: /情報源/ })
    const collaborationTablist = panel.getByRole('tablist', {
      name: '共同作業のセクション',
    })

    await expect(conversationTab).toHaveAttribute('aria-selected', 'true')
    await expect(
      collaborationTablist.getByRole('tab', { name: '会話 1' }),
    ).toHaveAttribute('aria-selected', 'true')
    await expect(
      collaborationTablist.getByRole('tab', { name: '判断 1' }),
    ).toBeVisible()
    const collaborationPanelId = await conversationTab.getAttribute(
      'aria-controls',
    )
    if (!collaborationPanelId) {
      throw new Error('Conversation tab did not expose its collaboration panel ID.')
    }
    await expect(panel.getByRole('tabpanel')).toHaveAttribute(
      'id',
      collaborationPanelId,
    )
    await conversationTab.focus()
    await page.keyboard.press('ArrowRight')
    if (await briefTab.count()) {
      await expect(briefTab).toBeFocused()
      await page.keyboard.press('ArrowRight')
    }
    await expect(decisionsTab).toBeFocused()
    await expect(decisionsTab).toHaveAttribute('aria-selected', 'true')
    await expect(panel.getByText('モバイルでは操作を固定フッターへ置く')).toBeVisible()
    await expect(panel.getByText('顧客チャットのアクセス権が失われた')).toHaveCount(0)

    await panel.getByRole('button', { name: '過去の判断を読み込む' }).click()
    await expect(panel.getByText('顧客チャットのアクセス権が失われた')).toBeVisible()
    expect(requestedSecondContextPage).toBe(true)

    await decisionsTab.press('End')
    await expect(sourcesTab).toBeFocused()
    await expect(sourcesTab).toHaveAttribute('aria-selected', 'true')
    await expect(
      panel.getByRole('status').getByText('アクセス権を喪失'),
    ).toBeVisible()
    await expect(panel.getByText('この外部メッセージを表示する権限がありません。')).toBeVisible()
    await expect(panel.getByText('E2E_SECRET_QUOTE')).toHaveCount(0)
    await expect(panel.getByText('E2E_SECRET_ORIGINAL')).toHaveCount(0)
    await expect(
      panel.locator('a[href="https://example.invalid/sensitive-message-42"]'),
    ).toHaveCount(0)

    await sourcesTab.press('Home')
    await expect(conversationTab).toBeFocused()
    const acceptResolution = panel.getByRole('button', {
      name: '解決策として採用',
    })

    await expect(acceptResolution).toHaveCount(1)
    await acceptResolution.click()
    let summary = panel.getByRole('textbox', { name: '手動の解決要約' })
    await expect(summary).toBeFocused()
    await panel.getByRole('button', { name: 'キャンセル' }).click()
    await expect(acceptResolution).toBeFocused()
    await acceptResolution.click()
    summary = panel.getByRole('textbox', { name: '手動の解決要約' })
    const saveResolution = panel.getByRole('button', { name: '解決策を保存' })

    await expect(saveResolution).toBeDisabled()
    await summary.fill('固定フッターを採用し、両方の viewport で確認する。')
    await saveResolution.click()
    await expect(panel.getByTestId('accepted-resolution-summary')).toContainText(
      '固定フッターを採用し、両方の viewport で確認する。',
    )
    await expect(
      panel.getByTestId('accepted-resolution-summary'),
    ).toContainText('採用時の返信 · revision 1')
    await panel
      .getByTestId('comment-thread-root-1')
      .getByRole('button', { name: '解決済みにする' })
      .click()
    await expect(
      panel.getByTestId('comment-thread-root-1').locator('details'),
    ).not.toHaveAttribute('open', '')

    await page.getByTestId(
      'related-document-promote-document-onboarding-research-relation-wireframe-research',
    ).click()
    await expect(decisionsTab).toHaveAttribute('aria-selected', 'true')
    await expect(panel.getByText(/根拠を添付: ドキュメント/)).toBeVisible()
    await expect(
      panel.getByRole('textbox', { name: '短いタイトル' }),
    ).toBeFocused()
    const documentQuote = panel.getByRole('textbox', {
      name: '正確な引用範囲',
    })
    await expect(documentQuote).toHaveValue(
      '初回利用者は次に何をすべきかを最初の画面で判断できる必要があります。',
    )
    await documentQuote.fill('次に何をすべきか')
    await expect(documentQuote).toHaveValue('次に何をすべきか')

    await page.setViewportSize({ width: 390, height: 844 })
    for (const tab of [conversationTab, decisionsTab, sourcesTab]) {
      await expect
        .poll(async () => (await tab.boundingBox())?.height ?? 0)
        .toBeGreaterThanOrEqual(44)
    }
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

  test('Analyticsの非canonical queryは現行URLへ戻して表示を継続する', async ({ page }) => {
    await mockAnalyticsReportsPage(page)

    await page.goto('/reports?tracking=legacy')

    await expect(page.getByRole('heading', { name: 'Delivery health' })).toBeVisible()
    await expect.poll(() => new URL(page.url()).searchParams.get('v')).toBe('1')
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
    await page.goto('/projects/refero/issues')
    const requestCounts = getMockRequestCounts(page)

    await page.getByRole('button', { name: '新規タスク' }).click()
    const createTaskForm = page.getByTestId('create-task-form')
    await createTaskForm.getByRole('button', { name: '詳細登録', exact: true }).click()

    await createTaskForm.locator('input[name="title"]').fill('新規タスク')
    await createTaskForm.locator('select[name="assigneeUserId"]').selectOption('sato@example.com')
    await createTaskForm.locator('select[name="scheduleMode"]').selectOption('due-date')
    await createTaskForm.locator('input[name="scheduleDueDate"]').fill('2026-06-20')
    await createTaskForm.getByRole('button', { name: '登録', exact: true }).click()

    await expect(page.getByTestId('task-row-new-task').getByText('新規タスク')).toBeVisible()
    expect(requestCounts.issueCreates).toBe(1)
  })

  test('作成 API の失敗はフォームを保持し、同じ idempotency key で再試行できる', async ({ page }) => {
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      createIssueFailureCount: 1,
    })
    await page.goto('/projects/refero/issues')
    const requestCounts = getMockRequestCounts(page)
    await page.getByRole('button', { name: '新規タスク' }).click()

    const createTaskForm = page.getByTestId('create-task-form')
    await createTaskForm.locator('input[name="title"]').fill('retryable-create')
    await createTaskForm.getByRole('button', { name: '登録', exact: true }).click()

    await expect(createTaskForm).toContainText('タスク作成に失敗しました。')
    await expect(createTaskForm.locator('input[name="title"]')).toHaveValue('retryable-create')
    await createTaskForm.getByRole('button', { name: '登録', exact: true }).click()

    await expect(page.getByTestId('task-row-retryable-create')).toContainText('retryable-create')
    expect(requestCounts.issueCreates).toBe(2)
    expect(requestCounts.issueCreateIdempotencyKeys[0]).toBeTruthy()
    expect(requestCounts.issueCreateIdempotencyKeys[0]).toBe(
      requestCounts.issueCreateIdempotencyKeys[1],
    )
  })

  test('進行中の古い作成失敗は再表示した作成パネルを変更しない', async ({ page }) => {
    await mockAuthenticatedTaskPage(page)
    let resolveFirstCreateArrival: (() => void) | undefined
    let resolveFirstCreateResponse: (() => void) | undefined
    let resolveSecondCreateArrival: (() => void) | undefined
    let resolveSecondCreateResponse: (() => void) | undefined
    let createRequestNumber = 0
    const firstCreateArrival = new Promise<void>((resolve) => {
      resolveFirstCreateArrival = resolve
    })
    const firstCreateResponse = new Promise<void>((resolve) => {
      resolveFirstCreateResponse = resolve
    })
    const secondCreateArrival = new Promise<void>((resolve) => {
      resolveSecondCreateArrival = resolve
    })
    const secondCreateResponse = new Promise<void>((resolve) => {
      resolveSecondCreateResponse = resolve
    })
    await page.route(/.*\/api\/teams\/core-team\/issues(?:\?.*)?$/, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback()
        return
      }

      const requestNumber = createRequestNumber + 1
      createRequestNumber = requestNumber
      if (requestNumber === 1) {
        resolveFirstCreateArrival?.()
        await firstCreateResponse
      } else if (requestNumber === 2) {
        resolveSecondCreateArrival?.()
        await secondCreateResponse
        await route.fallback()
        return
      } else {
        await route.fallback()
        return
      }

      await route.fulfill({
        status: 500,
        json: { message: '先行する登録に失敗しました。' },
      })
    })
    await page.goto('/projects/refero/issues')
    const requestCounts = getMockRequestCounts(page)
    const firstResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/teams/core-team/issues',
    )
    await page.getByRole('button', { name: '新規タスク' }).click()
    const createTaskForm = page.getByTestId('create-task-form')
    await createTaskForm.locator('input[name="title"]').fill('先行リクエスト')
    await createTaskForm.getByRole('button', { name: '登録', exact: true }).click()
    await firstCreateArrival

    await page.getByRole('button', { name: '新規タスク' }).click()
    await expect(page.getByTestId('create-task-form')).toHaveCount(0)
    await page.getByRole('button', { name: '新規タスク' }).click()
    await page.getByRole('button', { name: '新規タスク' }).click()
    await expect(page.getByTestId('create-task-form')).toHaveCount(0)
    await page.getByRole('button', { name: '新規タスク' }).click()
    const finalForm = page.getByTestId('create-task-form')
    const finalTitle = finalForm.locator('input[name="title"]')
    await expect(finalForm.getByRole('button', { name: '登録中', exact: true })).toBeDisabled()
    await expect(finalTitle).toBeDisabled()
    await finalForm.evaluate((form) => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(createRequestNumber).toBe(1)

    resolveFirstCreateResponse?.()
    const completedFirstResponse = await firstResponse
    await completedFirstResponse.finished()
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))

    await expect(finalTitle).toHaveValue('')
    await expect(finalForm.getByRole('alert')).toHaveCount(0)
    await expect(finalForm.getByRole('button', { name: '登録', exact: true })).toBeEnabled()
    await expect(finalTitle).toBeEnabled()

    await finalTitle.fill('replacement-create')
    await finalForm.getByRole('button', { name: '登録', exact: true }).click()
    await secondCreateArrival
    resolveSecondCreateResponse?.()
    await expect(page).toHaveURL(/issueId=/)
    expect(createRequestNumber).toBe(2)
    expect(requestCounts.issueCreates).toBe(1)
  })

  test('作成 POST 成功後の一覧再取得失敗でも作成を重複実行せず詳細へ遷移する', async ({ page }) => {
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      postCreateProjectIssueFailureCount: 1,
    })
    await page.goto('/projects/refero/issues')
    const requestCounts = getMockRequestCounts(page)
    await page.getByRole('button', { name: '新規タスク' }).click()

    const createTaskForm = page.getByTestId('create-task-form')
    await createTaskForm.locator('input[name="title"]').fill('refresh-failure-single-create')
    await createTaskForm.getByRole('button', { name: '登録', exact: true }).click()

    await expect(page).toHaveURL(/issueId=refresh-failure-single-create/)
    const taskDetailPane = page.getByTestId('task-detail-pane')
    await expect(taskDetailPane.getByRole('heading', {
      name: 'refresh-failure-single-create',
    })).toBeVisible()
    await expect(taskDetailPane.getByRole('textbox', { name: 'Issue' })).toHaveValue(
      'refresh-failure-single-create',
    )
    const taskRefreshError = page.getByTestId('tasks-error')
    await expect(taskRefreshError).toContainText('タスク一覧を取得できませんでした')
    await expect(taskRefreshError.getByRole('alert')).toHaveCount(1)
    await page.getByTestId('project-task-error').getByRole('button', { name: '再読み込み', exact: true }).click()
    await expect.poll(() => requestCounts.projectIssues.refero ?? 0).toBe(3)
    await expect(taskRefreshError).toHaveCount(0)
    await expect(page.getByTestId('task-row-refresh-failure-single-create')).toContainText(
      'refresh-failure-single-create',
    )
    expect(requestCounts.issueCreates).toBe(1)
  })

  test('作成後一覧取得の認証失効はログインへ遷移し、作成を重複実行しない', async ({ page }) => {
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      postCreateProjectIssueFailureCount: 1,
      postCreateProjectIssueFailureStatus: 401,
      postCreateProjectIssueFailureCode: 'EnterpriseSessionExpired',
    })
    await page.goto('/projects/refero/issues')
    const requestCounts = getMockRequestCounts(page)
    await page.getByRole('button', { name: '新規タスク' }).click()

    const createTaskForm = page.getByTestId('create-task-form')
    await createTaskForm.locator('input[name="title"]').fill('refresh-auth-expired')
    const refreshResponse = page.waitForResponse((response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === '/api/projects/refero/issues' &&
      response.status() === 401,
    )
    await createTaskForm.getByRole('button', { name: '登録', exact: true }).click()

    await refreshResponse
    await expect(page).toHaveURL(/\/login\?returnTo=/)
    expect(new URL(page.url()).searchParams.get('returnTo')).toBe(
      '/projects/refero/issues?issueId=refresh-auth-expired&teamId=core-team',
    )
    expect(requestCounts.issueCreates).toBe(1)
  })

  test('タスク本文をスクロール後に新規タスクを開いても作成パネルを表示する', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 520 })
    await page.goto('/projects/refero/issues')

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
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      currentUser: {
        username: 'viewer-not-member@example.com',
        name: 'Viewer Not Member',
        isSystemAdmin: true,
        workspaceRole: 'owner',
      },
    })
    await page.goto('/projects/refero/issues')
    const requestCounts = getMockRequestCounts(page)

    await page.getByRole('button', { name: '新規タスク' }).click()
    const createTaskForm = page.getByTestId('create-task-form')
    await createTaskForm.getByRole('button', { name: '詳細登録', exact: true }).click()

    await createTaskForm.locator('input[name="title"]').fill('担当者未選択タスク')
    await createTaskForm.locator('select[name="scheduleMode"]').selectOption('due-date')
    await createTaskForm.locator('input[name="scheduleDueDate"]').fill('2026-06-20')
    await createTaskForm.getByRole('button', { name: '登録', exact: true }).click()

    await expect(createTaskForm.locator('select[name="assigneeUserId"]')).toHaveValue('')
    expect(requestCounts.issueCreates).toBe(0)
  })

  test('現在の viewer が候補ならクイック登録の担当者を自分に初期化する', async ({ page }) => {
    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      currentUser: {
        username: 'sato@example.com',
        name: '佐藤 花子',
        isSystemAdmin: true,
        workspaceRole: 'owner',
      },
    })
    await page.goto('/projects/refero/issues')

    await page.getByRole('button', { name: '新規タスク' }).click()
    const createTaskForm = page.getByTestId('create-task-form')
    const assigneeSelect = createTaskForm.locator('select[name="assigneeUserId"]')

    await expect(assigneeSelect).toHaveValue('sato@example.com')
    await expect(assigneeSelect.locator('option:checked')).toContainText('自分')
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

    await page.goto('/projects/refero/issues')
    await page.getByRole('button', { name: '新規タスク' }).click()

    await expect(page.getByText('担当者候補を取得できませんでした')).toBeVisible()
    await expect(page.getByText('担当者にできるプロジェクトメンバーがいません。')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '登録', exact: true })).toBeDisabled()
  })

  test('利用停止中の Workspace member を project と担当者の追加候補から除外する', async ({ page }) => {
    await page.goto('/projects/refero/issues?teamId=core-team')
    await page.getByRole('button', { name: '新規タスク' }).click()

    const assigneeSelect = page.getByTestId('create-task-form').locator('select[name="assigneeUserId"]')

    await expect(assigneeSelect.locator('option[value="inactive@example.com"]')).toHaveCount(0)

    await page.getByRole('tab', { name: /権限/ }).click()
    await expect(page.getByTestId('permission-member-row-inactive-example-com')).toBeVisible()
    await page.getByTestId('permissions-user-search').fill('inactive')
    await expect(page.getByTestId('permissions-user-select').locator('option[value="inactive@example.com"]')).toHaveCount(0)
  })

  test('タスク API 失敗時にエラーを表示する', async ({ page }) => {
    await page.route('**/api/projects/refero/issues**', async (route) => {
      await route.fulfill({
        status: 500,
        json: {
          message: 'Lambda returned 500.',
        },
      })
    })

    await page.goto('/projects/refero/issues')

    await expect(page.getByTestId('tasks-error')).toHaveText(
      'タスク一覧を取得できませんでした: Lambda returned 500.',
    )
  })

  test('タスクが空の場合に empty 表示を出す', async ({ page }) => {
    await page.route('**/api/projects/refero/issues**', async (route) => {
      await route.fulfill({
        json: {
          projectId: 'refero',
          issues: [],
        },
      })
    })

    await page.goto('/projects/refero/issues')

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
    page.getByTestId('my-tasks-column-core-team-default-done').getByTestId('my-tasks-card-refero-billing-copy'),
  ).toBeVisible()

  releaseOnboardingFailure()

  await expect(page.getByTestId('my-tasks-move-error')).toBeVisible()
  await expect(
    page.getByTestId('my-tasks-column-core-team-default-in-progress').getByTestId('my-tasks-card-refero-onboarding-friction'),
  ).toBeVisible()
  await expect(
    page.getByTestId('my-tasks-column-core-team-default-done').getByTestId('my-tasks-card-refero-billing-copy'),
  ).toBeVisible()
  await expect(
    page.getByTestId('my-tasks-column-core-team-default-todo').getByTestId('my-tasks-card-refero-billing-copy'),
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
    page.getByTestId('my-tasks-column-core-team-default-done').getByTestId('my-tasks-card-refero-onboarding-friction'),
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
  expect(getMockRequestCounts(page).projectIssues).toEqual({})
})

test('未認証の場合はログイン画面へ戻す', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('mukuroji.locale', 'ja')
  })

  await page.goto('/projects/refero/issues')

  await expect(page).toHaveURL('/')
  await expect(page.getByRole('heading', { name: 'ログイン' })).toBeVisible()
})
