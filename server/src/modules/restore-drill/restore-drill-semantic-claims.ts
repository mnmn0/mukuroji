import { createHmac } from 'node:crypto'
import type {
  CrossDomainIntegrityFailureCode,
  CrossDomainIntegrityItem,
  CrossDomainRelationType,
} from '../../../scripts/data-integrity/cross-domain-integrity'

/** One fallback fact whose presence selects a more specific stable failure. */
export type RestoreDrillSemanticFallback = {
  /** Evidence-safe shared cross-domain failure category. */
  readonly failureCode: CrossDomainIntegrityFailureCode
  /** Opaque HMAC token for a less-specific candidate fact. */
  readonly factToken: string
}

/** One ordered guarded branch of a deferred semantic requirement. */
export type RestoreDrillSemanticRequirementBranch = {
  /** Failure raised when no success or fallback fact exists in this selected branch. */
  readonly defaultFailureCode: CrossDomainIntegrityFailureCode
  /** Ordered less-specific facts used only to classify a missing success fact. */
  readonly fallbacks: readonly RestoreDrillSemanticFallback[]
  /** Optional fact selecting this branch before lower-priority branches are considered. */
  readonly guardToken?: string
  /** Whether selecting this branch satisfies the requirement without another fact. */
  readonly satisfied: boolean
  /** Any matching exact fact satisfies this selected branch. */
  readonly successTokens: readonly string[]
}

/** Opaque deferred requirement evaluated after every table page is normalized. */
export type RestoreDrillSemanticRequirement = {
  /** Highest-priority-first guarded alternatives ending in one unguarded branch. */
  readonly branches: readonly RestoreDrillSemanticRequirementBranch[]
  /** Fixed deferred-requirement discriminator. */
  readonly kind: 'requirement'
  /** Opaque deterministic identity for this source-row requirement. */
  readonly requirementToken: string
}

/** Process-local Audit candidate whose raw ordering value must never be persisted. */
export type RestoreDrillSemanticAuditCandidate = {
  /** Canonical raw Audit ordering value used only to compare opaque durable order tokens. */
  readonly eventOrder: string
  /** Whether the event lifecycle makes this candidate historical even when latest. */
  readonly historical: boolean
  /** Fixed lifecycle-candidate discriminator. */
  readonly kind: 'audit-candidate'
  /** Opaque resource existence requirement applied only when this candidate is latest/current. */
  readonly requirement: RestoreDrillSemanticRequirement
  /** Opaque identity shared by all Audit candidates for the same logical resource. */
  readonly resourceToken: string
}

/** Opaque, tenant-data-free semantic claim persisted between verification invocations. */
export type RestoreDrillSemanticClaim =
  | {
      /** Opaque exact fact token. */
      readonly factToken: string
      /** Fixed existence-claim discriminator. */
      readonly kind: 'fact'
      /** Opaque HMAC of the exact physical source row. */
      readonly originToken: string
    }
  | {
      /** Failure raised when another physical row owns the same semantic identity. */
      readonly duplicateFailureCode: CrossDomainIntegrityFailureCode
      /** Fixed uniqueness-claim discriminator. */
      readonly kind: 'unique'
      /** Opaque HMAC of the exact physical source row. */
      readonly originToken: string
      /** Opaque exact semantic identity token. */
      readonly uniqueToken: string
    }
  | RestoreDrillSemanticRequirement
  | RestoreDrillSemanticAuditCandidate
  | {
      /** Evidence-safe shared cross-domain failure category. */
      readonly failureCode: CrossDomainIntegrityFailureCode
      /** Opaque deterministic identity preventing duplicate failure records. */
      readonly failureToken: string
      /** Fixed immediate-failure discriminator. */
      readonly kind: 'failure'
    }

/**
 * Creates an opaque domain-separated semantic identity.
 *
 * @param digestKey - Invocation-local 32-byte restore-drill HMAC key.
 * @param domain - Stable semantic token domain.
 * @param values - Raw process-local values that are never returned.
 * @returns Lower-case HMAC token safe for durable state.
 */
