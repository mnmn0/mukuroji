/**
 * Enterprise identity/security contract の schema version です。
 */
export const ENTERPRISE_IDENTITY_SCHEMA_VERSION = 1 as const

/**
 * Route authorization と custom role で利用できる permission ID 一覧です。
 */
export const ENTERPRISE_PERMISSION_IDS = [
  'workspace.read',
  'workspace.write',
  'workspace.manage',
  'members.read',
  'members.manage',
  'teams.read',
  'teams.write',
  'teams.manage',
  'projects.read',
  'projects.write',
  'projects.manage',
  'work-items.read',
  'work-items.write',
  'documents.read',
  'documents.write',
  'documents.manage',
  'files.read',
  'files.write',
  'files.approve',
  'requests.read',
  'requests.manage',
  'planning.read',
  'planning.write',
  'planning.manage',
  'automation.read',
  'automation.manage',
  'audit.read',
  'audit.export',
  'identity.read',
  'identity.manage',
  'security.read',
  'security.manage',
  'service-accounts.use',
  'service-accounts.manage',
] as const

/**
 * Enterprise authorization が認識する permission ID です。
 */
export type EnterprisePermissionId = (typeof ENTERPRISE_PERMISSION_IDS)[number]

/**
 * Mukuroji が提供する immutable な built-in role ID 一覧です。
 */
export const ENTERPRISE_BUILT_IN_ROLE_IDS = [
  'workspace:owner',
  'workspace:admin',
  'workspace:member',
  'workspace:guest',
  'team:manager',
  'team:member',
  'project:manager',
  'project:member',
  'project:viewer',
] as const

/**
 * Mukuroji が提供する built-in role ID です。
 */
export type EnterpriseBuiltInRoleId = (typeof ENTERPRISE_BUILT_IN_ROLE_IDS)[number]

/**
 * Workspace が定義する custom role ID です。
 */
export type EnterpriseCustomRoleId = `custom:${string}`

/**
 * Built-in role と custom role を統一した role ID です。
 */
export type EnterpriseRoleId = EnterpriseBuiltInRoleId | EnterpriseCustomRoleId

/**
 * Role assignment と authorization request が参照する resource scope です。
 */
export type EnterpriseRoleScope = {
  /**
   * Scope を所有する Workspace ID です。
   */
  workspaceId: string
  /**
   * Workspace、Team、Project のどこに権限を適用するかを示します。
   */
  kind: 'workspace' | 'team' | 'project'
  /**
   * Team または Project の ID です。Workspace scope では指定しません。
   */
  targetId?: string
  /** Team that owns a Project scope; required whenever the scope kind is project. */
  parentTeamId?: string
}

/**
 * Route と permission を結び付ける deny-by-default rule です。
 */
export type EnterpriseRoutePermissionRule = {
  /**
   * 大文字の HTTP method、または全 method を表す `*` です。
   */
  method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT' | '*'
  /**
   * `:workspaceId` のような一 segment parameter と `*` suffix を許す path pattern です。
   */
  pathPattern: string
  /**
   * Route を呼び出す principal に必要な permission です。
   */
  permission: EnterprisePermissionId
  /**
   * `permission` の代わりにいずれか一つを持てば呼び出せる permission です。
   */
  alternativePermissions?: EnterprisePermissionId[]
}

/**
 * Workspace が定義する custom role です。
 */
export type EnterpriseCustomRole = {
  /**
   * Role が属する Workspace ID です。
   */
  workspaceId: string
  /**
   * `custom:` prefix を持つ immutable role ID です。
   */
  roleId: EnterpriseCustomRoleId
  /**
   * 管理画面に表示する role 名です。
   */
  name: string
  /**
   * Role の目的を説明する任意の文言です。
   */
  description?: string
  /**
   * Role が許可する permission の重複しない集合です。
   */
  permissions: EnterprisePermissionId[]
  /**
   * Guest principal に割り当て可能かどうかです。
   */
  guestAssignable: boolean
  /**
   * Optimistic concurrency に使う revision です。
   */
  revision: number
  /**
   * Role 作成日時です。
   */
  createdAt: string
  /**
   * Role 最終更新日時です。
   */
  updatedAt: string
}

/**
 * User、directory group、service account に対する role assignment です。
 */
