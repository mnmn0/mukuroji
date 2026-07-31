import { expect, test } from 'bun:test'
import {
  authenticateCrossDomainIntegrityResult,
  calculateCrossDomainIntegrityResourceIdentityDigest,
  compareCrossDomainIntegrityResults,
  CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
  parseCrossDomainIntegrityResult,
  runCrossDomainIntegrityCheck,
  verifyCrossDomainIntegrityResult,
  type CrossDomainIntegrityItem,
  type CrossDomainIntegrityPage,
  type CrossDomainIntegrityReadPort,
  type CrossDomainIntegrityResourceIdentity,
  type CrossDomainIntegrityRole,
} from './cross-domain-integrity'

const digestKey = new Uint8Array(32).fill(19)
const resourceBindingDigest = 'b'.repeat(64)
const sourceResourceIdentities = createResourceIdentities(1)
const restoreResourceIdentities = createResourceIdentities(8)
const sourceResourceIdentityDigest =
  calculateCrossDomainIntegrityResourceIdentityDigest(
    sourceResourceIdentities,
    digestKey,
  )
const restoreResourceIdentityDigest =
  calculateCrossDomainIntegrityResourceIdentityDigest(
    restoreResourceIdentities,
    digestKey,
  )
const checkedAt = '2026-08-01T00:00:00.000Z'
const defaultLimits = { pageSize: 100, maxPages: 100, maxItems: 1_000 }

/**
 * Creates one complete canonical resource identity vector with unique test digests.
 *
 * @param offset - Hexadecimal value offset used to distinguish fixture roles.
 * @returns Complete canonical resource identity vector.
 */
function createResourceIdentities(
  offset: number,
): CrossDomainIntegrityResourceIdentity[] {
  return CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.map((target, index) => ({
    target,
    identityDigest: ((offset + index) % 16).toString(16).padStart(64, '0'),
  }))
}

/** Creates a valid cross-domain fixture with reciprocal relations and exact file metadata. */
function createHealthyItems(): CrossDomainIntegrityItem[] {
  return [
    {
      kind: 'configuration',
      workspaceId: 'tenant-secret-a',
      teamId: null,
      workflowStatuses: [
        { statusId: 'done', category: 'completed' },
        { statusId: 'todo', category: 'unstarted' },
      ],
    },
    { kind: 'team', workspaceId: 'tenant-secret-a', teamId: 'team-secret-a' },
    {
      kind: 'project',
      workspaceId: 'tenant-secret-a',
      teamId: 'team-secret-a',
      projectId: 'project-secret-a',
    },
    {
      kind: 'workspace-member',
      workspaceId: 'tenant-secret-a',
      memberKey: 'owner-secret@example.test',
    },
    {
      kind: 'work-item',
      workspaceId: 'tenant-secret-a',
      teamId: 'team-secret-a',
      workItemId: 'work-secret-a',
      creatorMemberKey: 'owner-secret@example.test',
      workflowStatusId: 'todo',
      statusCategory: 'unstarted',
      projectId: 'project-secret-a',
      relationIds: ['blocks:work-secret-b'],
    },
    {
      kind: 'work-item',
      workspaceId: 'tenant-secret-a',
      teamId: 'team-secret-a',
      workItemId: 'work-secret-b',
      creatorMemberKey: 'owner-secret@example.test',
      workflowStatusId: 'done',
      statusCategory: 'completed',
      projectId: 'project-secret-a',
      relationIds: ['blockedBy:work-secret-a'],
    },
    {
      kind: 'relation',
      workspaceId: 'tenant-secret-a',
      teamId: 'team-secret-a',
      sourceWorkItemId: 'work-secret-a',
      targetWorkItemId: 'work-secret-b',
      relationType: 'blocks',
    },
    {
      kind: 'relation',
      workspaceId: 'tenant-secret-a',
      teamId: 'team-secret-a',
      sourceWorkItemId: 'work-secret-b',
      targetWorkItemId: 'work-secret-a',
      relationType: 'blockedBy',
    },
    {
      kind: 'audit-reference',
      workspaceId: 'tenant-secret-a',
      referencedWorkspaceId: 'tenant-secret-a',
      resourceType: 'work-item',
      resourceId: 'work-secret-a',
      teamId: 'team-secret-a',
      resourceState: 'current',
    },
    {
      kind: 'audit-reference',
      workspaceId: 'tenant-secret-a',
      referencedWorkspaceId: 'tenant-secret-a',
      resourceType: 'work-item',
      resourceId: 'historically-deleted-secret',
      teamId: 'team-secret-a',
      resourceState: 'historical',
    },
    {
      kind: 'file-metadata',
      workspaceId: 'tenant-secret-a',
      teamId: 'team-secret-a',
      fileId: 'file-secret-a',
      versionId: 'version-secret-a',
      targetType: 'work-item',
      targetId: 'work-secret-a',
      objectKey: 'workspaces/tenant-secret-a/files/object-secret-key',
      objectVersionId: 's3-secret-version',
      contentType: 'application/pdf',
      sizeBytes: 42,
      scanStatus: 'available',
    },
    {
      kind: 'file-object',
      objectKey: 'workspaces/tenant-secret-a/files/object-secret-key',
      objectVersionId: 's3-secret-version',
      workspaceId: 'tenant-secret-a',
      fileId: 'file-secret-a',
      versionId: 'version-secret-a',
      contentType: 'application/pdf',
      sizeBytes: 42,
      scanStatus: 'available',
    },
  ]
}

