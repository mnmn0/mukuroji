// Shared HTTP integration fixtures used by domain-owned adapter tests.
import { expect } from 'bun:test'
import type { DynamoDBDocumentClient, TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import {
  AUTOMATION_SCHEMA_VERSION,
  type AnalyticsQueryInput,
  type ApiScope,
  type BulkOperation,
  type ApprovalRequest,
  type CustomFieldValue,
  type ProjectQuickAccessItem,
  type ProjectQuickAccessPreferences,
  type UpdateProjectQuickAccessPreferencesInput,
  type WorkItemConfiguration,
  type WorkItemRelation,
  type CanonicalWorkItem,
  type WorkItemSchedule,
  WORK_ITEM_SCHEMA_VERSION,
  createDefaultDueDateWorkItemSchedule,
} from '@mukuroji/contracts'
import type { LambdaEvent } from 'hono/aws-lambda'
import {
  createAuditEvent,
  createMutationAuditContext,
  type MutationAuditContext,
} from '../../modules/audit/audit'
import {
  CognitoServiceError,
} from '../../modules/authentication'
import { type CollaborationClient } from '../../modules/collaboration/collaboration'
import type { NotificationClient, NotificationItem } from '../../modules/notifications/notifications'
import { type FileProofingClient } from '../../modules/files/file-proofing'
import {
  createApp,
  createApiHandler,
} from '../../app/createApp'
import {
  createTestAppDependencies,
  overrideAppDependencies,
} from '../../app/composition/api-dependencies'
import {
  runWithAppDependencies,
} from '../api-router'
import {
  DynamoDbProjectDirectoryClient,
  ProjectDataError,
  type ProjectArchiveWorkItemRevisionGuard,
  type ProjectRole,
} from '../../modules/directory'
import type {
  AppDependencyOverrides,
  AppDependencies,
} from '../../app/composition/app-dependencies'
import {
  WorkspaceAccessError,
  type WorkspaceAccessClient,
  type WorkspaceMember,
  type WorkspaceMemberStatus,
  type WorkspaceRole,
} from '../../modules/workspace-access'
import {
  AutomationError,
  type AutomationBulkOperationPort,
  type AutomationInboundWebhookEndpointRecord,
  type AutomationInboundWebhookProvisioning,
} from '../../modules/automation'
import {
  DEFAULT_WORK_ITEM_CONFIGURATION,
  type WorkItemConfigurationClient,
} from '../../modules/work-items/work-item-configuration'
import {
  deriveWorkItemScheduleDueDate,
  isWorkItemSchedule,
  type CreateTeamIssueRequestBody,
  type TeamIssueDetailReadOptions,
  type TeamIssuesClient,
  type UpdateTeamIssueRequestBody,
  type WorkItemAuthorizationSnapshot,
} from '../../modules/work-items'
import { type DocumentClient } from '../../modules/documents'
import { InMemoryPlanningClient } from '../../modules/planning/planning'
import {
  InMemoryEnterpriseIdentityClient,
} from '../../modules/enterprise-identity/enterprise-identity'
import { createInMemoryDeveloperPlatformAdapters } from '../../modules/developer-platform/adapter-out/in-memory/developer-platform-adapters'
import {
  createEnterpriseScimGroupJobWorkerHandler,
} from '../../handlers/enterprise-scim-group-job-worker-handler'
import {
  createEnterpriseScimGroupJobProcessor,
} from '../../modules/enterprise-identity/enterprise-scim-group-job-worker'
import type {
  EnterpriseScimGroupJobProcessor,
} from '../../modules/enterprise-identity/application/ports/scim-group-job-processor'

const enterpriseScimGroupJobProcessors = new WeakMap<
  InMemoryEnterpriseIdentityClient,
  EnterpriseScimGroupJobProcessor
>()

const HEADLESS_DEVELOPER_WORKSPACE_ID = 'workspace-headless'

/** Mutable state owned by one domain test suite. */
type ApiTestHarnessState = {
  /** Dependency graph currently bound to the suite application. */
  dependencies: AppDependencies
  /** Application rebuilt after each dependency override. */
  application: ReturnType<typeof createApp>
}

/**
 * Applies dependency overrides to one suite-owned test application.
 *
 * @param state - Mutable state owned by the calling test suite.
 * @param dependencies - Ports to replace for subsequent requests.
 */
function setTestAppDependencies(
  state: ApiTestHarnessState,
  dependencies: AppDependencyOverrides,
) {
  state.dependencies = overrideAppDependencies(state.dependencies, {
    ...dependencies,
    workspaceSearchProjectionEnabled: dependencies.workspaceSearch
      ? true
      : state.dependencies.workItems.workspaceSearchProjectionEnabled,
  })
  state.application = createApp(state.dependencies)
}

/**
 * Resets one suite-owned application to the default test dependency graph.
 *
 * @param state - Mutable state owned by the calling test suite.
 */
function resetTestApp(state: ApiTestHarnessState) {
  state.dependencies = createTestAppDependencies()
  state.application = createApp(state.dependencies)
}

/**
 * Runs an operation with one suite's current dependency graph.
 *
 * @param state - Mutable state owned by the calling test suite.
 * @param operation - Operation to execute inside the dependency context.
 * @returns The operation result.
 */
function runWithTestAppDependencies<Result>(
  state: ApiTestHarnessState,
  operation: () => Result,
): Result {
  return runWithAppDependencies(state.dependencies, operation)
}

const originalBulkRecoveryTitle = 'Initial title'

function createBulkRecoveryIssue() {
  const schedule = createDefaultDueDateWorkItemSchedule('2026-07-31')
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    id: 'onboarding-friction',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    title: originalBulkRecoveryTitle,
    description: 'Initial description',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'in-progress',
    statusCategory: 'started',
    customFieldValues: {},
    relationIds: [],
    dueDate: deriveWorkItemScheduleDueDate(schedule),
    schedule,
    priority: 'high',
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    source: 'dynamodb',
  }
}

/**
 * Resolves a canonical schedule for an API test double without inferring it from another field.
 *
 * @param value - Candidate schedule supplied by the request.
 * @param currentSchedule - Existing canonical schedule retained by updates that omit schedule.
 * @returns The validated request schedule or the existing schedule for a partial update.
 */
function resolveApiTestWorkItemSchedule(
  value: unknown,
  currentSchedule?: WorkItemSchedule,
): WorkItemSchedule {
  if (isWorkItemSchedule(value)) {
    return value
  }
  if (value === undefined && currentSchedule) {
    return currentSchedule
  }
  throw new Error('API test request must contain a canonical Work Item schedule.')
}

function createBulkOperationAutomationFake(initialOperation?: BulkOperation) {
  let storedOperation = initialOperation ? structuredClone(initialOperation) : undefined
  const client: AutomationBulkOperationPort = {
    async getBulkOperation(workspaceId: string, operationId: string) {
      return storedOperation?.workspaceId === workspaceId && storedOperation.id === operationId
        ? structuredClone(storedOperation)
        : undefined
    },
    async createBulkOperation(operation: BulkOperation) {
      if (storedOperation) return false
      storedOperation = structuredClone(operation)
      return true
    },
    async saveBulkOperation(operation: BulkOperation, expectedRevision: number) {
      if (!storedOperation || storedOperation.revision !== expectedRevision) {
        throw new AutomationError(
          'conflict',
          'BulkOperationRevisionConflict',
          'Bulk operation was modified concurrently.',
        )
      }
      storedOperation = structuredClone(operation)
    },
  }
  return { client }
}

function createInboundWebhookEndpointRecord(
  overrides: Partial<AutomationInboundWebhookEndpointRecord> = {},
): AutomationInboundWebhookEndpointRecord {
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'webhook-1',
    workspaceId: 'user#demo@example.com',
    opaqueEndpointId: 'A'.repeat(43),
    name: 'Build events',
    status: 'active',
    version: 1,
    secretGeneration: 1,
    revision: 2,
    endpointUrl: `https://api.example.com/api/automation/inbound-webhooks/${'A'.repeat(43)}`,
    secretId: `mukuroji/automation-inbound-webhooks/${'b'.repeat(64)}/webhook-1`,
    secretVersionId: 'c'.repeat(64),
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:01.000Z',
    ...overrides,
  }
}

function createInboundWebhookProvisioning(
  endpoint: AutomationInboundWebhookEndpointRecord,
  kind: 'create' | 'rotate',
): AutomationInboundWebhookProvisioning {
  const operationId = `inbound_operation_${kind}_${'d'.repeat(32)}`
  return {
    endpoint: {
      ...endpoint,
      status: 'provisioning',
      provisioningOperationId: operationId,
      provisioningTargetStatus: 'active',
    },
    operation: {
      id: operationId,
      workspaceId: endpoint.workspaceId,
      actorId: 'demo@example.com',
      kind,
      endpointId: endpoint.id,
      requestFingerprint: 'e'.repeat(64),
      status: 'provisioning',
      targetStatus: 'active',
      endpointVersion: endpoint.version,
      endpointRevision: endpoint.revision,
      secretGeneration: endpoint.secretGeneration,
      secretId: endpoint.secretId,
      secretVersionId: endpoint.secretVersionId,
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
      recoveryExpiresAt: '2099-07-17T00:00:00.000Z',
    },
  }
}

/** Notification visibility API test に使う render-ready item を作ります。 */
function createNotificationItem(
  overrides: Partial<NotificationItem> = {},
): NotificationItem {
  return {
    id: 'notification-item',
    eventId: 'notification-event',
    eventType: 'work-item.updated',
    reasons: ['status-change'],
    teamId: 'core-team',
    projectId: 'refero',
    issueId: 'notification-item',
    occurredAt: '2026-07-12T12:00:00.000Z',
    state: 'unread',
    ...overrides,
  }
}

/** NotificationClient 経由で API の current visibility 判定結果を記録します。 */
function createNotificationVisibilityProbe(notifications: NotificationItem[]) {
  const visibility = new Map<string, boolean>()
  const client: NotificationClient = {
    async list(input) {
      const visibleNotifications: NotificationItem[] = []
      for (const notification of notifications) {
        const isVisible = !input.isVisible || await input.isVisible(notification)
        visibility.set(notification.id, isVisible)
        if (isVisible) {
          visibleNotifications.push(notification)
        }
      }
      return { notifications: visibleNotifications }
    },
    async countUnread(input) {
      let count = 0
      for (const notification of notifications) {
        const isVisible = !input.isVisible || await input.isVisible(notification)
        visibility.set(notification.id, isVisible)
        if (isVisible && notification.state === 'unread') {
          count += 1
        }
      }
      return count
    },
    async update() {
      throw new Error('Notification update is not configured for this visibility test.')
    },
    async markAllRead() {
      return 0
    },
    async getPreferences() {
      return {
        version: 0,
        channels: { inApp: true, email: false, push: false },
        frequency: 'instant',
        quietHours: { enabled: false, start: '22:00', end: '07:00', timeZone: 'UTC' },
      }
    },
    async savePreferences(input) {
      return {
        ...input.preferences,
        version: input.preferences.version + 1,
        updatedAt: '2026-07-12T13:00:00.000Z',
      }
    },
  }
  return { client, visibility }
}

function createProjectMemberFixtureItems(
  options: {
    /** owner Team ambiguity を再現する追加 Team です。 */
    additionalTeams?: Array<{
      /** Team ID です。 */
      id: string
      /** Team 表示名です。 */
      name: string
      /** Team 配下 project 一覧です。 */
      projects: Array<{
        /** Project ID です。 */
        id: string
        /** Project 表示名です。 */
        name: string
        /** Project tone です。 */
        tone: 'blue' | 'purple' | 'green' | 'yellow'
      }>
    }>
    archivedProject?: boolean
    archivedTeam?: boolean
    includeOtherManager?: boolean
    includeTargetMember?: boolean
    targetRole?: ProjectRole
  } = {},
) {
  const includeOtherManager = options.includeOtherManager ?? true
  const includeTargetMember = options.includeTargetMember ?? true
  const targetRole = options.targetRole ?? 'manager'

  return [
    {
      directoryId: 'user#demo@example.com',
      entryKey: '000010#000000#TEAM#core-team',
      entryType: 'team',
      teamId: 'core-team',
      teamSortOrder: 10,
      nameJa: 'コアチーム',
      nameEn: 'Core Team',
      expanded: true,
      ...(options.archivedTeam ? { archivedAt: '2026-06-08T00:00:00.000Z' } : {}),
    },
    {
      directoryId: 'user#demo@example.com',
      entryKey: '000010#000010#PROJECT#refero',
      entryType: 'project',
      teamId: 'core-team',
      teamSortOrder: 10,
      projectId: 'refero',
      projectSortOrder: 10,
      nameJa: 'Refero',
      nameEn: 'Refero',
      tone: 'blue',
      ...(options.archivedProject ? { archivedAt: '2026-06-08T00:00:00.000Z' } : {}),
    },
    ...(includeTargetMember
      ? [
          {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
            entryType: 'project-member',
            projectId: 'refero',
            memberKey: 'demo@example.com',
            email: 'demo@example.com',
            role: targetRole,
            createdAt: '2026-06-08T00:00:00.000Z',
            updatedAt: '2026-06-08T00:00:00.000Z',
          },
        ]
      : []),
    ...(includeOtherManager
      ? [
          {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#zmanager@example.com',
            entryType: 'project-member',
            projectId: 'refero',
            memberKey: 'zmanager@example.com',
            email: 'zmanager@example.com',
            role: 'manager',
            createdAt: '2026-06-08T00:00:00.000Z',
            updatedAt: '2026-06-08T00:00:00.000Z',
          },
        ]
      : []),
  ]
}

