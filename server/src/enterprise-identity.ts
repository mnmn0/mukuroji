import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
  X509Certificate,
} from 'node:crypto'
import { isIP } from 'node:net'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  BatchWriteCommand,
  type BatchWriteCommandInput,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  type EnterpriseBreakGlassAccount,
  type EnterpriseBreakGlassActivation,
  type EnterpriseCustomRole,
  type EnterpriseDirectoryGroupMapping,
  type EnterpriseIdentityProvider,
  type EnterpriseIdentitySnapshot,
  type EnterpriseIssuedCredential,
  type EnterpriseIssuedServiceAccountCredential,
  type EnterprisePermissionId,
  type EnterpriseProvisioningInput,
  type EnterpriseProvisioningPreview,
  type EnterpriseProvisioningRun,
  type EnterpriseRoleAssignment,
  type EnterpriseRoleId,
  type EnterpriseRoutePermissionRule,
  type EnterpriseScimGroup,
  type EnterpriseScimGroupInput,
  type EnterpriseScimCredential,
  type EnterpriseScimUser,
  type EnterpriseScimUserInput,
  type EnterpriseSecurityPolicy,
  type EnterpriseServiceAccount,
  type EnterpriseServiceAccountCredential,
  type EnterpriseVerifiedDomain,
  ENTERPRISE_PERMISSION_IDS,
} from '@mukuroji/contracts'
import {
  createMutationAuditEventPut,
  type MutationAuditContext,
} from './audit'
import type {
  EnterpriseScimGroupJobReference,
} from './enterprise-scim-group-job-reference'

/**
 * Enterprise identity domain の safe API error です。
 */
export class EnterpriseIdentityError extends Error {
  /** HTTP response に対応する status code です。 */
  readonly status: number
  /** Client が分岐に利用できる stable code です。 */
  readonly code: string
  /** 同一 operation を安全に retry できるかどうかです。 */
  readonly retryable: boolean

  /**
   * Enterprise identity error を作成します。
   */
  constructor(
    status: number,
    code: string,
    message: string,
    retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'EnterpriseIdentityError'
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

/**
 * Stored provider と実際に Cognito Hosted UI へ渡す federation provider 名を照合します。
 */
export function assertEnterpriseCognitoProviderBinding(
  provider: EnterpriseIdentityProvider,
  configuredProviderName: string,
) {
  const configuredName = requireText(
    configuredProviderName,
    'Cognito enterprise identity provider name',
  )
  if (provider.cognitoProviderName !== configuredName) {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseCognitoProviderBindingMismatch',
      'The stored identity provider does not match the configured Cognito federation provider.',
    )
  }
}

/**
 * Cognito User Pool に実在する federation provider の比較可能な設定です。
 */
export type EnterpriseCognitoFederationBinding = {
  /** Cognito 上の case-sensitive provider 名です。 */
  providerName: string
  /** Cognito が返す provider protocol/type です。 */
  providerType: string
  /** Cognito に保存された provider-specific 設定です。 */
  providerDetails: Record<string, string>
}

/**
 * Stored provider、runtime 設定、Cognito の実 provider が同じ authority か照合します。
 *
 * @remarks
 * SAML は metadata URL、または inline metadata の entity/SSO/certificate を比較できない
 * provider 設定を拒否します。名前と protocol だけでは authority の一致とみなしません。
 */
export function assertEnterpriseCognitoFederationBinding(
  provider: EnterpriseIdentityProvider,
  configuredProviderName: string,
  binding: EnterpriseCognitoFederationBinding,
) {
  assertEnterpriseCognitoProviderBinding(provider, configuredProviderName)
  const expectedType = provider.kind === 'saml' ? 'SAML' : 'OIDC'
  if (
    binding.providerName !== provider.cognitoProviderName ||
    binding.providerType !== expectedType
  ) {
    throwEnterpriseCognitoBindingMismatch(
      'Cognito federation provider name or protocol does not match the stored provider.',
    )
  }
  if (provider.kind === 'oidc') {
    if (
      binding.providerDetails.oidc_issuer?.replace(/\/$/u, '') !==
        provider.issuer.replace(/\/$/u, '') ||
      binding.providerDetails.client_id !== provider.clientId
    ) {
      throwEnterpriseCognitoBindingMismatch(
        'Cognito OIDC provider issuer or client ID does not match the stored provider.',
      )
    }
    return
  }

  const metadataUrl = binding.providerDetails.MetadataURL?.trim()
  if (metadataUrl) {
    try {
      if (new URL(metadataUrl).toString() === provider.metadataUrl) return
    } catch {
      // Invalid Cognito metadata is handled as a binding mismatch below.
    }
    throwEnterpriseCognitoBindingMismatch(
      'Cognito SAML provider metadata URL does not match the stored provider.',
    )
  }

  const metadataFile = binding.providerDetails.MetadataFile?.trim()
  if (!metadataFile) {
    throwEnterpriseCognitoBindingMismatch(
      'Cognito SAML provider does not expose comparable metadata.',
    )
  }
  try {
    const entityDescriptor = metadataFile.match(
      /<(?:[A-Za-z0-9_-]+:)?EntityDescriptor\b[^>]*>/iu,
    )?.[0]
    const entityId = entityDescriptor
      ? readEnterpriseXmlAttribute(entityDescriptor, 'entityID')
      : undefined
    const singleSignOnUrls = [...metadataFile.matchAll(
      /<(?:[A-Za-z0-9_-]+:)?SingleSignOnService\b[^>]*>/giu,
    )]
      .map((match) => readEnterpriseXmlAttribute(match[0], 'Location'))
      .filter((value): value is string => Boolean(value))
      .map((value) => new URL(decodeEnterpriseXmlValue(value)).toString())
    const now = Date.now()
    const certificateFingerprints = [...metadataFile.matchAll(
      /<(?:[A-Za-z0-9_-]+:)?X509Certificate\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?X509Certificate>/giu,
    )]
      .map((match) => match[1]?.replace(/\s+/gu, ''))
      .filter((value): value is string => Boolean(value))
      .map((value) => new X509Certificate(
        `-----BEGIN CERTIFICATE-----\n${value}\n-----END CERTIFICATE-----`,
      ))
      .filter((certificate) =>
        Date.parse(certificate.validFrom) <= now && Date.parse(certificate.validTo) > now
      )
      .map((certificate) => certificate.fingerprint256.replaceAll(':', '').toLowerCase())
      .sort()
    const expectedFingerprints = [...provider.certificateFingerprints].sort()
    if (
      decodeEnterpriseXmlValue(entityId ?? '') !== provider.entityId ||
      !singleSignOnUrls.includes(provider.singleSignOnUrl) ||
      certificateFingerprints.length === 0 ||
      certificateFingerprints.length !== expectedFingerprints.length ||
      certificateFingerprints.some((fingerprint, index) =>
        fingerprint !== expectedFingerprints[index]
      )
    ) {
      throw new Error('SAML metadata differs from the stored provider.')
    }
    return
  } catch {
    throwEnterpriseCognitoBindingMismatch(
      'Cognito inline SAML metadata does not match the stored provider.',
    )
  }
}

/**
 * Federation/SCIM source に利用する provider が接続テスト済みで active か確認します。
 */
export function assertEnterpriseIdentityProviderReady(
  provider: EnterpriseIdentityProvider | undefined,
): asserts provider is EnterpriseIdentityProvider {
  if (
    !provider ||
    provider.status !== 'active' ||
    !provider.lastTestedAt ||
    !Number.isFinite(Date.parse(provider.lastTestedAt))
  ) {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseIdentityProviderNotReady',
      'An active, connection-tested identity provider is required.',
    )
  }
}

/**
 * Enterprise authorization に渡す principal context です。
 */
export type EnterprisePrincipalContext = {
  /** Principal の種別です。 */
  kind: 'member' | 'service-account' | 'break-glass'
  /** Workspace 内の immutable principal ID です。 */
  principalId: string
  /** Cognito が現在の token に含めた directory group ID 一覧です。 */
  directoryGroupIds: string[]
  /** Provider-qualified な active SCIM group membership 一覧です。 */
  directoryGroupMemberships?: EnterpriseDirectoryGroupMembership[]
  /** Built-in Workspace role です。 */
  workspaceRole?: 'owner' | 'admin' | 'member' | 'guest'
  /** Built-in Workspace role permission を custom/mapped role と合成するかどうかです。 */
  includeWorkspaceRolePermissions?: boolean
  /** System administrator の live membership が確認済みかどうかです。 */
  systemAdministrator?: boolean
  /** Service account 等に直接付与された permission です。 */
  directPermissions?: EnterprisePermissionId[]
  /** Guest/external principal に適用する permission ceiling です。 */
  permissionCeiling?: EnterprisePermissionId[]
}

/**
 * Provider-qualified な SCIM directory group membership です。
 */
export type EnterpriseDirectoryGroupMembership = {
  /** Group を供給した identity provider ID です。 */
  identityProviderId: string
  /** Mukuroji が発行した immutable SCIM group ID です。 */
  groupId: string
  /** Upstream directory が発行した immutable group ID です。 */
  externalId: string
}

/**
 * HTTP/realtime evaluator が共有する authoritative directory principal 解決結果です。
 */
export type EnterpriseDirectoryPrincipalResolution = {
  /** Principal が provider readiness に関係なく SCIM directory 管理下かどうかです。 */
  directoryManaged: boolean
  /** 現在の Cognito token から取得した group ID 一覧です。 */
  directoryGroupIds: string[]
  /** Provider-qualified な active SCIM group membership 一覧です。 */
  directoryGroupMemberships: EnterpriseDirectoryGroupMembership[]
  /** 同じ provider の membership と一致する mapping 一覧です。 */
  compatibleGroupMappings: EnterpriseDirectoryGroupMapping[]
  /** Provider binding を満たす assignment 一覧です。 */
  compatibleRoleAssignments: EnterpriseRoleAssignment[]
  /** Principal に紐づく inactive SCIM user が存在するかどうかです。 */
  deprovisioned: boolean
}

/**
 * Enterprise authorization が評価する resource context です。
 */
export type EnterpriseAuthorizationResource = {
  /** Resource が属する Workspace ID です。 */
  workspaceId: string
  /** Resource scope の種別です。 */
  kind: 'workspace' | 'team' | 'project'
  /** Team または Project ID です。 */
  targetId?: string
  /** Project resource が属する Team ID です。 */
  parentTeamId?: string
}

/**
 * Enterprise access evaluator の入力です。
 */
export type EvaluateEnterpriseAccessInput = {
  /** Route が要求する permission です。 */
  permission: EnterprisePermissionId
  /** 認証済み principal です。 */
  principal: EnterprisePrincipalContext
  /** Direct/materialized role assignment 一覧です。 */
  assignments: EnterpriseRoleAssignment[]
  /** Workspace custom role 一覧です。 */
  customRoles: EnterpriseCustomRole[]
  /** Directory group mapping 一覧です。 */
  groupMappings: EnterpriseDirectoryGroupMapping[]
  /** 評価対象 resource です。 */
  resource: EnterpriseAuthorizationResource
}

/**
 * Enterprise authorization の決定と effective permission set です。
 */
export type EnterpriseEffectiveAccess = {
  /** 要求 permission が許可されたかどうかです。 */
  allowed: boolean
  /** Resource 上で有効な permission 一覧です。 */
  permissions: EnterprisePermissionId[]
  /** Deny の safe reason code です。 */
  reason?: 'permission-missing' | 'guest-ceiling' | 'scope-mismatch'
}

/**
 * Token/session security validation の入力です。
 */
export type EnterpriseSessionContext = {
  /** Access token の authentication time (epoch seconds) です。 */
  authenticatedAt: number
  /** 検証時刻 (epoch seconds) です。 */
  now: number
  /** Authentication method reference 一覧です。 */
  authenticationMethods: string[]
  /** 信頼済み transport/proxy から解決した client IP です。 */
  clientIp?: string
  /** Sensitive/privileged route かどうかです。 */
  privileged: boolean
  /** Guest/external principal かどうかです。 */
  external: boolean
  /** Active break-glass activation を使うかどうかです。 */
  breakGlass: boolean
}

/**
 * Token/session security validation の結果です。
 */
export type EnterpriseSessionValidation = {
  /** Session が現在の policy を満たすかどうかです。 */
  valid: boolean
  /** Reject の safe reason code です。 */
  reason?: 'mfa-required' | 'session-expired' | 'reauthentication-required' | 'ip-denied'
}

/**
 * SCIM User collection の equality filter です。
 */
export type EnterpriseScimUserListFilter = {
  /** DynamoDB lookup partition で照合する SCIM User field です。 */
  field: 'externalId' | 'userName' | 'displayName'
  /** externalId は case-sensitive、userName/displayName は case-insensitive に照合します。 */
  value: string
}

/**
 * SCIM Group collection の equality filter です。
 */
export type EnterpriseScimGroupListFilter = {
  /** DynamoDB lookup partition で照合する SCIM Group field です。 */
  field: 'externalId' | 'displayName'
  /** externalId は case-sensitive、displayName は case-insensitive に照合します。 */
  value: string
}

/**
 * SCIM User collection の page request です。
 */
export type EnterpriseScimUserListInput = {
  /** User collection が属する Workspace ID です。 */
  workspaceId: string
  /** Credential に bind された identity provider ID です。 */
  identityProviderId: string
  /** SCIM の1始まり page offset です。 */
  startIndex: number
  /** 返す最大 resource 数です。 */
  count: number
  /** Optional equality filter です。 */
  filter?: EnterpriseScimUserListFilter
}

/**
 * SCIM Group collection の page request です。
 */
export type EnterpriseScimGroupListInput = {
  /** Group collection が属する Workspace ID です。 */
  workspaceId: string
  /** Credential に bind された identity provider ID です。 */
  identityProviderId: string
  /** SCIM の1始まり page offset です。 */
  startIndex: number
  /** 返す最大 resource 数です。 */
  count: number
  /** Optional equality filter です。 */
  filter?: EnterpriseScimGroupListFilter
}

/**
 * SCIM User collection の page です。
 */
export type EnterpriseScimUserPage = {
  /** Filter 適用後の resource 総数です。 */
  totalResults: number
  /** Request と同じ1始まり page offset です。 */
  startIndex: number
  /** Page に含まれる SCIM Users です。 */
  resources: EnterpriseScimUser[]
}

/**
 * SCIM Group collection の page です。
 */
export type EnterpriseScimGroupPage = {
  /** Filter 適用後の resource 総数です。 */
  totalResults: number
  /** Request と同じ1始まり page offset です。 */
  startIndex: number
  /** Page に含まれる SCIM Groups です。 */
  resources: EnterpriseScimGroup[]
}

/**
 * SCIM bearer credential と current provider の targeted authentication 結果です。
 */
export type EnterpriseScimWorkspaceAuthentication = {
  /** 認証済み Workspace-scoped SCIM credential metadata です。 */
  credential: EnterpriseScimCredential
  /** Credential が bind された current active identity provider です。 */
  provider: EnterpriseIdentityProvider
}

/**
 * Workspace ごとの SCIM resource hard cap です。
 */
export type EnterpriseScimResourceLimits = {
  /** Inactive resource を含む User 上限です。 */
  maximumUsers: number
  /** Inactive resource を含む Group 上限です。 */
  maximumGroups: number
}

/**
 * Durable SCIM group reconciliation job の内部 state です。
 */
export type EnterpriseScimGroupJob = {
  /** Job が属する canonical Workspace ID です。 */
  workspaceId: string
  /** Group ごとに安定した reconciliation job ID です。 */
  jobId: string
  /** Reconcile 対象の immutable SCIM group ID です。 */
  groupId: string
  /** Job が適用する group desired version です。 */
  groupVersion: number
  /** 未処理 page を含む affected SCIM user ID 一覧です。 */
  targetUserIds: string[]
  /** Desired group 適用後の収束確認を含む現在の処理 phase です。 */
  phase: 'apply' | 'settle'
  /** 次の page が開始する0始まり offset です。 */
  cursor: number
  /** Stale stream event を除外する monotonically increasing revision です。 */
  revision: number
  /** Job 作成日時です。 */
  createdAt: string
  /** Job 最終更新日時です。 */
  updatedAt: string
}

/**
 * 一つの SCIM group job user callback に渡す immutable snapshot です。
 */
export type EnterpriseScimGroupJobApplyInput = {
  /** Job page 全体で共有する一度だけ読み込んだ identity snapshot です。 */
  snapshot: EnterpriseIdentitySnapshot
  /** Callback が参照した identity snapshot の storage revision です。 */
  snapshotRevision: number
  /** Job が適用する current desired group です。 */
  group: EnterpriseScimGroup
  /** Sequential に適用する affected user です。 */
  user: EnterpriseScimUser
  /** Callback が desired-state 適用または適用後収束のどちらかを示します。 */
  phase: EnterpriseScimGroupJob['phase']
  /** Callback と retry を識別する durable job reference です。 */
  reference: EnterpriseScimGroupJobReference
  /** 同じ revision の retry で固定される job timestamp です。 */
  jobUpdatedAt: string
}

/**
 * SCIM group job の一つの user side effect を適用する callback です。
 */
export type EnterpriseScimGroupJobApplyUser = (
  input: EnterpriseScimGroupJobApplyInput,
) => Promise<void>

/**
 * SCIM group job page processor の結果です。
 */
export type EnterpriseScimGroupJobProcessResult =
  | {
      /** Event が current job と一致しないため副作用なしで完了した状態です。 */
      status: 'stale'
    }
  | {
      /** 次の MODIFY stream event で継続する状態です。 */
      status: 'continued'
      /** Atomic checkpoint が発行した次の durable reference です。 */
      nextReference: EnterpriseScimGroupJobReference
      /** この page で適用済みにした user ID 一覧です。 */
      processedUserIds: string[]
    }
  | {
      /** 全 target と group checkpoint が完了した状態です。 */
      status: 'completed'
      /** 最終 page で適用済みにした user ID 一覧です。 */
      processedUserIds: string[]
    }

/** Production で適用する Workspace 単位の SCIM resource hard cap です。 */
export const ENTERPRISE_SCIM_RESOURCE_LIMITS: EnterpriseScimResourceLimits = {
  maximumUsers: 10_000,
  maximumGroups: 2_000,
}

/** 一つの SCIM Group に保持できる member 数です。 */
export const ENTERPRISE_SCIM_GROUP_MEMBER_LIMIT = 1_000

/** 一つの durable SCIM Group job に保持できる affected user 数です。 */
export const ENTERPRISE_SCIM_GROUP_JOB_TARGET_LIMIT = 2_000

/** 一回の SCIM Group worker invocation で逐次処理する user 数です。 */
export const ENTERPRISE_SCIM_GROUP_JOB_PAGE_SIZE = 5

/** 一つの SCIM Group collection response に返せる resource 数です。 */
export const ENTERPRISE_SCIM_GROUP_PAGE_LIMIT = 20

/** SCIM member.value に許可する UTF-8 byte 数です。 */
export const ENTERPRISE_SCIM_MEMBER_ID_MAX_BYTES = 128

/** SCIM resource ID に許可する UTF-8 byte 数です。 */
export const ENTERPRISE_SCIM_RESOURCE_ID_MAX_BYTES = 128

/** SCIM externalId に許可する UTF-8 byte 数です。 */
export const ENTERPRISE_SCIM_EXTERNAL_ID_MAX_BYTES = 256

/** SCIM userName と email に許可する UTF-8 byte 数です。 */
export const ENTERPRISE_SCIM_USER_IDENTIFIER_MAX_BYTES = 320

/** SCIM displayName に許可する UTF-8 byte 数です。 */
export const ENTERPRISE_SCIM_DISPLAY_NAME_MAX_BYTES = 256

/** SCIM mutation の Idempotency-Key に許可する UTF-8 byte 数です。 */
export const ENTERPRISE_SCIM_IDEMPOTENCY_KEY_MAX_BYTES = 256

/** 一つの SCIM User に保持できる email 数です。 */
export const ENTERPRISE_SCIM_USER_EMAIL_LIMIT = 10

/** 一つの provider が同時に保持できる active SCIM credential 数です。 */
export const ENTERPRISE_SCIM_ACTIVE_CREDENTIAL_LIMIT_PER_PROVIDER = 10

/** 一つの Workspace が同時に保持できる active SCIM credential 数です。 */
export const ENTERPRISE_SCIM_ACTIVE_CREDENTIAL_LIMIT_PER_WORKSPACE = 50

/**
 * Enterprise identity state を読み書きする application client です。
 */
