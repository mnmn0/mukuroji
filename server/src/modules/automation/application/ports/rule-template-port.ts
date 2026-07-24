import type {
  AutomationRule,
  AutomationTemplate,
  AutomationTemplateApplication,
  AutomationTemplateApplicationResult,
  AutomationTemplateApplicationTarget,
  CreateAutomationRuleInput,
  CreateAutomationTemplateInput,
  UpdateAutomationRuleInput,
  UpdateAutomationTemplateInput,
} from '@mukuroji/contracts'

/** Persistence capability required by Rule and Template use cases. */
export interface AutomationRuleTemplatePort<TCompletionMutation = unknown> {
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
  /** Creates an idempotent rule. */
  createRule(
    workspaceId: string,
    input: CreateAutomationRuleInput,
    idempotencyKey?: string,
  ): Promise<AutomationRule>
  /** Updates a rule with revision compare-and-swap. */
  updateRule(
    workspaceId: string,
    ruleId: string,
    input: UpdateAutomationRuleInput,
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
  /** Deletes a template with revision compare-and-swap. */
  deleteTemplate(
    workspaceId: string,
    templateId: string,
    expectedRevision: number,
  ): Promise<void>
  /** Reserves a pinned template-application receipt. */
  reserveTemplateApplication(
    workspaceId: string,
    actorId: string,
    templateId: string,
    target: AutomationTemplateApplicationTarget,
    idempotencyKey: string,
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
