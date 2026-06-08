import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  type TableDescription,
} from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { Hono } from 'hono'
import { handle } from 'hono/aws-lambda'
import { cors } from 'hono/cors'
import type { Context } from 'hono'

/**
 * Cognito の認証成功時に返る token set です。
 */
type AuthTokenSet = {
  /**
   * API 認証に使う access token です。
   */
  AccessToken?: string
  /**
   * フロントエンドでユーザー識別に使える ID token です。
   */
  IdToken?: string
  /**
   * token 更新に使う refresh token です。
   */
  RefreshToken?: string
  /**
   * token の有効秒数です。
   */
  ExpiresIn?: number
  /**
   * token type です。
   */
  TokenType?: string
}

/**
 * Cognito InitiateAuth のレスポンスです。
 */
type InitiateAuthResponse = {
  /**
   * 認証が完了した場合の token set です。
   */
  AuthenticationResult?: AuthTokenSet
  /**
   * 追加対応が必要な Cognito challenge 名です。
   */
  ChallengeName?: string
  /**
   * challenge 継続用の Cognito session です。
   */
  Session?: string
}

/**
 * Cognito ListUserPools のレスポンスです。
 */
type ListUserPoolsResponse = {
  /**
   * 検索対象リージョンの user pool 一覧です。
   */
  UserPools?: Array<{
    /**
     * Cognito user pool ID です。
     */
    Id?: string
    /**
     * Cognito user pool 名です。
     */
    Name?: string
  }>
}

/**
 * Cognito ListUserPoolClients のレスポンスです。
 */
type ListUserPoolClientsResponse = {
  /**
   * user pool に紐づく app client 一覧です。
   */
  UserPoolClients?: Array<{
    /**
     * Cognito app client ID です。
     */
    ClientId?: string
    /**
     * Cognito app client 名です。
     */
    ClientName?: string
  }>
}

/**
 * Cognito GetUser のレスポンスです。
 */
type GetUserResponse = {
  /**
   * Cognito ユーザー名です。
   */
  Username?: string
  /**
   * Cognito ユーザー属性一覧です。
   */
  UserAttributes?: Array<{
    /**
     * 属性名です。
     */
    Name?: string
    /**
     * 属性値です。
     */
    Value?: string
  }>
}

/**
 * プロジェクトデータへのアクセス範囲を表す認可済み principal です。
 */
type ProjectPrincipal = {
  /**
   * Cognito user から解決した directory partition key です。
   */
  directoryId: string
  /**
   * ログやエラー調査で参照するユーザー識別子です。
   */
  userKey: string
}

/**
 * Cognito JSON API のエラーレスポンスです。
 */
type CognitoErrorPayload = {
  /**
   * Cognito が返すエラー種別です。
   */
  __type?: string
  /**
   * 小文字キーで返るエラーメッセージです。
   */
  message?: string
  /**
   * 大文字キーで返るエラーメッセージです。
   */
  Message?: string
}

/**
 * ログイン API が受け取る request body です。
 */
type LoginRequestBody = {
  /**
   * ユーザーが入力したメールアドレスです。
   */
  email?: unknown
  /**
   * ユーザーが入力したパスワードです。
   */
  password?: unknown
}

/**
 * ダッシュボード集計 API が返す response body です。
 */
type DashboardSummaryResponse = {
  /**
   * 進行中プロジェクト数です。
   */
  projects: number
  /**
   * 未完了タスク数です。
   */
  tasks: number
  /**
   * 要確認タスク数です。
   */
  blocked: number
  /**
   * 集計値を更新した ISO 8601 timestamp です。
   */
  updatedAt: string
  /**
   * 集計値の取得元です。
   */
  source: 'dynamodb'
}

/**
 * タスクの進捗状態を表す API code です。
 */
type ProjectTaskStatus = 'in-progress' | 'review' | 'todo' | 'done'

/**
 * タスクの優先度を表す API code です。
 */
type ProjectTaskPriority = 'high' | 'medium' | 'low'

/**
 * DynamoDB に保存する project task item です。
 */
type ProjectTaskItem = {
  /**
   * ユーザーごとの directory partition key です。
   */
  directoryId: string
  /**
   * タスク一覧 query に使う directory/project 複合 partition key です。
   */
  directoryProjectId: string
  /**
   * プロジェクト ID です。
   */
  projectId: string
  /**
   * タスク ID です。
   */
  taskId: string
  /**
   * プロジェクト内の表示順です。
   */
  sortOrder: number
  /**
   * タスク名を解決する i18n key です。seed 由来のタスクで利用します。
   */
  titleKey?: string
  /**
   * 登録画面から入力されたタスク名です。
   */
  title?: string
  /**
   * 担当者名を解決する i18n key です。seed 由来のタスクで利用します。
   */
  assigneeKey?: string
  /**
   * 登録画面から入力された担当者名です。
   */
  assignee?: string
  /**
   * タスク状態です。
   */
  status: ProjectTaskStatus
  /**
   * 期限日として表示する文字列です。
   */
  dueDate: string
  /**
   * 優先度です。
   */
  priority: ProjectTaskPriority
}

/**
 * プロジェクト画面のテーブルへ表示するタスク行です。
 */
type ProjectTaskResponseItem = {
  /**
   * React の key として使う task ID です。
   */
  id: string
  /**
   * タスク名を解決する i18n key です。
   */
  titleKey?: string
  /**
   * API から返す literal のタスク名です。
   */
  title?: string
  /**
   * 担当者名を解決する i18n key です。
   */
  assigneeKey?: string
  /**
   * API から返す literal の担当者名です。
   */
  assignee?: string
  /**
   * タスク状態です。
   */
  status: ProjectTaskStatus
  /**
   * 期限日として表示する文字列です。
   */
  dueDate: string
  /**
   * 優先度です。
   */
  priority: ProjectTaskPriority
}

/**
 * プロジェクトタスク一覧 API が返す response body です。
 */
type ProjectTasksResponse = {
  /**
   * 取得対象の project ID です。
   */
  projectId: string
  /**
   * DynamoDB から取得したタスク一覧です。
   */
  tasks: ProjectTaskResponseItem[]
}

/**
 * プロジェクトタスク作成 API が受け取る request body です。
 */
type CreateProjectTaskRequestBody = {
  /**
   * ユーザーが入力したタスク名です。
   */
  title?: unknown
  /**
   * ユーザーが入力した担当者名です。
   */
  assignee?: unknown
  /**
   * タスク状態です。
   */
  status?: unknown
  /**
   * 期限日として保存する文字列です。
   */
  dueDate?: unknown
  /**
   * 優先度です。
   */
  priority?: unknown
}

/**
 * プロジェクトタスク作成 API が返す response body です。
 */
type CreateProjectTaskResponse = {
  /**
   * 作成したタスク行です。
   */
  task: ProjectTaskResponseItem
}

/**
 * プロジェクトタスク状態更新 API が受け取る request body です。
 */
type UpdateProjectTaskStatusRequestBody = {
  /**
   * 更新後のタスク状態です。
   */
  status?: unknown
}

/**
 * プロジェクトタスク状態更新 API が返す response body です。
 */
type UpdateProjectTaskStatusResponse = {
  /**
   * 更新したタスク行です。
   */
  task: ProjectTaskResponseItem
}

/**
 * サイドバー上のプロジェクトを識別しやすくする表示色です。
 */
type ProjectTone = 'blue' | 'purple' | 'green' | 'yellow'

/**
 * DynamoDB に保存する team/project directory item です。
 */