export type EnterpriseRoleAssignment = {
  /**
   * Assignment が属する Workspace ID です。
   */
  workspaceId: string
  /**
   * Assignment の immutable ID です。
   */
  assignmentId: string
  /**
   * Role を受け取る principal 種別です。
   */
  principalKind: 'member' | 'directory-group' | 'service-account'
  /**
   * Member、directory group、service account の immutable ID です。
   */
  principalId: string
  /**
   * 割り当てる built-in または custom role ID です。
   */
  roleId: EnterpriseRoleId
  /**
   * Role を有効にする resource scope です。
   */
  scope: EnterpriseRoleScope
  /**
   * Assignment が直接設定か directory mapping 由来かを示します。
   */
  source: 'direct' | 'directory-mapping' | 'system'
  /**
   * Assignment を生成した mapping ID です。
   */
  mappingId?: string
}

/**
 * SAML identity provider 設定です。
 */
export type EnterpriseSamlIdentityProvider = {
  /**
   * Provider が属する Workspace ID です。
   */
  workspaceId: string
  /**
   * Provider の immutable ID です。
   */
  providerId: string
  /**
   * Provider protocol discriminator です。
   */
  kind: 'saml'
  /**
   * 管理画面と login discovery に表示する名称です。
   */
  displayName: string
  /**
   * Cognito User Pool 上でこの federation connection を識別する provider 名です。
   */
  cognitoProviderName: string
  /**
   * Provider が認証に利用可能かどうかです。
   */
  status: 'draft' | 'active' | 'disabled'
  /**
   * Optimistic concurrency に使う monotonically increasing version です。
   */
  revision: number
  /**
   * IdP entity ID です。
   */
  entityId: string
  /**
   * IdP Single Sign-On URL です。
   */
  singleSignOnUrl: string
  /**
   * Entity ID、SSO endpoint、署名証明書を検証する metadata XML URL です。
   */
  metadataUrl: string
  /**
   * 署名証明書の SHA-256 fingerprint 一覧です。
   */
  certificateFingerprints: string[]
  /**
   * Cognito または secret manager が保持する metadata への参照です。
   */
  metadataReference?: string
  /**
   * Provider 作成日時です。
   */
  createdAt: string
  /**
   * Provider 最終更新日時です。
   */
  updatedAt: string
  /**
   * Metadata と署名設定の接続テストが最後に成功した日時です。
   */
  lastTestedAt?: string
}

/**
 * OIDC identity provider 設定です。
 */
export type EnterpriseOidcIdentityProvider = {
  /**
   * Provider が属する Workspace ID です。
   */
  workspaceId: string
  /**
   * Provider の immutable ID です。
   */
  providerId: string
  /**
   * Provider protocol discriminator です。
   */
  kind: 'oidc'
  /**
   * 管理画面と login discovery に表示する名称です。
   */
  displayName: string
  /**
   * Cognito User Pool 上でこの federation connection を識別する provider 名です。
   */
  cognitoProviderName: string
  /**
   * Provider が認証に利用可能かどうかです。
   */
  status: 'draft' | 'active' | 'disabled'
  /**
   * Optimistic concurrency に使う monotonically increasing version です。
   */
  revision: number
  /**
   * OpenID issuer URL です。
   */
  issuer: string
  /**
   * Public client ID です。
   */
  clientId: string
  /**
   * Authorization endpoint URL です。
   */
  authorizationEndpoint: string
  /**
   * Token endpoint URL です。
   */
  tokenEndpoint: string
  /**
   * JWKS endpoint URL です。
   */
  jwksUri: string
  /**
   * Authorization request に含める scope 一覧です。
   */
  scopes: string[]
  /**
   * Plaintext secret ではなく Secrets Manager 等の参照です。
   */
  clientSecretReference?: string
  /**
   * Provider 作成日時です。
   */
  createdAt: string
  /**
   * Provider 最終更新日時です。
   */
  updatedAt: string
  /**
   * Discovery と JWKS の接続テストが最後に成功した日時です。
   */
  lastTestedAt?: string
}

/**
 * Workspace に接続された SAML または OIDC identity provider です。
 */
export type EnterpriseIdentityProvider =
  | EnterpriseSamlIdentityProvider
  | EnterpriseOidcIdentityProvider

/**
 * Domain claim の状態と enforced login 設定です。
 */
