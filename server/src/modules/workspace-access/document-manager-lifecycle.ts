import {
  type DocumentClient,
  DocumentError,
  type DocumentManagerLifecycleSnapshot,
} from '../documents'
import { WorkspaceAccessError } from './workspace-access'

const DOCUMENT_MANAGER_SNAPSHOT_RETRY_LIMIT = 3

/**
 * Private Document manager 継続性検証に必要な storage clients です。
 */
export type DocumentManagerLifecycleDependencies = {
  /** Document ACL generation と manager projection を読みます。 */
  documents: Pick<
    DocumentClient,
    'getAuthorizationRevision' | 'getManagerLifecycleSnapshot'
  >
  /** Active/non-guest replacement manager 候補を読みます。 */
  workspaceAccess: {
    /** Active Workspace members を current role とともに返します。 */
    listActiveMembers(workspaceId: string): Promise<Array<{
      /** Stable Workspace member key です。 */
      memberKey: string
      /** Manager eligibility 判定に使う current Workspace role です。 */
      role: 'owner' | 'admin' | 'member' | 'guest'
    }>>
  }
}

/**
 * Member の deactivation / guest downgrade 後も全 private Document に manager が残ることを検証します。
 *
 * @returns Member mutation transaction に束縛する Document ACL generation です。
 */
export async function requirePrivateDocumentManagerContinuity(
  dependencies: DocumentManagerLifecycleDependencies,
  workspaceId: string,
  memberKey: string,
) {
  for (
    let attempt = 0;
    attempt < DOCUMENT_MANAGER_SNAPSHOT_RETRY_LIMIT;
    attempt += 1
  ) {
    let snapshot: DocumentManagerLifecycleSnapshot
    let expectedAuthorizationRevision: number
    try {
      expectedAuthorizationRevision =
        await dependencies.documents.getAuthorizationRevision(
          workspaceId,
        )
      const eligibleManagerMemberKeys =
        (
          await dependencies.workspaceAccess.listActiveMembers(
            workspaceId,
          )
        )
          .filter(({ role }) => role !== 'guest')
          .map((member) => member.memberKey)
      snapshot = await dependencies.documents.getManagerLifecycleSnapshot(
        workspaceId,
        memberKey,
        eligibleManagerMemberKeys,
      )
    } catch (error) {
      if (error instanceof DocumentError) {
        throw new WorkspaceAccessError(
          error.status,
          error.code,
          error.message,
          { cause: error },
        )
      }
      throw error
    }
    if (
      snapshot.authorizationRevision !==
        expectedAuthorizationRevision
    ) {
      continue
    }
    if (snapshot.blockingDocumentId !== undefined) {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceMemberManagesPrivateDocuments',
        'Transfer private Document manager access before deactivating this member or changing them to guest.',
      )
    }
    return snapshot.authorizationRevision
  }
  throw new WorkspaceAccessError(
    409,
    'DocumentAuthorizationChanged',
    'Document permissions changed. Reload and try again.',
  )
}