type ProjectDirectoryItem = {
  /**
   * ユーザーごとの directory partition key です。
   */
  directoryId: string
  /**
   * チームとプロジェクトを並べ替える sort key です。
   */
  entryKey: string
  /**
   * item 種別です。
   */
  entryType: 'team' | 'project'
  /**
   * 所属チーム ID です。
   */
  teamId: string
  /**
   * チームの表示順です。
   */
  teamSortOrder: number
  /**
   * 日本語表示名です。
   */
  nameJa: string
  /**
   * 英語表示名です。
   */
  nameEn: string
  /**
   * チーム配下を初期展開するかどうかです。
   */
  expanded?: boolean
  /**
   * プロジェクト ID です。
   */
  projectId?: string
  /**
   * チーム内のプロジェクト表示順です。
   */
  projectSortOrder?: number
  /**
   * サイドバー上のプロジェクト表示色です。
   */
  tone?: ProjectTone
  /**
   * アーカイブ済みの場合に設定する ISO 8601 timestamp です。
   */
  archivedAt?: string
}

/**
 * サイドバーに表示するプロジェクト行です。
 */
type ProjectDirectoryProjectResponse = {
  /**
   * タスク一覧の projectId として使う一意な ID です。
   */
  id: string
  /**
   * サイドバーと画面タイトルに表示するプロジェクト名です。
   */
  name: string
  /**
   * サイドバー上のプロジェクトアイコン色です。
   */
  tone?: ProjectTone
}

/**
 * サイドバーに表示するチーム行です。
 */
type ProjectDirectoryTeamResponse = {
  /**
   * チームを識別する一意な ID です。
   */
  id: string
  /**
   * サイドバーに表示するチーム名です。
   */
  name: string
  /**
   * 初期表示時にチーム配下を展開するかどうかです。
   */
  expanded: boolean
  /**
   * チームに紐づくプロジェクト一覧です。
   */
  projects: ProjectDirectoryProjectResponse[]
}

/**
 * チーム/プロジェクト一覧 API が返す response body です。
 */
type ProjectDirectoryResponse = {
  /**
   * DB に登録されているチームとプロジェクトの階層です。
   */
  teams: ProjectDirectoryTeamResponse[]
}

/**
 * チーム作成 API が受け取る request body です。
 */
type CreateTeamRequestBody = {
  /**
   * locale 非依存で扱うチーム名です。
   */
  name?: unknown
  /**
   * 日本語表示名です。
   */
  nameJa?: unknown
  /**
   * 英語表示名です。
   */
  nameEn?: unknown
  /**
   * 初期表示時にチーム配下を展開するかどうかです。
   */
  expanded?: unknown
}

/**
 * チーム作成 API が返す response body です。
 */
type CreateTeamResponse = {
  /**
   * 作成したチーム行です。
   */
  team: ProjectDirectoryTeamResponse
}

/**
 * プロジェクト作成 API が受け取る request body です。
 */
type CreateProjectRequestBody = {
  /**
   * locale 非依存で扱うプロジェクト名です。
   */
  name?: unknown
  /**
   * 日本語表示名です。
   */
  nameJa?: unknown
  /**
   * 英語表示名です。
   */
  nameEn?: unknown
  /**
   * サイドバー上のプロジェクト表示色です。
   */
  tone?: unknown
}

/**
 * プロジェクト作成 API が返す response body です。
 */
type CreateProjectResponse = {
  /**
   * 作成したプロジェクト行です。
   */
  project: ProjectDirectoryProjectResponse
}

/**
 * チームアーカイブ API が返す response body です。
 */
type ArchiveTeamResponse = {
  /**
   * アーカイブしたチーム ID です。
   */
  teamId: string
  /**
   * アーカイブ日時の ISO 8601 timestamp です。
   */
  archivedAt: string
}

/**
 * プロジェクトアーカイブ API が返す response body です。
 */
type ArchiveProjectResponse = {
  /**
   * プロジェクトが所属していたチーム ID です。
   */
  teamId: string
  /**
   * アーカイブしたプロジェクト ID です。
   */
  projectId: string
  /**
   * アーカイブ日時の ISO 8601 timestamp です。
   */
  archivedAt: string
}

/**
 * API handler から利用する Cognito client の最小 interface です。
 */
type CognitoClient = {
  /**
   * メールアドレスとパスワードで Cognito 認証を実行します。
   */
  initiatePasswordAuth(email: string, password: string): Promise<InitiateAuthResponse>
  /**
   * access token から Cognito ユーザー情報を取得します。
   */
  getUser(accessToken: string): Promise<GetUserResponse>
}

/**
 * API handler から利用するダッシュボード集計 client の最小 interface です。
 */
type DashboardSummaryClient = {
  /**
   * ユーザー directory の DynamoDB data からダッシュボード集計値を取得します。
   */
  getSummary(directoryId: string): Promise<DashboardSummaryResponse>
}

/**
 * API handler から利用するプロジェクトタスク client の最小 interface です。
 */
type ProjectTasksClient = {
  /**
   * DynamoDB から指定 project ID のタスク一覧を取得します。
   */
  getProjectTasks(directoryId: string, projectId: string): Promise<ProjectTasksResponse>
  /**
   * DynamoDB に指定 project ID のタスクを作成します。
   */
  createProjectTask(
    directoryId: string,
    projectId: string,
    input: CreateProjectTaskRequestBody,
  ): Promise<CreateProjectTaskResponse>
  /**
   * DynamoDB に保存された指定 task ID の状態を更新します。
   */
  updateProjectTaskStatus(
    directoryId: string,
    projectId: string,
    taskId: string,
    input: UpdateProjectTaskStatusRequestBody,
  ): Promise<UpdateProjectTaskStatusResponse>
}

/**
 * API handler から利用する team/project directory client の最小 interface です。
 */
type ProjectDirectoryClient = {
  /**
   * DynamoDB から sidebar 用の team/project 階層を取得します。
   */
  getProjectDirectory(directoryId: string, locale: Locale): Promise<ProjectDirectoryResponse>
  /**
   * ユーザーの directory に指定 project ID が含まれるかどうかを判定します。
   */
  hasProjectAccess(directoryId: string, projectId: string): Promise<boolean>
  /**
   * DynamoDB にチームを作成します。
   */
  createTeam(directoryId: string, input: CreateTeamRequestBody): Promise<CreateTeamResponse>
  /**
   * DynamoDB に指定チーム配下のプロジェクトを作成します。
   */
  createProject(
    directoryId: string,
    teamId: string,
    input: CreateProjectRequestBody,
  ): Promise<CreateProjectResponse>
  /**
   * DynamoDB 上のチームをアーカイブします。
   */
  archiveTeam(directoryId: string, teamId: string): Promise<ArchiveTeamResponse>
  /**
   * DynamoDB 上のチーム配下プロジェクトをアーカイブします。
   */
  archiveProject(
    directoryId: string,
    teamId: string,
    projectId: string,
  ): Promise<ArchiveProjectResponse>
}

/**
 * チーム/プロジェクト階層の表示 locale です。
 */
type Locale = 'ja' | 'en'

/**
 * Lambda handler、Bun dev server、server test で共有する Hono app です。
 */
export const app = new Hono()
let cognito: CognitoClient
let dashboardSummary: DashboardSummaryClient
let projectTasks: ProjectTasksClient
let projectDirectory: ProjectDirectoryClient
const projectDirectoryIdPrefix = 'user#'

app.use(
  '/api/*',
  cors({
    origin: [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:6006',
      'http://127.0.0.1:6006',
    ],
    allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
  }),
)

app.get('/', (c) => {
  return c.text('mukuroji API')
})

app.get('/api/health', (c) => {
  return c.json({ ok: true })
})

