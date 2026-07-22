import type {
  AutomationValue,
  BulkOperation,
  BulkOperationRequest,
  WorkItemPriority,
} from '@mukuroji/contracts'

/** Bulk selection を API identity と table selection key へ結び付けます。 */
export type BulkOperationSelection = {
  /** TaskPage 内で checkbox state を識別する key です。 */
  selectionKey: string
  /** Work Item を所有する Team ID です。 */
  teamId: string
  /** Team 内の Work Item ID です。 */
  workItemId: string
  /** Preview/apply の optimistic concurrency revision です。 */
  expectedRevision: number
  /** Toolbar の selection summary に表示する label です。 */
  label: string
}

/** Bulk edit で更新できる Work Item fields です。 */
export const bulkEditFields = ['workflowStatusId', 'assigneeUserId', 'dueDate', 'priority'] as const

/** Bulk edit で更新できる Work Item field です。 */
export type BulkEditField = (typeof bulkEditFields)[number]

/** Bulk edit の入力値を Work Item の保存形式へ正規化した patch にします。 */
export function createBulkEditPatch(
  field: BulkEditField,
  value: string,
): Record<string, AutomationValue> {
  const normalizedValue = value.trim()
  if (field === 'priority') {
    return { priority: normalizedValue as WorkItemPriority }
  }
  if (field === 'dueDate') {
    return { dueDate: normalizedValue.replaceAll('-', '/') }
  }
  return { [field]: normalizedValue }
}

/**
 * Preview を取得した request が現在の正規化済み request 全体と一致するか判定します。
 */
export function isBulkOperationPreviewRequestCurrent(
  previewedRequest: BulkOperationRequest | undefined,
  currentRequest: BulkOperationRequest | undefined,
) {
  if (!previewedRequest || !currentRequest) {
    return false
  }

  return createBulkOperationRequestSignature(previewedRequest) ===
    createBulkOperationRequestSignature(currentRequest)
}

/** Failed status の item だけを retry 対象として返します。 */
export function getRetryableBulkOperationItems(operation: BulkOperation) {
  return operation.items.filter((item) => item.status === 'failed' && item.retryable)
}

/** Running operation で apply 再送時に再開する未完了 item を返します。 */
export function getResumableBulkOperationItems(operation: BulkOperation) {
  if (operation.status !== 'running') {
    return []
  }

  return operation.items.filter((item) =>
    item.status === 'ready' || (item.status === 'failed' && item.retryable)
  )
}

/** Selection 解除対象となる成功 item を返します。 */
export function getSucceededBulkOperationItems(operation: BulkOperation) {
  return operation.items.filter((item) => item.status === 'succeeded')
}

/** Team/Work Item の組を衝突しない UI identity にします。 */
export function createBulkItemIdentity(teamId: string, workItemId: string) {
  return `${teamId}\u0000${workItemId}`
}

/** 表示中 selection key のみを一括で追加または解除します。 */
export function updateVisibleBulkSelection(
  currentSelectionKeys: string[],
  visibleSelectionKeys: string[],
  selected: boolean,
) {
  if (selected) {
    return [...new Set([...currentSelectionKeys, ...visibleSelectionKeys])]
  }

  const visibleKeySet = new Set(visibleSelectionKeys)
  return currentSelectionKeys.filter((selectionKey) => !visibleKeySet.has(selectionKey))
}

/** 選択済み item の revision snapshot を保ったまま selection を更新します。 */
export function updateBulkItemSelection(
  currentItems: BulkOperationSelection[],
  availableItems: BulkOperationSelection[],
  selectionKeys: string[],
  selected: boolean,
) {
  const nextSelectionKeys = updateVisibleBulkSelection(
    currentItems.map((item) => item.selectionKey),
    selectionKeys,
    selected,
  )
  const itemsBySelectionKey = new Map(
    currentItems.map((item) => [item.selectionKey, item]),
  )

  for (const item of availableItems) {
    if (!itemsBySelectionKey.has(item.selectionKey)) {
      itemsBySelectionKey.set(item.selectionKey, item)
    }
  }

  return nextSelectionKeys.flatMap((selectionKey) => {
    const item = itemsBySelectionKey.get(selectionKey)
    return item ? [item] : []
  })
}

/** Operation 成功 item だけを TaskPage selection から除外します。 */
export function clearSucceededBulkSelection(
  currentSelectionKeys: string[],
  selectedItems: BulkOperationSelection[],
  operation: BulkOperation,
) {
  const succeededIdentities = new Set(
    getSucceededBulkOperationItems(operation)
      .map((item) => createBulkItemIdentity(item.teamId, item.workItemId)),
  )
  const succeededSelectionKeys = new Set(
    selectedItems
      .filter((item) => succeededIdentities.has(createBulkItemIdentity(item.teamId, item.workItemId)))
      .map((item) => item.selectionKey),
  )

  return currentSelectionKeys.filter((selectionKey) => !succeededSelectionKeys.has(selectionKey))
}

function createBulkOperationRequestSignature(request: BulkOperationRequest) {
  return stableStringify({
    ...request,
    items: [...request.items].sort((first, second) =>
      compareAscendingStrings(first.teamId, second.teamId) ||
      compareAscendingStrings(first.workItemId, second.workItemId) ||
      first.expectedRevision - second.expectedRevision
    ),
  })
}

function compareAscendingStrings(first: string, second: string) {
  if (first < second) {
    return -1
  }
  if (first > second) {
    return 1
  }
  return 0
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${
      Object.entries(value)
        .sort(([firstKey], [secondKey]) => compareAscendingStrings(firstKey, secondKey))
        .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
        .join(',')
    }}`
  }
  return JSON.stringify(value) ?? 'undefined'
}