export interface EnterpriseIdentityClient {
  /** Workspace の enterprise identity/security snapshot を返します。 */
  getSnapshot(workspaceId: string): Promise<EnterpriseIdentitySnapshot>
  /** Provider-scoped SCIM User collection を page 取得します。 */
  listScimUsers(input: EnterpriseScimUserListInput): Promise<EnterpriseScimUserPage>
  /** Provider-scoped SCIM Group collection を page 取得します。 */
  listScimGroups(input: EnterpriseScimGroupListInput): Promise<EnterpriseScimGroupPage>
  /** Email domain に適用される active SSO provider を返します。 */
  discoverSso(email: string): Promise<{
    domain: EnterpriseVerifiedDomain
    provider: EnterpriseIdentityProvider
  } | undefined>
  /** SAML/OIDC provider を安全に upsert します。 */
  putIdentityProvider(
    provider: EnterpriseIdentityProvider,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseIdentityProvider>
  /** Verified domain claim を安全に upsert します。 */
  putVerifiedDomain(
    domain: EnterpriseVerifiedDomain,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseVerifiedDomain>
  /** 全 verified domain の SSO enforcement を一つの transaction で切り替えます。 */
  setSsoEnforcement(
    workspaceId: string,
    enforced: boolean,
    identityProviderId: string | undefined,
    expectedProviderRevision: number,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseVerifiedDomain[]>
  /** Authentication/session policy を安全に upsert します。 */
  putSecurityPolicy(
    policy: EnterpriseSecurityPolicy,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseSecurityPolicy>
  /** Custom role を安全に upsert します。 */
  putCustomRole(
    role: EnterpriseCustomRole,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseCustomRole>
  /** 未使用 custom role を削除します。 */
  deleteCustomRole(
    workspaceId: string,
    roleId: string,
    expectedRevision: number,
    auditContext?: MutationAuditContext,
  ): Promise<void>
  /** Directory group mapping を安全に upsert します。 */
  putGroupMapping(
    mapping: EnterpriseDirectoryGroupMapping,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseDirectoryGroupMapping>
  /** Directory group mapping を削除します。 */
  deleteGroupMapping(
    workspaceId: string,
    mappingId: string,
    expectedRevision: number,
    auditContext?: MutationAuditContext,
  ): Promise<void>
  /** SCIM bearer credential を一度だけ発行します。 */
  issueScimToken(
    workspaceId: string,
    identityProviderId: string,
    label: string,
    expiresAt?: string,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseIssuedCredential>
  /** 全 active SCIM credential を revoke し、新 credential を原子的に発行します。 */
  rotateScimToken(
    workspaceId: string,
    identityProviderId: string,
    label: string,
    expectedGeneration: number,
    idempotencyKey: string,
    requestFingerprint: string,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseIssuedCredential>
  /** SCIM bearer credential を HMAC digest で認証して provider binding を返します。 */
  authenticateScimToken(
    workspaceId: string,
    token: string,
  ): Promise<EnterpriseScimCredential | undefined>
  /** Direct auth projection から SCIM credential と current provider を認証します。 */
  authenticateScimWorkspace(
    workspaceId: string,
    token: string,
  ): Promise<EnterpriseScimWorkspaceAuthentication | undefined>
  /** SCIM bearer credential を revoke します。 */
  revokeScimToken(
    workspaceId: string,
    credentialId: string,
    auditContext?: MutationAuditContext,
  ): Promise<void>
  /** SCIM user desired state を idempotent に upsert します。 */
  upsertScimUser(
    input: EnterpriseScimUserInput,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseScimUser>
  /** SCIM user desired state を idempotent に deactivate します。 */
  deactivateScimUser(
    workspaceId: string,
    identityProviderId: string,
    userId: string,
    idempotencyKey: string,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseScimUser | undefined>
  /** SCIM user desired version の Workspace 適用成功を checkpoint します。 */
  markScimUserApplied(
    workspaceId: string,
    userId: string,
    desiredVersion: number,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseScimUser>
  /** SCIM group desired state を idempotent に upsert します。 */
  upsertScimGroup(
    input: EnterpriseScimGroupInput,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseScimGroup>
  /** SCIM group desired state を idempotent に deactivate します。 */
  deactivateScimGroup(
    workspaceId: string,
    identityProviderId: string,
    groupId: string,
    idempotencyKey: string,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseScimGroup | undefined>
  /** SCIM group desired version の Workspace 適用成功を checkpoint します。 */
  markScimGroupApplied(
    workspaceId: string,
    groupId: string,
    desiredVersion: number,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseScimGroup>
  /** Current pending SCIM group job の stream reference を返します。 */
  getScimGroupJobReference(
    workspaceId: string,
    groupId: string,
  ): Promise<EnterpriseScimGroupJobReference | undefined>
  /** 一つの durable SCIM group job page を逐次適用し、原子的に checkpoint します。 */
  processScimGroupJob(
    reference: EnterpriseScimGroupJobReference,
    applyUser: EnterpriseScimGroupJobApplyUser,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseScimGroupJobProcessResult>
  /** Reconciliation の mutation-free impact preview を返します。 */
  previewProvisioning(
    input: EnterpriseProvisioningInput,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseProvisioningPreview>
  /** ID で未失効 provisioning preview を返します。 */
  getProvisioningPreview(
    workspaceId: string,
    previewId: string,
  ): Promise<EnterpriseProvisioningPreview | undefined>
  /** 確認済み preview を idempotent に apply します。 */
  reconcileProvisioning(
    input: EnterpriseProvisioningInput,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseProvisioningRun>
  /** Reserved provisioning run を side effect の結果で確定します。 */
  finalizeProvisioningRun(
    workspaceId: string,
    runId: string,
    outcome: 'succeeded' | 'failed',
    failureCode?: string,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseProvisioningRun>
  /** Failed provisioning run を同じ plan で retry します。 */
  retryProvisioning(
    workspaceId: string,
    runId: string,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseProvisioningRun>
  /** Service account metadata を作成します。 */
  createServiceAccount(
    account: EnterpriseServiceAccount,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseServiceAccount>
  /** Service account と最初の one-time credential を原子的かつ idempotent に作成します。 */
  createServiceAccountWithToken(
    account: EnterpriseServiceAccount,
    idempotencyKey: string,
    requestFingerprint: string,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseIssuedServiceAccountCredential & { account: EnterpriseServiceAccount }>
  /** Service account credential を一度だけ発行します。 */
  issueServiceAccountToken(
    workspaceId: string,
    accountId: string,
    expiresAt?: string,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseIssuedServiceAccountCredential>
  /** Existing credential を原子的に revoke して新しい credential を発行します。 */
  rotateServiceAccountToken(
    workspaceId: string,
    accountId: string,
    expectedRevision: number,
    idempotencyKey: string,
    requestFingerprint: string,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseIssuedServiceAccountCredential>
  /** Service account bearer credential を認証します。 */
  authenticateServiceAccountToken(
    workspaceId: string,
    token: string,
  ): Promise<EnterpriseServiceAccount | undefined>
  /** 全 boundary check 成功後に service account の last-used/audit を更新します。 */
  recordServiceAccountUse(
    workspaceId: string,
    accountId: string,
    auditContext?: MutationAuditContext,
  ): Promise<void>
  /** Service account credential または account 全体を revoke します。 */
  revokeServiceAccountToken(
    workspaceId: string,
    accountId: string,
    credentialId?: string,
    expectedRevision?: number,
    auditContext?: MutationAuditContext,
  ): Promise<void>
  /** Break-glass account metadata を upsert します。 */
  putBreakGlassAccount(
    account: EnterpriseBreakGlassAccount,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseBreakGlassAccount>
  /** 理由・MFA・期限付きの break-glass activation を作成します。 */
  activateBreakGlass(
    workspaceId: string,
    accountId: string,
    actorMemberKey: string,
    authenticationSessionId: string,
    reason: string,
    durationMinutes: number,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseBreakGlassActivation>
  /** Current member の active break-glass elevation だけを早期終了します。 */
  revokeBreakGlassActivation(
    workspaceId: string,
    actorMemberKey: string,
    authenticationSessionId: string,
    auditContext?: MutationAuditContext,
  ): Promise<void>
  /** Active break-glass activation を早期 revoke します。 */
  deactivateBreakGlass(
    workspaceId: string,
    accountId: string,
    expectedRevision: number,
    auditContext?: MutationAuditContext,
  ): Promise<void>
  /** Member の current authentication session に対する有効な activation を返します。 */
  getActiveBreakGlassActivation(
    workspaceId: string,
    memberKey: string,
    authenticationSessionId: string,
  ): Promise<EnterpriseBreakGlassActivation | undefined>
}

/**
 * Credential secret を持たずに enterprise security state を読む client です。
 */
export interface EnterpriseIdentityReadClient {
  /** Workspace の enterprise identity/security snapshot を返します。 */
  getSnapshot(workspaceId: string): Promise<EnterpriseIdentitySnapshot>
  /** Member の current authentication session に対する有効な activation を返します。 */
  getActiveBreakGlassActivation(
    workspaceId: string,
    memberKey: string,
    authenticationSessionId: string,
  ): Promise<EnterpriseBreakGlassActivation | undefined>
}

const builtInRolePermissions = {
  'workspace:owner': [...ENTERPRISE_PERMISSION_IDS],
  'workspace:admin': ENTERPRISE_PERMISSION_IDS.filter((permission) =>
    permission !== 'audit.export' && permission !== 'service-accounts.use'
  ),
  'workspace:member': ENTERPRISE_PERMISSION_IDS.filter((permission) =>
    !permission.endsWith('.manage') &&
    permission !== 'audit.read' &&
    permission !== 'audit.export' &&
    permission !== 'identity.read' &&
    permission !== 'security.read' &&
    permission !== 'service-accounts.use'
  ),
  'workspace:guest': ENTERPRISE_PERMISSION_IDS.filter((permission) =>
    permission.endsWith('.read') &&
    permission !== 'audit.read' &&
    permission !== 'identity.read' &&
    permission !== 'security.read'
  ),
  'team:manager': ['teams.read', 'teams.write', 'teams.manage', 'projects.read', 'projects.write',
    'projects.manage', 'work-items.read', 'work-items.write', 'documents.read', 'documents.write',
    'documents.manage', 'files.read', 'files.write', 'files.approve', 'planning.read',
    'planning.write', 'planning.manage'] as EnterprisePermissionId[],
  'team:member': ['teams.read', 'teams.write', 'projects.read', 'projects.write', 'work-items.read',
    'work-items.write', 'documents.read', 'documents.write', 'files.read', 'files.write',
    'planning.read'] as EnterprisePermissionId[],
  'project:manager': ['projects.read', 'projects.write', 'projects.manage', 'work-items.read',
    'work-items.write', 'documents.read', 'documents.write', 'documents.manage', 'files.read',
    'files.write', 'files.approve', 'planning.read', 'planning.write',
    'planning.manage'] as EnterprisePermissionId[],
  'project:member': ['projects.read', 'projects.write', 'work-items.read', 'work-items.write',
    'documents.read', 'documents.write', 'files.read', 'files.write', 'planning.read'] as
    EnterprisePermissionId[],
  'project:viewer': ['projects.read', 'work-items.read', 'documents.read', 'files.read',
    'planning.read'] as EnterprisePermissionId[],
} as const

/**
 * Built-in/custom role の canonical permission set を返します。
 *
 * @remarks
 * 不明な role ID は権限を一切返しません。呼び出し側は、この結果を role の存在確認の
 * 代用にせず、入力境界で role ID と scope の妥当性も検証してください。
 */
export function resolveEnterpriseRolePermissions(
  customRoles: readonly EnterpriseCustomRole[],
  roleId: EnterpriseRoleId,
): EnterprisePermissionId[] {
  const builtIn = builtInRolePermissions[roleId as keyof typeof builtInRolePermissions]
  if (builtIn) return [...builtIn]
  return [...(customRoles.find((role) => role.roleId === roleId)?.permissions ?? [])]
}

/**
 * Role が指定 resource scope に割り当て可能な種類かどうかを返します。
 */
export function isEnterpriseRoleCompatibleWithScope(
  roleId: EnterpriseRoleId,
  scopeKind: 'workspace' | 'team' | 'project',
): boolean {
  return roleId.startsWith('custom:') || roleId.startsWith(`${scopeKind}:`)
}

/**
 * 呼び出し principal が自分の effective permission を超えずに role を割り当てられるか返します。
 */
export function canAssignEnterpriseRole(
  customRoles: readonly EnterpriseCustomRole[],
  callerPermissions: readonly EnterprisePermissionId[],
  roleId: EnterpriseRoleId,
  scopeKind: 'workspace' | 'team' | 'project',
): boolean {
  const roleExists = roleId.startsWith('custom:')
    ? customRoles.some((role) => role.roleId === roleId)
    : Object.hasOwn(builtInRolePermissions, roleId)
  if (!roleExists || !isEnterpriseRoleCompatibleWithScope(roleId, scopeKind)) return false
  return resolveEnterpriseRolePermissions(customRoles, roleId).every((permission) =>
    callerPermissions.includes(permission)
  )
}

/**
 * Request method/path に最初に一致する permission を返します。
 *
 * @remarks Rule が無い route は `undefined` となり deny-by-default です。
 */
export function resolveRoutePermission(
  method: string,
  path: string,
  rules: readonly EnterpriseRoutePermissionRule[],
) {
  return resolveRoutePermissions(method, path, rules)?.[0]
}

/**
 * Request method/path に最初に一致する rule の any-of permission 一覧を返します。
 *
 * @remarks Rule が無い route は `undefined` となり deny-by-default です。
 */
export function resolveRoutePermissions(
  method: string,
  path: string,
  rules: readonly EnterpriseRoutePermissionRule[],
) {
  const normalizedMethod = method.trim().toUpperCase()
  const normalizedPath = normalizePath(path)
  const rule = rules.find((candidate) =>
    (candidate.method === '*' || candidate.method === normalizedMethod) &&
    routePatternMatches(candidate.pathPattern, normalizedPath)
  )
  return rule
    ? [rule.permission, ...(rule.alternativePermissions ?? [])]
    : undefined
}

/**
 * SCIM user/group と Cognito group を provider-aware な認可 context へ解決します。
 *
 * @remarks
 * SCIM group ID は Cognito group ID と同じ namespace に flatten しません。Mapping は
 * user、group、mapping の `identityProviderId` がすべて一致した場合だけ有効です。
 */
export function resolveEnterpriseDirectoryPrincipal(
  snapshot: EnterpriseIdentitySnapshot,
  principalId: string,
  cognitoGroupIds: readonly string[],
): EnterpriseDirectoryPrincipalResolution {
  const normalizedPrincipalId = principalId.trim().toLowerCase()
  const eligibleProviderIds = new Set(
    snapshot.identityProviders
      .filter((provider) =>
        provider.status === 'active' &&
        provider.lastTestedAt !== undefined &&
        Number.isFinite(Date.parse(provider.lastTestedAt))
      )
      .map((provider) => provider.providerId),
  )
  const linkedScimUsers = snapshot.scimUsers.filter((candidate) =>
    candidate.linkedMemberKey?.trim().toLowerCase() === normalizedPrincipalId
  )
  const activeScimUsers = linkedScimUsers.filter((candidate) =>
    eligibleProviderIds.has(candidate.identityProviderId) &&
    candidate.active && candidate.appliedVersion >= candidate.version
  )
  const directoryGroupMemberships = snapshot.scimGroups
    .filter((group) =>
      eligibleProviderIds.has(group.identityProviderId) &&
      group.active &&
      group.appliedVersion >= group.version &&
      activeScimUsers.some((user) =>
        user.identityProviderId === group.identityProviderId &&
        group.memberUserIds.includes(user.userId)
      )
    )
    .map((group) => ({
      identityProviderId: group.identityProviderId,
      groupId: group.groupId,
      externalId: group.externalId,
    }))
  const compatibleGroupMappings = snapshot.groupMappings.filter((mapping) =>
    eligibleProviderIds.has(mapping.identityProviderId) &&
    mapping.enabled &&
    directoryGroupMemberships.some((membership) =>
      membership.identityProviderId === mapping.identityProviderId &&
      (
        membership.groupId === mapping.directoryGroupId ||
        membership.externalId === mapping.directoryGroupId
      )
    )
  )
  const compatibleMappingIds = new Set(
    compatibleGroupMappings.map((mapping) => mapping.mappingId),
  )

  return {
    directoryManaged: linkedScimUsers.length > 0,
    directoryGroupIds: [...new Set(
      cognitoGroupIds.map((groupId) => groupId.trim()).filter(Boolean),
    )],
    directoryGroupMemberships,
    compatibleGroupMappings,
    compatibleRoleAssignments: snapshot.roleAssignments.filter((assignment) =>
      assignment.principalKind !== 'directory-group' ||
      assignment.source !== 'directory-mapping' ||
      assignment.mappingId !== undefined && compatibleMappingIds.has(assignment.mappingId)
    ),
    deprovisioned: linkedScimUsers.length > 0 &&
      linkedScimUsers.every((candidate) =>
        !candidate.active &&
        candidate.appliedVersion >= candidate.version
      ),
  }
}

/**
 * Built-in/custom role、direct assignment、directory mapping、guest ceiling を統合して認可します。
 */
export function evaluateEnterpriseAccess(
  input: EvaluateEnterpriseAccessInput,
): EnterpriseEffectiveAccess {
  if (input.principal.systemAdministrator || input.principal.kind === 'break-glass') {
    return { allowed: true, permissions: [...ENTERPRISE_PERMISSION_IDS] }
  }

  const roleIds = new Set<string>()
  if (
    input.principal.workspaceRole &&
    input.principal.includeWorkspaceRolePermissions !== false
  ) {
    roleIds.add(`workspace:${input.principal.workspaceRole}`)
  }
  let matchingScopedGrant = input.resource.kind === 'workspace'
  for (const assignment of input.assignments) {
    const mapping = assignment.source === 'directory-mapping' && assignment.mappingId
      ? input.groupMappings.find((candidate) =>
          candidate.enabled && candidate.mappingId === assignment.mappingId
        )
      : undefined
    const principalMatches =
      assignment.principalKind === input.principal.kind &&
        assignment.principalId === input.principal.principalId ||
      assignment.principalKind === 'directory-group' &&
        (
          assignment.source !== 'directory-mapping'
            ? input.principal.directoryGroupIds.includes(assignment.principalId)
            : mapping !== undefined &&
              mapping.directoryGroupId === assignment.principalId &&
              directoryMembershipMatches(
                input.principal.directoryGroupMemberships,
                mapping,
              )
        )
    if (
      principalMatches &&
      scopeMatches(assignment.scope, input.resource)
    ) {
      roleIds.add(assignment.roleId)
      matchingScopedGrant = true
    }
  }
  for (const mapping of input.groupMappings) {
    if (
      mapping.enabled &&
      directoryMembershipMatches(
        input.principal.directoryGroupMemberships,
        mapping,
      ) &&
      scopeMatches(mapping.scope, input.resource)
    ) {
      roleIds.add(mapping.roleId)
      matchingScopedGrant = true
    }
  }

  const permissions = new Set(input.principal.directPermissions ?? [])
  for (const roleId of roleIds) {
    const customRole = input.customRoles.find((role) => role.roleId === roleId)
    if (
      customRole &&
      input.principal.workspaceRole === 'guest' &&
      !customRole.guestAssignable
    ) {
      continue
    }
    for (const permission of resolveEnterpriseRolePermissions(
      input.customRoles,
      roleId as EnterpriseRoleId,
    )) {
      permissions.add(permission)
    }
  }

  const ceiling = input.principal.permissionCeiling
  if (ceiling) {
    for (const permission of permissions) {
      if (!ceiling.includes(permission)) permissions.delete(permission)
    }
    if (!ceiling.includes(input.permission)) {
      return {
        allowed: false,
        permissions: [...permissions],
        reason: 'guest-ceiling',
      }
    }
  }
  const allowed = permissions.has(input.permission)
  return {
    allowed,
    permissions: [...permissions],
    ...(allowed
      ? {}
      : { reason: matchingScopedGrant ? 'permission-missing' as const : 'scope-mismatch' as const }),
  }
}

function directoryMembershipMatches(
  memberships: readonly EnterpriseDirectoryGroupMembership[] | undefined,
  mapping: EnterpriseDirectoryGroupMapping,
) {
  return memberships?.some((membership) =>
    membership.identityProviderId === mapping.identityProviderId &&
    (
      membership.groupId === mapping.directoryGroupId ||
      membership.externalId === mapping.directoryGroupId
    )
  ) === true
}

/**
 * MFA、absolute lifetime、sensitive re-authentication、IP allowlist を検証します。
 */
export function validateEnterpriseSession(
  policy: EnterpriseSecurityPolicy | undefined,
  context: EnterpriseSessionContext,
): EnterpriseSessionValidation {
  const methods = new Set(context.authenticationMethods.map((method) => method.toLowerCase()))
  if (!policy) {
    return context.breakGlass &&
        ![...methods].some((method) =>
          method.includes('mfa') || method.includes('otp') || method.includes('webauthn')
        )
      ? { valid: false, reason: 'mfa-required' }
      : { valid: true }
  }
  const requiresMfa = policy.mfaRequirement === 'required' ||
    context.external && policy.externalAccess.requireMfa ||
    context.breakGlass
  if (
    requiresMfa &&
    ![...methods].some((method) =>
      method.includes('mfa') || method.includes('otp') || method.includes('webauthn')
    )
  ) {
    return { valid: false, reason: 'mfa-required' }
  }
  const absoluteLifetime = context.external
    ? Math.min(
        policy.sessionLifetimeMinutes,
        policy.externalAccess.maximumSessionLifetimeMinutes,
      )
    : policy.sessionLifetimeMinutes
  const ageSeconds = context.now - context.authenticatedAt
  if (ageSeconds < 0 || ageSeconds > absoluteLifetime * 60) {
    return { valid: false, reason: 'session-expired' }
  }
  const reauthenticationMinutes = context.privileged
    ? policy.sensitiveActionReauthenticationMinutes
    : policy.reauthenticationIntervalMinutes
  if (ageSeconds > reauthenticationMinutes * 60) {
    return { valid: false, reason: 'reauthentication-required' }
  }
  const appliesIpAllowlist = !context.breakGlass &&
    (
      policy.ipAllowlistMode === 'all-users' ||
      policy.ipAllowlistMode === 'privileged-users' && context.privileged
    )
  if (
    appliesIpAllowlist &&
    (
      !context.clientIp ||
      !policy.ipAllowlist.some((cidr) => ipMatchesCidr(context.clientIp!, cidr))
    )
  ) {
    return { valid: false, reason: 'ip-denied' }
  }
  return { valid: true }
}

/**
 * IPv4/IPv6 address が CIDR range に含まれるかを判定します。
 */
export function ipMatchesCidr(address: string, cidr: string) {
  const [network, prefixText, ...extra] = cidr.trim().split('/')
  if (!network || !prefixText || extra.length > 0) return false
  const addressVersion = isIP(address.trim())
  if (addressVersion === 0 || addressVersion !== isIP(network)) return false
  const bitLength = addressVersion === 4 ? 32 : 128
  const prefix = Number(prefixText)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bitLength) return false
  const addressValue = addressVersion === 4
    ? parseIpv4(address.trim())
    : parseIpv6(address.trim())
  const networkValue = addressVersion === 4 ? parseIpv4(network) : parseIpv6(network)
  if (addressValue === undefined || networkValue === undefined) return false
  if (prefix === 0) return true
  const shift = BigInt(bitLength - prefix)
  return addressValue >> shift === networkValue >> shift
}

function normalizePath(path: string) {
  const normalized = `/${path.trim().replace(/^\/+|\/+$/gu, '')}`
  return normalized === '/' ? normalized : normalized.replace(/\/+$/gu, '')
}

function routePatternMatches(pattern: string, path: string) {
  const normalizedPattern = normalizePath(pattern)
  const wildcard = normalizedPattern.endsWith('*')
  const base = wildcard ? normalizedPattern.slice(0, -1) : normalizedPattern
  const expression = base
    .split('/')
    .map((segment) => segment.startsWith(':') ? '[^/]+' : escapeRegExp(segment))
    .join('/')
  return new RegExp(`^${expression}${wildcard ? '.*' : ''}$`, 'u').test(path)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function scopeMatches(
  scope: EnterpriseRoleAssignment['scope'],
  resource: EnterpriseAuthorizationResource,
) {
  if (scope.workspaceId !== resource.workspaceId) return false
  if (scope.kind === 'workspace') return true
  if (scope.kind === 'team') {
    return resource.kind === 'team' && scope.targetId === resource.targetId ||
      resource.kind === 'project' && scope.targetId === resource.parentTeamId
  }
  return resource.kind === 'project' && scope.targetId === resource.targetId
}

function parseIpv4(value: string) {
  const octets = value.split('.')
  if (octets.length !== 4) return undefined
  let parsed = 0n
  for (const octet of octets) {
    if (!/^(?:0|[1-9]\d{0,2})$/u.test(octet)) return undefined
    const number = Number(octet)
    if (number > 255) return undefined
    parsed = parsed << 8n | BigInt(number)
  }
  return parsed
}

function parseIpv6(value: string) {
  const normalized = value.toLowerCase()
  if (normalized.includes('.')) return undefined
  const doubleColonParts = normalized.split('::')
  if (doubleColonParts.length > 2) return undefined
  const left = doubleColonParts[0] ? doubleColonParts[0].split(':') : []
  const right = doubleColonParts[1] ? doubleColonParts[1].split(':') : []
  if (
    [...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/u.test(part)) ||
    doubleColonParts.length === 1 && left.length !== 8 ||
    doubleColonParts.length === 2 && left.length + right.length >= 8
  ) return undefined
  const groups = doubleColonParts.length === 2
    ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
    : left
  if (groups.length !== 8) return undefined
  return groups.reduce((result, group) => result << 16n | BigInt(`0x${group}`), 0n)
}

/**
 * 永続 state に保持する service credential metadata と HMAC digest です。
 */
type StoredServiceCredential = EnterpriseServiceAccountCredential & {
  /** Plaintext token の HMAC-SHA-256 digest です。 */
  digest: string
}

/**
 * 永続 state に保持する SCIM credential の HMAC digest です。
 */
type StoredScimCredentialDigest = {
  /** SCIM credential ID です。 */
  credentialId: string
  /** Plaintext token の HMAC-SHA-256 digest です。 */
  digest: string
}

/**
 * Public snapshot と operation recovery state をまとめた永続 record です。
 */
type EnterpriseIdentityState = EnterpriseIdentitySnapshot & {
  /** Optimistic concurrency に使う state revision です。 */
  storageRevision: number
  /** DynamoDB の CONTROL が参照する committed delta generation です。 */
  storageGeneration?: string
  /** DynamoDB CONTROL の active generation から snapshot までの chain です。 */
  storageGenerationChain: string[]
  /** Compactor が物理 TTL を付与している旧 generation です。 */
  storageRetiredGenerations: EnterpriseRetiredGeneration[]
  /** Raw secret を含まない service credential records です。 */
  serviceCredentials: StoredServiceCredential[]
  /** SCIM credential ID と digest の対応です。 */
  scimCredentialDigests: StoredScimCredentialDigest[]
  /** Pending durable SCIM group reconciliation jobs です。 */
  scimGroupJobs: EnterpriseScimGroupJob[]
  /** Expiry/revoke を含む break-glass activation 履歴です。 */
  breakGlassActivations: EnterpriseBreakGlassActivation[]
  /** Apply 前に短時間だけ保持する provisioning preview です。 */
  provisioningPreviews: EnterpriseProvisioningPreview[]
  /** Idempotency key と作成済み entity/run ID の対応です。 */
  idempotencyResults: Record<string, string>
  /** Idempotency key と canonical request fingerprint の対応です。 */
  idempotencyFingerprints: Record<string, string>
  /** Raw credential を安全に replay できる idempotency window の expiry です。 */
  idempotencyExpiresAt: Record<string, string>
}

/** Async compaction を開始する active generation 数です。 */
const ENTERPRISE_GENERATION_COMPACTION_THRESHOLD = 16

/** 一つの snapshot を含む最大 active generation 数です。 */
const ENTERPRISE_GENERATION_CHAIN_LIMIT = 64

/** 旧 generation を active reader のために残す猶予です。 */
const ENTERPRISE_GENERATION_RETIREMENT_GRACE_SECONDS = 60 * 60

/**
 * CONTROL が参照を外した generation と物理削除猶予です。
 */
type EnterpriseRetiredGeneration = {
  /** Retire 対象 generation ID です。 */
  stateGeneration: string
  /** Generation が表す logical revision です。 */
  generationRevision: number
  /** DynamoDB TTL に設定する epoch seconds です。 */
  expiresAt: number
}

/** Enterprise identity generation の保存形式です。 */
type EnterpriseGenerationKind = 'snapshot' | 'delta'

/** 検証済み generation です。 */
type ValidatedEnterpriseGeneration = {
  /** Generation ID です。 */
  stateGeneration: string
  /** 完全 snapshot または差分を示します。 */
  generationKind: EnterpriseGenerationKind
  /** Generation が表す state revision です。 */
  generationRevision: number
  /** Delta の親 generation ID です。 */
  parentStateGeneration?: string
  /** Delta の親 state revision です。 */
  parentGenerationRevision?: number
  /** Manifest 検証済みの logical records です。 */
  items: Record<string, unknown>[]
}

/** 復元対象として確定した logical records です。 */
type CommittedEnterpriseIdentityRecords = {
  /** CONTROL の state revision です。 */
  storageRevision: number
  /** CONTROL が参照する generation ID です。 */
  storageGeneration: string
  /** CONTROL が固定した active generation chain です。 */
  storageGenerationChain: string[]
  /** CONTROL が保持する TTL 付与中の旧 generations です。 */
  storageRetiredGenerations: EnterpriseRetiredGeneration[]
  /** Snapshot と delta を適用した records です。 */
  items: Record<string, unknown>[]
}

const SCIM_IDEMPOTENCY_RECEIPT_TTL_MS = 24 * 60 * 60_000

/** SCIM resource 本体に membership array を埋め込む record format version です。 */
const ENTERPRISE_SCIM_EMBEDDED_MEMBERSHIP_VERSION = 2

/**
 * State mutation と同じ transaction に保存する audit descriptor です。
 */
type EnterpriseMutationAudit = {
  /** 呼び出し元が構築した audit context です。 */
  context?: MutationAuditContext
  /** Stable event type です。 */
  eventType: string
  /** Stable action です。 */
  action: string
  /** Mutation 対象 entity ID です。 */
  entityId: string
  /** Secret を含まない operation-specific audit metadata です。 */
  metadata?: Readonly<Record<string, unknown>>
}

/**
 * Enterprise state persistence を抽象化する基底 service です。
 */
abstract class EnterpriseIdentityService implements EnterpriseIdentityClient {
  /** Credential digest に使う stable HMAC secret です。 */
  private readonly tokenHashSecret: string
  /** Testable wall clock です。 */
  private readonly clock: () => Date
  /** Workspace 単位で適用する SCIM resource hard cap です。 */
  private readonly scimResourceLimits: EnterpriseScimResourceLimits

  /**
   * Enterprise identity service を作成します。
   */
  protected constructor(
    tokenHashSecret: string,
    clock: () => Date,
    scimResourceLimits: EnterpriseScimResourceLimits =
      ENTERPRISE_SCIM_RESOURCE_LIMITS,
  ) {
    if (tokenHashSecret.length < 32 || tokenHashSecret.length > 256) {
      throw new EnterpriseIdentityError(
        503,
        'EnterpriseIdentitySecretInvalid',
        'Enterprise identity token hash secret must contain between 32 and 256 characters.',
      )
    }
    this.tokenHashSecret = tokenHashSecret
    this.clock = clock
    this.scimResourceLimits = validateEnterpriseScimResourceLimits(
      scimResourceLimits,
    )
  }

  /** 永続 state を読み込みます。 */
  protected abstract loadState(workspaceId: string): Promise<EnterpriseIdentityState>
  /** Optimistic concurrency と audit を含めて state を保存します。 */
  protected abstract saveState(
    state: EnterpriseIdentityState,
    expectedState: EnterpriseIdentityState,
    audit: EnterpriseMutationAudit,
  ): Promise<void>
  /** Domain claim の global uniqueness pointer を読みます。 */
  protected abstract findDomainWorkspace(domain: string): Promise<string | undefined>
  /** Inject された wall clock の現在時刻を返します。 */
  protected currentTime() {
    return this.clock()
  }

  /** Workspace の enterprise identity/security snapshot を返します。 */
  async getSnapshot(workspaceId: string) {
    return toPublicSnapshot(await this.loadState(requireText(workspaceId, 'Workspace ID')))
  }

  /** Provider-scoped SCIM User collection を memory state から page 取得します。 */
  async listScimUsers(input: EnterpriseScimUserListInput) {
    const normalized = validateEnterpriseScimListInput(
      input,
      ['externalId', 'userName', 'displayName'],
    )
    const state = await this.loadState(normalized.workspaceId)
    return createEnterpriseScimPage(
      state.scimUsers,
      normalized,
      (user, field) => user[field] ?? '',
      (user) => user.userId,
    )
  }

  /** Provider-scoped SCIM Group collection を memory state から page 取得します。 */
  async listScimGroups(input: EnterpriseScimGroupListInput) {
    const normalized = validateEnterpriseScimListInput(
      input,
      ['externalId', 'displayName'],
      ENTERPRISE_SCIM_GROUP_PAGE_LIMIT,
    )
    const state = await this.loadState(normalized.workspaceId)
    return createEnterpriseScimPage(
      state.scimGroups,
      normalized,
      (group, field) =>
        field === 'externalId' ? group.externalId : group.displayName,
      (group) => group.groupId,
    )
  }

  /** Email domain に適用される active SSO provider を返します。 */
  async discoverSso(email: string) {
    const domainName = normalizeEmailDomain(email)
    if (!domainName) return undefined
    const workspaceId = await this.findDomainWorkspace(domainName)
    if (!workspaceId) return undefined
    const snapshot = await this.getSnapshot(workspaceId)
    const domain = snapshot.domains.find((candidate) =>
      candidate.domain === domainName &&
      candidate.status === 'verified' &&
      candidate.enforceSso
    )
    if (!domain?.identityProviderId) return undefined
    const provider = snapshot.identityProviders.find((candidate) =>
      candidate.providerId === domain.identityProviderId && candidate.status === 'active'
    )
    return provider ? { domain, provider } : undefined
  }

  /** SAML/OIDC provider を安全に upsert します。 */
  async putIdentityProvider(
    provider: EnterpriseIdentityProvider,
    auditContext?: MutationAuditContext,
  ) {
    validateProvider(provider)
    return this.mutate(provider.workspaceId, {
      context: auditContext,
      eventType: 'identity-provider.updated',
      action: 'updated',
      entityId: provider.providerId,
    }, (state) => {
      const existing = state.identityProviders.find((candidate) =>
        candidate.providerId === provider.providerId
      )
      if (
        existing
          ? provider.revision !== existing.revision + 1
          : provider.revision !== 1
      ) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseIdentityProviderConflict',
          'Identity provider changed. Reload and try again.',
        )
      }
      upsertBy(state.identityProviders, provider, (candidate) =>
        candidate.providerId === provider.providerId
      )
      return provider
    })
  }

  /** Verified domain claim を安全に upsert します。 */
  async putVerifiedDomain(
    domain: EnterpriseVerifiedDomain,
    auditContext?: MutationAuditContext,
  ) {
    const normalized = { ...domain, domain: normalizeDomain(domain.domain) }
    return this.mutate(normalized.workspaceId, {
      context: auditContext,
      eventType: 'identity-domain.updated',
      action: normalized.status === 'verified' ? 'verified' : 'updated',
      entityId: normalized.domainId,
    }, (state) => {
      const existing = state.domains.find((candidate) =>
        candidate.domainId === normalized.domainId
      )
      if (
        existing
          ? normalized.revision !== existing.revision + 1
          : normalized.revision !== 1
      ) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseDomainConflict',
          'Domain claim changed. Reload and try again.',
        )
      }
      if (
        normalized.enforceSso &&
        (
          normalized.status !== 'verified' ||
          !state.identityProviders.some((provider) =>
            provider.providerId === normalized.identityProviderId &&
            provider.status === 'active'
          )
        )
      ) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseSsoPrerequisiteMissing',
          'SSO enforcement requires a verified domain and active identity provider.',
        )
      }
      upsertBy(state.domains, normalized, (candidate) =>
        candidate.domainId === normalized.domainId
      )
      return normalized
    })
  }

  /** 全 verified domain の SSO enforcement を一つの transaction で切り替えます。 */
  async setSsoEnforcement(
    workspaceId: string,
    enforced: boolean,
    identityProviderId: string | undefined,
    expectedProviderRevision: number,
    auditContext?: MutationAuditContext,
  ) {
    return this.mutate(workspaceId, {
      context: auditContext,
      eventType: 'identity-domain.enforcement-updated',
      action: enforced ? 'enforced' : 'unenforced',
      entityId: 'all-verified-domains',
    }, (state) => {
      const verifiedDomains = state.domains.filter((domain) => domain.status === 'verified')
      const provider = identityProviderId
        ? state.identityProviders.find((candidate) =>
            candidate.providerId === identityProviderId
          )
        : state.identityProviders.find((candidate) => candidate.status === 'active')
      if ((provider?.revision ?? 0) !== expectedProviderRevision) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseIdentityProviderConflict',
          'Identity provider changed. Reload before changing SSO enforcement.',
        )
      }
      if (verifiedDomains.length === 0) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseSsoPrerequisiteMissing',
          'SSO enforcement requires at least one verified domain.',
        )
      }
      if (
        enforced &&
        (
          !identityProviderId ||
          provider?.providerId !== identityProviderId ||
          provider.status !== 'active' ||
          !state.breakGlassAccounts.some((account) =>
            isEnterpriseSsoRecoveryAccountReady(state, account, this.clock())
          )
        )
      ) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseSsoPrerequisiteMissing',
          'SSO enforcement requires an active provider and MFA-ready break-glass account.',
        )
      }
      if (verifiedDomains.every((domain) =>
        domain.enforceSso === enforced &&
        domain.identityProviderId === (enforced ? identityProviderId : undefined)
      )) {
        return verifiedDomains
      }
      const updatedAt = this.clock().toISOString()
      for (const domain of verifiedDomains) {
        domain.enforceSso = enforced
        domain.identityProviderId = enforced ? identityProviderId : undefined
        domain.revision += 1
        domain.updatedAt = updatedAt
      }
      return verifiedDomains
    })
  }

  /** Authentication/session policy を安全に upsert します。 */
  async putSecurityPolicy(
    policy: EnterpriseSecurityPolicy,
    auditContext?: MutationAuditContext,
  ) {
    validateSecurityPolicy(policy)
    return this.mutate(policy.workspaceId, {
      context: auditContext,
      eventType: 'security-policy.updated',
      action: 'updated',
      entityId: policy.workspaceId,
    }, (state) => {
      if (
        policy.loginMode !== 'password-or-sso' &&
        !state.domains.some((domain) =>
          domain.status === 'verified' &&
          domain.enforceSso &&
          state.identityProviders.some((provider) =>
            provider.providerId === domain.identityProviderId && provider.status === 'active'
          )
        )
      ) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseSsoPrerequisiteMissing',
          'SSO-only policy requires an enforced verified domain and active provider.',
        )
      }
      state.policy = policy
      return policy
    })
  }

  /** Custom role を安全に upsert します。 */
  async putCustomRole(role: EnterpriseCustomRole, auditContext?: MutationAuditContext) {
    if (!role.roleId.startsWith('custom:') || role.permissions.length === 0) {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseCustomRoleInvalid',
        'Custom role ID and at least one permission are required.',
      )
    }
    return this.mutate(role.workspaceId, {
      context: auditContext,
      eventType: 'custom-role.updated',
      action: 'updated',
      entityId: role.roleId,
    }, (state) => {
      const existing = state.customRoles.find((candidate) => candidate.roleId === role.roleId)
      if (
        existing
          ? role.revision !== existing.revision + 1
          : role.revision !== 1
      ) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseCustomRoleConflict',
          'Custom role changed. Reload and try again.',
        )
      }
      if (state.customRoles.some((candidate) =>
        candidate.roleId !== role.roleId &&
        candidate.name.trim().toLowerCase() === role.name.trim().toLowerCase()
      )) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseCustomRoleNameConflict',
          'Custom role name must be unique in the Workspace.',
        )
      }
      const normalizedRole = {
        ...role,
        permissions: [...new Set(role.permissions)],
      }
      upsertBy(state.customRoles, normalizedRole, (candidate) =>
        candidate.roleId === role.roleId
      )
      return normalizedRole
    })
  }

  /** 未使用 custom role を削除します。 */
  async deleteCustomRole(
    workspaceId: string,
    roleId: string,
    expectedRevision: number,
    auditContext?: MutationAuditContext,
  ) {
    await this.mutate(workspaceId, {
      context: auditContext,
      eventType: 'custom-role.deleted',
      action: 'deleted',
      entityId: roleId,
    }, (state) => {
      const role = state.customRoles.find((candidate) => candidate.roleId === roleId)
      if (!role) {
        throw new EnterpriseIdentityError(
          404,
          'EnterpriseRoleNotFound',
          'Custom role was not found.',
        )
      }
      if (role.revision !== expectedRevision) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseCustomRoleConflict',
          'Custom role changed. Reload and try again.',
        )
      }
      if (
        state.roleAssignments.some((assignment) => assignment.roleId === roleId) ||
        state.groupMappings.some((mapping) => mapping.roleId === roleId) ||
        state.serviceAccounts.some((account) =>
          account.roleId === roleId && account.status === 'active'
        )
      ) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseCustomRoleInUse',
          'Custom role cannot be deleted while it is assigned.',
        )
      }
      state.customRoles = state.customRoles.filter((role) => role.roleId !== roleId)
    })
  }

  /** Directory group mapping を安全に upsert します。 */
  async putGroupMapping(
    mapping: EnterpriseDirectoryGroupMapping,
    auditContext?: MutationAuditContext,
  ) {
    return this.mutate(mapping.workspaceId, {
      context: auditContext,
      eventType: 'directory-group-mapping.updated',
      action: 'updated',
      entityId: mapping.mappingId,
    }, (state) => {
      if (!roleExists(state, mapping.roleId)) {
        throw new EnterpriseIdentityError(
          400,
          'EnterpriseRoleNotFound',
          'Directory mapping references an unknown role.',
        )
      }
      requireReadyIdentityProvider(state, mapping.identityProviderId)
      if (!state.scimGroups.some((group) =>
        group.active &&
        group.identityProviderId === mapping.identityProviderId &&
        (
          group.groupId === mapping.directoryGroupId ||
          group.externalId === mapping.directoryGroupId
        )
      )) {
        throw new EnterpriseIdentityError(
          400,
          'EnterpriseDirectoryGroupProviderMismatch',
          'Directory mapping must reference an active group from the same identity provider.',
        )
      }
      const existing = state.groupMappings.find((candidate) =>
        candidate.mappingId === mapping.mappingId
      )
      if (
        existing
          ? mapping.revision !== existing.revision + 1
          : mapping.revision !== 1
      ) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseGroupMappingConflict',
          'Directory group mapping changed. Reload and try again.',
        )
      }
      upsertBy(state.groupMappings, mapping, (candidate) =>
        candidate.mappingId === mapping.mappingId
      )
      enqueueEnterpriseScimGroupJobsForMappingChanges(
        state,
        [existing, mapping],
        mapping.updatedAt,
      )
      return mapping
    })
  }

