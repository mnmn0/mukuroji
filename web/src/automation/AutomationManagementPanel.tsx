import type {
  ApplyAutomationTemplateInput,
  AutomationExecution,
  AutomationInboundWebhookEndpoint,
  AutomationInboundWebhookSecretResponse,
  AutomationRule,
  AutomationTemplate,
  AutomationTemplateApplication,
  CreateAutomationRuleInput,
  CreateAutomationInboundWebhookEndpointInput,
  CreateAutomationTemplateInput,
  CreateRecurringWorkInput,
  RecurringWork,
  UpdateAutomationTemplateInput,
} from '@mukuroji/contracts'
import { useMemo, useState } from 'react'
import { createTranslator, type Locale, type MessageKey } from '../i18n'
import {
  AutomationRuleEditor,
  AutomationTemplateEditor,
  AutomationTemplateUpdateEditor,
  RecurringWorkEditor,
  type RecurringTeamOption,
} from './AutomationEditors'
import { AutomationInboundWebhooksPanel } from './AutomationInboundWebhooksPanel'
import {
  automationManagementTabs,
  type AutomationManagementTab,
} from './tabs'

const tabLabelKeys: Record<AutomationManagementTab, MessageKey> = {
  rules: 'automation.tab.rules',
  webhooks: 'automation.tab.webhooks',
  templates: 'automation.tab.templates',
  recurring: 'automation.tab.recurring',
  runs: 'automation.tab.runs',
}

const templateKindLabelKeys: Record<AutomationTemplate['kind'], MessageKey> = {
  'work-item': 'automation.template.kind.workItem',
  project: 'automation.template.kind.project',
  workflow: 'automation.template.kind.workflow',
}

/** Workflow template application の scope selector option です。 */
export type AutomationWorkflowTargetOption = {
  /** 保存先 scope です。 */
  scopeType: 'workspace' | 'team'
  /** Workspace または Team ID です。 */
  scopeId: string
  /** Selector に表示する scope 名です。 */
  name: string
  /** 保存対象 row の optimistic revision です。 */
  expectedRevision: number
  /** Team が Workspace/default を継承している場合の由来です。 */
  inheritedFrom?: 'workspace' | 'default'
}

/** Automation management panel の props です。 */
export type AutomationManagementPanelProps = {
  /** 表示 locale です。 */
  locale: Locale
  /** Rule 一覧です。 */
  rules: AutomationRule[]
  /** Secret を含まない inbound Webhook endpoint 一覧です。 */
  webhooks?: AutomationInboundWebhookEndpoint[]
  /** Template 一覧です。 */
  templates: AutomationTemplate[]
  /** Recurring Work 一覧です。 */
  recurringWork: RecurringWork[]
  /** Execution history です。 */
  executions: AutomationExecution[]
  /** Recurring Work の Team selector に表示する Team です。 */
  teams: RecurringTeamOption[]
  /** Workflow template の保存先と expected revision です。 */
  workflowTargets?: AutomationWorkflowTargetOption[]
  /** 最初に選択する tab です。 */
  initialTab?: AutomationManagementTab
  /** API の初回読み込み中かどうかです。 */
  isLoading?: boolean
  /** Mutation 実行中の operation key です。 */
  busyOperation?: string
  /** 読み込みまたは mutation の error message です。 */
  errorMessage?: string
  /** Mutation を表示しない参照専用状態です。 */
  readOnly?: boolean
  /** Admin-only Webhook metadata と tab を表示できるかどうかです。 */
  canViewWebhooks?: boolean
  /** Rule 作成 callback です。 */
  onCreateRule?: (input: CreateAutomationRuleInput) => Promise<unknown> | unknown
  /** Rule active/paused 切替 callback です。 */
  onToggleRule?: (rule: AutomationRule) => Promise<unknown> | unknown
  /** Inbound Webhook endpoint 作成 callback です。 */
  onCreateWebhook?: (
    input: CreateAutomationInboundWebhookEndpointInput,
  ) => Promise<AutomationInboundWebhookSecretResponse>
  /** Inbound Webhook endpoint pause callback です。 */
  onPauseWebhook?: (endpoint: AutomationInboundWebhookEndpoint) => Promise<unknown> | unknown
  /** Inbound Webhook endpoint resume callback です。 */
  onResumeWebhook?: (endpoint: AutomationInboundWebhookEndpoint) => Promise<unknown> | unknown
  /** Inbound Webhook signing secret rotate callback です。 */
  onRotateWebhook?: (
    endpoint: AutomationInboundWebhookEndpoint,
  ) => Promise<AutomationInboundWebhookSecretResponse>
  /** Inbound Webhook endpoint revoke callback です。 */
  onRevokeWebhook?: (endpoint: AutomationInboundWebhookEndpoint) => Promise<unknown> | unknown
  /** Template 作成 callback です。 */
  onCreateTemplate?: (input: CreateAutomationTemplateInput) => Promise<unknown> | unknown
  /** Template active/archived 切替 callback です。 */
  onToggleTemplate?: (template: AutomationTemplate) => Promise<unknown> | unknown
  /** Template duplicate callback です。 */
  onDuplicateTemplate?: (template: AutomationTemplate) => Promise<unknown> | unknown
  /** Kind を変更しない Template 更新 callback です。 */
  onUpdateTemplate?: (
    template: AutomationTemplate,
    input: UpdateAutomationTemplateInput,
  ) => Promise<unknown> | unknown
  /** Project/Workflow template application callback です。 */
  onApplyTemplate?: (
    template: AutomationTemplate,
    input: ApplyAutomationTemplateInput,
  ) => Promise<AutomationTemplateApplication>
  /** Application receipt の状態再取得 callback です。 */
  onRefreshTemplateApplication?: (
    applicationId: string,
  ) => Promise<AutomationTemplateApplication>
  /** Recurring Work 作成 callback です。 */
  onCreateRecurringWork?: (input: CreateRecurringWorkInput) => Promise<unknown> | unknown
  /** Recurring Work active/paused 切替 callback です。 */
  onToggleRecurringWork?: (recurringWork: RecurringWork) => Promise<unknown> | unknown
  /** Failed execution retry callback です。 */
  onRetryExecution?: (execution: AutomationExecution) => Promise<unknown> | unknown
  /** 全 resource の再読み込み callback です。 */
  onRefresh?: () => Promise<unknown> | unknown
}