export type EnterpriseVerifiedDomain = {
  /**
   * Domain が属する Workspace ID です。
   */
  workspaceId: string
  /**
   * Domain claim の immutable ID です。
   */
  domainId: string
  /**
   * Lowercase ASCII の claimed domain です。
   */
  domain: string
  /**
   * DNS verification の現在状態です。
   */
  status: 'pending' | 'verified' | 'failed'
  /**
   * Optimistic concurrency に使う monotonically increasing version です。
   */
  revision: number
  /**
   * TXT record を置く DNS name です。
   */
  verificationRecordName: string
  /**
   * Verification 完了日時です。
   */
  verifiedAt?: string
  /**
   * この domain の user に SSO を強制するかどうかです。
   */
  enforceSso: boolean
  /**
   * SSO 強制時に利用する active identity provider ID です。
   */
  identityProviderId?: string
  /**
   * Domain claim 作成日時です。
   */
  createdAt: string
  /**
   * Domain claim 最終更新日時です。
   */
  updatedAt: string
}

/**
 * DNS domain verification の一度だけ返される challenge です。
 */
export type EnterpriseDomainVerificationChallenge = {
  /**
   * 作成された domain claim です。
   */
  domain: EnterpriseVerifiedDomain
  /**
   * DNS TXT record に設定する一度だけ表示される値です。
   */
  verificationRecordValue: string
}

/**
 * Guest と external collaborator に対する上限 policy です。
 */
export type EnterpriseExternalAccessPolicy = {
  /**
   * Guest member の存在を許可するかどうかです。
   */
  allowGuests: boolean
  /**
   * Verified domain 外の collaborator を許可するかどうかです。
   */
  allowExternalCollaborators: boolean
  /**
   * External principal に MFA を必須化するかどうかです。
   */
  requireMfa: boolean
  /**
   * External principal の session lifetime 上限です。
   */
  maximumSessionLifetimeMinutes: number
  /**
   * Guest として許可する正規化済み email domain 一覧です。
   *
   * 空配列の場合は domain による追加制限を適用しません。
   */
  allowedGuestDomains: string[]
  /**
   * External principal が利用可能な permission の上限です。
   */
  permissionCeiling: EnterprisePermissionId[]
}

/**
 * Workspace 全体の authentication と session security policy です。
 */
export type EnterpriseSecurityPolicy = {
  /**
   * Policy が属する Workspace ID です。
   */
  workspaceId: string
  /**
   * Password と SSO の許可方法です。
   */
  loginMode: 'password-or-sso' | 'sso-for-claimed-domains' | 'sso-only'
  /**
   * Workspace member に対する MFA requirement です。
   */
  mfaRequirement: 'disabled' | 'optional' | 'required'
  /**
   * Session の absolute lifetime です。
   */
  sessionLifetimeMinutes: number
  /**
   * Activity がない session の timeout です。
   */
  idleTimeoutMinutes: number
  /**
   * Authentication age を再確認する間隔です。
   */
  reauthenticationIntervalMinutes: number
  /**
   * Privileged action に要求する直近 re-authentication の最大 age です。
   */
  sensitiveActionReauthenticationMinutes: number
  /**
   * IP allowlist の適用対象です。
   */
  ipAllowlistMode: 'disabled' | 'all-users' | 'privileged-users'
  /**
   * IPv4 または IPv6 CIDR の allowlist です。
   */
  ipAllowlist: string[]
  /**
   * Guest と external collaborator の上限です。
   */
  externalAccess: EnterpriseExternalAccessPolicy
  /**
   * Optimistic concurrency と session invalidation に使う revision です。
   */
  revision: number
  /**
   * Policy 最終更新日時です。
   */
  updatedAt: string
  /**
   * Policy を更新した actor の immutable key です。
   */
  updatedBy: string
}

/**
 * Directory group を scoped role へ変換する mapping です。
 */