  /** Directory group mapping を削除します。 */
  async deleteGroupMapping(
    workspaceId: string,
    mappingId: string,
    expectedRevision: number,
    auditContext?: MutationAuditContext,
  ) {
    await this.mutate(workspaceId, {
      context: auditContext,
      eventType: 'directory-group-mapping.deleted',
      action: 'deleted',
      entityId: mappingId,
    }, (state) => {
      const mapping = state.groupMappings.find((candidate) =>
        candidate.mappingId === mappingId
      )
      if (!mapping) {
        throw new EnterpriseIdentityError(
          404,
          'EnterpriseGroupMappingNotFound',
          'Directory group mapping was not found.',
        )
      }
      if (mapping.revision !== expectedRevision) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseGroupMappingConflict',
          'Directory group mapping changed. Reload and try again.',
        )
      }
      state.groupMappings = state.groupMappings.filter((mapping) =>
        mapping.mappingId !== mappingId
      )
      state.roleAssignments = state.roleAssignments.filter((assignment) =>
        assignment.mappingId !== mappingId
      )
      enqueueEnterpriseScimGroupJobsForMappingChanges(
        state,
        [mapping],
        this.clock().toISOString(),
      )
    })
  }

  /** SCIM bearer credential を一度だけ発行します。 */
  async issueScimToken(
    workspaceId: string,
    identityProviderId: string,
    label: string,
    expiresAt?: string,
    auditContext?: MutationAuditContext,
  ) {
    const normalizedProviderId = requireText(identityProviderId, 'Identity provider ID')
    const token = `msc_${randomBytes(32).toString('base64url')}`
    const createdAt = this.clock().toISOString()
    const credential = {
      workspaceId,
      identityProviderId: normalizedProviderId,
      credentialId: crypto.randomUUID(),
      label: requireText(label, 'SCIM credential label'),
      tokenLastFour: token.slice(-4),
      createdAt,
      ...(expiresAt ? { expiresAt: normalizeTimestamp(expiresAt, 'Credential expiry') } : {}),
    }
    const digest = this.digestToken('scim', workspaceId, credential.credentialId, token)
    await this.mutate(workspaceId, {
      context: auditContext,
      eventType: 'scim-credential.issued',
      action: 'issued',
      entityId: credential.credentialId,
    }, (state) => {
      requireReadyIdentityProvider(state, normalizedProviderId)
      const now = this.clock().getTime()
      const activeCredentials = pruneInactiveScimCredentialDigests(state, now)
      const activeCredentialCount = activeCredentials.filter((candidate) =>
        candidate.identityProviderId === normalizedProviderId
      ).length
      if (
        activeCredentialCount >=
          ENTERPRISE_SCIM_ACTIVE_CREDENTIAL_LIMIT_PER_PROVIDER
      ) {
        throw new EnterpriseIdentityError(
          413,
          'EnterpriseScimCredentialLimitExceeded',
          `An identity provider can retain at most ${
            ENTERPRISE_SCIM_ACTIVE_CREDENTIAL_LIMIT_PER_PROVIDER
          } active SCIM credentials.`,
        )
      }
      if (
        activeCredentials.length >=
          ENTERPRISE_SCIM_ACTIVE_CREDENTIAL_LIMIT_PER_WORKSPACE
      ) {
        throw new EnterpriseIdentityError(
          413,
          'EnterpriseScimWorkspaceCredentialLimitExceeded',
          `A Workspace can retain at most ${
            ENTERPRISE_SCIM_ACTIVE_CREDENTIAL_LIMIT_PER_WORKSPACE
          } active SCIM credentials.`,
        )
      }
      state.scimCredentials.push(credential)
      state.scimCredentialDigests.push({ credentialId: credential.credentialId, digest })
    })
    return { token, credential }
  }

  /** 全 active SCIM credential を revoke し、新 credential を原子的に発行します。 */
  async rotateScimToken(
    workspaceId: string,
    identityProviderId: string,
    label: string,
    expectedGeneration: number,
    idempotencyKey: string,
    requestFingerprint: string,
    auditContext?: MutationAuditContext,
  ) {
    const normalizedProviderId = requireText(identityProviderId, 'Identity provider ID')
    const receiptKey = `scim-credential-rotate:${normalizedProviderId}:${
      requireText(idempotencyKey, 'Idempotency key')
    }`
    const normalizedFingerprint = fingerprintScimRequest({
      identityProviderId: normalizedProviderId,
      requestFingerprint: requireText(requestFingerprint, 'Request fingerprint'),
    })
    const token = this.deriveOneTimeToken(
      'scim',
      workspaceId,
      normalizedProviderId,
      expectedGeneration + 1,
      receiptKey,
    )
    const credentialId = stableId(
      'scim-credential',
      workspaceId,
      normalizedProviderId,
      receiptKey,
    )
    const digest = this.digestToken('scim', workspaceId, credentialId, token)
    const credential = await this.mutate(workspaceId, {
      context: auditContext,
      eventType: 'scim-credential.rotated',
      action: 'rotated',
      entityId: credentialId,
    }, (state) => {
      requireReadyIdentityProvider(state, normalizedProviderId)
      const receiptCredentialId = state.idempotencyResults[receiptKey]
      if (receiptCredentialId) {
        assertIdempotencyReceipt(
          state,
          receiptKey,
          normalizedFingerprint,
          this.clock(),
          'SCIM credential rotation',
        )
        const existing = state.scimCredentials.find((candidate) =>
          candidate.credentialId === receiptCredentialId
        )
        if (!existing) {
          throw new EnterpriseIdentityError(
            503,
            'EnterpriseIdentityStateInvalid',
            'SCIM credential idempotency receipt is incomplete.',
          )
        }
        if (existing.identityProviderId !== normalizedProviderId) {
          throw new EnterpriseIdentityError(
            503,
            'EnterpriseIdentityStateInvalid',
            'SCIM credential provider binding is invalid.',
          )
        }
        return existing
      }
      const providerCredentials = state.scimCredentials.filter((candidate) =>
        candidate.identityProviderId === normalizedProviderId
      )
      if (providerCredentials.length !== expectedGeneration) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseScimCredentialConflict',
          'SCIM credential generation changed. Reload and try again.',
        )
      }
      const activeCredentials = pruneInactiveScimCredentialDigests(
        state,
        this.clock().getTime(),
      )
      const activeProviderCredentialCount = activeCredentials.filter((candidate) =>
        candidate.identityProviderId === normalizedProviderId
      ).length
      if (
        activeCredentials.length - activeProviderCredentialCount + 1 >
          ENTERPRISE_SCIM_ACTIVE_CREDENTIAL_LIMIT_PER_WORKSPACE
      ) {
        throw new EnterpriseIdentityError(
          413,
          'EnterpriseScimWorkspaceCredentialLimitExceeded',
          `A Workspace can retain at most ${
            ENTERPRISE_SCIM_ACTIVE_CREDENTIAL_LIMIT_PER_WORKSPACE
          } active SCIM credentials.`,
        )
      }
      const createdAt = this.clock().toISOString()
      const nextCredential = {
        workspaceId,
        identityProviderId: normalizedProviderId,
        credentialId,
        label: requireText(label, 'SCIM credential label'),
        tokenLastFour: token.slice(-4),
        createdAt,
      }
      for (const existing of providerCredentials) {
        if (!existing.revokedAt) existing.revokedAt = createdAt
      }
      state.scimCredentials.push(nextCredential)
      const providerCredentialIds = new Set(
        providerCredentials.map((candidate) => candidate.credentialId),
      )
      state.scimCredentialDigests = state.scimCredentialDigests
        .filter((candidate) => !providerCredentialIds.has(candidate.credentialId))
      state.scimCredentialDigests.push({ credentialId, digest })
      state.idempotencyResults[receiptKey] = credentialId
      state.idempotencyFingerprints[receiptKey] = normalizedFingerprint
      state.idempotencyExpiresAt[receiptKey] =
        new Date(this.clock().getTime() + 10 * 60_000).toISOString()
      return nextCredential
    })
    return { token, credential }
  }

  /** SCIM bearer credential を HMAC digest で認証します。 */
  async authenticateScimToken(workspaceId: string, token: string) {
    return (await this.authenticateScimWorkspace(workspaceId, token))?.credential
  }

  /** SCIM credential と current provider を一度の state read で認証します。 */
  async authenticateScimWorkspace(workspaceId: string, token: string) {
    const state = await this.loadState(workspaceId)
    const match = state.scimCredentialDigests.find((candidate) =>
      isMatchingCredentialDigest(
        candidate.digest,
        this.digestToken('scim', workspaceId, candidate.credentialId, token),
      )
    )
    if (!match) return undefined
    const credential = state.scimCredentials.find((candidate) =>
      candidate.credentialId === match.credentialId
    )
    if (!credential) return undefined
    if (
      credential.revokedAt ||
      credential.expiresAt && Date.parse(credential.expiresAt) <= this.clock().getTime()
    ) return undefined
    const provider = state.identityProviders.find((candidate) =>
      candidate.providerId === credential.identityProviderId
    )
    try {
      assertEnterpriseIdentityProviderReady(provider)
    } catch {
      return undefined
    }
    return { credential, provider }
  }

  /** SCIM bearer credential を revoke します。 */
  async revokeScimToken(
    workspaceId: string,
    credentialId: string,
    auditContext?: MutationAuditContext,
  ) {
    await this.mutate(workspaceId, {
      context: auditContext,
      eventType: 'scim-credential.revoked',
      action: 'revoked',
      entityId: credentialId,
    }, (state) => {
      const credential = state.scimCredentials.find((candidate) =>
        candidate.credentialId === credentialId
      )
      if (credential && !credential.revokedAt) credential.revokedAt = this.clock().toISOString()
      state.scimCredentialDigests = state.scimCredentialDigests.filter((candidate) =>
        candidate.credentialId !== credentialId
      )
    })
  }

  /** SCIM user desired state を idempotent に upsert します。 */
  async upsertScimUser(
    input: EnterpriseScimUserInput,
    auditContext?: MutationAuditContext,
  ) {
    validateEnterpriseScimUserInputLimits(input)
    const identityProviderId = requireText(
      input.identityProviderId,
      'Identity provider ID',
    )
    const externalId = requireText(input.externalId, 'SCIM user external ID')
    const auditEntityId = input.userId ??
      stableId('scim-user', input.workspaceId, identityProviderId, externalId)
    return this.mutate(input.workspaceId, {
      context: auditContext,
      eventType: 'scim-user.reconciled',
      action: input.active ? 'upserted' : 'deactivated',
      entityId: auditEntityId,
    }, (state) => {
      requireReadyIdentityProvider(state, identityProviderId)
      const receiptKey = `scim-user:${identityProviderId}:${input.idempotencyKey}`
      const fingerprint = fingerprintScimRequest({
        workspaceId: input.workspaceId,
        userId: input.userId ?? '',
        externalId,
        identityProviderId,
        userName: input.userName,
        displayName: input.displayName ?? '',
        emails: normalizeEmails(input.emails).sort(),
        active: input.active,
        linkedMemberKey: input.linkedMemberKey ?? '',
        groupIds: [...new Set(input.groupIds ?? [])].sort(),
      })
      const idempotencyId = getActiveIdempotencyResult(
        state,
        receiptKey,
        this.clock(),
      )
      const existing = state.scimUsers.find((user) =>
        user.userId === (idempotencyId ?? input.userId) ||
        input.userId === undefined &&
          user.identityProviderId === identityProviderId &&
          user.externalId === externalId
      )
      if (existing && existing.identityProviderId !== identityProviderId) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseScimProviderMismatch',
          'SCIM resources cannot be moved between identity providers.',
        )
      }
      if (idempotencyId) {
        if (state.idempotencyFingerprints[receiptKey] !== fingerprint) {
          throw new EnterpriseIdentityError(
            409,
            'EnterpriseScimIdempotencyConflict',
            'SCIM idempotency key was already used with a different user payload.',
          )
        }
        if (!existing) {
          throw new EnterpriseIdentityError(
            503,
            'EnterpriseIdentityStateInvalid',
            'SCIM user idempotency receipt is incomplete.',
          )
        }
        return existing
      }
      if (
        !existing &&
        state.scimUsers.length >= this.scimResourceLimits.maximumUsers
      ) {
        throw new EnterpriseIdentityError(
          413,
          'EnterpriseScimUserLimitExceeded',
          `A Workspace can retain at most ${
            this.scimResourceLimits.maximumUsers
          } SCIM users.`,
        )
      }
      const normalizedUserName = requireText(input.userName, 'SCIM userName').toLowerCase()
      if (state.scimUsers.some((user) =>
        user.userId !== existing?.userId &&
        user.identityProviderId === identityProviderId &&
        (
          user.externalId === externalId ||
          user.userName.toLowerCase() === normalizedUserName
        )
      )) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseScimUserConflict',
          'SCIM externalId and userName must be unique for an identity provider.',
        )
      }
      const groupIds = [...new Set(input.groupIds ?? existing?.groupIds ?? [])]
      if (groupIds.some((groupId) =>
        !state.scimGroups.some((group) =>
          group.groupId === groupId &&
          group.identityProviderId === identityProviderId
        )
      )) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseScimProviderMismatch',
          'SCIM user groups must belong to the same identity provider.',
        )
      }
      const now = this.clock().toISOString()
      const user = {
        workspaceId: input.workspaceId,
        userId: existing?.userId ??
          input.userId ??
          stableId('scim-user', input.workspaceId, identityProviderId, externalId),
        externalId,
        identityProviderId,
        userName: requireText(input.userName, 'SCIM userName'),
        displayName: input.displayName?.trim() || undefined,
        emails: normalizeEmails(input.emails),
        active: input.active,
        linkedMemberKey: input.linkedMemberKey,
        groupIds,
        version: (existing?.version ?? 0) + 1,
        appliedVersion: existing?.appliedVersion ?? 0,
        appliedAt: existing?.appliedAt,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      } satisfies EnterpriseScimUser
      upsertBy(state.scimUsers, user, (candidate) => candidate.userId === user.userId)
      state.idempotencyResults[receiptKey] = user.userId
      state.idempotencyFingerprints[receiptKey] = fingerprint
      state.idempotencyExpiresAt[receiptKey] =
        new Date(this.clock().getTime() + SCIM_IDEMPOTENCY_RECEIPT_TTL_MS).toISOString()
      return user
    })
  }

  /** SCIM user desired state を idempotent に deactivate します。 */
  async deactivateScimUser(
    workspaceId: string,
    identityProviderId: string,
    userId: string,
    idempotencyKey: string,
    auditContext?: MutationAuditContext,
  ) {
    validateEnterpriseScimTextByteLength(
      userId,
      'SCIM user ID',
      ENTERPRISE_SCIM_RESOURCE_ID_MAX_BYTES,
    )
    validateEnterpriseScimTextByteLength(
      idempotencyKey,
      'SCIM Idempotency-Key',
      ENTERPRISE_SCIM_IDEMPOTENCY_KEY_MAX_BYTES,
    )
    return this.mutate(workspaceId, {
      context: auditContext,
      eventType: 'scim-user.deactivated',
      action: 'deactivated',
      entityId: userId,
    }, (state) => {
      const normalizedProviderId = requireText(identityProviderId, 'Identity provider ID')
      requireReadyIdentityProvider(state, normalizedProviderId)
      const key = `scim-user-deactivate:${normalizedProviderId}:${idempotencyKey}`
      const fingerprint = fingerprintScimRequest({
        workspaceId,
        identityProviderId: normalizedProviderId,
        userId,
        active: false,
      })
      const receiptId = getActiveIdempotencyResult(state, key, this.clock())
      if (receiptId && state.idempotencyFingerprints[key] !== fingerprint) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseScimIdempotencyConflict',
          'SCIM idempotency key was already used for a different user deactivation.',
        )
      }
      const existing = state.scimUsers.find((user) =>
        user.userId === (receiptId ?? userId) &&
        user.identityProviderId === normalizedProviderId
      )
      if (!existing || receiptId) return existing
      if (existing.active) {
        existing.active = false
        existing.version += 1
        existing.updatedAt = this.clock().toISOString()
      }
      state.idempotencyResults[key] = existing.userId
      state.idempotencyFingerprints[key] = fingerprint
      state.idempotencyExpiresAt[key] =
        new Date(this.clock().getTime() + SCIM_IDEMPOTENCY_RECEIPT_TTL_MS).toISOString()
      return existing
    })
  }

  /** SCIM user desired version の Workspace 適用成功を checkpoint します。 */
  async markScimUserApplied(
    workspaceId: string,
    userId: string,
    desiredVersion: number,
    auditContext?: MutationAuditContext,
  ) {
    return this.mutate(workspaceId, {
      context: auditContext,
      eventType: 'scim-user.applied',
      action: 'applied',
      entityId: userId,
    }, (state) => {
      const user = state.scimUsers.find((candidate) => candidate.userId === userId)
      if (!user) {
        throw new EnterpriseIdentityError(
          404,
          'EnterpriseScimUserNotFound',
          'SCIM user was not found.',
        )
      }
      if (user.version !== desiredVersion) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseProvisioningPlanStale',
          'SCIM user changed after the provisioning plan was created.',
        )
      }
      if (user.appliedVersion < desiredVersion) {
        user.appliedVersion = desiredVersion
        user.appliedAt = this.clock().toISOString()
      }
      return user
    })
  }

  /** SCIM group desired state を idempotent に upsert します。 */
  async upsertScimGroup(
    input: EnterpriseScimGroupInput,
    auditContext?: MutationAuditContext,
  ) {
    validateEnterpriseScimGroupInputLimits(input)
    const identityProviderId = requireText(
      input.identityProviderId,
      'Identity provider ID',
    )
    const externalId = requireText(input.externalId, 'SCIM group external ID')
    const auditEntityId = input.groupId ??
      stableId('scim-group', input.workspaceId, identityProviderId, externalId)
    return this.mutate(input.workspaceId, {
      context: auditContext,
      eventType: 'scim-group.reconciled',
      action: input.active ? 'upserted' : 'deactivated',
      entityId: auditEntityId,
    }, (state) => {
      requireReadyIdentityProvider(state, identityProviderId)
      const receiptKey = `scim-group:${identityProviderId}:${input.idempotencyKey}`
      const fingerprint = fingerprintScimRequest({
        workspaceId: input.workspaceId,
        groupId: input.groupId ?? '',
        externalId,
        identityProviderId,
        displayName: input.displayName,
        active: input.active,
        memberUserIds: [...new Set(input.memberUserIds ?? [])].sort(),
      })
      const idempotencyId = getActiveIdempotencyResult(
        state,
        receiptKey,
        this.clock(),
      )
      const existing = state.scimGroups.find((group) =>
        group.groupId === (idempotencyId ?? input.groupId) ||
        input.groupId === undefined &&
          group.identityProviderId === identityProviderId &&
          group.externalId === externalId
      )
      if (existing && existing.identityProviderId !== identityProviderId) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseScimProviderMismatch',
          'SCIM resources cannot be moved between identity providers.',
        )
      }
      if (idempotencyId) {
        if (state.idempotencyFingerprints[receiptKey] !== fingerprint) {
          throw new EnterpriseIdentityError(
            409,
            'EnterpriseScimIdempotencyConflict',
            'SCIM idempotency key was already used with a different group payload.',
          )
        }
        if (!existing) {
          throw new EnterpriseIdentityError(
            503,
            'EnterpriseIdentityStateInvalid',
            'SCIM group idempotency receipt is incomplete.',
          )
        }
        return existing
      }
      if (
        !existing &&
        state.scimGroups.length >= this.scimResourceLimits.maximumGroups
      ) {
        throw new EnterpriseIdentityError(
          413,
          'EnterpriseScimGroupLimitExceeded',
          `A Workspace can retain at most ${
            this.scimResourceLimits.maximumGroups
          } SCIM groups.`,
        )
      }
      if (state.scimGroups.some((group) =>
        group.groupId !== existing?.groupId &&
        group.identityProviderId === identityProviderId &&
        group.externalId === externalId
      )) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseScimGroupConflict',
          'SCIM externalId must be unique for an identity provider.',
        )
      }
      const memberUserIds = [...new Set(
        input.memberUserIds ?? existing?.memberUserIds ?? [],
      )]
      if (memberUserIds.some((userId) =>
        !state.scimUsers.some((user) =>
          user.userId === userId &&
          user.identityProviderId === identityProviderId
        )
      )) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseScimProviderMismatch',
          'SCIM group members must belong to the same identity provider.',
        )
      }
      const now = this.clock().toISOString()
      const group = {
        workspaceId: input.workspaceId,
        groupId: existing?.groupId ??
          input.groupId ??
          stableId('scim-group', input.workspaceId, identityProviderId, externalId),
        externalId,
        identityProviderId,
        displayName: requireText(input.displayName, 'SCIM group display name'),
        active: input.active,
        memberUserIds,
        version: (existing?.version ?? 0) + 1,
        appliedVersion: existing?.appliedVersion ?? 0,
        appliedAt: existing?.appliedAt,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      } satisfies EnterpriseScimGroup
      upsertBy(state.scimGroups, group, (candidate) => candidate.groupId === group.groupId)
      enqueueEnterpriseScimGroupJob(
        state,
        group,
        existing?.memberUserIds ?? [],
        this.clock().toISOString(),
      )
      state.idempotencyResults[receiptKey] = group.groupId
      state.idempotencyFingerprints[receiptKey] = fingerprint
      state.idempotencyExpiresAt[receiptKey] =
        new Date(this.clock().getTime() + SCIM_IDEMPOTENCY_RECEIPT_TTL_MS).toISOString()
      return group
    })
  }

  /** SCIM group desired state を idempotent に deactivate します。 */
  async deactivateScimGroup(
    workspaceId: string,
    identityProviderId: string,
    groupId: string,
    idempotencyKey: string,
    auditContext?: MutationAuditContext,
  ) {
    validateEnterpriseScimTextByteLength(
      groupId,
      'SCIM group ID',
      ENTERPRISE_SCIM_RESOURCE_ID_MAX_BYTES,
    )
    validateEnterpriseScimTextByteLength(
      idempotencyKey,
      'SCIM Idempotency-Key',
      ENTERPRISE_SCIM_IDEMPOTENCY_KEY_MAX_BYTES,
    )
    return this.mutate(workspaceId, {
      context: auditContext,
      eventType: 'scim-group.deactivated',
      action: 'deactivated',
      entityId: groupId,
    }, (state) => {
      const normalizedProviderId = requireText(identityProviderId, 'Identity provider ID')
      requireReadyIdentityProvider(state, normalizedProviderId)
      const key = `scim-group-deactivate:${normalizedProviderId}:${idempotencyKey}`
      const fingerprint = fingerprintScimRequest({
        workspaceId,
        identityProviderId: normalizedProviderId,
        groupId,
        active: false,
      })
      const receiptId = getActiveIdempotencyResult(state, key, this.clock())
      if (receiptId && state.idempotencyFingerprints[key] !== fingerprint) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseScimIdempotencyConflict',
          'SCIM idempotency key was already used for a different group deactivation.',
        )
      }
      const existing = state.scimGroups.find((group) =>
        group.groupId === (receiptId ?? groupId) &&
        group.identityProviderId === normalizedProviderId
      )
      if (!existing || receiptId) return existing
      existing.active = false
      existing.version += 1
      existing.updatedAt = this.clock().toISOString()
      enqueueEnterpriseScimGroupJob(
        state,
        existing,
        existing.memberUserIds,
        existing.updatedAt,
      )
      state.idempotencyResults[key] = existing.groupId
      state.idempotencyFingerprints[key] = fingerprint
      state.idempotencyExpiresAt[key] =
        new Date(this.clock().getTime() + SCIM_IDEMPOTENCY_RECEIPT_TTL_MS).toISOString()
      return existing
    })
  }

  /** SCIM group desired version の Workspace 適用成功を checkpoint します。 */
  async markScimGroupApplied(
    workspaceId: string,
    groupId: string,
    desiredVersion: number,
    auditContext?: MutationAuditContext,
  ) {
    return this.mutate(workspaceId, {
      context: auditContext,
      eventType: 'scim-group.applied',
      action: 'applied',
      entityId: groupId,
    }, (state) => {
      const group = state.scimGroups.find((candidate) => candidate.groupId === groupId)
      if (!group) {
        throw new EnterpriseIdentityError(
          404,
          'EnterpriseScimGroupNotFound',
          'SCIM group was not found.',
        )
      }
      if (group.version !== desiredVersion) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseProvisioningPlanStale',
          'SCIM group changed after the provisioning plan was created.',
        )
      }
      if (group.appliedVersion < desiredVersion) {
        group.appliedVersion = desiredVersion
        group.appliedAt = this.clock().toISOString()
      }
      return group
    })
  }

  /** Current pending SCIM group job の stream reference を返します。 */
  async getScimGroupJobReference(
    workspaceId: string,
    groupId: string,
  ) {
    const normalizedWorkspaceId = requireText(workspaceId, 'Workspace ID')
    const normalizedGroupId = requireText(groupId, 'SCIM group ID')
    const state = await this.loadState(normalizedWorkspaceId)
    const job = state.scimGroupJobs.find((candidate) =>
      candidate.groupId === normalizedGroupId
    )
    return job ? toEnterpriseScimGroupJobReference(job) : undefined
  }

  /**
   * Durable SCIM group job の一 page を state 一回読み・逐次 side effect・一回 CAS で処理します。
   */
  async processScimGroupJob(
    reference: EnterpriseScimGroupJobReference,
    applyUser: EnterpriseScimGroupJobApplyUser,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseScimGroupJobProcessResult> {
    const normalizedReference = validateEnterpriseScimGroupJobReference(reference)
    const current = await this.loadState(normalizedReference.workspaceId)
    const currentJob = current.scimGroupJobs.find((candidate) =>
      candidate.jobId === normalizedReference.jobId
    )
    if (!currentJob || currentJob.revision !== normalizedReference.revision) {
      return { status: 'stale' }
    }
    const currentGroup = current.scimGroups.find((candidate) =>
      candidate.groupId === currentJob.groupId
    )
    if (
      !currentGroup ||
      currentGroup.version !== currentJob.groupVersion ||
      currentJob.cursor > currentJob.targetUserIds.length
    ) {
      throw invalidEnterpriseIdentityState()
    }

    const pageUserIds = currentJob.targetUserIds.slice(
      currentJob.cursor,
      currentJob.cursor + ENTERPRISE_SCIM_GROUP_JOB_PAGE_SIZE,
    )
    const snapshot = toPublicSnapshot(current)
    const snapshotGroup = snapshot.scimGroups.find((candidate) =>
      candidate.groupId === currentGroup.groupId
    )
    if (!snapshotGroup) throw invalidEnterpriseIdentityState()
    for (const userId of pageUserIds) {
      const user = snapshot.scimUsers.find((candidate) =>
        candidate.userId === userId &&
        candidate.identityProviderId === snapshotGroup.identityProviderId
      )
      if (!user) throw invalidEnterpriseIdentityState()
      await applyUser({
        snapshot,
        snapshotRevision: current.storageRevision,
        group: snapshotGroup,
        user,
        phase: currentJob.phase,
        reference: normalizedReference,
        jobUpdatedAt: currentJob.updatedAt,
      })
    }

    const next = structuredClone(current)
    const nextJob = next.scimGroupJobs.find((candidate) =>
      candidate.jobId === currentJob.jobId &&
      candidate.revision === currentJob.revision
    )
    const nextGroup = next.scimGroups.find((candidate) =>
      candidate.groupId === currentJob.groupId &&
      candidate.version === currentJob.groupVersion
    )
    if (!nextJob || !nextGroup) throw invalidEnterpriseIdentityState()
    const appliedAt = this.clock().toISOString()
    for (const userId of pageUserIds) {
      const user = next.scimUsers.find((candidate) => candidate.userId === userId)
      if (!user) throw invalidEnterpriseIdentityState()
      if (user.appliedVersion < user.version) {
        user.appliedVersion = user.version
        user.appliedAt = appliedAt
      }
    }
    next.storageRevision = current.storageRevision + 1
    nextJob.cursor += pageUserIds.length
    const phaseCompleted = nextJob.cursor >= nextJob.targetUserIds.length
    const completed = phaseCompleted && nextJob.phase === 'settle'
    let nextReference: EnterpriseScimGroupJobReference | undefined
    if (phaseCompleted && nextJob.phase === 'apply') {
      if (nextGroup.appliedVersion < nextGroup.version) {
        nextGroup.appliedVersion = nextGroup.version
        nextGroup.appliedAt = appliedAt
      }
      nextJob.phase = 'settle'
      nextJob.cursor = 0
      nextJob.revision = next.storageRevision
      nextJob.updatedAt = appliedAt
      nextReference = toEnterpriseScimGroupJobReference(nextJob)
    } else if (completed) {
      next.scimGroupJobs = next.scimGroupJobs.filter((candidate) =>
        candidate.jobId !== nextJob.jobId
      )
    } else {
      nextJob.revision = next.storageRevision
      nextJob.updatedAt = appliedAt
      nextReference = toEnterpriseScimGroupJobReference(nextJob)
    }
    await this.saveState(next, current, {
      context: auditContext,
      eventType: completed
        ? 'scim-group.reconciliation-completed'
        : 'scim-group.reconciliation-progressed',
      action: completed ? 'applied' : 'progressed',
      entityId: nextGroup.groupId,
      metadata: {
        jobId: currentJob.jobId,
        jobRevision: currentJob.revision,
        jobPhase: currentJob.phase,
        processedUserCount: pageUserIds.length,
      },
    })
    if (completed) {
      return {
        status: 'completed',
        processedUserIds: pageUserIds,
      }
    }
    if (!nextReference) throw invalidEnterpriseIdentityState()
    return {
      status: 'continued',
      nextReference,
      processedUserIds: pageUserIds,
    }
  }

  /** Reconciliation の mutation-free impact preview を返します。 */
  async previewProvisioning(
    input: EnterpriseProvisioningInput,
    auditContext?: MutationAuditContext,
  ) {
    const state = await this.loadState(input.workspaceId)
    const selectedUsers = state.scimUsers.filter((user) =>
      !input.userIds || input.userIds.includes(user.userId)
    )
    const selectedGroups = state.scimGroups.filter((group) =>
      !input.groupIds || input.groupIds.includes(group.groupId)
    )
    const pendingGroupVersionsByUser = new Map<string, string[]>()
    for (const group of selectedGroups) {
      if (group.appliedVersion >= group.version) continue
      const pendingJob = state.scimGroupJobs.find((job) =>
        job.groupId === group.groupId &&
        job.groupVersion === group.version
      )
      const targetUserIds = new Set(
        pendingJob?.targetUserIds ?? group.memberUserIds,
      )
      for (const user of selectedUsers) {
        if (
          group.identityProviderId !== user.identityProviderId ||
          !targetUserIds.has(user.userId)
        ) {
          continue
        }
        const versions = pendingGroupVersionsByUser.get(user.userId) ?? []
        versions.push(`${group.groupId}:${group.version}`)
        pendingGroupVersionsByUser.set(user.userId, versions)
      }
    }
    const changes = [
      ...selectedUsers.map((user) => {
        const pendingGroupVersions = (
          pendingGroupVersionsByUser.get(user.userId) ?? []
        ).sort()
        const requiresApply =
          user.appliedVersion < user.version ||
          pendingGroupVersions.length > 0
        return {
          changeId: stableId(
            'change',
            'user',
            user.userId,
            String(user.version),
            ...pendingGroupVersions,
          ),
          entityType: 'user' as const,
          entityId: user.userId,
          desiredVersion: user.version,
          action: !requiresApply
            ? 'noop' as const
            : user.active
              ? user.appliedVersion === 0 ? 'create' as const : 'update' as const
              : user.linkedMemberKey ? 'deactivate' as const : 'noop' as const,
          summary: user.active
            ? `Reconcile directory user ${user.userName}.`
            : `Deactivate directory user ${user.userName}.`,
          blocking: !user.active &&
            user.appliedVersion < user.version &&
            user.linkedMemberKey !== undefined &&
            (input.protectedMemberKeys ?? []).includes(user.linkedMemberKey),
        }
      }),
      ...selectedUsers
        .filter((user) =>
          !user.active &&
          user.appliedVersion < user.version &&
          user.linkedMemberKey !== undefined
        )
        .map((user) => ({
          changeId: stableId('change', 'session', user.userId, String(user.version)),
          entityType: 'session' as const,
          entityId: user.userId,
          desiredVersion: user.version,
          action: 'revoke' as const,
          summary: `Revoke active sessions for directory user ${user.userName}.`,
          blocking: false,
        })),
      ...selectedGroups.map((group) => ({
        changeId: stableId('change', 'group', group.groupId, String(group.version)),
        entityType: 'group' as const,
        entityId: group.groupId,
        desiredVersion: group.version,
        action: group.appliedVersion >= group.version
          ? 'noop' as const
          : group.active
            ? group.appliedVersion === 0 ? 'create' as const : 'update' as const
            : 'delete' as const,
        summary: group.active
          ? `Reconcile directory group ${group.displayName}.`
          : `Remove directory group ${group.displayName}.`,
        blocking: false,
      })),
    ]
    const createdAt = this.clock().toISOString()
    const preview = {
      workspaceId: input.workspaceId,
      previewId: crypto.randomUUID(),
      fingerprint: fingerprintProvisioning(input.workspaceId, input.source, changes),
      source: input.source,
      changes,
      createdAt,
      expiresAt: new Date(this.clock().getTime() + 10 * 60_000).toISOString(),
    } satisfies EnterpriseProvisioningPreview
    await this.mutate(input.workspaceId, {
      context: auditContext,
      eventType: 'provisioning.previewed',
      action: 'previewed',
      entityId: preview.previewId,
    }, (next) => {
      next.provisioningPreviews = next.provisioningPreviews
        .filter((candidate) => Date.parse(candidate.expiresAt) > this.clock().getTime())
      next.provisioningPreviews.push(preview)
    })
    return preview
  }

  /** ID で未失効 provisioning preview を返します。 */
  async getProvisioningPreview(workspaceId: string, previewId: string) {
    const state = await this.loadState(workspaceId)
    return state.provisioningPreviews.find((preview) =>
      preview.previewId === previewId &&
      Date.parse(preview.expiresAt) > this.clock().getTime()
    )
  }

  /** 確認済み preview を idempotent に apply します。 */
  async reconcileProvisioning(
    input: EnterpriseProvisioningInput,
    auditContext?: MutationAuditContext,
  ) {
    return this.mutate(input.workspaceId, {
      context: auditContext,
      eventType: 'provisioning.reconciled',
      action: 'reconciled',
      entityId: input.idempotencyKey,
    }, (state) => {
      const existingRunId = state.idempotencyResults[
        `provisioning-run:${input.idempotencyKey}`
      ]
      const existing = state.provisioningRuns.find((run) => run.runId === existingRunId)
      const conflictingRun = state.provisioningRuns.find((run) =>
        run.status === 'running' && run.runId !== existing?.runId
      )
      if (conflictingRun) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseProvisioningRunInProgress',
          'Another provisioning operation is already in progress for this Workspace.',
          true,
        )
      }
      if (existing?.status === 'running') {
        const leaseExpiresAt = Date.parse(existing.leaseExpiresAt ?? '')
        if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= this.clock().getTime()) {
          const takeoverAt = this.clock().toISOString()
          existing.attempt += 1
          existing.updatedAt = takeoverAt
          existing.leaseExpiresAt = new Date(
            this.clock().getTime() + 5 * 60_000,
          ).toISOString()
          state.provisioningLogs.push({
            workspaceId: input.workspaceId,
            logId: crypto.randomUUID(),
            runId: existing.runId,
            attempt: existing.attempt,
            level: 'warning',
            code: 'ProvisioningLeaseRecovered',
            message: 'An expired provisioning worker lease was recovered.',
            createdAt: takeoverAt,
            retryable: true,
          })
          return existing
        }
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseProvisioningRunInProgress',
          'This provisioning operation is already in progress.',
          true,
        )
      }
      if (existing) return existing
      const preview = state.provisioningPreviews.find((candidate) =>
        candidate.fingerprint === input.previewFingerprint &&
        candidate.source === input.source
      )
      if (!preview || Date.parse(preview.expiresAt) <= this.clock().getTime()) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseProvisioningPreviewExpired',
          'Provisioning preview is missing or expired. Run a new dry-run.',
        )
      }
      if (preview.changes.some((change) => change.blocking)) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseProvisioningImpactBlocked',
          'Provisioning preview contains a blocking impact.',
        )
      }
      const now = this.clock().toISOString()
      const run = {
        workspaceId: input.workspaceId,
        runId: crypto.randomUUID(),
        source: input.source,
        idempotencyKey: input.idempotencyKey,
        previewFingerprint: preview.fingerprint,
        status: 'running',
        attempt: 1,
        changes: preview.changes,
        createdAt: now,
        updatedAt: now,
        leaseExpiresAt: new Date(this.clock().getTime() + 5 * 60_000).toISOString(),
      } satisfies EnterpriseProvisioningRun
      state.provisioningRuns.push(run)
      state.provisioningLogs.push({
        workspaceId: input.workspaceId,
        logId: crypto.randomUUID(),
        runId: run.runId,
        attempt: run.attempt,
        level: 'info',
        code: 'ProvisioningRunReserved',
        message: `${run.changes.length} provisioning change(s) reserved for reconciliation.`,
        createdAt: now,
        retryable: true,
      })
      state.idempotencyResults[`provisioning-run:${input.idempotencyKey}`] = run.runId
      state.provisioningPreviews = state.provisioningPreviews.filter((candidate) =>
        candidate.previewId !== preview.previewId
      )
      return run
    })
  }

  /** Reserved provisioning run を side effect の結果で確定します。 */
  async finalizeProvisioningRun(
    workspaceId: string,
    runId: string,
    outcome: 'succeeded' | 'failed',
    failureCode?: string,
    auditContext?: MutationAuditContext,
  ) {
    return this.mutate(workspaceId, {
      context: auditContext,
      eventType: outcome === 'succeeded'
        ? 'provisioning.succeeded'
        : 'provisioning.failed',
      action: outcome,
      entityId: runId,
    }, (state) => {
      const run = state.provisioningRuns.find((candidate) => candidate.runId === runId)
      if (!run) {
        throw new EnterpriseIdentityError(
          404,
          'EnterpriseProvisioningRunNotFound',
          'Provisioning run was not found.',
        )
      }
      if (run.status === outcome) return run
      if (run.status !== 'running') {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseProvisioningRunConflict',
          'Provisioning run is not awaiting finalization.',
        )
      }
      if (
        outcome === 'succeeded' &&
        run.changes.some((change) =>
          change.action !== 'noop' &&
          !hasAppliedProvisioningCheckpoint(state, change)
        )
      ) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseProvisioningCheckpointIncomplete',
          'Provisioning cannot succeed until every reviewed desired version is applied.',
          true,
        )
      }
      const now = this.clock().toISOString()
      run.status = outcome
      run.updatedAt = now
      run.completedAt = now
      run.leaseExpiresAt = undefined
      run.failureCode = outcome === 'failed'
        ? requireText(failureCode ?? 'ProvisioningApplyFailed', 'Failure code')
        : undefined
      state.provisioningLogs.push({
        workspaceId,
        logId: crypto.randomUUID(),
        runId,
        attempt: run.attempt,
        level: outcome === 'succeeded' ? 'info' : 'error',
        code: outcome === 'succeeded'
          ? 'ProvisioningReconciled'
          : run.failureCode ?? 'ProvisioningApplyFailed',
        message: outcome === 'succeeded'
          ? `${run.changes.length} provisioning change(s) reconciled.`
          : 'Provisioning apply failed; retry is available.',
        createdAt: now,
        retryable: outcome === 'failed',
      })
      return run
    })
  }

  /** Failed provisioning run を同じ plan で retry します。 */
  async retryProvisioning(
    workspaceId: string,
    runId: string,
    auditContext?: MutationAuditContext,
  ) {
    return this.mutate(workspaceId, {
      context: auditContext,
      eventType: 'provisioning.retried',
      action: 'retried',
      entityId: runId,
    }, (state) => {
      const run = state.provisioningRuns.find((candidate) => candidate.runId === runId)
      if (!run) {
        throw new EnterpriseIdentityError(
          404,
          'EnterpriseProvisioningRunNotFound',
          'Provisioning run was not found.',
        )
      }
      if (run.status === 'running') {
        const leaseExpiresAt = Date.parse(run.leaseExpiresAt ?? '')
        if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= this.clock().getTime()) {
          run.attempt += 1
          run.updatedAt = this.clock().toISOString()
          run.leaseExpiresAt = new Date(
            this.clock().getTime() + 5 * 60_000,
          ).toISOString()
          state.provisioningLogs.push({
            workspaceId,
            logId: crypto.randomUUID(),
            runId,
            attempt: run.attempt,
            level: 'warning',
            code: 'ProvisioningLeaseRecovered',
            message: 'An expired provisioning worker lease was recovered.',
            createdAt: run.updatedAt,
            retryable: true,
          })
          return run
        }
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseProvisioningRunInProgress',
          'This provisioning operation is already in progress.',
          true,
        )
      }
      if (run.status !== 'failed') return run
      run.status = 'running'
      run.attempt += 1
      run.failureCode = undefined
      run.updatedAt = this.clock().toISOString()
      run.completedAt = undefined
      run.leaseExpiresAt = new Date(
        this.clock().getTime() + 5 * 60_000,
      ).toISOString()
      state.provisioningLogs.push({
        workspaceId,
        logId: crypto.randomUUID(),
        runId,
        attempt: run.attempt,
        level: 'info',
        code: 'ProvisioningRetryStarted',
        message: 'Provisioning retry started.',
        createdAt: run.updatedAt,
        retryable: true,
      })
      return run
    })
  }

  /** Service account metadata を作成します。 */
  async createServiceAccount(
    account: EnterpriseServiceAccount,
    auditContext?: MutationAuditContext,
  ) {
    validateServiceAccountBoundary(account)
    if (!account.permissions.includes('service-accounts.use')) {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseServiceAccountPermissionMissing',
        'Service accounts require service-accounts.use permission.',
      )
    }
    return this.mutate(account.workspaceId, {
      context: auditContext,
      eventType: 'service-account.created',
      action: 'created',
      entityId: account.accountId,
    }, (state) => {
      if (!roleExists(state, account.roleId)) {
        throw new EnterpriseIdentityError(
          400,
          'EnterpriseRoleNotFound',
          'Service account references an unknown role.',
        )
      }
      if (state.serviceAccounts.some((candidate) => candidate.accountId === account.accountId)) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseServiceAccountExists',
          'Service account already exists.',
        )
      }
      state.serviceAccounts.push(account)
      return account
    })
  }

  /** Service account と最初の one-time credential を原子的かつ idempotent に作成します。 */
  async createServiceAccountWithToken(
    account: EnterpriseServiceAccount,
    idempotencyKey: string,
    requestFingerprint: string,
    auditContext?: MutationAuditContext,
  ) {
    validateServiceAccountBoundary(account)
    const normalizedIdempotencyKey = requireText(idempotencyKey, 'Idempotency key')
    const normalizedFingerprint = requireText(requestFingerprint, 'Request fingerprint')
    const receiptKey = `service-account-create:${normalizedIdempotencyKey}`
    const token = this.deriveOneTimeToken(
      'service-account',
      account.workspaceId,
      account.accountId,
      1,
      receiptKey,
    )
    const credentialId = stableId('service-credential', account.workspaceId, receiptKey)
    const digest = this.digestToken(
      'service-account',
      account.workspaceId,
      credentialId,
      token,
    )
    const result = await this.mutate(account.workspaceId, {
      context: auditContext,
      eventType: 'service-account.created',
      action: 'created',
      entityId: account.accountId,
    }, (state) => {
      const receiptAccountId = state.idempotencyResults[receiptKey]
      if (receiptAccountId) {
        assertIdempotencyReceipt(
          state,
          receiptKey,
          normalizedFingerprint,
          this.clock(),
          'Service account create',
        )
        const existingAccount = state.serviceAccounts.find((candidate) =>
          candidate.accountId === receiptAccountId
        )
        const existingCredential = state.serviceCredentials.find((candidate) =>
          candidate.credentialId === credentialId
        )
        if (!existingAccount || !existingCredential) {
          throw new EnterpriseIdentityError(
            503,
            'EnterpriseIdentityStateInvalid',
            'Service account idempotency receipt is incomplete.',
          )
        }
        const { digest: _digest, ...credential } = existingCredential
        return { account: existingAccount, credential }
      }
      if (!account.permissions.includes('service-accounts.use')) {
        throw new EnterpriseIdentityError(
          400,
          'EnterpriseServiceAccountPermissionMissing',
          'Service accounts require service-accounts.use permission.',
        )
      }
      if (!roleExists(state, account.roleId)) {
        throw new EnterpriseIdentityError(
          400,
          'EnterpriseRoleNotFound',
          'Service account references an unknown role.',
        )
      }
      if (state.serviceAccounts.some((candidate) => candidate.accountId === account.accountId)) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseServiceAccountExists',
          'Service account already exists.',
        )
      }
      const createdAt = this.clock().toISOString()
      const expiresAt = new Date(
        this.clock().getTime() + account.credentialLifetimeDays * 24 * 60 * 60_000,
      ).toISOString()
      const storedAccount = {
        ...account,
        credentialGeneration: 1,
        credentialExpiresAt: expiresAt,
        revision: account.revision + 1,
        updatedAt: createdAt,
      }
      const storedCredential = {
        workspaceId: account.workspaceId,
        credentialId,
        accountId: account.accountId,
        createdAt,
        expiresAt,
        digest,
      } satisfies StoredServiceCredential
      state.serviceAccounts.push(storedAccount)
      state.serviceCredentials.push(storedCredential)
      state.idempotencyResults[receiptKey] = storedAccount.accountId
      state.idempotencyFingerprints[receiptKey] = normalizedFingerprint
      state.idempotencyExpiresAt[receiptKey] =
        new Date(this.clock().getTime() + 10 * 60_000).toISOString()
      const { digest: _digest, ...credential } = storedCredential
      return { account: storedAccount, credential }
    })
    return { ...result, token }
  }

  /** Service account credential を一度だけ発行します。 */
  async issueServiceAccountToken(
    workspaceId: string,
    accountId: string,
    expiresAt?: string,
    auditContext?: MutationAuditContext,
  ) {
    const token = `msa_${randomBytes(32).toString('base64url')}`
    const credentialId = crypto.randomUUID()
    const digest = this.digestToken('service-account', workspaceId, credentialId, token)
    const requestedExpiry = expiresAt
      ? normalizeTimestamp(expiresAt, 'Credential expiry')
      : undefined
    const credential = await this.mutate(workspaceId, {
      context: auditContext,
      eventType: 'service-account-credential.issued',
      action: 'issued',
      entityId: credentialId,
    }, (state) => {
      const account = state.serviceAccounts.find((candidate) =>
        candidate.accountId === accountId && candidate.status === 'active'
      )
      if (!account) {
        throw new EnterpriseIdentityError(
          404,
          'EnterpriseServiceAccountNotFound',
          'Active service account was not found.',
        )
      }
      const createdAt = this.clock().toISOString()
      const maximumExpiry = new Date(
        this.clock().getTime() +
          Math.min(account.credentialLifetimeDays, 365) * 24 * 60 * 60_000,
      )
      const credentialExpiry = requestedExpiry ?? maximumExpiry.toISOString()
      const credentialExpiryTime = Date.parse(credentialExpiry)
      if (
        !Number.isFinite(credentialExpiryTime) ||
        credentialExpiryTime <= this.clock().getTime() ||
        credentialExpiryTime > maximumExpiry.getTime()
      ) {
        throw new EnterpriseIdentityError(
          400,
          'EnterpriseServiceAccountExpiryInvalid',
          'Service account credential expiry must be in the future and within the configured lifetime.',
        )
      }
      const nextCredential = {
        workspaceId,
        credentialId,
        accountId,
        createdAt,
        expiresAt: credentialExpiry,
        digest,
      } satisfies StoredServiceCredential
      state.serviceCredentials.push(nextCredential)
      account.credentialGeneration += 1
      account.credentialExpiresAt = nextCredential.expiresAt
      account.revision += 1
      account.updatedAt = nextCredential.createdAt
      return nextCredential
    })
    const { digest: _digest, ...publicCredential } = credential
    return { token, credential: publicCredential }
  }

  /** Existing credential を原子的に revoke して新しい credential を発行します。 */
  async rotateServiceAccountToken(
    workspaceId: string,
    accountId: string,
    expectedRevision: number,
    idempotencyKey: string,
    requestFingerprint: string,
    auditContext?: MutationAuditContext,
  ) {
    const receiptKey =
      `service-account-rotate:${accountId}:${requireText(idempotencyKey, 'Idempotency key')}`
    const normalizedFingerprint = requireText(requestFingerprint, 'Request fingerprint')
    const token = this.deriveOneTimeToken(
      'service-account',
      workspaceId,
      accountId,
      expectedRevision + 1,
      receiptKey,
    )
    const credentialId = stableId('service-credential', workspaceId, receiptKey)
    const digest = this.digestToken(
      'service-account',
      workspaceId,
      credentialId,
      token,
    )
    const credential = await this.mutate(workspaceId, {
      context: auditContext,
      eventType: 'service-account-credential.rotated',
      action: 'rotated',
      entityId: credentialId,
    }, (state) => {
      const receiptCredentialId = state.idempotencyResults[receiptKey]
      if (receiptCredentialId) {
        assertIdempotencyReceipt(
          state,
          receiptKey,
          normalizedFingerprint,
          this.clock(),
          'Service account credential rotation',
        )
        const existing = state.serviceCredentials.find((candidate) =>
          candidate.credentialId === receiptCredentialId
        )
        if (!existing) {
          throw new EnterpriseIdentityError(
            503,
            'EnterpriseIdentityStateInvalid',
            'Service credential idempotency receipt is incomplete.',
          )
        }
        return existing
      }
      const account = state.serviceAccounts.find((candidate) =>
        candidate.accountId === accountId && candidate.status === 'active'
      )
      if (!account) {
        throw new EnterpriseIdentityError(
          404,
          'EnterpriseServiceAccountNotFound',
          'Active service account was not found.',
        )
      }
      if (account.revision !== expectedRevision) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseServiceAccountConflict',
          'Service account changed. Reload and try again.',
        )
      }
      const revokedAt = this.clock().toISOString()
      for (const candidate of state.serviceCredentials) {
        if (candidate.accountId === accountId && !candidate.revokedAt) {
          candidate.revokedAt = revokedAt
        }
      }
      const nextCredential = {
        workspaceId,
        credentialId,
        accountId,
        createdAt: revokedAt,
        expiresAt: new Date(
          this.clock().getTime() + account.credentialLifetimeDays * 24 * 60 * 60_000,
        ).toISOString(),
        digest,
      } satisfies StoredServiceCredential
      state.serviceCredentials.push(nextCredential)
      account.credentialGeneration += 1
      account.credentialExpiresAt = nextCredential.expiresAt
      account.revision += 1
      account.updatedAt = nextCredential.createdAt
      state.idempotencyResults[receiptKey] = credentialId
      state.idempotencyFingerprints[receiptKey] = normalizedFingerprint
      state.idempotencyExpiresAt[receiptKey] =
        new Date(this.clock().getTime() + 10 * 60_000).toISOString()
      return nextCredential
    })
    const { digest: _digest, ...publicCredential } = credential
    return { token, credential: publicCredential }
  }

  /** Service account bearer credential を認証します。 */
  async authenticateServiceAccountToken(workspaceId: string, token: string) {
    const state = await this.loadState(workspaceId)
    const credential = state.serviceCredentials.find((candidate) =>
      isMatchingCredentialDigest(
        candidate.digest,
        this.digestToken(
          'service-account',
          workspaceId,
          candidate.credentialId,
          token,
        ),
      ) &&
      !candidate.revokedAt &&
      (!candidate.expiresAt || Date.parse(candidate.expiresAt) > this.clock().getTime())
    )
    const account = credential
      ? state.serviceAccounts.find((candidate) =>
          candidate.accountId === credential.accountId && candidate.status === 'active'
        )
      : undefined
    if (!account || !credential) return undefined
    return account
  }

  /** 全 boundary check 成功後に service account の last-used/audit を更新します。 */
  async recordServiceAccountUse(
    workspaceId: string,
    accountId: string,
    auditContext?: MutationAuditContext,
  ) {
    const now = this.clock().toISOString()
    const snapshot = await this.getSnapshot(workspaceId)
    const account = snapshot.serviceAccounts.find((candidate) =>
      candidate.accountId === accountId && candidate.status === 'active'
    )
    if (!account) return
    await this.mutate(workspaceId, {
      context: auditContext,
      eventType: 'service-account.authenticated',
      action: 'authenticated',
      entityId: accountId,
    }, (next) => {
      const nextAccount = next.serviceAccounts.find((candidate) =>
        candidate.accountId === accountId && candidate.status === 'active'
      )
      if (nextAccount) nextAccount.lastUsedAt = now
    })
  }

  /** Service account credential または account 全体を revoke します。 */
  async revokeServiceAccountToken(
    workspaceId: string,
    accountId: string,
    credentialId?: string,
    expectedRevision?: number,
    auditContext?: MutationAuditContext,
  ) {
    await this.mutate(workspaceId, {
      context: auditContext,
      eventType: 'service-account.revoked',
      action: 'revoked',
      entityId: credentialId ?? accountId,
    }, (state) => {
      const account = state.serviceAccounts.find((candidate) =>
        candidate.accountId === accountId
      )
      if (!account) {
        throw new EnterpriseIdentityError(
          404,
          'EnterpriseServiceAccountNotFound',
          'Service account was not found.',
        )
      }
      if (
        !credentialId &&
        expectedRevision !== undefined &&
        account.revision !== expectedRevision
      ) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseServiceAccountConflict',
          'Service account changed. Reload and try again.',
        )
      }
      const revokedAt = this.clock().toISOString()
      for (const credential of state.serviceCredentials) {
        if (
          credential.accountId === accountId &&
          (!credentialId || credential.credentialId === credentialId)
        ) credential.revokedAt = revokedAt
      }
      if (!credentialId) {
        account.status = 'disabled'
        account.revision += 1
        account.updatedAt = revokedAt
      }
    })
  }

  /** Break-glass account metadata を upsert します。 */
  async putBreakGlassAccount(
    account: EnterpriseBreakGlassAccount,
    auditContext?: MutationAuditContext,
  ) {
    if (
      !account.requireMfa ||
      account.maximumActivationMinutes < 1 ||
      account.maximumActivationMinutes > 60 ||
      !normalizeEmailDomain(account.email) ||
      !Number.isFinite(Date.parse(account.mfaVerifiedAt))
    ) {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseBreakGlassPolicyInvalid',
        'Break-glass requires a verified MFA enrollment, email, and 1-60 minute duration.',
      )
    }
    return this.mutate(account.workspaceId, {
      context: auditContext,
      eventType: 'break-glass-account.updated',
      action: 'updated',
      entityId: account.accountId,
    }, (state) => {
      const existing = state.breakGlassAccounts.find((candidate) =>
        candidate.accountId === account.accountId
      )
      if (
        existing
          ? account.revision !== existing.revision + 1
          : account.revision !== 1
      ) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseBreakGlassConflict',
          'Break-glass account changed. Reload and try again.',
        )
      }
      upsertBy(state.breakGlassAccounts, account, (candidate) =>
        candidate.accountId === account.accountId
      )
      return account
    })
  }

  /** 理由・MFA・期限付きの break-glass activation を作成します。 */
  async activateBreakGlass(
    workspaceId: string,
    accountId: string,
    actorMemberKey: string,
    authenticationSessionId: string,
    reason: string,
    durationMinutes: number,
    auditContext?: MutationAuditContext,
  ) {
    const normalizedReason = requireText(reason, 'Break-glass reason')
    const normalizedAuthenticationSessionId = requireText(
      authenticationSessionId,
      'Break-glass authentication session ID',
    )
    if (!Number.isSafeInteger(durationMinutes) || durationMinutes < 1) {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseBreakGlassDurationInvalid',
        'Break-glass duration must be a positive integer.',
      )
    }
    const startedAt = this.clock().toISOString()
    const expiresAt = new Date(
      this.clock().getTime() + durationMinutes * 60_000,
    ).toISOString()
    const activationId = crypto.randomUUID()
    return this.mutate(workspaceId, {
      context: auditContext,
      eventType: 'break-glass.activated',
      action: 'activated',
      entityId: accountId,
      metadata: {
        reason: '[REDACTED]',
        durationMinutes,
        expiresAt,
        activationId,
      },
    }, (state) => {
      const account = state.breakGlassAccounts.find((candidate) =>
        candidate.accountId === accountId &&
        candidate.linkedMemberKey === actorMemberKey &&
        candidate.status === 'active'
      )
      if (!account) {
        throw new EnterpriseIdentityError(
          403,
          'EnterpriseBreakGlassDenied',
          'Active break-glass account was not found for this member.',
        )
      }
      requireUnmanagedEnterpriseBreakGlassRecoveryDomain(state, account.email)
      if (
        !Number.isSafeInteger(durationMinutes) ||
        durationMinutes < 1 ||
        durationMinutes > account.maximumActivationMinutes
      ) {
        throw new EnterpriseIdentityError(
          400,
          'EnterpriseBreakGlassDurationInvalid',
          'Break-glass duration exceeds the configured maximum.',
        )
      }
      account.lastTestedAt = startedAt
      account.revision += 1
      account.updatedAt = startedAt
      const activation = {
        workspaceId,
        activationId,
        accountId,
        actorMemberKey,
        authenticationSessionId: normalizedAuthenticationSessionId,
        reason: normalizedReason,
        mfaVerified: true,
        startedAt,
        expiresAt,
      } satisfies EnterpriseBreakGlassActivation
      state.breakGlassActivations.push(activation)
      return activation
    })
  }

  /** Current member の active break-glass elevation だけを早期終了します。 */
  async revokeBreakGlassActivation(
    workspaceId: string,
    actorMemberKey: string,
    authenticationSessionId: string,
    auditContext?: MutationAuditContext,
  ) {
    const normalizedAuthenticationSessionId = requireText(
      authenticationSessionId,
      'Break-glass authentication session ID',
    )
    await this.mutate(workspaceId, {
      context: auditContext,
      eventType: 'break-glass.activation-revoked',
      action: 'revoked',
      entityId: actorMemberKey,
    }, (state) => {
      const revokedAt = this.clock().toISOString()
      for (const activation of state.breakGlassActivations) {
        if (
          activation.actorMemberKey === actorMemberKey &&
          activation.authenticationSessionId === normalizedAuthenticationSessionId &&
          !activation.revokedAt &&
          Date.parse(activation.expiresAt) > this.clock().getTime()
        ) {
          activation.revokedAt = revokedAt
        }
      }
    })
  }

  /** Active break-glass activation を早期 revoke します。 */
  async deactivateBreakGlass(
    workspaceId: string,
    accountId: string,
    expectedRevision: number,
    auditContext?: MutationAuditContext,
  ) {
    await this.mutate(workspaceId, {
      context: auditContext,
      eventType: 'break-glass.deactivated',
      action: 'deactivated',
      entityId: accountId,
    }, (state) => {
      const account = state.breakGlassAccounts.find((candidate) =>
        candidate.accountId === accountId
      )
      if (!account || account.revision !== expectedRevision) {
        throw new EnterpriseIdentityError(
          account ? 409 : 404,
          account ? 'EnterpriseBreakGlassConflict' : 'EnterpriseBreakGlassAccountNotFound',
          account
            ? 'Break-glass account changed. Reload and try again.'
            : 'Break-glass account was not found.',
        )
      }
      if (
        account?.status === 'active' &&
        state.domains.some((domain) => domain.enforceSso) &&
        state.breakGlassAccounts.filter((candidate) =>
          candidate.status === 'active' && candidate.accountId !== accountId
        ).length === 0
      ) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseBreakGlassLastAccount',
          'The last active break-glass account cannot be disabled while SSO is enforced.',
        )
      }
      const revokedAt = this.clock().toISOString()
      for (const activation of state.breakGlassActivations) {
        if (activation.accountId === accountId && !activation.revokedAt) {
          activation.revokedAt = revokedAt
        }
      }
      if (account) {
        account.status = 'disabled'
        account.revision += 1
        account.updatedAt = revokedAt
      }
    })
  }

  /** Member の current authentication session に対する有効な activation を返します。 */
  async getActiveBreakGlassActivation(
    workspaceId: string,
    memberKey: string,
    authenticationSessionId: string,
  ) {
    const normalizedAuthenticationSessionId = requireText(
      authenticationSessionId,
      'Break-glass authentication session ID',
    )
    const state = await this.loadState(workspaceId)
    const now = this.clock().getTime()
    return state.breakGlassActivations.find((activation) =>
      activation.actorMemberKey === memberKey &&
      activation.authenticationSessionId === normalizedAuthenticationSessionId &&
      !activation.revokedAt &&
      Date.parse(activation.expiresAt) > now &&
      state.breakGlassAccounts.some((account) =>
        account.accountId === activation.accountId && account.status === 'active'
      )
    )
  }

  /** State mutation を optimistic retry と audit 付きで実行します。 */
  private async mutate<T>(
    workspaceId: string,
    audit: EnterpriseMutationAudit,
    mutateState: (state: EnterpriseIdentityState) => T,
  ): Promise<T> {
    const normalizedWorkspaceId = requireText(workspaceId, 'Workspace ID')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.loadState(normalizedWorkspaceId)
      const next = structuredClone(current)
      const result = mutateState(next)
      if (JSON.stringify(next) === JSON.stringify(current)) return result
      next.storageRevision = current.storageRevision + 1
      try {
        await this.saveState(next, current, audit)
        return result
      } catch (error) {
        if (
          error instanceof EnterpriseIdentityError &&
          error.code === 'EnterpriseIdentityRevisionConflict' &&
          attempt < 2
        ) continue
        throw error
      }
    }
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseIdentityRevisionConflict',
      'Enterprise identity state changed. Reload and try again.',
      true,
    )
  }

  /** Raw credential を永続化しない HMAC digest に変換します。 */
  protected digestToken(
    kind: 'scim' | 'service-account',
    workspaceId: string,
    credentialId: string,
    token: string,
  ) {
    return createHmac('sha256', this.tokenHashSecret)
      .update([
        kind,
        requireText(workspaceId, 'Workspace ID'),
        requireText(credentialId, 'Credential ID'),
        requireText(token, 'Credential'),
      ].join('\0'))
      .digest('hex')
  }

  /** Idempotency window 内だけ再生成できる one-time bearer token を導出します。 */
  private deriveOneTimeToken(
    kind: 'scim' | 'service-account',
    workspaceId: string,
    entityId: string,
    generation: number,
    receiptKey: string,
  ) {
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseCredentialGenerationInvalid',
        'Credential generation must be a positive integer.',
      )
    }
    const prefix = kind === 'scim' ? 'msc' : 'msa'
    return `${prefix}_${createHmac('sha256', this.tokenHashSecret)
      .update([
        'enterprise-one-time-credential-v1',
        kind,
        requireText(workspaceId, 'Workspace ID'),
        requireText(entityId, 'Credential entity ID'),
        String(generation),
        requireText(receiptKey, 'Credential receipt key'),
      ].join('\0'))
      .digest('base64url')}`
  }
}