/** Creates a reader whose page layout can be varied without changing its logical dataset. */
function createPageReader(pages: readonly CrossDomainIntegrityItem[][]): CrossDomainIntegrityReadPort {
  let index = 0
  return {
    /** Returns the next fixture page. */
    async readPage(): Promise<CrossDomainIntegrityPage> {
      const items = pages[index] ?? []
      index += 1
      return {
        items,
        ...(index < pages.length ? { nextCursor: `private-cursor-${index}` } : {}),
      }
    },
  }
}

/** Fails if implementation order depends on locale-sensitive string collation. */
function rejectLocaleComparison(): number {
  throw new Error('localeCompare must not be used by the integrity checker.')
}

/** Runs the checker with test-safe bounds and a supplied logical role. */
async function run(
  items: readonly CrossDomainIntegrityItem[],
  role: CrossDomainIntegrityRole = 'source',
  bindingDigest = resourceBindingDigest,
  resultCheckedAt = checkedAt,
  limits = defaultLimits,
  resourceIdentities = role === 'source'
    ? sourceResourceIdentities
    : restoreResourceIdentities,
) {
  return runCrossDomainIntegrityCheck({
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    role,
    checkedAt: resultCheckedAt,
    digestKey,
    resourceBindingDigest: bindingDigest,
    resourceIdentities,
    resourceIdentityDigest:
      calculateCrossDomainIntegrityResourceIdentityDigest(
        resourceIdentities,
        digestKey,
      ),
    limits,
    reader: createPageReader([[...items]]),
  })
}

test('passes a healthy dataset without requiring historical audit resources to remain current', async () => {
  const result = await run(createHealthyItems())

  expect(result.status).toBe('pass')
  expect(result.failureCodes).toEqual([])
  expect(result.scope.targets).toEqual([
    'audit-known-resource-tenant',
    'configuration-workflow-status',
    'file-metadata-work-item-project-tenant',
    'relation-work-item-team-project',
    'work-item-creator-membership',
  ])
  expect(result.scope.nonTargets).toContain('historical-audit-resource-liveness')
})

test('produces the same result for different item order and page boundaries', async () => {
  const items = createHealthyItems()
  const onePage = await runCrossDomainIntegrityCheck({
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    role: 'source',
    checkedAt,
    digestKey,
    resourceBindingDigest,
    resourceIdentities: sourceResourceIdentities,
    resourceIdentityDigest: sourceResourceIdentityDigest,
    limits: defaultLimits,
    reader: createPageReader([[...items]]),
  })
  const reversed = [...items].reverse()
  const manyPages = await runCrossDomainIntegrityCheck({
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    role: 'source',
    checkedAt,
    digestKey,
    resourceBindingDigest,
    resourceIdentities: sourceResourceIdentities,
    resourceIdentityDigest: sourceResourceIdentityDigest,
    limits: defaultLimits,
    reader: createPageReader([
      reversed.slice(0, 2),
      reversed.slice(2, 7),
      reversed.slice(7),
    ]),
  })

  expect(manyPages).toEqual(onePage)
})

