import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { WORK_ITEM_SCHEMA_VERSION } from '@mukuroji/contracts'
import type { ApprovalRequest, FileAnnotation, FileAttachment, FileVersion } from '@mukuroji/contracts'
import { readFile } from 'node:fs/promises'
import type { TeamIssue, TeamIssueActivity, TeamIssueComment } from '../src/issues/api'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import type { ProjectDirectoryTeam, ProjectMember, ProjectMemberRole, ProjectUser } from '../src/projects/api'
import type { ProjectTask } from '../src/tasks/api'
import type { WorkspaceAccess } from '../src/workspace/api'
import { referoTaskFixtures } from '../src/tasks/fixtures'

const authSession = {
  accessToken: 'test-access-token',
  expiresAt: Date.now() + 60 * 60 * 1000,
  tokenType: 'Bearer',
  remember: true,
}
const workItemConflictMessage =
  '別のメンバーが先に更新しました。最新の内容を確認してから、もう一度保存してください。'

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
}

const mockRequestCountsByPage = new WeakMap<Page, MockRequestCounts>()

/**
 * 認証済みユーザー API を指定したユーザーへ差し替えます。
 *
 * @param page - API route を差し替える Playwright page です。
 * @param username - username と email に使う識別子です。
 * @param name - 画面に表示するユーザー名です。
 */