/**
 * Test/local unit of work で利用する memory-backed enterprise identity client です。
 */
export class InMemoryEnterpriseIdentityClient extends EnterpriseIdentityService {
  /** Workspace ごとの永続 state です。 */
  private readonly states = new Map<string, EnterpriseIdentityState>()
  /** Global domain claim owner です。 */
  private readonly domainOwners = new Map<string, string>()

  /**
   * Memory-backed enterprise identity client を作成します。
   */
  constructor(
    tokenHashSecret = 'test-enterprise-identity-secret-0000000000000000',
    clock: () => Date = () => new Date(),
    scimResourceLimits: EnterpriseScimResourceLimits =
      ENTERPRISE_SCIM_RESOURCE_LIMITS,
  ) {
    super(tokenHashSecret, clock, scimResourceLimits)
  }

  /** Memory state を clone して読み込みます。 */
  protected async loadState(workspaceId: string) {
    return structuredClone(this.states.get(workspaceId) ?? createEmptyState(workspaceId))
  }

  /** Revision が一致する場合だけ memory state を保存します。 */
  protected async saveState(
    state: EnterpriseIdentityState,
    expectedState: EnterpriseIdentityState,
    _audit: EnterpriseMutationAudit,
  ) {
    const current = this.states.get(state.workspaceId)
    if ((current?.storageRevision ?? 0) !== expectedState.storageRevision) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseIdentityRevisionConflict',
        'Enterprise identity state changed. Reload and try again.',
        true,
      )
    }
    const domainClaims = getEnterpriseDomainClaimChanges(expectedState, state)
    for (const domain of domainClaims.claimed) {
      const owner = this.domainOwners.get(domain)
      if (owner && owner !== state.workspaceId) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseDomainAlreadyClaimed',
          'Domain is already claimed by another workspace.',
        )
      }
    }
    this.states.set(state.workspaceId, structuredClone(state))
    for (const domain of domainClaims.released) {
      if (this.domainOwners.get(domain) === state.workspaceId) {
        this.domainOwners.delete(domain)
      }
    }
    for (const domain of domainClaims.claimed) {
      this.domainOwners.set(domain, state.workspaceId)
    }
  }

  /** Domain claim owner を memory から返します。 */
  protected async findDomainWorkspace(domain: string) {
    return this.domainOwners.get(domain)
  }
}