test('detects known missing, orphaned, cross-tenant, and metadata corruption', async () => {
  const items = createHealthyItems().filter((item) =>
    item.kind !== 'workspace-member' &&
    !(item.kind === 'relation' && item.relationType === 'blockedBy') &&
    item.kind !== 'file-object'
  )
  items.push(
    {
      kind: 'workspace-member',
      workspaceId: 'tenant-secret-b',
      memberKey: 'owner-secret@example.test',
    },
    { kind: 'team', workspaceId: 'tenant-secret-b', teamId: 'cross-tenant-team' },
    {
      kind: 'audit-reference',
      workspaceId: 'tenant-secret-a',
      referencedWorkspaceId: 'tenant-secret-b',
      resourceType: 'team',
      resourceId: 'cross-tenant-team',
      teamId: null,
      resourceState: 'current',
    },
  )
  const workItem = items.find((item) => item.kind === 'work-item' && item.workItemId === 'work-secret-a')
  if (workItem?.kind === 'work-item') workItem.workflowStatusId = 'deleted-status'

  const result = await run(items)

  expect(result.status).toBe('fail')
  expect(result.failureCodes).toEqual([
    'AUDIT_TENANT_MISMATCH',
    'FILE_METADATA_OBJECT_MISSING',
    'RELATION_RECIPROCAL_MISSING',
    'WORK_ITEM_CREATOR_TENANT_MISMATCH',
    'WORK_ITEM_RELATION_PROJECTION_MISMATCH',
    'WORK_ITEM_WORKFLOW_STATUS_UNKNOWN',
  ])
})

test('detects relation endpoint and project corruption without exposing their IDs', async () => {
  const items = createHealthyItems().filter((item) =>
    !(item.kind === 'work-item' && item.workItemId === 'work-secret-b') &&
    item.kind !== 'project'
  )

  const result = await run(items)

  expect(result.failureCodes).toContain('RELATION_ENDPOINT_MISSING')
  expect(result.failureCodes).toContain('RELATION_PROJECT_MISSING')
  const serialized = JSON.stringify(result)
  expect(serialized).not.toContain('tenant-secret-a')
  expect(serialized).not.toContain('work-secret-a')
  expect(serialized).not.toContain('file-secret-a')
  expect(serialized).not.toContain('object-secret-key')
  expect(serialized).not.toContain('private-cursor')
})

test('checks Work Item Team, Project, and status category without requiring a relation', async () => {
  const items: CrossDomainIntegrityItem[] = [
    {
      kind: 'workspace-member',
      workspaceId: 'isolated-tenant',
      memberKey: 'creator@example.test',
    },
    {
      kind: 'work-item',
      workspaceId: 'isolated-tenant',
      teamId: 'missing-team',
      workItemId: 'unrelated-work-item',
      creatorMemberKey: 'creator@example.test',
      workflowStatusId: 'todo',
      statusCategory: 'completed',
      projectId: 'missing-project',
      relationIds: [],
    },
  ]

  const result = await run(items)

  expect(result.failureCodes).toEqual([
    'WORK_ITEM_PROJECT_MISSING',
    'WORK_ITEM_STATUS_CATEGORY_MISMATCH',
    'WORK_ITEM_TEAM_MISSING',
  ])
})

test('classifies exact object metadata differences and orphan object versions', async () => {
  const items = createHealthyItems()
  const object = items.find((item) => item.kind === 'file-object')
  if (object?.kind === 'file-object') object.sizeBytes = 99
  items.push({
    kind: 'file-object',
    objectKey: 'workspaces/tenant-secret-a/files/orphan-key',
    objectVersionId: 'orphan-version',
    workspaceId: 'tenant-secret-a',
    fileId: 'orphan-file',
    versionId: 'orphan-app-version',
    contentType: 'text/plain',
    sizeBytes: 1,
    scanStatus: 'available',
  })

  const result = await run(items)

  expect(result.failureCodes).toContain('FILE_METADATA_OBJECT_MISMATCH')
  expect(result.failureCodes).toContain('FILE_OBJECT_METADATA_MISSING')
})