/** Rule、template、recurring Work、execution history を管理する Settings panel です。 */
export function AutomationManagementPanel({
  busyOperation,
  canViewWebhooks = true,
  errorMessage,
  executions,
  initialTab = 'rules',
  isLoading = false,
  locale,
  onCreateRecurringWork,
  onCreateRule,
  onCreateTemplate,
  onCreateWebhook,
  onApplyTemplate,
  onDuplicateTemplate,
  onRefresh,
  onPauseWebhook,
  onResumeWebhook,
  onRevokeWebhook,
  onRetryExecution,
  onRotateWebhook,
  onToggleRecurringWork,
  onToggleRule,
  onToggleTemplate,
  onUpdateTemplate,
  onRefreshTemplateApplication,
  readOnly = false,
  recurringWork,
  rules,
  teams,
  templates,
  webhooks = [],
  workflowTargets = [],
}: AutomationManagementPanelProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [selectedTab, setSelectedTab] = useState<AutomationManagementTab>(initialTab)
  const visibleTabs = canViewWebhooks
    ? automationManagementTabs
    : automationManagementTabs.filter((tab) => tab !== 'webhooks')
  const activeTab = canViewWebhooks || selectedTab !== 'webhooks' ? selectedTab : 'rules'

  if (isLoading) {
    return <AutomationLoadingState locale={locale} />
  }

  return (
    <section className="workbench-panel overflow-hidden" data-testid="automation-management-panel">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-4 border-b border-[var(--workbench-border)] px-5 py-5">
        <div className="min-w-0 max-w-[720px]">
          <p className="workbench-eyebrow">{t('automation.eyebrow')}</p>
          <h2 className="mt-2 text-lg font-semibold text-[var(--workbench-text)]">
            {t('automation.title')}
          </h2>
          <p className="mt-2 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
            {t('automation.description')}
          </p>
        </div>
        <span className={readOnly ? 'workbench-badge' : 'workbench-badge-primary'}>
          {t(readOnly ? 'automation.readOnly' : 'automation.admin')}
        </span>
      </div>

      <div className="border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 pt-3">
        <div aria-label={t('automation.tabsAria')} className="flex min-w-0 gap-1 overflow-x-auto" role="tablist">
          {visibleTabs.map((tab) => (
            <button
              aria-controls={`automation-panel-${tab}`}
              aria-selected={activeTab === tab}
              className={`min-h-10 whitespace-nowrap border-b-2 px-4 text-sm font-semibold transition-colors ${
                activeTab === tab
                  ? 'border-[var(--workbench-primary)] text-[var(--workbench-primary)]'
                  : 'border-transparent text-[var(--workbench-muted)] hover:text-[var(--workbench-text)]'
              }`}
              data-testid={`automation-tab-${tab}`}
              id={`automation-tab-${tab}`}
              key={tab}
              role="tab"
              type="button"
              onClick={() => setSelectedTab(tab)}
            >
              {t(tabLabelKeys[tab])}
            </button>
          ))}
        </div>
      </div>

      {errorMessage ? (
        <div className="mx-5 mt-5 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3" role="alert">
          <p className="text-sm font-semibold text-red-700">{errorMessage}</p>
          {onRefresh ? (
            <button className="workbench-button-secondary min-h-9 px-3" type="button" onClick={() => void onRefresh()}>
              {t('automation.refresh')}
            </button>
          ) : null}
        </div>
      ) : null}

      <div
        aria-labelledby={`automation-tab-${activeTab}`}
        className="grid gap-5 p-5"
        id={`automation-panel-${activeTab}`}
        role="tabpanel"
      >
        {activeTab === 'rules' ? (
          <RulesTab
            busyOperation={busyOperation}
            locale={locale}
            readOnly={readOnly}
            rules={rules}
            webhookEndpoints={webhooks}
            onCreate={onCreateRule}
            onToggle={onToggleRule}
          />
        ) : null}
        {activeTab === 'webhooks' ? (
          <AutomationInboundWebhooksPanel
            busyOperation={busyOperation}
            endpoints={webhooks}
            locale={locale}
            readOnly={readOnly}
            onCreate={onCreateWebhook}
            onPause={onPauseWebhook}
            onResume={onResumeWebhook}
            onRevoke={onRevokeWebhook}
            onRotate={onRotateWebhook}
          />
        ) : null}
        {activeTab === 'templates' ? (
          <TemplatesTab
            busyOperation={busyOperation}
            locale={locale}
            readOnly={readOnly}
            templates={templates}
            teams={teams}
            workflowTargets={workflowTargets}
            onApply={onApplyTemplate}
            onCreate={onCreateTemplate}
            onDuplicate={onDuplicateTemplate}
            onRefreshApplication={onRefreshTemplateApplication}
            onToggle={onToggleTemplate}
            onUpdate={onUpdateTemplate}
          />
        ) : null}
        {activeTab === 'recurring' ? (
          <RecurringTab
            busyOperation={busyOperation}
            locale={locale}
            readOnly={readOnly}
            recurringWork={recurringWork}
            teams={teams}
            templates={templates}
            onCreate={onCreateRecurringWork}
            onToggle={onToggleRecurringWork}
          />
        ) : null}
        {activeTab === 'runs' ? (
          <RunsTab
            busyOperation={busyOperation}
            executions={executions}
            locale={locale}
            readOnly={readOnly}
            onRetry={onRetryExecution}
          />
        ) : null}
      </div>
    </section>
  )
}

