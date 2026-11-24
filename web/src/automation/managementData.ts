import type {
  AutomationExecution,
  AutomationInboundWebhookEndpoint,
  AutomationRule,
  AutomationTemplate,
  RecurringWork,
} from '@mukuroji/contracts'
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
  const [rules, webhooks, templates, recurringWork, executionPage, workflowTargets] = await Promise.all([
    getAutomationRules(accessToken),
    canManage ? getAutomationInboundWebhookEndpoints(accessToken) : Promise.resolve([]),
    getAutomationTemplates(accessToken),
    getRecurringWork(accessToken),
    getAutomationExecutions(accessToken),
    loadAutomationWorkflowTargets(accessToken, teams),
  ])

  return {
    executions: executionPage.executions,
    recurringWork,
    rules,
    templates,
    webhooks,
    workflowTargets,
  }
}

async function loadAutomationWorkflowTargets(
  accessToken: string,
  teams: ProjectDirectoryTeam[],
): Promise<AutomationWorkflowTargetOption[]> {
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
  return [
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
}