async function mockCurrentUser(page: Page, username: string, name: string) {
  await page.unroute('**/api/auth/me')
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      json: {
        username,
        attributes: {
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
   * チーム Issue API が初期状態として返す保存済み Issue 一覧です。
   */
  teamIssuesByTeam?: Partial<Record<string, TeamIssue[]>>
  /**
   * 初回更新を revision conflict にする `teamId\0issueId` key の一覧です。
   */
  revisionConflictIssueKeys?: readonly string[]
}

/**
 * 認証済みタスク画面を開くため、localStorage に session を注入し、
 * `/api/auth/me` と `/api/projects/refero/tasks` を stub します。
 */
async function mockAuthenticatedTaskPage(
  page: Page,
  taskResponse = referoTaskFixtures,
  onTaskStatusUpdate?: (
    taskId: string,
    status: ProjectTask['status'],
  ) => Promise<'fail' | undefined> | 'fail' | undefined,
  options: MockAuthenticatedTaskPageOptions = {},
) {
  const requestCounts: MockRequestCounts = {
    projectDirectory: 0,
    projectTasks: {},
    workspaceWorkItems: 0,
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
  }
  const projectDirectory: ProjectDirectoryTeam[] = projectDirectoryFixtures.map((team) => ({
    ...team,
    projects: [...team.projects],
  }))
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
  const issueCommentsByIssue: Record<string, TeamIssueComment[]> = {}
  const issueActivityByIssue: Record<string, TeamIssueActivity[]> = {}
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

    if (route.request().method() === 'POST') {
      requestCounts.taskCreates += 1
      const body = route.request().postDataJSON() as {
        assigneeUserId?: string
        dueDate?: string
        priority?: ProjectTask['priority']
        status?: ProjectTask['status']
        title?: string
      }
      const assigneeUser = projectUsers.find((user) => user.id === body.assigneeUserId)
      const task = {
        schemaVersion: WORK_ITEM_SCHEMA_VERSION,
        revision: 1,
        id: 'new-task',
        teamId: 'core-team',
        assignedProjectId: 'refero',
        title: body.title ?? '新規タスク',
        assigneeUserId: assigneeUser?.id ?? 'sato@example.com',
        assigneeEmail: assigneeUser?.email ?? 'sato@example.com',
        assigneeName: assigneeUser?.name ?? '佐藤 花子',
        status: body.status ?? 'todo',
        dueDate: body.dueDate ?? '2026/06/20',
        priority: body.priority ?? 'medium',
        source: 'legacy',
      } satisfies ProjectTask

      taskResponsesByProject.refero.push(task)

      await route.fulfill({
        status: 201,
        json: {
          task,
        },
      })
      return
    }

    await route.fulfill({
      json: {
        projectId: 'refero',
        tasks: taskResponsesByProject.refero,
      },
    })
  })

  await page.route(/.*\/api\/projects\/refero\/tasks\/[^/]+$/, async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fallback()
      return
    }

    requestCounts.taskStatusUpdates += 1
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    const taskId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[5] ?? '')
    const body = route.request().postDataJSON() as { status?: ProjectTask['status'] }
    const status = body.status ?? 'todo'
    const task = taskResponsesByProject.refero.find((candidate) => candidate.id === taskId)
    const updateResult = await onTaskStatusUpdate?.(taskId, status)

    if (updateResult === 'fail') {
      await route.fulfill({
        status: 500,
        json: {
          message: 'tasks.error.loading',
        },
      })
      return
    }

    if (!task) {
      await route.fulfill({
        status: 404,
        json: {
          message: 'Task was not found.',
        },
      })
      return
    }

    task.status = status

    await route.fulfill({
      json: {
        task,
      },
    })
  })

  await page.route(/.*\/api\/projects\/[^/]+\/issues$/, async (route) => {
    const pathSegments = new URL(route.request().url()).pathname.split('/')
    const projectId = decodeURIComponent(pathSegments[3] ?? '')
    recordProjectTaskRequest(requestCounts, projectId)

    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    const legacyIssues = (taskResponsesByProject[projectId] ?? []).map((task) =>
      toIssueFromTask(task, 'core-team', projectId),
    )
    const assignedIssues = Object.values(teamIssuesByTeam)
      .flat()
      .filter((issue) => issue.assignedProjectId === projectId)

    await route.fulfill({
      json: {
        projectId,
        issues: [...legacyIssues, ...assignedIssues],
      },
    })
  })

  await page.route('**/api/work-items', async (route) => {
    requestCounts.workspaceWorkItems += 1
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    const legacyWorkItems = Object.entries(taskResponsesByProject).flatMap(
      ([projectId, projectTasks]) => projectTasks.map((task) =>
        toIssueFromTask(task, task.teamId, projectId),
      ),
    )

    await route.fulfill({
      json: {
        workItems: [...legacyWorkItems, ...Object.values(teamIssuesByTeam).flat()],
      },
    })
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
        description?: string
        dueDate?: string
        priority?: TeamIssue['priority']
        status?: TeamIssue['status']
        title?: string
      }
      const assigneeUser = projectUsers.find((user) => user.id === body.assigneeUserId)
      const issue = {
        schemaVersion: WORK_ITEM_SCHEMA_VERSION,
        revision: 1,
        id: body.title === '新規タスク' ? 'new-task' : createIssueId(body.title ?? '新規 Issue'),
        teamId,
        assignedProjectId: body.assignedProjectId || undefined,
        title: body.title ?? '新規 Issue',
        description: body.description,
        assigneeUserId: assigneeUser?.id ?? 'sato@example.com',
        assigneeEmail: assigneeUser?.email ?? 'sato@example.com',
        assigneeName: assigneeUser?.name ?? '佐藤 花子',
        status: body.status ?? 'todo',
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
    const legacyIssues = projects.flatMap((project) =>
      (taskResponsesByProject[project.id] ?? []).map((task) =>
        toIssueFromTask(task, teamId, project.id),
      ),
    )

    await route.fulfill({
      json: {
        teamId,
        issues: [...legacyIssues, ...(teamIssuesByTeam[teamId] ?? [])],
      },
    })
  })

  await page.route(/.*\/api\/teams\/[^/]+\/issues\/[^/]+$/, async (route) => {
    const pathSegments = new URL(route.request().url()).pathname.split('/')
    const teamId = decodeURIComponent(pathSegments[3] ?? '')
    const issueId = decodeURIComponent(pathSegments[5] ?? '')
    const issue = findTeamIssue(teamIssuesByTeam, taskResponsesByProject, projectDirectory, teamId, issueId)

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
      if (issue.source === 'legacy') {
        await route.fulfill({
          status: 409,
          json: {
            message: 'Legacy task issues are read-only.',
          },
        })
        return
      }

      const body = route.request().postDataJSON() as Partial<TeamIssue> & {
        assignedProjectId?: string | null
        expectedRevision?: number
      }
      const { expectedRevision, ...patch } = body

      expect(expectedRevision).toBe(issue.revision)
      const conflictIssueKey = createIssueCollaborationKey(teamId, issueId)

      if (pendingRevisionConflictIssueKeys.delete(conflictIssueKey)) {
        replaceStoredTeamIssue(teamIssuesByTeam, teamId, {
          ...issue,
          description: '別のメンバーが更新した最新内容です。',
          revision: issue.revision + 1,
          status: 'review',
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

      const updateResult = body.status
        ? await onTaskStatusUpdate?.(issueId, body.status)
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

      const updatedIssue = {
        ...issue,
        ...patch,
        assignedProjectId: body.assignedProjectId === null
          ? undefined
          : body.assignedProjectId ?? issue.assignedProjectId,
        revision: issue.revision + 1,
        updatedAt: '2026-06-08T02:00:00.000Z',
      } satisfies TeamIssue
      replaceStoredTeamIssue(teamIssuesByTeam, teamId, updatedIssue)

      await route.fulfill({
        json: {
          issue: updatedIssue,
        },
      })
      return
    }

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
      },
    })
  })

  await page.route(/.*\/api\/teams\/[^/]+\/issues\/[^/]+\/files$/, async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        approvals: [],
        capabilities: { canRequestApproval: true, canUpload: true },
        files: [],
      },
    })
  })

  await page.route(/.*\/api\/teams\/[^/]+\/projects\/[^/]+\/files$/, async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        approvals: [],
        capabilities: { canRequestApproval: false, canUpload: true },
        files: [],
      },
    })
  })

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
        tasks: taskResponsesByProject['product-roadmap'],
      },
    })
  })

  await page.route('**/api/projects/brand-refresh/tasks', async (route) => {
    recordProjectTaskRequest(requestCounts, 'brand-refresh')

    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    await route.fulfill({
      json: {
        projectId: 'brand-refresh',
        tasks: taskResponsesByProject['brand-refresh'],
      },
    })
  })

  await page.route('**/api/projects/shared-launch/tasks', async (route) => {
    recordProjectTaskRequest(requestCounts, 'shared-launch')

    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    await route.fulfill({
      json: {
        projectId: 'shared-launch',
        tasks: taskResponsesByProject['shared-launch'],
      },
    })
  })

  await page.route('**/api/projects/new-project/tasks', async (route) => {
    recordProjectTaskRequest(requestCounts, 'new-project')

    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    await route.fulfill({
      json: {
        projectId: 'new-project',
        tasks: taskResponsesByProject['new-project'] ?? [],
      },
    })
  })

  await page.route('**/api/dashboard/summary', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    await route.fulfill({
      json: {
        projects: 3,
        tasks: 18,
        blocked: 2,
        updatedAt: '2026-05-31T00:00:00.000Z',
        source: 'dynamodb',
      },
    })
  })
}

