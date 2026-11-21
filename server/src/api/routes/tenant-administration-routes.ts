import type { Hono } from 'hono'
import type { Context } from 'hono'
import {
  createTenantAdministrationRouter,
} from '../../modules/tenant-administration/adapter-in/http/tenant-administration-router'
import type { TenantExportDownload, TenantOperation } from '@mukuroji/contracts'
import { TenantAdministrationError } from '../../modules/tenant-administration'
import {
  calculateAuditExpiresAt,
  createAuditEvent,
  getConfiguredAuditRetentionDays,
} from '../../modules/audit/audit'
import { CognitoServiceError } from '../../modules/authentication'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import { workspaceDependencies } from '../shared/app-dependencies'
import { readJson, toAuthErrorResponse } from '../shared/http'
import { getEnv } from '../shared/runtime-config'
import {
  createApiMutationContext,
  requireWorkspaceAdministration,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { toWorkspaceAccessErrorResponse } from '../shared/workspace-access'

function toTenantAdministrationErrorResponse(c: Context, error: unknown) {
  if (!(error instanceof TenantAdministrationError)) {
    console.error(error)
    return c.json({ message: 'Tenant administration is unavailable.' }, 502)
  }
  if (error.status >= 500) {
    console.error(error)
  }
  const status = error.status === 400 ||
    error.status === 401 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409 ||
    error.status === 413 ||
    error.status === 429 ||
    error.status === 503
    ? error.status
    : 502
  return c.json({ code: error.code, message: error.message }, status)
}

/**
 * Requires the audit export authority that a tenant export also carries.
 *
 * A tenant export contains the Workspace audit log and earlier audit export artifacts, so it is
 * held to the same `audit.export` permission as `/api/audit/exports`. The built-in
 * `workspace:admin` role deliberately lacks that permission.
 *
 * @param principal - Authenticated Workspace principal.
 * @throws WorkspaceAccessError with status 403 when the principal may not export audit events.
 */
function requireTenantAuditDataExport(principal: WorkspacePrincipal): void {
  if (principal.isSystemAdmin || principal.enterprisePermissions?.includes('audit.export')) return
  throw new WorkspaceAccessError(
    403,
    'TenantExportAuditPermissionRequired',
    'Exporting the tenant requires permission to export audit events.',
  )
}

/**
 * Records one issuance of tenant export download links in the immutable audit log.
 *
 * Every response signs new URLs, so each issuance gets its own audit identity even when a client
 * retries the request.
 *
 * @param c - Hono request context.
 * @param principal - Authenticated Workspace principal.
 * @param operation - Completed export operation whose artifacts were signed.
 * @param download - Signed artifact locations being returned.
 * @throws TenantAdministrationError with status 503 when no audit writer is configured.
 */
async function recordTenantExportDownload(
  c: Context,
  principal: WorkspacePrincipal,
  operation: TenantOperation,
  download: TenantExportDownload,
): Promise<void> {
  const auditEvents = workspaceDependencies.auditEvents
  if (!auditEvents.putEvent) {
    throw new TenantAdministrationError(
      503,
      'TenantAuditUnavailable',
      'Tenant export download links cannot be issued without an immutable audit writer.',
    )
  }
  const metadata = {
    exportId: operation.operationId,
    partCount: download.files.length,
  }
  const context = createApiMutationContext(
    c,
    principal,
    { tenantExport: 'downloaded', ...metadata },
    `tenant-export-download:${crypto.randomUUID()}`,
  )
  await auditEvents.putEvent(createAuditEvent({
    context,
    eventType: 'tenant.export.downloaded',
    entity: { type: 'tenant', id: principal.directoryId },
    summary: 'Tenant export download links were issued.',
    metadata,
    expiresAt: calculateAuditExpiresAt(context.occurredAt, getConfiguredAuditRetentionDays()),
  }))
}

/**
 * Environment variable that CDK sets to `disabled` when the stack omits the tenant export and
 * closure workers. Any other value, including unset for local runs, keeps the routes open.
 */
const TENANT_LIFECYCLE_OPERATIONS_ENVIRONMENT = 'TENANT_LIFECYCLE_OPERATIONS'

/**
 * Registers the tenant administration HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerTenantAdministrationRoutes(routeApp: Hono): void {
  routeApp.route('/', createTenantAdministrationRouter({
    authenticate: async (accessToken, context) =>
      await authenticateWorkspacePrincipal(accessToken, undefined, context),
    requireAdministration: requireWorkspaceAdministration,
    requireAuditDataExport: requireTenantAuditDataExport,
    recordExportDownload: recordTenantExportDownload,
    get client() {
      return workspaceDependencies.tenantAdministration
    },
    get tenantExportDownload() {
      return workspaceDependencies.tenantExportDownload
    },
    get nationalHolidays() {
      return workspaceDependencies.nationalHolidays
    },
    async resolveInitialization(principal) {
      const activeMembers = await workspaceDependencies.workspaceAccess.listActiveMembers(
        principal.directoryId,
      )
      const owner = activeMembers.find((member) => member.role === 'owner')
      if (!owner) {
        throw new TenantAdministrationError(
          503,
          'TenantOwnerUnavailable',
          'The Workspace owner required for tenant initialization is unavailable.',
        )
      }
      return {
        ownerMemberKey: owner.memberKey,
      }
    },
    readJson,
    lifecycleOperationsDeployed: () =>
      getEnv(TENANT_LIFECYCLE_OPERATIONS_ENVIRONMENT)?.trim() !== 'disabled',
    mapError: (context, error) => {
      if (error instanceof CognitoServiceError) return toAuthErrorResponse(context, error)
      if (error instanceof WorkspaceAccessError) {
        return toWorkspaceAccessErrorResponse(context, error)
      }
      return toTenantAdministrationErrorResponse(context, error)
    },
  }))
}