export type EnterpriseDirectoryGroupMapping = {
  /**
   * Mapping が属する Workspace ID です。
   */
  workspaceId: string
  /**
   * Mapping の immutable ID です。
   */
  mappingId: string
  /**
   * Directory group を供給する identity provider ID です。
   */
  identityProviderId: string
  /**
   * IdP または SCIM における immutable group external ID です。
   */
  directoryGroupId: string
  /**
   * Group member に割り当てる role ID です。
   */
  roleId: EnterpriseRoleId
  /**
   * Role assignment の resource scope です。
   */
  scope: EnterpriseRoleScope
  /**
   * Mapping が reconciliation で有効かどうかです。
   */
  enabled: boolean
  /**
   * 複数 mapping の deterministic ordering に使う優先度です。
   */
  priority: number
  /**
   * Optimistic concurrency に使う monotonically increasing version です。
   */
  revision: number
  /**
   * Mapping 最終更新日時です。
   */
  updatedAt: string
}

/**
 * SCIM が管理する immutable directory user です。
 */
export type EnterpriseScimUser = {
  /**
   * User が属する Workspace ID です。
   */
  workspaceId: string
  /**
   * Mukuroji が発行する immutable SCIM user ID です。
   */
  userId: string
  /**
   * IdP が発行する immutable external ID です。
   */
  externalId: string
  /**
   * User を供給した identity provider ID です。
   */
  identityProviderId: string
  /**
   * SCIM `userName` です。通常は email ですが可変です。
   */
  userName: string
  /**
   * User の表示名です。
   */
  displayName?: string
  /**
   * 正規化された email 一覧です。
   */
  emails: string[]
  /**
   * IdP の desired active state です。
   */
  active: boolean
  /**
   * Mukuroji member の immutable key です。
   */
  linkedMemberKey?: string
  /**
   * User が属する SCIM group ID 一覧です。
   */
  groupIds: string[]
  /**
   * SCIM ETag に利用できる monotonically increasing version です。
   */
  version: number
  /**
   * Workspace access へ最後に正常適用できた desired version です。
   */
  appliedVersion: number
  /**
   * `appliedVersion` の適用完了日時です。
   */
  appliedAt?: string
  /**
   * User 作成日時です。
   */
  createdAt: string
  /**
   * User 最終更新日時です。
   */
  updatedAt: string
}

/**
 * SCIM user の idempotent upsert 入力です。
 */
export type EnterpriseScimUserInput = {
  /**
   * User が属する Workspace ID です。
   */
  workspaceId: string
  /**
   * Existing SCIM resource の immutable internal ID です。更新時だけ指定します。
   */
  userId?: string
  /**
   * IdP が発行する immutable external ID です。
   */
  externalId: string
  /**
   * User を供給した identity provider ID です。
   */
  identityProviderId: string
  /**
   * SCIM `userName` です。
   */
  userName: string
  /**
   * User の表示名です。
   */
  displayName?: string
  /**
   * User の email 一覧です。
   */
  emails: string[]
  /**
   * Desired active state です。
   */
  active: boolean
  /**
   * 既存 Mukuroji member の immutable key です。
   */
  linkedMemberKey?: string
  /**
   * User が属する SCIM group ID 一覧です。
   */
  groupIds?: string[]
  /**
   * 同一 request の再送を識別する key です。
   */
  idempotencyKey: string
}

/**
 * SCIM が管理する immutable directory group です。
 */
export type EnterpriseScimGroup = {
  /**
   * Group が属する Workspace ID です。
   */
  workspaceId: string
  /**
   * Mukuroji が発行する immutable SCIM group ID です。
   */
  groupId: string
  /**
   * IdP が発行する immutable external ID です。
   */
  externalId: string
  /**
   * Group を供給した identity provider ID です。
   */
  identityProviderId: string
  /**
   * Directory group の表示名です。
   */
  displayName: string
  /**
   * Group の desired active state です。
   */
  active: boolean
  /**
   * Group に属する immutable SCIM user ID 一覧です。
   */
  memberUserIds: string[]
  /**
   * SCIM ETag に利用できる monotonically increasing version です。
   */
  version: number
  /**
   * Workspace access へ最後に正常適用できた desired version です。
   */
  appliedVersion: number
  /**
   * `appliedVersion` の適用完了日時です。
   */
  appliedAt?: string
  /**
   * Group 作成日時です。
   */
  createdAt: string
  /**
   * Group 最終更新日時です。
   */
  updatedAt: string
}

/**
 * SCIM group の idempotent upsert 入力です。
 */
