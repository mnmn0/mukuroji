import type {
  AutomationAction,
  AutomationRule,
  AutomationTemplate,
  AutomationTemplateApplication,
  AutomationTemplateApplicationResult,
  AutomationTemplateApplicationTarget,
  CreateAutomationRuleInput,
  CreateAutomationTemplateInput,
  UpdateAutomationRuleInput,
  UpdateAutomationTemplateInput,
  WorkItemScheduleCalendarPolicy,
} from '@mukuroji/contracts'

/**
 * Checks the actions of a rule after their template versions are pinned and before the rule is
 * written, so the check sees the exact template versions the rule will run with.
 *
 * @param actions - Rule actions with `templateVersion` set on template create actions.
 * @throws When the pinned actions are not allowed for the rule.
 */
export type AutomationPinnedActionsGuard = (actions: readonly AutomationAction[]) => Promise<void>

/** Persistence capability required by Rule and Template use cases. */
export interface AutomationRuleTemplatePort<TCompletionMutation = unknown> {
  /**
   * Reads the monotonic revision for all mutable Automation definitions in a Workspace.
   *
   * @param workspaceId - Workspace whose Automation definitions are fenced.
   * @returns Current definition revision, or zero before the sentinel is created.
   */
  getAutomationDefinitionRevision(workspaceId: string): Promise<number>
  /**
   * Creates a commit-time condition check for the Automation definition revision.
   *
   * @param workspaceId - Workspace whose Automation definitions are fenced.
   * @param expectedRevision - Revision observed before configuration validation.
   * @returns Adapter-owned condition mutation for the completion transaction.
   */
  createAutomationDefinitionRevisionConditionCheck(
    workspaceId: string,
    expectedRevision: number,
  ): TCompletionMutation
  /** Lists current rules in a Workspace. */
  listRules(workspaceId: string): Promise<AutomationRule[]>
  /** Reads a current rule. */
  getRule(workspaceId: string, ruleId: string): Promise<AutomationRule | undefined>
  /** Reads an immutable rule version. */
  getRuleVersion(
    workspaceId: string,
    ruleId: string,
    version: number,
  ): Promise<AutomationRule | undefined>
  /**
   * Creates an idempotent rule.
   *
   * @param workspaceId - Workspace that owns the rule.
   * @param input - Validated rule definition.
   * @param idempotencyKey - Client idempotency key; a replay returns the first rule.
   * @param createdByMemberKey - Member who creates the rule; failure notifications reach them.
   * @param assertPinnedActions - Check run on the actions after template versions are pinned.
   * @returns The created or replayed rule.
   */
  createRule(
    workspaceId: string,
    input: CreateAutomationRuleInput,
    idempotencyKey?: string,
    createdByMemberKey?: string,
    assertPinnedActions?: AutomationPinnedActionsGuard,
  ): Promise<AutomationRule>
  /** Updates a rule with revision compare-and-swap. */
  updateRule(
    workspaceId: string,
    ruleId: string,
    input: UpdateAutomationRuleInput,
    assertPinnedActions?: AutomationPinnedActionsGuard,
  ): Promise<AutomationRule>
  /** Deletes a rule with revision compare-and-swap. */
  deleteRule(workspaceId: string, ruleId: string, expectedRevision: number): Promise<void>
  /** Lists due schedule-trigger rules from one schedule shard. */
  listDueScheduledRules(
    scheduleShard: string,
    dueAt: string,
    limit?: number,
  ): Promise<AutomationRule[]>
  /** Advances a completed schedule-trigger rule slot. */
  completeScheduledRule(
    workspaceId: string,
    ruleId: string,
    expectedRevision: number,
    lastRunAt: string,
    nextRunAt: string,
  ): Promise<AutomationRule>
  /** Lists current templates in a Workspace. */
  listTemplates(workspaceId: string): Promise<AutomationTemplate[]>
  /** Reads a current template. */
  getTemplate(
    workspaceId: string,
    templateId: string,
  ): Promise<AutomationTemplate | undefined>
  /** Reads an immutable template version. */
  getTemplateVersion(
    workspaceId: string,
    templateId: string,
    version: number,
  ): Promise<AutomationTemplate | undefined>
  /** Creates an idempotent template. */
  createTemplate(
    workspaceId: string,
    input: CreateAutomationTemplateInput,
    idempotencyKey?: string,
  ): Promise<AutomationTemplate>
  /** Updates a template with revision compare-and-swap. */
  updateTemplate(
    workspaceId: string,
    templateId: string,
    input: UpdateAutomationTemplateInput,
  ): Promise<AutomationTemplate>
  /**
   * Deletes a template with revision compare-and-swap.
   *
   * @param workspaceId - Workspace that owns the template.
   * @param templateId - Template to delete.
   * @param expectedRevision - Template revision the caller read.
   * @param expectedDefinitionRevision - Workspace definition revision the caller read while
   *   checking that no rule or recurring definition uses the template; any definition change in
   *   between rejects the delete.
   * @returns A promise that resolves after the delete.
   */
  deleteTemplate(
    workspaceId: string,
    templateId: string,
    expectedRevision: number,
    expectedDefinitionRevision?: number,
  ): Promise<void>
  /**
   * Reserves a pinned template-application receipt. A new receipt of a Project template keeps the
   * policy `readCalendarPolicy` returns for the template version being pinned, and nothing is
   * written when it throws; a replay returns the receipt with the policy it already pinned without
   * calling it, so a failed calendar read never blocks a replay.
   */
  reserveTemplateApplication(
    workspaceId: string,
    actorId: string,
    templateId: string,
    target: AutomationTemplateApplicationTarget,
    idempotencyKey: string,
    readCalendarPolicy?: (templateVersion: number) => Promise<WorkItemScheduleCalendarPolicy>,
  ): Promise<AutomationTemplateApplication>
  /** Reads a template-application receipt. */
  getTemplateApplication(
    workspaceId: string,
    applicationId: string,
  ): Promise<AutomationTemplateApplication | undefined>
  /** Claims an expired or pending template-application lease. */
  claimTemplateApplication(
    application: AutomationTemplateApplication,
    now: Date,
    leaseExpiresAt: string,
  ): Promise<AutomationTemplateApplication | undefined>
  /** Creates the adapter-owned atomic completion mutation. */
  createTemplateApplicationCompletionMutation(
    application: AutomationTemplateApplication,
    result: AutomationTemplateApplicationResult,
  ): TCompletionMutation
  /** Saves a template-application receipt with revision compare-and-swap. */
  saveTemplateApplication(
    application: AutomationTemplateApplication,
    expectedRevision: number,
  ): Promise<void>
}
