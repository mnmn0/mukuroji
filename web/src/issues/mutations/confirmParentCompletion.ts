import {
  DEFAULT_WORK_ITEM_PARENT_COMPLETION_POLICY,
  isWorkItemHierarchyClosedCategory,
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
   * @param openChildCount - Number of open children, at least 1.
   * @returns Whether to go ahead.
   */
  confirm: (openChildCount: number) => boolean
  /** Counts open children; defaults to the Team Work Item API. */
  countOpenChildren?: (teamId: string, workItemId: string, accessToken: string) => Promise<number>
}

/**
 * Asks before completing a Work Item that still has open children, when the Team only warns.
 *
 * Every Web screen that changes a status calls this, so the `warn` policy asks the same question
 * everywhere. Under `reject` the server refuses the change, so nothing is asked. If the count
 * cannot be read, the change goes ahead, because `warn` never blocks a completion on the server.
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
  if (nextStatusCategory !== 'completed' || isWorkItemHierarchyClosedCategory(workItem.statusCategory)) {
    return true
  }
  const policy = configuration?.parentCompletionPolicy ?? DEFAULT_WORK_ITEM_PARENT_COMPLETION_POLICY
  if (policy !== 'warn') return true
  let openChildCount: number
  try {
    openChildCount = await countOpenChildren(workItem.teamId, workItem.id, accessToken)
  } catch {
    return true
  }
  return openChildCount === 0 || confirm(openChildCount)
}

/**
 * Asks the person, with a browser dialog, whether to complete a parent that has open children.
 *
 * @param t - Localized message resolver.
 * @param openChildCount - Number of open children.
 * @returns Whether the person chose to go ahead.
 */
export function confirmParentCompletionInBrowser(
  t: (key: MessageKey) => string,
  openChildCount: number,
): boolean {
  return globalThis.window.confirm(t('issues.outline.completeWarning').replace('{count}', String(openChildCount)))
}
