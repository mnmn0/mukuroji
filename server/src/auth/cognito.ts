import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  GetUserCommand,
  InitiateAuthCommand,
  ListUsersCommand,
  RespondToAuthChallengeCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import type { WorkspaceMemberStatus } from '../workspace-access'

const defaultSystemAdminGroups = ['mukuroji-system-admins']

/** Cognito の認証成功時に返る token set です。 */
export type AuthTokenSet = {
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
export type InitiateAuthResponse = {
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
  /**
   * challenge 継続時に Cognito が返す補助 parameter です。
   */
  ChallengeParameters?: Record<string, string>
}

/**
 * Cognito の NEW_PASSWORD_REQUIRED challenge を完了する入力です。
 */
export type CompleteNewPasswordChallengeRequestBody = {
  /**
   * challenge を開始した Cognito user のメールアドレスです。
   */
  email?: unknown
  /**
   * Cognito が login challenge とともに返した session です。
   */
  session?: unknown
  /**
   * user が設定する恒久 password です。
   */
  newPassword?: unknown
}

/**
 * Cognito ListUserPools のレスポンスです。
 */
export type ListUserPoolsResponse = {
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
  /**
   * 次 page 取得用の Cognito pagination token です。
   */
  NextToken?: string
}

/**
 * Cognito ListUserPoolClients のレスポンスです。
 */
export type ListUserPoolClientsResponse = {
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
  /**
   * 次 page 取得用の Cognito pagination token です。
   */
  NextToken?: string
}

/**
 * Cognito GetUser のレスポンスです。
 */
export type GetUserResponse = {
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
 * Cognito ListUsers / AdminGetUser 相当の user record です。
 */
export type CognitoUserRecord = {
  /**
   * Cognito user pool 内の username です。
   */
  Username?: string
  /**
   * Cognito user attributes です。
   */
  Attributes?: Array<{
    /**
     * 属性名です。
     */
    Name?: string
    /**
     * 属性値です。
     */
    Value?: string
  }>
  /**
   * AdminGetUser が返す Cognito user attributes です。
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
  /**
   * user が有効かどうかです。
   */
  Enabled?: boolean
  /**
   * Cognito user status です。
   */
  UserStatus?: string
}

/**
 * Cognito ListUsers のレスポンスです。
 */
export type ListUsersResponse = {
  /**
   * 取得できた Cognito users です。
   */
  Users?: CognitoUserRecord[]
  /**
   * 次 page 取得用の Cognito pagination token です。
   */
  PaginationToken?: string
}

/** Cognito AdminListGroupsForUser のレスポンスです。 */
export type AdminListGroupsForUserResponse = {
  /** User が所属する group 一覧です。 */
  Groups?: Array<{
    /** Cognito group 名です。 */
    GroupName?: string
  }>
  /** 次 page 取得用の Cognito pagination token です。 */
  NextToken?: string
}

/**
 * Cognito AdminCreateUser のレスポンスです。
 */
export type AdminCreateUserResponse = {
  /**
   * 作成された Cognito user です。
   */
  User?: CognitoUserRecord
}

/**
 * アプリが参照する Cognito user profile です。
 */
export type CognitoUserProfile = {
  /**
   * アプリ内で user 参照に使う正規化済み ID です。
   */
  id: string
  /**
   * Cognito user pool 内の username です。
   */
  username: string
  /**
   * Cognito user のメールアドレスです。
   */
  email: string
  /**
   * Cognito user の表示名です。
   */
  name?: string
  /**
   * Cognito user が有効かどうかです。
   */
  enabled?: boolean
  /**
   * Cognito user status です。
   */
  status?: string
  /**
   * Workspace membership の利用状態です。assignment candidate response で付与します。
   */
  workspaceStatus?: WorkspaceMemberStatus
}

/**
 * Workspace invitation provisioning で参照する Cognito user と directory 情報です。
 */
export type CognitoWorkspaceUser = {
  /**
   * 正規化済み Cognito user profile です。
   */
  profile: CognitoUserProfile
  /**
   * Cognito custom attribute に保存された Workspace directory ID です。
   */
  directoryId?: string
}

/**
 * Cognito user を Workspace invitation 用に準備する入力です。
 */
export type ProvisionCognitoWorkspaceUserInput = {
  /**
   * invitation の宛先メールアドレスです。
   */
  email: string
  /**
   * invitation に指定された表示名です。
   */
  name?: string
  /**
   * Cognito custom attribute に設定する Workspace directory ID です。
   */
  directoryId: string
  /**
   * reservation 前に確認した既存 Cognito user です。
   */
  existingUser?: CognitoWorkspaceUser
}

/**
 * Cognito invitation provisioning の結果です。
 */
export type ProvisionCognitoWorkspaceUserResult = {
  /**
   * invitation と紐付く Cognito user profile です。
   */
  profile: CognitoUserProfile
  /**
   * Cognito identity が Workspace によって新規作成されたかどうかです。
   */
  identityOwnership: 'workspace-created' | 'pre-existing' | 'ambiguous'
  /**
   * Cognito が invitation message を配信したかどうかです。
   */
  deliveryStatus: 'sent' | 'not-required'
}

/**
 * Cognito user 一覧 API が返す response body です。
 */
export type CognitoUsersResponse = {
  /**
   * Cognito を master とする user profile 一覧です。
   */
  users: CognitoUserProfile[]
  /**
   * 次 page 取得用の Cognito pagination token です。
   */
  nextToken?: string
}

/**
 * Cognito user 一覧 API の入力です。
 */
export type ListCognitoUsersInput = {
  /**
   * 候補 user を所属 directory に限定するための directory ID です。
   */
  directoryId?: string
  /**
   * Cognito の pagination token です。
   */
  paginationToken?: string
  /**
   * 1 page で取得する最大件数です。
   */
  limit?: number
  /**
   * email prefix 検索に使う query です。
   */
  query?: string
}

/**
 * Cognito access token の payload から読む claims です。
 */
export type CognitoAccessTokenClaims = {
  /**
   * Cognito グループ名の配列です。
   */
  'cognito:groups'?: unknown
  /**
   * token を発行した Cognito user pool の issuer です。
   */
  iss?: unknown
  /**
   * token を発行した Cognito app client ID です。
   */
  client_id?: unknown
  /**
   * Cognito token の用途です。
   */
  token_use?: unknown
}

/** Cognito JSON API のエラーレスポンスです。 */
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

/** API handler から利用する Cognito client の最小 interface です。 */
export type CognitoClient = {
  /**
   * メールアドレスとパスワードで Cognito 認証を実行します。
   */
  initiatePasswordAuth(email: string, password: string): Promise<InitiateAuthResponse>
  /**
   * NEW_PASSWORD_REQUIRED challenge に恒久 password を応答します。
   */
  respondToNewPasswordChallenge(
    email: string,
    newPassword: string,
    session: string,
  ): Promise<InitiateAuthResponse>
  /**
   * access token から Cognito ユーザー情報を取得します。
   */
  getUser(accessToken: string): Promise<GetUserResponse>
  /**
   * Cognito user pool から user 一覧を page 単位で取得します。
   */
  listUsers(input: ListCognitoUsersInput): Promise<CognitoUsersResponse>
  /**
   * Cognito user ID から user profile を取得します。
   */
  getUserProfile(userId: string): Promise<CognitoUserProfile>
  /**
   * Cognito user が現在 system administrator group に所属するかを返します。
   */
  isSystemAdmin(userId: string): Promise<boolean>
  /**
   * Workspace invitation 対象の Cognito user と directory 属性を検索します。
   */
  findWorkspaceUser(userId: string): Promise<CognitoWorkspaceUser | undefined>
  /**
   * invitation 対象 user を Cognito に作成または既存 identity と安全に関連付けます。
   */
  provisionWorkspaceUser(
    input: ProvisionCognitoWorkspaceUserInput,
  ): Promise<ProvisionCognitoWorkspaceUserResult>
  /**
   * Workspace が作成した未確定 Cognito user の invitation を再送します。
   */
  resendWorkspaceUserInvitation(userId: string): Promise<void>
  /**
   * Workspace が所有する未確定 Cognito user を削除します。
   */
  deleteWorkspaceUser(userId: string): Promise<void>
}

/** Cognito の user-not-found error かを判定します。 */
export function isCognitoUserNotFoundError(error: unknown) {
  return error instanceof CognitoServiceError && error.code === 'UserNotFoundException'
}

/**
 * AWS Cognito Identity Provider SDK を使う本番用 client です。
 */
export class AwsCognitoClient {
  /**
   * SigV4 署名と AWS endpoint 解決を委譲する SDK client です。
   */
  private readonly client: CognitoIdentityProviderClient
  /**
   * API が信頼する Cognito user pool ID です。
   */
  private readonly userPoolId: string | undefined
  /**
   * API が信頼する Cognito app client ID です。
   */
  private readonly clientId: string | undefined

  constructor(
    client = new CognitoIdentityProviderClient({ region: getAwsRegion() }),
    userPoolId = getEnv('COGNITO_USER_POOL_ID'),
    clientId = getEnv('COGNITO_CLIENT_ID'),
  ) {
    this.client = client
    this.userPoolId = userPoolId?.trim() || undefined
    this.clientId = clientId?.trim() || undefined
  }

  /**
   * USER_PASSWORD_AUTH flow で Cognito 認証を実行します。
   */
  async initiatePasswordAuth(email: string, password: string): Promise<InitiateAuthResponse> {
    const { clientId } = this.readRequiredConfiguration()

    try {
      const response = await this.client.send(new InitiateAuthCommand({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: clientId,
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
        },
      }))

      return {
        AuthenticationResult: response.AuthenticationResult,
        ChallengeName: response.ChallengeName,
        Session: response.Session,
      }
    } catch (error) {
      throw toCognitoSdkError(error)
    }
  }

  /**
   * NEW_PASSWORD_REQUIRED challenge に恒久 password を応答します。
   */
  async respondToNewPasswordChallenge(
    email: string,
    newPassword: string,
    session: string,
  ): Promise<InitiateAuthResponse> {
    const { clientId } = this.readRequiredConfiguration()

    try {
      const response = await this.client.send(new RespondToAuthChallengeCommand({
        ChallengeName: 'NEW_PASSWORD_REQUIRED',
        ChallengeResponses: {
          USERNAME: normalizeCognitoUserId(email),
          NEW_PASSWORD: newPassword,
        },
        ClientId: clientId,
        Session: session,
      }))

      return {
        AuthenticationResult: response.AuthenticationResult,
        ChallengeName: response.ChallengeName,
        Session: response.Session,
      }
    } catch (error) {
      throw toCognitoSdkError(error)
    }
  }

  /**
   * access token から Cognito ユーザー情報を取得します。
   */
  async getUser(accessToken: string): Promise<GetUserResponse> {
    this.readRequiredConfiguration()

    try {
      const response = await this.client.send(new GetUserCommand({ AccessToken: accessToken }))

      return {
        Username: response.Username,
        UserAttributes: response.UserAttributes,
      }
    } catch (error) {
      throw toCognitoSdkError(error)
    }
  }

  /**
   * Cognito user pool から所属 workspace が一致する user 一覧を取得します。
   */
  async listUsers(input: ListCognitoUsersInput): Promise<CognitoUsersResponse> {
    const { userPoolId } = this.readRequiredConfiguration()
    const limit = clampCognitoPageLimit(input.limit)
    const query = input.query?.trim()
    const users: CognitoUserProfile[] = []
    let paginationToken = input.paginationToken

    try {
      do {
        const response = await this.client.send(new ListUsersCommand({
          UserPoolId: userPoolId,
          Limit: Math.max(1, limit - users.length),
          ...(paginationToken ? { PaginationToken: paginationToken } : {}),
          ...(query ? { Filter: `"email"^="${escapeCognitoFilterValue(query.toLowerCase())}"` } : {}),
        }))
        const scopedUsers = (response.Users ?? [])
          .filter((user) => isCognitoUserInDirectory(user, input.directoryId))
          .map(toCognitoUserProfile)
          .filter(isDefined)

        users.push(...scopedUsers)
        paginationToken = response.PaginationToken
      } while (users.length < limit && paginationToken)

      return {
        users,
        nextToken: paginationToken,
      }
    } catch (error) {
      throw toCognitoSdkError(error)
    }
  }

  /**
   * Cognito user ID から user profile を取得します。
   */
  async getUserProfile(userId: string): Promise<CognitoUserProfile> {
    const { userPoolId } = this.readRequiredConfiguration()
    const normalizedUserId = normalizeCognitoUserId(userId)

    try {
      const response = await this.client.send(new AdminGetUserCommand({
        UserPoolId: userPoolId,
        Username: normalizedUserId,
      }))
      const profile = toCognitoUserProfile(response)

      if (!profile) {
        throw new CognitoServiceError(
          404,
          'UserNotFoundException',
          `Cognito user "${normalizedUserId}" was not found.`,
        )
      }

      return profile
    } catch (error) {
      throw toCognitoSdkError(error)
    }
  }

  /** Cognito の現在 group membership から system administrator 判定を返します。 */
  async isSystemAdmin(userId: string) {
    const { userPoolId } = this.readRequiredConfiguration()
    const normalizedUserId = normalizeCognitoUserId(userId)
    const configuredGroups = new Set(getSystemAdminGroups())
    let nextToken: string | undefined

    try {
      do {
        const response = await this.client.send(new AdminListGroupsForUserCommand({
          UserPoolId: userPoolId,
          Username: normalizedUserId,
          ...(nextToken ? { NextToken: nextToken } : {}),
        }))
        if ((response.Groups ?? []).some((group) =>
          typeof group.GroupName === 'string' && configuredGroups.has(group.GroupName)
        )) {
          return true
        }
        nextToken = response.NextToken
      } while (nextToken)

      return false
    } catch (error) {
      if (isCognitoUserNotFoundError(error)) {
        return false
      }
      throw toCognitoSdkError(error)
    }
  }

  /**
   * Workspace invitation 対象の Cognito user と directory 属性を検索します。
   */
  async findWorkspaceUser(userId: string): Promise<CognitoWorkspaceUser | undefined> {
    const { userPoolId } = this.readRequiredConfiguration()
    const normalizedUserId = normalizeCognitoUserId(userId)

    try {
      const user = await this.client.send(new AdminGetUserCommand({
        UserPoolId: userPoolId,
        Username: normalizedUserId,
      }))
      const profile = toCognitoUserProfile(user)

      if (!profile) {
        throw new CognitoServiceError(
          502,
          'InvalidCognitoResponse',
          `Cognito user "${normalizedUserId}" did not include a stable profile.`,
        )
      }

      return {
        profile,
        directoryId: readCognitoUserDirectoryId(user),
      }
    } catch (error) {
      const normalizedError = toCognitoSdkError(error)

      if (isCognitoUserNotFoundError(normalizedError)) {
        return undefined
      }

      throw normalizedError
    }
  }

  /**
   * invitation 対象 user を Cognito に作成または既存 identity と安全に関連付けます。
   */
  async provisionWorkspaceUser(
    input: ProvisionCognitoWorkspaceUserInput,
  ): Promise<ProvisionCognitoWorkspaceUserResult> {
    const { userPoolId } = this.readRequiredConfiguration()
    const email = normalizeCognitoUserId(input.email)
    const existingUser = input.existingUser ?? await this.findWorkspaceUser(email)

    if (existingUser) {
      this.requireCompatibleWorkspaceDirectory(existingUser, input.directoryId)
      await this.updateWorkspaceUserAttributes(email, input.directoryId, input.name)

      return {
        profile: {
          ...existingUser.profile,
          name: input.name?.trim() || existingUser.profile.name,
        },
        identityOwnership: 'pre-existing',
        deliveryStatus: 'not-required',
      }
    }

    try {
      const response = await this.client.send(new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: email,
        DesiredDeliveryMediums: ['EMAIL'],
        UserAttributes: createWorkspaceCognitoUserAttributes(email, input.directoryId, input.name),
      }))
      const profile = response.User ? toCognitoUserProfile(response.User) : undefined

      return {
        profile: profile ?? {
          id: email,
          username: email,
          email,
          name: input.name?.trim() || undefined,
          enabled: true,
          status: 'FORCE_CHANGE_PASSWORD',
        },
        identityOwnership: 'workspace-created',
        deliveryStatus: 'sent',
      }
    } catch (error) {
      const normalizedError = toCognitoSdkError(error)

      if (normalizedError.code !== 'UsernameExistsException') {
        throw normalizedError
      }

      const racedUser = await this.findWorkspaceUser(email)

      if (!racedUser) {
        throw normalizedError
      }

      this.requireCompatibleWorkspaceDirectory(racedUser, input.directoryId)
      await this.updateWorkspaceUserAttributes(email, input.directoryId, input.name)

      if (racedUser.profile.status === 'FORCE_CHANGE_PASSWORD') {
        await this.resendWorkspaceUserInvitation(racedUser.profile.username)
      }

      return {
        profile: racedUser.profile,
        identityOwnership: 'ambiguous',
        deliveryStatus: racedUser.profile.status === 'FORCE_CHANGE_PASSWORD'
          ? 'sent'
          : 'not-required',
      }
    }
  }

  /**
   * Workspace が作成した未確定 Cognito user の invitation を再送します。
   */
  async resendWorkspaceUserInvitation(userId: string): Promise<void> {
    const { userPoolId } = this.readRequiredConfiguration()

    try {
      await this.client.send(new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: normalizeCognitoUserId(userId),
        MessageAction: 'RESEND',
        DesiredDeliveryMediums: ['EMAIL'],
      }))
    } catch (error) {
      throw toCognitoSdkError(error)
    }
  }

  /**
   * Workspace が所有する未確定 Cognito user を削除します。
   */
  async deleteWorkspaceUser(userId: string): Promise<void> {
    const { userPoolId } = this.readRequiredConfiguration()

    try {
      await this.client.send(new AdminDeleteUserCommand({
        UserPoolId: userPoolId,
        Username: normalizeCognitoUserId(userId),
      }))
    } catch (error) {
      const normalizedError = toCognitoSdkError(error)

      if (!isCognitoUserNotFoundError(normalizedError)) {
        throw normalizedError
      }
    }
  }

  /**
   * 既存 Cognito user が別 Workspace に所属していないことを検証します。
   */
  private requireCompatibleWorkspaceDirectory(user: CognitoWorkspaceUser, directoryId: string) {
    if (!user.directoryId || user.directoryId === directoryId) {
      return
    }

    throw new CognitoServiceError(
      409,
      'WorkspaceDirectoryConflict',
      `Cognito user "${user.profile.id}" already belongs to another Workspace.`,
    )
  }

  /**
   * 既存 Cognito user に Workspace directory と表示属性を設定します。
   */
  private async updateWorkspaceUserAttributes(userId: string, directoryId: string, name?: string) {
    const { userPoolId } = this.readRequiredConfiguration()

    try {
      await this.client.send(new AdminUpdateUserAttributesCommand({
        UserPoolId: userPoolId,
        Username: normalizeCognitoUserId(userId),
        UserAttributes: createWorkspaceCognitoUserAttributes(userId, directoryId, name),
      }))
    } catch (error) {
      throw toCognitoSdkError(error)
    }
  }

  /**
   * 本番 Cognito client に必須の user pool / app client 設定を検証します。
   */
  private readRequiredConfiguration() {
    if (!this.userPoolId || !this.clientId) {
      throw new CognitoServiceError(
        503,
        'CognitoConfigurationMissing',
        'COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID are required.',
      )
    }

    return {
      userPoolId: this.userPoolId,
      clientId: this.clientId,
    }
  }
}