export function createRestoreDrillSemanticToken(
  digestKey: Uint8Array,
  domain: string,
  values: readonly string[],
): string {
  if (
    digestKey.byteLength !== 32 ||
    !/^[a-z0-9][a-z0-9-]{2,95}$/u.test(domain) ||
    values.some((value) => typeof value !== 'string' || value.length > 4_096)
  ) throw new TypeError('RESTORE_DRILL_SEMANTIC_TOKEN_INVALID')
  const hmac = createHmac('sha256', digestKey)
    .update(`mukuroji-restore-drill-semantic-${domain}-v1\0`, 'utf8')
  for (const value of values) {
    hmac.update(String(Buffer.byteLength(value, 'utf8')), 'utf8')
    hmac.update(':', 'utf8')
    hmac.update(value, 'utf8')
    hmac.update('\0', 'utf8')
  }
  return hmac.digest('hex')
}

/**
 * Converts one strictly normalized row into opaque facts and deferred requirements.
 *
 * @param item - Process-local normalized cross-domain item.
 * @param digestKey - Invocation-local restore-drill HMAC key.
 * @param originToken - HMAC of the exact physical source row.
 * @returns Tenant-data-free claims suitable for idempotent durable writes.
 */
export function createRestoreDrillSemanticItemClaims(
  item: CrossDomainIntegrityItem,
  digestKey: Uint8Array,
  originToken: string,
): readonly RestoreDrillSemanticClaim[] {
  if (!isHexDigest(originToken)) throw new TypeError('RESTORE_DRILL_SEMANTIC_ORIGIN_INVALID')
  const itemOriginToken = item.kind === 'file-metadata' || item.kind === 'file-object'
    ? token(digestKey, 'file-normalized-origin', [
        originToken,
        item.kind,
        item.objectKey,
        item.objectVersionId,
      ])
    : originToken
  switch (item.kind) {
    case 'configuration':
      return configurationClaims(item, digestKey, itemOriginToken)
    case 'work-item':
      return workItemClaims(item, digestKey, itemOriginToken)
    case 'workspace-member':
      return resourceClaims('member', [item.workspaceId, item.memberKey], [item.memberKey], digestKey, itemOriginToken)
    case 'team':
      return resourceClaims('team', [item.workspaceId, item.teamId], [item.teamId], digestKey, itemOriginToken)
    case 'project':
      return projectClaims(item, digestKey, itemOriginToken)
    case 'relation':
      return relationClaims(item, digestKey, itemOriginToken)
    case 'audit-reference':
      return auditClaims(item, digestKey, itemOriginToken)
    case 'file-metadata':
      return fileMetadataClaims(item, digestKey, itemOriginToken)
    case 'file-object':
      return fileObjectClaims(item, digestKey, itemOriginToken)
    default:
      return assertUnreachable(item)
  }
}

/**
 * Creates the Workspace-member audit pseudonym alias fact without retaining either identifier.
 *
 * @param workspaceId - Process-local Workspace identifier.
 * @param auditEntityId - Process-local deterministic audit pseudonym.
 * @param digestKey - Invocation-local restore-drill HMAC key.
 * @param originToken - Opaque physical source-row identity.
 * @returns One opaque alias fact.
 */
export function createRestoreDrillSemanticAuditMemberAliasClaim(
  workspaceId: string,
  auditEntityId: string,
  digestKey: Uint8Array,
  originToken: string,
): RestoreDrillSemanticClaim {
  return fact(token(digestKey, 'audit-member-alias', [workspaceId, auditEntityId]), originToken)
}

/**
 * Creates lifecycle-aware audit claims before raw identifiers leave the invocation.
 *
 * @param reference - Strict process-local normalized audit resource reference.
 * @param historical - Whether lifecycle semantics make this candidate historical.
 * @param eventOrder - Canonical raw ordering value retained only for the immediate state call.
 * @param resourceIdentity - Process-local identity shared by lifecycle candidates.
 * @param digestKey - Invocation-local restore-drill HMAC key.
 * @param originToken - Opaque physical source-row identity.
 * @param label - Stable per-event candidate label.
 * @returns Tenant-data-free historical fact, current requirement, or mismatch failure.
 */