function createSharedProjectCapacityClient(teamCount: number) {
  const transactions: Array<Record<string, unknown>> = []
  const directoryItems = [
    ...Array.from({ length: teamCount }, (_, index) => {
      const sortOrder = index + 1
      const teamId = `team-${sortOrder}`
      return [
        {
          directoryId: 'workspace-1',
          entryKey: `${String(sortOrder).padStart(6, '0')}#000000#TEAM#${teamId}`,
          entryType: 'team',
          teamId,
          teamSortOrder: sortOrder,
          nameJa: `Team ${sortOrder}`,
          nameEn: `Team ${sortOrder}`,
          expanded: true,
        },
        {
          directoryId: 'workspace-1',
          entryKey:
            `${String(sortOrder).padStart(6, '0')}#000010#PROJECT#shared-project`,
          entryType: 'project',
          teamId,
          teamSortOrder: sortOrder,
          projectId: 'shared-project',
          projectSortOrder: 10,
          nameJa: 'Shared project',
          nameEn: 'Shared project',
          tone: 'blue',
        },
      ]
    }).flat(),
    {
      directoryId: 'workspace-1',
      entryKey: 'PROJECT_MEMBER#shared-project#viewer@example.com',
      entryType: 'project-member',
      projectId: 'shared-project',
      memberKey: 'viewer@example.com',
      email: 'viewer@example.com',
      role: 'member',
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    },
  ]
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      if ('KeyConditionExpression' in command.input) {
        return { Items: directoryItems }
      }
      if ('TransactItems' in command.input) {
        transactions.push(command.input)
      }
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  return {
    client: new DynamoDbProjectDirectoryClient(
      'DirectoryTable',
      documentClient,
      undefined,
      false,
      undefined,
      'WorkspaceAccessTable',
    ),
    transactions,
  }
}

function createDirectoryMutationAuditContext() {
  return createMutationAuditContext({
    workspaceId: 'user#demo@example.com',
    actor: { id: 'demo-sub', kind: 'user' },
    idempotencyKey: 'directory-mutation-request',
    occurredAt: '2026-07-12T00:00:00.000Z',
    request: { method: 'PATCH', path: '/api/projects/refero/members/demo@example.com' },
    source: { kind: 'api', requestId: 'directory-mutation-request' },
  })
}

function createFakeAuditEvent() {
  const context = createMutationAuditContext({
    workspaceId: 'user#demo@example.com',
    actor: { id: 'demo-sub', kind: 'user' },
    idempotencyKey: 'audit-export-request',
    occurredAt: '2026-07-12T00:00:00.000Z',
    request: { method: 'GET', path: '/api/audit/events/export' },
    source: { kind: 'api', requestId: 'audit-export-request' },
  })

  return createAuditEvent({
    context,
    expiresAt: 2_000_000_000,
    eventType: 'project.updated',
    entity: { type: 'project', id: 'refero' },
  })
}

function createFileProofingStub(
  overrides: Partial<FileProofingClient> = {},
): FileProofingClient {
  const unsupported = async () => {
    throw new Error('Unexpected file proofing client call.')
  }
  return {
    list: unsupported,
    findFileById: unsupported,
    createUpload: unsupported,
    createVersionUpload: unsupported,
    completeUpload: unsupported,
    createAccess: unsupported,
    listAnnotations: unsupported,
    createAnnotation: unsupported,
    deleteFile: unsupported,
    createApproval: unsupported,
    createWorkItemApproval: unsupported,
    decideApproval: unsupported,
    cancelApproval: unsupported,
    async getApprovalSummary() {
      return {
        pendingCount: 0,
        overdueCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
        changesRequestedCount: 0,
      }
    },
    async getApprovalSummaries() {
      return new Map()
    },
    listReviewerApprovals: unsupported,
    ...overrides,
  } as FileProofingClient
}

function createCollaborationStub(
  overrides: Partial<CollaborationClient> = {},
): CollaborationClient {
  const unsupported = async () => {
    throw new Error('Unexpected collaboration client call.')
  }
  return {
    async isTeamIssueCommentBackfillComplete() {
      return true
    },
    validateBackfillTeamIssueComment: unsupported,
    getThread: unsupported,
    hasAttachableComment: unsupported,
    getCommentSnapshot: unsupported,
    async getCommentMutationReplay() {
      return undefined
    },
    getCuratedContext: unsupported,
    async getCuratedContextMutationReplay() {
      return undefined
    },
    getCuratedContextRevisions: unsupported,
    getCuratedContextItemSnapshot: unsupported,
    getAcceptedResolutionHistory: unsupported,
    createCuratedContextItem: unsupported,
    updateCuratedContextItem: unsupported,
    setAcceptedResolution: unsupported,
    createComment: unsupported,
    updateComment: unsupported,
    deleteComment: unsupported,
    resolveComment: unsupported,
    reopenComment: unsupported,
    addReaction: unsupported,
    removeReaction: unsupported,
    getWatcherState: unsupported,
    getMemberWatcherState: unsupported,
    subscribe: unsupported,
    unsubscribe: unsupported,
    heartbeatPresence: unsupported,
    leavePresence: unsupported,
    ...overrides,
  } satisfies CollaborationClient
}

/**
 * Creates a complete Workspace Access test double whose unconfigured methods fail immediately.
 *
 * @param overrides - Methods exercised by the calling test.
 * @returns A runtime-complete Workspace Access client.
 */
function createWorkspaceAccessFake(
  overrides: Partial<WorkspaceAccessClient> = {},
): WorkspaceAccessClient {
  const unsupported = async () => {
    throw new Error('Unexpected Workspace Access client call.')
  }
  return {
    createActiveMemberConditionCheck: unsupported,
    getMember: unsupported,
    getActiveMember: unsupported,
    getAccessSnapshot: unsupported,
    listActiveMembers: unsupported,
    createInvitation: unsupported,
    getInvitation: unsupported,
    acquireInvitationAcceptanceLock: unsupported,
    releaseInvitationAcceptanceLock: unsupported,
    markInvitationIdentityMutationStarted: unsupported,
    markInvitationDirectoryClaimCleanupRequired: unsupported,
    markInvitationDelivery: unsupported,
    markInvitationCleanupFailure: unsupported,
    markInvitationManualCleanupRequired: unsupported,
    clearInvitationCleanupFailure: unsupported,
    acknowledgeInvitationManualCleanup: unsupported,
    prepareResend: unsupported,
    revokeInvitation: unsupported,
    prepareReinvite: unsupported,
    reconcileAuthenticatedMember: unsupported,
    updateMember: unsupported,
    reconcileDirectoryMember: unsupported,
    deprovisionDirectoryMember: unsupported,
    ...overrides,
  } satisfies Required<WorkspaceAccessClient>
}

/**
 * Creates a complete Documents test double whose unconfigured methods fail immediately.
 *
 * @param overrides - Methods exercised by the calling test.
 * @returns A runtime-complete Documents client.
 */
function createDocumentFake(
  overrides: Partial<DocumentClient> = {},
): DocumentClient {
  const unsupported = async () => {
    throw new Error('Unexpected Documents client call.')
  }
  return {
    getAuthorizationRevision: unsupported,
    getManagerLifecycleSnapshot: unsupported,
    list: unsupported,
    get: unsupported,
    resolveSearchAccess: unsupported,
    create: unsupported,
    update: unsupported,
    archive: unsupported,
    restoreArchived: unsupported,
    instantiateTemplate: unsupported,
    prepareOperations: unsupported,
    applyOperations: unsupported,
    listVersions: unsupported,
    restoreVersion: unsupported,
    updatePreference: unsupported,
    listRecent: unsupported,
    getCommentCreateReplay: unsupported,
    createComment: unsupported,
    listComments: unsupported,
    resolveComment: unsupported,
    heartbeatPresence: unsupported,
    leavePresence: unsupported,
    listPresence: unsupported,
    createPublicShare: unsupported,
    listPublicShares: unsupported,
    revokePublicShare: unsupported,
    resolvePublicShare: unsupported,
    listBacklinks: unsupported,
    exportDocument: unsupported,
    prepareWorkItemDeletionFenceTransactWrite: unsupported,
    ...overrides,
  } satisfies Required<DocumentClient>
}

/**
 * Creates a complete Team Issues test double whose unconfigured methods fail immediately.
 *
 * @param overrides - Methods exercised by the calling test.
 * @returns A runtime-complete Team Issues client.
 */
function createTeamIssuesFake(
  overrides: Partial<TeamIssuesClient> = {},
): TeamIssuesClient {
  const unsupported = async () => {
    throw new Error('Unexpected Team Issues client call.')
  }
  return {
    createTriageDuplicateContextTransactionItems: () => {
      throw new Error('Unexpected Team Issues client call.')
    },
    getTeamIssues: unsupported,
    getPublicWorkItemPage: unsupported,
    getProjectIssues: unsupported,
    getTeamIssueDetail: unsupported,
    getAutomationCommentReplay: async () => false,
    createTeamIssue: unsupported,
    updateTeamIssue: unsupported,
    updateTeamIssueSchedules: unsupported,
    deleteTeamIssue: unsupported,
    ...overrides,
  } satisfies Required<TeamIssuesClient>
}

function createFileUploadSessionFixture() {
  const version = {
    id: 'version-1',
    number: 1,
    fileName: 'proof.pdf',
    contentType: 'application/pdf',
    sizeBytes: 4096,
    scanStatus: 'pending' as const,
    previewKind: 'pdf' as const,
    createdByMemberKey: 'demo@example.com',
    createdAt: '2026-07-12T00:00:00.000Z',
  }
  return {
    file: {
      id: 'file-1',
      name: 'proof.pdf',
      targetType: 'work-item' as const,
      targetId: 'issue-1',
      versionCount: 1,
      versions: [version],
      currentVersion: version,
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
      capabilities: {
        canDownload: false,
        canUploadVersion: true,
        canDelete: true,
        canAnnotate: true,
        canRequestApproval: true,
      },
    },
    version,
    upload: {
      url: 'https://objects.example.test/upload',
      method: 'PUT' as const,
      headers: {
        'content-length': '4096',
        'content-type': 'application/pdf',
      },
      expiresAt: '2026-07-12T00:10:00.000Z',
      maxSizeBytes: 2_147_483_648,
    },
  }
}

/** Approval API route test で利用する標準 request fixture です。 */
function createApprovalRequestFixture(
  overrides: Partial<Extract<ApprovalRequest, { subjectType: 'file-version' }>> = {},
): ApprovalRequest {
  return {
    id: 'approval-1',
    teamId: 'core-team',
    issueId: 'issue-1',
    subjectType: 'file-version',
    revision: 1,
    fileId: 'file-1',
    versionId: 'version-1',
    status: 'pending',
    reviewers: [{ memberKey: 'sato@example.com', status: 'pending' }],
    dueAt: '2099-07-20T00:00:00.000Z',
    requestedByMemberKey: 'demo@example.com',
    requestedByKind: 'member',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
    capabilities: { canCancel: true, canDecide: false },
    ...overrides,
  }
}

/** API integration tests で利用する scope 固定済み Work Item configuration です。 */
function createTestWorkItemConfiguration(
  scopeType: 'workspace' | 'team',
  scopeId: string,
  revision = 0,
): WorkItemConfiguration {
  return {
    ...structuredClone(DEFAULT_WORK_ITEM_CONFIGURATION),
    scopeType,
    scopeId,
    revision,
  }
}