/**
 * Floci の Cognito JSON API を呼び出す軽量 client です。
 */
export class FlociCognitoClient {
  /**
   * Floci / Cognito の endpoint URL です。
   */
  private readonly endpoint: string

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

  constructor(endpoint: string) {
    this.endpoint = trimTrailingSlash(endpoint)
  }

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
   * NEW_PASSWORD_REQUIRED challenge に恒久 password を応答します。
   */
  async respondToNewPasswordChallenge(email: string, newPassword: string, session: string) {
    return this.request<InitiateAuthResponse>('RespondToAuthChallenge', {
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      ChallengeResponses: {
        USERNAME: normalizeCognitoUserId(email),
        NEW_PASSWORD: newPassword,
      },
      ClientId: await this.resolveClientId(),
      Session: session,
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
   * Cognito user pool から user 一覧を page 単位で取得します。
   */
  async listUsers(input: ListCognitoUsersInput) {
    const userPoolId = await this.resolveUserPoolId()
    const limit = clampCognitoPageLimit(input.limit)
    const query = input.query?.trim()
    const users: CognitoUserProfile[] = []
    let paginationToken = input.paginationToken

    do {
      const response = await this.request<ListUsersResponse>('ListUsers', {
        UserPoolId: userPoolId,
        Limit: Math.max(1, limit - users.length),
        ...(paginationToken ? { PaginationToken: paginationToken } : {}),
        ...(query ? { Filter: `"email"^="${escapeCognitoFilterValue(query.toLowerCase())}"` } : {}),
      })
      const scopedUsers = (response.Users ?? [])
        .filter((user) => isCognitoUserInDirectory(user, input.directoryId))
        .map(toCognitoUserProfile)
        .filter(isDefined)

      users.push(...scopedUsers)
      paginationToken = response.PaginationToken
    } while (users.length < limit && paginationToken)

    return {
      users,
      nextToken: paginationToken,
    } satisfies CognitoUsersResponse
  }

  /**
   * Cognito user ID から user profile を取得します。
   */
  async getUserProfile(userId: string) {
    const normalizedUserId = normalizeCognitoUserId(userId)
    const profile = toCognitoUserProfile(await this.request<CognitoUserRecord>('AdminGetUser', {
      UserPoolId: await this.resolveUserPoolId(),
      Username: normalizedUserId,
    }))

    if (!profile) {
      throw new CognitoServiceError(
        404,
        'UserNotFoundException',
        `Cognito user "${normalizedUserId}" was not found.`,
      )
    }

    return profile
  }

  /** Cognito の現在 group membership から system administrator 判定を返します。 */
  async isSystemAdmin(userId: string) {
    const normalizedUserId = normalizeCognitoUserId(userId)
    const configuredGroups = new Set(getSystemAdminGroups())
    let nextToken: string | undefined

    try {
      do {
        const response = await this.request<AdminListGroupsForUserResponse>(
          'AdminListGroupsForUser',
          {
            UserPoolId: await this.resolveUserPoolId(),
            Username: normalizedUserId,
            ...(nextToken ? { NextToken: nextToken } : {}),
          },
        )
        if ((response.Groups ?? []).some((group) =>
          typeof group.GroupName === 'string' && configuredGroups.has(group.GroupName)
        )) {
          return true
        }
        nextToken = response.NextToken
      } while (nextToken)

      return false
    } catch (error) {
      if (isCognitoUserNotFoundError(error)) {
        return false
      }
      throw error
    }
  }

  /**
   * Workspace invitation 対象の Cognito user と directory 属性を検索します。
   */
  async findWorkspaceUser(userId: string) {
    const normalizedUserId = normalizeCognitoUserId(userId)

    try {
      const user = await this.request<CognitoUserRecord>('AdminGetUser', {
        UserPoolId: await this.resolveUserPoolId(),
        Username: normalizedUserId,
      })
      const profile = toCognitoUserProfile(user)

      if (!profile) {
        throw new CognitoServiceError(
          502,
          'InvalidCognitoResponse',
          `Cognito user "${normalizedUserId}" did not include a stable profile.`,
        )
      }

      return {
        profile,
        directoryId: readCognitoUserDirectoryId(user),
      } satisfies CognitoWorkspaceUser
    } catch (error) {
      if (isCognitoUserNotFoundError(error)) {
        return undefined
      }

      throw error
    }
  }

  /**
   * invitation 対象 user を Cognito に作成または既存 identity と安全に関連付けます。
   */
  async provisionWorkspaceUser(input: ProvisionCognitoWorkspaceUserInput) {
    const email = normalizeCognitoUserId(input.email)
    const existingUser = input.existingUser ?? await this.findWorkspaceUser(email)

    if (existingUser) {
      this.requireCompatibleWorkspaceDirectory(existingUser, input.directoryId)
      await this.updateWorkspaceUserAttributes(email, input.directoryId, input.name)

      return {
        profile: {
          ...existingUser.profile,
          name: input.name?.trim() || existingUser.profile.name,
        },
        identityOwnership: 'pre-existing',
        deliveryStatus: 'not-required',
      } satisfies ProvisionCognitoWorkspaceUserResult
    }

    try {
      const response = await this.request<AdminCreateUserResponse>('AdminCreateUser', {
        UserPoolId: await this.resolveUserPoolId(),
        Username: email,
        DesiredDeliveryMediums: ['EMAIL'],
        UserAttributes: createWorkspaceCognitoUserAttributes(email, input.directoryId, input.name),
      })
      const profile = response.User ? toCognitoUserProfile(response.User) : undefined

      return {
        profile: profile ?? {
          id: email,
          username: email,
          email,
          name: input.name?.trim() || undefined,
          enabled: true,
          status: 'FORCE_CHANGE_PASSWORD',
        },
        identityOwnership: 'workspace-created',
        deliveryStatus: 'sent',
      } satisfies ProvisionCognitoWorkspaceUserResult
    } catch (error) {
      if (!(error instanceof CognitoServiceError) || error.code !== 'UsernameExistsException') {
        throw error
      }

      const racedUser = await this.findWorkspaceUser(email)

      if (!racedUser) {
        throw error
      }

      this.requireCompatibleWorkspaceDirectory(racedUser, input.directoryId)
      await this.updateWorkspaceUserAttributes(email, input.directoryId, input.name)

      if (racedUser.profile.status === 'FORCE_CHANGE_PASSWORD') {
        await this.resendWorkspaceUserInvitation(racedUser.profile.username)
      }

      return {
        profile: racedUser.profile,
        identityOwnership: 'ambiguous',
        deliveryStatus: racedUser.profile.status === 'FORCE_CHANGE_PASSWORD'
          ? 'sent'
          : 'not-required',
      } satisfies ProvisionCognitoWorkspaceUserResult
    }
  }

  /**
   * Workspace が作成した未確定 Cognito user の invitation を再送します。
   */
  async resendWorkspaceUserInvitation(userId: string) {
    await this.request<AdminCreateUserResponse>('AdminCreateUser', {
      UserPoolId: await this.resolveUserPoolId(),
      Username: normalizeCognitoUserId(userId),
      MessageAction: 'RESEND',
      DesiredDeliveryMediums: ['EMAIL'],
    })
  }

  /**
   * Workspace が所有する未確定 Cognito user を削除します。
   */
  async deleteWorkspaceUser(userId: string) {
    try {
      await this.request<Record<string, never>>('AdminDeleteUser', {
        UserPoolId: await this.resolveUserPoolId(),
        Username: normalizeCognitoUserId(userId),
      })
    } catch (error) {
      if (!isCognitoUserNotFoundError(error)) {
        throw error
      }
    }
  }

  /**
   * 既存 Cognito user が別 Workspace に所属していないことを検証します。
   */
  private requireCompatibleWorkspaceDirectory(user: CognitoWorkspaceUser, directoryId: string) {
    if (!user.directoryId || user.directoryId === directoryId) {
      return
    }

    throw new CognitoServiceError(
      409,
      'WorkspaceDirectoryConflict',
      `Cognito user "${user.profile.id}" already belongs to another Workspace.`,
    )
  }

  /**
   * 既存 Cognito user に Workspace directory と表示属性を設定します。
   */
  private async updateWorkspaceUserAttributes(userId: string, directoryId: string, name?: string) {
    await this.request<Record<string, never>>('AdminUpdateUserAttributes', {
      UserPoolId: await this.resolveUserPoolId(),
      Username: normalizeCognitoUserId(userId),
      UserAttributes: createWorkspaceCognitoUserAttributes(userId, directoryId, name),
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
    let nextToken: string | undefined

    do {
      const response = await this.request<ListUserPoolClientsResponse>('ListUserPoolClients', {
        UserPoolId: userPoolId,
        MaxResults: 60,
        ...(nextToken ? { NextToken: nextToken } : {}),
      })
      const client = response.UserPoolClients?.find(
        (candidate) => candidate.ClientName === this.clientName,
      )

      if (client?.ClientId) {
        this.resolvedClientId = client.ClientId
        return this.resolvedClientId
      }

      nextToken = response.NextToken
    } while (nextToken)

    throw new CognitoServiceError(
      404,
      'ClientNotFoundException',
      `Cognito user pool client "${this.clientName}" was not found.`,
    )
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

    let nextToken: string | undefined

    do {
      const response = await this.request<ListUserPoolsResponse>('ListUserPools', {
        MaxResults: 60,
        ...(nextToken ? { NextToken: nextToken } : {}),
      })
      const userPool = response.UserPools?.find(
        (candidate) => candidate.Name === this.userPoolName,
      )

      if (userPool?.Id) {
        this.resolvedUserPoolId = userPool.Id
        return this.resolvedUserPoolId
      }

      nextToken = response.NextToken
    } while (nextToken)

    throw new CognitoServiceError(
      404,
      'ResourceNotFoundException',
      `Cognito user pool "${this.userPoolName}" was not found.`,
    )
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
 * Floci Cognito との通信で扱う domain error です。
 */
export class CognitoServiceError extends Error {
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

function toCognitoSdkError(error: unknown) {
  if (error instanceof CognitoServiceError) {
    return error
  }

  const metadata = isRecord(error) && isRecord(error.$metadata)
    ? error.$metadata
    : undefined
  const status = typeof metadata?.httpStatusCode === 'number'
    ? metadata.httpStatusCode
    : 502
  const code = isRecord(error) && typeof error.name === 'string'
    ? error.name
    : 'CognitoUnavailable'
  const message = isRecord(error) && typeof error.message === 'string'
    ? error.message
    : 'Cognito request failed.'

  return new CognitoServiceError(status, code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

/** Cognito page size を API の許容範囲へ収めます。 */
export function clampCognitoPageLimit(value: number | undefined) {
  if (!Number.isFinite(value)) {
    return 20
  }

  return Math.min(60, Math.max(1, Math.floor(value)))
}

function escapeCognitoFilterValue(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Cognito user ID を比較・検索用に正規化します。 */
export function normalizeCognitoUserId(value: string) {
  const normalized = value.trim().toLowerCase()

  if (!normalized) {
    throw new CognitoServiceError(400, 'InvalidParameterException', 'Cognito user ID is required.')
  }

  return normalized
}

function toCognitoUserProfile(value: CognitoUserRecord): CognitoUserProfile | undefined {
  const username = value.Username?.trim()
  const email = readCognitoUserAttribute(value, 'email')?.trim().toLowerCase()

  if (!username || !email) {
    return undefined
  }

  return {
    id: normalizeCognitoUserId(email),
    username,
    email,
    name: readCognitoUserAttribute(value, 'name')?.trim() || undefined,
    enabled: value.Enabled,
    status: value.UserStatus,
  }
}

function readCognitoUserAttribute(user: CognitoUserRecord, name: string) {
  return (user.Attributes ?? user.UserAttributes)?.find((attribute) => attribute.Name === name)?.Value
}

function readCognitoUserDirectoryId(user: CognitoUserRecord) {
  const directoryId = readCognitoUserAttribute(user, 'custom:directory_id')?.trim() || undefined
  const workspaceId = readCognitoUserAttribute(user, 'custom:workspace_id')?.trim() || undefined

  if (directoryId && workspaceId && directoryId !== workspaceId) {
    throw new CognitoServiceError(
      409,
      'WorkspaceDirectoryConflict',
      'Cognito user has conflicting Workspace directory attributes.',
    )
  }

  return directoryId ?? workspaceId
}

function createWorkspaceCognitoUserAttributes(email: string, directoryId: string, name?: string) {
  return [
    { Name: 'email', Value: normalizeCognitoUserId(email) },
    { Name: 'custom:directory_id', Value: directoryId },
    { Name: 'custom:workspace_id', Value: directoryId },
    ...(name?.trim() ? [{ Name: 'name', Value: name.trim() }] : []),
  ]
}

function isCognitoUserInDirectory(user: CognitoUserRecord, directoryId: string | undefined) {
  if (!directoryId) {
    return true
  }

  const claimedDirectoryId = readCognitoUserAttribute(user, 'custom:directory_id')?.trim() || undefined
  const claimedWorkspaceId = readCognitoUserAttribute(user, 'custom:workspace_id')?.trim() || undefined

  if (
    claimedDirectoryId &&
    claimedWorkspaceId &&
    claimedDirectoryId !== claimedWorkspaceId
  ) {
    return false
  }

  return (claimedDirectoryId ?? claimedWorkspaceId) === directoryId
}

/** 設定済みの system administrator group 名を返します。 */
export function getSystemAdminGroups() {
  const configuredGroups = (
    getEnv('MUKUROJI_SYSTEM_ADMIN_GROUPS') ??
    getEnv('SYSTEM_ADMIN_GROUPS') ??
    ''
  )
    .split(',')
    .map((group) => group.trim())
    .filter(Boolean)

  return configuredGroups.length > 0 ? configuredGroups : defaultSystemAdminGroups
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function getAwsRegion() {
  return getEnv('AWS_REGION') ?? getEnv('AWS_DEFAULT_REGION') ?? 'us-east-1'
}

function getCognitoEndpoint() {
  const configuredEndpoint = getEnv('COGNITO_ENDPOINT') ?? getEnv('AWS_ENDPOINT_URL')

  if (configuredEndpoint?.trim()) {
    return trimTrailingSlash(configuredEndpoint.trim())
  }

  return typeof Bun !== 'undefined' && !getEnv('AWS_LAMBDA_FUNCTION_NAME')
    ? 'http://localhost:4566'
    : undefined
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

/** 実行環境に応じた Cognito client を生成します。 */
export function createCognitoClient(): CognitoClient {
  const endpoint = getCognitoEndpoint()

  return endpoint
    ? new FlociCognitoClient(endpoint)
    : new AwsCognitoClient()
}