type RulesTabProps = {
  /** 表示 locale です。 */
  locale: Locale
  /** Rule 一覧です。 */
  rules: AutomationRule[]
  /** Webhook trigger selector に表示する endpoint です。 */
  webhookEndpoints: AutomationInboundWebhookEndpoint[]
  /** Mutation 実行中の operation key です。 */
  busyOperation?: string
  /** 参照専用状態です。 */
  readOnly: boolean
  /** Rule 作成 callback です。 */
  onCreate?: (input: CreateAutomationRuleInput) => Promise<unknown> | unknown
  /** Rule 状態切替 callback です。 */
  onToggle?: (rule: AutomationRule) => Promise<unknown> | unknown
}

function RulesTab({
  busyOperation,
  locale,
  onCreate,
  onToggle,
  readOnly,
  rules,
  webhookEndpoints,
}: RulesTabProps) {
  const t = useMemo(() => createTranslator(locale), [locale])

  return (
    <>
      {!readOnly && onCreate ? (
        <AutomationRuleEditor
          isSaving={busyOperation === 'rule:create'}
          locale={locale}
          webhookEndpoints={webhookEndpoints}
          onCreate={onCreate}
        />
      ) : null}
      <ResourceCollection
        emptyMessage={t('automation.rule.empty')}
        items={rules}
        renderItem={(rule) => {
          const id = readResourceId(rule)
          const status = readStatus(rule, 'paused')
          const trigger = readNestedType(rule, 'trigger')
          const actions = readArray(rule, 'actions').map((action) => readType(action)).filter(Boolean)

          return (
            <ResourceCard
              key={id}
              description={[
                trigger ? `${t('automation.rule.trigger')}: ${formatType(trigger)}` : '',
                actions.length > 0 ? `${t('automation.rule.action')}: ${actions.map(formatType).join(', ')}` : '',
              ].filter(Boolean).join(' · ')}
              locale={locale}
              name={readResourceName(rule, t('automation.common.unnamed'))}
              resource={rule}
              status={status}
            >
              {!readOnly && onToggle ? (
                <button
                  className="workbench-button-secondary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-55"
                  data-testid={`automation-rule-toggle-${id}`}
                  disabled={busyOperation === `rule:toggle:${id}`}
                  type="button"
                  onClick={() => void onToggle(rule)}
                >
                  {t(status === 'active' ? 'automation.pause' : 'automation.activate')}
                </button>
              ) : null}
            </ResourceCard>
          )
        }}
      />
    </>
  )
}

