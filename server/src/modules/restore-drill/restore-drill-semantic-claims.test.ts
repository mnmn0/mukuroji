import { describe, expect, test } from 'bun:test'
import type { CrossDomainIntegrityItem } from '../data-integrity'
import {
  createRestoreDrillSemanticAuditCandidateClaims,
  createRestoreDrillSemanticAuditMemberAliasClaim,
  createRestoreDrillSemanticItemClaims,
  evaluateRestoreDrillSemanticRequirement,
  type RestoreDrillSemanticClaim,
  type RestoreDrillSemanticRequirement,
} from './restore-drill-semantic-claims'

const DIGEST_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const ORIGIN = 'a'.repeat(64)

/** Collects opaque facts from independently normalized rows. */
function collectFacts(claims: readonly RestoreDrillSemanticClaim[]): Set<string> {
  return new Set(claims.flatMap((claim) => claim.kind === 'fact' ? [claim.factToken] : []))
}

/** Returns the unique status-precedence requirement emitted for one Work Item. */
function statusRequirement(claims: readonly RestoreDrillSemanticClaim[]) {
  const requirements = claims.filter(
    (claim): claim is RestoreDrillSemanticRequirement =>
      claim.kind === 'requirement' && claim.branches.length === 3,
  )
  expect(requirements).toHaveLength(1)
  const requirement = requirements[0]
  if (!requirement) throw new Error('status requirement missing')
  return requirement
}

/** Creates one normalized Work Item for status and relation checks. */
function workItem(
  workflowStatusId: string,
  statusCategory: 'completed' | 'started' | 'unstarted',
  projectId: string | null = null,
): Extract<CrossDomainIntegrityItem, { readonly kind: 'work-item' }> {
  return {
    creatorMemberKey: 'member-1',
    kind: 'work-item',
    projectId,
    relationIds: [],
    statusCategory,
    teamId: 'team-1',
    workItemId: 'item-1',
    workflowStatusId,
    workspaceId: 'workspace-1',
  }
}

