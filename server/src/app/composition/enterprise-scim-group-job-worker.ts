import {
  DynamoDbDocumentsClient,
} from '../../modules/documents/adapter-out/dynamodb/dynamo-db-documents-client'
import {
  AwsEnterpriseScimGroupJobCognitoClient,
} from '../../modules/enterprise-identity/adapter-out/cognito/enterprise-scim-group-job-cognito-client'
import {
  DynamoDbEnterpriseScimProjectManagerGuard,
} from '../../modules/enterprise-identity/adapter-out/dynamodb/enterprise-scim-project-manager-guard'
import type {
  EnterpriseScimGroupJobProcessor,
} from '../../modules/enterprise-identity/application/ports/scim-group-job-processor'
import {
  createEnterpriseIdentityClient,
} from '../../modules/enterprise-identity'
import {
  createEnterpriseScimGroupJobProcessor,
} from '../../modules/enterprise-identity/enterprise-scim-group-job-worker'
import { DynamoDbPlanningClient } from '../../modules/planning/planning'
import { createDynamoDbDeveloperPlatformAdapters } from '../../modules/developer-platform/adapter-out/dynamodb/developer-platform-adapters'
import type { MemberCredentialRevoker } from '../../modules/workspace-access'
import { createMemberCredentialRevoker } from './member-credential-revoker'
import { createProductionTenantWorkspaceAccess } from './tenant-administration'

/**
 * Enterprise SCIM group job worker の production dependency graph を組み立てます。
 */
export function createEnterpriseScimGroupJobWorkerProcessor():
  EnterpriseScimGroupJobProcessor {
  const enterpriseIdentityClient = createEnterpriseIdentityClient()
  const { workspaceAccess } = createProductionTenantWorkspaceAccess()
  return createEnterpriseScimGroupJobProcessor({
    enterpriseIdentity: Object.freeze({
      processScimGroupJob:
        enterpriseIdentityClient.processScimGroupJob.bind(enterpriseIdentityClient),
    }),
    workspaceAccess,
    documents: new DynamoDbDocumentsClient(),
    planning: new DynamoDbPlanningClient(),
    projectManagerGuard: new DynamoDbEnterpriseScimProjectManagerGuard(),
    cognito: new AwsEnterpriseScimGroupJobCognitoClient(),
    revokeMemberCredentials: createLazyMemberCredentialRevoker(),
  })
}

/**
 * Creates a credential revoker that connects to the developer platform store on first use, so
 * only a directory reactivation depends on that store's configuration.
 *
 * @returns The revoker.
 */
function createLazyMemberCredentialRevoker(): MemberCredentialRevoker {
  let revoker: MemberCredentialRevoker | undefined
  return (workspaceId, memberKey, actorId) => {
    revoker ??= createMemberCredentialRevoker(createDynamoDbDeveloperPlatformAdapters())
    return revoker(workspaceId, memberKey, actorId)
  }
}
