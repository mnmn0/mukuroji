import type {
  AutomationExecution,
  AutomationInboundWebhookEndpoint,
  AutomationRule,
  AutomationTemplate,
  CustomFieldType,
  RecurringWork,
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import type {
  AutomationRuleConditionValueType,
  AutomationRulePickerOption,
} from './model/ruleDefinitionDraft'
import type { ProjectDirectoryTeam } from '../projects/api'
import { getWorkItemConfiguration } from '../work-items/api'
import type { AutomationWorkflowTargetOption } from './ui/AutomationManagementPanel'
import {
  getAutomationExecutions,
  getAutomationInboundWebhookEndpoints,
  getAutomationRules,
  getAutomationTemplates,
  getRecurringWork,
} from './api'

/** Automation management panel が表示する取得済み data です。 */
export type AutomationManagementData = {
  /** Rule 一覧です。 */
  rules: AutomationRule[]
  /** Secret を含まない admin-only inbound Webhook endpoint 一覧です。 */
  webhooks: AutomationInboundWebhookEndpoint[]
  /** Template 一覧です。 */
  templates: AutomationTemplate[]
  /** Recurring Work 一覧です。 */
  recurringWork: RecurringWork[]
  /** Execution history です。 */
  executions: AutomationExecution[]
  /** Workflow application の scope/revision 選択肢です。 */
  workflowTargets: AutomationWorkflowTargetOption[]
  /** Workflow statuses the rule editor offers, from the Workspace and every readable Team. */
  statusOptions: AutomationRulePickerOption[]
  /** Custom fields the rule editor offers, from the Workspace and every readable Team. */
  customFieldOptions: AutomationRulePickerOption[]
}

/**
 * Automation 管理画面の参照可能な resource をまとめて取得します。
 *
 * @param accessToken - Automation API の access token です。
 * @param teams - Workflow target を解決する Team 一覧です。
 * @param canManage - Admin-only inbound Webhook metadata を取得できるかどうかです。
 * @returns 権限に応じて redaction 済みの管理画面 data です。
 */
export async function loadAutomationManagementData(
  accessToken: string,
  teams: ProjectDirectoryTeam[],
  canManage: boolean,
): Promise<AutomationManagementData> {
  const [rules, webhooks, templates, recurringWork, executionPage, configurations] = await Promise.all([
    getAutomationRules(accessToken),
    canManage ? getAutomationInboundWebhookEndpoints(accessToken) : Promise.resolve([]),
    getAutomationTemplates(accessToken),
    getRecurringWork(accessToken),
    getAutomationExecutions(accessToken),
    loadAutomationWorkflowConfigurations(accessToken, teams),
  ])

  return {
    executions: executionPage.executions,
    recurringWork,
    rules,
    templates,
    webhooks,
    workflowTargets: configurations.workflowTargets,
    statusOptions: collectPickerOptions(configurations.configurations, readWorkflowStatuses),
    customFieldOptions: collectPickerOptions(
      configurations.configurations,
      (configuration) => (configuration.customFields ?? []).map((field) => {
        const valueType = readCustomFieldValueType(field.type)
        return { id: field.id, name: field.name, ...(valueType ? { valueType } : {}) }
      }),
    ),
  }
}

/**
 * Tells which type a custom field's stored values have, for typed condition values.
 *
 * @param type - Custom field type.
 * @returns `number` or `boolean`, or undefined for fields compared as text.
 */
function readCustomFieldValueType(type: CustomFieldType): AutomationRuleConditionValueType | undefined {
  switch (type) {
    case 'number':
    case 'currency':
    case 'duration':
    case 'formula':
      return 'number'
    case 'boolean':
      return 'boolean'
    default:
      return undefined
  }
}

/**
 * Reads the statuses of every workflow a configuration holds. Picker choices are optional, so a
 * configuration response without workflows yields none instead of failing the panel.
 *
 * @param configuration - Workspace or Team configuration.
 * @returns Statuses of its workflows.
 */
function readWorkflowStatuses(configuration: WorkItemConfiguration): Array<{ id: string; name: string }> {
  const workflows = configuration.workflows ?? (configuration.workflow ? [configuration.workflow] : [])
  return workflows.flatMap((workflow) => workflow.statuses ?? [])
}

/**
 * Lists unique picker options from several configurations, first name winning for a shared ID.
 *
 * @param configurations - Workspace and Team configurations.
 * @param read - Reads the entries of one configuration.
 * @returns Options sorted by name.
 */
function collectPickerOptions(
  configurations: WorkItemConfiguration[],
  read: (configuration: WorkItemConfiguration) => Array<{
    id: string
    name: string
    valueType?: AutomationRuleConditionValueType
  }>,
): AutomationRulePickerOption[] {
  const options = new Map<string, AutomationRulePickerOption>()
  for (const configuration of configurations) {
    for (const entry of read(configuration)) {
      if (options.has(entry.id)) continue
      options.set(entry.id, {
        id: entry.id,
        label: entry.name,
        ...(entry.valueType ? { valueType: entry.valueType } : {}),
      })
    }
  }
  return [...options.values()].sort((first, second) => first.label.localeCompare(second.label))
}

/**
 * Loads the Workspace and Team Work Item configurations the panel uses.
 *
 * @param accessToken - Automation API の access token です。
 * @param teams - Teams whose configurations are read; unreadable ones are skipped.
 * @returns Workflow application targets and the configurations that could be read.
 */
async function loadAutomationWorkflowConfigurations(
  accessToken: string,
  teams: ProjectDirectoryTeam[],
): Promise<{ workflowTargets: AutomationWorkflowTargetOption[]; configurations: WorkItemConfiguration[] }> {
  const [workspace, ...teamResults] = await Promise.allSettled([
    getWorkItemConfiguration(accessToken, { kind: 'workspace' }),
    ...teams.map((team) => getWorkItemConfiguration(accessToken, {
      kind: 'team' as const,
      teamId: team.id,
    })),
  ])
  if (!workspace || workspace.status === 'rejected') {
    throw workspace?.reason ?? new Error('Workspace workflow configuration is unavailable.')
  }
  const workflowTargets: AutomationWorkflowTargetOption[] = [
    {
      expectedRevision: workspace.value.configuration.revision,
      name: workspace.value.configuration.scopeId,
      scopeId: workspace.value.configuration.scopeId,
      scopeType: 'workspace',
    },
    ...teamResults.flatMap((result, index) => {
      const team = teams[index]
      if (!team || result.status === 'rejected') return []
      return [{
        expectedRevision: result.value.inheritedFrom
          ? 0
          : result.value.configuration.revision,
        ...(result.value.inheritedFrom ? { inheritedFrom: result.value.inheritedFrom } : {}),
        name: team.name,
        scopeId: team.id,
        scopeType: 'team' as const,
      }]
    }),
  ]
  return {
    workflowTargets,
    configurations: [
      workspace.value.configuration,
      ...teamResults.flatMap((result) => result.status === 'fulfilled' ? [result.value.configuration] : []),
    ],
  }
}