/** 関心のある method だけ上書きできる Work Item configuration client fake です。 */
function createFakeWorkItemConfigurationClient(
  overrides: Partial<WorkItemConfigurationClient> = {},
): WorkItemConfigurationClient {
  const createResolved = (scopeType: 'workspace' | 'team', scopeId: string) => ({
    configuration: createTestWorkItemConfiguration(scopeType, scopeId),
    inheritedFrom: 'default' as const,
  })
  return {
    async getWorkspaceConfiguration(workspaceId) {
      return createResolved('workspace', workspaceId)
    },
    async getTeamConfiguration(_workspaceId, teamId) {
      return createResolved('team', teamId)
    },
    async saveWorkspaceConfiguration(workspaceId, configuration, compatibilityCheck) {
      await compatibilityCheck()
      return {
        configuration: {
          ...configuration,
          scopeType: 'workspace',
          scopeId: workspaceId,
          revision: configuration.revision + 1,
        },
      }
    },
    async saveTeamConfiguration(_workspaceId, teamId, configuration, compatibilityCheck) {
      await compatibilityCheck()
      return {
        configuration: {
          ...configuration,
          scopeType: 'team',
          scopeId: teamId,
          revision: configuration.revision + 1,
        },
      }
    },
    async listRelations() {
      return { relations: [], graphRevision: 0 }
    },
    async createRelation(_workspaceId, _teamId, input) {
      return createFakeRelationMutationResponse(input)
    },
    async deleteRelation(_workspaceId, _teamId, input) {
      return createFakeRelationMutationResponse(input)
    },
    ...overrides,
  }
}

/** Client fake の既定 relation mutation response です。 */
function createFakeRelationMutationResponse(
  input: Parameters<WorkItemConfigurationClient['createRelation']>[2],
) {
  return {
    relation: {
      sourceWorkItemId: input.sourceWorkItemId,
      targetWorkItemId: input.targetWorkItemId,
      type: input.type,
    },
    reciprocalRelation: {
      sourceWorkItemId: input.targetWorkItemId,
      targetWorkItemId: input.sourceWorkItemId,
      type: input.type,
    },
    graphRevision: input.expectedGraphRevision + 1,
  }
}

/** Audit context and call stage observed by a Workspace mutation client. */
type ObservedWorkspaceMutationAuditContext = {
  /** Workspace mutation client method that received the context. */
  stage: string
  /** Audit context supplied to the method, including a missing value. */
  context: ReturnType<typeof createMutationAuditContext> | undefined
}

/** Workspace mutation audit context の決定的な期待値です。 */
type ExpectedWorkspaceMutationAuditContext = {
  /** Context actor の安定 ID です。 */
  actorId: string
  /** Client-provided correlation ID header that the API does not trust. */
  clientCorrelationId: string
  /** Request の raw idempotency key header です。 */
  idempotencyKey: string
  /** Context fingerprint に含める canonical request body です。 */
  requestBody: unknown
  /** Context source の HTTP method です。 */
  method: string
  /** Context source と fingerprint の route path です。 */
  route: string
  /** Context が順番どおり渡される Workspace mutation client method です。 */
  stages: readonly string[]
  /** Context の canonical Workspace ID です。 */
  workspaceId: string
}

function expectStableWorkspaceMutationAuditContexts(
  observations: ObservedWorkspaceMutationAuditContext[],
  expected: ExpectedWorkspaceMutationAuditContext,
) {
  expect(observations.map(({ stage }) => stage)).toEqual([...expected.stages])
  const first = observations[0]?.context

  if (!first) {
    throw new Error('The first Workspace mutation audit context is missing.')
  }

  const expectedContext = createMutationAuditContext({
    workspaceId: expected.workspaceId,
    actor: { id: expected.actorId, kind: 'user' },
    idempotencyKey: expected.idempotencyKey,
    correlationId: first.correlationId,
    occurredAt: first.occurredAt,
    request: {
      method: expected.method,
      path: expected.route,
      body: expected.requestBody,
    },
    source: {
      kind: 'api',
      method: expected.method,
      route: expected.route,
    },
  })

  expect(first).toMatchObject({
    workspaceId: expected.workspaceId,
    actor: {
      id: expected.actorId,
      kind: 'user',
    },
    correlationId: first.correlationId,
    source: {
      kind: 'api',
      method: expected.method,
      route: expected.route,
    },
  })
  expect(first.correlationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  )
  expect(first.correlationId).not.toBe(expected.clientCorrelationId)
  expect(first.source.requestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  )
  expect(first.idempotencyKeyHash).toBe(expectedContext.idempotencyKeyHash)
  expect(first.requestFingerprint).toBe(expectedContext.requestFingerprint)

  for (const observation of observations) {
    expect(observation.context).toBe(first)
  }
}

function analyticsApiRequest(
  state: ApiTestHarnessState,
  path: string,
  body: unknown,
  method = 'POST',
) {
  return state.application.request(path, {
    method,
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

function createAnalyticsQueryInput(): AnalyticsQueryInput {
  return {
    filter: {
      period: {
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-31T23:59:59.999Z',
      },
    },
    widgets: [{
      id: 'wip',
      type: 'metric',
      title: 'WIP',
      metric: 'wip',
    }],
    asOf: '2026-07-18T08:30:00.000Z',
    timeZone: 'UTC',
  }
}

function createAnalyticsAuditEvent(
  entityType: string,
  entityId: string,
  occurredAt: string,
) {
  const context = createMutationAuditContext({
    workspaceId: 'user#demo@example.com',
    actor: { id: 'demo@example.com', kind: 'user' },
    idempotencyKey: `${entityType}-${entityId}-${occurredAt}`,
    correlationId: `correlation-${entityId}`,
    occurredAt,
    request: {
      method: 'PATCH',
      path: `/api/${entityType}/${entityId}`,
      body: { entityId },
    },
    source: {
      kind: 'api',
      method: 'PATCH',
      route: `/api/${entityType}/:id`,
    },
  })
  return createAuditEvent({
    context,
    eventType: `${entityType}.updated`,
    entity: { type: entityType, id: entityId },
    before: { state: 'before' },
    after: { state: 'after' },
    expiresAt: 2_000_000_000,
  })
}

function createHistoricalAnalyticsWorkItem(): CanonicalWorkItem {
  const schedule = createDefaultDueDateWorkItemSchedule('2026-07-31')
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 4,
    id: 'historical-item',
    teamId: 'core-team',
    assignedProjectId: 'project-after',
    title: 'Historical item',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowStatusId: 'completed',
    statusCategory: 'completed',
    workflowSchemaVersion: 1,
    customFieldValues: {},
    relationIds: [],
    dueDate: deriveWorkItemScheduleDueDate(schedule),
    schedule,
    priority: 'medium',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-17T12:00:00.000Z',
    archivedAt: '2026-07-17T12:00:00.000Z',
    archivedBy: 'demo@example.com',
    source: 'dynamodb',
  }
}

function createHistoricalAnalyticsWorkItemEvent(workItem: CanonicalWorkItem) {
  const occurredAt = '2026-07-17T12:00:00.000Z'
  const context = createMutationAuditContext({
    workspaceId: 'user#demo@example.com',
    actor: { id: 'demo@example.com', kind: 'user' },
    idempotencyKey: 'historical-item-future-change',
    correlationId: 'historical-item-correlation',
    occurredAt,
    request: {
      method: 'PATCH',
      path: `/api/teams/${workItem.teamId}/issues/${workItem.id}`,
      body: { expectedRevision: 3 },
    },
    source: {
      kind: 'api',
      method: 'PATCH',
      route: '/api/teams/:teamId/issues/:issueId',
    },
  })
  const event = createAuditEvent({
    context,
    eventType: 'work-item.updated',
    entity: {
      type: 'work-item',
      id: `team/${workItem.teamId}/issue/${workItem.id}`,
    },
    before: {
      assignedProjectId: 'project-before',
      archivedAt: undefined,
      statusCategory: 'started',
    },
    after: {
      assignedProjectId: workItem.assignedProjectId,
      archivedAt: workItem.archivedAt,
      statusCategory: workItem.statusCategory,
    },
    expiresAt: 2_000_000_000,
  })
  return {
    ...event,
    metadata: {
      ...event.metadata,
      adapter: 'canonical-work-item',
      afterRevision: workItem.revision,
      teamId: workItem.teamId,
      issueId: workItem.id,
      workItemId: workItem.id,
    },
  }
}

async function putHeadlessEnterpriseIdentityProvider(
  identity: InMemoryEnterpriseIdentityClient,
  workspaceId: string,
) {
  const now = '2026-07-20T00:00:00.000Z'
  await identity.putIdentityProvider({
    workspaceId,
    providerId: 'headless-idp',
    kind: 'oidc',
    displayName: 'Headless identity provider',
    cognitoProviderName: 'HeadlessEnterpriseOidc',
    status: 'active',
    revision: 1,
    issuer: 'https://idp.example.com',
    clientId: 'headless-enterprise-client',
    authorizationEndpoint: 'https://idp.example.com/authorize',
    tokenEndpoint: 'https://idp.example.com/token',
    jwksUri: 'https://idp.example.com/jwks',
    scopes: ['openid', 'email'],
    createdAt: now,
    updatedAt: now,
    lastTestedAt: now,
  })
}

async function putAppliedHeadlessScimUser(
  identity: InMemoryEnterpriseIdentityClient,
  workspaceId: string,
) {
  const user = await identity.upsertScimUser({
    workspaceId,
    identityProviderId: 'headless-idp',
    externalId: 'headless-demo-user',
    userName: 'demo@example.com',
    emails: ['demo@example.com'],
    active: true,
    linkedMemberKey: 'demo@example.com',
    idempotencyKey: 'headless-demo-user-created',
  })
  const desired = (await identity.getSnapshot(workspaceId)).scimUsers.find((candidate) =>
    candidate.userId === user.userId
  )
  if (!desired) throw new Error('Expected the headless SCIM user to exist.')
  return identity.markScimUserApplied(
    workspaceId,
    desired.userId,
    desired.version,
  )
}

async function configureHeadlessDeveloperCredential(
  state: ApiTestHarnessState,
  identity: InMemoryEnterpriseIdentityClient,
  scopes: ApiScope[],
) {
  const workspaceId = HEADLESS_DEVELOPER_WORKSPACE_ID
  const platform = createInMemoryDeveloperPlatformAdapters()
  const apiKey = await platform.apiKeys.createApiKey({
    workspaceId,
    createdByUserId: 'demo@example.com',
    input: {
      name: 'Headless Enterprise RBAC test key',
      scopes,
      expiresAt: '2027-07-20T00:00:00.000Z',
    },
  })
  setTestAppDependencies(state, {
    ...platform,
    enterpriseIdentity: identity,
  })
  return apiKey.secret
}

function requestHeadlessWorkItem(
  state: ApiTestHarnessState,
  secret: string,
  workItemId: string,
) {
  return state.application.request(
    `http://localhost/api/v1/work-items/${encodeURIComponent(workItemId)}?teamId=core-team`,
    { headers: { Authorization: `Bearer ${secret}` } },
  )
}

function createHeadlessWorkItem(
  state: ApiTestHarnessState,
  secret: string,
  assignedProjectId: string,
  idempotencyKey: string,
) {
  return state.application.request('http://localhost/api/v1/work-items', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      teamId: 'core-team',
      title: 'Headless Enterprise Work Item',
      assigneeUserId: 'sato@example.com',
      assignedProjectId,
      schedule: createDefaultDueDateWorkItemSchedule('2026-07-31'),
      priority: 'medium',
    }),
  })
}

/**
 * Detaches a quick-access preference returned by the shared HTTP fixture.
 *
 * @param preference - Versioned preference to copy.
 * @returns A preference whose item collection shares no mutable references.
 */
function cloneProjectQuickAccessPreferences(
  preference: ProjectQuickAccessPreferences,
): ProjectQuickAccessPreferences {
  return {
    items: cloneProjectQuickAccessItems(preference.items),
    revision: preference.revision,
  }
}

/**
 * Detaches a complete quick-access replacement input for call assertions.
 *
 * @param input - Replacement input supplied to the fake client.
 * @returns An input whose item collection shares no mutable references.
 */
function cloneProjectQuickAccessInput(
  input: UpdateProjectQuickAccessPreferencesInput,
): UpdateProjectQuickAccessPreferencesInput {
  return {
    items: cloneProjectQuickAccessItems(input.items),
    revision: input.revision,
  }
}

/**
 * Copies ordered Team-owned Project identities.
 *
 * @param items - Ordered identities to detach.
 * @returns New identity objects in the same order.
 */
function cloneProjectQuickAccessItems(
  items: readonly ProjectQuickAccessItem[],
): ProjectQuickAccessItem[] {
  return items.map((item) => ({
    projectId: item.projectId,
    teamId: item.teamId,
  }))
}

