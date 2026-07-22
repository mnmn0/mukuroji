import {
  loadServerConfig,
} from '../../../../infrastructure/config/server-config'
import type {
  EnterpriseCognitoFederationBinding,
} from '../../../enterprise-identity'
import type {
  WorkspaceIdentityOwnership,
  WorkspaceMemberStatus,
} from '../../../workspace-access'
import {
  resolveCognitoMfaResponseKey,
} from '../../domain/mfa-challenge'
import type {
  CognitoMfaChallengeName,
} from '../../domain/mfa-challenge'
import {
  AdminCreateUserCommand,
  AdminDeleteUserAttributesCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminUpdateUserAttributesCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  DescribeIdentityProviderCommand,
  DescribeUserPoolClientCommand,
  GetUserCommand,
  InitiateAuthCommand,
  ListUsersCommand,
  RespondToAuthChallengeCommand,
} from '@aws-sdk/client-cognito-identity-provider'

/**
 * Cognito の認証成功時に返る token set です。
 */
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
  /**
   * 次 page 取得用の Cognito pagination token です。
   */
  NextToken?: string
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
type CognitoUserRecord = {
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
  /**
   * AdminGetUser が返す現在の MFA setting 一覧です。
   */
  UserMFASettingList?: string[]
  /**
   * AdminGetUser が返す preferred MFA setting です。
   */
  PreferredMfaSetting?: string
}

/**
 * Cognito ListUsers のレスポンスです。
 */
