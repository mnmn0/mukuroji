import type {
  ApplyAutomationTemplateInput,
  AutomationExecution,
  AutomationProjectTemplateApplicationPreview,
  AutomationInboundWebhookEndpoint,
  AutomationInboundWebhookSecretResponse,
  AutomationRule,
  AutomationRuleDryRunInput,
  AutomationRuleDryRunResult,
  AutomationTemplate,
  AutomationTemplateApplication,
  CreateAutomationRuleInput,
  CreateAutomationInboundWebhookEndpointInput,
  CreateAutomationTemplateInput,
  CreateRecurringWorkInput,
  RecurringWork,
  UpdateAutomationRuleInput,
  UpdateAutomationTemplateInput,
} from '@mukuroji/contracts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'
import {
  AutomationRuleEditor,
  AutomationTemplateEditor,
  AutomationTemplateUpdateEditor,
  RecurringWorkEditor,
  type RecurringTeamOption,
} from './AutomationEditors'
import { AutomationInboundWebhooksPanel } from './AutomationInboundWebhooksPanel'
import {
  AutomationRuleDefinitionEditor,
  type AutomationRuleEditorOptions,
} from './AutomationRuleDefinitionEditor'
import {
  automationManagementTabs,
  resolveAutomationManagementTabTarget,
  type AutomationManagementTab,
} from '../model/tabs'
import { refreshAutomationTemplateApplication } from '../model/templateApplicationRefresh'
import {
  countProjectTemplateWorkItems,
  formatLocalCalendarDate,
} from '../model/projectTemplateWorkItems'
import type { AutomationPlanningParentsState } from '../model/projectTemplatePlanning'

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

const triggerTypeLabelKeys: Record<string, MessageKey> = {
  status: 'automation.trigger.statusChange',
  assignee: 'automation.trigger.assigneeChange',
  due: 'automation.trigger.dueDate',
  'baseline-slip': 'automation.trigger.baselineSlip',
  'custom-field': 'automation.trigger.customFieldChange',
  'work-item-type': 'automation.trigger.workItemTypeChange',
  comment: 'automation.trigger.comment',
  approval: 'automation.trigger.approval',
  form: 'automation.trigger.formSubmission',
  webhook: 'automation.trigger.webhook',
  schedule: 'automation.trigger.schedule',
}

const actionTypeLabelKeys: Record<string, MessageKey> = {
  assign: 'automation.action.assign',
  move: 'automation.action.moveStatus',
  update: 'automation.action.updateFields',
  create: 'automation.action.createWorkItem',
  comment: 'automation.action.addComment',
  notify: 'automation.action.notify',
  approval: 'automation.action.requestApproval',
  webhook: 'automation.action.webhook',
}