function configureFakeProjectClients(
  state: ApiTestHarnessState,
  hasProjectAccess: boolean,
  options: {
    /** Cognito user pagination fake が page ごとに返す user ID と token です。 */
    cognitoUserPages?: Array<{ userIds: string[]; nextToken?: string }>
    /** Cognito principal へ設定する明示的な Workspace directory ID です。 */
    directoryId?: string
    /** Cognito user 一覧 fake が返す次 page token です。 */
    cognitoUsersNextToken?: string
    profileError?: Error
    /** 指定した active member を Workspace guest として返します。 */
    guestWorkspaceMemberKeys?: string[]
    inactiveWorkspaceMemberKeys?: string[]
    mentionAccessDeniedMemberKeys?: string[]
    /** NEW_PASSWORD_REQUIRED challenge で Cognito が返す error です。 */
    newPasswordChallengeError?: CognitoServiceError
    /** Cognito federation provider inspection fake が返す provider details です。 */
    cognitoProviderDetails?: Record<string, string>
    /** Cognito SSO app client inspection fake の既定 contract を上書きします。 */
    cognitoSsoClientDetails?: {
      allowedOAuthFlows?: string[]
      allowedOAuthFlowsUserPoolClient?: boolean
      allowedOAuthScopes?: string[]
      callbackUrls?: string[]
      explicitAuthFlows?: string[]
      hasClientSecret?: boolean
      supportedIdentityProviders?: string[]
    }
    newPasswordChallengeTokens?: boolean
    /** MFA challenge 応答 fake が返す Cognito error です。 */
    mfaChallengeError?: CognitoServiceError
    /** MFA challenge 応答 fake が token set を返すかどうかです。 */
    mfaChallengeTokens?: boolean
    /** Password login fake が返す MFA challenge です。 */
    passwordMfaChallenge?: 'SOFTWARE_TOKEN_MFA' | 'SMS_MFA' | 'SMS_OTP' | 'EMAIL_OTP'
    passwordAuthChallenge?: boolean
    passwordAuthTokens?: boolean
    projectAccesses?: Array<{
      /** Project identifier returned by the fake access directory. */
      projectId: string
      /** Optional role granted to the authenticated member. */
      role?: ProjectRole
      /** Canonical owner Team when the test exercises duplicate Project IDs. */
      teamId?: string
    }>
    role?: ProjectRole
    /** Cognito current group membership fake が返す group 名です。 */
    cognitoUserGroups?: string[]
    /** Cognito current group membership の取得障害です。 */
    cognitoUserGroupsError?: Error
    systemAdminMemberKeys?: string[]
    taskAssigneeUserId?: string
    /** Notification 認可で再取得する Work Item の現在 assigned Project ID です。 */
    detailAssignedProjectId?: string
    /** Work Item ID ごとに detail fake が返す現在 assigned Project ID です。 */
    detailAssignedProjectIds?: Record<string, string>
    /** `${teamId}\0${workItemId}` key ごとに detail fake が返す current revision です。 */
    detailRevisions?: Partial<Record<`${string}\0${string}`, number>>
    /** Notification 認可で再取得する Work Item の現在担当者です。 */
    detailAssigneeUserId?: string
    /** Detail fake が返す現在の設定済み custom field values です。 */
    detailCustomFieldValues?: Record<string, CustomFieldValue>
    /** Detail fake が返す現在の canonical schedule です。 */
    detailSchedule?: WorkItemSchedule
    /** `${teamId}\0${workItemId}` key ごとに detail fake が返す canonical schedule です。 */
    detailSchedules?: Partial<Record<`${string}\0${string}`, WorkItemSchedule>>
    /** Detail fake が返す legacy search custom fields です。 */
    /** Detail fake が TeamIssueNotFound を返す Work Item ID です。 */
    detailMissingIssueIds?: string[]
    /** Work Item detail read の障害を再現する error です。 */
    detailReadError?: Error
    /** Work Item detail read の同時実行を観測または制御する hook です。 */
    detailReadHook?: (issueId: string) => Promise<void>
    /** Detail fake が返す現在の設定済み workflow status ID です。 */
    detailWorkflowStatusId?: string
    /** Detail fake が read ごとに返す workflow status ID です。 */
    detailWorkflowStatusIds?: string[]
    /** Detail fake が read ごとに返す更新日時です。 */
    detailUpdatedAts?: string[]
    /** Schedule preview fake が返す可視 Work Item relation です。 */
    workItemRelations?: WorkItemRelation[]
    /** Schedule preview fake が返す relation graph revision です。 */
    workItemRelationGraphRevision?: number
    /** Project 作成 transaction と template application receipt の同時確定を再現する hook です。 */
    projectCreateHook?: (
      input: Record<string, unknown>,
      completionTransactItems: NonNullable<TransactWriteCommandInput['TransactItems']>,
    ) => Promise<void> | void
    /** Project archive transaction guards observed after scope validation. */
    projectArchiveHook?: (input: {
      /** Planning revision that the directory transaction must advance. */
      expectedPlanningRevision: number
      /** Canonical dependency endpoint revisions checked by the transaction. */
      workItemRevisionGuards: readonly ProjectArchiveWorkItemRevisionGuard[]
    }) => Promise<void> | void
    /** Canonical Work Item create transaction 直前の競合を再現する hook です。 */
    issueCreateHook?: (input: CreateTeamIssueRequestBody) => Promise<void> | void
    /** Canonical Work Item update transaction 直前の認可競合を再現する hook です。 */
    issueUpdateHook?: (input: {
      /** Application-level authorization generations supplied to the adapter. */
      authorizationSnapshot?: WorkItemAuthorizationSnapshot
      /** App-owned Planning revision fence supplied to the adapter. */
      planningRevisionFence?: UpdateTeamIssueRequestBody['planningRevisionFence']
      /** Updated Team-local Work Item identifier. */
      issueId: string
    }) => Promise<void> | void
    /** Canonical Work Item delete の transaction 配線を観測する hook です。 */
    issueDeleteHook?: (input: {
      /** Authorization generation checks です。 */
      authorizationConditionChecks: NonNullable<TransactWriteCommandInput['TransactItems']>
      /** Application-level authorization generations supplied to the adapter. */
      authorizationSnapshot?: WorkItemAuthorizationSnapshot
      /** Named deletion fences です。 */
      deletionFences: ReadonlyArray<{
        /** Fence の競合分類名です。 */
        kind: string
        /** 同じ transaction へ渡す DynamoDB action です。 */
        transactWriteItem: NonNullable<TransactWriteCommandInput['TransactItems']>[number]
      }>
      /** Delete 対象 Work Item ID です。 */
      issueId: string
    }) => Promise<void> | void
    teamProjects?: Array<{ id: string; name: string; tone: 'blue' | 'purple' | 'green' | 'yellow' }>
    /** owner Team ambiguity を再現する追加 Team です。 */
    additionalTeams?: Array<{
      /** Team ID です。 */
      id: string
      /** Team 表示名です。 */
      name: string
      /** Team 配下 project 一覧です。 */
      projects: Array<{
        /** Project ID です。 */
        id: string
        /** Project 表示名です。 */
        name: string
        /** Project tone です。 */
        tone: 'blue' | 'purple' | 'green' | 'yellow'
      }>
    }>
    /** Project 別 canonical Work Item fake が返す Issue ID です。 */
    canonicalProjectIssueIds?: string[]
    /** Project quick access fake が最初に返す viewer preference です。 */
    projectQuickAccessPreference?: ProjectQuickAccessPreferences
    /** Team Issue fake が返す canonical Work Item 数です。 */
    teamIssueCount?: number
    /** Team Issue fake の先頭に置く閲覧不可 Work Item 数です。 */
    inaccessibleTeamIssueCount?: number
    unassignedIssue?: boolean
    workspaceRole?: WorkspaceRole
    workspaceReconcileFailures?: number
    workspaceStatus?: WorkspaceMemberStatus
    /** Invitation provisioning 時に Cognito user が存在しない状態を再現します。 */
    workspaceUserMissing?: boolean
    /** AdminCreateUser と競合して temporary-password user が作成された状態を再現します。 */
    workspaceProvisionRace?: boolean
  } = {},
) {
  const role = 'role' in options ? options.role : 'manager'
  const workspaceRole = options.workspaceRole ?? 'owner'
  const workspaceStatus = options.workspaceStatus ?? 'active'
  let workspaceReconcileFailures = options.workspaceReconcileFailures ?? 0
  let projectQuickAccessPreference = options.projectQuickAccessPreference === undefined
    ? { items: [], revision: 0 }
    : cloneProjectQuickAccessPreferences(options.projectQuickAccessPreference)
  const calls = {
    accessChecks: [] as Array<{ directoryId: string; projectId: string }>,
    cognitoIdentityProviderDescriptions: [] as string[],
    cognitoSsoAppClientDescriptions: [] as string[],
    directoryReads: [] as Array<{
      directoryId: string
      locale: string
      consistentRead?: boolean
    }>,
    memberDeletes: [] as Array<{ directoryId: string; projectId: string; memberKey: string }>,
    memberReads: [] as Array<{ directoryId: string; projectId: string }>,
    memberUpdates: [] as Array<{
      directoryId: string
      memberKey: string
      projectId: string
      role: string
    }>,
    projectArchives: [] as Array<{
      directoryId: string
      expectedPlanningRevision: number
      teamId: string
      projectId: string
      workItemRevisionGuards?: ProjectArchiveWorkItemRevisionGuard[]
    }>,
    projectCreates: [] as Array<{
      creatorUserKey: string
      directoryId: string
      name: string
      teamId: string
    }>,
    roleChecks: [] as Array<{ directoryId: string; memberKey: string; projectId: string }>,
    summaryReads: [] as Array<{
      directoryId: string
      isSystemAdmin: boolean
      userKey: string
    }>,
    teamArchives: [] as Array<{
      directoryId: string
      expectedPlanningRevision: number
      teamId: string
    }>,
    teamCreates: [] as Array<{ directoryId: string; name: string }>,
    issueCreates: [] as Array<{
      actorUserId: string
      assignedProjectId?: unknown
      directoryId: string
      teamId: string
      title: string
      statusCategory?: unknown
      workflowStatusId?: unknown
    }>,
    issueDetails: [] as Array<{
      directoryId: string
      issueId: string
      teamId: string
      readOptions?: TeamIssueDetailReadOptions
    }>,
    issueReads: [] as Array<{ directoryId: string; limit?: number; teamId: string }>,
    publicIssuePageReads: [] as Array<{
      directoryId: string
      teamId: string
      limit: number
      cursor?: string
    }>,
    issueUpdates: [] as Array<{
      actorUserId: string
      assignedProjectId?: unknown
      authorizationSnapshot?: WorkItemAuthorizationSnapshot
      planningRevisionFence?: UpdateTeamIssueRequestBody['planningRevisionFence']
      directoryId: string
      issueId: string
      teamId: string
    }>,
    scheduleCascades: [] as Array<{
      directoryId: string
      guardedWorkItemIds: string[]
      updatedWorkItemIds: string[]
    }>,
    issueDeletes: [] as Array<{
      actorUserId: string
      directoryId: string
      issueId: string
      teamId: string
    }>,
    projectIssueReads: [] as Array<{ directoryId: string; limit?: number; projectId: string }>,
    projectQuickAccessReads: [] as Array<{
      consistentRead?: boolean
      directoryId: string
      memberKey: string
    }>,
    projectQuickAccessReplacements: [] as Array<{
      directoryId: string
      input: UpdateProjectQuickAccessPreferencesInput
      memberKey: string
    }>,
    userLists: [] as Array<{
      directoryId?: string
      limit?: number
      paginationToken?: string
      query?: string
    }>,
    userProfiles: [] as string[],
    workspaceInvitationResends: [] as string[],
    workspaceMutationAuditContexts: [] as ObservedWorkspaceMutationAuditContext[],
    workspaceMemberUpdates: [] as Array<{
      expectedDocumentAuthorizationRevision?: number
      expectedPlanningRevision: number
      memberKey: string
      role?: WorkspaceRole
      status?: WorkspaceMemberStatus
    }>,
    workspaceReconciliations: [] as string[],
    mfaChallenges: [] as Array<{
      challenge: string
      code: string
      email: string
      session: string
    }>,
  }
  const workspaceInvitationInputs = new Map<string, {
    name?: string
    role: WorkspaceRole
  }>()
  const deletedIssueIds = new Set<string>()
  const createWorkspaceMember = (memberKey: string) => ({
    id: memberKey,
    memberKey,
    email: memberKey,
    name: memberKey === 'demo@example.com' ? 'Demo User' : undefined,
    role: memberKey === 'demo@example.com'
      ? workspaceRole
      : options.guestWorkspaceMemberKeys?.includes(memberKey)
        ? 'guest' as WorkspaceRole
        : 'member' as WorkspaceRole,
    status: memberKey === 'demo@example.com'
      ? workspaceStatus
      : options.inactiveWorkspaceMemberKeys?.includes(memberKey)
        ? 'deactivated' as WorkspaceMemberStatus
        : 'active' as WorkspaceMemberStatus,
    version: 1,
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  })
  const createFakeTeamIssues = (teamId: string) =>
    Array.from({ length: options.teamIssueCount ?? 1 }, (_, index) => ({
      schemaVersion: WORK_ITEM_SCHEMA_VERSION,
      revision: 1,
      id: index === 0 ? 'onboarding-friction' : `work-item-${index}`,
      teamId,
      assignedProjectId: options.detailAssignedProjectIds?.[
        index === 0 ? 'onboarding-friction' : `work-item-${index}`
      ] ?? (index < (options.inaccessibleTeamIssueCount ?? 0)
        ? 'private-project'
        : options.unassignedIssue ? undefined : 'refero'),
      title: index === 0
        ? '初回オンボーディングの離脱要因を減らす'
        : `Work Item ${index}`,
      description: '初回体験の摩擦を下げる。',
      assigneeUserId: 'sato@example.com',
      creatorMemberKey: 'demo@example.com',
      workflowSchemaVersion: 1 as const,
      workflowStatusId: 'in-progress',
      statusCategory: 'started' as const,
      customFieldValues: {},
      relationIds: [],
      dueDate: '2026-06-18',
      schedule: createDefaultDueDateWorkItemSchedule('2026-06-18'),
      priority: 'high' as const,
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z',
      source: 'dynamodb' as const,
    }))

  setTestAppDependencies(state, {
    collaboration: createCollaborationStub({
      async getThread() {
        return {
          comments: [],
          watch: {
            subscribed: false,
            explicit: false,
            automatic: false,
            reasons: [],
            watcherCount: 0,
          },
          presence: [],
        }
      },
      async getCommentSnapshot(input) {
        return {
          id: input.commentId,
          rootCommentId: input.commentId,
          authorMemberKey: 'demo@example.com',
          bodyMarkdown: 'Search body',
          version: 1,
          mentionMemberKeys: [],
          createdAt: '2026-06-08T01:00:00.000Z',
          updatedAt: '2026-06-08T01:00:00.000Z',
          acceptedResolutions: [],
          reactions: [],
        }
      },
    }),
    enterpriseIdentity: new InMemoryEnterpriseIdentityClient(),
    cognito: {
      async initiatePasswordAuth() {
        if (options.passwordMfaChallenge) {
          return {
            ChallengeName: options.passwordMfaChallenge,
            ChallengeParameters: {
              CODE_DELIVERY_DESTINATION: '***-***-1234',
              CODE_DELIVERY_DELIVERY_MEDIUM: 'SMS',
            },
            Session: 'mfa-session',
          }
        }
        if (options.passwordAuthChallenge) {
          return {
            ChallengeName: 'NEW_PASSWORD_REQUIRED',
            Session: 'new-password-session',
          }
        }

        if (options.passwordAuthTokens) {
          return { AuthenticationResult: createFakeAuthTokenSet() }
        }

        return {}
      },
      async respondToNewPasswordChallenge() {
        if (options.newPasswordChallengeError) {
          throw options.newPasswordChallengeError
        }

        if (options.newPasswordChallengeTokens) {
          return { AuthenticationResult: createFakeAuthTokenSet() }
        }

        return {}
      },
      async respondToMfaChallenge(email, challenge, code, session) {
        calls.mfaChallenges.push({ email, challenge, code, session })
        if (options.mfaChallengeError) throw options.mfaChallengeError
        if (options.mfaChallengeTokens) {
          return { AuthenticationResult: createFakeAuthTokenSet() }
        }
        return {}
      },
      async getUser() {
        return {
          Username: 'demo@example.com',
          UserAttributes: [
            {
              Name: 'email',
              Value: 'Demo@Example.com',
            },
            ...(options.directoryId
              ? [{
                  Name: 'custom:directory_id',
                  Value: options.directoryId,
                }]
              : []),
          ],
        }
      },
      async listUsers(input) {
        calls.userLists.push(input)
        const page = options.cognitoUserPages?.[calls.userLists.length - 1]

        if (page) {
          return {
            users: page.userIds.map(createFakeCognitoProfile),
            nextToken: page.nextToken,
          }
        }

        return {
          users: [createFakeCognitoProfile('sato@example.com')],
          nextToken: options.cognitoUsersNextToken,
        }
      },
      async getUserProfile(userId) {
        calls.userProfiles.push(userId)

        if (options.profileError) {
          throw options.profileError
        }

        return createFakeCognitoProfile(userId)
      },
      async isSystemAdmin(userId) {
        return options.systemAdminMemberKeys?.includes(userId.toLowerCase()) ?? false
      },
      async getUserGroups(userId) {
        if (options.cognitoUserGroupsError) throw options.cognitoUserGroupsError
        return [
          ...(options.cognitoUserGroups ?? []),
          ...(options.systemAdminMemberKeys?.includes(userId.toLowerCase())
            ? ['mukuroji-system-admins']
            : []),
        ]
      },
      async describeEnterpriseIdentityProvider(providerName) {
        calls.cognitoIdentityProviderDescriptions.push(providerName)
        return {
          providerName,
          providerType: 'OIDC',
          providerDetails: options.cognitoProviderDetails ?? {
            oidc_issuer: 'https://idp.example.com',
            client_id: 'enterprise-client',
          },
        }
      },
      async describeEnterpriseSsoAppClient(clientId) {
        calls.cognitoSsoAppClientDescriptions.push(clientId)
        return {
          clientId,
          hasClientSecret: options.cognitoSsoClientDetails?.hasClientSecret ?? false,
          supportedIdentityProviders:
            options.cognitoSsoClientDetails?.supportedIdentityProviders ?? ['EnterpriseOidc'],
          allowedOAuthFlowsUserPoolClient:
            options.cognitoSsoClientDetails?.allowedOAuthFlowsUserPoolClient ?? true,
          allowedOAuthFlows:
            options.cognitoSsoClientDetails?.allowedOAuthFlows ?? ['code'],
          allowedOAuthScopes:
            options.cognitoSsoClientDetails?.allowedOAuthScopes ??
              ['openid', 'email', 'profile'],
          explicitAuthFlows:
            options.cognitoSsoClientDetails?.explicitAuthFlows ??
              ['ALLOW_REFRESH_TOKEN_AUTH'],
          callbackUrls: options.cognitoSsoClientDetails?.callbackUrls ?? [
            Bun.env.COGNITO_SSO_REDIRECT_URI ??
              'https://app.example.com/api/auth/sso/callback',
          ],
        }
      },
      async findWorkspaceUser(userId) {
        if (options.workspaceUserMissing || options.workspaceProvisionRace) {
          return undefined
        }

        return {
          profile: {
            ...createFakeCognitoProfile(userId),
            status: 'FORCE_CHANGE_PASSWORD',
          },
          identityId: `sub-${userId.toLowerCase()}`,
          directoryId: 'user#demo@example.com',
        }
      },
      async provisionWorkspaceUser(input) {
        if (options.workspaceProvisionRace) {
          await input.beforeDirectoryClaimUpdate(`sub-${input.email}`, input.email)
          calls.workspaceInvitationResends.push(input.email)
          return {
            profile: {
              ...createFakeCognitoProfile(input.email),
              status: 'FORCE_CHANGE_PASSWORD',
            },
            cognitoIdentityId: `sub-${input.email}`,
            cognitoUsername: input.email,
            identityOwnership: 'ambiguous',
            directoryClaimCleanupRequired: true,
            deliveryStatus: 'sent',
          }
        }

        return {
          profile: createFakeCognitoProfile(input.email),
          cognitoIdentityId: `sub-${input.email}`,
          cognitoUsername: input.email,
          identityOwnership: input.existingUser ? 'pre-existing' : 'workspace-created',
          directoryClaimCleanupRequired: false,
          deliveryStatus: input.existingUser ? 'not-required' : 'sent',
        }
      },
      async resendWorkspaceUserInvitation(userId) {
        calls.workspaceInvitationResends.push(userId)
      },
      async deleteWorkspaceUser() {
        return 'deleted'
      },
      async unlinkWorkspaceUser() {
        return 'completed'
      },
    },
    dashboardSummary: {
      async getSummary(directoryId, accessContext) {
        calls.summaryReads.push({
          directoryId,
          isSystemAdmin: accessContext.isSystemAdmin,
          userKey: accessContext.userKey,
        })

        return {
          projects: 1,
          tasks: 1,
          blocked: 0,
          updatedAt: '2026-06-03T00:00:00.000Z',
          source: 'dynamodb',
        }
      },
    },
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async listRelations() {
        return {
          relations: (options.workItemRelations ?? []).map((relation) => ({ ...relation })),
          graphRevision: options.workItemRelationGraphRevision ?? 0,
        }
      },
    }),
    projectDirectory: {
      async createActiveReferenceConditionChecks(directoryId, teamId, projectId) {
        if (projectId && !hasProjectAccess) {
          throw new ProjectDataError(404, 'ProjectNotFound', 'Project is unavailable.')
        }
        return [
          {
            ConditionCheck: {
              TableName: 'DirectoryTable',
              Key: { directoryId, entryKey: `TEAM#${teamId}` },
              ConditionExpression: 'attribute_exists(directoryId)',
            },
          },
          ...(projectId
            ? [{
                ConditionCheck: {
                  TableName: 'DirectoryTable',
                  Key: { directoryId, entryKey: `PROJECT#${projectId}` },
                  ConditionExpression: 'attribute_exists(directoryId)',
                },
              }]
            : []),
        ]
      },
      async createProjectAccessConditionCheck(directoryId, projectId, memberKey) {
        if (!hasProjectAccess) return undefined
        return {
          ConditionCheck: {
            TableName: 'DirectoryTable',
            Key: { directoryId, entryKey: `PROJECT_MEMBER#${projectId}#${memberKey}` },
            ConditionExpression: 'attribute_exists(directoryId)',
          },
        }
      },
      async getProjectDirectory(directoryId, locale, consistentRead) {
        calls.directoryReads.push({
          directoryId,
          locale,
          ...(consistentRead === undefined ? {} : { consistentRead }),
        })

        return {
          teams: [
            {
              id: 'core-team',
              name: locale === 'en' ? 'Core Team' : 'コアチーム',
              expanded: true,
              projects: options.teamProjects ?? [
                {
                  id: 'refero',
                  name: 'Refero',
                  tone: 'blue',
                },
              ],
            },
            ...(options.additionalTeams ?? []).map((team) => ({
              ...team,
              expanded: true,
            })),
          ],
        }
      },
      async getProjectQuickAccess(directoryId, memberKey, consistentRead) {
        calls.projectQuickAccessReads.push({
          directoryId,
          memberKey,
          ...(consistentRead === undefined ? {} : { consistentRead }),
        })
        return cloneProjectQuickAccessPreferences(projectQuickAccessPreference)
      },
      async replaceProjectQuickAccess(directoryId, memberKey, input) {
        const detachedInput = cloneProjectQuickAccessInput(input)
        calls.projectQuickAccessReplacements.push({
          directoryId,
          input: detachedInput,
          memberKey,
        })
        projectQuickAccessPreference = {
          items: detachedInput.items,
          revision: detachedInput.revision + 1,
        }
        return cloneProjectQuickAccessPreferences(projectQuickAccessPreference)
      },
      async getProjectAccess(directoryId, projectId, memberKey = 'demo@example.com') {
        calls.accessChecks.push({ directoryId, projectId })

        if (options.mentionAccessDeniedMemberKeys?.includes(memberKey)) {
          return undefined
        }

        if (options.projectAccesses) {
          return options.projectAccesses.find((access) => access.projectId === projectId)
        }

        if (!hasProjectAccess) {
          return undefined
        }

        return {
          projectId,
          role,
        }
      },
      async getProjectAccessList(directoryId, memberKey = 'demo@example.com') {
        calls.accessChecks.push({ directoryId, projectId: '*' })

        if (options.mentionAccessDeniedMemberKeys?.includes(memberKey)) {
          return []
        }

        if (options.projectAccesses) {
          return options.projectAccesses
        }

        if (!hasProjectAccess) {
          return []
        }

        return [
          {
            projectId: 'refero',
            role,
          },
        ]
      },
      async hasProjectAccess(directoryId, projectId) {
        calls.accessChecks.push({ directoryId, projectId })

        return hasProjectAccess
      },
      async getProjectRole(directoryId, projectId, memberKey) {
        calls.roleChecks.push({ directoryId, projectId, memberKey })

        if (options.projectAccesses) {
          return options.projectAccesses.find((access) => access.projectId === projectId)?.role
        }

        return role
      },
      async getProjectMembers(directoryId, projectId) {
        calls.memberReads.push({ directoryId, projectId })

        return {
          projectId,
          members: [
            {
              id: 'demo@example.com',
              email: 'demo@example.com',
              role: 'manager',
              updatedAt: '2026-06-08T00:00:00.000Z',
            },
          ],
        }
      },
      async updateProjectMember(directoryId, projectId, memberKey, input) {
        calls.memberUpdates.push({
          directoryId,
          memberKey,
          projectId,
          role: String(input.role),
        })

        return {
          member: {
            id: memberKey,
            email: String(input.email ?? memberKey),
            name: typeof input.name === 'string' ? input.name : undefined,
            role: input.role === 'member' ? 'member' : input.role === 'manager' ? 'manager' : 'viewer',
            updatedAt: '2026-06-08T00:00:00.000Z',
          },
        }
      },
      async removeProjectMember(directoryId, projectId, memberKey) {
        calls.memberDeletes.push({ directoryId, projectId, memberKey })

        return {
          projectId,
          memberId: memberKey,
        }
      },
      async createTeam(directoryId, input) {
        calls.teamCreates.push({ directoryId, name: String(input.name) })

        return {
          team: {
            id: 'new-team',
            name: String(input.name),
            expanded: true,
            projects: [],
          },
        }
      },
      async createProject(
        directoryId,
        teamId,
        input,
        creator,
        _auditContext,
        completionTransactItems = [],
      ) {
        calls.projectCreates.push({
          creatorUserKey: creator.userKey,
          directoryId,
          name: String(input.name),
          teamId,
        })
        await options.projectCreateHook?.(
          input as Record<string, unknown>,
          completionTransactItems,
        )

        return {
          project: {
            id: typeof input.idempotencyResourceId === 'string'
              ? input.idempotencyResourceId
              : 'new-project',
            name: String(input.nameJa ?? input.name),
            tone: input.tone === 'blue' ||
                input.tone === 'purple' ||
                input.tone === 'green' ||
                input.tone === 'yellow'
              ? input.tone
              : 'green',
          },
        }
      },
      async archiveTeam(directoryId, teamId, _auditContext, expectedPlanningRevision) {
        calls.teamArchives.push({ directoryId, expectedPlanningRevision, teamId })

        return {
          teamId,
          archivedAt: '2026-06-06T00:00:00.000Z',
        }
      },
      async archiveProject(
        directoryId,
        teamId,
        projectId,
        _auditContext,
        expectedPlanningRevision,
        workItemRevisionGuards,
      ) {
        const detachedGuards = workItemRevisionGuards.map((guard) => ({ ...guard }))
        calls.projectArchives.push({
          directoryId,
          expectedPlanningRevision,
          teamId,
          projectId,
          ...(detachedGuards.length === 0
            ? {}
            : { workItemRevisionGuards: detachedGuards }),
        })
        await options.projectArchiveHook?.({
          expectedPlanningRevision,
          workItemRevisionGuards: detachedGuards,
        })

        return {
          teamId,
          projectId,
          archivedAt: '2026-06-06T00:00:00.000Z',
        }
      },
    },
    workspaceAccess: {
      async createActiveMemberConditionCheck(workspaceId, memberKey) {
        const member = createWorkspaceMember(memberKey)
        if (member.status !== 'active') return undefined
        return {
          ConditionCheck: {
            TableName: 'WorkspaceAccessTable',
            Key: { workspaceId, recordKey: `MEMBER#${memberKey}` },
            ConditionExpression: 'attribute_exists(workspaceId)',
          },
        }
      },
      async getMember(_workspaceId, memberKey) {
        return createWorkspaceMember(memberKey)
      },
      async getActiveMember(_workspaceId, memberKey) {
        const member = createWorkspaceMember(memberKey)
        return member.status === 'active' ? member : undefined
      },
      async listActiveMembers() {
        return [
          createWorkspaceMember('demo@example.com'),
          createWorkspaceMember('sato@example.com'),
          createWorkspaceMember('suzuki@example.com'),
          createWorkspaceMember('viewer@example.com'),
        ].filter((member) => member.status === 'active')
      },
      async getAccessSnapshot(_workspaceId, memberKey) {
        const currentMember = createWorkspaceMember(memberKey)
        return {
          currentMember,
          members: [currentMember, createWorkspaceMember('sato@example.com')],
          invitations: [],
          capabilities: {
            canInvite: currentMember.role === 'owner' || currentMember.role === 'admin',
            canManageMembers: currentMember.role === 'owner' || currentMember.role === 'admin',
            canManageAdmins: currentMember.role === 'owner',
          },
        }
      },
      async getInvitation() {
        return undefined
      },
      async acquireInvitationAcceptanceLock() {
        return undefined
      },
      async releaseInvitationAcceptanceLock() {
        throw new Error('Acceptance lock fake is not configured for this test.')
      },
      async markInvitationIdentityMutationStarted(
        _workspaceId,
        invitationId,
        expectedVersion,
        cognitoIdentityId,
        cognitoUsername,
        auditContext,
      ) {
        calls.workspaceMutationAuditContexts.push({
          stage: 'markInvitationIdentityMutationStarted',
          context: auditContext,
        })
        return {
          id: invitationId,
          email: invitationId,
          name: workspaceInvitationInputs.get(invitationId)?.name,
          role: workspaceInvitationInputs.get(invitationId)?.role ?? 'member',
          status: 'provisioning',
          deliveryStatus: 'pending',
          identityOwnership: 'ambiguous',
          identityLifecycleVersion: 2,
          cognitoIdentityId,
          cognitoUsername,
          identityMutationAttempted: true,
          version: expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async markInvitationDirectoryClaimCleanupRequired(
        _workspaceId,
        invitationId,
        expectedVersion,
        cognitoIdentityId,
        cognitoUsername,
        auditContext,
      ) {
        calls.workspaceMutationAuditContexts.push({
          stage: 'markInvitationDirectoryClaimCleanupRequired',
          context: auditContext,
        })
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'provisioning',
          deliveryStatus: 'pending',
          identityOwnership: 'ambiguous',
          cognitoIdentityId,
          cognitoUsername,
          directoryClaimCleanupRequired: true,
          version: expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async createInvitation(_workspaceId, _actorMemberKey, input, _expiresInDays, auditContext) {
        calls.workspaceMutationAuditContexts.push({ stage: 'createInvitation', context: auditContext })
        workspaceInvitationInputs.set(input.email, { name: input.name, role: input.role })
        return {
          id: input.email,
          email: input.email,
          name: input.name,
          role: input.role,
          status: 'provisioning',
          deliveryStatus: 'pending',
          identityOwnership: 'ambiguous',
          version: 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async markInvitationDelivery(_workspaceId, invitationId, input, auditContext) {
        calls.workspaceMutationAuditContexts.push({
          stage: 'markInvitationDelivery',
          context: auditContext,
        })
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: input.deliveryStatus === 'failed' ? 'delivery-failed' : 'pending',
          deliveryStatus: input.deliveryStatus,
          identityOwnership: input.identityOwnership,
          cognitoIdentityId: input.cognitoIdentityId,
          cognitoUsername: input.cognitoUsername,
          directoryClaimCleanupRequired: input.directoryClaimCleanupRequired,
          version: input.expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async markInvitationCleanupFailure(_workspaceId, invitationId, input, auditContext) {
        calls.workspaceMutationAuditContexts.push({
          stage: 'markInvitationCleanupFailure',
          context: auditContext,
        })
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'workspace-created',
          version: input.expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
          failureMessage: input.failureMessage,
        }
      },
      async clearInvitationCleanupFailure(
        _workspaceId,
        invitationId,
        expectedVersion,
        auditContext,
      ) {
        calls.workspaceMutationAuditContexts.push({
          stage: 'clearInvitationCleanupFailure',
          context: auditContext,
        })
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'workspace-created',
          version: expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async markInvitationManualCleanupRequired() {
        throw new Error('Manual invitation cleanup fake is not configured for this test.')
      },
      async acknowledgeInvitationManualCleanup() {
        throw new Error('Manual invitation cleanup acknowledgement fake is not configured for this test.')
      },
      async prepareResend() {
        throw new Error('Invitation fake is not configured for this test.')
      },
      async revokeInvitation() {
        throw new Error('Invitation fake is not configured for this test.')
      },
      async prepareReinvite() {
        throw new Error('Invitation fake is not configured for this test.')
      },
      async reconcileAuthenticatedMember(_workspaceId, input, auditContext) {
        calls.workspaceMutationAuditContexts.push({
          stage: 'reconcileAuthenticatedMember',
          context: auditContext,
        })
        calls.workspaceReconciliations.push(input.memberKey)

        if (workspaceReconcileFailures > 0) {
          workspaceReconcileFailures -= 1
          throw new WorkspaceAccessError(
            503,
            'WorkspaceAccessUnavailable',
            'Workspace membership update failed.',
          )
        }

        return createWorkspaceMember(input.memberKey)
      },
      async updateMember(_workspaceId, _actorMemberKey, memberKey, input, auditContext) {
        calls.workspaceMutationAuditContexts.push({ stage: 'updateMember', context: auditContext })
        calls.workspaceMemberUpdates.push({
          ...(input.expectedDocumentAuthorizationRevision === undefined
            ? {}
            : {
                expectedDocumentAuthorizationRevision:
                  input.expectedDocumentAuthorizationRevision,
              }),
          expectedPlanningRevision: input.expectedPlanningRevision,
          memberKey,
          ...(input.role === undefined ? {} : { role: input.role }),
          ...(input.status === undefined ? {} : { status: input.status }),
        })
        return {
          ...createWorkspaceMember(memberKey),
          role: input.role ?? createWorkspaceMember(memberKey).role,
          status: input.status ?? createWorkspaceMember(memberKey).status,
          version: input.expectedVersion + 1,
        }
      },
    },
    teamIssues: {
      async getTeamIssues(directoryId, teamId, readOptions) {
        calls.issueReads.push({
          directoryId,
          teamId,
          ...(readOptions?.limit === undefined ? {} : { limit: readOptions.limit }),
        })

        const issues = createFakeTeamIssues(teamId)
        return {
          teamId,
          issues: readOptions?.limit === undefined ? issues : issues.slice(0, readOptions.limit),
        }
      },
      async getPublicWorkItemPage(directoryId, teamId, readOptions) {
        calls.publicIssuePageReads.push({
          directoryId,
          teamId,
          limit: readOptions.limit,
          ...(readOptions.cursor ? { cursor: readOptions.cursor } : {}),
        })
        return {
          issues: createFakeTeamIssues(teamId).slice(0, readOptions.limit),
        }
      },
      async getProjectIssues(directoryId, projectId, readOptions) {
        calls.projectIssueReads.push({
          directoryId,
          projectId,
          ...(readOptions?.limit === undefined ? {} : { limit: readOptions.limit }),
        })

        const issues = options.canonicalProjectIssueIds
          ? options.canonicalProjectIssueIds.map((issueId, index) => ({
              schemaVersion: WORK_ITEM_SCHEMA_VERSION,
              revision: 1,
              id: issueId,
              teamId: 'core-team',
              assignedProjectId: projectId,
              title: `Canonical Work Item ${index}`,
              assigneeUserId: 'sato@example.com',
              creatorMemberKey: 'demo@example.com',
              workflowSchemaVersion: 1 as const,
              workflowStatusId: 'in-progress',
              statusCategory: 'started' as const,
              customFieldValues: {},
              relationIds: [],
              dueDate: '2026-06-18',
              schedule: createDefaultDueDateWorkItemSchedule('2026-06-18'),
              priority: 'high' as const,
              createdAt: '2026-06-08T00:00:00.000Z',
              updatedAt: '2026-06-08T00:00:00.000Z',
              source: 'dynamodb' as const,
            }))
          : [
              {
                schemaVersion: WORK_ITEM_SCHEMA_VERSION,
                revision: 1,
                id: 'onboarding-friction',
                teamId: 'core-team',
                assignedProjectId: projectId,
                title: '初回オンボーディングの離脱要因を減らす',
                assigneeUserId: 'sato@example.com',
                creatorMemberKey: 'demo@example.com',
                workflowSchemaVersion: 1 as const,
                workflowStatusId: 'in-progress',
                statusCategory: 'started' as const,
                customFieldValues: {},
                relationIds: [],
                dueDate: '2026-06-18',
                schedule: createDefaultDueDateWorkItemSchedule('2026-06-18'),
                priority: 'high' as const,
                createdAt: '2026-06-08T00:00:00.000Z',
                updatedAt: '2026-06-08T00:00:00.000Z',
                source: 'dynamodb' as const,
              },
            ]
        return {
          projectId,
          issues: readOptions?.limit === undefined ? issues : issues.slice(0, readOptions.limit),
        }
      },
      async getTeamIssueDetail(directoryId, teamId, issueId, readOptions) {
        const detailReadIndex = calls.issueDetails.length
        calls.issueDetails.push({
          directoryId,
          teamId,
          issueId,
          ...(readOptions ? { readOptions } : {}),
        })
        await options.detailReadHook?.(issueId)

        if (options.detailReadError) {
          throw options.detailReadError
        }

        if (
          issueId === 'wireframe' ||
          deletedIssueIds.has(issueId) ||
          options.detailMissingIssueIds?.includes(issueId)
        ) {
          throw {
            status: 404,
            code: 'TeamIssueNotFound',
            message: 'Issue was not found.',
          }
        }
        const workflowStatusId = options.detailWorkflowStatusIds?.[detailReadIndex] ??
          options.detailWorkflowStatusId ??
          'in-progress'
        const detailSchedule = options.detailSchedules?.[`${teamId}\0${issueId}`] ??
          options.detailSchedule ??
          createDefaultDueDateWorkItemSchedule('2026-06-18')

        return {
          issue: {
            schemaVersion: WORK_ITEM_SCHEMA_VERSION,
            revision: options.detailRevisions?.[`${teamId}\0${issueId}`] ?? 1,
            id: issueId,
            teamId,
            assignedProjectId: options.detailAssignedProjectIds?.[issueId] ??
              (options.unassignedIssue
                ? undefined
                : options.detailAssignedProjectId ?? 'refero'),
            title: '初回オンボーディングの離脱要因を減らす',
            description: '初回体験の摩擦を下げる。',
            assigneeUserId: options.detailAssigneeUserId ?? 'sato@example.com',
            creatorMemberKey: 'demo@example.com',
            workflowSchemaVersion: 1,
            workflowStatusId,
            statusCategory:
              workflowStatusId === 'done' || workflowStatusId === 'approval-complete'
                ? 'completed'
                : 'started',
            customFieldValues: options.detailCustomFieldValues ?? {},
            relationIds: [],
            dueDate: deriveWorkItemScheduleDueDate(detailSchedule),
            schedule: detailSchedule,
            priority: 'high',
            createdAt: '2026-06-08T00:00:00.000Z',
            updatedAt: options.detailUpdatedAts?.[detailReadIndex] ??
              '2026-06-08T00:00:00.000Z',
            source: 'dynamodb',
          },
          comments: [],
          activity: [
            {
              id: 'activity-1',
              type: 'created',
              actorUserId: 'demo@example.com',
              summary: 'Issue was created.',
              createdAt: '2026-06-08T00:00:00.000Z',
            },
          ],
        }
      },
      async createTeamIssue(directoryId, teamId, input, actorUserId) {
        await options.issueCreateHook?.(input)
        calls.issueCreates.push({
          actorUserId,
          assignedProjectId: input.assignedProjectId,
          directoryId,
          teamId,
          title: String(input.title),
          ...(input.statusCategory === undefined
            ? {}
            : { statusCategory: input.statusCategory }),
          ...(input.workflowStatusId === undefined
            ? {}
            : { workflowStatusId: input.workflowStatusId }),
        })

        const schedule = resolveApiTestWorkItemSchedule(input.schedule)
        return {
          issue: {
            schemaVersion: WORK_ITEM_SCHEMA_VERSION,
            revision: 1,
            id: 'new-issue',
            teamId,
            assignedProjectId: typeof input.assignedProjectId === 'string'
              ? input.assignedProjectId
              : undefined,
            title: String(input.title),
            description: typeof input.description === 'string' ? input.description : undefined,
            assigneeUserId: String(input.assigneeUserId),
            creatorMemberKey: actorUserId,
            workflowSchemaVersion: 1,
            workflowStatusId: String(input.workflowStatusId),
            statusCategory: input.statusCategory === 'backlog' ||
              input.statusCategory === 'unstarted' ||
              input.statusCategory === 'started' ||
              input.statusCategory === 'completed' ||
              input.statusCategory === 'canceled'
              ? input.statusCategory
              : 'unstarted',
            customFieldValues: input.customFieldValues as Record<string, CustomFieldValue>,
            relationIds: [],
            dueDate: deriveWorkItemScheduleDueDate(schedule),
            schedule,
            priority: 'medium',
            createdAt: '2026-06-08T00:00:00.000Z',
            updatedAt: '2026-06-08T00:00:00.000Z',
            source: 'dynamodb',
          },
        }
      },
      async updateTeamIssue(directoryId, teamId, issueId, input, actorUserId) {
        await options.issueUpdateHook?.({
          authorizationSnapshot: input.authorizationSnapshot,
          planningRevisionFence: input.planningRevisionFence,
          issueId,
        })
        calls.issueUpdates.push({
          actorUserId,
          assignedProjectId: input.assignedProjectId,
          ...(input.authorizationSnapshot
            ? { authorizationSnapshot: input.authorizationSnapshot }
            : {}),
          ...(input.planningRevisionFence
            ? { planningRevisionFence: input.planningRevisionFence }
            : {}),
          directoryId,
          issueId,
          teamId,
        })

        const schedule = resolveApiTestWorkItemSchedule(
          input.schedule,
          createDefaultDueDateWorkItemSchedule('2026-06-18'),
        )
        return {
          issue: {
            schemaVersion: WORK_ITEM_SCHEMA_VERSION,
            revision: 2,
            id: issueId,
            teamId,
            assignedProjectId: typeof input.assignedProjectId === 'string'
              ? input.assignedProjectId
              : undefined,
            title: typeof input.title === 'string' ? input.title : '初回オンボーディングの離脱要因を減らす',
            assigneeUserId: typeof input.assigneeUserId === 'string' ? input.assigneeUserId : 'sato@example.com',
            creatorMemberKey: 'demo@example.com',
            workflowSchemaVersion: 1,
            workflowStatusId: typeof input.workflowStatusId === 'string'
              ? input.workflowStatusId
              : 'in-progress',
            statusCategory: input.statusCategory === 'backlog' ||
              input.statusCategory === 'unstarted' ||
              input.statusCategory === 'started' ||
              input.statusCategory === 'completed' ||
              input.statusCategory === 'canceled'
              ? input.statusCategory
              : 'started',
            customFieldValues: input.customFieldValues as Record<string, CustomFieldValue>,
            relationIds: [],
            dueDate: deriveWorkItemScheduleDueDate(schedule),
            schedule,
            priority: input.priority === 'low' ? 'low' : 'high',
            createdAt: '2026-06-08T00:00:00.000Z',
            updatedAt: '2026-06-08T02:00:00.000Z',
            source: 'dynamodb',
          },
        }
      },
      async updateTeamIssueSchedules(
        directoryId,
        updates,
        guardedRevisions,
        _actorUserId,
        _auditContext,
        _relationGraphConditionChecks,
        _authorizationSnapshot,
        idempotency,
      ) {
        const issues = updates.map((update) => ({
            ...createFakeTeamIssues(update.teamId)[0]!,
            id: update.workItemId,
            assignedProjectId: options.detailAssignedProjectIds?.[update.workItemId] ??
              options.detailAssignedProjectId ??
              createFakeTeamIssues(update.teamId)[0]!.assignedProjectId,
            revision: update.expectedRevision + 1,
            schedule: update.schedule,
            dueDate: deriveWorkItemScheduleDueDate(update.schedule),
            updatedAt: '2026-06-08T02:00:00.000Z',
          }))
        const response = {
          issues,
          confirmedSchedules: issues.map((issue) => ({
            id: issue.id,
            teamId: issue.teamId,
            revision: issue.revision,
            schedule: issue.schedule,
            dueDate: issue.dueDate,
            ...(issue.assignedProjectId
              ? { assignedProjectId: issue.assignedProjectId }
              : {}),
          })),
        }
        await idempotency?.prepare({
          status: 200,
          body: { workItems: response.confirmedSchedules },
        })
        calls.scheduleCascades.push({
          directoryId,
          guardedWorkItemIds: guardedRevisions.map((guard) => guard.workItemId),
          updatedWorkItemIds: updates.map((update) => update.workItemId),
        })
        return response
      },
      async deleteTeamIssue(
        directoryId,
        teamId,
        issueId,
        _expectedRevision,
        actorUserId,
        _auditContext,
        _idempotency,
        deletionFences = [],
        authorizationConditionChecks = [],
        authorizationSnapshot,
      ) {
        await options.issueDeleteHook?.({
          authorizationConditionChecks,
          authorizationSnapshot,
          deletionFences,
          issueId,
        })
        calls.issueDeletes.push({ actorUserId, directoryId, issueId, teamId })
        deletedIssueIds.add(issueId)
        return {
          issue: {
            ...createFakeTeamIssues(teamId)[0]!,
            id: issueId,
          },
        }
      },
    },
  })

  return calls
}

function configureFakeAuthenticatedUser(
  state: ApiTestHarnessState,
  attributes: Record<string, string>,
  onGetUser: () => void = () => undefined,
) {
  setTestAppDependencies(state, {
    cognito: {
      ...state.dependencies.authentication.cognito,
      async initiatePasswordAuth() {
        return {}
      },
      async getUser() {
        onGetUser()

        return {
          Username: attributes.email ?? 'demo@example.com',
          UserAttributes: Object.entries(attributes).map(([Name, Value]) => ({ Name, Value })),
        }
      },
      async listUsers() {
        return { users: [] }
      },
      async getUserProfile(userId) {
        return createFakeCognitoProfile(userId)
      },
    },
  })
}

function createLambdaHttpEvent(rawPath: string, accessToken: string) {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath,
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${accessToken}`,
      host: 'example.lambda-url.us-east-1.on.aws',
    },
    body: null,
    isBase64Encoded: false,
    requestContext: {
      accountId: 'anonymous',
      apiId: 'function-url',
      authentication: null,
      authorizer: {},
      domainName: 'example.lambda-url.us-east-1.on.aws',
      domainPrefix: 'example',
      http: {
        method: 'GET',
        path: rawPath,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'bun:test',
      },
      requestId: 'request-id',
      routeKey: '$default',
      stage: '$default',
      time: '11/Jul/2026:00:00:00 +0000',
      timeEpoch: 1_783_728_000_000,
    },
  } satisfies Extract<LambdaEvent, { rawPath: string }>
}

async function drainEnterpriseScimGroupJob(
  identity: InMemoryEnterpriseIdentityClient,
  workspaceId: string,
  groupId: string,
) {
  let eventName: 'INSERT' | 'MODIFY' = 'INSERT'
  for (let page = 0; page < 1_000; page += 1) {
    if (!await processEnterpriseScimGroupJobPage(
      identity,
      workspaceId,
      groupId,
      eventName,
    )) return
    eventName = 'MODIFY'
  }
  throw new Error('SCIM group reconciliation exceeded the test page limit.')
}

async function processEnterpriseScimGroupJobPage(
  identity: InMemoryEnterpriseIdentityClient,
  workspaceId: string,
  groupId: string,
  eventName: 'INSERT' | 'MODIFY' = 'MODIFY',
) {
  const reference = await identity.getScimGroupJobReference(
    workspaceId,
    groupId,
  )
  if (!reference) return false
  const workerHandler = createEnterpriseScimGroupJobWorkerHandler(
    requireEnterpriseScimGroupJobProcessor(identity),
  )
  const result = await workerHandler({
    Records: [{
      eventSource: 'aws:dynamodb',
      eventName,
      dynamodb: {
        SequenceNumber: `sequence-${reference.revision}`,
        NewImage: {
          scopeKey: { S: `WORKSPACE#${workspaceId}` },
          recordKey: { S: `SCIM_GROUP_JOB#${reference.jobId}` },
          entryType: { S: 'enterprise-scim-group-job' },
          workspaceId: { S: workspaceId },
          jobId: { S: reference.jobId },
          revision: { N: String(reference.revision) },
        },
      },
    }],
  })
  expect(result).toEqual({ batchItemFailures: [] })
  return true
}