/**
 * メールアドレスとパスワードで Cognito 認証を実行する login endpoint です。
 *
 * @remarks
 * `LoginRequestBody` の `email` は trim し、`email` と `password` の存在を検証します。
 * 成功時は `accessToken`, `idToken`, `refreshToken`, `expiresAt`, `tokenType` を返します。
 * 未入力は 400、未対応 challenge は 409、Cognito 由来の認証失敗や upstream failure は
 * `toAuthErrorResponse` に委譲します。
 */
app.post('/api/auth/login', async (c) => {
  const body = await readJson<LoginRequestBody>(c.req)
  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  const password = typeof body?.password === 'string' ? body.password : ''

  if (!email || !password) {
    return c.json({ message: 'Email and password are required.' }, 400)
  }

  try {
    const response = await cognito.initiatePasswordAuth(email, password)
    const tokens = response.AuthenticationResult

    if (!tokens?.AccessToken) {
      return c.json(
        {
          message: response.ChallengeName
            ? `Unsupported Cognito challenge: ${response.ChallengeName}`
            : 'Cognito did not return an access token.',
        },
        409,
      )
    }

    return c.json({
      accessToken: tokens.AccessToken,
      idToken: tokens.IdToken,
      refreshToken: tokens.RefreshToken,
      expiresAt: Date.now() + (tokens.ExpiresIn ?? 3600) * 1000,
      tokenType: tokens.TokenType ?? 'Bearer',
    })
  } catch (error) {
    return toAuthErrorResponse(c, error)
  }
})

/**
 * Bearer access token から現在の Cognito ユーザー情報を返す endpoint です。
 *
 * @remarks
 * `Authorization: Bearer <accessToken>` header を要求し、形式が合わない場合は 401 を返します。
 * 成功時は `username` と Cognito user attributes の map を返します。
 * Cognito の `getUser` 失敗は `toAuthErrorResponse` に委譲します。
 */
app.get('/api/auth/me', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const user = await cognito.getUser(accessToken)

    return c.json({
      username: user.Username ?? '',
      attributes: Object.fromEntries(
        (user.UserAttributes ?? [])
          .filter((attribute) => attribute.Name && attribute.Value !== undefined)
          .map((attribute) => [attribute.Name as string, attribute.Value]),
      ),
    })
  } catch (error) {
    return toAuthErrorResponse(c, error)
  }
})

/**
 * DynamoDB に保存されたダッシュボード集計値を返す endpoint です。
 *
 * @remarks
 * `Authorization: Bearer <accessToken>` header を要求し、Cognito で token を検証してから
 * DynamoDB の集計 item を読みます。React から Lambda/API Gateway 経由で呼ぶ想定の読み取り API です。
 */