const automationStatusLabelKeys: Record<string, MessageKey> = {
  active: 'automation.status.active',
  paused: 'automation.status.paused',
  archived: 'automation.status.archived',
  pending: 'automation.status.pending',
  running: 'automation.status.running',
  succeeded: 'automation.status.succeeded',
  failed: 'automation.status.failed',
  'dead-letter': 'automation.status.deadLetter',
  skipped: 'automation.status.skipped',
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
  /** Saves edited conditions and actions as the rule's next version. */
  onUpdateRule?: (rule: AutomationRule, input: UpdateAutomationRuleInput) => Promise<unknown> | unknown
  /** Deletes a rule after the user confirms. */
  onDeleteRule?: (rule: AutomationRule) => Promise<unknown> | unknown
  /** Tries an unsaved rule definition on one Work Item. */
  onDryRunRule?: (input: AutomationRuleDryRunInput) => Promise<AutomationRuleDryRunResult>
  /** Picker choices of the rule definition editor. */
  ruleEditorOptions?: AutomationRuleEditorOptions
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
  /** Deletes a template after the user confirms. */
  onDeleteTemplate?: (template: AutomationTemplate) => Promise<unknown> | unknown
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
  /** Dry-runs a Project template application without writing anything. */
  onPreviewTemplateApplication?: (
    template: AutomationTemplate,
    input: ApplyAutomationTemplateInput,
  ) => Promise<AutomationProjectTemplateApplicationPreview>
  /** Planning entities a template's Phases and Milestones can be placed under, with their loading state. */
  planningParents?: AutomationPlanningParentsState
  /** Recurring Work 作成 callback です。 */
  onCreateRecurringWork?: (input: CreateRecurringWorkInput) => Promise<unknown> | unknown
  /** Recurring Work active/paused 切替 callback です。 */
  onToggleRecurringWork?: (recurringWork: RecurringWork) => Promise<unknown> | unknown
  /** Deletes a Recurring Work definition after the user confirms. */
  onDeleteRecurringWork?: (recurringWork: RecurringWork) => Promise<unknown> | unknown
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
  onDeleteRecurringWork,
  onDeleteRule,
  onDeleteTemplate,
  onDryRunRule,
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
  onUpdateRule,
  onUpdateTemplate,
  onRefreshTemplateApplication,
  onPreviewTemplateApplication,
  planningParents,
  readOnly = false,
  recurringWork,
  ruleEditorOptions,
  rules,
  teams,
  templates,
  webhooks = [],
  workflowTargets = [],
}: AutomationManagementPanelProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [selectedTab, setSelectedTab] = useState<AutomationManagementTab>(initialTab)
  const pendingTabFocus = useRef<AutomationManagementTab | undefined>(undefined)
  const visibleTabs = canViewWebhooks
    ? automationManagementTabs
    : automationManagementTabs.filter((tab) => tab !== 'webhooks')
  const activeTab = canViewWebhooks || selectedTab !== 'webhooks' ? selectedTab : 'rules'

  useEffect(() => {
    if (pendingTabFocus.current !== activeTab) return
    document.getElementById(`automation-tab-${activeTab}`)?.focus()
    pendingTabFocus.current = undefined
  }, [activeTab])

  function handleTabKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    tab: AutomationManagementTab,
  ) {
    const nextTab = resolveAutomationManagementTabTarget(tab, event.key, visibleTabs)
    if (!nextTab) return

    event.preventDefault()
    pendingTabFocus.current = nextTab
    setSelectedTab(nextTab)
  }

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
                  ? 'border-[var(--workbench-primary)] text-[var(--workbench-primary-text)]'
                  : 'border-transparent text-[var(--workbench-muted)] hover:text-[var(--workbench-text)]'
              }`}
              data-testid={`automation-tab-${tab}`}
              id={`automation-tab-${tab}`}
              key={tab}
              role="tab"
              tabIndex={activeTab === tab ? 0 : -1}
              type="button"
              onClick={() => setSelectedTab(tab)}
              onKeyDown={(event) => handleTabKeyDown(event, tab)}
            >
              {t(tabLabelKeys[tab])}
            </button>
          ))}
        </div>
      </div>

      {errorMessage ? (
        <div className="mx-5 mt-5 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3" role="alert">
          <p className="text-sm font-semibold text-fg-red-700">{errorMessage}</p>
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
            teams={teams}
            webhookEndpoints={webhooks.filter((endpoint) => endpoint.purpose !== 'triage')}
            editorOptions={ruleEditorOptions}
            onCreate={onCreateRule}
            onDelete={onDeleteRule}
            onDryRun={onDryRunRule}
            onToggle={onToggleRule}
            onUpdate={onUpdateRule}
          />
        ) : null}
        {activeTab === 'webhooks' ? (
          <AutomationInboundWebhooksPanel
            busyOperation={busyOperation}
            endpoints={webhooks}
            locale={locale}
            readOnly={readOnly}
            teams={teams}
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
            onDelete={onDeleteTemplate}
            onDuplicate={onDuplicateTemplate}
            onRefreshApplication={onRefreshTemplateApplication}
            onPreviewApplication={onPreviewTemplateApplication}
            planningParents={planningParents}
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
            onDelete={onDeleteRecurringWork}
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

/** Automation rule tab の props です。 */
type RulesTabProps = {
  /** 表示 locale です。 */
  locale: Locale
  /** Rule 一覧です。 */
  rules: AutomationRule[]
  /** Work Item Type trigger で選択できる Team です。 */
  teams: RecurringTeamOption[]
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
  /** Saves an edited rule as its next version. */
  onUpdate?: (rule: AutomationRule, input: UpdateAutomationRuleInput) => Promise<unknown> | unknown
  /** Deletes a rule. */
  onDelete?: (rule: AutomationRule) => Promise<unknown> | unknown
  /** Tries an unsaved rule definition on one Work Item. */
  onDryRun?: (input: AutomationRuleDryRunInput) => Promise<AutomationRuleDryRunResult>
  /** Picker choices of the rule definition editor. */
  editorOptions?: AutomationRuleEditorOptions
}

/** Picker choices used when the container gives none. */
const emptyRuleEditorOptions: AutomationRuleEditorOptions = {
  members: [],
  teams: [],
  projects: [],
  statuses: [],
  customFields: [],
  workItemTemplates: [],
}

/**
 * Lists rules with their create, edit, toggle, and delete controls.
 *
 * @param props - Tab props.
 * @returns The rules tab.
 */
function RulesTab({
  busyOperation,
  editorOptions = emptyRuleEditorOptions,
  locale,
  onCreate,
  onDelete,
  onDryRun,
  onToggle,
  onUpdate,
  readOnly,
  rules,
  teams,
  webhookEndpoints,
}: RulesTabProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [editingRuleId, setEditingRuleId] = useState<string>()
  // Counts editor opens and closes so a finished save closes only the editing session that started it.
  const editSession = useRef(0)

  /**
   * Opens a rule editor, or closes it with `undefined`, and starts a new editing session.
   *
   * @param ruleId - The rule to edit, or `undefined` to close the editor.
   */
  const changeEditingRule = (ruleId: string | undefined) => {
    editSession.current += 1
    setEditingRuleId(ruleId)
  }

  return (
    <>
      {!readOnly && onCreate ? (
        <AutomationRuleEditor
          isSaving={busyOperation === 'rule:create'}
          locale={locale}
          teams={teams}
          webhookEndpoints={webhookEndpoints}
          onCreate={onCreate}
        />
      ) : null}
      <ResourceCollection
        emptyMessage={t('automation.rule.empty')}
        items={rules}
        renderItem={(rule) => {
          const id = rule.id
          const status = rule.enabled ? 'active' : 'paused'
          const trigger = rule.trigger.type
          const actions = rule.actions.map((action) => action.type)

          const isEditing = editingRuleId === id
          const name = readResourceName(rule, t('automation.common.unnamed'))

          return (
            <div className="grid gap-3" key={id}>
            <ResourceCard
              description={[
                trigger
                  ? `${t('automation.rule.trigger')}: ${formatType(trigger, t, 'trigger')}`
                  : '',
                actions.length > 0
                  ? `${t('automation.rule.action')}: ${actions
                    .map((action) => formatType(action, t, 'action'))
                    .join(', ')}`
                  : '',
              ].filter(Boolean).join(' · ')}
              locale={locale}
              name={name}
              status={status}
              version={rule.version}
            >
              {!readOnly && onUpdate ? (
                <button
                  className="workbench-button-secondary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-55"
                  data-testid={`automation-rule-edit-${id}`}
                  disabled={busyOperation === `rule:update:${id}`}
                  type="button"
                  onClick={() => changeEditingRule(isEditing ? undefined : id)}
                >
                  {t(isEditing ? 'automation.ruleEdit.cancel' : 'automation.edit')}
                </button>
              ) : null}
              {!readOnly && onToggle ? (
                <button
                  className="workbench-button-secondary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-55"
                  data-testid={`automation-rule-toggle-${id}`}
                  disabled={busyOperation === `rule:toggle:${id}` || isEditing}
                  type="button"
                  onClick={() => void onToggle(rule)}
                >
                  {t(status === 'active' ? 'automation.pause' : 'automation.activate')}
                </button>
              ) : null}
              {!readOnly && onDelete ? (
                <DeleteResourceButton
                  disabled={busyOperation === `rule:delete:${id}`}
                  locale={locale}
                  name={name}
                  testId={`automation-rule-delete-${id}`}
                  onDelete={() => onDelete(rule)}
                />
              ) : null}
            </ResourceCard>
            {isEditing && onUpdate ? (
              <AutomationRuleDefinitionEditor
                isSaving={busyOperation === `rule:update:${id}`}
                key={id}
                locale={locale}
                options={editorOptions}
                rule={rule}
                onCancel={() => changeEditingRule(undefined)}
                onDryRun={onDryRun}
                onSave={async (input) => {
                  const session = editSession.current
                  await onUpdate(rule, input)
                  // Close only the session that saved: the editor may have been switched or reopened meanwhile.
                  if (editSession.current === session) changeEditingRule(undefined)
                }}
              />
            ) : null}
            </div>
          )
        }}
      />
    </>
  )
}

/** Props of the delete button that asks for confirmation. */
type DeleteResourceButtonProps = {
  /** Display locale. */
  locale: Locale
  /** Name shown in the confirmation. */
  name: string
  /** Test ID of the button. */
  testId: string
  /** Whether the delete is in progress. */
  disabled: boolean
  /** Deletes the resource. */
  onDelete: () => Promise<unknown> | unknown
}

/**
 * Deletes a resource after the browser confirmation.
 *
 * @param props - Button props.
 * @returns The delete button.
 */
function DeleteResourceButton({ disabled, locale, name, onDelete, testId }: DeleteResourceButtonProps) {
  const t = useMemo(() => createTranslator(locale), [locale])

  return (
    <button
      className="workbench-button-secondary min-h-9 px-3 text-fg-red-700 disabled:cursor-not-allowed disabled:opacity-55"
      data-testid={testId}
      disabled={disabled}
      type="button"
      onClick={() => {
        if (!window.confirm(t('automation.deleteConfirm').replace('{name}', name))) return
        void onDelete()
      }}
    >
      {t('automation.delete')}
    </button>
  )
}

/** Automation template tab の props です。 */
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
  /** Deletes a template. */
  onDelete?: (template: AutomationTemplate) => Promise<unknown> | unknown
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
  /** Dry-runs a Project template application. */
  onPreviewApplication?: (
    template: AutomationTemplate,
    input: ApplyAutomationTemplateInput,
  ) => Promise<AutomationProjectTemplateApplicationPreview>
  /** Planning parent candidates for template Phases and Milestones, with their loading state. */
  planningParents?: AutomationPlanningParentsState
}

function TemplatesTab({
  busyOperation,
  locale,
  onApply,
  onCreate,
  onDelete,
  onDuplicate,
  onRefreshApplication,
  onPreviewApplication,
  planningParents,
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
          const id = template.id
          const status = template.enabled ? 'active' : 'archived'

          const isEditing = editingTemplateId === id
          const isApplying = applyingTemplateId === id

          return (
            <div className="grid gap-3" key={id}>
              <ResourceCard
                description={`${t('automation.template.kind')}: ${t(templateKindLabelKeys[template.kind])}`}
                locale={locale}
                name={readResourceName(template, t('automation.common.unnamed'))}
                status={status}
                version={template.version}
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
                {!readOnly && onDelete ? (
                  <DeleteResourceButton
                    disabled={busyOperation === `template:delete:${id}`}
                    locale={locale}
                    name={readResourceName(template, t('automation.common.unnamed'))}
                    testId={`automation-template-delete-${id}`}
                    onDelete={() => onDelete(template)}
                  />
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
                  planningParents={planningParents}
                  onPreview={onPreviewApplication ? (input) => onPreviewApplication(template, input) : undefined}
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

/** Automation template application editor の props です。 */
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
  /** Dry-runs the application; when given, applying a Project template waits for a clean preview. */
  onPreview?: (input: ApplyAutomationTemplateInput) => Promise<AutomationProjectTemplateApplicationPreview>
  /** Planning parent candidates for the template's Phases and Milestones, with their loading state. */
  planningParents?: AutomationPlanningParentsState
  /** Story/test で表示する既存 preview です。 */
  initialPreview?: AutomationProjectTemplateApplicationPreview
}

/** Template application の target、immutable pin、durable result を表示します。 */
export function AutomationTemplateApplicationEditor({
  initialApplication,
  initialPreview,
  isApplying = false,
  locale,
  onApply,
  planningParents,
  onPreview,
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
  const [refreshErrorMessage, setRefreshErrorMessage] = useState<string>()
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [startDate, setStartDate] = useState(() => formatLocalCalendarDate(new Date()))
  const workItemCount = template.kind === 'project'
    ? countProjectTemplateWorkItems(template.payload.workItems)
    : 0
  const targetsAvailable = template.kind === 'project'
    ? projectTargetValues.length > 0
    : workflowTargetValues.length > 0
  const planningEntityCount = template.kind === 'project'
    ? countProjectTemplatePlanningEntities(template.payload)
    : 0
  const needsStartDate = workItemCount > 0 || planningEntityCount > 0
  const startDateIsValid = !needsStartDate || /^\d{4}-\d{2}-\d{2}$/u.test(startDate)
  const planningParentsFailed = planningParents?.failed === true
  const [planningParentId, setPlanningParentId] = useState('')
  const [preview, setPreview] = useState(initialPreview)
  // A preview passed in by a story or test has no key and counts as current until it is replaced.
  const [previewKey, setPreviewKey] = useState<string>()
  const [isPreviewing, setIsPreviewing] = useState(false)
  const [previewErrorMessage, setPreviewErrorMessage] = useState<string>()
  const usableParents = (planningParents?.parents ?? []).filter((parent) =>
    parent.teamId === undefined || parent.teamId === targetValue
  )
  const selectedParentId = usableParents.some((parent) => parent.id === planningParentId) ? planningParentId : ''
  const planningParentIsValid = planningEntityCount === 0 || selectedParentId !== ''
  const currentPreviewKey = createPreviewKey(
    template.version,
    targetValue,
    needsStartDate ? startDate : undefined,
    planningEntityCount > 0 ? selectedParentId : undefined,
  )
  const requiresPreview = template.kind === 'project' && onPreview !== undefined
  const previewIsCurrent = preview !== undefined && preview.templateVersion === template.version &&
    (previewKey === currentPreviewKey || (previewKey === undefined && preview === initialPreview))
  const previewAllowsApply = !requiresPreview || (previewIsCurrent && preview.errors.length === 0)

  /** Builds the request for the current form values. */
  function readInput() {
    return createTemplateApplicationInput(
      template,
      targetValue,
      workflowTargets,
      needsStartDate ? startDate : undefined,
      planningEntityCount > 0 && selectedParentId ? selectedParentId : undefined,
    )
  }

  async function handlePreview() {
    if (!onPreview || !targetsAvailable || !startDateIsValid) return
    const input = readInput()
    if (!input) return
    // An earlier result no longer counts once a new preview starts, even if it fails.
    setPreview(undefined)
    setPreviewKey(undefined)
    setIsPreviewing(true)
    setPreviewErrorMessage(undefined)
    try {
      setPreview(await onPreview(input))
      setPreviewKey(currentPreviewKey)
    } catch {
      setPreviewErrorMessage(t('automation.template.application.previewError'))
    } finally {
      setIsPreviewing(false)
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!targetsAvailable || !startDateIsValid || !planningParentIsValid || !previewAllowsApply) return
    const input = readInput()
    if (!input) return
    try {
      // The server refuses a new application whose template or calendar changed since this preview.
      setApplication(await onApply(requiresPreview && preview
        ? {
            ...input,
            expectedPreview: {
              templateVersion: preview.templateVersion,
              calendarFingerprint: preview.calendarFingerprint,
            },
          }
        : input))
    } catch {
      return
    }
  }

  async function refreshApplication() {
    if (!application || !onRefresh) return
    await refreshAutomationTemplateApplication({
      applicationId: application.id,
      errorMessage: t('automation.template.application.refreshError'),
      onErrorChange: setRefreshErrorMessage,
      onRefresh,
      onRefreshingChange: setIsRefreshing,
      onSuccess: setApplication,
    })
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
      {needsStartDate ? (
        <>
          <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('automation.template.application.startDate')}
            <input
              className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
              data-testid="automation-template-application-start-date"
              disabled={isApplying}
              required
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
            />
          </label>
          {workItemCount > 0 ? (
            <p className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
              {t('automation.template.application.workItemsNotice').replace('{count}', String(workItemCount))}
            </p>
          ) : null}
        </>
      ) : null}
      {planningEntityCount > 0 ? (
        <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('automation.template.application.planningParent')}
          <select
            className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
            data-testid="automation-template-application-planning-parent"
            disabled={isApplying}
            required
            value={selectedParentId}
            onChange={(event) => setPlanningParentId(event.target.value)}
          >
            <option value="">{t('automation.template.application.planningParentNone')}</option>
            {usableParents.map((parent) => (
              <option key={parent.id} value={parent.id}>{`${parent.title} (${t(`planning.type.${parent.type}`)})`}</option>
            ))}
          </select>
          <span className={planningParentsFailed
            ? 'text-xs font-semibold text-fg-red-700'
            : 'text-xs font-medium leading-5 text-[var(--workbench-muted)]'}
          >
            {t(planningParentsFailed
              ? 'automation.template.application.planningParentUnavailable'
              : planningParents?.isLoading
                ? 'automation.template.application.planningParentLoading'
                : planningParents?.parents !== undefined && usableParents.length === 0
                  ? 'automation.template.application.planningParentEmpty'
                  : 'automation.template.application.planningParentHint')}
          </span>
          {planningParentsFailed ? (
            <button
              className="workbench-button-secondary min-h-9 justify-self-start px-3"
              data-testid="automation-template-application-planning-parent-retry"
              type="button"
              onClick={planningParents?.onRetry}
            >
              {t('automation.template.application.planningParentRetry')}
            </button>
          ) : null}
        </label>
      ) : null}
      {!targetsAvailable ? (
        <p className="text-xs font-semibold text-fg-red-700" role="alert">
          {t('automation.template.application.noTargets')}
        </p>
      ) : null}
      {requiresPreview && !previewAllowsApply ? (
        <p className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
          {t('automation.template.application.previewRequired')}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        {requiresPreview ? (
          <button
            className="workbench-button-secondary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-55"
            data-testid="automation-template-application-preview"
            disabled={!targetsAvailable || !startDateIsValid || isPreviewing || isApplying}
            type="button"
            onClick={() => void handlePreview()}
          >
            {t(isPreviewing ? 'automation.template.application.previewing' : 'automation.template.application.preview')}
          </button>
        ) : null}
        <button
          className="workbench-button-primary min-h-10 px-5 disabled:cursor-not-allowed disabled:opacity-55"
          data-testid="automation-template-application-submit"
          disabled={!targetsAvailable || !startDateIsValid || !planningParentIsValid || !previewAllowsApply || isApplying}
          type="submit"
        >
          {t(isApplying ? 'automation.template.application.applying' : 'automation.template.apply')}
        </button>
      </div>
      {previewErrorMessage ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
          {previewErrorMessage}
        </p>
      ) : null}
      {preview && previewIsCurrent ? <TemplateApplicationPreview locale={locale} preview={preview} /> : null}
      {application ? (
        <TemplateApplicationResult
          application={application}
          isRefreshing={isRefreshing}
          locale={locale}
          onRefresh={onRefresh ? refreshApplication : undefined}
        />
      ) : null}
      {refreshErrorMessage ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
          {refreshErrorMessage}
        </p>
      ) : null}
    </form>
  )
}

/** Template application result の props です。 */
type TemplateApplicationResultProps = {
  /** 表示する durable receipt です。 */
  application: AutomationTemplateApplication
  /** Receipt の再取得中かどうかです。 */
  isRefreshing: boolean
  /** 表示 locale です。 */
  locale: Locale
  /** 非終端 receipt の再取得 callback です。 */
  onRefresh?: () => Promise<void>
}

function TemplateApplicationResult({
  application,
  isRefreshing,
  locale,
  onRefresh,
}: TemplateApplicationResultProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const result = application.result
  return (
    <section className="rounded-lg border border-[var(--workbench-border)] bg-surface p-4" data-testid="automation-template-application-result">
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
          {result.workItemCount
            ? ` ${t('automation.template.application.workItemsResult').replace('{count}', String(result.workItemCount))}`
            : null}
          {result.planningEntityCount
            ? ` ${t('automation.template.application.planningResult').replace('{count}', String(result.planningEntityCount))}`
            : null}
          {result.dependencyCount
            ? ` ${t('automation.template.application.dependencyResult').replace('{count}', String(result.dependencyCount))}`
            : null}
        </p>
      ) : result?.kind === 'workflow' ? (
        <p className="mt-3 text-sm font-semibold text-[var(--workbench-text)]">
          {t('automation.template.application.workflowResult')
            .replace('{scope}', result.scopeId)
            .replace('{revision}', String(result.revision))}
        </p>
      ) : null}
      {application.errorMessage ? (
        <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700">
          {application.errorMessage}
        </p>
      ) : null}
    </section>
  )
}

/** Props of the Project template application preview. */
type TemplateApplicationPreviewProps = {
  /** Display locale. */
  locale: Locale
  /** Dry-run result to show. */
  preview: AutomationProjectTemplateApplicationPreview
}

/**
 * Shows what a Project template application would create and the problems that would stop it.
 *
 * @param props - Preview and locale.
 * @returns The preview section.
 */
function TemplateApplicationPreview({ locale, preview }: TemplateApplicationPreviewProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  return (
    <section
      className="grid gap-3 rounded-lg border border-[var(--workbench-border)] bg-surface p-4"
      data-testid="automation-template-application-preview-result"
    >
      <h4 className="text-sm font-semibold text-[var(--workbench-text)]">
        {t('automation.template.application.previewTitle')}
      </h4>
      <p className="text-sm font-medium text-[var(--workbench-text)]">
        {t('automation.template.application.previewSummary')
          .replace('{name}', preview.name)
          .replace('{workItems}', String(preview.workItems.length))
          .replace('{planning}', String(preview.planningEntities.length))
          .replace('{dependencies}', String(preview.dependencyCount))}
      </p>
      {preview.startDate && preview.endDate ? (
        <p className="text-xs font-medium text-[var(--workbench-muted)]">
          {t('automation.template.application.previewPeriod')
            .replace('{start}', preview.startDate)
            .replace('{end}', preview.endDate)}
        </p>
      ) : null}
      {preview.errors.length > 0 ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2" role="alert">
          <p className="text-sm font-semibold text-fg-red-700">{t('automation.template.application.previewErrors')}</p>
          <ul className="mt-1 grid gap-1 text-xs font-medium text-fg-red-700">
            {preview.errors.map((error, index) => (
              <li key={`${error.code}-${index}`}>
                {error.wbsNumber
                  ? t('automation.template.application.previewErrorWbs')
                    .replace('{wbs}', error.wbsNumber)
                    .replace('{message}', error.message)
                  : error.dependencyNumber
                    ? t('automation.template.application.previewErrorDependency')
                      .replace('{number}', String(error.dependencyNumber))
                      .replace('{message}', error.message)
                    : error.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {preview.workItems.length > 0 ? (
        <PreviewTable
          caption={t('automation.template.application.previewWorkItems')}
          rows={preview.workItems.map((workItem) => ({
            key: workItem.wbsNumber,
            label: `${workItem.wbsNumber} ${workItem.title}`,
            startDate: workItem.startDate,
            endDate: workItem.endDate,
          }))}
        />
      ) : null}
      {preview.planningEntities.length > 0 ? (
        <PreviewTable
          caption={t('automation.template.application.previewPlanning')}
          rows={preview.planningEntities.map((entity, index) => ({
            key: String(index),
            label: `${t(entity.type === 'phase'
              ? 'automation.template.application.previewPhase'
              : 'automation.template.application.previewMilestone')}: ${entity.phaseTitle ? `${entity.phaseTitle} / ` : ''}${entity.title}`,
            startDate: entity.startDate,
            endDate: entity.endDate,
          }))}
        />
      ) : null}
    </section>
  )
}

/**
 * Lists previewed rows with their dates.
 *
 * @param props - Caption and rows.
 * @returns A compact date table.
 */
function PreviewTable({ caption, rows }: {
  /** Table caption. */
  caption: string
  /** Rows with a stable key, label, and inclusive dates. */
  rows: Array<{ key: string, label: string, startDate: string, endDate: string }>
}) {
  return (
    <div className="max-h-64 overflow-auto">
      <table className="w-full min-w-0 text-left text-xs">
        <caption className="pb-1 text-left text-xs font-semibold text-[var(--workbench-muted)]">{caption}</caption>
        <tbody>
          {rows.map((row) => (
            <tr className="border-t border-[var(--workbench-border)]" key={row.key}>
              <td className="break-all py-1 pr-2 font-medium text-[var(--workbench-text)]">{row.label}</td>
              <td className="w-48 whitespace-nowrap py-1 text-[var(--workbench-muted)]">
                {row.startDate === row.endDate ? row.startDate : `${row.startDate} – ${row.endDate}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Identifies the template version and form values a preview was computed for.
 *
 * @param templateVersion - Template version being applied.
 * @param teamId - Selected Team ID.
 * @param startDate - Project start date, when the template needs one.
 * @param planningParentId - Planning parent, when the template has Phases or Milestones.
 * @returns A key that changes whenever one of the values does.
 */