/**
 * DynamoDB-backed production enterprise identity client です。
 */
export class DynamoDbEnterpriseIdentityClient extends EnterpriseIdentityService {
  /** Enterprise identity state table 名です。 */
  private readonly tableName: string
  /** Immutable audit event table 名です。 */
  private readonly auditTableName?: string
  /** DynamoDB document client です。 */
  private readonly documentClient: DynamoDBDocumentClient

  /**
   * DynamoDB-backed enterprise identity client を作成します。
   */
  constructor(
    tableName: string,
    tokenHashSecret: string,
    documentClient = createEnterpriseDocumentClient(),
    auditTableName = process.env.AUDIT_EVENTS_TABLE_NAME ??
      process.env.MUKUROJI_AUDIT_EVENTS_TABLE,
    clock: () => Date = () => new Date(),
    scimResourceLimits: EnterpriseScimResourceLimits =
      ENTERPRISE_SCIM_RESOURCE_LIMITS,
  ) {
    super(tokenHashSecret, clock, scimResourceLimits)
    this.tableName = requireText(tableName, 'Enterprise identity table name')
    this.documentClient = documentClient
    this.auditTableName = auditTableName?.trim() || undefined
  }

  /** CONTROL と bounded generation chain を強整合読みします。 */
  protected async loadState(workspaceId: string) {
    try {
      for (let readAttempt = 0; readAttempt < 2; readAttempt += 1) {
        const controlResponse = await this.documentClient.send(new GetCommand({
          TableName: this.tableName,
          Key: {
            scopeKey: `WORKSPACE#${workspaceId}`,
            recordKey: 'CONTROL',
          },
          ConsistentRead: true,
        }))
        if (!controlResponse.Item) return createEmptyState(workspaceId)
        const control = readEnterpriseIdentityControl(
          controlResponse.Item,
          workspaceId,
        )
        const generationPartitions = await Promise.all(
          control.storageGenerationChain.map((stateGeneration) =>
            this.loadEnterpriseGeneration(workspaceId, stateGeneration)
          ),
        )
        const hasPhysicalExpiry = generationPartitions.some((items) =>
          items.some((item) => item.expiresAt !== undefined)
        )
        const generations = generationPartitions.map((items, index) =>
          validateEnterpriseGeneration(
            items,
            workspaceId,
            control.storageGenerationChain[index]!,
            control.storageRevision - index,
            hasPhysicalExpiry,
          )
        )
        validateEnterpriseGenerationChain(control, generations)
        if (hasPhysicalExpiry) {
          const refreshedControlResponse = await this.documentClient.send(new GetCommand({
            TableName: this.tableName,
            Key: {
              scopeKey: `WORKSPACE#${workspaceId}`,
              recordKey: 'CONTROL',
            },
            ConsistentRead: true,
          }))
          if (!refreshedControlResponse.Item) throw invalidEnterpriseIdentityState()
          const refreshedControl = readEnterpriseIdentityControl(
            refreshedControlResponse.Item,
            workspaceId,
          )
          if (
            refreshedControl.storageRevision === control.storageRevision &&
            refreshedControl.storageGeneration === control.storageGeneration
          ) {
            throw invalidEnterpriseIdentityState()
          }
          if (readAttempt === 0) continue
          throw invalidEnterpriseIdentityState()
        }
        return readEnterpriseIdentityRecords(
          materializeEnterpriseIdentityRecords(control, generations),
          workspaceId,
          this.currentTime(),
        )
      }
      throw invalidEnterpriseIdentityState()
    } catch (error) {
      if (error instanceof EnterpriseIdentityError) throw error
      throw toEnterprisePersistenceError(error)
    }
  }

  /** Direct auth partition だけから SCIM credential と provider を認証します。 */
  override async authenticateScimWorkspace(
    workspaceId: string,
    token: string,
  ) {
    const normalizedWorkspaceId = requireText(workspaceId, 'Workspace ID')
    const normalizedToken = requireText(token, 'SCIM credential')
    try {
      let exclusiveStartKey: Record<string, unknown> | undefined
      let authenticatedCredential: EnterpriseScimCredential | undefined
      do {
        const response = await this.documentClient.send(new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression:
            'scopeKey = :scopeKey AND begins_with(recordKey, :recordPrefix)',
          ExpressionAttributeValues: {
            ':scopeKey': enterpriseScimAuthenticationScopeKey(
              normalizedWorkspaceId,
            ),
            ':recordPrefix':
              enterpriseScimAuthenticationCredentialRecordPrefix(),
          },
          ConsistentRead: true,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }))
        for (const item of response.Items ?? []) {
          const [credential, digest] =
            readEnterpriseScimAuthenticationCredential(
              item,
              normalizedWorkspaceId,
            )
          if (
            isMatchingCredentialDigest(
              digest,
              this.digestToken(
                'scim',
                normalizedWorkspaceId,
                credential.credentialId,
                normalizedToken,
              ),
            )
          ) {
            authenticatedCredential = credential
            break
          }
        }
        exclusiveStartKey = response.LastEvaluatedKey
      } while (!authenticatedCredential && exclusiveStartKey)
      if (
        !authenticatedCredential ||
        authenticatedCredential.revokedAt ||
        authenticatedCredential.expiresAt &&
          Date.parse(authenticatedCredential.expiresAt) <=
            this.currentTime().getTime()
      ) {
        return undefined
      }
      const providerResponse = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: {
          scopeKey: enterpriseScimAuthenticationScopeKey(
            normalizedWorkspaceId,
          ),
          recordKey: enterpriseScimAuthenticationProviderRecordKey(
            authenticatedCredential.identityProviderId,
          ),
        },
        ConsistentRead: true,
      }))
      const provider = readEnterpriseScimAuthenticationProvider(
        providerResponse.Item,
        normalizedWorkspaceId,
        authenticatedCredential.identityProviderId,
      )
      try {
        assertEnterpriseIdentityProviderReady(provider)
      } catch {
        return undefined
      }
      return {
        credential: authenticatedCredential,
        provider,
      }
    } catch (error) {
      if (error instanceof EnterpriseIdentityError) throw error
      throw toEnterprisePersistenceError(error)
    }
  }

  /** Provider-scoped SCIM User direct projection を強整合 Query します。 */
  override async listScimUsers(input: EnterpriseScimUserListInput) {
    return await this.listScimProjection<EnterpriseScimUser>(
      'user',
      validateEnterpriseScimListInput(
        input,
        ['externalId', 'userName', 'displayName'],
      ),
    )
  }

  /** Provider-scoped SCIM Group direct projection を強整合 Query します。 */
  override async listScimGroups(input: EnterpriseScimGroupListInput) {
    return await this.listScimProjection<EnterpriseScimGroup>(
      'group',
      validateEnterpriseScimListInput(
        input,
        ['externalId', 'displayName'],
        ENTERPRISE_SCIM_GROUP_PAGE_LIMIT,
      ),
    )
  }

  /** SCIM collection/lookup partition だけから一つの page を読みます。 */
  private async listScimProjection<
    Resource extends EnterpriseScimUser | EnterpriseScimGroup,
  >(
    resourceKind: EnterpriseScimProjectionResourceKind,
    input: EnterpriseScimUserListInput | EnterpriseScimGroupListInput,
  ) {
    try {
      const scopeKey = input.filter
        ? enterpriseScimLookupScopeKey(
            input.workspaceId,
            input.identityProviderId,
            resourceKind,
            input.filter.field,
            input.filter.value,
          )
        : enterpriseScimCollectionScopeKey(
            input.workspaceId,
            input.identityProviderId,
            resourceKind,
          )
      const metaResponse = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: {
          scopeKey,
          recordKey: enterpriseScimProjectionMetaRecordKey(),
        },
        ConsistentRead: true,
      }))
      const totalResults = readEnterpriseScimProjectionTotal(
        metaResponse.Item,
        input.workspaceId,
        input.identityProviderId,
        resourceKind,
        input.filter,
      )
      if (
        input.count === 0 ||
        input.startIndex > totalResults
      ) {
        return {
          totalResults,
          startIndex: input.startIndex,
          resources: [],
        }
      }

      const resources: Resource[] = []
      let remainingSkip = input.startIndex - 1
      let exclusiveStartKey: Record<string, unknown> | undefined
      do {
        const response = await this.documentClient.send(new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression:
            'scopeKey = :scopeKey AND begins_with(recordKey, :recordPrefix)',
          ExpressionAttributeValues: {
            ':scopeKey': scopeKey,
            ':recordPrefix': enterpriseScimProjectionResourceRecordPrefix(),
          },
          ConsistentRead: true,
          Limit: Math.max(1, remainingSkip + input.count - resources.length),
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }))
        for (const item of response.Items ?? []) {
          if (remainingSkip > 0) {
            remainingSkip -= 1
            continue
          }
          resources.push(readEnterpriseScimProjectionResource<Resource>(
            item,
            input.workspaceId,
            input.identityProviderId,
            resourceKind,
            input.filter,
          ))
          if (resources.length >= input.count) break
        }
        exclusiveStartKey = response.LastEvaluatedKey
      } while (resources.length < input.count && exclusiveStartKey)

      return {
        totalResults,
        startIndex: input.startIndex,
        resources,
      }
    } catch (error) {
      if (error instanceof EnterpriseIdentityError) throw error
      throw toEnterprisePersistenceError(error)
    }
  }

  /** Generation partition を強整合 Query で全件読みします。 */
  private async loadEnterpriseGeneration(
    workspaceId: string,
    stateGeneration: string,
  ) {
    return await loadEnterpriseGenerationPartition(
      this.documentClient,
      this.tableName,
      workspaceId,
      stateGeneration,
    )
  }

  /** Generation を staging し CONTROL/domain/audit だけを atomic checkpoint します。 */
  protected async saveState(
    state: EnterpriseIdentityState,
    expectedState: EnterpriseIdentityState,
    audit: EnterpriseMutationAudit,
  ) {
    if (
      expectedState.storageGeneration &&
      expectedState.storageGenerationChain.length >=
        ENTERPRISE_GENERATION_CHAIN_LIMIT
    ) {
      throw new EnterpriseIdentityError(
        503,
        'EnterpriseIdentityCompactionRequired',
        'Enterprise identity maintenance is compacting this workspace. Retry shortly.',
        true,
      )
    }
    const expectedRecords = serializeEnterpriseIdentityRecords(expectedState)
    const nextRecords = serializeEnterpriseIdentityRecords(state)
    const domainClaims = getEnterpriseDomainClaimChanges(expectedState, state)
    const scimProjectionWrites = [
      ...createEnterpriseScimResourceProjectionWrites(
        this.tableName,
        expectedState,
        state,
      ),
      ...createEnterpriseScimAuthenticationProjectionWrites(
        this.tableName,
        expectedState,
        state,
      ),
    ]
    const scimGroupJobWrites = createEnterpriseScimGroupJobProjectionWrites(
      this.tableName,
      expectedState,
      state,
    )
    const changedRecordKeys = new Set([
      ...[...expectedRecords].filter(([recordKey, record]) =>
        nextRecords.get(recordKey)?.contentHash !== record.contentHash
      ).map(([recordKey]) => recordKey),
      ...[...nextRecords].filter(([recordKey, record]) =>
        expectedRecords.get(recordKey)?.contentHash !== record.contentHash
      ).map(([recordKey]) => recordKey),
    ])
    const stateGeneration = crypto.randomUUID()
    const generationKind: EnterpriseGenerationKind = expectedState.storageGeneration
      ? 'delta'
      : 'snapshot'
    const activeStateGenerations = generationKind === 'snapshot'
      ? [stateGeneration]
      : [stateGeneration, ...expectedState.storageGenerationChain]
    const generationRecordKeys = generationKind === 'snapshot'
      ? [...nextRecords.keys()]
      : [...changedRecordKeys]
    const generationScopeKey = enterpriseGenerationScopeKey(
      state.workspaceId,
      stateGeneration,
    )
    const generationItems = generationRecordKeys.map((recordKey) => {
      const next = nextRecords.get(recordKey)
      if (!next) {
        return {
          scopeKey: generationScopeKey,
          recordKey: enterpriseDeltaRecordKey(recordKey),
          entryType: 'enterprise-identity-tombstone',
          workspaceId: state.workspaceId,
          stateGeneration,
          logicalRecordKey: recordKey,
        }
      }
      return {
        scopeKey: generationScopeKey,
        recordKey: enterpriseDeltaRecordKey(recordKey),
        entryType: 'enterprise-identity-record',
        workspaceId: state.workspaceId,
        stateGeneration,
        logicalRecordKey: recordKey,
        ...next,
      }
    })
    const stagedItems = [
      {
        scopeKey: generationScopeKey,
        recordKey: enterpriseGenerationRecordKey(),
        entryType: 'enterprise-identity-generation',
        workspaceId: state.workspaceId,
        stateGeneration,
        generationKind,
        generationRevision: state.storageRevision,
        deltaCount: generationItems.length,
        manifestHash: fingerprintEnterpriseGenerationManifest(generationItems),
        ...(generationKind === 'delta'
          ? {
              parentStateGeneration: expectedState.storageGeneration,
              parentGenerationRevision: expectedState.storageRevision,
            }
          : {}),
      },
      ...generationItems,
    ]
    await this.stageEnterpriseGeneration(stagedItems)
    const controlWrite = {
      Put: {
        TableName: this.tableName,
        Item: {
          scopeKey: `WORKSPACE#${state.workspaceId}`,
          recordKey: 'CONTROL',
          entryType: 'enterprise-identity-control',
          workspaceId: state.workspaceId,
          controlRevision: state.storageRevision,
          activeStateGeneration: stateGeneration,
          activeStateGenerations,
          retiredStateGenerations: state.storageRetiredGenerations,
          maintenanceRequired:
            activeStateGenerations.length >=
              ENTERPRISE_GENERATION_COMPACTION_THRESHOLD ||
            state.storageRetiredGenerations.length > 0,
        },
        ConditionExpression: expectedState.storageRevision === 0
          ? 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)'
          : 'controlRevision = :expectedRevision AND activeStateGeneration = :expectedGeneration',
        ...(expectedState.storageRevision === 0
          ? {}
          : {
              ExpressionAttributeValues: {
                ':expectedRevision': expectedState.storageRevision,
                ':expectedGeneration': expectedState.storageGeneration,
              },
            }),
      },
    }
    const domainClaimWrites = [
      ...domainClaims.claimed.map((domain) => ({
        Put: {
          TableName: this.tableName,
          Item: {
            scopeKey: `DOMAIN#${domain}`,
            recordKey: 'CLAIM',
            entryType: 'enterprise-domain-claim',
            workspaceId: state.workspaceId,
          },
          ConditionExpression:
            'attribute_not_exists(scopeKey) OR workspaceId = :workspaceId',
          ExpressionAttributeValues: { ':workspaceId': state.workspaceId },
        },
      })),
      ...domainClaims.released.map((domain) => ({
        Delete: {
          TableName: this.tableName,
          Key: {
            scopeKey: `DOMAIN#${domain}`,
            recordKey: 'CLAIM',
          },
          ConditionExpression:
            'attribute_not_exists(scopeKey) OR workspaceId = :workspaceId',
          ExpressionAttributeValues: { ':workspaceId': state.workspaceId },
        },
      })),
    ]
    const auditPut = createMutationAuditEventPut(
      this.auditTableName,
      audit.context,
      {
        directoryId: state.workspaceId,
        eventType: audit.eventType,
        entityType: 'enterprise-security',
        entityId: audit.entityId,
        action: audit.action,
        occurredAt: audit.context?.occurredAt,
        metadata: {
          kind: 'enterprise-identity',
          ...audit.metadata,
        },
        sequence: 10,
      },
    )
    const transactItems = [
      controlWrite,
      ...scimGroupJobWrites,
      ...domainClaimWrites,
      ...scimProjectionWrites,
      ...(auditPut ? [auditPut] : []),
    ]
    if (transactItems.length > 100) {
      await this.cleanupEnterpriseGeneration(stagedItems)
      throw new EnterpriseIdentityError(
        413,
        'EnterpriseIdentityMutationTooLarge',
        'This mutation changes too many enterprise records for one atomic checkpoint.',
      )
    }
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: transactItems,
      }))
    } catch (error) {
      if (isConditionalWriteError(error)) {
        await this.cleanupEnterpriseGeneration(stagedItems)
        for (const domain of domainClaims.claimed) {
          const ownerWorkspaceId = await this.findDomainWorkspace(domain)
          if (ownerWorkspaceId && ownerWorkspaceId !== state.workspaceId) {
            throw new EnterpriseIdentityError(
              409,
              'EnterpriseDomainAlreadyClaimed',
              'The verified domain is already assigned to another workspace.',
            )
          }
        }
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseIdentityRevisionConflict',
          'Enterprise identity state changed. Reload and try again.',
          true,
          { cause: error },
        )
      }
      await this.cleanupEnterpriseGeneration(stagedItems)
      throw toEnterprisePersistenceError(error)
    }
  }

  /** Immutable delta generation を DynamoDB の 25-item batch 単位で先行保存します。 */
  private async stageEnterpriseGeneration(items: Record<string, unknown>[]) {
    try {
      for (let offset = 0; offset < items.length; offset += 25) {
        let pending: NonNullable<BatchWriteCommandInput['RequestItems']>[string] =
          items.slice(offset, offset + 25).map((item) => ({
            PutRequest: { Item: item },
          }))
        for (let attempt = 0; pending.length > 0 && attempt < 5; attempt += 1) {
          const response = await this.documentClient.send(new BatchWriteCommand({
            RequestItems: { [this.tableName]: pending },
          }))
          pending = response.UnprocessedItems?.[this.tableName] ?? []
        }
        if (pending.length > 0) {
          throw new EnterpriseIdentityError(
            503,
            'EnterpriseIdentityUnavailable',
            'Enterprise identity state is unavailable.',
            true,
          )
        }
      }
    } catch (error) {
      await this.cleanupEnterpriseGeneration(items)
      if (error instanceof EnterpriseIdentityError) throw error
      throw toEnterprisePersistenceError(error)
    }
  }

  /** 未commit generation の既知 key を best-effort で削除します。 */
  private async cleanupEnterpriseGeneration(items: Record<string, unknown>[]) {
    try {
      for (let offset = 0; offset < items.length; offset += 25) {
        let pending: NonNullable<BatchWriteCommandInput['RequestItems']>[string] =
          items.slice(offset, offset + 25).map((item) => ({
            DeleteRequest: {
              Key: {
                scopeKey: item.scopeKey,
                recordKey: item.recordKey,
              },
            },
          }))
        for (let attempt = 0; pending.length > 0 && attempt < 3; attempt += 1) {
          const response = await this.documentClient.send(new BatchWriteCommand({
            RequestItems: { [this.tableName]: pending },
          }))
          pending = response.UnprocessedItems?.[this.tableName] ?? []
        }
      }
    } catch {
      // Orphaned UUID partitions are invisible unless CONTROL points to them.
    }
  }

  /** Domain claim owner を global pointer から返します。 */
  protected async findDomainWorkspace(domain: string) {
    try {
      const response = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: {
          scopeKey: `DOMAIN#${domain}`,
          recordKey: 'CLAIM',
        },
        ConsistentRead: true,
      }))
      return typeof response.Item?.workspaceId === 'string'
        ? response.Item.workspaceId
        : undefined
    } catch (error) {
      throw toEnterprisePersistenceError(error)
    }
  }
}

