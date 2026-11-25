import type { WorkflowRuleUnmetCondition } from '@mukuroji/contracts'

/**
 * Lambda API からエラーレスポンスが返ったときに投げる例外です。
 */
export class TeamIssuesApiError extends Error {
  /**
   * API レスポンスの HTTP status code です。
   */
  readonly status: number

  /**
   * API が返した安定 error code です。
   */
  readonly code?: string

  /** Workflow rules the rejected status change did not meet; empty for every other error. */
  readonly workflowRuleConditions: readonly WorkflowRuleUnmetCondition[]

  constructor(
    status: number,
    message: string,
    code?: string,
    workflowRuleConditions: readonly WorkflowRuleUnmetCondition[] = [],
  ) {
    super(message)
    this.status = status
    this.code = code
    this.workflowRuleConditions = workflowRuleConditions
  }
}