function createPreviewKey(
  templateVersion: number,
  teamId: string,
  startDate: string | undefined,
  planningParentId: string | undefined,
) {
  return JSON.stringify([templateVersion, teamId, startDate ?? null, planningParentId ?? null])
}

/**
 * Counts the Phases and Milestones a Project template creates.
 *
 * @param payload - Project template payload.
 * @returns Number of Planning entities.
 */
function countProjectTemplatePlanningEntities(payload: Extract<AutomationTemplate, { kind: 'project' }>['payload']) {
  return (payload.phases ?? []).reduce((total, phase) => total + 1 + (phase.milestones?.length ?? 0), 0) +
    (payload.milestones?.length ?? 0)
}

/**
 * Builds the application request for the selected target.
 *
 * @param template - Project or Workflow template being applied.
 * @param targetValue - Selected Team ID or encoded Workflow scope.
 * @param workflowTargets - Workflow scopes the viewer can choose from.
 * @param startDate - Project start date, sent only for a template with dated content.
 * @param planningParentId - Planning parent, sent only for a template with Phases or Milestones.
 * @returns The request body, or undefined when no target is selected.
 */
function createTemplateApplicationInput(
  template: Extract<AutomationTemplate, { kind: 'project' | 'workflow' }>,
  targetValue: string,
  workflowTargets: AutomationWorkflowTargetOption[],
  startDate?: string,
  planningParentId?: string,
): ApplyAutomationTemplateInput | undefined {
  if (template.kind === 'project') {
    return targetValue
      ? {
          target: {
            kind: 'project',
            teamId: targetValue,
            ...(startDate ? { startDate } : {}),
            ...(planningParentId ? { planningParentId } : {}),
          },
        }
      : undefined
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

/** Recurring Work tab の props です。 */
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
  /** Deletes a Recurring Work definition. */
  onDelete?: (recurringWork: RecurringWork) => Promise<unknown> | unknown
}

function RecurringTab({
  busyOperation,
  locale,
  onCreate,
  onDelete,
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
          const id = definition.id
          const status = definition.enabled ? 'active' : 'paused'
          const timeZone = definition.schedule.timeZone
          const nextRunAt = definition.nextRunAt

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
              status={status}
              version={definition.version}
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
              {!readOnly && onDelete ? (
                <DeleteResourceButton
                  disabled={busyOperation === `recurring:delete:${id}`}
                  locale={locale}
                  name={readResourceName(definition, t('automation.common.unnamed'))}
                  testId={`automation-recurring-delete-${id}`}
                  onDelete={() => onDelete(definition)}
                />
              ) : null}
            </ResourceCard>
          )
        }}
      />
    </>
  )
}