/**
 * DynamoDB-backed enterprise identity generations の compaction と退役処理です。
 *
 * @remarks
 * API request path から完全 snapshot の書き込みを分離し、CONTROL の head/revision CAS
 * に成功した sealed snapshot だけを reader へ公開します。
 */
export class DynamoDbEnterpriseIdentityMaintenanceClient {
  /** Enterprise identity state table 名です。 */
  private readonly tableName: string
  /** DynamoDB document client です。 */
  private readonly documentClient: DynamoDBDocumentClient
  /** Testable wall clock です。 */
  private readonly clock: () => Date

  /**
   * DynamoDB-backed maintenance client を作成します。
   */
  constructor(
    tableName: string,
    documentClient = createEnterpriseDocumentClient(),
    clock: () => Date = () => new Date(),
  ) {
    this.tableName = requireText(tableName, 'Enterprise identity table name')
    this.documentClient = documentClient
    this.clock = clock
  }

  /**
   * 一つの Workspace について旧 generation の TTL 付与、または compaction を行います。
   */
  async maintainWorkspace(workspaceId: string) {
    const normalizedWorkspaceId = requireText(workspaceId, 'Workspace ID')
    try {
      const controlItem = await this.loadControl(normalizedWorkspaceId)
      if (!controlItem) return { status: 'idle' as const }
      const control = readEnterpriseIdentityControl(
        controlItem,
        normalizedWorkspaceId,
      )
      if (control.storageRetiredGenerations.length > 0) {
        const nowEpochSeconds = Math.floor(this.clock().getTime() / 1_000)
        if (control.storageRetiredGenerations.every((retired) =>
          retired.expiresAt <= nowEpochSeconds
        )) {
          await this.rearmExpiredRetiredGenerations(
            normalizedWorkspaceId,
            control,
            nowEpochSeconds + ENTERPRISE_GENERATION_RETIREMENT_GRACE_SECONDS,
          )
          const cleared = await this.clearRetiredGenerations(
            normalizedWorkspaceId,
            control,
          )
          return {
            status: cleared ? 'retirement-expired' as const : 'conflict' as const,
          }
        }
        await this.expireRetiredGenerations(normalizedWorkspaceId, control)
        const cleared = await this.clearRetiredGenerations(
          normalizedWorkspaceId,
          control,
        )
        return { status: cleared ? 'retired' as const : 'conflict' as const }
      }
      if (
        control.storageGenerationChain.length <
          ENTERPRISE_GENERATION_COMPACTION_THRESHOLD
      ) {
        return { status: 'idle' as const }
      }
      return await this.compactWorkspace(normalizedWorkspaceId, control)
    } catch (error) {
      if (error instanceof EnterpriseIdentityError) throw error
      throw toEnterprisePersistenceError(error)
    }
  }

  /** CONTROL を強整合読みします。 */
  private async loadControl(workspaceId: string) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        scopeKey: `WORKSPACE#${workspaceId}`,
        recordKey: 'CONTROL',
      },
      ConsistentRead: true,
    }))
    return response.Item
  }

  /**
   * Grace 後の partial/missing partition を manifest 非依存で再度 TTL 対象にします。
   *
   * DynamoDB TTL が marker や一部 record を既に削除していても、残存 item に新しい
   * expiry を付けてから CONTROL の retired list を clear するため orphan を残しません。
   */
  private async rearmExpiredRetiredGenerations(
    workspaceId: string,
    control: ReturnType<typeof readEnterpriseIdentityControl>,
    expiresAt: number,
  ) {
    const partitions = await Promise.all(
      control.storageRetiredGenerations.map((retired) =>
        loadEnterpriseGenerationPartition(
          this.documentClient,
          this.tableName,
          workspaceId,
          retired.stateGeneration,
        )
      ),
    )
    for (const partition of partitions) {
      await batchWriteEnterpriseItems(
        this.documentClient,
        this.tableName,
        partition.map((item) => ({
          PutRequest: {
            Item: { ...item, expiresAt },
          },
        })),
        5,
      )
    }
  }

  /** Active chain を sealed snapshot にまとめて CONTROL head を CAS します。 */
  private async compactWorkspace(
    workspaceId: string,
    control: ReturnType<typeof readEnterpriseIdentityControl>,
  ) {
    const partitions = await Promise.all(
      control.storageGenerationChain.map((stateGeneration) =>
        loadEnterpriseGenerationPartition(
          this.documentClient,
          this.tableName,
          workspaceId,
          stateGeneration,
        )
      ),
    )
    const generations = partitions.map((items, index) =>
      validateEnterpriseGeneration(
        items,
        workspaceId,
        control.storageGenerationChain[index]!,
        control.storageRevision - index,
      )
    )
    validateEnterpriseGenerationChain(control, generations)
    const committed = materializeEnterpriseIdentityRecords(control, generations)
    const compactedAt = this.clock()
    const stateGeneration = crypto.randomUUID()
    const generationScopeKey = enterpriseGenerationScopeKey(
      workspaceId,
      stateGeneration,
    )
    const generationItems = committed.items.filter((item) =>
      !isExpiredEnterpriseIdentityRecord(item, compactedAt)
    ).map((item) => ({
      scopeKey: generationScopeKey,
      recordKey: enterpriseDeltaRecordKey(item.logicalRecordKey as string),
      entryType: 'enterprise-identity-record',
      workspaceId,
      stateGeneration,
      logicalRecordKey: item.logicalRecordKey,
      recordType: item.recordType,
      entityKey: item.entityKey,
      payload: item.payload,
      contentHash: item.contentHash,
      ...(item.logicalExpiresAt === undefined
        ? {}
        : { logicalExpiresAt: item.logicalExpiresAt }),
    }))
    const stagedItems = [
      {
        scopeKey: generationScopeKey,
        recordKey: enterpriseGenerationRecordKey(),
        entryType: 'enterprise-identity-generation',
        workspaceId,
        stateGeneration,
        generationKind: 'snapshot',
        generationRevision: control.storageRevision,
        deltaCount: generationItems.length,
        manifestHash: fingerprintEnterpriseGenerationManifest(generationItems),
      },
      ...generationItems,
    ]
    await this.stageEnterpriseGeneration(stagedItems)
    const expiresAt = Math.floor(compactedAt.getTime() / 1_000) +
      ENTERPRISE_GENERATION_RETIREMENT_GRACE_SECONDS
    const retiredStateGenerations = control.storageGenerationChain.map(
      (retiredGeneration, index) => ({
        stateGeneration: retiredGeneration,
        generationRevision: control.storageRevision - index,
        expiresAt,
      }),
    )
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          scopeKey: `WORKSPACE#${workspaceId}`,
          recordKey: 'CONTROL',
          entryType: 'enterprise-identity-control',
          workspaceId,
          controlRevision: control.storageRevision,
          activeStateGeneration: stateGeneration,
          activeStateGenerations: [stateGeneration],
          retiredStateGenerations,
          maintenanceRequired: true,
        },
        ConditionExpression:
          'controlRevision = :expectedRevision AND activeStateGeneration = :expectedGeneration AND (attribute_not_exists(retiredStateGenerations) OR retiredStateGenerations = :emptyRetired)',
        ExpressionAttributeValues: {
          ':expectedRevision': control.storageRevision,
          ':expectedGeneration': control.storageGeneration,
          ':emptyRetired': [],
        },
      }))
    } catch (error) {
      if (isConditionalWriteError(error)) {
        await this.cleanupEnterpriseGeneration(stagedItems)
        return { status: 'conflict' as const }
      }
      await this.cleanupEnterpriseGeneration(stagedItems)
      throw error
    }
    const compactedControl = {
      storageRevision: control.storageRevision,
      storageGeneration: stateGeneration,
      storageGenerationChain: [stateGeneration],
      storageRetiredGenerations: retiredStateGenerations,
    }
    await this.expireRetiredGenerations(workspaceId, compactedControl)
    await this.clearRetiredGenerations(workspaceId, compactedControl)
    return { status: 'compacted' as const }
  }

  /** 旧 generation を検証して grace 付き DynamoDB TTL を全 item に付与します。 */
  private async expireRetiredGenerations(
    workspaceId: string,
    control: ReturnType<typeof readEnterpriseIdentityControl>,
  ) {
    const partitions = await Promise.all(
      control.storageRetiredGenerations.map((retired) =>
        loadEnterpriseGenerationPartition(
          this.documentClient,
          this.tableName,
          workspaceId,
          retired.stateGeneration,
        )
      ),
    )
    const generations = partitions.map((items, index) => {
      const retired = control.storageRetiredGenerations[index]!
      return validateEnterpriseGeneration(
        items,
        workspaceId,
        retired.stateGeneration,
        retired.generationRevision,
        true,
      )
    })
    validateEnterpriseGenerationChain({
      storageRevision: control.storageRetiredGenerations[0]!.generationRevision,
      storageGeneration: control.storageRetiredGenerations[0]!.stateGeneration,
      storageGenerationChain: control.storageRetiredGenerations.map(
        (retired) => retired.stateGeneration,
      ),
      storageRetiredGenerations: [],
    }, generations)
    for (let index = 0; index < partitions.length; index += 1) {
      const expiresAt = control.storageRetiredGenerations[index]!.expiresAt
      const pending = partitions[index]!.filter((item) =>
        item.expiresAt !== expiresAt
      ).map((item) => ({ ...item, expiresAt }))
      await batchWriteEnterpriseItems(
        this.documentClient,
        this.tableName,
        pending.map((item) => ({ PutRequest: { Item: item } })),
        5,
      )
    }
  }

  /** Retired list が変わっていない場合だけ CONTROL から削除します。 */
  private async clearRetiredGenerations(
    workspaceId: string,
    control: ReturnType<typeof readEnterpriseIdentityControl>,
  ) {
    try {
      await this.documentClient.send(new UpdateCommand({
        TableName: this.tableName,
        Key: {
          scopeKey: `WORKSPACE#${workspaceId}`,
          recordKey: 'CONTROL',
        },
        UpdateExpression:
          'SET retiredStateGenerations = :emptyRetired, maintenanceRequired = :nextMaintenanceRequired',
        ConditionExpression:
          'controlRevision = :expectedRevision AND activeStateGeneration = :expectedGeneration AND retiredStateGenerations = :expectedRetired',
        ExpressionAttributeValues: {
          ':emptyRetired': [],
          ':nextMaintenanceRequired':
            control.storageGenerationChain.length >=
              ENTERPRISE_GENERATION_COMPACTION_THRESHOLD,
          ':expectedRevision': control.storageRevision,
          ':expectedGeneration': control.storageGeneration,
          ':expectedRetired': control.storageRetiredGenerations,
        },
      }))
      return true
    } catch (error) {
      if (isConditionalWriteError(error)) return false
      throw error
    }
  }

  /** Compaction snapshot を全件 staging し partial failure を不可視のまま掃除します。 */
  private async stageEnterpriseGeneration(items: Record<string, unknown>[]) {
    try {
      await batchWriteEnterpriseItems(
        this.documentClient,
        this.tableName,
        items.map((item) => ({ PutRequest: { Item: item } })),
        5,
      )
    } catch (error) {
      await this.cleanupEnterpriseGeneration(items)
      throw error
    }
  }

  /** CAS loser または partial staging の既知 key を best-effort で削除します。 */
  private async cleanupEnterpriseGeneration(items: Record<string, unknown>[]) {
    try {
      await batchWriteEnterpriseItems(
        this.documentClient,
        this.tableName,
        items.map((item) => ({
          DeleteRequest: {
            Key: {
              scopeKey: item.scopeKey,
              recordKey: item.recordKey,
            },
          },
        })),
        3,
      )
    } catch {
      // Orphaned UUID partitions are invisible unless CONTROL points to them.
    }
  }
}

const ENTERPRISE_READ_ONLY_PLACEHOLDER_SECRET =
  'enterprise-read-only-client-has-no-credential-secret'

/**
 * DynamoDB-backed の secretless enterprise identity reader です。
 *
 * Realtime など credential の発行・認証を行わない runtime が、credential HMAC secret を
 * environment に受け取らず current policy と break-glass state だけを参照するために使います。
 */
export class DynamoDbEnterpriseIdentityReadClient implements EnterpriseIdentityReadClient {
  /** Secretless reader の公開面だけを委譲する persistence client です。 */
  private readonly delegate: DynamoDbEnterpriseIdentityClient

  /**
   * DynamoDB-backed enterprise identity reader を作成します。
   */
  constructor(
    tableName: string,
    documentClient = createEnterpriseDocumentClient(),
    clock: () => Date = () => new Date(),
  ) {
    this.delegate = new DynamoDbEnterpriseIdentityClient(
      tableName,
      ENTERPRISE_READ_ONLY_PLACEHOLDER_SECRET,
      documentClient,
      undefined,
      clock,
    )
  }

  /** Workspace の enterprise identity/security snapshot を返します。 */
  async getSnapshot(workspaceId: string) {
    return this.delegate.getSnapshot(workspaceId)
  }

  /** Member の current authentication session に対する有効な activation を返します。 */
  async getActiveBreakGlassActivation(
    workspaceId: string,
    memberKey: string,
    authenticationSessionId: string,
  ) {
    return this.delegate.getActiveBreakGlassActivation(
      workspaceId,
      memberKey,
      authenticationSessionId,
    )
  }
}

/**
 * Environment configuration から production enterprise identity client を作成します。
 */
export function createEnterpriseIdentityClient() {
  const tableName = process.env.ENTERPRISE_IDENTITY_TABLE_NAME?.trim()
  const secret = process.env.ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET?.trim()
  if (!tableName) return new InMemoryEnterpriseIdentityClient()
  if (!secret) {
    throw new EnterpriseIdentityError(
      503,
      'EnterpriseIdentitySecretMissing',
      'ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET is required.',
    )
  }
  return new DynamoDbEnterpriseIdentityClient(tableName, secret)
}

function createEnterpriseDocumentClient() {
  const endpoint = process.env.DYNAMODB_ENDPOINT ??
    process.env.AWS_ENDPOINT_URL_DYNAMODB ??
    process.env.AWS_ENDPOINT_URL
  return DynamoDBDocumentClient.from(new DynamoDBClient({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'ap-northeast-1',
    ...(endpoint ? { endpoint } : {}),
  }), {
    marshallOptions: { removeUndefinedValues: true },
  })
}

function enqueueEnterpriseScimGroupJob(
  state: EnterpriseIdentityState,
  group: EnterpriseScimGroup,
  previousMemberUserIds: readonly string[],
  updatedAt: string,
) {
  const jobId = stableId(
    'scim-group-job',
    state.workspaceId,
    group.groupId,
  )
  const existingJob = state.scimGroupJobs.find((candidate) =>
    candidate.jobId === jobId
  )
  const targetUserIds = [...new Set([
    ...(existingJob?.targetUserIds.slice(existingJob.cursor) ?? []),
    ...previousMemberUserIds,
    ...group.memberUserIds,
  ])].sort()
  if (targetUserIds.length > ENTERPRISE_SCIM_GROUP_JOB_TARGET_LIMIT) {
    throw new EnterpriseIdentityError(
      429,
      'EnterpriseScimGroupJobBacklogExceeded',
      `A pending SCIM group reconciliation can retain at most ${
        ENTERPRISE_SCIM_GROUP_JOB_TARGET_LIMIT
      } affected users. Retry after the current job progresses.`,
      true,
    )
  }
  const job = {
    workspaceId: state.workspaceId,
    jobId,
    groupId: group.groupId,
    groupVersion: group.version,
    targetUserIds,
    phase: 'apply',
    cursor: 0,
    revision: state.storageRevision + 1,
    createdAt: existingJob?.createdAt ?? updatedAt,
    updatedAt,
  } satisfies EnterpriseScimGroupJob
  upsertBy(state.scimGroupJobs, job, (candidate) => candidate.jobId === jobId)
}

function enqueueEnterpriseScimGroupJobsForMappingChanges(
  state: EnterpriseIdentityState,
  mappings: ReadonlyArray<EnterpriseDirectoryGroupMapping | undefined>,
  updatedAt: string,
) {
  const affectedMappings = mappings.filter((
    mapping,
  ): mapping is EnterpriseDirectoryGroupMapping =>
    mapping !== undefined &&
    mapping.enabled &&
    mapping.scope.kind === 'workspace' &&
    mapping.roleId === 'workspace:guest'
  )
  if (affectedMappings.length === 0) return
  const affectedGroups = new Map<string, EnterpriseScimGroup>()
  for (const mapping of affectedMappings) {
    const groupIdMatch = state.scimGroups.find((group) =>
      group.identityProviderId === mapping.identityProviderId &&
      group.groupId === mapping.directoryGroupId
    )
    if (groupIdMatch) affectedGroups.set(groupIdMatch.groupId, groupIdMatch)
    const externalIdMatches = state.scimGroups.filter((group) =>
      group.identityProviderId === mapping.identityProviderId &&
      group.externalId === mapping.directoryGroupId
    )
    if (externalIdMatches.length > 1) throw invalidEnterpriseIdentityState()
    const externalIdMatch = externalIdMatches[0]
    if (externalIdMatch) {
      affectedGroups.set(externalIdMatch.groupId, externalIdMatch)
    }
  }
  for (const group of affectedGroups.values()) {
    const existingJob = state.scimGroupJobs.find((job) =>
      job.groupId === group.groupId
    )
    if (!existingJob && !group.active) {
      continue
    }
    enqueueEnterpriseScimGroupJob(
      state,
      group,
      existingJob?.targetUserIds ?? group.memberUserIds,
      updatedAt,
    )
    const enqueuedJob = state.scimGroupJobs.find((job) =>
      job.groupId === group.groupId
    )
    if (!enqueuedJob) throw invalidEnterpriseIdentityState()
    enqueuedJob.phase = group.appliedVersion >= group.version ? 'settle' : 'apply'
  }
}

function validateEnterpriseScimGroupJobReference(
  reference: EnterpriseScimGroupJobReference,
) {
  const workspaceId = requireText(reference.workspaceId, 'Workspace ID')
  const jobId = requireText(reference.jobId, 'SCIM group job ID')
  if (!Number.isSafeInteger(reference.revision) || reference.revision < 1) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimGroupJobReferenceInvalid',
      'SCIM group job revision must be a positive safe integer.',
    )
  }
  return {
    workspaceId,
    jobId,
    revision: reference.revision,
  } satisfies EnterpriseScimGroupJobReference
}

function toEnterpriseScimGroupJobReference(
  job: EnterpriseScimGroupJob,
): EnterpriseScimGroupJobReference {
  return {
    workspaceId: job.workspaceId,
    jobId: job.jobId,
    revision: job.revision,
  }
}

function isEnterpriseScimGroupJob(
  value: unknown,
  workspaceId: string,
): value is EnterpriseScimGroupJob {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('workspaceId' in value) ||
    value.workspaceId !== workspaceId ||
    !('jobId' in value) ||
    typeof value.jobId !== 'string' ||
    value.jobId.length === 0 ||
    !('groupId' in value) ||
    typeof value.groupId !== 'string' ||
    value.groupId.length === 0 ||
    value.jobId !== stableId(
      'scim-group-job',
      workspaceId,
      value.groupId,
    ) ||
    !('groupVersion' in value) ||
    !Number.isSafeInteger(value.groupVersion) ||
    Number(value.groupVersion) < 1 ||
    !('targetUserIds' in value) ||
    !Array.isArray(value.targetUserIds) ||
    value.targetUserIds.length > ENTERPRISE_SCIM_GROUP_JOB_TARGET_LIMIT ||
    value.targetUserIds.some((userId) =>
      typeof userId !== 'string' || userId.length === 0
    ) ||
    new Set(value.targetUserIds).size !== value.targetUserIds.length ||
    !('phase' in value) ||
    value.phase !== 'apply' && value.phase !== 'settle' ||
    !('cursor' in value) ||
    !Number.isSafeInteger(value.cursor) ||
    Number(value.cursor) < 0 ||
    Number(value.cursor) > value.targetUserIds.length ||
    !('revision' in value) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !('createdAt' in value) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !('updatedAt' in value) ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    return false
  }
  return true
}

function createEmptyState(workspaceId: string): EnterpriseIdentityState {
  return {
    workspaceId,
    storageRevision: 0,
    storageGenerationChain: [],
    storageRetiredGenerations: [],
    policy: undefined,
    identityProviders: [],
    domains: [],
    customRoles: [],
    groupMappings: [],
    roleAssignments: [],
    scimUsers: [],
    scimGroups: [],
    scimCredentials: [],
    serviceAccounts: [],
    breakGlassAccounts: [],
    provisioningRuns: [],
    provisioningLogs: [],
    serviceCredentials: [],
    scimCredentialDigests: [],
    scimGroupJobs: [],
    breakGlassActivations: [],
    provisioningPreviews: [],
    idempotencyResults: {},
    idempotencyFingerprints: {},
    idempotencyExpiresAt: {},
  }
}

function toPublicSnapshot(state: EnterpriseIdentityState): EnterpriseIdentitySnapshot {
  const {
    storageRevision: _storageRevision,
    storageGeneration: _storageGeneration,
    storageGenerationChain: _storageGenerationChain,
    storageRetiredGenerations: _storageRetiredGenerations,
    serviceCredentials: _serviceCredentials,
    scimCredentialDigests: _scimCredentialDigests,
    scimGroupJobs: _scimGroupJobs,
    breakGlassActivations: _breakGlassActivations,
    provisioningPreviews: _provisioningPreviews,
    idempotencyResults: _idempotencyResults,
    idempotencyFingerprints: _idempotencyFingerprints,
    idempotencyExpiresAt: _idempotencyExpiresAt,
    ...snapshot
  } = structuredClone(state)
  return {
    ...snapshot,
    controlRevision: state.storageRevision,
  }
}

function getEnterpriseDomainClaimChanges(
  expectedState: EnterpriseIdentityState,
  nextState: EnterpriseIdentityState,
) {
  const expectedDomains = new Set(expectedState.domains.map((domain) => domain.domain))
  const nextDomains = new Set(nextState.domains.map((domain) => domain.domain))
  return {
    claimed: [...nextDomains].filter((domain) => !expectedDomains.has(domain)),
    released: [...expectedDomains].filter((domain) => !nextDomains.has(domain)),
  }
}

/** Direct SCIM projection の resource 種別です。 */
type EnterpriseScimProjectionResourceKind = 'user' | 'group'

/** Direct SCIM projection が保持する resource です。 */
type EnterpriseScimProjectionResource = EnterpriseScimUser | EnterpriseScimGroup

/** Direct SCIM projection の equality filter です。 */
type EnterpriseScimProjectionFilter =
  | EnterpriseScimUserListFilter
  | EnterpriseScimGroupListFilter

/**
 * Direct SCIM projection に投入する source resource です。
 */
type EnterpriseScimProjectionSource = {
  /** User または Group の discriminator です。 */
  resourceKind: EnterpriseScimProjectionResourceKind
  /** Projection に保存する complete SCIM resource です。 */
  resource: EnterpriseScimProjectionResource
}

/**
 * SCIM collection または equality lookup partition の descriptor です。
 */
type EnterpriseScimProjectionScope = {
  /** User または Group の discriminator です。 */
  resourceKind: EnterpriseScimProjectionResourceKind
  /** Partition を所有する identity provider ID です。 */
  identityProviderId: string
  /** Lookup partition だけに設定する equality filter です。 */
  filter?: EnterpriseScimProjectionFilter
}

/** DynamoDB transaction に投入する一つの operation です。 */
type EnterpriseTransactWriteItem =
  NonNullable<TransactWriteCommandInput['TransactItems']>[number]

function validateEnterpriseScimResourceLimits(
  limits: EnterpriseScimResourceLimits,
) {
  if (
    !Number.isSafeInteger(limits.maximumUsers) ||
    limits.maximumUsers < 1 ||
    !Number.isSafeInteger(limits.maximumGroups) ||
    limits.maximumGroups < 1
  ) {
    throw new EnterpriseIdentityError(
      503,
      'EnterpriseScimResourceLimitsInvalid',
      'SCIM resource limits must be positive integers.',
    )
  }
  return { ...limits }
}

function validateEnterpriseScimListInput<
  Input extends EnterpriseScimUserListInput | EnterpriseScimGroupListInput,
>(
  input: Input,
  allowedFields: readonly EnterpriseScimProjectionFilter['field'][],
  maximumCount = 200,
) {
  const workspaceId = requireText(input.workspaceId, 'Workspace ID')
  const identityProviderId = requireText(
    input.identityProviderId,
    'Identity provider ID',
  )
  if (
    !Number.isSafeInteger(input.startIndex) ||
    input.startIndex < 1 ||
    !Number.isSafeInteger(input.count) ||
    input.count < 0 ||
    input.count > maximumCount
  ) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimPaginationInvalid',
      `SCIM startIndex must be positive and count must be between 0 and ${
        maximumCount
      }.`,
    )
  }
  if (
    input.filter &&
    (
      typeof input.filter.field !== 'string' ||
      typeof input.filter.value !== 'string' ||
      input.filter.value.length === 0
    )
  ) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimFilterInvalid',
      'SCIM equality filter field or value is invalid.',
    )
  }
  const canonicalFilterField = input.filter
    ? allowedFields.find((field) =>
      field.toLowerCase() === input.filter!.field.toLowerCase()
    )
    : undefined
  if (input.filter && !canonicalFilterField) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimFilterInvalid',
      'SCIM equality filter field or value is invalid.',
    )
  }
  return {
    ...input,
    workspaceId,
    identityProviderId,
    ...(input.filter && canonicalFilterField
      ? {
          filter: {
            field: canonicalFilterField,
            value: normalizeEnterpriseScimFilterValue(
              canonicalFilterField,
              input.filter.value,
            ),
          },
        }
      : {}),
  } as Input
}

function createEnterpriseScimPage<
  Resource extends EnterpriseScimProjectionResource,
>(
  resources: readonly Resource[],
  input: EnterpriseScimUserListInput | EnterpriseScimGroupListInput,
  readFilterValue: (
    resource: Resource,
    field: EnterpriseScimProjectionFilter['field'],
  ) => string,
  readResourceId: (resource: Resource) => string,
) {
  const filtered = resources
    .filter((resource) =>
      resource.identityProviderId === input.identityProviderId &&
      (
        !input.filter ||
        normalizeEnterpriseScimFilterValue(
          input.filter.field,
          readFilterValue(resource, input.filter.field),
        ) === input.filter.value
      )
    )
    .sort((left, right) =>
      readResourceId(left).localeCompare(readResourceId(right))
    )
  return {
    totalResults: filtered.length,
    startIndex: input.startIndex,
    resources: structuredClone(
      filtered.slice(
        input.startIndex - 1,
        input.startIndex - 1 + input.count,
      ),
    ),
  }
}

function enterpriseScimCollectionScopeKey(
  workspaceId: string,
  identityProviderId: string,
  resourceKind: EnterpriseScimProjectionResourceKind,
) {
  return `SCIM_COLLECTION#${
    stableId('scim-collection', workspaceId, identityProviderId, resourceKind)
  }`
}

function enterpriseScimLookupScopeKey(
  workspaceId: string,
  identityProviderId: string,
  resourceKind: EnterpriseScimProjectionResourceKind,
  field: EnterpriseScimProjectionFilter['field'],
  value: string,
) {
  return `SCIM_LOOKUP#${
    stableId(
      'scim-lookup',
      workspaceId,
      identityProviderId,
      resourceKind,
      field,
      value,
    )
  }`
}

function normalizeEnterpriseScimFilterValue(
  field: EnterpriseScimProjectionFilter['field'],
  value: string,
) {
  return field === 'externalId'
    ? value
    : value.normalize('NFC').toLowerCase()
}

function enterpriseScimProjectionResourceRecordPrefix() {
  return 'RESOURCE#'
}

function enterpriseScimProjectionResourceRecordKey(resourceId: string) {
  return `${enterpriseScimProjectionResourceRecordPrefix()}${resourceId}`
}

function enterpriseScimProjectionMetaRecordKey() {
  return 'META'
}

function createEnterpriseScimProjectionSources(
  state: EnterpriseIdentityState,
) {
  const sources = new Map<string, EnterpriseScimProjectionSource>()
  for (const resource of state.scimUsers) {
    sources.set(`user\0${resource.userId}`, {
      resourceKind: 'user',
      resource,
    })
  }
  for (const resource of state.scimGroups) {
    sources.set(`group\0${resource.groupId}`, {
      resourceKind: 'group',
      resource,
    })
  }
  return sources
}

function readEnterpriseScimProjectionResourceId(
  source: EnterpriseScimProjectionSource,
) {
  return source.resourceKind === 'user'
    ? (source.resource as EnterpriseScimUser).userId
    : (source.resource as EnterpriseScimGroup).groupId
}

