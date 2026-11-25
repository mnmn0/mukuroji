import { afterEach, describe, expect, test } from 'bun:test'
import type { EnterprisePermissionId, EnterpriseRoleAssignment, FileAttachment, FileScanStatus } from '@mukuroji/contracts'
import { createApiTestHarness } from './test-support/api-test-harness'
import { createCanonicalPublicAttachmentService } from './shared/public-attachment-access'
import { FileProofingError, type FileProofingActor, type FileProofingScope } from '../modules/files/file-proofing'
import type { MutationAuditContext } from '../modules/audit/audit'
import type { AuthenticatedDeveloperCredential } from '../modules/developer-platform/application/ports'
import { InMemoryEnterpriseIdentityClient } from '../modules/enterprise-identity/enterprise-identity'

const {
  configureFakeProjectClients,
  createFileProofingStub,
  resetTestApp,
  runWithTestAppDependencies,
  setTestAppDependencies,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

const workspaceId = 'user#demo@example.com'
const NOW = '2026-07-18T00:00:00.000Z'
const credential: AuthenticatedDeveloperCredential = {
  kind: 'api-key',
  workspaceId,
  credentialId: 'agent-key',
  subjectUserId: 'demo@example.com',
  scopes: ['work-items:read'],
}

/**
 * Creates a Work Item file whose current version has the given scan status.
 *
 * @param id - File ID.
 * @param scanStatus - Scan status of the current version.
 * @returns File as the file store lists it.
 */
function createFile(id: string, scanStatus: FileScanStatus): FileAttachment {
  const version = {
    id: `${id}-v2`,
    number: 2,
    fileName: `${id}.pdf`,
    contentType: 'application/pdf',
    sizeBytes: 2048,
    scanStatus,
    previewKind: 'pdf' as const,
    createdByMemberKey: 'demo@example.com',
    createdAt: NOW,
  }
  return {
    id,
    name: `${id}.pdf`,
    targetType: 'work-item',
    targetId: 'task-1',
    versionCount: 2,
    versions: [version],
    currentVersion: version,
    createdAt: NOW,
    updatedAt: NOW,
    capabilities: { canDownload: true, canUploadVersion: false, canDelete: false, canAnnotate: false, canRequestApproval: false },
  }
}

/** One Enterprise custom role granted to the credential owner at one Team or Project. */
type ProjectRoleGrant = {
  /** Custom role ID. */
  roleId: `custom:${string}`
  /** Permissions of the role. */
  permissions: EnterprisePermissionId[]
  /** Kind of the scope the role is granted at. */
  kind: 'team' | 'project'
  /** Team or Project the role is granted at. */
  targetId: string
}

/**
 * Creates an Enterprise identity whose only grants are the given Team- or Project-scoped custom roles.
 *
 * @param grants - Roles and the scopes they apply to.
 * @returns Enterprise identity client.
 */
async function createProjectRoleIdentity(grants: readonly ProjectRoleGrant[]) {
  const identity = new InMemoryEnterpriseIdentityClient()
  for (const grant of grants) {
    await identity.putCustomRole({
      workspaceId, roleId: grant.roleId, name: grant.roleId, permissions: grant.permissions,
      guestAssignable: false, revision: 1, createdAt: NOW, updatedAt: NOW,
    })
  }
  return new Proxy(identity, {
    get(target, property) {
      if (property === 'getSnapshot') {
        return async (requestedWorkspaceId: string) => {
          const snapshot = await target.getSnapshot(requestedWorkspaceId)
          const roleAssignments = grants.map((grant): EnterpriseRoleAssignment => ({
            workspaceId,
            assignmentId: `${grant.roleId}-assignment`,
            principalKind: 'member',
            principalId: 'demo@example.com',
            roleId: grant.roleId,
            scope: { workspaceId, kind: grant.kind, targetId: grant.targetId },
            source: 'direct',
          }))
          return { ...snapshot, roleAssignments }
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Configures a member who can view Work Items of the refero Project. */
function configureViewer() {
  configureFakeProjectClients(true, {
    directoryId: workspaceId,
    projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
    role: 'viewer',
    workspaceRole: 'member',
  })
}

describe('public attachment service', () => {
  test('lists only files whose current version passed the scan, as a read-only actor', async () => {
    configureViewer()
    const reads: { scope: FileProofingScope; actor: FileProofingActor }[] = []
    setTestAppDependencies({
      fileProofing: createFileProofingStub({
        async list(scope, actor) {
          reads.push({ scope, actor })
          return {
            files: [createFile('spec', 'available'), createFile('pending', 'pending'), createFile('blocked', 'blocked')],
            approvals: [],
            capabilities: { canUpload: false, canRequestApproval: false, canGrantGuestAccess: false },
          }
        },
      }),
    })

    const list = await runWithTestAppDependencies(() => createCanonicalPublicAttachmentService()
      .listWorkItemAttachments(credential, 'core-team', 'task-1'))

    expect(list).toEqual({
      items: [{
        id: 'spec', name: 'spec.pdf', versionId: 'spec-v2', versionNumber: 2,
        contentType: 'application/pdf', sizeBytes: 2048, updatedAt: NOW,
      }],
    })
    expect(reads[0]?.scope).toMatchObject({ workspaceId, teamId: 'core-team', kind: 'work-item', issueId: 'task-1' })
    expect(reads[0]?.actor).toEqual({ memberKey: 'demo@example.com', guest: false, canWrite: false, canManage: false })
  })

  test('refuses the files of a Work Item the credential owner cannot view', async () => {
    configureFakeProjectClients(true, {
      directoryId: workspaceId,
      projectAccesses: [{ projectId: 'other-project', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
    })
    let listed = false
    setTestAppDependencies({
      fileProofing: createFileProofingStub({
        async list() {
          listed = true
          return { files: [], approvals: [], capabilities: { canUpload: false, canRequestApproval: false, canGrantGuestAccess: false } }
        },
      }),
    })

    await expect(runWithTestAppDependencies(() => createCanonicalPublicAttachmentService()
      .listWorkItemAttachments(credential, 'core-team', 'task-1'))).rejects.toMatchObject({ status: 403 })
    expect(listed).toBe(false)
  })

  test('evaluates the file permission at the Work Item\'s own Project', async () => {
    configureFakeProjectClients(false, { directoryId: workspaceId, workspaceRole: 'member', projectAccesses: [] })
    let listed = 0
    setTestAppDependencies({
      fileProofing: createFileProofingStub({
        async list() {
          listed += 1
          return { files: [createFile('spec', 'available')], approvals: [], capabilities: { canUpload: false, canRequestApproval: false, canGrantGuestAccess: false } }
        },
      }),
    })
    /**
     * Lists task-1's attachments with the files.read grant at the given scope.
     *
     * @param kind - Scope kind of the files.read grant.
     * @param targetId - Team or Project of the files.read grant.
     * @returns The listed attachment IDs.
     */
    const listWithFileGrantAt = async (kind: 'team' | 'project', targetId: string) => {
      setTestAppDependencies({
        enterpriseIdentity: await createProjectRoleIdentity([
          { roleId: 'custom:work-item-reader', permissions: ['work-items.read'], kind: 'project', targetId: 'refero' },
          { roleId: 'custom:file-reader', permissions: ['files.read'], kind, targetId },
        ]),
      })
      const list = await runWithTestAppDependencies(() => createCanonicalPublicAttachmentService()
        .listWorkItemAttachments(credential, 'core-team', 'task-1'))
      return list.items.map((item) => item.id)
    }

    // A file grant in another Project of the Team does not open task-1's files.
    expect(await listWithFileGrantAt('project', 'other-project')).toEqual([])
    expect(listed).toBe(0)
    expect(await listWithFileGrantAt('project', 'refero')).toEqual(['spec'])
    // A Team grant covers the Team's Projects.
    expect(await listWithFileGrantAt('team', 'core-team')).toEqual(['spec'])
    expect(listed).toBe(2)
  })

  test('issues an audited download URL for a clean current version and hides the rest', async () => {
    configureViewer()
    const accesses: { fileId: string; versionId: string; disposition: string; auditContext?: MutationAuditContext }[] = []
    let failAfterListing: FileProofingError | undefined
    setTestAppDependencies({
      fileProofing: createFileProofingStub({
        async list() {
          return {
            files: [createFile('spec', 'available'), createFile('pending', 'pending')],
            approvals: [],
            capabilities: { canUpload: false, canRequestApproval: false, canGrantGuestAccess: false },
          }
        },
        async createAccess(_scope, _actor, fileId, versionId, disposition, auditContext) {
          if (failAfterListing) throw failAfterListing
          accesses.push({ fileId, versionId, disposition, ...(auditContext ? { auditContext } : {}) })
          return { url: 'https://files.example.test/spec?signature=redacted', expiresAt: '2026-07-18T00:05:00.000Z' }
        },
      }),
    })
    const service = createCanonicalPublicAttachmentService()
    /**
     * Requests a download of one fixture file of Work Item task-1.
     *
     * @param fileId - File ID.
     * @returns The download.
     */
    const download = (fileId: string) => runWithTestAppDependencies(() => service.createWorkItemAttachmentDownload(
      credential, 'core-team', 'task-1', fileId, { requestId: 'request-1', correlationId: 'corr-1' },
    ))

    expect(await download('spec')).toEqual({
      fileId: 'spec',
      versionId: 'spec-v2',
      url: 'https://files.example.test/spec?signature=redacted',
      expiresAt: '2026-07-18T00:05:00.000Z',
    })
    expect(accesses).toHaveLength(1)
    expect(accesses[0]).toMatchObject({ fileId: 'spec', versionId: 'spec-v2', disposition: 'attachment' })
    expect(accesses[0]?.auditContext).toMatchObject({ workspaceId, correlationId: 'corr-1', source: { kind: 'api', requestId: 'request-1' } })
    await expect(download('pending')).rejects.toMatchObject({ status: 404 })
    await expect(download('missing')).rejects.toMatchObject({ status: 404 })
    failAfterListing = new FileProofingError(423, 'FileThreatDetected', 'Malware scanning blocked this file.')
    await expect(download('spec')).rejects.toMatchObject({ status: 404 })
    // A file that changed after the listing read it is a conflict the client can retry.
    failAfterListing = new FileProofingError(409, 'FileVersionConflict', 'The file changed.')
    await expect(download('spec')).rejects.toMatchObject({ status: 409, code: 'conflict' })
    expect(accesses).toHaveLength(1)
  })
})