export function createRestoreDrillSemanticAuditCandidateClaims(
  reference: Omit<
    Extract<CrossDomainIntegrityItem, { readonly kind: 'audit-reference' }>,
    'resourceState'
  >,
  historical: boolean,
  eventOrder: string,
  resourceIdentity: string,
  digestKey: Uint8Array,
  originToken: string,
  label: string,
): readonly RestoreDrillSemanticClaim[] {
  if (
    eventOrder.length === 0 || Buffer.byteLength(eventOrder, 'utf8') > 4_096 ||
    resourceIdentity.length === 0 || Buffer.byteLength(resourceIdentity, 'utf8') > 4_096
  ) throw new TypeError('RESTORE_DRILL_SEMANTIC_AUDIT_CANDIDATE_INVALID')
  if (reference.workspaceId !== reference.referencedWorkspaceId) {
    return [failure(digestKey, originToken, `${label}-tenant`, 'AUDIT_TENANT_MISMATCH')]
  }
  const unresolvedMemberPrefix = 'unresolved-workspace-member:'
  const resource = reference.resourceType === 'workspace-member' &&
      reference.resourceId.startsWith(unresolvedMemberPrefix)
    ? token(digestKey, 'audit-member-alias', [
        reference.workspaceId,
        reference.resourceId.slice(unresolvedMemberPrefix.length),
      ])
    : auditResourceToken({ ...reference, resourceState: 'current' }, digestKey)
  const currentRequirement = requirement(
    digestKey,
    originToken,
    `${label}-resource`,
    [resource],
    [],
    'AUDIT_RESOURCE_MISSING',
  )
  return [{
    eventOrder,
    historical,
    kind: 'audit-candidate',
    requirement: currentRequirement,
    resourceToken: token(digestKey, 'audit-lifecycle-resource', [resourceIdentity]),
  }]
}

/** Creates exact/global existence and uniqueness claims for one simple resource. */
function resourceClaims(
  domain: 'member' | 'team',
  exactValues: readonly string[],
  globalValues: readonly string[],
  digestKey: Uint8Array,
  originToken: string,
): RestoreDrillSemanticClaim[] {
  const exact = token(digestKey, `${domain}-exact`, exactValues)
  return [
    fact(exact, originToken),
    fact(token(digestKey, `${domain}-global`, globalValues), originToken),
    unique(exact, originToken, 'DUPLICATE_RECORD'),
  ]
}

/** Creates configuration scope/status claims. */
function configurationClaims(
  item: Extract<CrossDomainIntegrityItem, { readonly kind: 'configuration' }>,
  digestKey: Uint8Array,
  originToken: string,
): RestoreDrillSemanticClaim[] {
  const scope = [item.workspaceId, item.teamId ?? '']
  const scopeToken = token(digestKey, 'configuration-scope', scope)
  const claims: RestoreDrillSemanticClaim[] = [
    fact(scopeToken, originToken),
    unique(scopeToken, originToken, 'CONFIGURATION_DUPLICATE_SCOPE'),
  ]
  for (const status of item.workflowStatuses) {
    claims.push(
      fact(token(digestKey, 'configuration-status', [...scope, status.statusId]), originToken),
      fact(token(
        digestKey,
        'configuration-status-category',
        [...scope, status.statusId, status.category],
      ), originToken),
    )
  }
  return claims
}