function readEnterpriseScimProjectionLookupValues(
  source: EnterpriseScimProjectionSource,
) {
  if (source.resourceKind === 'user') {
    const user = source.resource as EnterpriseScimUser
    return [
      ['externalId', user.externalId],
      ['userName', user.userName],
      ...(user.displayName ? [['displayName', user.displayName]] : []),
    ] as Array<[EnterpriseScimUserListFilter['field'], string]>
  }
  const group = source.resource as EnterpriseScimGroup
  return [
    ['externalId', group.externalId],
    ['displayName', group.displayName],
  ] as Array<[EnterpriseScimGroupListFilter['field'], string]>
}

function createEnterpriseScimProjectionEntries(
  source: EnterpriseScimProjectionSource,
) {
  const workspaceId = source.resource.workspaceId
  const identityProviderId = source.resource.identityProviderId
  const resourceId = readEnterpriseScimProjectionResourceId(source)
  const recordKey = enterpriseScimProjectionResourceRecordKey(resourceId)
  const collectionScope: EnterpriseScimProjectionScope = {
    resourceKind: source.resourceKind,
    identityProviderId,
  }
  const entries: Array<[Record<string, unknown>, EnterpriseScimProjectionScope]> = [[{
    scopeKey: enterpriseScimCollectionScopeKey(
      workspaceId,
      identityProviderId,
      source.resourceKind,
    ),
    recordKey,
    entryType: 'enterprise-scim-resource',
    workspaceId,
    identityProviderId,
    resourceKind: source.resourceKind,
    resourceId,
    resource: structuredClone(source.resource),
  }, collectionScope]]
  for (const [field, value] of readEnterpriseScimProjectionLookupValues(source)) {
    const normalizedValue = normalizeEnterpriseScimFilterValue(field, value)
    const filter = { field, value: normalizedValue }
    entries.push([{
      scopeKey: enterpriseScimLookupScopeKey(
        workspaceId,
        identityProviderId,
        source.resourceKind,
        field,
        normalizedValue,
      ),
      recordKey,
      entryType: 'enterprise-scim-lookup',
      workspaceId,
      identityProviderId,
      resourceKind: source.resourceKind,
      resourceId,
      filterField: field,
      filterValue: normalizedValue,
      resource: structuredClone(source.resource),
    }, {
      resourceKind: source.resourceKind,
      identityProviderId,
      filter,
    }])
  }
  return entries
}

function enterpriseScimProjectionPhysicalKey(item: Record<string, unknown>) {
  return `${String(item.scopeKey)}\0${String(item.recordKey)}`
}

function countEnterpriseScimProjectionScope(
  state: EnterpriseIdentityState,
  scope: EnterpriseScimProjectionScope,
) {
  const resources = scope.resourceKind === 'user'
    ? state.scimUsers
    : state.scimGroups
  return resources.filter((resource) =>
    resource.identityProviderId === scope.identityProviderId &&
    (
      !scope.filter ||
      normalizeEnterpriseScimFilterValue(
        scope.filter.field,
        readEnterpriseScimProjectionFilterValue(
          resource,
          scope.filter.field,
        ),
      ) === scope.filter.value
    )
  ).length
}

function readEnterpriseScimProjectionFilterValue(
  resource: EnterpriseScimProjectionResource,
  field: EnterpriseScimProjectionFilter['field'],
) {
  if (field === 'externalId') return resource.externalId
  if (field === 'userName') {
    return 'userName' in resource ? resource.userName : ''
  }
  return resource.displayName ?? ''
}

function createEnterpriseScimProjectionMetaItem(
  workspaceId: string,
  scopeKey: string,
  scope: EnterpriseScimProjectionScope,
  totalResults: number,
) {
  return {
    scopeKey,
    recordKey: enterpriseScimProjectionMetaRecordKey(),
    entryType: 'enterprise-scim-projection-meta',
    workspaceId,
    identityProviderId: scope.identityProviderId,
    resourceKind: scope.resourceKind,
    totalResults,
    ...(scope.filter
      ? {
          filterField: scope.filter.field,
          filterValue: scope.filter.value,
        }
      : {}),
  }
}

function createEnterpriseScimResourceProjectionWrites(
  tableName: string,
  expectedState: EnterpriseIdentityState,
  nextState: EnterpriseIdentityState,
) {
  const expectedSources = createEnterpriseScimProjectionSources(expectedState)
  const nextSources = createEnterpriseScimProjectionSources(nextState)
  const sourceKeys = new Set([...expectedSources.keys(), ...nextSources.keys()])
  const operations = new Map<string, EnterpriseTransactWriteItem>()
  const affectedScopes = new Map<string, EnterpriseScimProjectionScope>()
  for (const sourceKey of sourceKeys) {
    const expected = expectedSources.get(sourceKey)
    const next = nextSources.get(sourceKey)
    if (
      expected &&
      next &&
      fingerprintScimRequest(expected.resource) ===
        fingerprintScimRequest(next.resource)
    ) {
      continue
    }
    const expectedEntries = new Map(
      (expected ? createEnterpriseScimProjectionEntries(expected) : [])
        .map(([item, scope]) => {
          affectedScopes.set(String(item.scopeKey), scope)
          return [enterpriseScimProjectionPhysicalKey(item), item]
        }),
    )
    const nextEntries = new Map(
      (next ? createEnterpriseScimProjectionEntries(next) : [])
        .map(([item, scope]) => {
          affectedScopes.set(String(item.scopeKey), scope)
          return [enterpriseScimProjectionPhysicalKey(item), item]
        }),
    )
    for (const physicalKey of new Set([
      ...expectedEntries.keys(),
      ...nextEntries.keys(),
    ])) {
      const expectedItem = expectedEntries.get(physicalKey)
      const nextItem = nextEntries.get(physicalKey)
      if (!nextItem) {
        operations.set(physicalKey, {
          Delete: {
            TableName: tableName,
            Key: {
              scopeKey: expectedItem?.scopeKey,
              recordKey: expectedItem?.recordKey,
            },
          },
        })
      } else if (
        !expectedItem ||
        fingerprintScimRequest(expectedItem) !==
          fingerprintScimRequest(nextItem)
      ) {
        operations.set(physicalKey, {
          Put: {
            TableName: tableName,
            Item: nextItem,
          },
        })
      }
    }
  }
  for (const [scopeKey, scope] of affectedScopes) {
    const totalResults = countEnterpriseScimProjectionScope(nextState, scope)
    const metaItem = createEnterpriseScimProjectionMetaItem(
      nextState.workspaceId,
      scopeKey,
      scope,
      totalResults,
    )
    operations.set(
      enterpriseScimProjectionPhysicalKey(metaItem),
      totalResults === 0
        ? {
            Delete: {
              TableName: tableName,
              Key: {
                scopeKey: metaItem.scopeKey,
                recordKey: metaItem.recordKey,
              },
            },
          }
        : {
            Put: {
              TableName: tableName,
              Item: metaItem,
            },
          },
    )
  }
  return [...operations.values()]
}

function enterpriseScimAuthenticationScopeKey(workspaceId: string) {
  return `SCIM_AUTH#${stableId('scim-auth', workspaceId)}`
}

function enterpriseScimAuthenticationProviderRecordKey(
  identityProviderId: string,
) {
  return `PROVIDER#${
    stableId('scim-auth-provider', identityProviderId)
  }`
}

function enterpriseScimAuthenticationCredentialRecordPrefix() {
  return 'CREDENTIAL#'
}

function enterpriseScimAuthenticationCredentialRecordKey(
  credentialId: string,
) {
  return `${
    enterpriseScimAuthenticationCredentialRecordPrefix()
  }${credentialId}`
}

function createEnterpriseScimAuthenticationProjectionItems(
  state: EnterpriseIdentityState,
) {
  const items = new Map<string, Record<string, unknown>>()
  const scopeKey = enterpriseScimAuthenticationScopeKey(state.workspaceId)
  for (const provider of state.identityProviders) {
    const item = {
      scopeKey,
      recordKey: enterpriseScimAuthenticationProviderRecordKey(
        provider.providerId,
      ),
      entryType: 'enterprise-scim-auth-provider',
      workspaceId: state.workspaceId,
      identityProviderId: provider.providerId,
      provider: structuredClone(provider),
    }
    items.set(enterpriseScimProjectionPhysicalKey(item), item)
  }
  for (const storedDigest of state.scimCredentialDigests) {
    const credential = state.scimCredentials.find((candidate) =>
      candidate.credentialId === storedDigest.credentialId
    )
    if (!credential) throw invalidEnterpriseIdentityState()
    const item = {
      scopeKey,
      recordKey: enterpriseScimAuthenticationCredentialRecordKey(
        credential.credentialId,
      ),
      entryType: 'enterprise-scim-auth-credential',
      workspaceId: state.workspaceId,
      identityProviderId: credential.identityProviderId,
      credentialId: credential.credentialId,
      digest: storedDigest.digest,
      credential: structuredClone(credential),
    }
    items.set(enterpriseScimProjectionPhysicalKey(item), item)
  }
  return items
}

function createEnterpriseScimAuthenticationProjectionWrites(
  tableName: string,
  expectedState: EnterpriseIdentityState,
  nextState: EnterpriseIdentityState,
) {
  const expectedItems =
    createEnterpriseScimAuthenticationProjectionItems(expectedState)
  const nextItems = createEnterpriseScimAuthenticationProjectionItems(nextState)
  const writes: EnterpriseTransactWriteItem[] = []
  for (const physicalKey of new Set([
    ...expectedItems.keys(),
    ...nextItems.keys(),
  ])) {
    const expectedItem = expectedItems.get(physicalKey)
    const nextItem = nextItems.get(physicalKey)
    if (!nextItem) {
      writes.push({
        Delete: {
          TableName: tableName,
          Key: {
            scopeKey: expectedItem?.scopeKey,
            recordKey: expectedItem?.recordKey,
          },
        },
      })
    } else if (
      !expectedItem ||
      fingerprintScimRequest(expectedItem) !== fingerprintScimRequest(nextItem)
    ) {
      writes.push({
        Put: {
          TableName: tableName,
          Item: nextItem,
        },
      })
    }
  }
  return writes
}

function createEnterpriseScimGroupJobProjectionItems(
  state: EnterpriseIdentityState,
) {
  return new Map(state.scimGroupJobs.map((job) => [
    job.jobId,
    {
      scopeKey: `WORKSPACE#${state.workspaceId}`,
      recordKey: `SCIM_GROUP_JOB#${job.jobId}`,
      entryType: 'enterprise-scim-group-job',
      workspaceId: state.workspaceId,
      jobId: job.jobId,
      revision: job.revision,
    },
  ]))
}

function createEnterpriseScimGroupJobProjectionWrites(
  tableName: string,
  expectedState: EnterpriseIdentityState,
  nextState: EnterpriseIdentityState,
) {
  const expectedItems = createEnterpriseScimGroupJobProjectionItems(expectedState)
  const nextItems = createEnterpriseScimGroupJobProjectionItems(nextState)
  const writes: EnterpriseTransactWriteItem[] = []
  for (const jobId of new Set([
    ...expectedItems.keys(),
    ...nextItems.keys(),
  ])) {
    const expectedItem = expectedItems.get(jobId)
    const nextItem = nextItems.get(jobId)
    if (!nextItem) {
      writes.push({
        Delete: {
          TableName: tableName,
          Key: {
            scopeKey: expectedItem?.scopeKey,
            recordKey: expectedItem?.recordKey,
          },
        },
      })
    } else if (
      !expectedItem ||
      expectedItem.revision !== nextItem.revision
    ) {
      writes.push({
        Put: {
          TableName: tableName,
          Item: nextItem,
        },
      })
    }
  }
  return writes
}

function readEnterpriseScimAuthenticationCredential(
  item: Record<string, unknown>,
  workspaceId: string,
): [EnterpriseScimCredential, string] {
  const credential = item.credential
  if (
    item.entryType !== 'enterprise-scim-auth-credential' ||
    item.workspaceId !== workspaceId ||
    typeof item.identityProviderId !== 'string' ||
    typeof item.credentialId !== 'string' ||
    typeof item.digest !== 'string' ||
    typeof credential !== 'object' ||
    credential === null ||
    !('workspaceId' in credential) ||
    credential.workspaceId !== workspaceId ||
    !('identityProviderId' in credential) ||
    credential.identityProviderId !== item.identityProviderId ||
    !('credentialId' in credential) ||
    credential.credentialId !== item.credentialId
  ) {
    throw invalidEnterpriseIdentityState()
  }
  return [
    structuredClone(credential) as EnterpriseScimCredential,
    item.digest,
  ]
}

function readEnterpriseScimAuthenticationProvider(
  item: Record<string, unknown> | undefined,
  workspaceId: string,
  identityProviderId: string,
) {
  const provider = item?.provider
  if (
    item?.entryType !== 'enterprise-scim-auth-provider' ||
    item.workspaceId !== workspaceId ||
    item.identityProviderId !== identityProviderId ||
    typeof provider !== 'object' ||
    provider === null ||
    !('workspaceId' in provider) ||
    provider.workspaceId !== workspaceId ||
    !('providerId' in provider) ||
    provider.providerId !== identityProviderId
  ) {
    throw invalidEnterpriseIdentityState()
  }
  return structuredClone(provider) as EnterpriseIdentityProvider
}

function readEnterpriseScimProjectionTotal(
  item: Record<string, unknown> | undefined,
  workspaceId: string,
  identityProviderId: string,
  resourceKind: EnterpriseScimProjectionResourceKind,
  filter: EnterpriseScimProjectionFilter | undefined,
) {
  if (!item) return 0
  if (
    item.entryType !== 'enterprise-scim-projection-meta' ||
    item.workspaceId !== workspaceId ||
    item.identityProviderId !== identityProviderId ||
    item.resourceKind !== resourceKind ||
    !Number.isSafeInteger(item.totalResults) ||
    Number(item.totalResults) < 0 ||
    (filter
      ? item.filterField !== filter.field || item.filterValue !== filter.value
      : item.filterField !== undefined || item.filterValue !== undefined)
  ) {
    throw invalidEnterpriseIdentityState()
  }
  return Number(item.totalResults)
}

function readEnterpriseScimProjectionResource<
  Resource extends EnterpriseScimProjectionResource,
>(
  item: Record<string, unknown>,
  workspaceId: string,
  identityProviderId: string,
  resourceKind: EnterpriseScimProjectionResourceKind,
  filter: EnterpriseScimProjectionFilter | undefined,
) {
  const resource = item.resource
  if (
    item.entryType !== (
      filter ? 'enterprise-scim-lookup' : 'enterprise-scim-resource'
    ) ||
    item.workspaceId !== workspaceId ||
    item.identityProviderId !== identityProviderId ||
    item.resourceKind !== resourceKind ||
    typeof resource !== 'object' ||
    resource === null ||
    !('workspaceId' in resource) ||
    resource.workspaceId !== workspaceId ||
    !('identityProviderId' in resource) ||
    resource.identityProviderId !== identityProviderId ||
    (filter &&
      (
        item.filterField !== filter.field ||
        item.filterValue !== filter.value ||
        normalizeEnterpriseScimFilterValue(
          filter.field,
          readEnterpriseScimProjectionFilterValue(
            resource as EnterpriseScimProjectionResource,
            filter.field,
          ),
        ) !== filter.value
      ))
  ) {
    throw invalidEnterpriseIdentityState()
  }
  return structuredClone(resource) as Resource
}

/**
 * DynamoDB に保存する一つの enterprise entity record です。
 */
type SerializedEnterpriseIdentityRecord = {
  /** Deserialize 時に payload の格納先を決める record discriminator です。 */
  recordType: string
  /** Audit/debug で参照できる immutable entity key です。 */
  entityKey: string
  /** Raw secret を含まない entity payload です。 */
  payload: unknown
  /** Entity 単位の optimistic condition に使う canonical hash です。 */
  contentHash: string
  /** Ephemeral record の論理 expiry epoch seconds です。 */
  logicalExpiresAt?: number
}

function enterpriseGenerationScopeKey(
  workspaceId: string,
  stateGeneration: string,
) {
  return `WORKSPACE_STATE#${workspaceId}#${stateGeneration}`
}

function enterpriseGenerationRecordKey() {
  return 'GENERATION'
}

function enterpriseDeltaRecordKey(logicalRecordKey: string) {
  return `STATE#${logicalRecordKey}`
}

async function loadEnterpriseGenerationPartition(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  workspaceId: string,
  stateGeneration: string,
) {
  const items: Record<string, unknown>[] = []
  let exclusiveStartKey: Record<string, unknown> | undefined
  do {
    const response = await documentClient.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'scopeKey = :scopeKey',
      ExpressionAttributeValues: {
        ':scopeKey': enterpriseGenerationScopeKey(workspaceId, stateGeneration),
      },
      ConsistentRead: true,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }))
    items.push(...(response.Items ?? []))
    exclusiveStartKey = response.LastEvaluatedKey
  } while (exclusiveStartKey)
  return items
}

async function batchWriteEnterpriseItems(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  requests: NonNullable<BatchWriteCommandInput['RequestItems']>[string],
  maximumAttempts: number,
) {
  for (let offset = 0; offset < requests.length; offset += 25) {
    let pending = requests.slice(offset, offset + 25)
    for (
      let attempt = 0;
      pending.length > 0 && attempt < maximumAttempts;
      attempt += 1
    ) {
      const response = await documentClient.send(new BatchWriteCommand({
        RequestItems: { [tableName]: pending },
      }))
      pending = response.UnprocessedItems?.[tableName] ?? []
    }
    if (pending.length > 0) {
      throw new EnterpriseIdentityError(
        503,
        'EnterpriseIdentityUnavailable',
        'Enterprise identity state is unavailable.',
        true,
      )
    }
  }
}

function serializeEnterpriseIdentityRecords(state: EnterpriseIdentityState) {
  const records = new Map<string, SerializedEnterpriseIdentityRecord>()
  const put = (
    recordType: string,
    entityKey: string,
    payload: unknown,
    expiresAt?: string,
  ) => {
    const recordKey = `${recordType}#${stableId('record', recordType, entityKey)}`
    records.set(recordKey, {
      recordType,
      entityKey,
      payload,
      contentHash: fingerprintScimRequest(payload),
      ...(expiresAt
        ? { logicalExpiresAt: Math.floor(Date.parse(expiresAt) / 1_000) }
        : {}),
    })
  }
  if (state.policy) put('POLICY', 'workspace', state.policy)
  for (const value of state.identityProviders) put('PROVIDER', value.providerId, value)
  for (const value of state.domains) put('DOMAIN', value.domain, value)
  for (const value of state.customRoles) put('CUSTOM_ROLE', value.roleId, value)
  for (const value of state.groupMappings) put('GROUP_MAPPING', value.mappingId, value)
  for (const value of state.roleAssignments) put('ROLE_ASSIGNMENT', value.assignmentId, value)
  for (const value of state.scimUsers) {
    put('SCIM_USER', value.userId, {
      ...value,
      membershipStorageVersion: ENTERPRISE_SCIM_EMBEDDED_MEMBERSHIP_VERSION,
    })
  }
  for (const value of state.scimGroups) {
    put('SCIM_GROUP', value.groupId, {
      ...value,
      membershipStorageVersion: ENTERPRISE_SCIM_EMBEDDED_MEMBERSHIP_VERSION,
    })
  }
  for (const value of state.scimCredentials) {
    put('SCIM_CREDENTIAL', value.credentialId, value)
  }
  for (const value of state.serviceAccounts) put('SERVICE_ACCOUNT', value.accountId, value)
  for (const value of state.breakGlassAccounts) {
    put('BREAK_GLASS_ACCOUNT', value.accountId, value)
  }
  for (const value of state.provisioningRuns) {
    const { changes, ...run } = value
    put('PROVISIONING_RUN', value.runId, { ...run, changes: [] })
    for (const change of changes) {
      put(
        'PROVISIONING_RUN_CHANGE',
        `${value.runId}\0${change.changeId}`,
        { runId: value.runId, change },
      )
    }
  }
  for (const value of state.provisioningLogs) put('PROVISIONING_LOG', value.logId, value)
  for (const value of state.serviceCredentials) {
    put('SERVICE_CREDENTIAL', value.credentialId, value)
  }
  for (const value of state.scimCredentialDigests) {
    put('SCIM_CREDENTIAL_DIGEST', value.credentialId, value)
  }
  for (const value of state.scimGroupJobs) {
    put('SCIM_GROUP_JOB', value.jobId, value)
  }
  for (const value of state.breakGlassActivations) {
    put('BREAK_GLASS_ACTIVATION', value.activationId, value)
  }
  for (const value of state.provisioningPreviews) {
    const { changes, ...preview } = value
    put(
      'PROVISIONING_PREVIEW',
      value.previewId,
      { ...preview, changes: [] },
      value.expiresAt,
    )
    for (const change of changes) {
      put(
        'PROVISIONING_PREVIEW_CHANGE',
        `${value.previewId}\0${change.changeId}`,
        { previewId: value.previewId, change },
        value.expiresAt,
      )
    }
  }
  const idempotencyKeys = new Set([
    ...Object.keys(state.idempotencyResults),
    ...Object.keys(state.idempotencyFingerprints),
    ...Object.keys(state.idempotencyExpiresAt),
  ])
  for (const key of idempotencyKeys) {
    put('IDEMPOTENCY', key, {
      key,
      result: state.idempotencyResults[key],
      fingerprint: state.idempotencyFingerprints[key],
      expiresAt: state.idempotencyExpiresAt[key],
    }, state.idempotencyExpiresAt[key])
  }
  return records
}

function readEnterpriseIdentityRecords(
  committed: CommittedEnterpriseIdentityRecords,
  workspaceId: string,
  now: Date,
) {
  const state = createEmptyState(workspaceId)
  state.storageRevision = committed.storageRevision
  state.storageGeneration = committed.storageGeneration
  state.storageGenerationChain = committed.storageGenerationChain
  state.storageRetiredGenerations = committed.storageRetiredGenerations
  const usersWithEmbeddedMemberships = new Set<string>()
  const groupsWithEmbeddedMemberships = new Set<string>()
  const userGroupRelations: Array<{ userId: string; groupId: string }> = []
  const groupMemberRelations: Array<{ groupId: string; userId: string }> = []
  const previewChanges: Array<{
    previewId: string
    change: EnterpriseProvisioningPreview['changes'][number]
  }> = []
  const provisioningRunChanges: Array<{
    runId: string
    change: EnterpriseProvisioningRun['changes'][number]
  }> = []
  for (const item of committed.items) {
    if (isExpiredEnterpriseIdentityRecord(item, now)) continue
    if (
      item.entryType !== 'enterprise-identity-record' ||
      item.workspaceId !== workspaceId ||
      typeof item.recordType !== 'string' ||
      typeof item.entityKey !== 'string' ||
      typeof item.contentHash !== 'string' ||
      fingerprintScimRequest(item.payload) !== item.contentHash
    ) {
      throw invalidEnterpriseIdentityState()
    }
    const payload = structuredClone(item.payload)
    if (item.recordType === 'POLICY') {
      state.policy = payload as EnterpriseSecurityPolicy
    } else if (item.recordType === 'PROVIDER') {
      state.identityProviders.push(payload as EnterpriseIdentityProvider)
    } else if (item.recordType === 'DOMAIN') {
      state.domains.push(payload as EnterpriseVerifiedDomain)
    } else if (item.recordType === 'CUSTOM_ROLE') {
      state.customRoles.push(payload as EnterpriseCustomRole)
    } else if (item.recordType === 'GROUP_MAPPING') {
      state.groupMappings.push(payload as EnterpriseDirectoryGroupMapping)
    } else if (item.recordType === 'ROLE_ASSIGNMENT') {
      state.roleAssignments.push(payload as EnterpriseRoleAssignment)
    } else if (item.recordType === 'SCIM_USER') {
      const user = payload as EnterpriseScimUser & {
        /** Embedded membership storage marker. */
        membershipStorageVersion?: number
      }
      if (
        user.membershipStorageVersion ===
          ENTERPRISE_SCIM_EMBEDDED_MEMBERSHIP_VERSION
      ) {
        usersWithEmbeddedMemberships.add(user.userId)
      }
      delete user.membershipStorageVersion
      state.scimUsers.push(user)
    } else if (item.recordType === 'SCIM_USER_GROUP') {
      userGroupRelations.push(readScimRelation(payload))
    } else if (item.recordType === 'SCIM_GROUP') {
      const group = payload as EnterpriseScimGroup & {
        /** Embedded membership storage marker. */
        membershipStorageVersion?: number
      }
      if (
        group.membershipStorageVersion ===
          ENTERPRISE_SCIM_EMBEDDED_MEMBERSHIP_VERSION
      ) {
        groupsWithEmbeddedMemberships.add(group.groupId)
      }
      delete group.membershipStorageVersion
      state.scimGroups.push(group)
    } else if (item.recordType === 'SCIM_GROUP_MEMBER') {
      groupMemberRelations.push(readScimRelation(payload))
    } else if (item.recordType === 'SCIM_CREDENTIAL') {
      state.scimCredentials.push(payload as EnterpriseIssuedCredential['credential'])
    } else if (item.recordType === 'SERVICE_ACCOUNT') {
      state.serviceAccounts.push(payload as EnterpriseServiceAccount)
    } else if (item.recordType === 'BREAK_GLASS_ACCOUNT') {
      state.breakGlassAccounts.push(payload as EnterpriseBreakGlassAccount)
    } else if (item.recordType === 'PROVISIONING_RUN') {
      const run = payload as EnterpriseProvisioningRun
      if (!Array.isArray(run.changes) || run.changes.length > 0) {
        throw invalidEnterpriseIdentityState()
      }
      state.provisioningRuns.push(run)
    } else if (item.recordType === 'PROVISIONING_RUN_CHANGE') {
      provisioningRunChanges.push(
        payload as {
          runId: string
          change: EnterpriseProvisioningRun['changes'][number]
        },
      )
    } else if (item.recordType === 'PROVISIONING_LOG') {
      state.provisioningLogs.push(
        payload as EnterpriseIdentitySnapshot['provisioningLogs'][number],
      )
    } else if (item.recordType === 'SERVICE_CREDENTIAL') {
      state.serviceCredentials.push(payload as StoredServiceCredential)
    } else if (item.recordType === 'SCIM_CREDENTIAL_DIGEST') {
      state.scimCredentialDigests.push(payload as StoredScimCredentialDigest)
    } else if (item.recordType === 'SCIM_GROUP_JOB') {
      if (!isEnterpriseScimGroupJob(payload, workspaceId)) {
        throw invalidEnterpriseIdentityState()
      }
      state.scimGroupJobs.push(payload)
    } else if (item.recordType === 'BREAK_GLASS_ACTIVATION') {
      state.breakGlassActivations.push(payload as EnterpriseBreakGlassActivation)
    } else if (item.recordType === 'PROVISIONING_PREVIEW') {
      state.provisioningPreviews.push(payload as EnterpriseProvisioningPreview)
    } else if (item.recordType === 'PROVISIONING_PREVIEW_CHANGE') {
      previewChanges.push(
        payload as {
          previewId: string
          change: EnterpriseProvisioningPreview['changes'][number]
        },
      )
    } else if (item.recordType === 'IDEMPOTENCY') {
      readIdempotencyRecord(state, payload)
    } else {
      throw invalidEnterpriseIdentityState()
    }
  }
  for (const relation of userGroupRelations) {
    if (usersWithEmbeddedMemberships.has(relation.userId)) continue
    const user = state.scimUsers.find((candidate) => candidate.userId === relation.userId)
    if (!user) throw invalidEnterpriseIdentityState()
    if (!user.groupIds.includes(relation.groupId)) user.groupIds.push(relation.groupId)
  }
  for (const relation of groupMemberRelations) {
    if (groupsWithEmbeddedMemberships.has(relation.groupId)) continue
    const group = state.scimGroups.find((candidate) => candidate.groupId === relation.groupId)
    if (!group) throw invalidEnterpriseIdentityState()
    if (!group.memberUserIds.includes(relation.userId)) {
      group.memberUserIds.push(relation.userId)
    }
  }
  for (const entry of previewChanges) {
    const preview = state.provisioningPreviews.find((candidate) =>
      candidate.previewId === entry.previewId
    )
    if (!preview) throw invalidEnterpriseIdentityState()
    preview.changes.push(entry.change)
  }
  for (const entry of provisioningRunChanges) {
    const run = state.provisioningRuns.find((candidate) => candidate.runId === entry.runId)
    if (!run) throw invalidEnterpriseIdentityState()
    run.changes.push(entry.change)
  }
  return readStoredState({
    ...state,
    entryType: 'enterprise-identity-state',
  }, workspaceId)
}