export type EnterpriseScimGroupInput = {
  /**
   * Group が属する Workspace ID です。
   */
  workspaceId: string
  /**
   * Existing SCIM resource の immutable internal ID です。更新時だけ指定します。
   */
  groupId?: string
  /**
   * IdP が発行する immutable external ID です。
   */
  externalId: string
  /**
   * Group を供給した identity provider ID です。
   */
  identityProviderId: string
  /**
   * Directory group の表示名です。
   */
  displayName: string
  /**
   * Desired active state です。
   */
  active: boolean
  /**
   * Group に属する immutable SCIM user ID 一覧です。
   */
  memberUserIds?: string[]
  /**
   * 同一 request の再送を識別する key です。
   */
  idempotencyKey: string
}

/**
 * SCIM bearer credential の secret を含まない metadata です。
 */
export type EnterpriseScimCredential = {
  /**
   * Credential が属する Workspace ID です。
   */
  workspaceId: string
  /**
   * Credential が provisioning を許可する identity provider ID です。
   */
  identityProviderId: string
  /**
   * Credential の immutable ID です。
   */
  credentialId: string
  /**
   * 管理画面に表示する用途名です。
   */
  label: string
  /**
   * Credential 照合用に保存する bearer token の末尾4文字です。
   */
  tokenLastFour: string
  /**
   * Credential 発行日時です。
   */
  createdAt: string
  /**
   * Credential の任意 expiry です。
   */
  expiresAt?: string
  /**
   * Credential revoke 日時です。
   */
  revokedAt?: string
  /**
   * Credential 最終利用日時です。
   */
  lastUsedAt?: string
}

/**
 * Credential 発行時に返す plaintext token と安全な metadata です。
 *
 * @remarks 同じ idempotency request の応答喪失時だけ、短い receipt window 内で再取得できます。
 */
export type EnterpriseIssuedCredential = {
  /**
   * UI が一度だけ表示し、永続化してはいけない bearer token です。
   */
  token: string
  /**
   * Secret を含まない credential metadata です。
   */
  credential: EnterpriseScimCredential
}

/**
 * Interactive user と分離された service account です。
 */
export type EnterpriseServiceAccount = {
  /**
   * Service account が属する Workspace ID です。
   */
  workspaceId: string
  /**
   * Service account の immutable ID です。
   */
  accountId: string
  /**
   * 管理画面と audit に表示する名称です。
   */
  displayName: string
  /**
   * Service account の説明です。
   */
  description?: string
  /**
   * Account に直接許可された permission です。
   */
  permissions: EnterprisePermissionId[]
  /**
   * Account に割り当てた built-in または custom role ID です。
   */
  roleId: EnterpriseRoleId
  /**
   * Account の resource scope です。
   */
  scope: EnterpriseRoleScope
  /**
   * 新規/rotate credential に適用する有効日数です。
   */
  credentialLifetimeDays: number
  /**
   * Bearer authentication を許可する source CIDR 一覧です。空配列は制限なしです。
   */
  allowedSourceCidrs: string[]
  /**
   * Account が認証可能かどうかです。
   */
  status: 'active' | 'disabled'
  /**
   * 発行済み credential の monotonically increasing generation です。
   */
  credentialGeneration: number
  /**
   * Current credential の expiry です。
   */
  credentialExpiresAt?: string
  /**
   * Account が最後に bearer authentication へ成功した日時です。
   */
  lastUsedAt?: string
  /**
   * Optimistic concurrency に使う monotonically increasing version です。
   */
  revision: number
  /**
   * Account 作成日時です。
   */
  createdAt: string
  /**
   * Account 最終更新日時です。
   */
  updatedAt: string
}

/**
 * Service account credential の secret を含まない metadata です。
 */
export type EnterpriseServiceAccountCredential = {
  /**
   * Credential が属する Workspace ID です。
   */
  workspaceId: string
  /**
   * Credential の immutable ID です。
   */
  credentialId: string
  /**
   * Credential を所有する service account ID です。
   */
  accountId: string
  /**
   * Credential 発行日時です。
   */
  createdAt: string
  /**
   * Credential の任意 expiry です。
   */
  expiresAt?: string
  /**
   * Credential revoke 日時です。
   */
  revokedAt?: string
  /**
   * Credential 最終利用日時です。
   */
  lastUsedAt?: string
}

/**
 * Service account credential 発行結果です。
 *
 * @remarks 同じ idempotency request の応答喪失時だけ、短い receipt window 内で再取得できます。
 */