/** Creates Work Item resource, ownership, status, membership, and projection claims. */
function workItemClaims(
  item: Extract<CrossDomainIntegrityItem, { readonly kind: 'work-item' }>,
  digestKey: Uint8Array,
  originToken: string,
): RestoreDrillSemanticClaim[] {
  const exactValues = [item.workspaceId, item.teamId, item.workItemId]
  const exact = token(digestKey, 'work-item-exact', exactValues)
  const claims: RestoreDrillSemanticClaim[] = [
    fact(exact, originToken),
    fact(token(digestKey, 'work-item-workspace', [item.workspaceId, item.workItemId]), originToken),
    fact(token(digestKey, 'work-item-global', [item.workItemId]), originToken),
    unique(exact, originToken, 'DUPLICATE_RECORD'),
    requirement(
      digestKey,
      originToken,
      'team',
      [token(digestKey, 'team-exact', [item.workspaceId, item.teamId])],
      [{
        factToken: token(digestKey, 'team-global', [item.teamId]),
        failureCode: 'WORK_ITEM_TENANT_MISMATCH',
      }],
      'WORK_ITEM_TEAM_MISSING',
    ),
    requirement(
      digestKey,
      originToken,
      'creator',
      [token(digestKey, 'member-exact', [item.workspaceId, item.creatorMemberKey])],
      [{
        factToken: token(digestKey, 'member-global', [item.creatorMemberKey]),
        failureCode: 'WORK_ITEM_CREATOR_TENANT_MISMATCH',
      }],
      'WORK_ITEM_CREATOR_MEMBER_MISSING',
    ),
  ]
  if (item.projectId !== null) {
    claims.push(requirement(
      digestKey,
      originToken,
      'project',
      [token(digestKey, 'project-exact', [item.workspaceId, item.teamId, item.projectId])],
      [
        {
          factToken: token(digestKey, 'project-workspace', [item.workspaceId, item.projectId]),
          failureCode: 'WORK_ITEM_PROJECT_TEAM_MISMATCH',
        },
        {
          factToken: token(digestKey, 'project-global', [item.projectId]),
          failureCode: 'WORK_ITEM_TENANT_MISMATCH',
        },
      ],
      'WORK_ITEM_PROJECT_MISSING',
    ))
    claims.push({
      branches: [
        {
          defaultFailureCode: 'RELATION_PROJECT_MISSING',
          fallbacks: [
            {
              factToken: token(digestKey, 'project-workspace', [
                item.workspaceId,
                item.projectId,
              ]),
              failureCode: 'RELATION_PROJECT_TEAM_MISMATCH',
            },
            {
              factToken: token(digestKey, 'project-global', [item.projectId]),
              failureCode: 'RELATION_TENANT_MISMATCH',
            },
          ],
          guardToken: token(digestKey, 'relation-endpoint', exactValues),
          satisfied: false,
          successTokens: [token(digestKey, 'project-exact', [
            item.workspaceId,
            item.teamId,
            item.projectId,
          ])],
        },
        {
          defaultFailureCode: 'RELATION_PROJECT_MISSING',
          fallbacks: [],
          satisfied: true,
          successTokens: [],
        },
      ],
      kind: 'requirement',
      requirementToken: token(digestKey, 'requirement', [originToken, 'relation-project']),
    })
  }
  claims.push(workItemStatusRequirement(item, digestKey, originToken))
  for (let index = 0; index < item.relationIds.length; index += 1) {
    const relationId = item.relationIds[index]
    if (relationId === undefined) continue
    const projectionToken = token(
      digestKey,
      'relation-projection',
      [...exactValues, relationId],
    )
    claims.push(fact(projectionToken, originToken))
    claims.push(requirement(
      digestKey,
      originToken,
      `projection-${index}`,
      [token(digestKey, 'relation-exact', [...exactValues, relationId])],
      [],
      'WORK_ITEM_RELATION_PROJECTION_MISMATCH',
    ))
  }
  return claims
}

/** Creates the configuration/category requirement for one Work Item. */
function workItemStatusRequirement(
  item: Extract<CrossDomainIntegrityItem, { readonly kind: 'work-item' }>,
  digestKey: Uint8Array,
  originToken: string,
): RestoreDrillSemanticRequirement {
  const builtInCategory = builtInWorkflowStatusCategory(item.workflowStatusId)
  const teamScope = [item.workspaceId, item.teamId]
  const workspaceScope = [item.workspaceId, '']
  const configuredBranch = (
    scope: readonly string[],
  ): RestoreDrillSemanticRequirementBranch => ({
    defaultFailureCode: 'WORK_ITEM_WORKFLOW_STATUS_UNKNOWN',
    fallbacks: [{
      factToken: token(digestKey, 'configuration-status', [
        ...scope,
        item.workflowStatusId,
      ]),
      failureCode: 'WORK_ITEM_STATUS_CATEGORY_MISMATCH',
    }],
    guardToken: token(digestKey, 'configuration-scope', scope),
    satisfied: false,
    successTokens: [token(digestKey, 'configuration-status-category', [
      ...scope,
      item.workflowStatusId,
      item.statusCategory,
    ])],
  })
  const builtInMatches = builtInCategory === item.statusCategory
  return {
    branches: [
      configuredBranch(teamScope),
      configuredBranch(workspaceScope),
      {
        defaultFailureCode: builtInCategory === undefined
          ? 'WORK_ITEM_WORKFLOW_STATUS_UNKNOWN'
          : 'WORK_ITEM_STATUS_CATEGORY_MISMATCH',
        fallbacks: [],
        satisfied: builtInMatches,
        successTokens: [],
      },
    ],
    kind: 'requirement',
    requirementToken: token(digestKey, 'requirement', [originToken, 'status']),
  }
}

