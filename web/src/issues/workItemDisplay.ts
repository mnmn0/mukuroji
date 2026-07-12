import type { WorkItem } from '@mukuroji/contracts'

/**
 * Work Item の literal title を優先し、未保存または migration fallback の場合だけ表示 key を解決します。
 *
 * @typeParam TDisplayKey - titleKey の表示解決に使う key の型です。
 * @param workItem - タイトルを表示する Work Item です。
 * @param resolveTitleKey - titleKey を表示文言へ変換する関数です。
 * @returns 画面に表示する Work Item タイトルです。
 */
export function resolveWorkItemTitle<TDisplayKey extends string>(
  workItem: Pick<WorkItem<TDisplayKey>, 'id' | 'title' | 'titleKey'>,
  resolveTitleKey: (key: TDisplayKey) => string,
) {
  if (workItem.title && workItem.title !== workItem.titleKey) {
    return workItem.title
  }

  return workItem.titleKey
    ? resolveTitleKey(workItem.titleKey)
    : (workItem.title ?? workItem.id)
}

/**
 * Work Item の担当者表示を canonical field から既存の優先順で解決します。
 *
 * @typeParam TDisplayKey - assigneeKey の表示解決に使う key の型です。
 * @param workItem - 担当者を表示する Work Item です。
 * @param resolveAssigneeKey - assigneeKey を表示文言へ変換する任意の関数です。
 * @returns 画面に表示する担当者名です。
 */
export function resolveWorkItemAssignee<TDisplayKey extends string>(
  workItem: Pick<
    WorkItem<TDisplayKey>,
    | 'assignee'
    | 'assigneeEmail'
    | 'assigneeKey'
    | 'assigneeName'
    | 'assigneeUserId'
  >,
  resolveAssigneeKey?: (key: TDisplayKey) => string,
) {
  return workItem.assigneeName ??
    workItem.assigneeEmail ??
    workItem.assigneeUserId ??
    workItem.assignee ??
    (workItem.assigneeKey
      ? resolveAssigneeKey?.(workItem.assigneeKey) ?? workItem.assigneeKey
      : '')
}