export type EnterpriseIssuedServiceAccountCredential = {
  /**
   * UI が一度だけ表示し、永続化してはいけない bearer token です。
   */
  token: string
  /**
   * Secret を含まない credential metadata です。
   */
  credential: EnterpriseServiceAccountCredential
}

/**
 * 通常の system administrator と分離された break-glass account です。
 */
export type EnterpriseBreakGlassAccount = {
  /**
   * Account が属する Workspace ID です。
   */
  workspaceId: string
  /**
   * Account の immutable ID です。
   */
  accountId: string
  /**
   * Interactive member の immutable key です。
   */
  linkedMemberKey: string
  /**
   * 通知と管理画面表示に使用する正規化済み email address です。
   */
  email: string
  /**
   * Account を利用可能にするかどうかです。
   */
  status: 'active' | 'disabled'
  /**
   * Activation に常に MFA が必要かどうかです。
   */
  requireMfa: true
  /**
   * 一回の activation の最大 duration です。
   */
  maximumActivationMinutes: number
  /**
   * Account 登録時に MFA enrollment を確認した日時です。
   */
  mfaVerifiedAt: string
  /**
   * Break-glass activation が最後に成功した日時です。
   */
  lastTestedAt?: string
  /**
   * Optimistic concurrency に使う monotonically increasing version です。
   */
  revision: number
  /**
   * Account 作成日時です。
   */
  createdAt: string
  /**
   * Account 最終更新日時です。
   */
  updatedAt: string
}

/**
 * 理由と期限を持つ break-glass activation です。
 */
export type EnterpriseBreakGlassActivation = {
  /**
   * Activation が属する Workspace ID です。
   */
  workspaceId: string
  /**
   * Activation の immutable ID です。
   */
  activationId: string
  /**
   * 利用した break-glass account ID です。
   */
  accountId: string
  /**
   * Activation を開始した member key です。
   */
  actorMemberKey: string
  /**
   * MFA と再認証を確認した access token の SHA-256 session digest です。
   */
  authenticationSessionId: string
  /**
   * Mandatory な利用理由です。
   */
  reason: string
  /**
   * MFA verification が成立したことを示します。
   */
  mfaVerified: true
  /**
   * Activation 開始日時です。
   */
  startedAt: string
  /**
   * Activation expiry です。
   */
  expiresAt: string
  /**
   * Activation が早期 revoke された日時です。
   */
  revokedAt?: string
}

/**
 * Provisioning が検出した一つの desired-state change です。
 */
export type EnterpriseProvisioningChange = {
  /**
   * Change の deterministic ID です。
   */
  changeId: string
  /**
   * Change 対象の entity 種別です。
   */
  entityType: 'user' | 'group' | 'role-assignment' | 'session'
  /**
   * 対象 entity の immutable ID です。
   */
  entityId: string
  /**
   * Preview が固定した entity desired version です。
   */
  desiredVersion: number
  /**
   * Reconciliation が行う操作です。
   */
  action: 'create' | 'update' | 'deactivate' | 'delete' | 'revoke' | 'noop'
  /**
   * Operator に表示可能な影響説明です。
   */
  summary: string
  /**
   * Apply を止める impact かどうかです。
   */
  blocking: boolean
}

/**
 * Mutation を行わない provisioning dry-run 結果です。
 */
export type EnterpriseProvisioningPreview = {
  /**
   * Preview が属する Workspace ID です。
   */
  workspaceId: string
  /**
   * Preview の immutable ID です。
   */
  previewId: string
  /**
   * Apply 時に入力同一性を検証する fingerprint です。
   */
  fingerprint: string
  /**
   * Preview source です。
   */
  source: 'scim' | 'directory-reconciliation' | 'administrator'
  /**
   * Deterministic change plan です。
   */
  changes: EnterpriseProvisioningChange[]
  /**
   * Preview 作成日時です。
   */
  createdAt: string
  /**
   * Preview の有効期限です。
   */
  expiresAt: string
}

/**
 * Provisioning preview/reconcile の共通入力です。
 */
