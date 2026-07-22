import { DynamoDbDocumentsClient } from '../../modules/documents/documents'
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
import {
  DynamoDbWorkspaceAccessClient,
} from '../../modules/workspace-access/workspace-access'

/**
 * Enterprise SCIM group job worker の production dependency graph を組み立てます。
 */
export function createEnterpriseScimGroupJobWorkerProcessor():
  EnterpriseScimGroupJobProcessor {
  const enterpriseIdentityClient = createEnterpriseIdentityClient()
  return createEnterpriseScimGroupJobProcessor({
    enterpriseIdentity: Object.freeze({
      processScimGroupJob:
        enterpriseIdentityClient.processScimGroupJob.bind(enterpriseIdentityClient),
    }),
    workspaceAccess: new DynamoDbWorkspaceAccessClient(),
    documents: new DynamoDbDocumentsClient(),
    planning: new DynamoDbPlanningClient(),
    projectManagerGuard: new DynamoDbEnterpriseScimProjectManagerGuard(),
    cognito: new AwsEnterpriseScimGroupJobCognitoClient(),
  })
}