app.get('/api/dashboard/summary', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = toProjectPrincipal(await cognito.getUser(accessToken))

    return c.json(await dashboardSummary.getSummary(principal.directoryId))
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * DynamoDB に保存されたチーム/プロジェクト階層を返す endpoint です。
 *
 * @remarks
 * サイドバー用の directory table を読み、`locale=en` のときだけ英語名を優先します。
 */
app.get('/api/teams/projects', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = toProjectPrincipal(await cognito.getUser(accessToken))

    return c.json(await projectDirectory.getProjectDirectory(principal.directoryId, readLocale(c)))
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * DynamoDB にチームを新規作成する endpoint です。
 */
app.post('/api/teams', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = toProjectPrincipal(await cognito.getUser(accessToken))
    const body = await readJson<CreateTeamRequestBody>(c.req)

    return c.json(await projectDirectory.createTeam(principal.directoryId, body ?? {}), 201)
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * DynamoDB にチーム配下のプロジェクトを新規作成する endpoint です。
 */
app.post('/api/teams/:teamId/projects', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!teamId) {
    return c.json({ message: 'Team ID is required.' }, 400)
  }

  try {
    const principal = toProjectPrincipal(await cognito.getUser(accessToken))
    const body = await readJson<CreateProjectRequestBody>(c.req)

    return c.json(await projectDirectory.createProject(principal.directoryId, teamId, body ?? {}), 201)
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * DynamoDB 上のチームをアーカイブする endpoint です。
 */
app.patch('/api/teams/:teamId/archive', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!teamId) {
    return c.json({ message: 'Team ID is required.' }, 400)
  }

  try {
    const principal = toProjectPrincipal(await cognito.getUser(accessToken))

    return c.json(await projectDirectory.archiveTeam(principal.directoryId, teamId))
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * DynamoDB 上のチーム配下プロジェクトをアーカイブする endpoint です。
 */
app.patch('/api/teams/:teamId/projects/:projectId/archive', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')
  const projectId = c.req.param('projectId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!teamId) {
    return c.json({ message: 'Team ID is required.' }, 400)
  }

  if (!projectId) {
    return c.json({ message: 'Project ID is required.' }, 400)
  }

  try {
    const principal = toProjectPrincipal(await cognito.getUser(accessToken))

    return c.json(await projectDirectory.archiveProject(principal.directoryId, teamId, projectId))
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * DynamoDB に保存されたプロジェクト別タスク一覧を返す endpoint です。
 *
 * @remarks
 * `ProjectSortOrderIndex` で `sortOrder` 昇順に取得し、画面表示用 DTO に変換します。
 */
app.get('/api/projects/:projectId/tasks', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const projectId = c.req.param('projectId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!projectId) {
    return c.json({ message: 'Project ID is required.' }, 400)
  }

  try {
    const principal = toProjectPrincipal(await cognito.getUser(accessToken))

    if (!(await projectDirectory.hasProjectAccess(principal.directoryId, projectId))) {
      throw new ProjectDataError(
        403,
        'ProjectAccessDenied',
        `User "${principal.userKey}" cannot access project "${projectId}".`,
      )
    }

    return c.json(await projectTasks.getProjectTasks(principal.directoryId, projectId))
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * DynamoDB にプロジェクト別タスクを新規作成する endpoint です。
 */
app.post('/api/projects/:projectId/tasks', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const projectId = c.req.param('projectId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!projectId) {
    return c.json({ message: 'Project ID is required.' }, 400)
  }

  try {
    const principal = toProjectPrincipal(await cognito.getUser(accessToken))

    if (!(await projectDirectory.hasProjectAccess(principal.directoryId, projectId))) {
      throw new ProjectDataError(
        403,
        'ProjectAccessDenied',
        `User "${principal.userKey}" cannot access project "${projectId}".`,
      )
    }

    const body = await readJson<CreateProjectTaskRequestBody>(c.req)

    return c.json(await projectTasks.createProjectTask(principal.directoryId, projectId, body ?? {}), 201)
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * DynamoDB に保存されたプロジェクト別タスクの状態を更新する endpoint です。
 */
app.patch('/api/projects/:projectId/tasks/:taskId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const projectId = c.req.param('projectId')
  const taskId = c.req.param('taskId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!projectId) {
    return c.json({ message: 'Project ID is required.' }, 400)
  }

  if (!taskId) {
    return c.json({ message: 'Task ID is required.' }, 400)
  }

  try {
    const principal = toProjectPrincipal(await cognito.getUser(accessToken))

    if (!(await projectDirectory.hasProjectAccess(principal.directoryId, projectId))) {
      throw new ProjectDataError(
        403,
        'ProjectAccessDenied',
        `User "${principal.userKey}" cannot access project "${projectId}".`,
      )
    }

    const body = await readJson<UpdateProjectTaskStatusRequestBody>(c.req)

    return c.json(
      await projectTasks.updateProjectTaskStatus(principal.directoryId, projectId, taskId, body ?? {}),
    )
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

async function readJson<T>(request: { json: () => Promise<T> }) {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

function readBearerAccessToken(c: Context) {
  const authorization = c.req.header('Authorization') ?? ''

  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]
}

function readLocale(c: Context): Locale {
  return c.req.query('locale') === 'en' ? 'en' : 'ja'
}

function toAuthErrorResponse(c: Context, error: unknown) {
  if (!(error instanceof CognitoServiceError)) {
    console.error(error)
    return c.json({ message: 'Unexpected authentication error.' }, 500)
  }

  if (error.code === 'CognitoTimeout') {
    console.error(error)
    return c.json({ message: 'Cognito local service timed out.' }, 504)
  }

  if (error.code === 'InvalidCognitoResponse' || error.status === 200 || !error.code) {
    console.error(error)
    return c.json({ message: 'Cognito local service returned an invalid response.' }, 502)
  }

  if (error.code === 'NotAuthorizedException' || error.code === 'UserNotFoundException') {
    return c.json({ message: 'Invalid email or password.' }, 401)
  }

  if (error.code === 'ResourceNotFoundException' || error.code === 'ClientNotFoundException') {
    return c.json({ message: 'Cognito local resources are not ready.' }, 503)
  }

  if (error.status >= 500) {
    console.error(error)
    return c.json({ message: 'Cognito local service is unavailable.' }, 502)
  }

  return c.json({ message: error.message }, 400)
}

function toProjectDataErrorResponse(c: Context, error: unknown) {
  if (!(error instanceof ProjectDataError)) {
    console.error(error)
    return c.json({ message: 'Project data is unavailable.' }, 502)
  }

  if (error.code === 'InvalidProjectWrite') {
    return c.json({ message: error.message }, 400)
  }

  if (error.code === 'TeamNotFound') {
    return c.json({ message: 'Team was not found.' }, 404)
  }

  if (error.code === 'ProjectNotFound') {
    return c.json({ message: 'Project was not found.' }, 404)
  }

  if (error.code === 'ProjectTaskNotFound') {
    return c.json({ message: 'Task was not found.' }, 404)
  }

  if (error.code === 'ConditionalCheckFailedException') {
    return c.json({ message: 'The same item already exists.' }, 409)
  }

  if (error.code === 'ResourceNotFoundException') {
    console.error(error)
    return c.json({ message: 'Project data is not initialized.' }, 503)
  }

  if (error.code === 'InvalidProjectTask' || error.code === 'InvalidProjectDirectory') {
    console.error(error)
    return c.json({ message: 'Project data is invalid.' }, 503)
  }

  if (error.code === 'ProjectPrincipalMissing' || error.code === 'ProjectAccessDenied') {
    return c.json({ message: 'Project access is denied.' }, 403)
  }

  console.error(error)
  return c.json({ message: 'Project data is unavailable.' }, 502)
}

/**
 * Floci の Cognito JSON API を呼び出す軽量 client です。
 */
class FlociCognitoClient {
  /**
   * Floci / Cognito の endpoint URL です。
   */
  private readonly endpoint = trimTrailingSlash(
    getEnv('COGNITO_ENDPOINT') ?? getEnv('AWS_ENDPOINT_URL') ?? 'http://localhost:4566',
  )

  /**
   * Cognito HTTP request を abort するまでの milliseconds です。
   */
  private readonly requestTimeoutMs = 5000

  /**
   * 明示指定された Cognito user pool ID です。
   */
  private readonly userPoolId = getEnv('COGNITO_USER_POOL_ID')
  /**
   * 自動検出に使う Cognito user pool 名です。
   */
  private readonly userPoolName = getEnv('COGNITO_USER_POOL_NAME') ?? 'mukuroji-local'
  /**
   * 明示指定された Cognito app client ID です。
   */
  private readonly clientId = getEnv('COGNITO_CLIENT_ID')
  /**
   * 自動検出に使う Cognito app client 名です。
   */
  private readonly clientName = getEnv('COGNITO_USER_POOL_CLIENT_NAME') ?? 'mukuroji-web-local'
  /**
   * 解決済み user pool ID の cache です。
   */
  private resolvedUserPoolId: string | undefined
  /**
   * 解決済み app client ID の cache です。
   */
  private resolvedClientId: string | undefined

  /**
   * USER_PASSWORD_AUTH flow で Cognito 認証を実行します。
   */
  async initiatePasswordAuth(email: string, password: string) {
    const clientId = await this.resolveClientId()

    return this.request<InitiateAuthResponse>('InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: clientId,
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
      },
    })
  }

  /**
   * access token から Cognito ユーザー情報を取得します。
   */
  async getUser(accessToken: string) {
    return this.request<GetUserResponse>('GetUser', {
      AccessToken: accessToken,
    })
  }

  /**
   * 環境変数または Floci 上の一覧から app client ID を解決します。
   */
  private async resolveClientId() {
    if (this.resolvedClientId) {
      return this.resolvedClientId
    }

    if (this.clientId) {
      this.resolvedClientId = this.clientId
      return this.resolvedClientId
    }

    const userPoolId = await this.resolveUserPoolId()
    const response = await this.request<ListUserPoolClientsResponse>('ListUserPoolClients', {
      UserPoolId: userPoolId,
      MaxResults: 60,
    })

    const client = response.UserPoolClients?.find(
      (candidate) => candidate.ClientName === this.clientName,
    )

    if (!client?.ClientId) {
      throw new CognitoServiceError(
        404,
        'ClientNotFoundException',
        `Cognito user pool client "${this.clientName}" was not found.`,
      )
    }

    this.resolvedClientId = client.ClientId
    return this.resolvedClientId
  }

  /**
   * 環境変数または Floci 上の一覧から user pool ID を解決します。
   */
  private async resolveUserPoolId() {
    if (this.resolvedUserPoolId) {
      return this.resolvedUserPoolId
    }

    if (this.userPoolId) {
      this.resolvedUserPoolId = this.userPoolId
      return this.resolvedUserPoolId
    }

    const response = await this.request<ListUserPoolsResponse>('ListUserPools', {
      MaxResults: 60,
    })

    const userPool = response.UserPools?.find(
      (candidate) => candidate.Name === this.userPoolName,
    )

    if (!userPool?.Id) {
      throw new CognitoServiceError(
        404,
        'ResourceNotFoundException',
        `Cognito user pool "${this.userPoolName}" was not found.`,
      )
    }

    this.resolvedUserPoolId = userPool.Id
    return this.resolvedUserPoolId
  }

  /**
   * Cognito JSON 1.1 API に action 指定で POST します。
   */
  private async request<T>(action: string, payload: Record<string, unknown>) {
    let response: Response
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs)

    try {
      response = await fetch(`${this.endpoint}/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError'
      const message = isAbort
        ? 'Cognito request timed out.'
        : error instanceof Error
          ? error.message
          : 'Unknown network error.'

      throw new CognitoServiceError(
        isAbort ? 504 : 503,
        isAbort ? 'CognitoTimeout' : 'CognitoUnavailable',
        message,
      )
    } finally {
      clearTimeout(timeoutId)
    }

    const data = await parseJsonResponse<T | CognitoErrorPayload>(response)

    if (!response.ok) {
      const errorPayload = data as CognitoErrorPayload
      const errorCode = normalizeCognitoErrorCode(errorPayload.__type)

      if (!errorCode) {
        throw new CognitoServiceError(
          response.status,
          'InvalidCognitoResponse',
          errorPayload.message ?? errorPayload.Message ?? response.statusText,
        )
      }

      throw new CognitoServiceError(
        response.status,
        errorCode,
        errorPayload.message ?? errorPayload.Message ?? response.statusText,
      )
    }

    return data as T
  }
}

/**
 * DynamoDB の team/project と task data からダッシュボード集計値を算出する client です。
 */
export class DynamoDbDashboardSummaryClient {
  /**
   * team/project directory を読み取る client です。
   */
  private readonly projectDirectoryClient: ProjectDirectoryClient

  /**
   * project task を読み取る client です。
   */
  private readonly projectTasksClient: ProjectTasksClient

  constructor(
    projectDirectoryClient: ProjectDirectoryClient = new DynamoDbProjectDirectoryClient(),
    projectTasksClient: ProjectTasksClient = new DynamoDbProjectTasksClient(),
  ) {
    this.projectDirectoryClient = projectDirectoryClient
    this.projectTasksClient = projectTasksClient
  }

  /**
   * ユーザー directory の team/project と task data からダッシュボード集計値を取得します。
   */
  async getSummary(directoryId: string) {
    const directory = await this.projectDirectoryClient.getProjectDirectory(directoryId, 'ja')
    const projectIds = new Set(
      directory.teams.flatMap((team) => team.projects.map((project) => project.id)),
    )
    const taskResponses = await Promise.all(
      Array.from(projectIds).map((projectId) =>
        this.projectTasksClient.getProjectTasks(directoryId, projectId),
      ),
    )
    const tasks = taskResponses.flatMap((response) => response.tasks)

    return {
      projects: projectIds.size,
      tasks: tasks.filter((task) => task.status !== 'done').length,
      blocked: tasks.filter((task) => task.priority === 'high' && task.status !== 'done').length,
      updatedAt: new Date().toISOString(),
      source: 'dynamodb',
    } satisfies DashboardSummaryResponse
  }
}

/**
 * DynamoDB の project task item を読み取る client です。
 */
export class DynamoDbProjectTasksClient {
  /**
   * project task item を保存する DynamoDB table 名です。
   */
  private readonly tableName: string
  /**
   * DynamoDB DocumentClient です。
   */
  private readonly documentClient: DynamoDBDocumentClient
  /**
   * table 初期化に使う低レベル DynamoDB client です。
   */
  private readonly dynamoDbClient: DynamoDBClient
  /**
   * ローカル DynamoDB の table 欠落を自動復旧するかどうかです。
   */
  private readonly bootstrapLocalTables: boolean

  constructor(
    tableName =
      getEnv('MUKUROJI_PROJECT_TASKS_TABLE') ??
      getEnv('TASKS_TABLE_NAME') ??
      'mukuroji-project-tasks-v2-local',
    documentClient = createDynamoDbDocumentClient(),
    dynamoDbClient?: DynamoDBClient,
    bootstrapLocalTables = dynamoDbClient === undefined && shouldBootstrapLocalDynamoDb(),
  ) {
    this.tableName = tableName
    this.documentClient = documentClient
    this.dynamoDbClient = dynamoDbClient ?? createDynamoDbClient()
    this.bootstrapLocalTables = bootstrapLocalTables
  }

  /**
   * DynamoDB からプロジェクト別タスク一覧を取得します。
   */
  async getProjectTasks(directoryId: string, projectId: string) {
    try {
      const items = await this.queryProjectTaskItems(directoryId, projectId)
      const tasks = items.map(toProjectTaskResponseItem)

      return {
        projectId,
        tasks,
      } satisfies ProjectTasksResponse
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB にプロジェクト別タスクを作成します。
   */
  async createProjectTask(
    directoryId: string,
    projectId: string,
    input: CreateProjectTaskRequestBody,
  ) {
    const title = readRequiredString(input.title, 'Task title is required.')
    const assignee = readRequiredString(input.assignee, 'Task assignee is required.')
    const status = readTaskStatus(input.status)
    const dueDate = readRequiredString(input.dueDate, 'Task due date is required.')
    const priority = readTaskPriority(input.priority)
    const directoryProjectId = createDirectoryProjectId(directoryId, projectId)

    try {
      const currentTasks = await this.getProjectTasks(directoryId, projectId)
      const taskId = createUniqueResourceId(title, currentTasks.tasks.map((task) => task.id))
      const sortOrder = (currentTasks.tasks.length + 1) * 10
      const item: ProjectTaskItem = {
        directoryId,
        directoryProjectId,
        projectId,
        taskId,
        sortOrder,
        title,
        assignee,
        status,
        dueDate,
        priority,
      }

      await this.documentClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(directoryProjectId) AND attribute_not_exists(taskId)',
        }),
      )

      return {
        task: toProjectTaskResponseItem(item),
      } satisfies CreateProjectTaskResponse
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB に保存されたプロジェクト別タスクの状態を更新します。
   */
  async updateProjectTaskStatus(
    directoryId: string,
    projectId: string,
    taskId: string,
    input: UpdateProjectTaskStatusRequestBody,
  ) {
    const status = readRequiredTaskStatus(input.status)
    const directoryProjectId = createDirectoryProjectId(directoryId, projectId)

    try {
      const response = await this.documentClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: {
            directoryProjectId,
            taskId,
          },
          UpdateExpression: 'SET #status = :status',
          ExpressionAttributeNames: {
            '#status': 'status',
          },
          ExpressionAttributeValues: {
            ':status': status,
          },
          ConditionExpression: 'attribute_exists(directoryProjectId) AND attribute_exists(taskId)',
          ReturnValues: 'ALL_NEW',
        }),
      )

      return {
        task: toProjectTaskResponseItem(response.Attributes),
      } satisfies UpdateProjectTaskStatusResponse
    } catch (error) {
      if (isAwsNamedError(error, 'ConditionalCheckFailedException')) {
        throw new ProjectDataError(404, 'ProjectTaskNotFound', 'Task was not found.')
      }

      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB から project partition の task item を全件取得します。
   */
  private async queryProjectTaskItems(
    directoryId: string,
    projectId: string,
    canBootstrapLocalTable = true,
  ) {
    try {
      const items: unknown[] = []
      let exclusiveStartKey: Record<string, unknown> | undefined

      do {
        const response = await this.documentClient.send(
          new QueryCommand({
            TableName: this.tableName,
            IndexName: 'ProjectSortOrderIndex',
            KeyConditionExpression: 'directoryProjectId = :directoryProjectId',
            ExpressionAttributeValues: {
              ':directoryProjectId': createDirectoryProjectId(directoryId, projectId),
            },
            ExclusiveStartKey: exclusiveStartKey,
            ScanIndexForward: true,
          }),
        )

        items.push(...(response.Items ?? []))
        exclusiveStartKey = response.LastEvaluatedKey
      } while (exclusiveStartKey)

      return items
    } catch (error) {
      if (
        canBootstrapLocalTable &&
        this.bootstrapLocalTables &&
        isResourceNotFoundError(error) &&
        await ensureLocalProjectTasksTable(this.tableName, this.dynamoDbClient)
      ) {
        return this.queryProjectTaskItems(directoryId, projectId, false)
      }

      throw error
    }
  }
}

/**
 * DynamoDB の team/project directory item を読み取る client です。
 */
export class DynamoDbProjectDirectoryClient {
  /**
   * team/project directory item を保存する DynamoDB table 名です。
   */
  private readonly tableName: string
  /**
   * DynamoDB DocumentClient です。
   */
  private readonly documentClient: DynamoDBDocumentClient
  /**
   * table 初期化に使う低レベル DynamoDB client です。
   */
  private readonly dynamoDbClient: DynamoDBClient
  /**
   * ローカル DynamoDB の table 欠落を自動復旧するかどうかです。
   */
  private readonly bootstrapLocalTables: boolean

  constructor(
    tableName =
      getEnv('MUKUROJI_PROJECT_DIRECTORY_TABLE') ??
      getEnv('PROJECT_DIRECTORY_TABLE_NAME') ??
      'mukuroji-project-directory-local',
    documentClient = createDynamoDbDocumentClient(),
    dynamoDbClient?: DynamoDBClient,
    bootstrapLocalTables = dynamoDbClient === undefined && shouldBootstrapLocalDynamoDb(),
  ) {
    this.tableName = tableName
    this.documentClient = documentClient
    this.dynamoDbClient = dynamoDbClient ?? createDynamoDbClient()
    this.bootstrapLocalTables = bootstrapLocalTables
  }

  /**
   * DynamoDB から sidebar 用の team/project 階層を取得します。
   */
  async getProjectDirectory(directoryId: string, locale: Locale) {
    try {
      const items = await this.queryDirectoryItems(directoryId)

      return {
        teams: toProjectDirectoryResponse(items, locale, directoryId),
      } satisfies ProjectDirectoryResponse
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * ユーザーの directory に指定 project ID が含まれるかどうかを判定します。
   */
  async hasProjectAccess(directoryId: string, projectId: string) {
    try {
      const items = await this.readValidDirectoryItems(directoryId)
      const activeTeamIds = new Set(
        items
          .filter((item) => item.entryType === 'team' && isActiveDirectoryItem(item))
          .map((item) => item.teamId),
      )

      return items.some((item) => {
        return (
          item.entryType === 'project' &&
          item.projectId === projectId &&
          isActiveDirectoryItem(item) &&
          activeTeamIds.has(item.teamId)
        )
      })
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB にチームを作成します。
   */
  async createTeam(directoryId: string, input: CreateTeamRequestBody) {
    const names = readLocalizedNames(input)

    try {
      const items = await this.readValidDirectoryItems(directoryId)
      const teamId = createUniqueResourceId(
        names.nameJa,
        items
          .filter((item) => item.entryType === 'team')
          .map((item) => item.teamId),
      )
      const teamSortOrder =
        Math.max(0, ...items.filter((item) => item.entryType === 'team').map((item) => item.teamSortOrder)) +
        10
      const item: ProjectDirectoryItem = {
        directoryId,
        entryKey: createTeamEntryKey(teamSortOrder, teamId),
        entryType: 'team',
        teamId,
        teamSortOrder,
        nameJa: names.nameJa,
        nameEn: names.nameEn,
        expanded: typeof input.expanded === 'boolean' ? input.expanded : true,
      }

      await this.documentClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
        }),
      )

      return {
        team: {
          id: item.teamId,
          name: item.nameJa,
          expanded: item.expanded ?? false,
          projects: [],
        },
      } satisfies CreateTeamResponse
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB にチーム配下のプロジェクトを作成します。
   */
  async createProject(directoryId: string, teamId: string, input: CreateProjectRequestBody) {
    const names = readLocalizedNames(input)
    const tone = readProjectTone(input.tone)

    try {
      const items = await this.readValidDirectoryItems(directoryId)
      const team = items.find((item) =>
        item.entryType === 'team' && item.teamId === teamId && isActiveDirectoryItem(item),
      )

      if (!team) {
        throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
      }

      const projectId = createUniqueResourceId(
        names.nameJa,
        items
          .filter((item) => item.entryType === 'project')
          .flatMap((item) => (item.projectId ? [item.projectId] : [])),
      )
      const projectSortOrder =
        Math.max(
          0,
          ...items
            .filter((item) => item.entryType === 'project' && item.teamId === teamId)
            .map((item) => item.projectSortOrder ?? 0),
        ) + 10
      const item: ProjectDirectoryItem = {
        directoryId,
        entryKey: createProjectEntryKey(team.teamSortOrder, projectSortOrder, projectId),
        entryType: 'project',
        teamId,
        teamSortOrder: team.teamSortOrder,
        nameJa: names.nameJa,
        nameEn: names.nameEn,
        projectId,
        projectSortOrder,
        tone,
      }

      await this.documentClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
        }),
      )

      return {
        project: {
          id: item.projectId,
          name: item.nameJa,
          tone: item.tone,
        },
      } satisfies CreateProjectResponse
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB 上のチームをアーカイブします。
   */
  async archiveTeam(directoryId: string, teamId: string) {
    try {
      const items = await this.readValidDirectoryItems(directoryId)
      const team = items.find((item) =>
        item.entryType === 'team' && item.teamId === teamId && isActiveDirectoryItem(item),
      )

      if (!team) {
        throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
      }

      const archivedAt = new Date().toISOString()

      await this.documentClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: {
            directoryId,
            entryKey: team.entryKey,
          },
          UpdateExpression: 'SET archivedAt = :archivedAt',
          ConditionExpression:
            'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
          ExpressionAttributeValues: {
            ':archivedAt': archivedAt,
          },
        }),
      )

      return {
        teamId,
        archivedAt,
      } satisfies ArchiveTeamResponse
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB 上のチーム配下プロジェクトをアーカイブします。
   */
  async archiveProject(directoryId: string, teamId: string, projectId: string) {
    try {
      const items = await this.readValidDirectoryItems(directoryId)
      const team = items.find((item) =>
        item.entryType === 'team' && item.teamId === teamId && isActiveDirectoryItem(item),
      )

      if (!team) {
        throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
      }

      const project = items.find((item) =>
        item.entryType === 'project' &&
        item.teamId === teamId &&
        item.projectId === projectId &&
        isActiveDirectoryItem(item),
      )

      if (!project) {
        throw new ProjectDataError(
          404,
          'ProjectNotFound',
          `Project "${projectId}" was not found in team "${teamId}".`,
        )
      }

      const archivedAt = new Date().toISOString()

      await this.documentClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: {
            directoryId,
            entryKey: project.entryKey,
          },
          UpdateExpression: 'SET archivedAt = :archivedAt',
          ConditionExpression:
            'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
          ExpressionAttributeValues: {
            ':archivedAt': archivedAt,
          },
        }),
      )

      return {
        teamId,
        projectId,
        archivedAt,
      } satisfies ArchiveProjectResponse
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * directory partition 内の全 item を検証済み item として取得します。
   */
  private async readValidDirectoryItems(directoryId: string) {
    return this.queryDirectoryItems(directoryId).then((items) =>
      items.map((item) => {
        if (!isProjectDirectoryItem(item, directoryId)) {
          throw new ProjectDataError(
            503,
            'InvalidProjectDirectory',
            'Project directory item is missing or invalid.',
          )
        }

        return item
      }),
    )
  }

  /**
   * directory partition 内の全 item を LastEvaluatedKey がなくなるまで取得します。
   */
  private async queryDirectoryItems(directoryId: string, canBootstrapLocalTable = true) {
    try {
      const items: unknown[] = []
      let exclusiveStartKey: Record<string, unknown> | undefined

      do {
        const response = await this.documentClient.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: 'directoryId = :directoryId',
            ExpressionAttributeValues: {
              ':directoryId': directoryId,
            },
            ExclusiveStartKey: exclusiveStartKey,
            ScanIndexForward: true,
          }),
        )

        items.push(...(response.Items ?? []))
        exclusiveStartKey = response.LastEvaluatedKey
      } while (exclusiveStartKey)

      return items
    } catch (error) {
      if (
        canBootstrapLocalTable &&
        this.bootstrapLocalTables &&
        isResourceNotFoundError(error) &&
        await ensureLocalProjectDirectoryTable(this.tableName, this.dynamoDbClient)
      ) {
        return this.queryDirectoryItems(directoryId, false)
      }

      throw error
    }
  }
}

/**
 * Floci Cognito との通信で扱う domain error です。
 */
class CognitoServiceError extends Error {
  /**
   * Cognito または proxy 相当の HTTP status code です。
   */
  readonly status: number
  /**
   * Cognito error code またはローカルで付与した error code です。
   */
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/**
 * DynamoDB の project data 取得で扱う domain error です。
 */
class ProjectDataError extends Error {
  /**
   * DynamoDB または proxy 相当の HTTP status code です。
   */
  readonly status: number
  /**
   * DynamoDB error code またはローカルで付与した error code です。
   */
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text()

  if (!text) {
    return {} as T
  }

  try {
    return JSON.parse(text) as T
  } catch {
    throw new CognitoServiceError(
      response.status,
      'InvalidCognitoResponse',
      'Cognito returned invalid JSON.',
    )
  }
}

function createDynamoDbClient() {
  const endpoint = getDynamoDbEndpoint()

  return new DynamoDBClient({
    region: getAwsRegion(),
    endpoint,
    credentials: {
      accessKeyId: getEnv('AWS_ACCESS_KEY_ID') ?? 'test',
      secretAccessKey: getEnv('AWS_SECRET_ACCESS_KEY') ?? 'test',
    },
  })
}

function createDynamoDbDocumentClient() {
  return DynamoDBDocumentClient.from(createDynamoDbClient(), {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  })
}

const localDynamoDbTableInitializers = new Map<string, Promise<void>>()

async function ensureLocalProjectTasksTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
) {
  return ensureLocalDynamoDbTable(
    tableName,
    dynamoDbClient,
    () =>
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [
          { AttributeName: 'directoryProjectId', AttributeType: 'S' },
          { AttributeName: 'taskId', AttributeType: 'S' },
          { AttributeName: 'sortOrder', AttributeType: 'N' },
        ],
        KeySchema: [
          { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
          { AttributeName: 'taskId', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'ProjectSortOrderIndex',
            KeySchema: [
              { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
              { AttributeName: 'sortOrder', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    isProjectTasksTableDescription,
  )
}

async function ensureLocalProjectDirectoryTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
) {
  return ensureLocalDynamoDbTable(
    tableName,
    dynamoDbClient,
    () =>
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [
          { AttributeName: 'directoryId', AttributeType: 'S' },
          { AttributeName: 'entryKey', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'directoryId', KeyType: 'HASH' },
          { AttributeName: 'entryKey', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    isProjectDirectoryTableDescription,
  )
}

async function ensureLocalDynamoDbTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
  createCommand: () => CreateTableCommand,
  validateTable: (table: TableDescription | undefined) => boolean,
) {
  if (!shouldBootstrapLocalDynamoDb()) {
    return false
  }

  const initializerKey = `${getDynamoDbEndpoint()}#${tableName}`
  const existingInitializer = localDynamoDbTableInitializers.get(initializerKey)

  if (existingInitializer) {
    await existingInitializer
    return true
  }

  const initializer = createLocalDynamoDbTable(tableName, dynamoDbClient, createCommand, validateTable)
    .finally(() => {
      localDynamoDbTableInitializers.delete(initializerKey)
    })

  localDynamoDbTableInitializers.set(initializerKey, initializer)
  await initializer

  return true
}

async function createLocalDynamoDbTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
  createCommand: () => CreateTableCommand,
  validateTable: (table: TableDescription | undefined) => boolean,
) {
  try {
    await dynamoDbClient.send(createCommand())
  } catch (error) {
    if (!isResourceInUseError(error)) {
      throw error
    }
  }

  await waitForLocalDynamoDbTable(tableName, dynamoDbClient, validateTable)
}

async function waitForLocalDynamoDbTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
  validateTable: (table: TableDescription | undefined) => boolean,
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await dynamoDbClient.send(
      new DescribeTableCommand({
        TableName: tableName,
      }),
    )

    if (response.Table?.TableStatus === 'ACTIVE' && validateTable(response.Table)) {
      return
    }

    if (response.Table?.TableStatus === 'ACTIVE') {
      throw new Error(`Local DynamoDB table "${tableName}" does not match the expected schema.`)
    }

    await sleep(100)
  }

  throw new Error(`Local DynamoDB table "${tableName}" did not become active.`)
}

function isProjectTasksTableDescription(table: TableDescription | undefined) {
  return (
    hasKeySchema(table, [
      ['directoryProjectId', 'HASH'],
      ['taskId', 'RANGE'],
    ]) &&
    Boolean(
      table?.GlobalSecondaryIndexes?.some((index) =>
        index.IndexName === 'ProjectSortOrderIndex' &&
        hasKeySchema(index, [
          ['directoryProjectId', 'HASH'],
          ['sortOrder', 'RANGE'],
        ]),
      ),
    )
  )
}

function isProjectDirectoryTableDescription(table: TableDescription | undefined) {
  return hasKeySchema(table, [
    ['directoryId', 'HASH'],
    ['entryKey', 'RANGE'],
  ])
}

function hasKeySchema(
  value: { KeySchema?: TableDescription['KeySchema'] } | undefined,
  expected: Array<[string, 'HASH' | 'RANGE']>,
) {
  return expected.every(([attributeName, keyType]) =>
    value?.KeySchema?.some((schema) =>
      schema.AttributeName === attributeName && schema.KeyType === keyType,
    ),
  )
}

function shouldBootstrapLocalDynamoDb() {
  const endpoint = getDynamoDbEndpoint()

  return /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|floci)(?::|\/|$)/.test(endpoint)
}

function isResourceNotFoundError(error: unknown) {
  return isAwsNamedError(error, 'ResourceNotFoundException')
}

function isResourceInUseError(error: unknown) {
  return isAwsNamedError(error, 'ResourceInUseException')
}

function isAwsNamedError(error: unknown, name: string) {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === name
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function toProjectDataError(error: unknown) {
  const awsError = error as {
    $metadata?: {
      httpStatusCode?: number
    }
    message?: string
    name?: string
  }

  return new ProjectDataError(
    awsError.$metadata?.httpStatusCode ?? 502,
    awsError.name ?? 'DynamoDbUnavailable',
    awsError.message ?? 'DynamoDB request failed.',
  )
}

function toProjectTaskResponseItem(value: unknown): ProjectTaskResponseItem {
  if (!isProjectTaskItem(value)) {
    throw new ProjectDataError(
      503,
      'InvalidProjectTask',
      'Project task item is missing or invalid.',
    )
  }

  const task: ProjectTaskResponseItem = {
    id: value.taskId,
    status: value.status,
    dueDate: value.dueDate,
    priority: value.priority,
  }

  if (value.titleKey) {
    task.titleKey = value.titleKey
  }

  if (value.title) {
    task.title = value.title
  }

  if (value.assigneeKey) {
    task.assigneeKey = value.assigneeKey
  }

  if (value.assignee) {
    task.assignee = value.assignee
  }

  return task
}

function toProjectDirectoryResponse(
  values: unknown[],
  locale: Locale,
  directoryId: string,
): ProjectDirectoryTeamResponse[] {
  const teams: ProjectDirectoryTeamResponse[] = []
  const teamById = new Map<string, ProjectDirectoryTeamResponse>()
  const projectItems: ProjectDirectoryItem[] = []

  for (const value of values) {
    if (!isProjectDirectoryItem(value, directoryId)) {
      throw new ProjectDataError(
        503,
        'InvalidProjectDirectory',
        'Project directory item is missing or invalid.',
      )
    }

    if (!isActiveDirectoryItem(value)) {
      continue
    }

    if (value.entryType === 'team') {
      const team = {
        id: value.teamId,
        name: localizedName(value, locale),
        expanded: value.expanded ?? false,
        projects: [],
      }

      teamById.set(team.id, team)
      teams.push(team)
      continue
    }

    projectItems.push(value)
  }

  for (const item of projectItems) {
    const team = teamById.get(item.teamId)

    if (!team || !item.projectId) {
      continue
    }

    team.projects.push({
      id: item.projectId,
      name: localizedName(item, locale),
      tone: item.tone,
    })
  }

  return teams
}

function localizedName(item: ProjectDirectoryItem, locale: Locale) {
  return locale === 'en' ? item.nameEn || item.nameJa : item.nameJa || item.nameEn
}

function isActiveDirectoryItem(item: ProjectDirectoryItem) {
  return item.archivedAt === undefined
}

function isProjectTaskItem(value: unknown): value is ProjectTaskItem {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.projectId === 'string' &&
    typeof value.directoryId === 'string' &&
    value.directoryProjectId === createDirectoryProjectId(value.directoryId, value.projectId) &&
    typeof value.taskId === 'string' &&
    typeof value.sortOrder === 'number' &&
    (typeof value.titleKey === 'string' || typeof value.title === 'string') &&
    (typeof value.assigneeKey === 'string' || typeof value.assignee === 'string') &&
    isProjectTaskStatus(value.status) &&
    typeof value.dueDate === 'string' &&
    isProjectTaskPriority(value.priority)
  )
}

function isProjectDirectoryItem(value: unknown, directoryId: string): value is ProjectDirectoryItem {
  if (!isRecord(value)) {
    return false
  }

  if (
    value.directoryId !== directoryId ||
    typeof value.entryKey !== 'string' ||
    (value.entryType !== 'team' && value.entryType !== 'project') ||
    typeof value.teamId !== 'string' ||
    typeof value.teamSortOrder !== 'number' ||
    typeof value.nameJa !== 'string' ||
    typeof value.nameEn !== 'string' ||
    (value.archivedAt !== undefined && typeof value.archivedAt !== 'string')
  ) {
    return false
  }

  if (value.entryType === 'team') {
    return value.expanded === undefined || typeof value.expanded === 'boolean'
  }

  return (
    typeof value.projectId === 'string' &&
    typeof value.projectSortOrder === 'number' &&
    isProjectTone(value.tone)
  )
}

function isProjectTaskStatus(value: unknown): value is ProjectTaskStatus {
  return value === 'in-progress' || value === 'review' || value === 'todo' || value === 'done'
}

function isProjectTaskPriority(value: unknown): value is ProjectTaskPriority {
  return value === 'high' || value === 'medium' || value === 'low'
}

function isProjectTone(value: unknown): value is ProjectTone {
  return value === 'blue' || value === 'purple' || value === 'green' || value === 'yellow'
}

function readRequiredString(value: unknown, message: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', message)
  }

  return value.trim()
}

function readLocalizedNames(input: CreateTeamRequestBody | CreateProjectRequestBody) {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const nameJa = typeof input.nameJa === 'string' ? input.nameJa.trim() : ''
  const nameEn = typeof input.nameEn === 'string' ? input.nameEn.trim() : ''
  const primaryName = nameJa || name || nameEn

  if (!primaryName) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Name is required.')
  }

  return {
    nameJa: primaryName,
    nameEn: nameEn || name || primaryName,
  }
}

function readTaskStatus(value: unknown): ProjectTaskStatus {
  if (value === undefined) {
    return 'todo'
  }

  if (!isProjectTaskStatus(value)) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Task status is invalid.')
  }

  return value
}

function readRequiredTaskStatus(value: unknown): ProjectTaskStatus {
  if (!isProjectTaskStatus(value)) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Task status is invalid.')
  }

  return value
}

function readTaskPriority(value: unknown): ProjectTaskPriority {
  if (value === undefined) {
    return 'medium'
  }

  if (!isProjectTaskPriority(value)) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Task priority is invalid.')
  }

  return value
}

function readProjectTone(value: unknown): ProjectTone {
  if (value === undefined) {
    return 'blue'
  }

  if (!isProjectTone(value)) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Project tone is invalid.')
  }

  return value
}

function createResourceId(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')

  return normalized || `item-${Date.now()}`
}

function createUniqueResourceId(value: string, existingIds: Iterable<string>) {
  const baseId = createResourceId(value)
  const usedIds = new Set(existingIds)

  if (!usedIds.has(baseId)) {
    return baseId
  }

  let suffix = 2

  while (usedIds.has(`${baseId}-${suffix}`)) {
    suffix += 1
  }

  return `${baseId}-${suffix}`
}

function createTeamEntryKey(teamSortOrder: number, teamId: string) {
  return `${padSortOrder(teamSortOrder)}#000000#TEAM#${teamId}`
}

function createProjectEntryKey(
  teamSortOrder: number,
  projectSortOrder: number,
  projectId: string,
) {
  return `${padSortOrder(teamSortOrder)}#${padSortOrder(projectSortOrder)}#PROJECT#${projectId}`
}

function padSortOrder(value: number) {
  return String(value).padStart(6, '0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toProjectPrincipal(user: GetUserResponse): ProjectPrincipal {
  const userKey = readUserAttribute(user, 'email') ?? user.Username

  if (!userKey?.trim()) {
    throw new ProjectDataError(
      403,
      'ProjectPrincipalMissing',
      'Cognito user does not have a stable project access identifier.',
    )
  }

  const normalizedUserKey = userKey.trim().toLowerCase()

  return {
    directoryId: `${projectDirectoryIdPrefix}${normalizedUserKey}`,
    userKey: normalizedUserKey,
  }
}

function readUserAttribute(user: GetUserResponse, name: string) {
  return user.UserAttributes?.find((attribute) => attribute.Name === name)?.Value
}

function createDirectoryProjectId(directoryId: string, projectId: string) {
  return `${directoryId}#project#${projectId}`
}

function getAwsRegion() {
  return getEnv('AWS_REGION') ?? getEnv('AWS_DEFAULT_REGION') ?? 'us-east-1'
}

function getDynamoDbEndpoint() {
  return getEnv('DYNAMODB_ENDPOINT') ?? getEnv('AWS_ENDPOINT_URL') ?? 'http://localhost:4566'
}

function getEnv(name: string) {
  if (typeof Bun !== 'undefined') {
    return Bun.env[name]
  }

  return process.env[name]
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}

function normalizeCognitoErrorCode(value: string | undefined) {
  return value?.split('#').pop()
}

cognito = new FlociCognitoClient()
dashboardSummary = new DynamoDbDashboardSummaryClient()
projectTasks = new DynamoDbProjectTasksClient()
projectDirectory = new DynamoDbProjectDirectoryClient()

/**
 * Server test で外部 service client を差し替えます。
 */
export function configureApiClientsForTest(clients: {
  cognito?: CognitoClient
  dashboardSummary?: DashboardSummaryClient
  projectTasks?: ProjectTasksClient
  projectDirectory?: ProjectDirectoryClient
}) {
  cognito = clients.cognito ?? cognito
  dashboardSummary = clients.dashboardSummary ?? dashboardSummary
  projectTasks = clients.projectTasks ?? projectTasks
  projectDirectory = clients.projectDirectory ?? projectDirectory
}

/**
 * Server test 後に外部 service client を実装 client に戻します。
 */
export function resetApiClientsForTest() {
  cognito = new FlociCognitoClient()
  dashboardSummary = new DynamoDbDashboardSummaryClient()
  projectTasks = new DynamoDbProjectTasksClient()
  projectDirectory = new DynamoDbProjectDirectoryClient()
}

/**
 * AWS Lambda にデプロイする Hono handler です。
 */
export const handler = handle(app)

/**
 * Bun のローカル開発サーバー entrypoint です。
 */
export default {
  port: Number(getEnv('PORT') ?? 3000),
  fetch: app.fetch,
}
