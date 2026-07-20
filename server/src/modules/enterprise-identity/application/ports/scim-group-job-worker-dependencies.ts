import type { DocumentClient } from '../../../documents'
import type { PlanningClient } from '../../../planning'
import type {
  WorkspaceAccessClient,
} from '../../../workspace-access'
import type {
  EnterpriseIdentityClient,
} from '../../enterprise-identity'

/**
 * SCIM group worker が利用する enterprise identity client の最小契約です。
 */
export type EnterpriseScimGroupJobIdentityClient = Pick<
  EnterpriseIdentityClient,
  'processScimGroupJob'
>

/**
 * SCIM group worker が利用する Workspace access client の最小契約です。
 */
export type EnterpriseScimGroupJobWorkspaceAccessClient = Required<Pick<
  WorkspaceAccessClient,
  'deprovisionDirectoryMember' | 'getMember' | 'listActiveMembers' |
    'reconcileDirectoryMember'
>>

/**
 * SCIM group worker が利用する private Document manager guard client です。
 */
export type EnterpriseScimGroupJobDocumentClient = Pick<
  DocumentClient,
  'getAuthorizationRevision' | 'getManagerLifecycleSnapshot'
>

/**
 * SCIM group worker が利用する Planning client の最小契約です。
 */
export type EnterpriseScimGroupJobPlanningClient = Pick<
  PlanningClient,
  'getAuthorizationState'
>

/**
 * SCIM group worker が参照する Project manager guard です。
 */
export type EnterpriseScimGroupJobProjectManagerGuard = {
  /**
   * Active project の manager role が残っている場合に true を返します。
   */
  hasManagedProject(workspaceId: string, memberKey: string): Promise<boolean>
}

/**
 * SCIM group worker が利用する Cognito user lifecycle 操作です。
 */
export type EnterpriseScimGroupJobCognitoClient = {
  /** Directory deprovisioning 後に新規認証を停止します。 */
  disableWorkspaceUser(userId: string): Promise<void>
  /** Directory reactivation 後に認証を再開します。 */
  enableWorkspaceUser(userId: string): Promise<void>
  /** Directory deprovisioning 後に refresh token を全失効させます。 */
  globallySignOutWorkspaceUser(userId: string): Promise<void>
}

/**
 * SCIM group worker processor の dependency です。
 */
export type EnterpriseScimGroupJobWorkerDependencies = {
  /** Durable group job と enterprise identity snapshot を管理します。 */
  enterpriseIdentity: EnterpriseScimGroupJobIdentityClient
  /** Workspace member を directory authority から収束させます。 */
  workspaceAccess: EnterpriseScimGroupJobWorkspaceAccessClient
  /** Private Document manager 継続性と ACL generation を読みます。 */
  documents: EnterpriseScimGroupJobDocumentClient
  /** Planning owner guard と revision fence を読み取ります。 */
  planning: EnterpriseScimGroupJobPlanningClient
  /** Active Project manager role の有無を確認します。 */
  projectManagerGuard: EnterpriseScimGroupJobProjectManagerGuard
  /** Cognito user の認証 lifecycle を収束させます。 */
  cognito: EnterpriseScimGroupJobCognitoClient
}