type TemplatesTabProps = {
  /** 表示 locale です。 */
  locale: Locale
  /** Template 一覧です。 */
  templates: AutomationTemplate[]
  /** Project application の Team 選択肢です。 */
  teams: RecurringTeamOption[]
  /** Workflow application の scope 選択肢です。 */
  workflowTargets: AutomationWorkflowTargetOption[]
  /** Mutation 実行中の operation key です。 */
  busyOperation?: string
  /** 参照専用状態です。 */
  readOnly: boolean
  /** Template 作成 callback です。 */
  onCreate?: (input: CreateAutomationTemplateInput) => Promise<unknown> | unknown
  /** Template 状態切替 callback です。 */
  onToggle?: (template: AutomationTemplate) => Promise<unknown> | unknown
  /** Template 複製 callback です。 */
  onDuplicate?: (template: AutomationTemplate) => Promise<unknown> | unknown
  /** Template payload 更新 callback です。 */
  onUpdate?: (
    template: AutomationTemplate,
    input: UpdateAutomationTemplateInput,
  ) => Promise<unknown> | unknown
  /** Template application callback です。 */
  onApply?: (
    template: AutomationTemplate,
    input: ApplyAutomationTemplateInput,
  ) => Promise<AutomationTemplateApplication>
  /** Application receipt 再取得 callback です。 */
  onRefreshApplication?: (
    applicationId: string,
  ) => Promise<AutomationTemplateApplication>
}

function TemplatesTab({
  busyOperation,
  locale,
  onApply,
  onCreate,
  onDuplicate,
  onRefreshApplication,
  onToggle,
  onUpdate,
  readOnly,
  teams,
  templates,
  workflowTargets,
}: TemplatesTabProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [editingTemplateId, setEditingTemplateId] = useState<string>()
  const [applyingTemplateId, setApplyingTemplateId] = useState<string>()

  return (
    <>
      {!readOnly && onCreate ? (
        <AutomationTemplateEditor
          isSaving={busyOperation === 'template:create'}
          locale={locale}
          onCreate={onCreate}
        />
      ) : null}
      <ResourceCollection
        emptyMessage={t('automation.template.empty')}
        items={templates}
        renderItem={(template) => {
          const id = readResourceId(template)
          const status = template.enabled ? 'active' : 'archived'
          const kind = readText(template, 'kind')

          const isEditing = editingTemplateId === id
          const isApplying = applyingTemplateId === id

          return (
            <div className="grid gap-3" key={id}>
              <ResourceCard
                description={kind ? `${t('automation.template.kind')}: ${t(templateKindLabelKeys[template.kind])}` : undefined}
                locale={locale}
                name={readResourceName(template, t('automation.common.unnamed'))}
                resource={template}
                status={status}
              >
                {!readOnly && onUpdate ? (
                  <button
                    className="workbench-button-secondary min-h-9 px-3"
                    data-testid={`automation-template-edit-${id}`}
                    type="button"
                    onClick={() => {
                      setApplyingTemplateId(undefined)
                      setEditingTemplateId(isEditing ? undefined : id)
                    }}
                  >
                    {t(isEditing ? 'automation.template.cancel' : 'automation.template.edit')}
                  </button>
                ) : null}
                {!readOnly && onDuplicate ? (
                  <button
                    className="workbench-button-secondary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-55"
                    disabled={busyOperation === `template:duplicate:${id}`}
                    type="button"
                    onClick={() => void onDuplicate(template)}
                  >
                    {t('automation.template.duplicate')}
                  </button>
                ) : null}
                {!readOnly && onApply && template.enabled && template.kind !== 'work-item' ? (
                  <button
                    className="workbench-button-primary min-h-9 px-3"
                    data-testid={`automation-template-apply-${id}`}
                    type="button"
                    onClick={() => {
                      setEditingTemplateId(undefined)
                      setApplyingTemplateId(isApplying ? undefined : id)
                    }}
                  >
                    {t(isApplying ? 'automation.template.cancel' : 'automation.template.apply')}
                  </button>
                ) : null}
                {!readOnly && onToggle ? (
                  <button
                    className="workbench-button-secondary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-55"
                    disabled={busyOperation === `template:toggle:${id}`}
                    type="button"
                    onClick={() => void onToggle(template)}
                  >
                    {t(status === 'archived' ? 'automation.activate' : 'automation.archive')}
                  </button>
                ) : null}
              </ResourceCard>
              {isEditing && onUpdate ? (
                <AutomationTemplateUpdateEditor
                  isSaving={busyOperation === `template:update:${id}`}
                  key={`${id}:${template.revision}`}
                  locale={locale}
                  template={template}
                  onCancel={() => setEditingTemplateId(undefined)}
                  onUpdate={async (input) => {
                    await onUpdate(template, input)
                    setEditingTemplateId(undefined)
                  }}
                />
              ) : null}
              {isApplying && onApply && template.kind !== 'work-item' ? (
                <AutomationTemplateApplicationEditor
                  isApplying={busyOperation === `template:apply:${id}`}
                  locale={locale}
                  teams={teams}
                  template={template}
                  workflowTargets={workflowTargets}
                  onApply={(input) => onApply(template, input)}
                  onRefresh={onRefreshApplication}
                />
              ) : null}
            </div>
          )
        }}
      />
    </>
  )
}

