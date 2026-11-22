import {
  DEFAULT_WORK_ITEM_PARENT_COMPLETION_POLICY,
  type WorkflowStatusCategory,
  type WorkItemConfiguration,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import { getWorkItemOpenChildCount } from '../../work-items/api/hierarchy'

/** Inputs for {@link confirmParentCompletion}. */
export type ConfirmParentCompletionInput = {
  /** Work Item whose status changes. */
  workItem: {
    /** Work Item ID. */
    id: string
    /** Team that owns the Work Item. */
    teamId: string
    /** Status category before the change. */
    statusCategory: WorkflowStatusCategory
  }
  /** Status category after the change; `undefined` when the status does not change or is unknown. */
  nextStatusCategory: WorkflowStatusCategory | undefined
  /** Team configuration that holds the parent completion policy. */
  configuration: Pick<WorkItemConfiguration, 'parentCompletionPolicy'> | undefined
  /** Access token used to count the open children. */
  accessToken: string
  /**
   * Asks the person whether to complete the parent anyway.
   *
   * @param openChildCount - Number of open children, at least 1; `null` when they could not be
   *   counted, so it is unknown whether any is open.
   * @returns Whether to go ahead.
   */
  confirm: (openChildCount: number | null) => boolean
  /** Counts open children; defaults to the Team Work Item API. */
  countOpenChildren?: (teamId: string, workItemId: string, accessToken: string) => Promise<number>
}

/**
 * Asks before completing a Work Item that still has open children, when the Team only warns.
 *
 * Every Web screen that changes a status calls this, so the `warn` policy asks the same question
 * everywhere. Under `reject` the server refuses the change, so nothing is asked. If the count
 * cannot be read, the person is still asked, without a count, so an open child is never skipped
 * silently.
 *
 * @param input - Work Item, target category, policy, and how to ask.
 * @returns Whether the update should go ahead.
 */
export async function confirmParentCompletion({
  workItem,
  nextStatusCategory,
  configuration,
  accessToken,
  confirm,
  countOpenChildren = getWorkItemOpenChildCount,
}: ConfirmParentCompletionInput): Promise<boolean> {
  // Like the server's check, only a Work Item already completed is exempt; a canceled one moving
  // to completed still asks.
  if (nextStatusCategory !== 'completed' || workItem.statusCategory === 'completed') {
    return true
  }
  const policy = configuration?.parentCompletionPolicy ?? DEFAULT_WORK_ITEM_PARENT_COMPLETION_POLICY
  if (policy !== 'warn') return true
  let openChildCount: number
  try {
    openChildCount = await countOpenChildren(workItem.teamId, workItem.id, accessToken)
  } catch {
    return confirm(null)
  }
  return openChildCount === 0 || confirm(openChildCount)
}

/**
 * Asks the person, with a browser dialog, whether to complete a parent that has open children.
 *
 * @param t - Localized message resolver.
 * @param openChildCount - Number of open children, or `null` when they could not be counted.
 * @returns Whether the person chose to go ahead.
 */
export function confirmParentCompletionInBrowser(
  t: (key: MessageKey) => string,
  openChildCount: number | null,
): boolean {
  return globalThis.window.confirm(openChildCount === null
    ? t('issues.outline.completeWarningUncounted')
    : t('issues.outline.completeWarning').replace('{count}', String(openChildCount)))
}

/** One Work Item of {@link confirmParentsCompletion}. */
export type ConfirmParentsCompletionTarget = Pick<ConfirmParentCompletionInput, 'workItem' | 'nextStatusCategory'>

/** Inputs for {@link confirmParentsCompletion}. */
export type ConfirmParentsCompletionInput = Omit<ConfirmParentCompletionInput, 'workItem' | 'nextStatusCategory'> & {
  /** Work Items whose status changes together. */
  targets: readonly ConfirmParentsCompletionTarget[]
}

/**
 * Asks once before completing several Work Items when any of them still has open children.
 *
 * Applies the same rules as {@link confirmParentCompletion} to every target, then asks a single
 * question with the total open child count, or without a count when any could not be read.
 *
 * @param input - Work Items, target categories, policy, and how to ask.
 * @returns Whether the change should go ahead.
 */
export async function confirmParentsCompletion({
  targets,
  confirm,
  ...shared
}: ConfirmParentsCompletionInput): Promise<boolean> {
  const counts: (number | null)[] = []
  await Promise.all(targets.map((target) => confirmParentCompletion({
    ...shared,
    ...target,
    confirm: (openChildCount) => {
      counts.push(openChildCount)
      return true
    },
  })))
  if (counts.length === 0) return true
  const total = counts.reduce<number | null>(
    (sum, count) => sum === null || count === null ? null : sum + count,
    0,
  )
  return confirm(total)
}