test('incorporates only aggregate external file evidence and stable failure codes', async () => {
  const result = await runCrossDomainIntegrityCheck({
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    role: 'restore',
    checkedAt,
    digestKey,
    resourceBindingDigest,
    resourceIdentities: restoreResourceIdentities,
    resourceIdentityDigest: restoreResourceIdentityDigest,
    limits: defaultLimits,
    reader: createPageReader([createHealthyItems()]),
    externalFileEvidence: {
      contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
      checkedItemCount: 3,
      aggregateDigest: 'a'.repeat(64),
      failureCodes: ['FILE_METADATA_OBJECT_MISMATCH'],
    },
  })

  expect(result.failureCodes).toEqual(['FILE_METADATA_OBJECT_MISMATCH'])
  expect(result.evidence.itemCount).toBe(createHealthyItems().length + 3)
  expect(JSON.stringify(result)).not.toContain('a'.repeat(64))
})

test('compares source and restore by stable aggregate domains', async () => {
  const source = await run(createHealthyItems(), 'source')
  const restoreItems = createHealthyItems()
  const restoreWorkItem = restoreItems.find((item) =>
    item.kind === 'work-item' && item.workItemId === 'work-secret-a'
  )
  if (restoreWorkItem?.kind === 'work-item') {
    restoreWorkItem.workflowStatusId = 'done'
    restoreWorkItem.statusCategory = 'completed'
  }
  const restore = await run(restoreItems, 'restore')

  expect(compareCrossDomainIntegrityResults(
    source,
    await run(createHealthyItems(), 'restore'),
    digestKey,
  )).toEqual({
    kind: 'mukuroji-cross-domain-integrity-comparison',
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    status: 'pass',
    failureCodes: [],
  })
  expect(compareCrossDomainIntegrityResults(source, restore, digestKey).failureCodes).toEqual([
    'RESTORE_WORK_ITEM_DIFFERENCE',
  ])
})

test('treats exact object-store Version IDs as dataset-local restore identities', async () => {
  const source = await run(createHealthyItems(), 'source')
  const restoreItems = createHealthyItems()
  for (const item of restoreItems) {
    if (item.kind === 'file-metadata' || item.kind === 'file-object') {
      item.objectVersionId = 'isolated-restore-object-version'
    }
  }
  const restore = await run(restoreItems, 'restore')

  expect(compareCrossDomainIntegrityResults(source, restore, digestKey)).toEqual({
    kind: 'mukuroji-cross-domain-integrity-comparison',
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    status: 'pass',
    failureCodes: [],
  })

  const changedRestoreItems = createHealthyItems()
  for (const item of changedRestoreItems) {
    if (item.kind === 'file-metadata' || item.kind === 'file-object') {
      item.objectVersionId = 'isolated-restore-object-version'
      item.sizeBytes += 1
    }
  }
  expect(compareCrossDomainIntegrityResults(
    source,
    await run(changedRestoreItems, 'restore'),
    digestKey,
  ).failureCodes).toEqual(['RESTORE_FILE_DIFFERENCE'])
})

test('binds evidence and source/restore comparison to the intended logical resources', async () => {
  const source = await run(createHealthyItems(), 'source')
  const differentlyBoundRestore = await run(createHealthyItems(), 'restore', 'c'.repeat(64))
  const comparison = compareCrossDomainIntegrityResults(source, differentlyBoundRestore, digestKey)

  expect(source.evidence.resourceBindingDigest).toBe(resourceBindingDigest)
  expect(source.evidence.aggregateDigest).not.toBe(differentlyBoundRestore.evidence.aggregateDigest)
  expect(comparison.failureCodes).toContain('SOURCE_RESTORE_RESOURCE_BINDING_MISMATCH')
})

test('strictly parses and authenticates an unchanged serialized result', async () => {
  const result = await run(createHealthyItems())
  const serialized: unknown = JSON.parse(JSON.stringify(result))

  expect(parseCrossDomainIntegrityResult(serialized)).toEqual(result)
  expect(verifyCrossDomainIntegrityResult(serialized, digestKey)).toBe(true)
  expect(() => parseCrossDomainIntegrityResult({
    ...result,
    limits: { pageSize: 1, maxPages: 1, maxItems: 2 },
  })).toThrow('page capacity')
})