type AutomationTemplateApplicationEditorProps = {
  /** 表示 locale です。 */
  locale: Locale
  /** 適用中かどうかです。 */
  isApplying?: boolean
  /** 適用対象の Project または Workflow template です。 */
  template: Extract<AutomationTemplate, { kind: 'project' | 'workflow' }>
  /** Project target の Team 選択肢です。 */
  teams: RecurringTeamOption[]
  /** Workflow target の scope/revision 選択肢です。 */
  workflowTargets: AutomationWorkflowTargetOption[]
  /** Application mutation callback です。 */
  onApply: (input: ApplyAutomationTemplateInput) => Promise<AutomationTemplateApplication>
  /** Receipt 再取得 callback です。 */
  onRefresh?: (applicationId: string) => Promise<AutomationTemplateApplication>
  /** Story/test で表示する既存 receipt です。 */
  initialApplication?: AutomationTemplateApplication
}

/** Template application の target、immutable pin、durable result を表示します。 */
export function AutomationTemplateApplicationEditor({
  initialApplication,
  isApplying = false,
  locale,
  onApply,
  onRefresh,
  teams,
  template,
  workflowTargets,
}: AutomationTemplateApplicationEditorProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const projectTargetValues = teams.map((team) => team.id)
  const workflowTargetValues = workflowTargets.map(createWorkflowTargetValue)
  const [targetValue, setTargetValue] = useState(
    template.kind === 'project'
      ? projectTargetValues[0] ?? ''
      : workflowTargetValues[0] ?? '',
  )
  const [application, setApplication] = useState(initialApplication)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const targetsAvailable = template.kind === 'project'
    ? projectTargetValues.length > 0
    : workflowTargetValues.length > 0

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!targetsAvailable) return
    const input = createTemplateApplicationInput(template, targetValue, workflowTargets)
    if (!input) return
    try {
      setApplication(await onApply(input))
    } catch {
      return
    }
  }

  async function refreshApplication() {
    if (!application || !onRefresh) return
    setIsRefreshing(true)
    try {
      setApplication(await onRefresh(application.id))
    } finally {
      setIsRefreshing(false)
    }
  }

  return (
    <form
      className="grid gap-4 rounded-lg border border-[var(--workbench-primary)] bg-[var(--workbench-surface-muted)] p-4"
      data-testid={`automation-template-application-${template.id}`}
      onSubmit={(event) => void handleSubmit(event)}
    >
      <div>
        <h3 className="text-sm font-semibold text-[var(--workbench-text)]">
          {t('automation.template.application.title')}
        </h3>
        <p className="mt-1 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
          {t(template.kind === 'workflow'
            ? 'automation.template.application.workflowDescription'
            : 'automation.template.application.projectDescription')}
        </p>
      </div>
      <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
        {t('automation.template.application.target')}
        <select
          className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
          data-testid="automation-template-application-target"
          disabled={!targetsAvailable || isApplying}
          value={targetValue}
          onChange={(event) => setTargetValue(event.target.value)}
        >
          {template.kind === 'project'
            ? teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)
            : workflowTargets.map((target) => (
                <option key={createWorkflowTargetValue(target)} value={createWorkflowTargetValue(target)}>
                  {formatWorkflowTargetLabel(target, t)}
                </option>
              ))}
        </select>
      </label>
      {!targetsAvailable ? (
        <p className="text-xs font-semibold text-red-700" role="alert">
          {t('automation.template.application.noTargets')}
        </p>
      ) : null}
      <div className="flex justify-end">
        <button
          className="workbench-button-primary min-h-10 px-5 disabled:cursor-not-allowed disabled:opacity-55"
          data-testid="automation-template-application-submit"
          disabled={!targetsAvailable || isApplying}
          type="submit"
        >
          {t(isApplying ? 'automation.template.application.applying' : 'automation.template.apply')}
        </button>
      </div>
      {application ? (
        <TemplateApplicationResult
          application={application}
          isRefreshing={isRefreshing}
          locale={locale}
          onRefresh={onRefresh ? refreshApplication : undefined}
        />
      ) : null}
    </form>
  )
}