function getMockRequestCounts(page: Page) {
  const requestCounts = mockRequestCountsByPage.get(page)

  if (!requestCounts) {
    throw new Error('mockAuthenticatedTaskPage must run before reading request counts.')
  }

  return requestCounts
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

function resolveLegacyTaskAssignee(task: ProjectTask) {
  const assigneeByKey = {
    'tasks.assignee.sato': {
      id: 'sato@example.com',
      email: 'sato@example.com',
      name: '佐藤 花子',
    },
    'tasks.assignee.suzuki': {
      id: 'suzuki@example.com',
      email: 'suzuki@example.com',
      name: '鈴木 大輔',
    },
    'tasks.assignee.tanaka': {
      id: 'tanaka@example.com',
      email: 'tanaka@example.com',
      name: '田中 美咲',
    },
    'tasks.assignee.yamamoto': {
      id: 'yamamoto@example.com',
      email: 'yamamoto@example.com',
      name: '山本 健太',
    },
  } as const

  return task.assigneeKey && task.assigneeKey in assigneeByKey
    ? assigneeByKey[task.assigneeKey as keyof typeof assigneeByKey]
    : {
        id: task.assigneeUserId ?? task.assignee ?? 'sato@example.com',
        email: task.assigneeEmail,
        name: task.assigneeName,
      }
}

function toIssueFromTask(task: ProjectTask, teamId: string, assignedProjectId: string): TeamIssue {
  const assignee = resolveLegacyTaskAssignee(task)

  return {
    schemaVersion: task.schemaVersion,
    revision: task.revision,
    id: task.id,
    teamId,
    assignedProjectId,
    titleKey: task.titleKey,
    title: task.title,
    assigneeUserId: assignee.id,
    assigneeEmail: assignee.email,
    assigneeName: assignee.name,
    status: task.status,
    dueDate: task.dueDate,
    priority: task.priority,
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
    source: 'legacy',
  }
}

function createStoredTeamIssue(overrides: Partial<TeamIssue> & Pick<TeamIssue, 'id' | 'status' | 'title'>): TeamIssue {
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    teamId: 'core-team',
    assignedProjectId: 'refero',
    description: 'My Tasks の移動操作を検証する Issue です。',
    assigneeUserId: 'sato@example.com',
    assigneeEmail: 'sato@example.com',
    assigneeName: '佐藤 花子',
    dueDate: '2026/06/22',
    priority: 'medium',
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
    source: 'dynamodb',
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
  taskResponsesByProject: Record<string, ProjectTask[]>,
  projectDirectory: ProjectDirectoryTeam[],
  teamId: string,
  issueId: string,
) {
  const issue = teamIssuesByTeam[teamId]?.find((candidate) => candidate.id === issueId)

  if (issue) {
    return issue
  }

  const team = projectDirectory.find((candidate) => candidate.id === teamId)

  for (const project of team?.projects ?? []) {
    const task = taskResponsesByProject[project.id]?.find((candidate) => candidate.id === issueId)

    if (task) {
      return toIssueFromTask(task, teamId, project.id)
    }
  }

  return undefined
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
    const detailControls = Array.from(detailPane.querySelectorAll('input, select, textarea, button'))
    const formOverflows = formControls.flatMap((element) => {
      const rect = element.getBoundingClientRect()

      return rect.right > detailRect.left + 1
        ? [`${element.tagName.toLowerCase()} ${Math.round(rect.right)} > ${Math.round(detailRect.left)}`]
        : []
    })
    const detailOverflows = detailControls.flatMap((element) => {
      const rect = element.getBoundingClientRect()

      return rect.left < detailRect.left - 1 || rect.right > detailRect.right + 1
        ? [`${element.tagName.toLowerCase()} ${Math.round(rect.left)}-${Math.round(rect.right)} outside ${Math.round(detailRect.left)}-${Math.round(detailRect.right)}`]
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
    const detailControls = Array.from(detailPane.querySelectorAll('input, select, textarea, button'))
    const formOverflows = formControls.flatMap((element) => {
      const rect = element.getBoundingClientRect()

      return rect.right > detailRect.left + 1 && detailRect.top < rect.bottom && rect.top < detailRect.bottom
        ? [`${element.tagName.toLowerCase()} ${Math.round(rect.right)} > ${Math.round(detailRect.left)}`]
        : []
    })
    const detailOverflows = detailControls.flatMap((element) => {
      const rect = element.getBoundingClientRect()

      return rect.left < detailRect.left - 1 || rect.right > detailRect.right + 1
        ? [`${element.tagName.toLowerCase()} ${Math.round(rect.left)}-${Math.round(rect.right)} outside ${Math.round(detailRect.left)}-${Math.round(detailRect.right)}`]
        : []
    })

    return { detailOverflows, formOverflows }
  })

  expect(result.formOverflows).toEqual([])
  expect(result.detailOverflows).toEqual([])
}

test.describe('authenticated task page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthenticatedTaskPage(page)
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

    await page.getByRole('searchbox', { name: '検索...' }).clear()
    await page.getByRole('button', { name: 'ステータス' }).click()
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
    await expect(page.getByText('ブランドガイドラインの更新')).toBeVisible()
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
            status: 'todo',
          }),
        ],
      },
    })
    await page.goto(`/projects/refero/issues?teamId=core-team&issueId=${issueId}`)
    const requestCounts = getMockRequestCounts(page)
    const detailPane = page.getByTestId('task-detail-pane')

    await expect(detailPane.getByRole('button', { name: '変更を保存' })).toBeEnabled()
    await detailPane.locator('select[name="status"]').selectOption('done')
    await detailPane.getByRole('button', { name: '変更を保存' }).click()

    await expect.poll(() => requestCounts.issueUpdates).toBe(1)
    await expect.poll(() => requestCounts.projectTasks.refero).toBeGreaterThanOrEqual(2)
    await expect(detailPane.locator('select[name="status"]')).toHaveValue('review')
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
            status: 'todo',
          }),
        ],
      },
    })
    await page.goto('/teams/core-team/issues')
    const requestCounts = getMockRequestCounts(page)

    await page.getByTestId(`issue-row-${issueId}`).click()
    const statusSelect = page.locator('aside select[name="status"]')
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

    await expect(page.getByTestId('task-detail-pane')).toContainText('新しいランディングページのワイヤーフレーム作成')
    await expect(page.getByText('旧タスク由来または詳細 API に接続されていない行にはコメントを追加できません。')).toBeVisible()

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
    await page.getByTestId('task-detail-pane').locator('select[name="status"]').selectOption('review')
    await page.getByRole('button', { name: '変更を保存' }).click()
    await expect(page.getByTestId('task-detail-pane').locator('textarea[name="description"]')).toHaveValue('詳細説明を保持します。')

    await page.getByTestId('task-row-seo-research').getByRole('button').click()

    await expect(page).toHaveURL(/issueId=seo-research/)
    await expect(page.getByTestId('task-detail-pane')).toContainText('SEO キーワードリサーチ')
    await expect(page.getByRole('button', { name: '変更を保存' })).toBeDisabled()

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
    await expect(page.getByText('旧タスク由来の Issue は参照専用です。')).toBeVisible()
    await expect(page.getByRole('button', { name: '変更を保存' })).toBeDisabled()
    await expect(page.getByText('旧タスク由来の Issue にはコメントを追加できません。')).toBeVisible()
    await expect(page.getByRole('button', { name: 'コメントを追加' })).toHaveCount(0)
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

    await expect(page.getByText('割当待ち Issue')).toBeVisible()
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
        file.versions = [availableVersion]
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
        requestedByMemberKey: 'demo@example.com',
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
    await page.getByTestId('file-upload-input').setInputFiles({
      buffer: Buffer.from('proof'),
      mimeType: 'image/png',
      name: 'proof.png',
    })

    await expect.poll(() => objectPutCount).toBe(1)
    await expect(page.getByTestId('file-row-file-proof-1')).toContainText('利用可能')
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
    await page.getByRole('button', { name: '位置を指定' }).click()
    await page.getByTestId('file-preview-canvas').click({ position: { x: 180, y: 120 } })
    await page.getByLabel('レビューコメント').fill('CTA の位置を確認してください。')
    await page.getByRole('button', { name: 'Annotation を追加' }).click()
    await expect(page.getByTestId('file-preview-dialog')).toContainText('CTA の位置を確認してください。')
    await page.getByRole('button', { name: 'Preview を閉じる' }).click()

    await page.getByRole('button', { name: '承認を依頼' }).click()
    await page.getByTestId('approval-request-form').getByText('Demo User').click()
    await page.getByTestId('approval-request-form').locator('input[name="dueAt"]').fill('2099-12-31')
    await page.getByRole('button', { name: 'Request を作成' }).click()
    await expect(page.getByTestId('approval-approval-proof-1')).toBeVisible()
    await page.getByTestId('approval-approval-proof-1').getByRole('button', { name: 'Request をキャンセル' }).click()
    await expect(page.getByTestId('approval-approval-proof-1')).toContainText('キャンセル済み')

    await page.getByRole('button', { name: '承認を依頼' }).click()
    await page.getByTestId('approval-request-form').getByText('Demo User').click()
    await page.getByTestId('approval-request-form').locator('input[name="dueAt"]').fill('2099-12-31')
    await page.getByRole('button', { name: 'Request を作成' }).click()
    await expect(page.getByTestId('approval-approval-proof-2')).toBeVisible()
    await page.getByTestId('approval-approval-proof-2').getByRole('button', { name: '承認' }).click()
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
    await expect(page.getByTestId('my-tasks-column-todo')).toContainText('未着手')
    await expect(page.getByTestId('my-tasks-column-in-progress')).toContainText('進行中')
    await expect(page.getByTestId('my-tasks-column-review')).toContainText('レビュー中')
    await expect(page.getByTestId('my-tasks-column-done')).toContainText('完了')
    await expect(
      page.getByTestId('my-tasks-column-in-progress').getByTestId('my-tasks-card-refero-wireframe'),
    ).toBeVisible()
    await expect(
      page.getByTestId('my-tasks-card-refero-seo-research'),
    ).toHaveCount(0)
    await expect(page.getByTestId('my-tasks-card-refero-brand-guideline')).toHaveCount(0)
    await expect(page.getByTestId('my-tasks-card-refero-competitor-report')).toHaveCount(0)

    await expect(
      page.getByTestId('my-tasks-card-refero-brand-guideline-status-select'),
    ).toHaveCount(0)
    const legacyWireframeCard = page.getByTestId('my-tasks-card-refero-wireframe')

    await expect(
      page.getByTestId('my-tasks-card-refero-wireframe-status-select'),
    ).toHaveCount(0)
    await expect(legacyWireframeCard).toHaveAttribute('draggable', 'false')
    await expect(
      page.getByTestId('my-tasks-column-in-progress').getByTestId('my-tasks-card-refero-wireframe'),
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
            status: 'in-progress',
          }),
        ],
        'design-team': [
          createStoredTeamIssue({
            id: 'duplicate-issue',
            title: '重複 Issue',
            description: 'design team detail',
            assignedProjectId: 'shared-launch',
            teamId: 'design-team',
            status: 'review',
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

  test('未割り当て Work Item を My Tasks カードと受信箱の行から Team 詳細へ開ける', async ({ page }) => {
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
            status: 'review',
            title: '未割り当て Work Item',
          }),
        ],
      },
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
    const inboxRow = page.getByTestId(`inbox-task-core-team-unassigned-${issueId}`)

    await expect(inboxRow).toBeEnabled()
    await inboxRow.click()
    await expect(page).toHaveURL(`/teams/core-team/issues?issueId=${issueId}`)
    await expect(page.locator('aside textarea[name="description"]')).toHaveValue(issueDescription)
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
            status: 'review',
            teamId: 'core-team',
          }),
        ],
      },
    })

    await page.goto('/teams/design-team/overview')

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

  test('受信箱で実タスクを要確認理由と検索語から絞り込める', async ({ page }) => {
    await page.goto('/inbox')

    await expect(page.getByTestId('inbox-workbench')).toBeVisible()
    await expect(page.getByTestId('inbox-task-core-team-refero-wireframe')).toBeVisible()
    await expect(page.getByTestId('inbox-task-core-team-refero-brand-guideline')).toBeVisible()

    await page.getByTestId('inbox-filter-review').click()

    await expect(page.getByTestId('inbox-filter-review')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('inbox-task-core-team-refero-brand-guideline')).toBeVisible()
    await expect(page.getByTestId('inbox-task-core-team-refero-wireframe')).toHaveCount(0)

    await page.getByTestId('inbox-search').fill('存在しないタスク')
    await expect(page.getByText('条件に合う対応事項はありません', { exact: true })).toBeVisible()

    await page.getByTestId('inbox-search').clear()
    await page.getByTestId('inbox-filter-high').click()
    await expect(page.getByTestId('inbox-task-core-team-refero-wireframe')).toBeVisible()
    await expect(page.getByTestId('inbox-task-core-team-refero-brand-guideline')).toHaveCount(0)
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
            status: 'in-progress',
          }),
        ],
        'design-team': [
          createStoredTeamIssue({
            id: 'duplicate-issue',
            title: '重複 Issue',
            assignedProjectId: 'shared-launch',
            teamId: 'design-team',
            status: 'review',
          }),
        ],
      },
    })

    await page.goto('/inbox')

    const coreTeamRow = page.getByTestId('inbox-task-core-team-shared-launch-duplicate-issue')
    const designTeamRow = page.getByTestId('inbox-task-design-team-shared-launch-duplicate-issue')

    await expect(coreTeamRow).toBeVisible()
    await expect(designTeamRow).toBeVisible()

    await page.getByTestId('inbox-filter-mine').click()
    await expect(coreTeamRow).toBeVisible()
    await expect(designTeamRow).toHaveCount(0)

    await page.getByTestId('inbox-filter-all').click()
    await designTeamRow.click()
    await expect(page).toHaveURL(
      '/projects/shared-launch/issues?teamId=design-team&issueId=duplicate-issue',
    )
  })

  test('approval summary を受信箱の要確認理由とレポート集計へ反映する', async ({ page }) => {
    const approvalIssue = createStoredTeamIssue({
      approvalSummary: {
        approvedCount: 0,
        changesRequestedCount: 1,
        nextDueAt: '2026-07-15T14:59:59.000Z',
        overdueCount: 1,
        pendingCount: 2,
        rejectedCount: 0,
      },
      assignedProjectId: 'refero',
      dueDate: '2099/12/31',
      id: 'approval-proof',
      priority: 'low',
      status: 'todo',
      teamId: 'core-team',
      title: '承認待ち成果物',
    })
    const historicalDecisionIssue = createStoredTeamIssue({
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
      status: 'todo',
      teamId: 'core-team',
      title: '過去の承認判断だけがある成果物',
    })

    await mockAuthenticatedTaskPage(page, referoTaskFixtures, undefined, {
      teamIssuesByTeam: { 'core-team': [approvalIssue, historicalDecisionIssue] },
    })

    await page.goto('/inbox')
    const approvalRow = page.getByTestId('inbox-task-core-team-refero-approval-proof')

    await expect(approvalRow).toBeVisible()
    await expect(page.getByTestId('inbox-task-core-team-refero-approval-history-only')).toHaveCount(0)
    await expect(approvalRow).toContainText('Approval 期限超過')
    await page.getByTestId('inbox-filter-approval').click()
    await expect(approvalRow).toBeVisible()

    await page.goto('/reports')
    await expect(page.getByTestId('reports-metric-pending-approvals').locator('p').last()).toHaveText('2')
    await expect(page.getByTestId('reports-metric-overdue-approvals').locator('p').last()).toHaveText('1')
    await expect(page.getByTestId('reports-project-core-team-refero')).toContainText('2')
  })

  test('レポートでプロジェクト健全性を絞り込み CSV 出力できる', async ({ page }) => {
    await page.goto('/reports')

    await expect(page.getByTestId('reports-workbench')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'ステータス構成', exact: true })).toBeVisible()
    await expect(page.getByTestId('reports-project-core-team-refero')).toBeVisible()

    await openSidebarCreatePanel(page)
    await page.getByRole('button', { name: 'プロジェクト', exact: true }).click()
    await page.getByLabel('プロジェクト名').fill('=SUM(1,1)')
    await page.getByRole('button', { name: 'プロジェクトを登録' }).click()

    await expect(page.getByTestId('reports-project-core-team-new-project')).toBeVisible()
    await page.getByTestId('reports-project-search').fill('=SUM')

    await expect(page.getByTestId('reports-project-core-team-new-project')).toBeVisible()
    await expect(page.getByTestId('reports-project-core-team-refero')).toHaveCount(0)

    const downloadPromise = page.waitForEvent('download')
    await page.getByTestId('reports-export-csv').click()
    const download = await downloadPromise
    const downloadPath = await download.path()

    expect(download.suggestedFilename()).toBe('mukuroji-project-snapshot.csv')
    expect(downloadPath).not.toBeNull()
    if (!downloadPath) {
      throw new Error('CSV download path was not available.')
    }

    const csv = await readFile(downloadPath, 'utf8')

    expect(csv).toContain("'=SUM(1,1)")
    expect(csv).not.toContain('Refero')

    await page.getByTestId('reports-project-search').clear()
    await page.getByTestId('reports-attention-only').check()

    await expect(page.getByTestId('reports-project-core-team-refero')).toBeVisible()
    await expect(page.getByTestId('reports-project-core-team-product-roadmap')).toHaveCount(0)
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
          status: 'in-progress',
          priority: 'high',
        }),
        createStoredTeamIssue({
          id: 'billing-copy',
          title: '料金導線の説明不足を解消する',
          status: 'todo',
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
    page.getByTestId('my-tasks-column-done').getByTestId('my-tasks-card-refero-billing-copy'),
  ).toBeVisible()

  releaseOnboardingFailure()

  await expect(page.getByTestId('my-tasks-move-error')).toBeVisible()
  await expect(
    page.getByTestId('my-tasks-column-in-progress').getByTestId('my-tasks-card-refero-onboarding-friction'),
  ).toBeVisible()
  await expect(
    page.getByTestId('my-tasks-column-done').getByTestId('my-tasks-card-refero-billing-copy'),
  ).toBeVisible()
  await expect(
    page.getByTestId('my-tasks-column-todo').getByTestId('my-tasks-card-refero-billing-copy'),
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
          status: 'in-progress',
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
    page.getByTestId('my-tasks-column-done').getByTestId('my-tasks-card-refero-onboarding-friction'),
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