test('rejects tampered role, status, failures, evidence, counts, MAC, and extra fields', async () => {
  const result = await run(createHealthyItems())
  const failureTampered = {
    ...result,
    status: 'fail',
    failureCodes: ['AUDIT_RESOURCE_MISSING'],
  }
  const firstDomain = result.evidence.domains[0]
  if (!firstDomain) throw new Error('Expected aggregate domain evidence.')
  const countTampered = {
    ...result,
    evidence: {
      ...result.evidence,
      itemCount: result.evidence.itemCount + 1,
      domains: [
        { ...firstDomain, itemCount: firstDomain.itemCount + 1 },
        ...result.evidence.domains.slice(1),
      ],
    },
  }
  const tamperedValues: unknown[] = [
    { ...result, role: 'restore' },
    { ...result, status: 'fail' },
    failureTampered,
    {
      ...result,
      evidence: { ...result.evidence, aggregateDigest: 'e'.repeat(64) },
    },
    countTampered,
    { ...result, resultMac: 'f'.repeat(64) },
    { ...result, harmlessRawTenantHint: 'must-not-be-accepted' },
  ]

  for (const value of tamperedValues) {
    expect(verifyCrossDomainIntegrityResult(value, digestKey)).toBe(false)
  }
  expect(() => parseCrossDomainIntegrityResult(tamperedValues[6])).toThrow('fields are invalid')
})

test('compares authenticated checkedAt and configured limits', async () => {
  const source = await run(createHealthyItems(), 'source')
  const differentTime = await run(
    createHealthyItems(),
    'restore',
    resourceBindingDigest,
    '2026-08-01T00:00:01.000Z',
  )
  const differentLimits = await run(
    createHealthyItems(),
    'restore',
    resourceBindingDigest,
    checkedAt,
    { pageSize: 50, maxPages: 100, maxItems: 1_000 },
  )

  expect(compareCrossDomainIntegrityResults(source, differentTime, digestKey).failureCodes).toEqual([
    'SOURCE_RESTORE_CHECKED_AT_MISMATCH',
  ])
  expect(compareCrossDomainIntegrityResults(source, differentLimits, digestKey).failureCodes).toEqual([
    'SOURCE_RESTORE_LIMITS_MISMATCH',
  ])
})

test('rejects reuse of any corresponding physical resource identity', async () => {
  const source = await run(createHealthyItems(), 'source')
  const partiallyReusedIdentities = restoreResourceIdentities.map((identity, index) => {
    const selected = index === 3 ? sourceResourceIdentities[index] : identity
    if (!selected) throw new Error('Expected complete resource identity fixture.')
    return { ...selected }
  })
  const reusedIdentityRestore = await run(
    createHealthyItems(),
    'restore',
    resourceBindingDigest,
    checkedAt,
    defaultLimits,
    partiallyReusedIdentities,
  )

  expect(compareCrossDomainIntegrityResults(source, reusedIdentityRestore, digestKey).failureCodes)
    .toEqual(['SOURCE_RESTORE_RESOURCE_IDENTITY_REUSED'])
})

test('does not trust any result fields after MAC authentication fails', async () => {
  const source = await run(createHealthyItems(), 'source')
  const restore = await run(createHealthyItems(), 'restore')
  const tamperedRestore = {
    ...restore,
    role: 'source',
    status: 'fail',
    failureCodes: ['AUDIT_RESOURCE_MISSING'],
    evidence: { ...restore.evidence, aggregateDigest: 'e'.repeat(64) },
  }

  expect(compareCrossDomainIntegrityResults(source, tamperedRestore, digestKey).failureCodes).toEqual([
    'RESTORE_RESULT_AUTHENTICATION_FAILED',
  ])
})

test('rejects a re-signed result whose total aggregate disagrees with its domains', async () => {
  const source = await run(createHealthyItems(), 'source')
  const restore = await run(createHealthyItems(), 'restore')
  const inconsistentRestore = authenticateCrossDomainIntegrityResult({
    kind: restore.kind,
    contractVersion: restore.contractVersion,
    role: restore.role,
    checkedAt: restore.checkedAt,
    limits: restore.limits,
    status: restore.status,
    failureCodes: restore.failureCodes,
    scope: restore.scope,
    evidence: {
      ...restore.evidence,
      aggregateDigest: 'e'.repeat(64),
    },
  }, digestKey)

  expect(verifyCrossDomainIntegrityResult(inconsistentRestore, digestKey)).toBe(false)
  expect(compareCrossDomainIntegrityResults(source, inconsistentRestore, digestKey).failureCodes)
    .toEqual(['RESTORE_RESULT_AUTHENTICATION_FAILED'])
})