type ListUsersResponse = {
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
type AdminListGroupsForUserResponse = {
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
type AdminCreateUserResponse = {
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
   * Cognito で MFA enrollment が一つ以上確認できたかどうかです。
   */
  mfaConfigured?: boolean
  /**
   * Workspace membership の利用状態です。assignment candidate response で付与します。
   */
  workspaceStatus?: WorkspaceMemberStatus
}

/**
 * Workspace invitation provisioning で参照する Cognito user と directory 情報です。
 */
type CognitoWorkspaceUser = {
  /**
   * 正規化済み Cognito user profile です。
   */
  profile: CognitoUserProfile
  /** Cognito の `sub` attribute から取得した安定 identity ID です。 */
  identityId?: string
  /**
   * Cognito custom attribute に保存された Workspace directory ID です。
   */
  directoryId?: string
}

/**
 * Cognito user を Workspace invitation 用に準備する入力です。
 */
type ProvisionCognitoWorkspaceUserInput = {
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
  /**
   * 既存 identity へ directory claim を書く直前に補償責務を永続化します。
   */
  beforeDirectoryClaimUpdate: (
    cognitoIdentityId: string,
    cognitoUsername: string,
  ) => Promise<void>
}

/**
 * Cognito invitation provisioning の結果です。
 */
type ProvisionCognitoWorkspaceUserResult = {
  /**
   * invitation と紐付く Cognito user profile です。
   */
  profile: CognitoUserProfile
  /** provisioning 対象となった Cognito identity の安定 ID です。 */
  cognitoIdentityId: string
  /** provisioning 対象となった大文字小文字を保持した Cognito username です。 */
  cognitoUsername: string
  /**
   * Cognito identity が Workspace によって新規作成されたかどうかです。
   */
  identityOwnership: WorkspaceIdentityOwnership
  /**
   * この provisioning が既存 identity に Workspace directory claim を追加したかどうかです。
   */
  directoryClaimCleanupRequired: boolean
  /**
   * Cognito が invitation message を配信したかどうかです。
   */
  deliveryStatus: 'sent' | 'not-required'
}

/**
 * revoke 時に Cognito identity を検索して補償する入力です。
 */
type CognitoWorkspaceUserCleanupInput = {
  /**
   * invitation の宛先として検索する Cognito user ID です。
   */
  userId: string
  /**
   * 削除対象 claim の Workspace directory ID です。
   */
  directoryId: string
  /** provisioning 時に保存した Cognito identity の安定 ID です。 */
  cognitoIdentityId: string
  /** provisioning 時に保存した大文字小文字を保持した Cognito username です。 */
  cognitoUsername: string
}

/** Cognito user 削除処理の安全な結果です。 */
type DeleteCognitoWorkspaceUserResult =
  | 'deleted'
  | 'absent'
  | 'preserved'
  | 'manual-required'

/** Cognito directory claim 解除処理の安全な結果です。 */
type UnlinkCognitoWorkspaceUserResult = 'completed' | 'manual-required'

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
 * Cognito Hosted UI 専用 app client の検証対象 contract です。
 */
export type EnterpriseCognitoSsoAppClientBinding = {
  /** Cognito app client ID です。 */
  clientId: string
  /** Client secret を持つ confidential client かどうかです。 */
  hasClientSecret: boolean
  /** Hosted UI で選択可能な identity provider 名です。 */
  supportedIdentityProviders: string[]
  /** User Pool OAuth server が有効かどうかです。 */
  allowedOAuthFlowsUserPoolClient: boolean
  /** App client が許可する OAuth flow です。 */
  allowedOAuthFlows: string[]
  /** App client が許可する OAuth scope です。 */
  allowedOAuthScopes: string[]
  /** Cognito InitiateAuth で許可する explicit auth flow です。 */
  explicitAuthFlows: string[]
  /** App client に登録された callback URI です。 */
  callbackUrls: string[]
}

/**
 * API handler から利用する Cognito client の最小 interface です。
 */
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
   * SOFTWARE_TOKEN_MFA / SMS_MFA / OTP challenge に one-time code を応答します。
   */
  respondToMfaChallenge(
    email: string,
    challenge: CognitoMfaChallengeName,
    code: string,
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
   * Cognito user が現在所属する全 group 名を返します。
   */
  getUserGroups(userId: string): Promise<string[]>
  /**
   * Cognito User Pool に実在する federation provider 設定を返します。
   */
  describeEnterpriseIdentityProvider?(
    providerName: string,
  ): Promise<EnterpriseCognitoFederationBinding>
  /**
   * Enterprise Hosted UI 専用 app client の OAuth/provider contract を返します。
   */
  describeEnterpriseSsoAppClient?(
    clientId: string,
  ): Promise<EnterpriseCognitoSsoAppClientBinding>
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
   * Workspace が作成した未確定 Cognito username へ invitation を再送します。
   */
  resendWorkspaceUserInvitation(username: string): Promise<void>
  /**
   * Workspace が作成した未確定 user だけを削除します。
   */
  deleteWorkspaceUser(
    input: CognitoWorkspaceUserCleanupInput,
  ): Promise<DeleteCognitoWorkspaceUserResult>
  /**
   * invitation が追加した Workspace directory claim を解除します。
   */
  unlinkWorkspaceUser(
    input: CognitoWorkspaceUserCleanupInput,
  ): Promise<UnlinkCognitoWorkspaceUserResult>
  /**
   * Directory deprovisioning 後に Cognito user の新規認証を停止します。
   */
  disableWorkspaceUser?(userId: string): Promise<void>
  /**
   * Directory reactivation 後に Cognito user の認証を再開します。
   */
  enableWorkspaceUser?(userId: string): Promise<void>
  /**
   * Directory deprovisioning 後に Cognito refresh token を全失効させます。
   */
  globallySignOutWorkspaceUser?(userId: string): Promise<void>
}

const defaultSystemAdminGroups = ['mukuroji-system-admins']

/**
 * Determines whether a Cognito operation failed because the user does not exist.
 *
 * @param error - Error value caught from a Cognito operation.
 * @returns Whether the value is the stable Cognito user-not-found error.
 */
export function isCognitoUserNotFoundError(error: unknown) {
  return error instanceof CognitoServiceError && error.code === 'UserNotFoundException'
}

/**
 * AWS Cognito Identity Provider SDK を使う本番用 client です。
 */
export class AwsCognitoClient implements CognitoClient {
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
        ChallengeParameters: response.ChallengeParameters,
      }
    } catch (error) {
      throw toCognitoSdkError(error)
    }
  }

  /**
   * Cognito MFA/OTP challenge に one-time code を応答します。
   */
  async respondToMfaChallenge(
    email: string,
    challenge: CognitoMfaChallengeName,
    code: string,
    session: string,
  ): Promise<InitiateAuthResponse> {
    const { clientId } = this.readRequiredConfiguration()
    const responseKey = resolveCognitoMfaResponseKey(challenge)
    try {
      const response = await this.client.send(new RespondToAuthChallengeCommand({
        ChallengeName: challenge,
        ChallengeResponses: {
          USERNAME: normalizeCognitoUserId(email),
          [responseKey]: code,
        },
        ClientId: clientId,
        Session: session,
      }))
      return {
        AuthenticationResult: response.AuthenticationResult,
        ChallengeName: response.ChallengeName,
        Session: response.Session,
        ChallengeParameters: response.ChallengeParameters,
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

  /** Cognito User Pool に実在する federation provider 設定を返します。 */
  async describeEnterpriseIdentityProvider(providerName: string) {
    const { userPoolId } = this.readRequiredConfiguration()
    try {
      const response = await this.client.send(new DescribeIdentityProviderCommand({
        UserPoolId: userPoolId,
        ProviderName: providerName,
      }))
      const described = response.IdentityProvider
      if (!described?.ProviderName || !described.ProviderType) {
        throw new CognitoServiceError(
          503,
          'CognitoIdentityProviderInvalid',
          'Cognito identity provider response is incomplete.',
        )
      }
      return {
        providerName: described.ProviderName,
        providerType: described.ProviderType,
        providerDetails: Object.fromEntries(
          Object.entries(described.ProviderDetails ?? {})
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        ),
      }
    } catch (error) {
      if (error instanceof CognitoServiceError) throw error
      throw toCognitoSdkError(error)
    }
  }

  /** Enterprise Hosted UI 専用 app client の OAuth/provider contract を返します。 */
  async describeEnterpriseSsoAppClient(clientId: string) {
    const { userPoolId } = this.readRequiredConfiguration()
    try {
      const response = await this.client.send(new DescribeUserPoolClientCommand({
        UserPoolId: userPoolId,
        ClientId: clientId,
      }))
      const described = response.UserPoolClient
      if (described?.ClientId !== clientId) {
        throw new CognitoServiceError(
          503,
          'CognitoSsoAppClientInvalid',
          'Cognito SSO app client response is incomplete.',
        )
      }
      return {
        clientId: described.ClientId,
        hasClientSecret: Boolean(described.ClientSecret),
        supportedIdentityProviders: [...(described.SupportedIdentityProviders ?? [])],
        allowedOAuthFlowsUserPoolClient: described.AllowedOAuthFlowsUserPoolClient === true,
        allowedOAuthFlows: [...(described.AllowedOAuthFlows ?? [])],
        allowedOAuthScopes: [...(described.AllowedOAuthScopes ?? [])],
        explicitAuthFlows: [...(described.ExplicitAuthFlows ?? [])],
        callbackUrls: [...(described.CallbackURLs ?? [])],
      }
    } catch (error) {
      if (error instanceof CognitoServiceError) throw error
      throw toCognitoSdkError(error)
    }
  }

  /** Directory deprovisioning 後に Cognito user の新規認証を停止します。 */
  async disableWorkspaceUser(userId: string) {
    const { userPoolId } = this.readRequiredConfiguration()

    try {
      await this.client.send(new AdminDisableUserCommand({
        UserPoolId: userPoolId,
        Username: normalizeCognitoUserId(userId),
      }))
    } catch (error) {
      throw toCognitoSdkError(error)
    }
  }

  /** Directory reactivation 後に Cognito user の認証を再開します。 */
  async enableWorkspaceUser(userId: string) {
    const { userPoolId } = this.readRequiredConfiguration()

    try {
      await this.client.send(new AdminEnableUserCommand({
        UserPoolId: userPoolId,
        Username: normalizeCognitoUserId(userId),
      }))
    } catch (error) {
      throw toCognitoSdkError(error)
    }
  }

  /** Directory deprovisioning 後に Cognito refresh token を全失効させます。 */
  async globallySignOutWorkspaceUser(userId: string) {
    const { userPoolId } = this.readRequiredConfiguration()

    try {
      await this.client.send(new AdminUserGlobalSignOutCommand({
        UserPoolId: userPoolId,
        Username: normalizeCognitoUserId(userId),
      }))
    } catch (error) {
      throw toCognitoSdkError(error)
    }
  }

  /** Cognito の現在 group membership を全 page から取得します。 */
  async getUserGroups(userId: string) {
    const { userPoolId } = this.readRequiredConfiguration()
    const normalizedUserId = normalizeCognitoUserId(userId)
    const groups = new Set<string>()
    let nextToken: string | undefined

    try {
      do {
        const response = await this.client.send(new AdminListGroupsForUserCommand({
          UserPoolId: userPoolId,
          Username: normalizedUserId,
          ...(nextToken ? { NextToken: nextToken } : {}),
        }))
        for (const group of response.Groups ?? []) {
          if (typeof group.GroupName === 'string' && group.GroupName.trim()) {
            groups.add(group.GroupName)
          }
        }
        nextToken = response.NextToken
      } while (nextToken)

      return [...groups]
    } catch (error) {
      throw toCognitoSdkError(error)
    }
  }

  /** Cognito の現在 group membership から system administrator 判定を返します。 */
  async isSystemAdmin(userId: string) {
    try {
      const configuredGroups = new Set(getSystemAdminGroups())
      return (await this.getUserGroups(userId)).some((group) =>
        configuredGroups.has(group)
      )
    } catch (error) {
      if (isCognitoUserNotFoundError(error)) return false
      throw error
    }
  }

  /**
   * Workspace invitation 対象の Cognito user と directory 属性を検索します。
   */
  async findWorkspaceUser(userId: string): Promise<CognitoWorkspaceUser | undefined> {
    return this.findWorkspaceUserByUsername(normalizeCognitoUserId(userId))
  }

  /** Cognito username または stable sub を大文字小文字を変えずに検索します。 */
  private async findWorkspaceUserByUsername(
    username: string,
  ): Promise<CognitoWorkspaceUser | undefined> {
    const { userPoolId } = this.readRequiredConfiguration()
    const normalizedUsername = requireCognitoUsername(username)

    try {
      const user = await this.client.send(new AdminGetUserCommand({
        UserPoolId: userPoolId,
        Username: normalizedUsername,
      }))
      const profile = toCognitoUserProfile(user)

      if (!profile) {
        throw new CognitoServiceError(
          502,
          'InvalidCognitoResponse',
          `Cognito user "${normalizedUsername}" did not include a stable profile.`,
        )
      }

      return {
        profile,
        identityId: readCognitoUserAttribute(user, 'sub')?.trim() || undefined,
        directoryId: readCognitoUserDirectoryId(user),
      }
    } catch (error) {
      const cognitoError = toCognitoSdkError(error)

      if (isCognitoUserNotFoundError(cognitoError)) {
        return undefined
      }

      throw cognitoError
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
      requireEnabledWorkspaceUser(existingUser)
      const cognitoIdentityId = requireCognitoIdentityId(existingUser.identityId)
      if (!existingUser.directoryId) {
        await input.beforeDirectoryClaimUpdate(
          cognitoIdentityId,
          existingUser.profile.username,
        )
      }
      await this.updateWorkspaceUserAttributes(
        existingUser.profile.username,
        email,
        input.directoryId,
        input.name,
      )

      return {
        profile: {
          ...existingUser.profile,
          name: input.name?.trim() || existingUser.profile.name,
        },
        cognitoIdentityId,
        cognitoUsername: requireCognitoUsername(existingUser.profile.username),
        identityOwnership: 'pre-existing',
        directoryClaimCleanupRequired: !existingUser.directoryId,
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
        cognitoIdentityId: requireCognitoIdentityId(
          response.User ? readCognitoUserAttribute(response.User, 'sub') : undefined,
        ),
        cognitoUsername: requireCognitoUsername(profile?.username ?? email),
        identityOwnership: 'workspace-created',
        directoryClaimCleanupRequired: false,
        deliveryStatus: 'sent',
      }
    } catch (error) {
      const cognitoError = toCognitoSdkError(error)

      if (cognitoError.code !== 'UsernameExistsException') {
        throw cognitoError
      }

      const racedUser = await this.findWorkspaceUser(email)

      if (!racedUser) {
        throw cognitoError
      }

      this.requireCompatibleWorkspaceDirectory(racedUser, input.directoryId)
      requireEnabledWorkspaceUser(racedUser)
      const cognitoIdentityId = requireCognitoIdentityId(racedUser.identityId)
      if (!racedUser.directoryId) {
        await input.beforeDirectoryClaimUpdate(
          cognitoIdentityId,
          racedUser.profile.username,
        )
      }
      await this.updateWorkspaceUserAttributes(
        racedUser.profile.username,
        email,
        input.directoryId,
        input.name,
      )

      if (racedUser.profile.status === 'FORCE_CHANGE_PASSWORD') {
        await this.resendWorkspaceUserInvitation(racedUser.profile.username)
      }

      return {
        profile: racedUser.profile,
        cognitoIdentityId,
        cognitoUsername: requireCognitoUsername(racedUser.profile.username),
        identityOwnership: 'ambiguous',
        directoryClaimCleanupRequired: !racedUser.directoryId,
        deliveryStatus: racedUser.profile.status === 'FORCE_CHANGE_PASSWORD'
          ? 'sent'
          : 'not-required',
      }
    }
  }

  /**
   * Workspace が作成した未確定 Cognito username へ invitation を再送します。
   */
  async resendWorkspaceUserInvitation(username: string): Promise<void> {
    const { userPoolId } = this.readRequiredConfiguration()

    try {
      await this.client.send(new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: requireCognitoUsername(username),
        MessageAction: 'RESEND',
        DesiredDeliveryMediums: ['EMAIL'],
      }))
    } catch (error) {
      throw toCognitoSdkError(error)
    }
  }

  /** Workspace が作成した未確定 user だけを削除します。 */
  async deleteWorkspaceUser(
    input: CognitoWorkspaceUserCleanupInput,
  ): Promise<DeleteCognitoWorkspaceUserResult> {
    const { userPoolId } = this.readRequiredConfiguration()
    // Cognito sub を stable lookup key として Username parameter へ意図的に渡します。
    const stableIdentityUsername = requireCognitoIdentityId(input.cognitoIdentityId)
    const canonicalUsername = requireCognitoUsername(input.cognitoUsername)
    const currentUser = await this.findWorkspaceUserByUsername(stableIdentityUsername)

    if (!currentUser && canonicalUsername !== stableIdentityUsername) {
      const canonicalUser = await this.findWorkspaceUserByUsername(canonicalUsername)

      if (!canonicalUser) {
        return 'absent'
      }

      if (!canonicalUser.identityId) {
        return 'manual-required'
      }

      if (canonicalUser.identityId !== input.cognitoIdentityId) {
        return 'absent'
      }

      if (
        canonicalUser.directoryId !== input.directoryId ||
        canonicalUser.profile.status !== 'FORCE_CHANGE_PASSWORD'
      ) {
        return 'preserved'
      }

      return 'manual-required'
    }

    if (!currentUser) {
      return 'absent'
    }

    if (currentUser.identityId !== input.cognitoIdentityId) {
      return 'manual-required'
    }

    if (
      currentUser.directoryId !== input.directoryId ||
      currentUser.profile.status !== 'FORCE_CHANGE_PASSWORD'
    ) {
      return 'preserved'
    }

    try {
      await this.client.send(new AdminDeleteUserCommand({
        UserPoolId: userPoolId,
        Username: stableIdentityUsername,
      }))
      return 'deleted'
    } catch (error) {
      const cognitoError = toCognitoSdkError(error)

      if (isCognitoUserNotFoundError(cognitoError)) {
        return 'absent'
      }

      throw cognitoError
    }
  }

  /** invitation が追加した Workspace directory claim を解除します。 */
  async unlinkWorkspaceUser(
    input: CognitoWorkspaceUserCleanupInput,
  ): Promise<UnlinkCognitoWorkspaceUserResult> {
    const { userPoolId } = this.readRequiredConfiguration()
    // Cognito sub を stable lookup key として Username parameter へ意図的に渡します。
    const stableIdentityUsername = requireCognitoIdentityId(input.cognitoIdentityId)
    const canonicalUsername = requireCognitoUsername(input.cognitoUsername)
    const currentUser = await this.findWorkspaceUserByUsername(stableIdentityUsername)

    if (!currentUser && canonicalUsername !== stableIdentityUsername) {
      const canonicalUser = await this.findWorkspaceUserByUsername(canonicalUsername)

      if (!canonicalUser) {
        return 'completed'
      }

      if (!canonicalUser.identityId) {
        return 'manual-required'
      }

      if (
        canonicalUser.identityId !== input.cognitoIdentityId ||
        canonicalUser.directoryId !== input.directoryId
      ) {
        return 'completed'
      }

      return 'manual-required'
    }

    if (!currentUser) {
      return 'completed'
    }

    if (currentUser.identityId !== input.cognitoIdentityId) {
      return 'manual-required'
    }

    if (currentUser.directoryId !== input.directoryId) {
      return 'completed'
    }

    try {
      await this.client.send(new AdminDeleteUserAttributesCommand({
        UserPoolId: userPoolId,
        Username: stableIdentityUsername,
        UserAttributeNames: ['custom:directory_id', 'custom:workspace_id'],
      }))
    } catch (error) {
      const cognitoError = toCognitoSdkError(error)

      if (!isCognitoUserNotFoundError(cognitoError)) {
        throw cognitoError
      }
    }

    return 'completed'
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
  private async updateWorkspaceUserAttributes(
    username: string,
    email: string,
    directoryId: string,
    name?: string,
  ) {
    const { userPoolId } = this.readRequiredConfiguration()

    try {
      await this.client.send(new AdminUpdateUserAttributesCommand({
        UserPoolId: userPoolId,
        Username: requireCognitoUsername(username),
        UserAttributes: createWorkspaceCognitoUserAttributes(email, directoryId, name),
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
export class FlociCognitoClient implements CognitoClient {
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

  /**
   * @param endpoint Floci / Cognito の endpoint URL です。
   */
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
   * Cognito MFA/OTP challenge に one-time code を応答します。
   */
  async respondToMfaChallenge(
    email: string,
    challenge: CognitoMfaChallengeName,
    code: string,
    session: string,
  ) {
    return this.request<InitiateAuthResponse>('RespondToAuthChallenge', {
      ChallengeName: challenge,
      ChallengeResponses: {
        USERNAME: normalizeCognitoUserId(email),
        [resolveCognitoMfaResponseKey(challenge)]: code,
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

  /** Floci の User Pool に実在する federation provider 設定を返します。 */
  async describeEnterpriseIdentityProvider(providerName: string) {
    const response = await this.request<{
      IdentityProvider?: {
        ProviderName?: string
        ProviderType?: string
        ProviderDetails?: Record<string, string>
      }
    }>('DescribeIdentityProvider', {
      UserPoolId: await this.resolveUserPoolId(),
      ProviderName: providerName,
    })
    const described = response.IdentityProvider
    if (!described?.ProviderName || !described.ProviderType) {
      throw new CognitoServiceError(
        503,
        'CognitoIdentityProviderInvalid',
        'Cognito identity provider response is incomplete.',
      )
    }
    return {
      providerName: described.ProviderName,
      providerType: described.ProviderType,
      providerDetails: described.ProviderDetails ?? {},
    }
  }

  /** Enterprise Hosted UI 専用 app client の OAuth/provider contract を返します。 */
  async describeEnterpriseSsoAppClient(clientId: string) {
    const response = await this.request<{
      UserPoolClient?: {
        AllowedOAuthFlows?: string[]
        AllowedOAuthFlowsUserPoolClient?: boolean
        AllowedOAuthScopes?: string[]
        CallbackURLs?: string[]
        ClientId?: string
        ClientSecret?: string
        ExplicitAuthFlows?: string[]
        SupportedIdentityProviders?: string[]
      }
    }>('DescribeUserPoolClient', {
      UserPoolId: await this.resolveUserPoolId(),
      ClientId: clientId,
    })
    const described = response.UserPoolClient
    if (described?.ClientId !== clientId) {
      throw new CognitoServiceError(
        503,
        'CognitoSsoAppClientInvalid',
        'Cognito SSO app client response is incomplete.',
      )
    }
    return {
      clientId: described.ClientId,
      hasClientSecret: Boolean(described.ClientSecret),
      supportedIdentityProviders: [...(described.SupportedIdentityProviders ?? [])],
      allowedOAuthFlowsUserPoolClient: described.AllowedOAuthFlowsUserPoolClient === true,
      allowedOAuthFlows: [...(described.AllowedOAuthFlows ?? [])],
      allowedOAuthScopes: [...(described.AllowedOAuthScopes ?? [])],
      explicitAuthFlows: [...(described.ExplicitAuthFlows ?? [])],
      callbackUrls: [...(described.CallbackURLs ?? [])],
    }
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

  /** Directory deprovisioning 後に Cognito user の新規認証を停止します。 */
  async disableWorkspaceUser(userId: string) {
    await this.request('AdminDisableUser', {
      UserPoolId: await this.resolveUserPoolId(),
      Username: normalizeCognitoUserId(userId),
    })
  }

  /** Directory reactivation 後に Cognito user の認証を再開します。 */
  async enableWorkspaceUser(userId: string) {
    await this.request('AdminEnableUser', {
      UserPoolId: await this.resolveUserPoolId(),
      Username: normalizeCognitoUserId(userId),
    })
  }

  /** Directory deprovisioning 後に Cognito refresh token を全失効させます。 */
  async globallySignOutWorkspaceUser(userId: string) {
    await this.request('AdminUserGlobalSignOut', {
      UserPoolId: await this.resolveUserPoolId(),
      Username: normalizeCognitoUserId(userId),
    })
  }

  /** Cognito の現在 group membership を全 page から取得します。 */
  async getUserGroups(userId: string) {
    const normalizedUserId = normalizeCognitoUserId(userId)
    const groups = new Set<string>()
    let nextToken: string | undefined

    do {
      const response = await this.request<AdminListGroupsForUserResponse>(
        'AdminListGroupsForUser',
        {
          UserPoolId: await this.resolveUserPoolId(),
          Username: normalizedUserId,
          ...(nextToken ? { NextToken: nextToken } : {}),
        },
      )
      for (const group of response.Groups ?? []) {
        if (typeof group.GroupName === 'string' && group.GroupName.trim()) {
          groups.add(group.GroupName)
        }
      }
      nextToken = response.NextToken
    } while (nextToken)

    return [...groups]
  }

  /** Cognito の現在 group membership から system administrator 判定を返します。 */
  async isSystemAdmin(userId: string) {
    try {
      const configuredGroups = new Set(getSystemAdminGroups())
      return (await this.getUserGroups(userId)).some((group) =>
        configuredGroups.has(group)
      )
    } catch (error) {
      if (isCognitoUserNotFoundError(error)) return false
      throw error
    }
  }

  /**
   * Workspace invitation 対象の Cognito user と directory 属性を検索します。
   */
  async findWorkspaceUser(userId: string) {
    return this.findWorkspaceUserByUsername(normalizeCognitoUserId(userId))
  }

  /** Cognito username または stable sub を大文字小文字を変えずに検索します。 */
  private async findWorkspaceUserByUsername(username: string) {
    const normalizedUsername = requireCognitoUsername(username)

    try {
      const user = await this.request<CognitoUserRecord>('AdminGetUser', {
        UserPoolId: await this.resolveUserPoolId(),
        Username: normalizedUsername,
      })
      const profile = toCognitoUserProfile(user)

      if (!profile) {
        throw new CognitoServiceError(
          502,
          'InvalidCognitoResponse',
          `Cognito user "${normalizedUsername}" did not include a stable profile.`,
        )
      }

      return {
        profile,
        identityId: readCognitoUserAttribute(user, 'sub')?.trim() || undefined,
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
      requireEnabledWorkspaceUser(existingUser)
      const cognitoIdentityId = requireCognitoIdentityId(existingUser.identityId)
      if (!existingUser.directoryId) {
        await input.beforeDirectoryClaimUpdate(
          cognitoIdentityId,
          existingUser.profile.username,
        )
      }
      await this.updateWorkspaceUserAttributes(
        existingUser.profile.username,
        email,
        input.directoryId,
        input.name,
      )

      return {
        profile: {
          ...existingUser.profile,
          name: input.name?.trim() || existingUser.profile.name,
        },
        cognitoIdentityId,
        cognitoUsername: requireCognitoUsername(existingUser.profile.username),
        identityOwnership: 'pre-existing',
        directoryClaimCleanupRequired: !existingUser.directoryId,
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
        cognitoIdentityId: requireCognitoIdentityId(
          response.User ? readCognitoUserAttribute(response.User, 'sub') : undefined,
        ),
        cognitoUsername: requireCognitoUsername(profile?.username ?? email),
        identityOwnership: 'workspace-created',
        directoryClaimCleanupRequired: false,
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
      requireEnabledWorkspaceUser(racedUser)
      const cognitoIdentityId = requireCognitoIdentityId(racedUser.identityId)
      if (!racedUser.directoryId) {
        await input.beforeDirectoryClaimUpdate(
          cognitoIdentityId,
          racedUser.profile.username,
        )
      }
      await this.updateWorkspaceUserAttributes(
        racedUser.profile.username,
        email,
        input.directoryId,
        input.name,
      )

      if (racedUser.profile.status === 'FORCE_CHANGE_PASSWORD') {
        await this.resendWorkspaceUserInvitation(racedUser.profile.username)
      }

      return {
        profile: racedUser.profile,
        cognitoIdentityId,
        cognitoUsername: requireCognitoUsername(racedUser.profile.username),
        identityOwnership: 'ambiguous',
        directoryClaimCleanupRequired: !racedUser.directoryId,
        deliveryStatus: racedUser.profile.status === 'FORCE_CHANGE_PASSWORD'
          ? 'sent'
          : 'not-required',
      } satisfies ProvisionCognitoWorkspaceUserResult
    }
  }

  /**
   * Workspace が作成した未確定 Cognito username へ invitation を再送します。
   */
  async resendWorkspaceUserInvitation(username: string) {
    await this.request<AdminCreateUserResponse>('AdminCreateUser', {
      UserPoolId: await this.resolveUserPoolId(),
      Username: requireCognitoUsername(username),
      MessageAction: 'RESEND',
      DesiredDeliveryMediums: ['EMAIL'],
    })
  }

  /** Workspace が作成した未確定 user だけを削除します。 */
  async deleteWorkspaceUser(
    input: CognitoWorkspaceUserCleanupInput,
  ): Promise<DeleteCognitoWorkspaceUserResult> {
    // Cognito sub を stable lookup key として Username parameter へ意図的に渡します。
    const stableIdentityUsername = requireCognitoIdentityId(input.cognitoIdentityId)
    const canonicalUsername = requireCognitoUsername(input.cognitoUsername)
    const currentUser = await this.findWorkspaceUserByUsername(stableIdentityUsername)

    if (!currentUser && canonicalUsername !== stableIdentityUsername) {
      const canonicalUser = await this.findWorkspaceUserByUsername(canonicalUsername)

      if (!canonicalUser) {
        return 'absent'
      }

      if (!canonicalUser.identityId) {
        return 'manual-required'
      }

      if (canonicalUser.identityId !== input.cognitoIdentityId) {
        return 'absent'
      }

      if (
        canonicalUser.directoryId !== input.directoryId ||
        canonicalUser.profile.status !== 'FORCE_CHANGE_PASSWORD'
      ) {
        return 'preserved'
      }

      return 'manual-required'
    }

    if (!currentUser) {
      return 'absent'
    }

    if (currentUser.identityId !== input.cognitoIdentityId) {
      return 'manual-required'
    }

    if (
      currentUser.directoryId !== input.directoryId ||
      currentUser.profile.status !== 'FORCE_CHANGE_PASSWORD'
    ) {
      return 'preserved'
    }

    try {
      await this.request<Record<string, never>>('AdminDeleteUser', {
        UserPoolId: await this.resolveUserPoolId(),
        Username: stableIdentityUsername,
      })
      return 'deleted'
    } catch (error) {
      if (isCognitoUserNotFoundError(error)) {
        return 'absent'
      }

      throw error
    }
  }

  /** invitation が追加した Workspace directory claim を解除します。 */
  async unlinkWorkspaceUser(
    input: CognitoWorkspaceUserCleanupInput,
  ): Promise<UnlinkCognitoWorkspaceUserResult> {
    // Cognito sub を stable lookup key として Username parameter へ意図的に渡します。
    const stableIdentityUsername = requireCognitoIdentityId(input.cognitoIdentityId)
    const canonicalUsername = requireCognitoUsername(input.cognitoUsername)
    const currentUser = await this.findWorkspaceUserByUsername(stableIdentityUsername)

    if (!currentUser && canonicalUsername !== stableIdentityUsername) {
      const canonicalUser = await this.findWorkspaceUserByUsername(canonicalUsername)

      if (!canonicalUser) {
        return 'completed'
      }

      if (!canonicalUser.identityId) {
        return 'manual-required'
      }

      if (
        canonicalUser.identityId !== input.cognitoIdentityId ||
        canonicalUser.directoryId !== input.directoryId
      ) {
        return 'completed'
      }

      return 'manual-required'
    }

    if (!currentUser) {
      return 'completed'
    }

    if (currentUser.identityId !== input.cognitoIdentityId) {
      return 'manual-required'
    }

    if (currentUser.directoryId !== input.directoryId) {
      return 'completed'
    }

    try {
      await this.request<Record<string, never>>('AdminDeleteUserAttributes', {
        UserPoolId: await this.resolveUserPoolId(),
        Username: stableIdentityUsername,
        UserAttributeNames: ['custom:directory_id', 'custom:workspace_id'],
      })
    } catch (error) {
      if (!isCognitoUserNotFoundError(error)) {
        throw error
      }
    }

    return 'completed'
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
  private async updateWorkspaceUserAttributes(
    username: string,
    email: string,
    directoryId: string,
    name?: string,
  ) {
    await this.request<Record<string, never>>('AdminUpdateUserAttributes', {
      UserPoolId: await this.resolveUserPoolId(),
      Username: requireCognitoUsername(username),
      UserAttributes: createWorkspaceCognitoUserAttributes(email, directoryId, name),
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

/**
 * Converts an unknown AWS SDK failure into the Cognito domain error contract.
 *
 * @param error - Error value caught from the AWS SDK.
 * @returns A normalized Cognito service error.
 */
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

/**
 * Parses a Floci HTTP response as JSON and rejects malformed payloads.
 *
 * @param response - HTTP response returned by the Cognito-compatible endpoint.
 * @returns The parsed response body, or an empty object for an empty response.
 */
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

/**
 * Clamps a requested Cognito page size to the supported range.
 *
 * @param value - Optional requested page size.
 * @returns An integer page size between one and sixty.
 */
export function clampCognitoPageLimit(value: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 20
  }

  return Math.min(60, Math.max(1, Math.floor(value)))
}

/**
 * Escapes a literal value embedded in a Cognito list-users filter.
 *
 * @param value - Raw filter literal.
 * @returns The Cognito filter-safe literal value.
 */
function escapeCognitoFilterValue(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Normalizes a Cognito user identifier for stable identity comparisons.
 *
 * @param value - Raw user identifier.
 * @returns A trimmed lowercase Cognito user identifier.
 */
export function normalizeCognitoUserId(value: string) {
  const normalized = value.trim().toLowerCase()

  if (!normalized) {
    throw new CognitoServiceError(400, 'InvalidParameterException', 'Cognito user ID is required.')
  }

  return normalized
}

/**
 * Validates a required Cognito username.
 *
 * @param value - Raw Cognito username.
 * @returns The trimmed non-empty username.
 */
function requireCognitoUsername(value: string) {
  const username = value.trim()

  if (!username) {
    throw new CognitoServiceError(400, 'InvalidParameterException', 'Cognito username is required.')
  }

  return username
}

/**
 * Validates a stable Cognito identity identifier returned by the service.
 *
 * @param value - Optional identity identifier from Cognito attributes.
 * @returns The trimmed identity identifier.
 */
function requireCognitoIdentityId(value: string | undefined) {
  const identityId = value?.trim()

  if (!identityId) {
    throw new CognitoServiceError(
      502,
      'InvalidCognitoResponse',
      'Cognito user did not include a stable identity ID.',
    )
  }

  return identityId
}

/**
 * Rejects an existing Workspace user when Cognito authentication is disabled.
 *
 * @param user - Workspace Cognito user to validate.
 */
function requireEnabledWorkspaceUser(user: CognitoWorkspaceUser) {
  if (user.profile.enabled !== false) {
    return
  }

  throw new CognitoServiceError(
    409,
    'CognitoUserDisabled',
    'The existing Cognito user is disabled. Re-enable it before sending a Workspace invitation.',
  )
}

/**
 * Converts a Cognito user record into the public profile contract.
 *
 * @param value - User record returned by Cognito or Floci.
 * @returns A normalized profile, or undefined when required identity fields are absent.
 */
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
    mfaConfigured: Boolean(
      value.PreferredMfaSetting?.trim() ||
      value.UserMFASettingList?.some((setting) => Boolean(setting.trim())),
    ),
  }
}

/**
 * Reads one named user attribute across Cognito response shapes.
 *
 * @param user - Cognito user record.
 * @param name - Attribute name to locate.
 * @returns The attribute value when present.
 */
function readCognitoUserAttribute(user: CognitoUserRecord, name: string) {
  return (user.Attributes ?? user.UserAttributes)?.find((attribute) => attribute.Name === name)?.Value
}

/**
 * Resolves the canonical Workspace directory claim from a Cognito user.
 *
 * @param user - Cognito user record containing Workspace custom attributes.
 * @returns The claimed directory identifier when present.
 */
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

/**
 * Creates the canonical Cognito attributes for a Workspace-managed user.
 *
 * @param email - User email address.
 * @param directoryId - Owning Workspace directory identifier.
 * @param name - Optional display name.
 * @returns Cognito attributes ready for a create or update operation.
 */
function createWorkspaceCognitoUserAttributes(email: string, directoryId: string, name?: string) {
  return [
    { Name: 'email', Value: normalizeCognitoUserId(email) },
    { Name: 'custom:directory_id', Value: directoryId },
    { Name: 'custom:workspace_id', Value: directoryId },
    ...(name?.trim() ? [{ Name: 'name', Value: name.trim() }] : []),
  ]
}

/**
 * Determines whether a Cognito user belongs to the requested Workspace directory.
 *
 * @param user - Cognito user record to inspect.
 * @param directoryId - Optional directory scope.
 * @returns Whether the record has a compatible directory claim.
 */
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

/**
 * Narrows an optional value to its defined variant.
 *
 * @param value - Optional value.
 * @returns Whether the value is defined.
 */
function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

/**
 * Narrows an unknown value to a non-array object record.
 *
 * @param value - Unknown value to inspect.
 * @returns Whether the value is a record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolves the configured Cognito groups that grant system administration.
 *
 * @returns Configured group names or the stable default group.
 */
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

/** @returns The centralized AWS region used by Cognito clients. */
function getAwsRegion() {
  return loadServerConfig().awsRegion
}

/** @returns The optional centralized Cognito-compatible endpoint. */
function getCognitoEndpoint() {
  return loadServerConfig().cognitoEndpoint
}

/**
 * Reads one environment value through centralized server configuration.
 *
 * @param name - Environment variable name.
 * @returns The configured value when present.
 */
function getEnv(name: string) {
  return loadServerConfig().environment[name]
}

/**
 * Removes trailing slashes from an endpoint URL.
 *
 * @param value - Endpoint URL to normalize.
 * @returns The URL without trailing slashes.
 */
function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}

/**
 * Removes an optional namespace prefix from a Cognito error code.
 *
 * @param value - Raw Cognito error type header.
 * @returns The terminal error code segment when present.
 */
function normalizeCognitoErrorCode(value: string | undefined) {
  return value?.split('#').pop()
}

/**
 * Creates the Cognito adapter selected by centralized runtime configuration.
 *
 * @returns A Floci HTTP adapter for configured endpoints or the AWS SDK adapter.
 */
export function createCognitoClient(): CognitoClient {
  const endpoint = getCognitoEndpoint()

  return endpoint
    ? new FlociCognitoClient(endpoint)
    : new AwsCognitoClient()
}
