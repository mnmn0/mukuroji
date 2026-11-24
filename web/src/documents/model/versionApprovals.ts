import type { ApprovalRequest } from '@mukuroji/contracts'

/**
 * Chooses the badge style of an approval status shown on Document versions.
 *
 * @param status - Approval status.
 * @returns Badge class names.
 */
export function resolveApprovalStatusClassName(status: ApprovalRequest['status']) {
  if (status === 'approved') return 'workbench-badge border-emerald-200 bg-emerald-50 text-fg-emerald-800'
  if (status === 'rejected' || status === 'changes-requested') {
    return 'workbench-badge border-red-200 bg-red-50 text-fg-red-800'
  }
  if (status === 'pending') return 'workbench-badge border-amber-200 bg-amber-50 text-fg-amber-800'
  return 'workbench-badge'
}