/** Creates Project exact/workspace/global claims. */
function projectClaims(
  item: Extract<CrossDomainIntegrityItem, { readonly kind: 'project' }>,
  digestKey: Uint8Array,
  originToken: string,
): RestoreDrillSemanticClaim[] {
  const exact = token(
    digestKey,
    'project-exact',
    [item.workspaceId, item.teamId, item.projectId],
  )
  return [
    fact(exact, originToken),
    fact(token(digestKey, 'project-workspace', [item.workspaceId, item.projectId]), originToken),
    fact(token(digestKey, 'project-global', [item.projectId]), originToken),
    unique(exact, originToken, 'DUPLICATE_RECORD'),
  ]
}

/** Creates relation existence, reciprocal, endpoint, Team, and projection claims. */
function relationClaims(
  item: Extract<CrossDomainIntegrityItem, { readonly kind: 'relation' }>,
  digestKey: Uint8Array,
  originToken: string,
): RestoreDrillSemanticClaim[] {
  const relationId = `${item.relationType}:${item.targetWorkItemId}`
  const exactValues = [
    item.workspaceId,
    item.teamId,
    item.sourceWorkItemId,
    relationId,
  ]
  const exact = token(digestKey, 'relation-exact', exactValues)
  const reciprocalId = `${reciprocalRelationType(item.relationType)}:${item.sourceWorkItemId}`
  const claims: RestoreDrillSemanticClaim[] = [
    fact(exact, originToken),
    fact(token(digestKey, 'relation-endpoint', [
      item.workspaceId,
      item.teamId,
      item.sourceWorkItemId,
    ]), originToken),
    fact(token(digestKey, 'relation-endpoint', [
      item.workspaceId,
      item.teamId,
      item.targetWorkItemId,
    ]), originToken),
    unique(exact, originToken, 'DUPLICATE_RECORD'),
    requirement(
      digestKey,
      originToken,
      'reciprocal',
      [token(digestKey, 'relation-exact', [
        item.workspaceId,
        item.teamId,
        item.targetWorkItemId,
        reciprocalId,
      ])],
      [],
      'RELATION_RECIPROCAL_MISSING',
    ),
    requirement(
      digestKey,
      originToken,
      'projection',
      [token(digestKey, 'relation-projection', exactValues)],
      [],
      'WORK_ITEM_RELATION_PROJECTION_MISMATCH',
    ),
    requirement(
      digestKey,
      originToken,
      'team',
      [token(digestKey, 'team-exact', [item.workspaceId, item.teamId])],
      [{
        factToken: token(digestKey, 'team-global', [item.teamId]),
        failureCode: 'RELATION_TENANT_MISMATCH',
      }],
      'RELATION_TEAM_MISSING',
    ),
  ]
  const endpoints: readonly {
    /** Stable requirement label. */
    readonly label: string
    /** Referenced Work Item ID. */
    readonly workItemId: string
  }[] = [
    { label: 'source', workItemId: item.sourceWorkItemId },
    { label: 'target', workItemId: item.targetWorkItemId },
  ]
  for (const endpoint of endpoints) {
    claims.push(requirement(
      digestKey,
      originToken,
      endpoint.label,
      [token(
        digestKey,
        'work-item-exact',
        [item.workspaceId, item.teamId, endpoint.workItemId],
      )],
      [
        {
          factToken: token(
            digestKey,
            'work-item-workspace',
            [item.workspaceId, endpoint.workItemId],
          ),
          failureCode: 'RELATION_ENDPOINT_TEAM_MISMATCH',
        },
        {
          factToken: token(digestKey, 'work-item-global', [endpoint.workItemId]),
          failureCode: 'RELATION_TENANT_MISMATCH',
        },
      ],
      'RELATION_ENDPOINT_MISSING',
    ))
  }
  return claims
}

/** Creates lifecycle-aware audit resource requirements from normalized references. */
function auditClaims(
  item: Extract<CrossDomainIntegrityItem, { readonly kind: 'audit-reference' }>,
  digestKey: Uint8Array,
  originToken: string,
): RestoreDrillSemanticClaim[] {
  if (item.workspaceId !== item.referencedWorkspaceId) {
    return [failure(digestKey, originToken, 'audit-tenant', 'AUDIT_TENANT_MISMATCH')]
  }
  if (item.resourceState === 'historical') return []
  const resource = auditResourceToken(item, digestKey)
  return [requirement(
    digestKey,
    originToken,
    'audit-resource',
    [resource, token(digestKey, 'audit-historical-resource', [resource])],
    [],
    'AUDIT_RESOURCE_MISSING',
  )]
}