function TemplateApplicationResult({
  application,
  isRefreshing,
  locale,
  onRefresh,
}: {
  /** 表示する durable receipt です。 */
  application: AutomationTemplateApplication
  /** Receipt の再取得中かどうかです。 */
  isRefreshing: boolean
  /** 表示 locale です。 */
  locale: Locale
  /** 非終端 receipt の再取得 callback です。 */
  onRefresh?: () => Promise<void>
}) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const result = application.result
  return (
    <section className="rounded-lg border border-[var(--workbench-border)] bg-white p-4" data-testid="automation-template-application-result">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <StatusBadge
            label={t(`automation.template.application.status.${application.status}`)}
            status={application.status}
          />
          <span className="workbench-badge">
            {t('automation.template.application.pinnedVersion')
              .replace('{version}', String(application.templateVersion))}
          </span>
        </div>
        {(application.status === 'pending' || application.status === 'running') && onRefresh ? (
          <button
            className="workbench-button-secondary min-h-9 px-3"
            disabled={isRefreshing}
            type="button"
            onClick={() => void onRefresh()}
          >
            {t(isRefreshing
              ? 'automation.template.application.refreshing'
              : 'automation.template.application.refresh')}
          </button>
        ) : null}
      </div>
      <p className="mt-2 break-all text-xs font-medium text-[var(--workbench-muted)]">
        {t('automation.template.application.receipt').replace('{id}', application.id)}
      </p>
      {result?.kind === 'project' ? (
        <p className="mt-3 text-sm font-semibold text-[var(--workbench-text)]">
          {t('automation.template.application.projectResult')
            .replace('{name}', result.name)
            .replace('{id}', result.projectId)}
        </p>
      ) : result?.kind === 'workflow' ? (
        <p className="mt-3 text-sm font-semibold text-[var(--workbench-text)]">
          {t('automation.template.application.workflowResult')
            .replace('{scope}', result.scopeId)
            .replace('{revision}', String(result.revision))}
        </p>
      ) : null}
      {application.errorMessage ? (
        <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
          {application.errorMessage}
        </p>
      ) : null}
    </section>
  )
}

function createTemplateApplicationInput(
  template: Extract<AutomationTemplate, { kind: 'project' | 'workflow' }>,
  targetValue: string,
  workflowTargets: AutomationWorkflowTargetOption[],
): ApplyAutomationTemplateInput | undefined {
  if (template.kind === 'project') {
    return targetValue ? { target: { kind: 'project', teamId: targetValue } } : undefined
  }
  const target = workflowTargets.find((candidate) =>
    createWorkflowTargetValue(candidate) === targetValue
  )
  return target
    ? {
        target: {
          expectedRevision: target.expectedRevision,
          kind: 'workflow',
          scopeId: target.scopeId,
          scopeType: target.scopeType,
        },
      }
    : undefined
}

function createWorkflowTargetValue(target: AutomationWorkflowTargetOption) {
  return `${target.scopeType}\0${target.scopeId}`
}

function formatWorkflowTargetLabel(
  target: AutomationWorkflowTargetOption,
  t: ReturnType<typeof createTranslator>,
) {
  const label = target.scopeType === 'workspace'
    ? t('automation.template.application.workspace')
    : t('automation.template.application.team').replace('{team}', target.name)
  return `${label} · ${t('automation.template.application.revision')
    .replace('{revision}', String(target.expectedRevision))}${target.inheritedFrom
      ? ` · ${t('automation.template.application.inherited')}`
      : ''}`
}

type RecurringTabProps = {
  /** 表示 locale です。 */
  locale: Locale
  /** Template 一覧です。 */
  templates: AutomationTemplate[]
  /** Team 選択肢です。 */
  teams: RecurringTeamOption[]
  /** Recurring Work 一覧です。 */
  recurringWork: RecurringWork[]
  /** Mutation 実行中の operation key です。 */
  busyOperation?: string
  /** 参照専用状態です。 */
  readOnly: boolean
  /** Recurring Work 作成 callback です。 */
  onCreate?: (input: CreateRecurringWorkInput) => Promise<unknown> | unknown
  /** Recurring Work 状態切替 callback です。 */
  onToggle?: (recurringWork: RecurringWork) => Promise<unknown> | unknown
}

function RecurringTab({
  busyOperation,
  locale,
  onCreate,
  onToggle,
  readOnly,
  recurringWork,
  teams,
  templates,
}: RecurringTabProps) {
  const t = useMemo(() => createTranslator(locale), [locale])

  return (
    <>
      {!readOnly && onCreate ? (
        <RecurringWorkEditor
          isSaving={busyOperation === 'recurring:create'}
          locale={locale}
          teams={teams}
          templates={templates}
          onCreate={onCreate}
        />
      ) : null}
      <ResourceCollection
        emptyMessage={t('automation.recurring.empty')}
        items={recurringWork}
        renderItem={(definition) => {
          const id = readResourceId(definition)
          const status = readStatus(definition, 'paused')
          const timeZone = readNestedText(definition, 'schedule', 'timeZone')
          const nextRunAt = readText(definition, 'nextRunAt')

          return (
            <ResourceCard
              key={id}
              description={[
                timeZone,
                nextRunAt
                  ? `${t('automation.recurring.nextRun')}: ${formatDateTime(nextRunAt, locale, timeZone)}`
                  : '',
              ].filter(Boolean).join(' · ')}
              locale={locale}
              name={readResourceName(definition, t('automation.common.unnamed'))}
              resource={definition}
              status={status}
            >
              {!readOnly && onToggle ? (
                <button
                  className="workbench-button-secondary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-55"
                  disabled={busyOperation === `recurring:toggle:${id}`}
                  type="button"
                  onClick={() => void onToggle(definition)}
                >
                  {t(status === 'active' ? 'automation.pause' : 'automation.activate')}
                </button>
              ) : null}
            </ResourceCard>
          )
        }}
      />
    </>
  )
}