test('rejects a re-signed resource aggregate that disagrees with its vector', async () => {
  const restore = await run(createHealthyItems(), 'restore')
  const inconsistentRestore = authenticateCrossDomainIntegrityResult({
    kind: restore.kind,
    contractVersion: restore.contractVersion,
    role: restore.role,
    checkedAt: restore.checkedAt,
    limits: restore.limits,
    status: restore.status,
    failureCodes: restore.failureCodes,
    scope: restore.scope,
    evidence: {
      ...restore.evidence,
      resourceIdentities: restore.evidence.resourceIdentities.map(
        (identity, index) => index === 0
          ? { ...identity, identityDigest: 'f'.repeat(64) }
          : identity,
      ),
    },
  }, digestKey)

  expect(verifyCrossDomainIntegrityResult(inconsistentRestore, digestKey)).toBe(false)
})

test('uses UTF-8 ordinal ordering without consulting process locale', async () => {
  const originalLocaleCompare = String.prototype.localeCompare
  String.prototype.localeCompare = rejectLocaleComparison
  try {
    const items: CrossDomainIntegrityItem[] = [
      { kind: 'team', workspaceId: 'workspace-\u{1f600}', teamId: 'team' },
      { kind: 'team', workspaceId: 'workspace-\ue000', teamId: 'team' },
    ]
    const forward = await run(items)
    const reverse = await run([...items].reverse())
    expect(reverse).toEqual(forward)
  } finally {
    String.prototype.localeCompare = originalLocaleCompare
  }
})

test('fails closed on a repeated opaque cursor and item limit without serializing cursors', async () => {
  const loopingReader: CrossDomainIntegrityReadPort = {
    /** Deliberately repeats one cursor to exercise fail-closed behavior. */
    async readPage(): Promise<CrossDomainIntegrityPage> {
      return { items: [], nextCursor: 'never-serialize-this-cursor' }
    },
  }
  const cursorResult = await runCrossDomainIntegrityCheck({
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    role: 'source',
    checkedAt,
    digestKey,
    resourceBindingDigest,
    resourceIdentities: sourceResourceIdentities,
    resourceIdentityDigest: sourceResourceIdentityDigest,
    limits: { pageSize: 1, maxPages: 10, maxItems: 10 },
    reader: loopingReader,
  })
  const limitResult = await runCrossDomainIntegrityCheck({
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    role: 'source',
    checkedAt,
    digestKey,
    resourceBindingDigest,
    resourceIdentities: sourceResourceIdentities,
    resourceIdentityDigest: sourceResourceIdentityDigest,
    limits: { pageSize: 10, maxPages: 10, maxItems: 1 },
    reader: createPageReader([createHealthyItems()]),
  })

  expect(cursorResult.failureCodes).toEqual(['CURSOR_LOOP'])
  expect(JSON.stringify(cursorResult)).not.toContain('never-serialize-this-cursor')
  expect(limitResult.failureCodes).toEqual(['INTEGRITY_LIMIT_EXCEEDED'])
})

test('fails closed when an adapter returns more than the requested page size', async () => {
  const oversizedReader: CrossDomainIntegrityReadPort = {
    /** Deliberately violates the normalized read-port page limit. */
    async readPage(): Promise<CrossDomainIntegrityPage> {
      return { items: createHealthyItems() }
    },
  }
  const result = await runCrossDomainIntegrityCheck({
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    role: 'source',
    checkedAt,
    digestKey,
    resourceBindingDigest,
    resourceIdentities: sourceResourceIdentities,
    resourceIdentityDigest: sourceResourceIdentityDigest,
    limits: { pageSize: 1, maxPages: 10, maxItems: 10 },
    reader: oversizedReader,
  })

  expect(result.failureCodes).toEqual(['INTEGRITY_LIMIT_EXCEEDED'])
  expect(result.evidence.itemCount).toBe(0)
})

