import type {
  AutomationTemplate,
  AutomationTemplateApplication,
  UpdateAutomationTemplateInput,
} from '@mukuroji/contracts'
import { useMemo, useRef, useState } from 'react'
import { createMutationRequestRunner, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'
import type { ProjectDirectoryTeam } from '../../projects/api'
import { AutomationManagementPanel } from './AutomationManagementPanel'
import { readAutomationManagementTab } from '../model/tabs'
import {
  AutomationApiError,
  applyAutomationTemplate,
  createAutomationInboundWebhookEndpoint,
  createAutomationRule,
  createAutomationTemplate,
  createRecurringWork,
  duplicateAutomationTemplate,
  getAutomationTemplateApplication,
  pauseAutomationInboundWebhookEndpoint,
  previewAutomationTemplateApplication,
  resumeAutomationInboundWebhookEndpoint,
  revokeAutomationInboundWebhookEndpoint,
  retryAutomationExecution,
  rotateAutomationInboundWebhookEndpoint,
  updateAutomationRule,
  updateAutomationTemplate,
  updateRecurringWork,
} from '../api'
import { runAutomationManagementMutation } from '../mutations/runAutomationManagementMutation'
import {
  loadMoreOwnedAutomationExecutions,
  useAutomationManagement,
} from '../queries/useAutomationManagement'
import {
  selectOwnedAutomationData,
  selectTeamTemplateOptions,
  selectWorkspaceTemplateOptions,
} from '../model/ownedDefinitions'
import { useAutomationPlanningParents } from '../queries/useAutomationPlanningParents'

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
  /**
   * Team の設定から開いたときの Team ID です。指定すると、その Team が所有する rule・template・
   * recurring Work・実行履歴だけを表示し、作成する定義をその Team の所有にします。
   */
  ownerTeamId?: string
}