describe('restore drill opaque semantic claims', () => {
  test('selects Team configuration before Workspace configuration and built-ins', async () => {
    const itemClaims = createRestoreDrillSemanticItemClaims(
      workItem('todo', 'unstarted'),
      DIGEST_KEY,
      ORIGIN,
    )
    const workspaceClaims = createRestoreDrillSemanticItemClaims({
      kind: 'configuration',
      teamId: null,
      workflowStatuses: [{ category: 'unstarted', statusId: 'todo' }],
      workspaceId: 'workspace-1',
    }, DIGEST_KEY, 'b'.repeat(64))
    const teamClaims = createRestoreDrillSemanticItemClaims({
      kind: 'configuration',
      teamId: 'team-1',
      workflowStatuses: [],
      workspaceId: 'workspace-1',
    }, DIGEST_KEY, 'c'.repeat(64))
    const facts = collectFacts([...workspaceClaims, ...teamClaims])
    expect(await evaluateRestoreDrillSemanticRequirement(
      statusRequirement(itemClaims),
      (factToken) => facts.has(factToken),
    )).toBe('WORK_ITEM_WORKFLOW_STATUS_UNKNOWN')
  })

  test('classifies a Team category mismatch without falling through to Workspace', async () => {
    const itemClaims = createRestoreDrillSemanticItemClaims(
      workItem('custom', 'completed'),
      DIGEST_KEY,
      ORIGIN,
    )
    const workspaceClaims = createRestoreDrillSemanticItemClaims({
      kind: 'configuration',
      teamId: null,
      workflowStatuses: [{ category: 'completed', statusId: 'custom' }],
      workspaceId: 'workspace-1',
    }, DIGEST_KEY, 'b'.repeat(64))
    const teamClaims = createRestoreDrillSemanticItemClaims({
      kind: 'configuration',
      teamId: 'team-1',
      workflowStatuses: [{ category: 'started', statusId: 'custom' }],
      workspaceId: 'workspace-1',
    }, DIGEST_KEY, 'c'.repeat(64))
    const facts = collectFacts([...workspaceClaims, ...teamClaims])
    expect(await evaluateRestoreDrillSemanticRequirement(
      statusRequirement(itemClaims),
      (factToken) => facts.has(factToken),
    )).toBe('WORK_ITEM_STATUS_CATEGORY_MISMATCH')
  })

  test('uses a built-in status only when neither configuration scope exists', async () => {
    const claims = createRestoreDrillSemanticItemClaims(
      workItem('todo', 'unstarted'),
      DIGEST_KEY,
      ORIGIN,
    )
    expect(await evaluateRestoreDrillSemanticRequirement(
      statusRequirement(claims),
      () => false,
    )).toBeUndefined()
  })

  test('guards relation Project checks with actual relation endpoint facts', async () => {
    const itemClaims = createRestoreDrillSemanticItemClaims(
      workItem('todo', 'unstarted', 'project-missing'),
      DIGEST_KEY,
      ORIGIN,
    )
    const relationClaims = createRestoreDrillSemanticItemClaims({
      kind: 'relation',
      relationType: 'blocks',
      sourceWorkItemId: 'item-1',
      targetWorkItemId: 'item-2',
      teamId: 'team-1',
      workspaceId: 'workspace-1',
    }, DIGEST_KEY, 'd'.repeat(64))
    const relationProject = itemClaims.find(
      (claim): claim is RestoreDrillSemanticRequirement =>
        claim.kind === 'requirement' &&
        claim.branches[0]?.defaultFailureCode === 'RELATION_PROJECT_MISSING',
    )
    if (!relationProject) throw new Error('relation Project requirement missing')
    const relationFacts = collectFacts(relationClaims)
    expect(await evaluateRestoreDrillSemanticRequirement(
      relationProject,
      (factToken) => relationFacts.has(factToken),
    ))
      .toBe('RELATION_PROJECT_MISSING')
    expect(await evaluateRestoreDrillSemanticRequirement(
      relationProject,
      () => false,
    )).toBeUndefined()
  })

  test('classifies a File target that exists only in another Workspace as cross-tenant', async () => {
    const metadataClaims = createRestoreDrillSemanticItemClaims({
      contentType: 'text/plain',
      fileId: 'file-1',
      kind: 'file-metadata',
      objectKey: 'workspaces/workspace-1/files/file-1',
      objectVersionId: 'object-version-1',
      scanStatus: 'available',
      sizeBytes: 1,
      targetId: 'item-1',
      targetType: 'work-item',
      teamId: 'team-1',
      versionId: 'version-1',
      workspaceId: 'workspace-1',
    }, DIGEST_KEY, ORIGIN)
    const otherWorkspaceClaims = createRestoreDrillSemanticItemClaims({
      ...workItem('todo', 'unstarted'),
      workspaceId: 'workspace-2',
    }, DIGEST_KEY, 'e'.repeat(64))
    const targetRequirement = metadataClaims.find(
      (claim): claim is RestoreDrillSemanticRequirement =>
        claim.kind === 'requirement' && claim.branches[0]?.fallbacks.length === 2,
    )
    if (!targetRequirement) throw new Error('File target requirement missing')
    const otherWorkspaceFacts = collectFacts(otherWorkspaceClaims)
    expect(await evaluateRestoreDrillSemanticRequirement(
      targetRequirement,
      (factToken) => otherWorkspaceFacts.has(factToken),
    ))
      .toBe('FILE_METADATA_TENANT_MISMATCH')
  })

  test('joins an unresolved Audit member pseudonym through an opaque alias fact', async () => {
    const alias = createRestoreDrillSemanticAuditMemberAliasClaim(
      'workspace-1',
      'audit-pseudonym-1',
      DIGEST_KEY,
      ORIGIN,
    )
    const candidates = createRestoreDrillSemanticAuditCandidateClaims({
      kind: 'audit-reference',
      referencedWorkspaceId: 'workspace-1',
      resourceId: 'unresolved-workspace-member:audit-pseudonym-1',
      resourceType: 'workspace-member',
      teamId: null,
      workspaceId: 'workspace-1',
    }, false, '2026-08-01T00:00:00.000Z#event-1', 'member-resource', DIGEST_KEY, ORIGIN, 'member')
    const candidate = candidates.find(
      (claim): claim is Extract<RestoreDrillSemanticClaim, { readonly kind: 'audit-candidate' }> =>
        claim.kind === 'audit-candidate',
    )
    if (!candidate || alias.kind !== 'fact') throw new Error('Audit alias claim missing')
    expect(await evaluateRestoreDrillSemanticRequirement(
      candidate.requirement,
      (factToken) => factToken === alias.factToken,
    ))
      .toBeUndefined()
  })

  test('rejects a requirement without a selectable terminal branch', async () => {
    const invalidRequirement: RestoreDrillSemanticRequirement = {
      branches: [{
        defaultFailureCode: 'WORK_ITEM_TEAM_MISSING',
        fallbacks: [],
        guardToken: 'b'.repeat(64),
        satisfied: false,
        successTokens: [],
      }],
      kind: 'requirement',
      requirementToken: 'c'.repeat(64),
    }

    await expect(evaluateRestoreDrillSemanticRequirement(
      invalidRequirement,
      () => false,
    )).rejects.toThrow('RESTORE_DRILL_SEMANTIC_REQUIREMENT_INVALID')
  })
})