test('includes external file evidence in the configured total item bound', async () => {
  const result = await runCrossDomainIntegrityCheck({
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    role: 'source',
    checkedAt,
    digestKey,
    resourceBindingDigest,
    resourceIdentities: sourceResourceIdentities,
    resourceIdentityDigest: sourceResourceIdentityDigest,
    limits: { pageSize: 1, maxPages: 1, maxItems: 1 },
    reader: createPageReader([[]]),
    externalFileEvidence: {
      contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
      checkedItemCount: 2,
      aggregateDigest: 'a'.repeat(64),
      failureCodes: [],
    },
  })

  expect(result.failureCodes).toEqual(['INTEGRITY_LIMIT_EXCEEDED'])
  expect(result.evidence.itemCount).toBe(0)
  expect(verifyCrossDomainIntegrityResult(result, digestKey)).toBe(true)
})

test('rejects invalid bounds, digest keys, and row-level external evidence shapes', async () => {
  await expect(runCrossDomainIntegrityCheck({
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    role: 'source',
    checkedAt,
    digestKey: new Uint8Array(31),
    resourceBindingDigest,
    resourceIdentities: sourceResourceIdentities,
    resourceIdentityDigest: sourceResourceIdentityDigest,
    limits: { pageSize: 1, maxPages: 1, maxItems: 1 },
    reader: createPageReader([[]]),
  })).rejects.toThrow('exactly 32 bytes')
  await expect(runCrossDomainIntegrityCheck({
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    role: 'source',
    checkedAt,
    digestKey,
    resourceBindingDigest,
    resourceIdentities: sourceResourceIdentities,
    resourceIdentityDigest: sourceResourceIdentityDigest,
    limits: { pageSize: 0, maxPages: 1, maxItems: 1 },
    reader: createPageReader([[]]),
  })).rejects.toThrow('pageSize')
  await expect(runCrossDomainIntegrityCheck({
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    role: 'source',
    checkedAt,
    digestKey,
    resourceBindingDigest,
    resourceIdentities: sourceResourceIdentities,
    resourceIdentityDigest: sourceResourceIdentityDigest,
    limits: { pageSize: 1, maxPages: 1, maxItems: 2 },
    reader: createPageReader([[]]),
  })).rejects.toThrow('page capacity')
  await expect(runCrossDomainIntegrityCheck({
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    role: 'source',
    checkedAt,
    digestKey,
    resourceBindingDigest: 'invalid-binding',
    resourceIdentities: sourceResourceIdentities,
    resourceIdentityDigest: sourceResourceIdentityDigest,
    limits: { pageSize: 1, maxPages: 1, maxItems: 1 },
    reader: createPageReader([[]]),
  })).rejects.toThrow('resource binding digest')
  await expect(runCrossDomainIntegrityCheck({
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    role: 'source',
    checkedAt: '2026-08-01T00:00:00Z',
    digestKey,
    resourceBindingDigest,
    resourceIdentities: sourceResourceIdentities,
    resourceIdentityDigest: sourceResourceIdentityDigest,
    limits: { pageSize: 1, maxPages: 1, maxItems: 1 },
    reader: createPageReader([[]]),
  })).rejects.toThrow('canonical UTC timestamp')
  await expect(runCrossDomainIntegrityCheck({
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    role: 'source',
    checkedAt,
    digestKey,
    resourceBindingDigest,
    resourceIdentities: sourceResourceIdentities,
    resourceIdentityDigest: 'invalid-identity',
    limits: { pageSize: 1, maxPages: 1, maxItems: 1 },
    reader: createPageReader([[]]),
  })).rejects.toThrow('resource identity digest')
  await expect(runCrossDomainIntegrityCheck({
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    role: 'source',
    checkedAt,
    digestKey,
    resourceBindingDigest,
    resourceIdentities: sourceResourceIdentities,
    resourceIdentityDigest: sourceResourceIdentityDigest,
    limits: { pageSize: 1, maxPages: 1, maxItems: 1 },
    reader: createPageReader([[]]),
    externalFileEvidence: {
      contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
      checkedItemCount: 1,
      aggregateDigest: 'not-an-aggregate-hmac',
      failureCodes: [],
    },
  })).rejects.toThrow('External file integrity evidence is invalid')
})
