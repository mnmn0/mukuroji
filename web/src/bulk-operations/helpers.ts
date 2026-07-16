import type { BulkOperation } from '@mukuroji/contracts'
import type { BulkOperationSelection } from './BulkOperationToolbar'

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
