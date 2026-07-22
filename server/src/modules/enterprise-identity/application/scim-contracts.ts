import type {
  EnterpriseIdentityProvider,
  EnterpriseIdentitySnapshot,
  EnterpriseScimCredential,
  EnterpriseScimGroup,
  EnterpriseScimUser,
} from '@mukuroji/contracts'
import type {
  EnterpriseScimGroupJobReference,
} from '../domain/scim-group-job-reference'

/** SCIM User collection の equality filter です。 */
export type EnterpriseScimUserListFilter = {
  /** DynamoDB lookup partition で照合する SCIM User field です。 */
  field: 'externalId' | 'userName' | 'displayName'
  /** externalId は case-sensitive、userName/displayName は case-insensitive に照合します。 */
  value: string
}

/** SCIM Group collection の equality filter です。 */
export type EnterpriseScimGroupListFilter = {
  /** DynamoDB lookup partition で照合する SCIM Group field です。 */
  field: 'externalId' | 'displayName'
  /** externalId は case-sensitive、displayName は case-insensitive に照合します。 */
  value: string
}

/** SCIM User collection の page request です。 */
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

/** SCIM Group collection の page request です。 */
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

/** SCIM User collection の page です。 */
export type EnterpriseScimUserPage = {
  /** Filter 適用後の resource 総数です。 */
  totalResults: number
  /** Request と同じ1始まり page offset です。 */
  startIndex: number
  /** Page に含まれる SCIM Users です。 */
  resources: EnterpriseScimUser[]
}

/** SCIM Group collection の page です。 */
export type EnterpriseScimGroupPage = {
  /** Filter 適用後の resource 総数です。 */
  totalResults: number
  /** Request と同じ1始まり page offset です。 */
  startIndex: number
  /** Page に含まれる SCIM Groups です。 */
  resources: EnterpriseScimGroup[]
}

/** SCIM bearer credential と current provider の targeted authentication 結果です。 */
export type EnterpriseScimWorkspaceAuthentication = {
  /** 認証済み Workspace-scoped SCIM credential metadata です。 */
  credential: EnterpriseScimCredential
  /** Credential が bind された current active identity provider です。 */
  provider: EnterpriseIdentityProvider
}

/** Workspace ごとの SCIM resource hard cap です。 */
export type EnterpriseScimResourceLimits = {
  /** Inactive resource を含む User 上限です。 */
  maximumUsers: number
  /** Inactive resource を含む Group 上限です。 */
  maximumGroups: number
}

/** Durable SCIM group reconciliation job の内部 state です。 */
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

/** 一つの SCIM group job user callback に渡す immutable snapshot です。 */
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

/** SCIM group job の一つの user side effect を適用する callback です。 */
export type EnterpriseScimGroupJobApplyUser = (
  input: EnterpriseScimGroupJobApplyInput,
) => Promise<void>

/** SCIM group job page processor の結果です。 */
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

/** SCIM userName/email に許可する UTF-8 byte 数です。 */
export const ENTERPRISE_SCIM_USER_IDENTIFIER_MAX_BYTES = 320

/** SCIM displayName に許可する UTF-8 byte 数です。 */
export const ENTERPRISE_SCIM_DISPLAY_NAME_MAX_BYTES = 256

/** SCIM idempotency key に許可する UTF-8 byte 数です。 */
export const ENTERPRISE_SCIM_IDEMPOTENCY_KEY_MAX_BYTES = 256

/** 一つの SCIM User に保持できる email 数です。 */
export const ENTERPRISE_SCIM_USER_EMAIL_LIMIT = 10

/** 一つの provider に保持できる active SCIM credential 数です。 */
export const ENTERPRISE_SCIM_ACTIVE_CREDENTIAL_LIMIT_PER_PROVIDER = 10

/** 一つの Workspace に保持できる active SCIM credential 数です。 */
export const ENTERPRISE_SCIM_ACTIVE_CREDENTIAL_LIMIT_PER_WORKSPACE = 50
