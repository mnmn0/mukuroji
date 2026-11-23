import type {
  DocumentChecklistBlock,
  DocumentChecklistItem,
} from '@mukuroji/contracts'

/**
 * One member offered as the owner of a checklist item.
 */
export type ChecklistAssigneeOption = {
  /** Normalized Workspace member key saved on the item. */
  id: string
  /** Display name or email shown in the picker and next to the item. */
  label: string
}

/**
 * Owner and deadline change for one checklist item. A blank value clears the
 * field; an omitted key leaves it as it is.
 */
export type ChecklistItemOwnershipChange = {
  /** New owner member key, or an empty string to clear the owner. */
  assigneeMemberKey?: string
  /** New `YYYY-MM-DD` deadline, or an empty string to clear the deadline. */
  dueDate?: string
}

/**
 * Applies an owner or deadline change to one checklist item.
 *
 * Cleared fields are removed rather than saved as empty strings, because the
 * server only accepts a non-empty member key and a real calendar date.
 *
 * @param block - Checklist block that contains the item.
 * @param itemId - Item to change.
 * @param change - Owner and deadline values to set or clear.
 * @returns The block with the item changed; other items are kept as they are.
 */
export function updateChecklistItemOwnership(
  block: DocumentChecklistBlock,
  itemId: string,
  change: ChecklistItemOwnershipChange,
): DocumentChecklistBlock {
  return {
    ...block,
    items: block.items.map((item) =>
      item.id === itemId ? applyOwnershipChange(item, change) : item),
  }
}

/**
 * Sets or removes the owner and deadline fields of one item.
 *
 * @param item - Item to change.
 * @param change - Values to set or clear.
 * @returns The changed item.
 */
function applyOwnershipChange(
  item: DocumentChecklistItem,
  change: ChecklistItemOwnershipChange,
): DocumentChecklistItem {
  const { assigneeMemberKey, dueDate, ...rest } = item
  const nextAssignee = change.assigneeMemberKey === undefined
    ? assigneeMemberKey
    : change.assigneeMemberKey || undefined
  const nextDueDate = change.dueDate === undefined
    ? dueDate
    : change.dueDate || undefined
  return {
    ...rest,
    ...(nextAssignee ? { assigneeMemberKey: nextAssignee } : {}),
    ...(nextDueDate ? { dueDate: nextDueDate } : {}),
  }
}

/**
 * Resolves the label shown for an item owner.
 *
 * A member who is no longer offered, for example after leaving the Project,
 * is shown by the saved member key so the owner never disappears silently.
 *
 * @param options - Members offered as owners.
 * @param memberKey - Saved owner member key.
 * @returns Display label, or undefined when the item has no owner.
 */
export function resolveChecklistAssigneeLabel(
  options: readonly ChecklistAssigneeOption[],
  memberKey: string | undefined,
): string | undefined {
  if (!memberKey) return undefined
  return options.find((option) => option.id === memberKey)?.label ?? memberKey
}

/**
 * Tells whether an open item is past its deadline.
 *
 * @param item - Checklist item.
 * @param today - Viewer's local `YYYY-MM-DD` date.
 * @returns True when the item is not done and its deadline is before today.
 */
export function isChecklistItemOverdue(
  item: Pick<DocumentChecklistItem, 'checked' | 'dueDate'>,
  today: string,
): boolean {
  return !item.checked && item.dueDate !== undefined && item.dueDate < today
}