/** Automation execution history tab の props です。 */
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
        const id = execution.id
        const status = execution.status
        const failureReason = execution.errorMessage
        const startedAt = execution.startedAt
        const retryable = execution.retryable
        const actionResults = execution.actions

        return (
          <article className="rounded-lg border border-[var(--workbench-border)] bg-surface p-4" key={id}>
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h3 className="break-all text-sm font-semibold text-[var(--workbench-text)]">
                    {`${t('automation.runs.execution')} ${id}`}
                  </h3>
                  <StatusBadge
                    label={formatType(status, t, 'status')}
                    status={status}
                  />
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
              <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700">
                {failureReason}
              </p>
            ) : null}
            {actionResults.length > 0 ? (
              <div className="mt-3 grid gap-2">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
                  {t('automation.runs.actionResults')}
                </p>
                {actionResults.map((result, index) => {
                  const actionStatus = result.status
                  const actionFailure = result.errorMessage

                  return (
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--workbench-surface-muted)] px-3 py-2" key={`${id}-action-${index}`}>
                      <span className="text-xs font-semibold text-[var(--workbench-text)]">
                        {formatType(
                          result.actionId || `${t('automation.rule.action')} ${index + 1}`,
                          t,
                          'action',
                        )}
                      </span>
                      <span className="flex min-w-0 items-center gap-2">
                        {actionFailure ? <span className="break-all text-xs font-medium text-fg-red-700">{actionFailure}</span> : null}
                        <StatusBadge
                          label={formatType(actionStatus, t, 'status')}
                          status={actionStatus}
                        />
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

/** Resource collection の props です。 */
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

/** Automation resource card の props です。 */
type ResourceCardProps = {
  /** Resource name です。 */
  name: string
  /** Resource status です。 */
  status: string
  /** Immutable resource definition version shown as a badge. */
  version: number
  /** 表示 locale です。 */
  locale: Locale
  /** Resource の補足説明です。 */
  description?: string
  /** Resource action です。 */
  children?: React.ReactNode
}

/**
 * Renders one automation resource with its status, version, description, and actions.
 *
 * @param props - Resource display values and action controls.
 * @returns The resource card.
 */
function ResourceCard({ children, description, locale, name, status, version }: ResourceCardProps) {
  const t = useMemo(() => createTranslator(locale), [locale])

  return (
    <article className="flex min-w-0 flex-wrap items-center justify-between gap-4 rounded-lg border border-[var(--workbench-border)] bg-surface p-4">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="break-words text-sm font-semibold text-[var(--workbench-text)]">{name}</h3>
          <StatusBadge
            label={formatType(status, t, 'status')}
            status={status}
          />
          <span className="workbench-badge">
            {t('automation.version').replace('{version}', String(version))}
          </span>
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

/** Automation status badge の props です。 */
type StatusBadgeProps = {
  /** 表示する status です。 */
  status: string
  /** Status code の代わりに表示する localized label です。 */
  label?: string
}

function StatusBadge({ label, status }: StatusBadgeProps) {
  const className = status === 'active' || status === 'succeeded'
    ? 'workbench-badge-success'
    : status === 'failed' || status === 'dead-letter'
      ? 'workbench-badge-danger'
      : status === 'running'
        ? 'workbench-badge-primary'
        : 'workbench-badge-warning'

  return <span className={className}>{label ?? formatUnknownType(status)}</span>
}

/** Automation empty state の props です。 */
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

/**
 * Returns a resource name, or the fallback label when the name is blank.
 *
 * @param resource - Named automation resource.
 * @param fallback - Label shown for a blank name.
 * @returns The display name.
 */
function readResourceName(resource: { name: string }, fallback: string) {
  return resource.name.trim() ? resource.name : fallback
}

function formatType(
  value: string,
  t: ReturnType<typeof createTranslator>,
  category: 'trigger' | 'action' | 'status',
) {
  const labelKeys = category === 'trigger'
    ? triggerTypeLabelKeys
    : category === 'action'
      ? actionTypeLabelKeys
      : automationStatusLabelKeys
  const labelKey = labelKeys[value]

  return labelKey ? t(labelKey) : formatUnknownType(value)
}

function formatUnknownType(value: string) {
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