/** Creates File metadata facts and exact object/attachment requirements. */
function fileMetadataClaims(
  item: Extract<CrossDomainIntegrityItem, { readonly kind: 'file-metadata' }>,
  digestKey: Uint8Array,
  originToken: string,
): RestoreDrillSemanticClaim[] {
  const identity = [item.objectKey, item.objectVersionId]
  const detail = fileDetail(item)
  const metadataExact = token(digestKey, 'file-metadata-detail', [...identity, ...detail])
  const targetExactToken = item.targetType === 'work-item'
    ? token(digestKey, 'work-item-exact', [item.workspaceId, item.teamId, item.targetId])
    : token(digestKey, 'project-exact', [item.workspaceId, item.teamId, item.targetId])
  const targetWorkspaceToken = item.targetType === 'work-item'
    ? token(digestKey, 'work-item-workspace', [item.workspaceId, item.targetId])
    : token(digestKey, 'project-workspace', [item.workspaceId, item.targetId])
  const targetGlobalToken = item.targetType === 'work-item'
    ? token(digestKey, 'work-item-global', [item.targetId])
    : token(digestKey, 'project-global', [item.targetId])
  const objectIdentityToken = token(digestKey, 'file-object-identity', identity)
  return [
    fact(token(digestKey, 'file-resource', [item.workspaceId, item.fileId]), originToken),
    fact(token(digestKey, 'file-metadata-identity', identity), originToken),
    fact(metadataExact, originToken),
    unique(token(digestKey, 'file-metadata-identity', identity), originToken, 'DUPLICATE_RECORD'),
    requirement(
      digestKey,
      originToken,
      'file-object',
      [token(digestKey, 'file-object-detail', [...identity, ...detail])],
      [
        {
          factToken: objectIdentityToken,
          failureCode: 'FILE_METADATA_OBJECT_MISMATCH',
        },
      ],
      'FILE_METADATA_OBJECT_MISSING',
    ),
    {
      branches: [
        {
          defaultFailureCode: 'FILE_METADATA_TENANT_MISMATCH',
          fallbacks: [],
          guardToken: objectIdentityToken,
          satisfied: false,
          successTokens: [token(digestKey, 'file-object-workspace', [
            ...identity,
            item.workspaceId,
          ])],
        },
        {
          defaultFailureCode: 'FILE_METADATA_OBJECT_MISSING',
          fallbacks: [],
          satisfied: true,
          successTokens: [],
        },
      ],
      kind: 'requirement',
      requirementToken: token(digestKey, 'requirement', [originToken, 'file-object-tenant']),
    },
    requirement(
      digestKey,
      originToken,
      'file-team',
      [token(digestKey, 'team-exact', [item.workspaceId, item.teamId])],
      [{
        factToken: token(digestKey, 'team-global', [item.teamId]),
        failureCode: 'FILE_METADATA_TENANT_MISMATCH',
      }],
      'FILE_METADATA_REFERENCE_MISSING',
    ),
    requirement(
      digestKey,
      originToken,
      'file-target',
      [targetExactToken],
      [
        {
          factToken: targetWorkspaceToken,
          failureCode: 'FILE_METADATA_REFERENCE_MISSING',
        },
        {
          factToken: targetGlobalToken,
          failureCode: 'FILE_METADATA_TENANT_MISMATCH',
        },
      ],
      'FILE_METADATA_REFERENCE_MISSING',
    ),
  ]
}

/** Creates exact File object facts and the reciprocal metadata requirement. */
function fileObjectClaims(
  item: Extract<CrossDomainIntegrityItem, { readonly kind: 'file-object' }>,
  digestKey: Uint8Array,
  originToken: string,
): RestoreDrillSemanticClaim[] {
  const identity = [item.objectKey, item.objectVersionId]
  const detail = fileDetail(item)
  return [
    fact(token(digestKey, 'file-object-identity', identity), originToken),
    fact(token(digestKey, 'file-object-workspace', [...identity, item.workspaceId]), originToken),
    fact(token(digestKey, 'file-object-detail', [...identity, ...detail]), originToken),
    unique(token(digestKey, 'file-object-identity', identity), originToken, 'DUPLICATE_RECORD'),
    requirement(
      digestKey,
      originToken,
      'file-metadata',
      [token(digestKey, 'file-metadata-identity', identity)],
      [],
      'FILE_OBJECT_METADATA_MISSING',
    ),
  ]
}