function requireEnterpriseScimGroupJobProcessor(
  identity: InMemoryEnterpriseIdentityClient,
) {
  const processor = enterpriseScimGroupJobProcessors.get(identity)
  if (!processor) {
    throw new Error('Enterprise SCIM group job test processor is not configured.')
  }
  return processor
}

async function withTestEnvironment(
  values: Record<string, string | undefined>,
  callback: () => Promise<void>,
) {
  const originalValues = new Map(
    Object.keys(values).map((name) => [name, Bun.env[name]]),
  )

  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) {
      delete Bun.env[name]
    } else {
      Bun.env[name] = value
    }
  }

  try {
    await callback()
  } finally {
    for (const [name, value] of originalValues) {
      if (value === undefined) {
        delete Bun.env[name]
      } else {
        Bun.env[name] = value
      }
    }
  }
}

async function configureEnterpriseScimGuestRoleScenario(
  state: ApiTestHarnessState,
  workspaceId: string,
) {
  configureFakeProjectClients(state, true)
  const identity = new InMemoryEnterpriseIdentityClient()
  const now = new Date().toISOString()
  await identity.putIdentityProvider({
    workspaceId,
    providerId: 'idp-guest-role',
    kind: 'oidc',
    displayName: 'Guest role directory',
    cognitoProviderName: 'EnterpriseOidc',
    status: 'active',
    revision: 1,
    issuer: 'https://idp.example.com',
    clientId: 'enterprise-client',
    authorizationEndpoint: 'https://idp.example.com/authorize',
    tokenEndpoint: 'https://idp.example.com/token',
    jwksUri: 'https://idp.example.com/jwks',
    scopes: ['openid', 'email'],
    createdAt: now,
    updatedAt: now,
    lastTestedAt: now,
  })
  const scimToken = (await identity.issueScimToken(
    workspaceId,
    'idp-guest-role',
    'Guest role directory',
  )).token
  const members = new Map<string, WorkspaceMember>([
    ['demo@example.com', {
      id: 'demo@example.com',
      memberKey: 'demo@example.com',
      email: 'demo@example.com',
      name: 'Demo User',
      role: 'owner',
      status: 'active',
      version: 1,
      createdAt: now,
      updatedAt: now,
    }],
    ['managed@example.com', {
      id: 'managed@example.com',
      memberKey: 'managed@example.com',
      email: 'managed@example.com',
      name: 'Managed User',
      role: 'member',
      status: 'active',
      version: 1,
      createdAt: now,
      updatedAt: now,
    }],
  ])
  const reconciledRoles: WorkspaceRole[] = []
  const reconcileAuditContexts: MutationAuditContext[] = []
  let reconcileFailures = 0
  let afterNextDirectoryReconcile: (() => Promise<void>) | undefined
  const planningClient = new InMemoryPlanningClient()
  const documentClient = {
    async getAuthorizationRevision() {
      return 0
    },
    async getManagerLifecycleSnapshot() {
      return { authorizationRevision: 0 }
    },
  } as unknown as DocumentClient
  const workspaceAccessClient = {
    async getMember(_workspaceId: string, memberKey: string) {
      return members.get(memberKey)
    },
    async getActiveMember(_workspaceId: string, memberKey: string) {
      const member = members.get(memberKey)
      return member?.status === 'active' ? member : undefined
    },
    async listActiveMembers() {
      return [...members.values()].filter((member) => member.status === 'active')
    },
    async reconcileDirectoryMember(
      _workspaceId: string,
      input: Parameters<
        NonNullable<WorkspaceAccessClient['reconcileDirectoryMember']>
      >[1],
      auditContext?: MutationAuditContext,
    ) {
      if (reconcileFailures > 0) {
        reconcileFailures -= 1
        throw new WorkspaceAccessError(
          503,
          'WorkspaceDirectoryReconcileUnavailable',
          'Directory reconciliation is temporarily unavailable.',
        )
      }
      const existing = members.get(input.memberKey)
      if (
        input.expectedVersion !== undefined &&
        existing?.version !== input.expectedVersion
      ) {
        throw new WorkspaceAccessError(
          409,
          'WorkspaceMemberVersionConflict',
          'Workspace member changed.',
        )
      }
      const member: WorkspaceMember = {
        id: input.memberKey,
        memberKey: input.memberKey,
        email: input.email,
        name: input.name,
        role: input.role,
        status: 'active',
        provisioningSource: 'directory',
        externalIdentityId: input.externalIdentityId,
        version: (existing?.version ?? 0) + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      members.set(input.memberKey, member)
      reconciledRoles.push(member.role)
      if (auditContext) reconcileAuditContexts.push(auditContext)
      const afterReconcile = afterNextDirectoryReconcile
      afterNextDirectoryReconcile = undefined
      await afterReconcile?.()
      return member
    },
    async deprovisionDirectoryMember(
      _workspaceId: string,
      memberKey: string,
      _input: Parameters<
        NonNullable<WorkspaceAccessClient['deprovisionDirectoryMember']>
      >[2],
      auditContext?: MutationAuditContext,
    ) {
      const existing = members.get(memberKey)
      if (!existing) return undefined
      const member = {
        ...existing,
        status: 'deactivated' as const,
        version: existing.version + 1,
        updatedAt: now,
      }
      members.set(memberKey, member)
      if (auditContext) reconcileAuditContexts.push(auditContext)
      return member
    },
  } as unknown as WorkspaceAccessClient
  setTestAppDependencies(state, {
    documents: documentClient,
    enterpriseIdentity: identity,
    planning: planningClient,
    workspaceAccess: workspaceAccessClient,
  })
  enterpriseScimGroupJobProcessors.set(
    identity,
    createEnterpriseScimGroupJobProcessor({
      documents: documentClient,
      enterpriseIdentity: identity,
      planning: planningClient,
      workspaceAccess: workspaceAccessClient as Required<Pick<
        WorkspaceAccessClient,
        'deprovisionDirectoryMember' | 'getMember' | 'listActiveMembers' |
          'reconcileDirectoryMember'
      >>,
      projectManagerGuard: {
        async hasManagedProject() {
          return false
        },
      },
      cognito: {
        async disableWorkspaceUser() {
          return undefined
        },
        async enableWorkspaceUser() {
          return undefined
        },
        async globallySignOutWorkspaceUser() {
          return undefined
        },
      },
    }),
  )
  return {
    identity,
    members,
    reconcileAuditContexts,
    reconciledRoles,
    scimToken,
    setAfterNextDirectoryReconcile(callback: () => Promise<void>) {
      afterNextDirectoryReconcile = callback
    },
    setReconcileFailures(value: number) {
      reconcileFailures = value
    },
  }
}

function createFakeCognitoProfile(userId: string) {
  const id = userId.trim().toLowerCase()
  const names: Record<string, string> = {
    'demo@example.com': 'Demo User',
    'sato@example.com': '佐藤 花子',
    'suzuki@example.com': '鈴木 太郎',
    'viewer@example.com': 'Viewer User',
  }

  return {
    id,
    username: id,
    email: id,
    name: names[id],
    enabled: true,
    status: 'CONFIRMED',
  }
}

function createFakeAuthTokenSet() {
  return {
    AccessToken: 'test-token',
    IdToken: 'test-id-token',
    RefreshToken: 'test-refresh-token',
    ExpiresIn: 3600,
    TokenType: 'Bearer',
  }
}

function createCognitoSdkTestError(name: string, status: number) {
  const error = new Error(`${name} from the Cognito SDK test double.`)
  error.name = name

  return Object.assign(error, {
    $metadata: { httpStatusCode: status },
  })
}

function createWorkspaceBootstrapItems() {
  return [
    {
      directoryId: 'workspace#production',
      entryKey: 'WORKSPACE#METADATA',
      entryType: 'workspace-metadata',
      workspaceId: 'workspace#production',
    },
    {
      directoryId: 'workspace#production',
      entryKey: 'WORKSPACE_MEMBER#owner@example.com',
      entryType: 'workspace-member',
      workspaceId: 'workspace#production',
      memberKey: 'owner@example.com',
      email: 'owner@example.com',
      username: 'owner-cognito-id',
      role: 'owner',
    },
    {
      directoryId: 'workspace#production',
      entryKey: 'EMAIL_ALIAS#owner@example.com',
      entryType: 'email-alias',
      workspaceId: 'workspace#production',
      memberKey: 'owner@example.com',
      email: 'owner@example.com',
      username: 'owner-cognito-id',
    },
  ]
}

function createAccessToken(groups: string[] = [], claims: Record<string, unknown> = {}) {
  const payload = Buffer
    .from(JSON.stringify({ ...claims, 'cognito:groups': groups }))
    .toString('base64url')

  return `header.${payload}.signature`
}

/**
 * Sends one authenticated Planning API request through the suite-owned application.
 *
 * @param state - Mutable harness state.
 * @param path - Planning API path.
 * @param method - HTTP method.
 * @param body - Optional JSON request body.
 * @param idempotencyKey - Optional raw idempotency header value.
 * @returns Pending HTTP response.
 */
function planningApiRequest(
  state: ApiTestHarnessState,
  path: string,
  method = 'GET',
  body?: unknown,
  idempotencyKey?: string,
) {
  return state.application.request(path, {
    method,
    headers: {
      Authorization: 'Bearer test-token',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function createCyclePlanningInput(id: string, expectedRevision: number) {
  return {
    id,
    type: 'cycle' as const,
    title: `Cycle ${id}`,
    teamId: 'core-team',
    projectId: 'refero',
    ownerMemberKey: 'demo@example.com',
    status: 'active' as const,
    health: 'on-track' as const,
    risk: 'low' as const,
    progressMode: 'automatic' as const,
    baseline: { startDate: '2026-07-01', endDate: '2026-07-14' },
    forecast: { startDate: '2026-07-01', endDate: '2026-07-14' },
    cadence: { unit: 'week' as const, count: 2 },
    capacity: 10,
    carryOverPolicy: 'move-incomplete' as const,
    expectedRevision,
  }
}

async function seedPlanningWorkspaceParentAndScopedChild(
  planningClient: InMemoryPlanningClient,
) {
  await planningClient.create('user#demo@example.com', {
    ...createCyclePlanningInput('portfolio-scope-parent', 0),
    type: 'portfolio',
    title: 'Workspace portfolio',
    teamId: undefined,
    projectId: undefined,
    cadence: undefined,
    capacity: undefined,
    carryOverPolicy: undefined,
  }, { workItems: [] })
  await planningClient.create('user#demo@example.com', {
    ...createCyclePlanningInput('roadmap-scoped-child', 1),
    type: 'roadmap',
    title: 'Scoped roadmap',
    parentId: 'portfolio-scope-parent',
    cadence: undefined,
    capacity: undefined,
    carryOverPolicy: undefined,
  }, { workItems: [] })
}

/**
 * Creates an isolated HTTP integration harness for one domain test suite.
 *
 * @returns Suite-owned application state, dependency controls, and shared fixture helpers.
 */
export function createApiTestHarness() {
  const dependencies = createTestAppDependencies()
  const state: ApiTestHarnessState = {
    dependencies,
    application: createApp(dependencies),
  }
  const app = {
    request: (...args: Parameters<typeof state.application.request>) =>
      state.application.request(...args),
  }

  return {
    HEADLESS_DEVELOPER_WORKSPACE_ID,
    analyticsApiRequest: (
      ...args: Parameters<typeof analyticsApiRequest> extends [ApiTestHarnessState, ...infer Rest]
        ? Rest
        : never
    ) => analyticsApiRequest(state, ...args),
    app,
    configureEnterpriseScimGuestRoleScenario: (workspaceId: string) =>
      configureEnterpriseScimGuestRoleScenario(state, workspaceId),
    configureFakeAuthenticatedUser: (
      attributes: Record<string, string>,
      onGetUser: () => void = () => undefined,
    ) => configureFakeAuthenticatedUser(state, attributes, onGetUser),
    configureFakeProjectClients: (
      ...args: Parameters<typeof configureFakeProjectClients> extends [ApiTestHarnessState, ...infer Rest]
        ? Rest
        : never
    ) => configureFakeProjectClients(state, ...args),
    configureHeadlessDeveloperCredential: (
      identity: InMemoryEnterpriseIdentityClient,
      scopes: ApiScope[],
    ) => configureHeadlessDeveloperCredential(state, identity, scopes),
    createAccessToken,
    createAnalyticsAuditEvent,
    createAnalyticsQueryInput,
    createApprovalRequestFixture,
    createBulkOperationAutomationFake,
    createBulkRecoveryIssue,
    createCognitoSdkTestError,
    createCollaborationStub,
    createCyclePlanningInput,
    createDirectoryMutationAuditContext,
    createDocumentFake,
    createFakeAuditEvent,
    createFakeAuthTokenSet,
    createFakeCognitoProfile,
    createFakeRelationMutationResponse,
    createFakeWorkItemConfigurationClient,
    createFileProofingStub,
    createFileUploadSessionFixture,
    createHeadlessWorkItem: (
      secret: string,
      assignedProjectId: string,
      idempotencyKey: string,
    ) => createHeadlessWorkItem(state, secret, assignedProjectId, idempotencyKey),
    createHistoricalAnalyticsWorkItem,
    createHistoricalAnalyticsWorkItemEvent,
    createInboundWebhookEndpointRecord,
    createInboundWebhookProvisioning,
    createLambdaHttpEvent,
    createNotificationItem,
    createNotificationVisibilityProbe,
    createProjectMemberFixtureItems,
    createSharedProjectCapacityClient,
    createTeamIssuesFake,
    createTestWorkItemConfiguration,
    createWorkspaceAccessFake,
    createWorkspaceBootstrapItems,
    drainEnterpriseScimGroupJob,
    enterpriseScimGroupJobProcessors,
    expectStableWorkspaceMutationAuditContexts,
    originalBulkRecoveryTitle,
    planningApiRequest: (
      path: string,
      method = 'GET',
      body?: unknown,
      idempotencyKey?: string,
    ) => planningApiRequest(state, path, method, body, idempotencyKey),
    processEnterpriseScimGroupJobPage,
    putAppliedHeadlessScimUser,
    putHeadlessEnterpriseIdentityProvider,
    requestHeadlessWorkItem: (secret: string, workItemId: string) =>
      requestHeadlessWorkItem(state, secret, workItemId),
    requireEnterpriseScimGroupJobProcessor,
    resetTestApp: () => resetTestApp(state),
    runWithTestAppDependencies: <Result>(operation: () => Result) =>
      runWithTestAppDependencies(state, operation),
    seedPlanningWorkspaceParentAndScopedChild,
    setTestAppDependencies: (overrides: AppDependencyOverrides) =>
      setTestAppDependencies(state, overrides),
    getTestAppDependencies: () => state.dependencies,
    withTestEnvironment,
    createApp,
    createApiHandler,
    overrideAppDependencies,
  }
}

export type {
  AppDependencyOverrides,
  ObservedWorkspaceMutationAuditContext,
}