/** Automation API と Settings panel を接続する container です。 */
export function AutomationManagementPanelContainer({
  accessToken,
  canManage,
  locale,
  ownerTeamId,
  teams,
}: AutomationManagementPanelContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const mutationRunner = useRef(createMutationRequestRunner()).current
  const [busyOperation, setBusyOperation] = useState<string>()
  const [mutationErrorMessage, setMutationErrorMessage] = useState<string>()
  const isTeamScope = ownerTeamId !== undefined
  const { data: loadedData, error, isLoading, mutate } = useAutomationManagement(
    accessToken,
    teams,
    canManage && !isTeamScope,
    ownerTeamId,
  )
  const data = useMemo(
    () => loadedData && isTeamScope ? selectOwnedAutomationData(loadedData, ownerTeamId) : loadedData,
    [isTeamScope, loadedData, ownerTeamId],
  )
  const templateOptions = useMemo(
    () => loadedData
      ? isTeamScope
        ? selectTeamTemplateOptions(loadedData.templates, ownerTeamId)
        : selectWorkspaceTemplateOptions(loadedData.templates)
      : undefined,
    [isTeamScope, loadedData, ownerTeamId],
  )
  const canManageWorkspace = canManage && !isTeamScope
  /** Adds the owner Team of the Team settings view to a new definition. */
  const withOwner = <TInput extends object>(input: TInput): TInput & { ownerTeamId?: string } =>
    ownerTeamId === undefined ? input : { ...input, ownerTeamId }

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
          setMutationErrorMessage(
            mutationError instanceof AutomationApiError && mutationError.code === 'AutomationTemplatePreviewStale'
              ? t('automation.template.application.previewStale')
              : readErrorMessage(mutationError, t('automation.error.mutation')),
          )
        },
      )
    } finally {
      setBusyOperation((current) => current === operationKey ? undefined : current)
    }
  }

  /** Searches older runs of the Team and appends them to the loaded history. */
  async function loadMoreExecutions(teamId: string) {
    setBusyOperation('execution:load-more')
    setMutationErrorMessage(undefined)
    try {
      await mutate(
        async (current) => current
          ? await loadMoreOwnedAutomationExecutions(accessToken, teamId, current)
          : current,
        { revalidate: false },
      )
    } catch (loadError) {
      setMutationErrorMessage(readErrorMessage(loadError, t('automation.error.load')))
    } finally {
      setBusyOperation((current) => current === 'execution:load-more' ? undefined : current)
    }
  }

  const initialTab = readInitialTab()
  const planningParentsQuery = useAutomationPlanningParents(
    accessToken,
    canManageWorkspace && (data?.templates ?? []).some(hasPlanningEntities),
  )

  return (
    <AutomationManagementPanel
      busyOperation={busyOperation}
      errorMessage={error
        ? readErrorMessage(error, t('automation.error.load'))
        : mutationErrorMessage}
      executions={data?.executions ?? []}
      onLoadMoreExecutions={ownerTeamId !== undefined && loadedData?.executionsNextCursor
        ? () => loadMoreExecutions(ownerTeamId)
        : undefined}
      initialTab={initialTab}
      isLoading={isLoading}
      locale={locale}
      canViewWebhooks={canManageWorkspace}
      readOnly={!canManage}
      recurringWork={data?.recurringWork ?? []}
      rules={data?.rules ?? []}
      teams={teams.map((team) => ({ id: team.id, name: team.name }))}
      templates={data?.templates ?? []}
      templateOptions={templateOptions}
      teamScoped={isTeamScope}
      webhooks={data?.webhooks ?? []}
      workflowTargets={data?.workflowTargets ?? []}
      onRefresh={async () => {
        await mutate()
      }}
      onCreateRule={canManage ? (input) => runMutation(
        'rule:create',
        withOwner(input),
        (context) => createAutomationRule(accessToken, withOwner(input), context),
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
      onCreateWebhook={canManageWorkspace ? (input) => runMutation(
        'webhook:create',
        input,
        (context) => createAutomationInboundWebhookEndpoint(accessToken, input, context),
      ) : undefined}
      onPauseWebhook={canManageWorkspace ? (endpoint) => {
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
      onResumeWebhook={canManageWorkspace ? (endpoint) => {
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
      onRotateWebhook={canManageWorkspace ? (endpoint) => {
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
      onRevokeWebhook={canManageWorkspace ? (endpoint) => {
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
        withOwner(input),
        (context) => createAutomationTemplate(accessToken, withOwner(input), context),
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
      onApplyTemplate={canManageWorkspace ? (template, input): Promise<AutomationTemplateApplication> => runMutation(
        `template:apply:${template.id}`,
        input,
        (context) => applyAutomationTemplate(accessToken, template.id, input, context),
      ) : undefined}
      onRefreshTemplateApplication={canManageWorkspace
        ? (applicationId) => getAutomationTemplateApplication(accessToken, applicationId)
        : undefined}
      onPreviewTemplateApplication={canManageWorkspace
        ? (template, input) => previewAutomationTemplateApplication(accessToken, template.id, input)
        : undefined}
      planningParents={canManageWorkspace
        ? {
            parents: planningParentsQuery.data,
            isLoading: planningParentsQuery.isLoading,
            failed: planningParentsQuery.error !== undefined,
            onRetry: () => {
              void planningParentsQuery.mutate()
            },
          }
        : undefined}
      onCreateRecurringWork={canManage ? (input) => runMutation(
        'recurring:create',
        withOwner(input),
        (context) => createRecurringWork(accessToken, withOwner(input), context),
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

/**
 * Tells whether a template creates Phases or Milestones and so needs a Planning parent.
 *
 * @param template - Automation template.
 * @returns True for a Project template with Phases or Milestones.
 */
function hasPlanningEntities(template: AutomationTemplate) {
  return template.kind === 'project' &&
    ((template.payload.phases?.length ?? 0) > 0 || (template.payload.milestones?.length ?? 0) > 0)
}

function readInitialTab() {
  return typeof window === 'undefined'
    ? 'rules' as const
    : readAutomationManagementTab(new URLSearchParams(window.location.search).get('automationTab'))
}

function readErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}
