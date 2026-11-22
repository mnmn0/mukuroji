/**
 * Combines the assignee picker with the "other assignees" text after the user edits the text.
 *
 * `undefined` keeps every assignee and `[]` keeps none, as in the other multi-select filters.
 * IDs that were in the text the user started editing belong to that text, even when the
 * member list arrived meanwhile and would now place them in the picker.
 *
 * @param current - The filter's assignee IDs before the edit.
 * @param pickedIds - Assignee IDs the picker currently shows as selected.
 * @param typedText - The comma-separated text the user typed.
 * @param editedFromText - The text the input showed when the user started editing.
 * @returns The assignee IDs to store in the filter.
 */
export function mergeAnalyticsAssigneeDraft(
  current: readonly string[] | undefined,
  pickedIds: readonly string[],
  typedText: string,
  editedFromText: string,
): string[] | undefined {
  const typed = splitAssigneeText(typedText)
  if (current === undefined && typed.length === 0) return undefined
  const editedIds = new Set(splitAssigneeText(editedFromText))
  const picked = pickedIds.filter((id) => !editedIds.has(id))
  return [...new Set([...picked, ...typed])]
}

/**
 * Splits comma-separated assignee text into trimmed, non-empty IDs.
 *
 * @param text - The text to split.
 * @returns The IDs in order of appearance.
 */
function splitAssigneeText(text: string) {
  return text.split(',').map((item) => item.trim()).filter(Boolean)
}