export type EnterpriseProvisioningInput = {
  /**
   * 対象 Workspace ID です。
   */
  workspaceId: string
  /**
   * Reconciliation source です。
   */
  source: 'scim' | 'directory-reconciliation' | 'administrator'
  /**
   * 同一 operation の再送を識別する key です。
   */
  idempotencyKey: string
  /**
   * Reconcile 対象の user ID です。省略時は全 user を対象にします。
   */
  userIds?: string[]
  /**
   * Reconcile 対象の group ID です。省略時は全 group を対象にします。
   */
  groupIds?: string[]
  /**
   * Deprovision preview で blocking impact として扱う protected member key 一覧です。
   */
  protectedMemberKeys?: string[]
  /**
   * Apply する preview の fingerprint です。
   */
  previewFingerprint?: string
}

/**
 * Provisioning run の lifecycle 状態です。
 */
export type EnterpriseProvisioningRun = {
  /**
   * Run が属する Workspace ID です。
   */
  workspaceId: string
  /**
   * Run の immutable ID です。
   */
  runId: string
  /**
   * Run の source です。
   */
  source: EnterpriseProvisioningInput['source']
  /**
   * 再送を同一 run に収束させる idempotency key です。
   */
  idempotencyKey: string
  /**
   * Apply した preview fingerprint です。
   */
  previewFingerprint: string
  /**
   * Run の現在状態です。
   */
  status: 'pending' | 'running' | 'succeeded' | 'failed'
  /**
   * 現在までの attempt 回数です。
   */
  attempt: number
  /**
   * Run に含まれる change plan です。
   */
  changes: EnterpriseProvisioningChange[]
  /**
   * Run 作成日時です。
   */
  createdAt: string
  /**
   * Run 最終更新日時です。
   */
  updatedAt: string
  /**
   * Run 完了日時です。
   */
  completedAt?: string
  /**
   * Running worker lease の expiry です。Process failure 後の安全な takeover に使います。
   */
  leaseExpiresAt?: string
  /**
   * Safe な failure code です。
   */
  failureCode?: string
}

/**
 * Operator が確認できる redacted provisioning log entry です。
 */
export type EnterpriseProvisioningLogEntry = {
  /**
   * Log が属する Workspace ID です。
   */
  workspaceId: string
  /**
   * Log の immutable ID です。
   */
  logId: string
  /**
   * Parent provisioning run ID です。
   */
  runId: string
  /**
   * Run attempt 番号です。
   */
  attempt: number
  /**
   * Log severity です。
   */
  level: 'info' | 'warning' | 'error'
  /**
   * Machine-readable safe code です。
   */
  code: string
  /**
   * Secret や raw IdP payload を含まない説明です。
   */
  message: string
  /**
   * Log 発生日時です。
   */
  createdAt: string
  /**
   * 同じ operation を retry できるかどうかです。
   */
  retryable: boolean
}

/**
 * Enterprise security 管理画面向けの集約 snapshot です。
 */
export type EnterpriseIdentitySnapshot = {
  /**
   * Snapshot 対象 Workspace ID です。
   */
  workspaceId: string
  /**
   * Enterprise CONTROL row の optimistic concurrency revision です。
   */
  controlRevision?: number
  /**
   * Current security policy です。
   */
  policy?: EnterpriseSecurityPolicy
  /**
   * Configured identity providers です。
   */
  identityProviders: EnterpriseIdentityProvider[]
  /**
   * Domain claims です。
   */
  domains: EnterpriseVerifiedDomain[]
  /**
   * Workspace-defined roles です。
   */
  customRoles: EnterpriseCustomRole[]
  /**
   * Directory group mappings です。
   */
  groupMappings: EnterpriseDirectoryGroupMapping[]
  /**
   * Direct and materialized role assignments です。
   */
  roleAssignments: EnterpriseRoleAssignment[]
  /**
   * SCIM directory users です。
   */
  scimUsers: EnterpriseScimUser[]
  /**
   * SCIM directory groups です。
   */
  scimGroups: EnterpriseScimGroup[]
  /**
   * SCIM credential metadata です。
   */
  scimCredentials: EnterpriseScimCredential[]
  /**
   * Non-interactive service accounts です。
   */
  serviceAccounts: EnterpriseServiceAccount[]
  /**
   * Emergency administrator accounts です。
   */
  breakGlassAccounts: EnterpriseBreakGlassAccount[]
  /**
   * Recent provisioning runs です。
   */
  provisioningRuns: EnterpriseProvisioningRun[]
  /**
   * Recent redacted provisioning logs です。
   */
  provisioningLogs: EnterpriseProvisioningLogEntry[]
}
