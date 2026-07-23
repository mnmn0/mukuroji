import type {
  DocumentCapabilities,
  DocumentMemberGrantRole,
  DocumentPermission,
  DocumentScope,
} from '@mukuroji/contracts'

/**
 * Project scope の Document access に対応する既存 Project role です。
 */
export type DocumentProjectRole = 'viewer' | 'member' | 'manager'

/**
 * Document access policy が認識する Workspace role です。
 */
export type DocumentWorkspaceRole = 'owner' | 'admin' | 'member' | 'guest'

/**
 * Document access を評価する認証済み Workspace principal です。
 */
export type DocumentAccessPrincipal = {
  /**
   * Active Workspace membership の安定した member key です。
   */
  memberKey: string
  /**
   * Workspace 全体で付与された role です。
   */
  workspaceRole: DocumentWorkspaceRole
  /**
   * System administrator の break-glass access を持つかどうかです。
   */
  isSystemAdmin: boolean
}

/**
 * Document access 判定に必要な canonical field だけを持つ subject です。
 */
export type DocumentAccessSubject = {
  /**
   * Document の ACL です。
   */
  permission: DocumentPermission
  /**
   * Workspace または Project scope です。
   */
  scope: DocumentScope
  /**
   * Archive 済みの場合の timestamp です。
   */
  archivedAt?: string
}

/**
 * Document permission を評価する source-of-truth context です。
 */
export type ResolveDocumentCapabilitiesInput = {
  /**
   * 現在操作している認証済み Workspace principal です。
   */
  principal: DocumentAccessPrincipal
  /**
   * Access を評価する Document です。
   */
  document: DocumentAccessSubject
  /**
   * 直近の親から root へ向かう順番で並べた ancestor Documents です。
   */
  ancestors?: readonly DocumentAccessSubject[]
  /**
   * Project scope の場合に source of truth から取得した Project role です。
   */
  projectRole?: DocumentProjectRole
  /**
   * External RBAC が許可した scope と role を Document ACL の上限にするかどうかです。
   */
  restrictToAuthorizedScopes?: boolean
  /**
   * Workspace scope で External RBAC が許可した最大 role です。
   */
  workspaceScopeRole?: DocumentProjectRole
}

/**
 * Document API が返す既定の拒否 capabilities です。
 */
export const deniedDocumentCapabilities: DocumentCapabilities = Object.freeze({
  canView: false,
  canEdit: false,
  canComment: false,
  canShare: false,
  canManagePermissions: false,
  canArchive: false,
  canRestore: false,
  canExport: false,
})

/**
 * Document の継承 ACL、private ACL、scope role、guest 上限を合成します。
 *
 * @param input - Principal、対象 Document、ancestor、Project role です。
 * @returns 現在 user に許可する操作 capability です。
 */
export function resolveDocumentCapabilities(
  input: ResolveDocumentCapabilitiesInput,
): DocumentCapabilities {
  const { principal, document } = input
  const accessLevel = resolveDocumentAccessLevel(input)
  const canView = accessLevel >= documentAccessWeights.viewer
  const isArchived = Boolean(document.archivedAt) ||
    (input.ancestors ?? []).some((ancestor) => Boolean(ancestor.archivedAt))
  const canEdit = !isArchived &&
    principal.workspaceRole !== 'guest' &&
    accessLevel >= documentAccessWeights.editor
  const canManage = !isArchived &&
    accessLevel >= documentAccessWeights.manager

  return {
    canView,
    canEdit,
    canComment: !isArchived && principal.workspaceRole !== 'guest' && canView,
    canShare: canManage,
    canManagePermissions: canManage,
    canArchive: !isArchived && canManage,
    canRestore:
      Boolean(document.archivedAt) &&
      accessLevel >= documentAccessWeights.manager,
    canExport: canView,
  }
}

function resolveDocumentAccessLevel(input: ResolveDocumentCapabilitiesInput) {
  const { principal, document } = input
  if (principal.isSystemAdmin) return documentAccessWeights.manager

  let explicitLevel = resolveExplicitDocumentAccess(document, principal.memberKey)
  if (document.permission.mode === 'private') {
    return capAuthorizedScopeAccess(
      capGuestAccess(explicitLevel, principal.workspaceRole),
      input,
    )
  }

  for (const ancestor of input.ancestors ?? []) {
    explicitLevel = Math.max(
      explicitLevel,
      resolveExplicitDocumentAccess(ancestor, principal.memberKey),
    )
    if (ancestor.permission.mode === 'private') {
      return capAuthorizedScopeAccess(
        capGuestAccess(explicitLevel, principal.workspaceRole),
        input,
      )
    }
  }

  const scopeLevel = resolveScopeDocumentAccess(input)
  return capAuthorizedScopeAccess(
    capGuestAccess(
      Math.max(explicitLevel, scopeLevel),
      principal.workspaceRole,
    ),
    input,
  )
}

function resolveExplicitDocumentAccess(
  document: DocumentAccessSubject,
  memberKey: string,
) {
  return document.permission.memberGrants.reduce<number>((level, grant) => {
    if (grant.memberKey !== memberKey) return level
    return Math.max(level, documentGrantWeights[grant.role])
  }, documentAccessWeights.denied)
}

function resolveScopeDocumentAccess(input: ResolveDocumentCapabilitiesInput) {
  const { principal, document } = input
  if (principal.workspaceRole === 'owner' || principal.workspaceRole === 'admin') {
    return documentAccessWeights.manager
  }
  if (principal.workspaceRole === 'guest') {
    return documentAccessWeights.denied
  }
  if (document.scope.type === 'workspace') {
    return documentAccessWeights.editor
  }
  if (input.projectRole === 'manager') return documentAccessWeights.manager
  if (input.projectRole === 'member') return documentAccessWeights.editor
  if (input.projectRole === 'viewer') return documentAccessWeights.viewer
  return documentAccessWeights.denied
}

function capGuestAccess(level: number, workspaceRole: DocumentWorkspaceRole) {
  return workspaceRole === 'guest'
    ? Math.min(level, documentAccessWeights.viewer)
    : level
}

function capAuthorizedScopeAccess(
  level: number,
  input: ResolveDocumentCapabilitiesInput,
) {
  if (!input.restrictToAuthorizedScopes) return level
  const authorizedRole = input.document.scope.type === 'workspace'
    ? input.workspaceScopeRole
    : input.projectRole
  if (authorizedRole === undefined) {
    return documentAccessWeights.denied
  }
  return Math.min(level, documentProjectRoleWeights[authorizedRole])
}

const documentAccessWeights = {
  denied: 0,
  viewer: 1,
  editor: 2,
  manager: 3,
} as const

const documentGrantWeights = {
  viewer: documentAccessWeights.viewer,
  editor: documentAccessWeights.editor,
  manager: documentAccessWeights.manager,
} as const satisfies Record<DocumentMemberGrantRole, number>

const documentProjectRoleWeights = {
  viewer: documentAccessWeights.viewer,
  member: documentAccessWeights.editor,
  manager: documentAccessWeights.manager,
} as const satisfies Record<DocumentProjectRole, number>
