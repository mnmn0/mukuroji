import type { CanonicalWorkItem } from '@mukuroji/contracts'

/**
 * Canonical Work Item の literal title を返します。
 *
 * @param workItem - タイトルを表示する Work Item です。
 * @returns 画面に表示する Work Item タイトルです。
 */
export function resolveWorkItemTitle(workItem: CanonicalWorkItem) {
  return workItem.title
}

/**
 * Work Item の担当者表示を canonical field から解決します。
 *
 * @param workItem - 担当者を表示する Work Item です。
 * @returns 画面に表示する担当者名です。
 */
export function resolveWorkItemAssignee(workItem: CanonicalWorkItem) {
  return workItem.assigneeName ??
    workItem.assigneeEmail ??
    workItem.assigneeUserId
}
