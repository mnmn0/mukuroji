import type {
  AutomationTemplateApplication,
  UpdateAutomationTemplateInput,
} from '@mukuroji/contracts'
import { useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import { createMutationRequestRunner, type MutationRequestContext } from '../api/mutationHeaders'
import { createTranslator, type Locale } from '../i18n'
import type { ProjectDirectoryTeam } from '../projects/api'
import { AutomationManagementPanel } from './AutomationManagementPanel'
import { readAutomationManagementTab } from './tabs'
import {
  applyAutomationTemplate,
  createAutomationInboundWebhookEndpoint,
  createAutomationRule,
  createAutomationTemplate,
  createRecurringWork,
  duplicateAutomationTemplate,
  getAutomationTemplateApplication,
  pauseAutomationInboundWebhookEndpoint,
  resumeAutomationInboundWebhookEndpoint,
  revokeAutomationInboundWebhookEndpoint,
  retryAutomationExecution,
  rotateAutomationInboundWebhookEndpoint,
  updateAutomationRule,
  updateAutomationTemplate,
  updateRecurringWork,
} from './api'
import {
  loadAutomationManagementData,
  type AutomationManagementData,
} from './managementData'
import { runAutomationManagementMutation } from './mutation'

/** Automation management panel container の props です。 */
export type AutomationManagementPanelContainerProps = {
  /** Automation API の Authorization header に使う access token です。 */
  accessToken: string
  /** 表示 locale です。 */
  locale: Locale
  /** Rule、template、recurring Work を変更できるかどうかです。 */
  canManage: boolean
  /** Recurring Work selector に表示する Team 一覧です。 */
  teams: ProjectDirectoryTeam[]
}

/** Automation API と Settings panel を接続する container です。 */
export function AutomationManagementPanelContainer({
  accessToken,
  canManage,
  locale,
  teams,
}: AutomationManagementPanelContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const mutationRunner = useRef(createMutationRequestRunner()).current
  const [busyOperation, setBusyOperation] = useState<string>()
  const [mutationErrorMessage, setMutationErrorMessage] = useState<string>()
  const { data, error, isLoading, mutate } = useSWR<AutomationManagementData>(
    ['automation-management', accessToken, canManage, teams.map((team) => team.id).join('\0')],
    () => loadAutomationManagementData(accessToken, teams, canManage),
  )

  async function runMutation<TResult>(
    operationKey: string,
    input: unknown,
    request: (context: MutationRequestContext) => Promise<TResult>,
  ) {
    setBusyOperation(operationKey)
    setMutationErrorMessage(undefined)

    try {
      return await runAutomationManagementMutation(
        mutationRunner,
        operationKey,
        JSON.stringify(input),
        request,
        () => mutate(),
        (mutationError) => {
          setMutationErrorMessage(readErrorMessage(mutationError, t('automation.error.mutation')))
        },
      )
    } finally {
      setBusyOperation((current) => current === operationKey ? undefined : current)
    }
  }

  const initialTab = readInitialTab()

  return (
    <AutomationManagementPanel
      busyOperation={busyOperation}
      errorMessage={error
        ? readErrorMessage(error, t('automation.error.load'))
        : mutationErrorMessage}
      executions={data?.executions ?? []}
      initialTab={initialTab}
      isLoading={isLoading}
      locale={locale}
      canViewWebhooks={canManage}
      readOnly={!canManage}
      recurringWork={data?.recurringWork ?? []}
      rules={data?.rules ?? []}
      teams={teams.map((team) => ({ id: team.id, name: team.name }))}
      templates={data?.templates ?? []}
      webhooks={data?.webhooks ?? []}
      workflowTargets={data?.workflowTargets ?? []}
      onRefresh={async () => {
        await mutate()
      }}
      onCreateRule={canManage ? (input) => runMutation(
        'rule:create',
        input,
        (context) => createAutomationRule(accessToken, input, context),
      ) : undefined}
      onToggleRule={canManage ? (rule) => {
        const input = {
          enabled: !rule.enabled,
          expectedRevision: rule.revision,
        }

        return runMutation(
          `rule:toggle:${rule.id}`,
          input,
          (context) => updateAutomationRule(accessToken, rule.id, input, context),
        )
      } : undefined}
      onCreateWebhook={canManage ? (input) => runMutation(
        'webhook:create',
        input,
        (context) => createAutomationInboundWebhookEndpoint(accessToken, input, context),
      ) : undefined}
      onPauseWebhook={canManage ? (endpoint) => {
        const input = { expectedRevision: endpoint.revision }
        return runMutation(
          `webhook:pause:${endpoint.id}`,
          input,
          (context) => pauseAutomationInboundWebhookEndpoint(
            accessToken,
            endpoint.id,
            input,
            context,
          ),
        )
      } : undefined}
      onResumeWebhook={canManage ? (endpoint) => {
        const input = { expectedRevision: endpoint.revision }
        return runMutation(
          `webhook:resume:${endpoint.id}`,
          input,
          (context) => resumeAutomationInboundWebhookEndpoint(
            accessToken,
            endpoint.id,
            input,
            context,
          ),
        )
      } : undefined}
      onRotateWebhook={canManage ? (endpoint) => {
        const input = { expectedRevision: endpoint.revision }
        return runMutation(
          `webhook:rotate:${endpoint.id}`,
          input,
          (context) => rotateAutomationInboundWebhookEndpoint(
            accessToken,
            endpoint.id,
            input,
            context,
          ),
        )
      } : undefined}
      onRevokeWebhook={canManage ? (endpoint) => {
        const input = { expectedRevision: endpoint.revision }
        return runMutation(
          `webhook:revoke:${endpoint.id}`,
          input,
          (context) => revokeAutomationInboundWebhookEndpoint(
            accessToken,
            endpoint.id,
            input,
            context,
          ),
        )
      } : undefined}
      onCreateTemplate={canManage ? (input) => runMutation(
        'template:create',
        input,
        (context) => createAutomationTemplate(accessToken, input, context),
      ) : undefined}
      onToggleTemplate={canManage ? (template) => {
        const input = {
          enabled: !template.enabled,
          expectedRevision: template.revision,
        } satisfies UpdateAutomationTemplateInput

        return runMutation(
          `template:toggle:${template.id}`,
          input,
          (context) => updateAutomationTemplate(accessToken, template.id, input, context),
        )
      } : undefined}
      onDuplicateTemplate={canManage ? (template) => runMutation(
        `template:duplicate:${template.id}`,
        { expectedRevision: template.revision },
        (context) => duplicateAutomationTemplate(accessToken, template.id, context),
      ) : undefined}
      onUpdateTemplate={canManage ? (template, input) => runMutation(
        `template:update:${template.id}`,
        input,
        (context) => updateAutomationTemplate(accessToken, template.id, input, context),
      ) : undefined}
      onApplyTemplate={canManage ? (template, input): Promise<AutomationTemplateApplication> => runMutation(
        `template:apply:${template.id}`,
        input,
        (context) => applyAutomationTemplate(accessToken, template.id, input, context),
      ) : undefined}
      onRefreshTemplateApplication={canManage
        ? (applicationId) => getAutomationTemplateApplication(accessToken, applicationId)
        : undefined}
      onCreateRecurringWork={canManage ? (input) => runMutation(
        'recurring:create',
        input,
        (context) => createRecurringWork(accessToken, input, context),
      ) : undefined}
      onToggleRecurringWork={canManage ? (definition) => {
        const input = {
          enabled: !definition.enabled,
          expectedRevision: definition.revision,
        }

        return runMutation(
          `recurring:toggle:${definition.id}`,
          input,
          (context) => updateRecurringWork(accessToken, definition.id, input, context),
        )
      } : undefined}
      onRetryExecution={canManage ? (execution) => runMutation(
        `execution:retry:${execution.id}`,
        { executionId: execution.id, attempts: execution.attempts },
        (context) => retryAutomationExecution(accessToken, execution.id, context),
      ) : undefined}
    />
  )
}

function readInitialTab() {
  return typeof window === 'undefined'
    ? 'rules' as const
    : readAutomationManagementTab(new URLSearchParams(window.location.search).get('automationTab'))
}

function readErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}
