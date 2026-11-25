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

/** Longest reviewer member key the server accepts. */
const REVIEWER_MEMBER_KEY_MAX_LENGTH = 320

/**
 * Reads the member key a requester typed to add a reviewer by hand.
 *
 * The member list needs a member read permission that requesting an approval does not, so a key
 * can be entered directly; the server checks that the member is active and can view the Work Item.
 *
 * @param query - Text typed in the reviewer field.
 * @param selectedKeys - Reviewers already chosen.
 * @returns The normalized key, or undefined when it is blank, too long, or already chosen.
 */
export function readEnteredReviewerKey(query: string, selectedKeys: readonly string[]) {
  const memberKey = query.trim().toLowerCase()
  if (!memberKey || memberKey.length > REVIEWER_MEMBER_KEY_MAX_LENGTH) return undefined
  return selectedKeys.includes(memberKey) ? undefined : memberKey
}

/**
 * Lists the chosen reviewers that the offered members do not name, so they stay visible.
 *
 * @param selectedKeys - Reviewers already chosen.
 * @param offeredKeys - Member keys the picker offers.
 * @returns The chosen keys outside the offered members, in the order they were chosen.
 */
export function listEnteredReviewerKeys(
  selectedKeys: readonly string[],
  offeredKeys: readonly string[],
) {
  return selectedKeys.filter((memberKey) => !offeredKeys.includes(memberKey))
}