type RunsTabProps = {
  /** 表示 locale です。 */
  locale: Locale
  /** Execution 一覧です。 */
  executions: AutomationExecution[]
  /** Mutation 実行中の operation key です。 */
  busyOperation?: string
  /** 参照専用状態です。 */
  readOnly: boolean
  /** Execution retry callback です。 */
  onRetry?: (execution: AutomationExecution) => Promise<unknown> | unknown
}

function RunsTab({ busyOperation, executions, locale, onRetry, readOnly }: RunsTabProps) {
  const t = useMemo(() => createTranslator(locale), [locale])

  if (executions.length === 0) {
    return <EmptyState message={t('automation.runs.empty')} />
  }

  return (
    <div className="grid gap-3">
      {executions.map((execution) => {
        const id = readResourceId(execution)
        const status = readStatus(execution, 'unknown')
        const failureReason = readText(execution, 'failureReason') || readText(execution, 'errorMessage')
        const startedAt = readText(execution, 'startedAt') || readText(execution, 'createdAt')
        const retryable = execution.retryable
        const actionResults = readArray(execution, 'actions')

        return (
          <article className="rounded-lg border border-[var(--workbench-border)] bg-white p-4" key={id}>
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h3 className="break-all text-sm font-semibold text-[var(--workbench-text)]">
                    {readText(execution, 'ruleName') || `${t('automation.runs.execution')} ${id}`}
                  </h3>
                  <StatusBadge status={status} />
                </div>
                <p className="mt-2 text-xs font-medium text-[var(--workbench-muted)]">
                  {startedAt ? formatDateTime(startedAt, locale) : id}
                </p>
              </div>
              {!readOnly && onRetry && retryable ? (
                <button
                  className="workbench-button-secondary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-55"
                  data-testid={`automation-run-retry-${id}`}
                  disabled={busyOperation === `execution:retry:${id}`}
                  type="button"
                  onClick={() => void onRetry(execution)}
                >
                  {t('automation.runs.retry')}
                </button>
              ) : null}
            </div>
            {failureReason ? (
              <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
                {failureReason}
              </p>
            ) : null}
            {actionResults.length > 0 ? (
              <div className="mt-3 grid gap-2">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
                  {t('automation.runs.actionResults')}
                </p>
                {actionResults.map((result, index) => {
                  const actionStatus = readStatus(result, 'unknown')
                  const actionFailure = readText(result, 'failureReason') || readText(result, 'errorMessage')

                  return (
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--workbench-surface-muted)] px-3 py-2" key={`${id}-action-${index}`}>
                      <span className="text-xs font-semibold text-[var(--workbench-text)]">
                        {formatType(readType(result) || readText(result, 'actionId') || `${t('automation.rule.action')} ${index + 1}`)}
                      </span>
                      <span className="flex min-w-0 items-center gap-2">
                        {actionFailure ? <span className="break-all text-xs font-medium text-red-700">{actionFailure}</span> : null}
                        <StatusBadge status={actionStatus} />
                      </span>
                    </div>
                  )
                })}
              </div>
            ) : null}
          </article>
        )
      })}
    </div>
  )
}

type ResourceCollectionProps<TItem> = {
  /** 表示する resource です。 */
  items: TItem[]
  /** 空状態 message です。 */
  emptyMessage: string
  /** Resource row renderer です。 */
  renderItem: (item: TItem) => React.ReactNode
}

function ResourceCollection<TItem>({ emptyMessage, items, renderItem }: ResourceCollectionProps<TItem>) {
  return items.length > 0
    ? <div className="grid gap-3">{items.map(renderItem)}</div>
    : <EmptyState message={emptyMessage} />
}

type ResourceCardProps = {
  /** Resource name です。 */
  name: string
  /** Resource status です。 */
  status: string
  /** Resource metadata の取得元です。 */
  resource: unknown
  /** 表示 locale です。 */
  locale: Locale
  /** Resource の補足説明です。 */
  description?: string
  /** Resource action です。 */
  children?: React.ReactNode
}