function readEnterpriseIdentityControl(
  control: Record<string, unknown>,
  workspaceId: string,
) {
  const retiredStateGenerations = control.retiredStateGenerations ?? []
  if (
    control.scopeKey !== `WORKSPACE#${workspaceId}` ||
    control.recordKey !== 'CONTROL' ||
    control.entryType !== 'enterprise-identity-control' ||
    control.workspaceId !== workspaceId ||
    control.maintenanceRequired !== undefined &&
      typeof control.maintenanceRequired !== 'boolean' ||
    !Number.isSafeInteger(control.controlRevision) ||
    Number(control.controlRevision) < 1 ||
    typeof control.activeStateGeneration !== 'string' ||
    control.activeStateGeneration.length === 0 ||
    !Array.isArray(control.activeStateGenerations) ||
    control.activeStateGenerations.length < 1 ||
    control.activeStateGenerations.length > ENTERPRISE_GENERATION_CHAIN_LIMIT ||
    Number(control.controlRevision) < control.activeStateGenerations.length ||
    control.activeStateGenerations.some((entry) =>
      typeof entry !== 'string' || entry.length === 0
    ) ||
    new Set(control.activeStateGenerations).size !==
      control.activeStateGenerations.length ||
    control.activeStateGenerations[0] !== control.activeStateGeneration ||
    !Array.isArray(retiredStateGenerations) ||
    retiredStateGenerations.length > ENTERPRISE_GENERATION_CHAIN_LIMIT ||
    retiredStateGenerations.some((entry) =>
      !isEnterpriseRetiredGeneration(entry)
    ) ||
    new Set(retiredStateGenerations.map((entry) =>
      (entry as EnterpriseRetiredGeneration).stateGeneration
    )).size !== retiredStateGenerations.length ||
    retiredStateGenerations.some((entry) =>
      (control.activeStateGenerations as unknown[]).includes(
        (entry as EnterpriseRetiredGeneration).stateGeneration,
      )
    )
  ) {
    throw invalidEnterpriseIdentityState()
  }
  return {
    storageRevision: control.controlRevision as number,
    storageGeneration: control.activeStateGeneration,
    storageGenerationChain: [...control.activeStateGenerations] as string[],
    storageRetiredGenerations: structuredClone(
      retiredStateGenerations,
    ) as EnterpriseRetiredGeneration[],
  }
}

function isEnterpriseRetiredGeneration(
  value: unknown,
): value is EnterpriseRetiredGeneration {
  return typeof value === 'object' &&
    value !== null &&
    'stateGeneration' in value &&
    typeof value.stateGeneration === 'string' &&
    value.stateGeneration.length > 0 &&
    'generationRevision' in value &&
    Number.isSafeInteger(value.generationRevision) &&
    Number(value.generationRevision) > 0 &&
    'expiresAt' in value &&
    Number.isSafeInteger(value.expiresAt) &&
    Number(value.expiresAt) > 0 &&
    Object.keys(value).every((key) =>
      key === 'stateGeneration' ||
      key === 'generationRevision' ||
      key === 'expiresAt'
    )
}

function validateEnterpriseGeneration(
  items: Record<string, unknown>[],
  workspaceId: string,
  stateGeneration: string,
  expectedRevision: number,
  allowPhysicalExpiry = false,
): ValidatedEnterpriseGeneration {
  const generationScopeKey = enterpriseGenerationScopeKey(
    workspaceId,
    stateGeneration,
  )
  const markers = items.filter((item) =>
    item.entryType === 'enterprise-identity-generation'
  )
  if (markers.length !== 1) throw invalidEnterpriseIdentityState()
  const marker = markers[0]!
  const generationKind = marker.generationKind
  const generationItems = items.filter((item) => item !== marker)
  if (
    !hasOnlyEnterpriseGenerationKeys(marker, [
      'scopeKey',
      'recordKey',
      'entryType',
      'workspaceId',
      'stateGeneration',
      'generationKind',
      'generationRevision',
      'deltaCount',
      'manifestHash',
      'parentStateGeneration',
      'parentGenerationRevision',
      'expiresAt',
    ]) ||
    marker.scopeKey !== generationScopeKey ||
    marker.recordKey !== enterpriseGenerationRecordKey() ||
    marker.workspaceId !== workspaceId ||
    marker.stateGeneration !== stateGeneration ||
    generationKind !== 'snapshot' && generationKind !== 'delta' ||
    !Number.isSafeInteger(marker.generationRevision) ||
    Number(marker.generationRevision) < 1 ||
    marker.generationRevision !== expectedRevision ||
    !Number.isSafeInteger(marker.deltaCount) ||
    Number(marker.deltaCount) < 0 ||
    marker.deltaCount !== generationItems.length ||
    typeof marker.manifestHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(marker.manifestHash) ||
    !isValidEnterprisePhysicalExpiry(marker.expiresAt, allowPhysicalExpiry) ||
    generationKind === 'snapshot' &&
      (marker.parentStateGeneration !== undefined ||
        marker.parentGenerationRevision !== undefined) ||
    generationKind === 'delta' &&
      (typeof marker.parentStateGeneration !== 'string' ||
        marker.parentStateGeneration.length === 0 ||
        !Number.isSafeInteger(marker.parentGenerationRevision) ||
        marker.parentGenerationRevision !== expectedRevision - 1 ||
        Number(marker.parentGenerationRevision) < 1)
  ) {
    throw invalidEnterpriseIdentityState()
  }
  const logicalRecordKeys = new Set<string>()
  for (const item of generationItems) {
    const logicalRecordKey = item.logicalRecordKey
    if (
      item.scopeKey !== generationScopeKey ||
      item.workspaceId !== workspaceId ||
      item.stateGeneration !== stateGeneration ||
      typeof logicalRecordKey !== 'string' ||
      logicalRecordKey.length === 0 ||
      item.recordKey !== enterpriseDeltaRecordKey(logicalRecordKey) ||
      logicalRecordKeys.has(logicalRecordKey)
    ) {
      throw invalidEnterpriseIdentityState()
    }
    logicalRecordKeys.add(logicalRecordKey)
    if (item.entryType === 'enterprise-identity-record') {
      if (
        !hasOnlyEnterpriseGenerationKeys(item, [
          'scopeKey',
          'recordKey',
          'entryType',
          'workspaceId',
          'stateGeneration',
          'logicalRecordKey',
          'recordType',
          'entityKey',
          'payload',
          'contentHash',
          'logicalExpiresAt',
          'expiresAt',
        ]) ||
        typeof item.recordType !== 'string' ||
        typeof item.entityKey !== 'string' ||
        logicalRecordKey !==
          `${item.recordType}#${stableId(
            'record',
            item.recordType,
            item.entityKey,
          )}` ||
        !Object.hasOwn(item, 'payload') ||
        typeof item.contentHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(item.contentHash) ||
        fingerprintScimRequest(item.payload) !== item.contentHash ||
        item.logicalExpiresAt !== undefined &&
          (!Number.isSafeInteger(item.logicalExpiresAt) ||
            Number(item.logicalExpiresAt) <= 0) ||
        !isValidEnterprisePhysicalExpiry(item.expiresAt, allowPhysicalExpiry)
      ) {
        throw invalidEnterpriseIdentityState()
      }
    } else {
      if (
        item.entryType !== 'enterprise-identity-tombstone' ||
        generationKind === 'snapshot' ||
        !hasOnlyEnterpriseGenerationKeys(item, [
          'scopeKey',
          'recordKey',
          'entryType',
          'workspaceId',
          'stateGeneration',
          'logicalRecordKey',
          'expiresAt',
        ])
        || !isValidEnterprisePhysicalExpiry(item.expiresAt, allowPhysicalExpiry)
      ) {
        throw invalidEnterpriseIdentityState()
      }
    }
  }
  if (fingerprintEnterpriseGenerationManifest(generationItems) !== marker.manifestHash) {
    throw invalidEnterpriseIdentityState()
  }
  return {
    stateGeneration,
    generationKind,
    generationRevision: expectedRevision,
    ...(generationKind === 'delta'
      ? {
          parentStateGeneration: marker.parentStateGeneration as string,
          parentGenerationRevision: marker.parentGenerationRevision as number,
        }
      : {}),
    items: generationItems,
  }
}

function isValidEnterprisePhysicalExpiry(
  value: unknown,
  allowPhysicalExpiry: boolean,
) {
  return value === undefined ||
    allowPhysicalExpiry &&
      Number.isSafeInteger(value) &&
      Number(value) > 0
}

function hasOnlyEnterpriseGenerationKeys(
  value: Record<string, unknown>,
  allowedKeys: string[],
) {
  const allowed = new Set(allowedKeys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function validateEnterpriseGenerationChain(
  control: ReturnType<typeof readEnterpriseIdentityControl>,
  generations: ValidatedEnterpriseGeneration[],
) {
  if (
    generations.length !== control.storageGenerationChain.length ||
    generations.length < 1 ||
    generations.at(-1)?.generationKind !== 'snapshot'
  ) {
    throw invalidEnterpriseIdentityState()
  }
  for (let index = 0; index < generations.length; index += 1) {
    const generation = generations[index]!
    const expectedGenerationId = control.storageGenerationChain[index]
    const parent = generations[index + 1]
    if (
      generation.stateGeneration !== expectedGenerationId ||
      generation.generationRevision !== control.storageRevision - index ||
      parent &&
        (generation.generationKind !== 'delta' ||
          generation.parentStateGeneration !== parent.stateGeneration ||
          generation.parentGenerationRevision !== parent.generationRevision) ||
      !parent && generation.generationKind !== 'snapshot'
    ) {
      throw invalidEnterpriseIdentityState()
    }
  }
}

function materializeEnterpriseIdentityRecords(
  control: ReturnType<typeof readEnterpriseIdentityControl>,
  generations: ValidatedEnterpriseGeneration[],
): CommittedEnterpriseIdentityRecords {
  const committedRecords = new Map<string, Record<string, unknown>>()
  for (const generation of [...generations].reverse()) {
    for (const item of generation.items) {
      if (item.entryType === 'enterprise-identity-tombstone') {
        committedRecords.delete(item.logicalRecordKey as string)
      } else if (item.entryType === 'enterprise-identity-record') {
        committedRecords.set(item.logicalRecordKey as string, item)
      } else {
        throw invalidEnterpriseIdentityState()
      }
    }
  }
  return {
    storageRevision: control.storageRevision,
    storageGeneration: control.storageGeneration,
    storageGenerationChain: control.storageGenerationChain,
    storageRetiredGenerations: control.storageRetiredGenerations,
    items: [...committedRecords.values()],
  }
}

function fingerprintEnterpriseGenerationManifest(
  items: Record<string, unknown>[],
) {
  return fingerprintScimRequest(items.map((item) => ({
    logicalRecordKey: item.logicalRecordKey,
    entryType: item.entryType,
    ...(item.entryType === 'enterprise-identity-record'
      ? {
          recordType: item.recordType,
          entityKey: item.entityKey,
          contentHash: item.contentHash,
          ...(item.logicalExpiresAt === undefined
            ? {}
            : { logicalExpiresAt: item.logicalExpiresAt }),
        }
      : { tombstone: true }),
  })).sort((left, right) => {
    const leftKey = String(left.logicalRecordKey)
    const rightKey = String(right.logicalRecordKey)
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  }))
}

function isExpiredEnterpriseIdentityRecord(
  item: Record<string, unknown>,
  now: Date,
) {
  if (item.logicalExpiresAt === undefined) return false
  if (
    !Number.isSafeInteger(item.logicalExpiresAt) ||
    Number(item.logicalExpiresAt) <= 0
  ) {
    throw invalidEnterpriseIdentityState()
  }
  return Number(item.logicalExpiresAt) <= Math.floor(now.getTime() / 1_000)
}

function readScimRelation(value: unknown) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('userId' in value) ||
    typeof value.userId !== 'string' ||
    !('groupId' in value) ||
    typeof value.groupId !== 'string'
  ) throw invalidEnterpriseIdentityState()
  return { userId: value.userId, groupId: value.groupId }
}

function readIdempotencyRecord(state: EnterpriseIdentityState, value: unknown) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('key' in value) ||
    typeof value.key !== 'string'
  ) throw invalidEnterpriseIdentityState()
  if ('result' in value && typeof value.result === 'string') {
    state.idempotencyResults[value.key] = value.result
  }
  if ('fingerprint' in value && typeof value.fingerprint === 'string') {
    state.idempotencyFingerprints[value.key] = value.fingerprint
  }
  if ('expiresAt' in value && typeof value.expiresAt === 'string') {
    state.idempotencyExpiresAt[value.key] = value.expiresAt
  }
}

function invalidEnterpriseIdentityState() {
  return new EnterpriseIdentityError(
    503,
    'EnterpriseIdentityStateInvalid',
    'Enterprise identity state is invalid.',
  )
}

function readStoredState(value: Record<string, unknown>, workspaceId: string) {
  if (
    value.workspaceId !== workspaceId ||
    value.entryType !== 'enterprise-identity-state' ||
    !Number.isSafeInteger(value.storageRevision) ||
    value.storageGeneration !== undefined &&
      typeof value.storageGeneration !== 'string' ||
    !Array.isArray(value.storageGenerationChain) ||
    value.storageGenerationChain.some((entry) => typeof entry !== 'string') ||
    !Array.isArray(value.storageRetiredGenerations) ||
    value.storageRetiredGenerations.some((entry) =>
      !isEnterpriseRetiredGeneration(entry)
    ) ||
    !Array.isArray(value.identityProviders) ||
    !Array.isArray(value.domains) ||
    !Array.isArray(value.customRoles) ||
    !Array.isArray(value.groupMappings) ||
    !Array.isArray(value.roleAssignments) ||
    !Array.isArray(value.scimUsers) ||
    !Array.isArray(value.scimGroups) ||
    !Array.isArray(value.scimCredentials) ||
    !Array.isArray(value.serviceAccounts) ||
    !Array.isArray(value.breakGlassAccounts) ||
    !Array.isArray(value.provisioningRuns) ||
    !Array.isArray(value.provisioningLogs) ||
    !Array.isArray(value.serviceCredentials) ||
    !Array.isArray(value.scimCredentialDigests) ||
    !Array.isArray(value.scimGroupJobs) ||
    value.scimGroupJobs.some((job) =>
      !isEnterpriseScimGroupJob(job, workspaceId)
    ) ||
    !Array.isArray(value.breakGlassActivations) ||
    !Array.isArray(value.provisioningPreviews) ||
    !isStringRecord(value.idempotencyResults) ||
    !isStringRecord(value.idempotencyFingerprints) ||
    !isStringRecord(value.idempotencyExpiresAt)
  ) {
    throw invalidEnterpriseIdentityState()
  }
  const state = structuredClone(value) as unknown as EnterpriseIdentityState
  if (
    new Set(state.scimGroupJobs.map((job) => job.jobId)).size !==
      state.scimGroupJobs.length ||
    new Set(state.scimGroupJobs.map((job) => job.groupId)).size !==
      state.scimGroupJobs.length ||
    state.scimGroupJobs.some((job) => {
      const group = state.scimGroups.find((candidate) =>
        candidate.groupId === job.groupId &&
        candidate.version === job.groupVersion
      )
      return !group ||
        job.targetUserIds.some((userId) =>
          !state.scimUsers.some((user) =>
            user.userId === userId &&
            user.identityProviderId === group.identityProviderId
          )
        )
    })
  ) {
    throw invalidEnterpriseIdentityState()
  }
  return state
}

function validateProvider(provider: EnterpriseIdentityProvider) {
  requireText(provider.workspaceId, 'Workspace ID')
  requireText(provider.providerId, 'Identity provider ID')
  requireText(provider.displayName, 'Identity provider display name')
  requireText(provider.cognitoProviderName, 'Cognito identity provider name')
  const urls = provider.kind === 'saml'
    ? [provider.singleSignOnUrl, provider.metadataUrl]
    : [
        provider.issuer,
        provider.authorizationEndpoint,
        provider.tokenEndpoint,
        provider.jwksUri,
      ]
  for (const value of urls) {
    try {
      const url = new URL(value)
      if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new Error()
    } catch {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseIdentityProviderUrlInvalid',
        'Identity provider endpoints must be valid HTTPS URLs.',
      )
    }
  }
  if (
    provider.status === 'active' &&
    (
      !provider.lastTestedAt ||
      !Number.isFinite(Date.parse(provider.lastTestedAt))
    )
  ) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseIdentityProviderTestRequired',
      'Active identity providers require a successful connection test.',
    )
  }
  if (
    provider.status === 'active' &&
    provider.kind === 'saml' &&
    provider.certificateFingerprints.length === 0
  ) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseSamlCertificateMissing',
      'Active SAML providers require a verified signing certificate.',
    )
  }
}

function validateSecurityPolicy(policy: EnterpriseSecurityPolicy) {
  const minuteFields = [
    policy.sessionLifetimeMinutes,
    policy.idleTimeoutMinutes,
    policy.reauthenticationIntervalMinutes,
    policy.sensitiveActionReauthenticationMinutes,
    policy.externalAccess.maximumSessionLifetimeMinutes,
  ]
  if (minuteFields.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 43_200)) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseSecurityPolicyInvalid',
      'Session policy durations must be integers between 1 and 43200 minutes.',
    )
  }
  if (
    policy.idleTimeoutMinutes > policy.sessionLifetimeMinutes ||
    policy.reauthenticationIntervalMinutes > policy.sessionLifetimeMinutes ||
    policy.sensitiveActionReauthenticationMinutes >
      policy.reauthenticationIntervalMinutes ||
    policy.externalAccess.maximumSessionLifetimeMinutes >
      policy.sessionLifetimeMinutes
  ) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseSecurityPolicyInvalid',
      'Idle, reauthentication, sensitive-action, and external session intervals must become progressively stricter than the absolute session lifetime.',
    )
  }
  if (
    policy.ipAllowlistMode !== 'disabled' &&
    (
      policy.ipAllowlist.length === 0 ||
      policy.ipAllowlist.some((cidr) => {
        const address = cidr.split('/')[0]
        return !address || !ipMatchesCidr(address, cidr)
      })
    )
  ) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseIpAllowlistInvalid',
      'Enabled IP allowlist requires valid IPv4 or IPv6 CIDRs.',
    )
  }
  if (
    !Array.isArray(policy.externalAccess.allowedGuestDomains) ||
    policy.externalAccess.allowedGuestDomains.some((domain) =>
      normalizeDomain(domain) !== domain
    )
  ) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseGuestDomainInvalid',
      'Allowed guest domains must be normalized DNS domain names.',
    )
  }
}

function validateServiceAccountBoundary(account: EnterpriseServiceAccount) {
  if (
    !Number.isSafeInteger(account.credentialLifetimeDays) ||
    account.credentialLifetimeDays < 1 ||
    account.credentialLifetimeDays > 365
  ) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseServiceAccountLifetimeInvalid',
      'Service account credential lifetime must be between 1 and 365 days.',
    )
  }
  if (
    !Array.isArray(account.allowedSourceCidrs) ||
    account.allowedSourceCidrs.some((cidr) => {
      const address = cidr.split('/')[0]
      return !address || !ipMatchesCidr(address, cidr)
    })
  ) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseServiceAccountSourceInvalid',
      'Service account source restrictions must be valid IPv4 or IPv6 CIDRs.',
    )
  }
  if (
    account.scope.kind !== 'workspace' &&
    !account.scope.targetId?.trim()
  ) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseServiceAccountScopeInvalid',
      'Team and Project service accounts require a resource scope ID.',
    )
  }
}

function normalizeDomain(value: string) {
  const domain = requireText(value, 'Domain').toLowerCase().replace(/\.$/u, '')
  if (
    domain.length > 253 ||
    !domain.includes('.') ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/u.test(domain)
  ) {
    throw new EnterpriseIdentityError(400, 'EnterpriseDomainInvalid', 'Domain is invalid.')
  }
  return domain
}

function normalizeEmailDomain(email: string) {
  const normalized = email.trim().toLowerCase()
  const at = normalized.lastIndexOf('@')
  if (at <= 0 || at === normalized.length - 1) return undefined
  try {
    return normalizeDomain(normalized.slice(at + 1))
  } catch {
    return undefined
  }
}

function isEnterpriseSsoRecoveryAccountReady(
  state: EnterpriseIdentityState,
  account: EnterpriseBreakGlassAccount,
  now: Date,
) {
  const emailDomain = normalizeEmailDomain(account.email)
  const testedAt = Date.parse(account.lastTestedAt ?? '')
  return account.status === 'active' &&
    account.requireMfa &&
    Number.isFinite(Date.parse(account.mfaVerifiedAt)) &&
    Number.isFinite(testedAt) &&
    testedAt <= now.getTime() &&
    now.getTime() - testedAt <= 30 * 24 * 60 * 60_000 &&
    !state.domains.some((domain) =>
      domain.status === 'verified' && domain.domain === emailDomain
    )
}

function requireUnmanagedEnterpriseBreakGlassRecoveryDomain(
  state: EnterpriseIdentityState,
  email: string,
) {
  const emailDomain = normalizeEmailDomain(email)
  if (state.domains.some((domain) =>
    domain.status === 'verified' && domain.domain === emailDomain
  )) {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseBreakGlassRecoveryDomainManaged',
      'Break-glass recovery must use an account outside every managed domain.',
    )
  }
}

function normalizeEmails(values: string[]) {
  const emails = [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))]
  if (emails.length === 0 || emails.some((email) => !normalizeEmailDomain(email))) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimEmailInvalid',
      'SCIM user requires at least one valid email.',
    )
  }
  return emails
}

function pruneInactiveScimCredentialDigests(
  state: EnterpriseIdentityState,
  now: number,
) {
  const activeCredentials = state.scimCredentials.filter((credential) =>
    !credential.revokedAt &&
    (
      !credential.expiresAt ||
      Date.parse(credential.expiresAt) > now
    )
  )
  const activeCredentialIds = new Set(
    activeCredentials.map((credential) => credential.credentialId),
  )
  state.scimCredentialDigests = state.scimCredentialDigests.filter((digest) =>
    activeCredentialIds.has(digest.credentialId)
  )
  return activeCredentials
}

function validateEnterpriseScimUserInputLimits(
  input: EnterpriseScimUserInput,
) {
  if (input.emails.length > ENTERPRISE_SCIM_USER_EMAIL_LIMIT) {
    throw new EnterpriseIdentityError(
      413,
      'EnterpriseScimUserEmailLimitExceeded',
      `A SCIM user can contain at most ${
        ENTERPRISE_SCIM_USER_EMAIL_LIMIT
      } email addresses.`,
    )
  }
  validateEnterpriseScimTextByteLength(
    input.userId,
    'SCIM user ID',
    ENTERPRISE_SCIM_RESOURCE_ID_MAX_BYTES,
  )
  validateEnterpriseScimTextByteLength(
    input.externalId,
    'SCIM user externalId',
    ENTERPRISE_SCIM_EXTERNAL_ID_MAX_BYTES,
  )
  validateEnterpriseScimTextByteLength(
    input.userName,
    'SCIM userName',
    ENTERPRISE_SCIM_USER_IDENTIFIER_MAX_BYTES,
  )
  validateEnterpriseScimTextByteLength(
    input.displayName,
    'SCIM user displayName',
    ENTERPRISE_SCIM_DISPLAY_NAME_MAX_BYTES,
  )
  validateEnterpriseScimTextByteLength(
    input.idempotencyKey,
    'SCIM Idempotency-Key',
    ENTERPRISE_SCIM_IDEMPOTENCY_KEY_MAX_BYTES,
  )
  for (const email of input.emails) {
    validateEnterpriseScimTextByteLength(
      email,
      'SCIM email',
      ENTERPRISE_SCIM_USER_IDENTIFIER_MAX_BYTES,
    )
  }
}

function validateEnterpriseScimGroupInputLimits(
  input: EnterpriseScimGroupInput,
) {
  if (
    (input.memberUserIds?.length ?? 0) >
      ENTERPRISE_SCIM_GROUP_MEMBER_LIMIT
  ) {
    throw new EnterpriseIdentityError(
      413,
      'EnterpriseScimGroupMemberLimitExceeded',
      `A SCIM group can contain at most ${
        ENTERPRISE_SCIM_GROUP_MEMBER_LIMIT
      } members.`,
    )
  }
  validateEnterpriseScimTextByteLength(
    input.groupId,
    'SCIM group ID',
    ENTERPRISE_SCIM_RESOURCE_ID_MAX_BYTES,
  )
  validateEnterpriseScimTextByteLength(
    input.externalId,
    'SCIM group externalId',
    ENTERPRISE_SCIM_EXTERNAL_ID_MAX_BYTES,
  )
  validateEnterpriseScimTextByteLength(
    input.displayName,
    'SCIM group displayName',
    ENTERPRISE_SCIM_DISPLAY_NAME_MAX_BYTES,
  )
  validateEnterpriseScimTextByteLength(
    input.idempotencyKey,
    'SCIM Idempotency-Key',
    ENTERPRISE_SCIM_IDEMPOTENCY_KEY_MAX_BYTES,
  )
  for (const memberUserId of input.memberUserIds ?? []) {
    if (
      memberUserId.trim().length === 0 ||
      Buffer.byteLength(memberUserId, 'utf8') >
        ENTERPRISE_SCIM_MEMBER_ID_MAX_BYTES
    ) {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseScimGroupMemberInvalid',
        `SCIM member IDs must contain at most ${
          ENTERPRISE_SCIM_MEMBER_ID_MAX_BYTES
        } UTF-8 bytes.`,
      )
    }
  }
}

function validateEnterpriseScimTextByteLength(
  value: string | undefined,
  label: string,
  maximumBytes: number,
) {
  if (
    value !== undefined &&
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimTextLimitExceeded',
      `${label} must contain at most ${maximumBytes} UTF-8 bytes.`,
    )
  }
}

function throwEnterpriseCognitoBindingMismatch(message: string): never {
  throw new EnterpriseIdentityError(
    409,
    'EnterpriseCognitoProviderBindingMismatch',
    message,
  )
}

function readEnterpriseXmlAttribute(element: string, attributeName: string) {
  return element.match(new RegExp(
    `\\b${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    'iu',
  ))?.slice(1).find((value) => value !== undefined)
}

function decodeEnterpriseXmlValue(value: string) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', '\'')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function requireReadyIdentityProvider(
  state: EnterpriseIdentityState,
  identityProviderId: string,
) {
  const provider = state.identityProviders.find((candidate) =>
    candidate.providerId === identityProviderId
  )
  assertEnterpriseIdentityProviderReady(provider)
  return provider
}

function roleExists(state: EnterpriseIdentityState, roleId: string) {
  return roleId in builtInRolePermissions ||
    state.customRoles.some((role) => role.roleId === roleId)
}

function hasAppliedProvisioningCheckpoint(
  state: EnterpriseIdentityState,
  change: EnterpriseProvisioningPreview['changes'][number],
) {
  const entity = change.entityType === 'user' || change.entityType === 'session'
    ? state.scimUsers.find((candidate) => candidate.userId === change.entityId)
    : change.entityType === 'group'
      ? state.scimGroups.find((candidate) => candidate.groupId === change.entityId)
      : undefined
  return entity?.version === change.desiredVersion &&
    entity.appliedVersion >= change.desiredVersion
}

function fingerprintProvisioning(
  workspaceId: string,
  source: EnterpriseProvisioningInput['source'],
  changes: EnterpriseProvisioningPreview['changes'],
) {
  return createHash('sha256')
    .update(JSON.stringify({
      workspaceId,
      source,
      changes: [...changes].sort((first, second) =>
        first.changeId.localeCompare(second.changeId)
      ),
    }))
    .digest('hex')
}

function fingerprintScimRequest(value: unknown) {
  return createHash('sha256')
    .update(canonicalEnterpriseJson(value))
    .digest('hex')
}

function canonicalEnterpriseJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) =>
      entry === undefined ? 'null' : canonicalEnterpriseJson(entry)
    ).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) =>
        `${JSON.stringify(key)}:${canonicalEnterpriseJson(entry)}`
      )
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function getActiveIdempotencyResult(
  state: EnterpriseIdentityState,
  receiptKey: string,
  now: Date,
) {
  const result = state.idempotencyResults[receiptKey]
  const expiresAt = Date.parse(state.idempotencyExpiresAt[receiptKey] ?? '')
  return result && Number.isFinite(expiresAt) && expiresAt > now.getTime()
    ? result
    : undefined
}

function assertIdempotencyReceipt(
  state: EnterpriseIdentityState,
  receiptKey: string,
  requestFingerprint: string,
  now: Date,
  operation: string,
) {
  if (state.idempotencyFingerprints[receiptKey] !== requestFingerprint) {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseIdempotencyConflict',
      `${operation} idempotency key was already used with a different payload.`,
    )
  }
  const expiresAt = state.idempotencyExpiresAt[receiptKey]
  if (!expiresAt || Date.parse(expiresAt) <= now.getTime()) {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseOneTimeCredentialAlreadyIssued',
      `${operation} already completed and its one-time credential replay window expired.`,
    )
  }
}

function stableId(namespace: string, ...values: string[]) {
  return `${namespace}_${createHash('sha256')
    .update(values.join('\0'))
    .digest('base64url')
    .slice(0, 22)}`
}

function isMatchingCredentialDigest(candidate: string, expected: string) {
  if (
    candidate.length !== expected.length ||
    !/^[0-9a-f]{64}$/u.test(candidate) ||
    !/^[0-9a-f]{64}$/u.test(expected)
  ) return false
  return timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(expected, 'hex'))
}

function upsertBy<T>(values: T[], next: T, predicate: (value: T) => boolean) {
  const index = values.findIndex(predicate)
  if (index < 0) values.push(next)
  else values[index] = next
}

function normalizeTimestamp(value: string, label: string) {
  const timestamp = requireText(value, label)
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed)) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseTimestampInvalid',
      `${label} must be an ISO 8601 timestamp.`,
    )
  }
  return new Date(parsed).toISOString()
}

function requireText(value: string, label: string) {
  const normalized = value?.trim()
  if (!normalized || normalized.length > 4096) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseIdentityInputInvalid',
      `${label} is required.`,
    )
  }
  return normalized
}

function isConditionalWriteError(error: unknown) {
  return error instanceof Error &&
    (
      error.name === 'ConditionalCheckFailedException' ||
      error.name === 'TransactionCanceledException'
    )
}

function toEnterprisePersistenceError(error: unknown) {
  return new EnterpriseIdentityError(
    503,
    'EnterpriseIdentityUnavailable',
    'Enterprise identity state is unavailable.',
    true,
    { cause: error },
  )
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
}