/** Creates a canonical portable File detail vector shared by both roles. */
function fileDetail(item: Extract<
  CrossDomainIntegrityItem,
  { readonly kind: 'file-metadata' | 'file-object' }
>): string[] {
  return [
    item.workspaceId,
    item.fileId,
    item.versionId,
    item.contentType,
    String(item.sizeBytes),
    item.scanStatus,
  ]
}

/** Creates the canonical resource fact required by one current audit reference. */
function auditResourceToken(
  item: Extract<CrossDomainIntegrityItem, { readonly kind: 'audit-reference' }>,
  digestKey: Uint8Array,
): string {
  if (item.resourceType === 'workspace-member') {
    return token(digestKey, 'member-exact', [item.workspaceId, item.resourceId])
  }
  if (item.resourceType === 'team') {
    return token(digestKey, 'team-exact', [item.workspaceId, item.resourceId])
  }
  if (item.resourceType === 'project') {
    return token(digestKey, 'project-exact', [
      item.workspaceId,
      item.teamId ?? '',
      item.resourceId,
    ])
  }
  if (item.resourceType === 'work-item') {
    return token(digestKey, 'work-item-exact', [
      item.workspaceId,
      item.teamId ?? '',
      item.resourceId,
    ])
  }
  return token(digestKey, 'file-resource', [item.workspaceId, item.resourceId])
}

/** Creates one exact fact claim. */
function fact(factToken: string, originToken: string): RestoreDrillSemanticClaim {
  return { factToken, kind: 'fact', originToken }
}

/** Creates one uniqueness claim. */
function unique(
  uniqueToken: string,
  originToken: string,
  duplicateFailureCode: CrossDomainIntegrityFailureCode,
): RestoreDrillSemanticClaim {
  return { duplicateFailureCode, kind: 'unique', originToken, uniqueToken }
}

/** Creates one deferred fact requirement. */
function requirement(
  digestKey: Uint8Array,
  originToken: string,
  label: string,
  successTokens: readonly string[],
  fallbacks: readonly RestoreDrillSemanticFallback[],
  defaultFailureCode: CrossDomainIntegrityFailureCode,
): RestoreDrillSemanticRequirement {
  return {
    branches: [{
      defaultFailureCode,
      fallbacks,
      satisfied: false,
      successTokens,
    }],
    kind: 'requirement',
    requirementToken: token(digestKey, 'requirement', [originToken, label]),
  }
}

/** Creates one immediate stable failure claim. */
export function createRestoreDrillSemanticFailureClaim(
  digestKey: Uint8Array,
  originToken: string,
  label: string,
  failureCode: CrossDomainIntegrityFailureCode,
): RestoreDrillSemanticClaim {
  return failure(digestKey, originToken, label, failureCode)
}

/** Creates one immediate stable failure claim. */
function failure(
  digestKey: Uint8Array,
  originToken: string,
  label: string,
  failureCode: CrossDomainIntegrityFailureCode,
): RestoreDrillSemanticClaim {
  return {
    failureCode,
    failureToken: token(digestKey, 'failure', [originToken, label, failureCode]),
    kind: 'failure',
  }
}

/** Delegates to the common token builder with a concise call site. */
function token(digestKey: Uint8Array, domain: string, values: readonly string[]): string {
  return createRestoreDrillSemanticToken(digestKey, domain, values)
}

/** Returns the canonical reciprocal relation type. */
function reciprocalRelationType(type: CrossDomainRelationType): CrossDomainRelationType {
  if (type === 'blockedBy') return 'blocks'
  if (type === 'blocks') return 'blockedBy'
  if (type === 'child') return 'parent'
  if (type === 'parent') return 'child'
  return type
}

/** Returns the fixed built-in category for one default workflow status. */
function builtInWorkflowStatusCategory(
  statusId: string,
): 'completed' | 'started' | 'unstarted' | undefined {
  if (statusId === 'done') return 'completed'
  if (statusId === 'in-progress' || statusId === 'review') return 'started'
  if (statusId === 'todo') return 'unstarted'
  return undefined
}

/** Checks one lower-case SHA-256 HMAC token. */
function isHexDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value)
}

/** Enforces exhaustive normalized item handling. */
function assertUnreachable(value: never): never {
  void value
  throw new TypeError('RESTORE_DRILL_SEMANTIC_ITEM_INVALID')
}
