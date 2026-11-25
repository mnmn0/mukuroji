import {
  DynamoDbDocumentsClient,
} from '../../modules/documents/adapter-out/dynamodb/dynamo-db-documents-client'
import {
  DynamoDbEnterpriseScimProjectManagerGuard,
} from '../../modules/enterprise-identity/adapter-out/dynamodb/enterprise-scim-project-manager-guard'
import { DynamoDbPlanningClient } from '../../modules/planning/planning'
import {
  deactivateExpiredMembers,
  type MemberAccessExpiryResult,
} from '../../modules/workspace-access/application/member-access-expiry'
import { createProductionTenantWorkspaceAccess } from './tenant-administration'

/**
 * Creates the production run of the scheduled member access expiry job.
 *
 * The job deactivates members whose access expiry has passed, with the same Project manager,
 * Planning owner, and private Document checks as an administrator's deactivation (ADR 0095).
 *
 * @returns A run that reports deactivated, blocked, and deferred members.
 */
export function createProductionMemberAccessExpiryRun(): () => Promise<MemberAccessExpiryResult> {
  const { workspaceAccess } = createProductionTenantWorkspaceAccess()
  const documents = new DynamoDbDocumentsClient()
  const planning = new DynamoDbPlanningClient()
  const projectManagerGuard = new DynamoDbEnterpriseScimProjectManagerGuard()
  return async () => {
    const result = await deactivateExpiredMembers({
      workspaceAccess,
      documents,
      planning,
      projectManagerGuard,
      now: () => new Date(),
    })
    if (result.blocked.length > 0) {
      // Member keys are email addresses, so only the Workspace and the blocker are logged.
      console.warn(JSON.stringify({
        message: 'Expired members still manage or own resources and stay unable to sign in.',
        blocked: result.blocked,
      }))
    }
    return result
  }
}