function ResourceCard({ children, description, locale, name, resource, status }: ResourceCardProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const version = readNumber(resource, 'version') ?? readNumber(resource, 'revision')

  return (
    <article className="flex min-w-0 flex-wrap items-center justify-between gap-4 rounded-lg border border-[var(--workbench-border)] bg-white p-4">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="break-words text-sm font-semibold text-[var(--workbench-text)]">{name}</h3>
          <StatusBadge status={status} />
          {version !== undefined ? (
            <span className="workbench-badge">
              {t('automation.version').replace('{version}', String(version))}
            </span>
          ) : null}
        </div>
        {description ? (
          <p className="mt-2 break-words text-xs font-medium leading-5 text-[var(--workbench-muted)]">
            {description}
          </p>
        ) : null}
      </div>
      {children ? <div className="flex flex-none flex-wrap items-center gap-2">{children}</div> : null}
    </article>
  )
}

type StatusBadgeProps = {
  /** 表示する status です。 */
  status: string
  /** Status code の代わりに表示する localized label です。 */
  label?: string
}

function StatusBadge({ label, status }: StatusBadgeProps) {
  const normalizedStatus = status.toLowerCase()
  const className = normalizedStatus === 'active' || normalizedStatus === 'succeeded' || normalizedStatus === 'success'
    ? 'workbench-badge-success'
    : normalizedStatus === 'failed' || normalizedStatus === 'dead-letter' || normalizedStatus === 'dead_letter'
      ? 'workbench-badge-danger'
      : normalizedStatus === 'running' || normalizedStatus === 'retrying'
        ? 'workbench-badge-primary'
        : 'workbench-badge-warning'

  return <span className={className}>{label ?? formatType(status)}</span>
}

type EmptyStateProps = {
  /** 空状態 message です。 */
  message: string
}

function EmptyState({ message }: EmptyStateProps) {
  return (
    <div className="grid min-h-28 place-items-center rounded-lg border border-dashed border-[var(--workbench-border-strong)] bg-[var(--workbench-surface-muted)] p-5 text-center">
      <p className="text-sm font-medium text-[var(--workbench-muted)]">{message}</p>
    </div>
  )
}

function AutomationLoadingState({ locale }: { /** 表示 locale です。 */ locale: Locale }) {
  const t = useMemo(() => createTranslator(locale), [locale])

  return (
    <section aria-label={t('automation.title')} className="workbench-panel p-5" role="status">
      <div className="h-5 w-48 animate-pulse rounded bg-slate-200" />
      <div className="mt-3 h-4 w-3/4 animate-pulse rounded bg-slate-100" />
      <div className="mt-6 grid gap-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div className="h-16 animate-pulse rounded-lg bg-slate-100" key={index} />
        ))}
      </div>
    </section>
  )
}

function readResourceId(resource: unknown) {
  const record = toRecord(resource)
  const id = record.id ?? record.ruleId ?? record.templateId ?? record.executionId

  return typeof id === 'string' ? id : ''
}

function readResourceName(resource: unknown, fallback: string) {
  const name = toRecord(resource).name

  return typeof name === 'string' && name.trim() ? name : fallback
}

function readStatus(resource: unknown, fallback: string) {
  const record = toRecord(resource)
  const status = record.status

  if (typeof status === 'string' && status) return status
  if (typeof record.enabled === 'boolean') return record.enabled ? 'active' : 'paused'

  return fallback
}

function readText(resource: unknown, key: string) {
  const value = toRecord(resource)[key]

  return typeof value === 'string' ? value : ''
}

function readNumber(resource: unknown, key: string) {
  const value = toRecord(resource)[key]

  return typeof value === 'number' ? value : undefined
}

function readArray(resource: unknown, key: string): unknown[] {
  const value = toRecord(resource)[key]

  return Array.isArray(value) ? value : []
}

function readNestedType(resource: unknown, key: string) {
  return readType(toRecord(resource)[key])
}

function readNestedText(resource: unknown, key: string, nestedKey: string) {
  return readText(toRecord(resource)[key], nestedKey)
}

function readType(resource: unknown) {
  const record = toRecord(resource)
  const type = record.type ?? record.actionType ?? record.triggerType

  return typeof type === 'string' ? type : ''
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {}
}

function formatType(value: string) {
  return value.replaceAll('_', ' ').replaceAll('-', ' ')
}

function formatDateTime(value: string, locale: Locale, timeZone?: string) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return value

  const format = (resolvedTimeZone?: string) => new Intl.DateTimeFormat(
    locale === 'ja' ? 'ja-JP' : 'en-US',
    {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(resolvedTimeZone ? { timeZone: resolvedTimeZone } : {}),
    },
  ).format(date)

  try {
    return format(timeZone)
  } catch {
    return format()
  }
}
