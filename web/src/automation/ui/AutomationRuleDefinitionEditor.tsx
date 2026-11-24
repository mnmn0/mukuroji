import type {
  AutomationConditionOperator,
  AutomationRule,
  AutomationRuleDryRunInput,
  AutomationRuleDryRunResult,
  AutomationValue,
  UpdateAutomationRuleInput,
} from '@mukuroji/contracts'
import { useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'
import {
  AUTOMATION_RULE_DRAFT_ACTION_TYPES,
  AUTOMATION_RULE_DRAFT_LIMIT,
  AUTOMATION_RULE_UPDATE_FIELDS,
  createAutomationRuleDraft,
  createAutomationRuleDraftActions,
  createAutomationRuleDraftConditions,
  createAutomationRuleDraftUpdate,
  createEmptyAutomationRuleActionDraft,
  isAutomationRuleActionDraftValid,
  isAutomationRuleConditionDraftValid,
  isAutomationRuleDraftValid,
  moveAutomationRuleDraftItem,
  type AutomationRuleActionDraft,
  type AutomationRuleConditionDraft,
  type AutomationRuleDraft,
  type AutomationRuleDraftActionType,
  type AutomationRulePickerOption,
  type AutomationRuleUpdateField,
} from '../model/ruleDefinitionDraft'

/** Options the rule definition editor offers in its pickers. */
export type AutomationRuleEditorOptions = {
  /** Active Workspace members, by member key. */
  members: AutomationRulePickerOption[]
  /** Teams, by Team ID. */
  teams: AutomationRulePickerOption[]
  /** Projects, by Project ID. */
  projects: AutomationRulePickerOption[]
  /** Workflow statuses, by status ID. */
  statuses: AutomationRulePickerOption[]
  /** Custom fields, by field ID. */
  customFields: AutomationRulePickerOption[]
  /** Enabled Work Item templates, by template ID. */
  workItemTemplates: AutomationRulePickerOption[]
}

/** Props of the rule definition editor. */
export type AutomationRuleDefinitionEditorProps = {
  /** Display locale. */
  locale: Locale
  /** Rule to edit. */
  rule: AutomationRule
  /** Picker choices. */
  options: AutomationRuleEditorOptions
  /** Whether the save is in progress. */
  isSaving?: boolean
  /** Saves the edited rule as its next version. */
  onSave: (input: UpdateAutomationRuleInput) => Promise<unknown> | unknown
  /** Tries the edited rule on one Work Item; absent hides the dry run. */
  onDryRun?: (input: AutomationRuleDryRunInput) => Promise<AutomationRuleDryRunResult>
  /** Closes the editor without saving. */
  onCancel: () => void
}

/** Kind of value a condition field compares. */
type ConditionFieldKind = 'status' | 'member' | 'priority' | 'project' | 'team' | 'number' | 'boolean' | 'text'

/** A condition field the editor offers by name. */
type ConditionFieldPreset = {
  /** Field path. */
  field: string
  /** Label shown in the field picker. */
  label: string
  /** Kind of value picker. */
  kind: ConditionFieldKind
}

/** Value of the field picker that selects a typed path. */
const CUSTOM_CONDITION_FIELD = '__custom__'

const conditionOperators: readonly AutomationConditionOperator[] = [
  'equals',
  'not-equals',
  'contains',
  'greater-than',
  'greater-than-or-equal',
  'less-than',
  'less-than-or-equal',
  'exists',
  'not-exists',
]

const conditionOperatorLabelKeys: Record<AutomationConditionOperator, MessageKey> = {
  equals: 'automation.condition.equals',
  'not-equals': 'automation.condition.notEquals',
  contains: 'automation.condition.contains',
  'greater-than': 'automation.condition.greaterThan',
  'greater-than-or-equal': 'automation.condition.greaterThanOrEqual',
  'less-than': 'automation.condition.lessThan',
  'less-than-or-equal': 'automation.condition.lessThanOrEqual',
  exists: 'automation.condition.isNotEmpty',
  'not-exists': 'automation.condition.isEmpty',
}

const actionLabelKeys: Record<AutomationRuleDraftActionType, MessageKey> = {
  assign: 'automation.action.assign',
  move: 'automation.action.moveStatus',
  update: 'automation.action.updateFields',
  create: 'automation.action.createWorkItem',
  comment: 'automation.action.addComment',
  notify: 'automation.action.notify',
  approval: 'automation.action.requestApproval',
  webhook: 'automation.action.webhook',
}

const updateFieldLabelKeys: Record<AutomationRuleUpdateField, MessageKey> = {
  workflowStatusId: 'automation.ruleEdit.field.status',
  priority: 'automation.ruleEdit.field.priority',
  title: 'automation.ruleEdit.field.title',
  description: 'automation.ruleEdit.field.description',
}

const priorityValues = ['low', 'medium', 'high'] as const

const priorityLabelKeys: Record<(typeof priorityValues)[number], MessageKey> = {
  low: 'automation.ruleEdit.priority.low',
  medium: 'automation.ruleEdit.priority.medium',
  high: 'automation.ruleEdit.priority.high',
}

const inputClassName = 'workbench-input min-h-10 px-3 text-[var(--workbench-text)]'
const labelClassName = 'grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]'

/**
 * Edits an existing rule's name, conditions, and ordered actions, and tries the edited rule on a
 * Work Item before saving. The trigger and execution limits keep their saved values.
 *
 * @param props - Editor props.
 * @returns The editor form.
 */
export function AutomationRuleDefinitionEditor({
  isSaving = false,
  locale,
  onCancel,
  onDryRun,
  onSave,
  options,
  rule,
}: AutomationRuleDefinitionEditorProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const formId = useId()
  const [draft, setDraft] = useState<AutomationRuleDraft>(() => createAutomationRuleDraft(rule))
  const [newActionType, setNewActionType] = useState<AutomationRuleDraftActionType>('notify')
  const presets = useMemo(() => createConditionFieldPresets(t, options.customFields), [t, options.customFields])
  const valid = isAutomationRuleDraftValid(draft)

  /**
   * Replaces one condition row.
   *
   * @param index - Row to replace.
   * @param next - New row.
   */
  function updateCondition(index: number, next: AutomationRuleConditionDraft) {
    setDraft((current) => ({
      ...current,
      conditions: current.conditions.map((condition, position) => position === index ? next : condition),
    }))
  }

  /**
   * Replaces one action.
   *
   * @param index - Action to replace.
   * @param next - New action.
   */
  function updateAction(index: number, next: AutomationRuleActionDraft) {
    setDraft((current) => ({
      ...current,
      actions: current.actions.map((action, position) => position === index ? next : action),
    }))
  }

  /**
   * Saves the draft when it is complete.
   *
   * @param event - Form submit event.
   */
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!valid || isSaving) return
    try {
      await onSave(createAutomationRuleDraftUpdate(rule, draft))
    } catch {
      return
    }
  }

  return (
    <form
      aria-labelledby={`${formId}-title`}
      className="grid gap-4 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4"
      data-testid={`automation-rule-editor-${rule.id}`}
      onSubmit={(event) => void handleSubmit(event)}
    >
      <div>
        <h3 className="text-sm font-semibold text-[var(--workbench-text)]" id={`${formId}-title`}>
          {t('automation.ruleEdit.title')}
        </h3>
        <p className="mt-1 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
          {t('automation.ruleEdit.description')}
        </p>
      </div>
      <label className={labelClassName}>
        {t('automation.common.name')}
        <input
          className={inputClassName}
          data-testid="automation-rule-edit-name"
          required
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
        />
      </label>

      <fieldset className="grid gap-3 rounded-lg border border-[var(--workbench-border)] bg-surface p-3">
        <legend className="px-1 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('automation.ruleEdit.conditions')}
        </legend>
        {draft.savedConditions ? (
          <div className="grid gap-2">
            <p className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
              {t('automation.ruleEdit.savedConditions')}
            </p>
            <div>
              <button
                className="workbench-button-secondary min-h-9 px-3"
                data-testid="automation-rule-edit-reset-conditions"
                type="button"
                onClick={() => setDraft((current) => ({
                  name: current.name,
                  match: 'all',
                  conditions: [],
                  actions: current.actions,
                }))}
              >
                {t('automation.ruleEdit.resetConditions')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <label className={`${labelClassName} max-w-[320px]`}>
              {t('automation.ruleEdit.match')}
              <select
                className={inputClassName}
                data-testid="automation-rule-edit-match"
                value={draft.match}
                onChange={(event) => {
                  const match = event.target.value === 'any' ? 'any' : 'all'
                  setDraft((current) => ({ ...current, match }))
                }}
              >
                <option value="all">{t('automation.ruleEdit.match.all')}</option>
                <option value="any">{t('automation.ruleEdit.match.any')}</option>
              </select>
            </label>
            {draft.conditions.length === 0 ? (
              <p className="text-xs font-medium text-[var(--workbench-muted)]">{t('automation.ruleEdit.noConditions')}</p>
            ) : null}
            <ol className="grid gap-3">
              {draft.conditions.map((condition, index) => (
                <li key={index}>
                  <ConditionRow
                    condition={condition}
                    index={index}
                    options={options}
                    presets={presets}
                    t={t}
                    onChange={(next) => updateCondition(index, next)}
                    onRemove={() => setDraft((current) => ({
                      ...current,
                      conditions: current.conditions.filter((_condition, position) => position !== index),
                    }))}
                  />
                </li>
              ))}
            </ol>
            <div>
              <button
                className="workbench-button-secondary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-55"
                data-testid="automation-rule-edit-add-condition"
                disabled={draft.conditions.length >= AUTOMATION_RULE_DRAFT_LIMIT}
                type="button"
                onClick={() => setDraft((current) => ({
                  ...current,
                  conditions: [...current.conditions, { field: 'workItem.workflowStatusId', operator: 'equals', value: '' }],
                }))}
              >
                {t('automation.ruleEdit.addCondition')}
              </button>
            </div>
          </>
        )}
      </fieldset>

      <fieldset className="grid gap-3 rounded-lg border border-[var(--workbench-border)] bg-surface p-3">
        <legend className="px-1 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('automation.ruleEdit.actions')}
        </legend>
        <p className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">{t('automation.ruleEdit.actionsHint')}</p>
        <ol className="grid gap-3">
          {draft.actions.map((action, index) => (
            <li key={index}>
              <ActionCard
                action={action}
                count={draft.actions.length}
                index={index}
                options={options}
                t={t}
                onChange={(next) => updateAction(index, next)}
                onMove={(offset) => setDraft((current) => ({
                  ...current,
                  actions: moveAutomationRuleDraftItem(current.actions, index, offset),
                }))}
                onRemove={() => setDraft((current) => ({
                  ...current,
                  actions: current.actions.filter((_action, position) => position !== index),
                }))}
              />
            </li>
          ))}
        </ol>
        {draft.actions.length === 0 ? (
          <p className="text-xs font-semibold text-fg-red-700" role="alert">{t('automation.ruleEdit.actionRequired')}</p>
        ) : null}
        <div className="flex flex-wrap items-end gap-3">
          <label className={labelClassName}>
            {t('automation.ruleEdit.newAction')}
            <select
              className={inputClassName}
              data-testid="automation-rule-edit-new-action-type"
              value={newActionType}
              onChange={(event) => setNewActionType(readActionType(event.target.value))}
            >
              {AUTOMATION_RULE_DRAFT_ACTION_TYPES.map((type) => (
                <option key={type} value={type}>{t(actionLabelKeys[type])}</option>
              ))}
            </select>
          </label>
          <button
            className="workbench-button-secondary min-h-10 px-3 disabled:cursor-not-allowed disabled:opacity-55"
            data-testid="automation-rule-edit-add-action"
            disabled={draft.actions.length >= AUTOMATION_RULE_DRAFT_LIMIT}
            type="button"
            onClick={() => setDraft((current) => ({
              ...current,
              actions: [...current.actions, createEmptyAutomationRuleActionDraft(newActionType, current.name.trim())],
            }))}
          >
            {t('automation.ruleEdit.addAction')}
          </button>
        </div>
      </fieldset>

      {onDryRun ? (
        <DryRunSection
          canRun={valid}
          draft={draft}
          options={options}
          rule={rule}
          t={t}
          onDryRun={onDryRun}
        />
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <button className="workbench-button-secondary min-h-10 px-4" type="button" onClick={onCancel}>
          {t('automation.ruleEdit.cancel')}
        </button>
        <button
          className="workbench-button-primary min-h-10 px-5 disabled:cursor-not-allowed disabled:opacity-55"
          data-testid="automation-rule-edit-save"
          disabled={!valid || isSaving}
          type="submit"
        >
          {t(isSaving ? 'automation.common.saving' : 'automation.ruleEdit.save')}
        </button>
      </div>
    </form>
  )
}

/** Translator of the editor locale. */
type Translate = ReturnType<typeof createTranslator>

/** Props of one condition row. */
type ConditionRowProps = {
  /** Row to show. */
  condition: AutomationRuleConditionDraft
  /** Position of the row, for labels. */
  index: number
  /** Picker choices. */
  options: AutomationRuleEditorOptions
  /** Named condition fields. */
  presets: ConditionFieldPreset[]
  /** Translator. */
  t: Translate
  /** Replaces the row. */
  onChange: (next: AutomationRuleConditionDraft) => void
  /** Removes the row. */
  onRemove: () => void
}

/**
 * One condition row: field, operator, and a value picker that fits the field.
 *
 * @param props - Row props.
 * @returns The row.
 */
function ConditionRow({ condition, index, onChange, onRemove, options, presets, t }: ConditionRowProps) {
  const preset = presets.find((candidate) => candidate.field === condition.field)
  const [customField, setCustomField] = useState(!preset)
  const needsValue = condition.operator !== 'exists' && condition.operator !== 'not-exists'
  const invalid = !isAutomationRuleConditionDraftValid(condition)
  const kind = customField ? 'text' : preset?.kind ?? 'text'
  return (
    <div
      className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] items-end gap-3 max-[860px]:grid-cols-1"
      data-testid={`automation-rule-edit-condition-${index}`}
    >
      <div className="grid gap-2">
        <label className={labelClassName}>
          {t('automation.ruleEdit.conditionField')}
          <select
            className={inputClassName}
            data-testid={`automation-rule-edit-condition-field-${index}`}
            value={customField ? CUSTOM_CONDITION_FIELD : condition.field}
            onChange={(event) => {
              if (event.target.value === CUSTOM_CONDITION_FIELD) {
                setCustomField(true)
                return
              }
              setCustomField(false)
              const selected = presets.find((candidate) => candidate.field === event.target.value)
              const valueType = selected?.kind === 'number' || selected?.kind === 'boolean' ? selected.kind : undefined
              onChange({ field: event.target.value, operator: condition.operator, value: '', ...(valueType ? { valueType } : {}) })
            }}
          >
            {presets.map((candidate) => (
              <option key={candidate.field} value={candidate.field}>{candidate.label}</option>
            ))}
            <option value={CUSTOM_CONDITION_FIELD}>{t('automation.ruleEdit.field.custom')}</option>
          </select>
        </label>
        {customField ? (
          <input
            aria-invalid={invalid || undefined}
            aria-label={t('automation.rule.conditionField')}
            className={inputClassName}
            data-testid={`automation-rule-edit-condition-path-${index}`}
            placeholder="workItem.customFieldValues.field-id"
            value={condition.field}
            onChange={(event) => onChange({ field: event.target.value, operator: condition.operator, value: condition.value })}
          />
        ) : null}
      </div>
      <label className={labelClassName}>
        {t('automation.rule.conditionOperator')}
        <select
          className={inputClassName}
          data-testid={`automation-rule-edit-condition-operator-${index}`}
          value={condition.operator}
          onChange={(event) => onChange({ ...condition, operator: readConditionOperator(event.target.value) })}
        >
          {conditionOperators.map((operator) => (
            <option key={operator} value={operator}>{t(conditionOperatorLabelKeys[operator])}</option>
          ))}
        </select>
      </label>
      {needsValue ? (
        <ValuePicker
          kind={kind}
          label={t('automation.rule.conditionValue')}
          options={options}
          t={t}
          testId={`automation-rule-edit-condition-value-${index}`}
          value={condition.value}
          onChange={(value) => onChange({ ...condition, value })}
        />
      ) : <span />}
      <button
        className="workbench-button-secondary min-h-10 px-3"
        data-testid={`automation-rule-edit-condition-remove-${index}`}
        type="button"
        onClick={onRemove}
      >
        {t('automation.ruleEdit.remove')}
      </button>
    </div>
  )
}

/** Props of a value picker. */
type ValuePickerProps = {
  /** Kind of value. */
  kind: ConditionFieldKind
  /** Field label. */
  label: string
  /** Picker choices. */
  options: AutomationRuleEditorOptions
  /** Translator. */
  t: Translate
  /** Test selector. */
  testId: string
  /** Current value. */
  value: string
  /** Called with the new value. */
  onChange: (value: string) => void
}

/**
 * Picks a status, member, priority, Project, or Team, or takes typed text.
 *
 * @param props - Picker props.
 * @returns The picker.
 */
function ValuePicker({ kind, label, onChange, options, t, testId, value }: ValuePickerProps) {
  const choices = kind === 'status' ? options.statuses
    : kind === 'member' ? options.members
      : kind === 'project' ? options.projects
        : kind === 'team' ? options.teams
          : kind === 'priority'
            ? priorityValues.map((priority) => ({ id: priority, label: t(priorityLabelKeys[priority]) }))
            : undefined
  if (kind === 'boolean') {
    return (
      <label className={labelClassName}>
        {label}
        <select className={inputClassName} data-testid={testId} value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">{t('automation.ruleEdit.choose')}</option>
          <option value="true">{t('automation.ruleEdit.booleanTrue')}</option>
          <option value="false">{t('automation.ruleEdit.booleanFalse')}</option>
        </select>
      </label>
    )
  }
  if (!choices) {
    return (
      <label className={labelClassName}>
        {label}
        <input
          className={inputClassName}
          data-testid={testId}
          inputMode={kind === 'number' ? 'decimal' : undefined}
          step={kind === 'number' ? 'any' : undefined}
          type={kind === 'number' ? 'number' : 'text'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    )
  }
  return (
    <label className={labelClassName}>
      {label}
      <select className={inputClassName} data-testid={testId} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t('automation.ruleEdit.choose')}</option>
        {withCurrentChoice(choices, value).map((choice) => (
          <option key={choice.id} value={choice.id}>{choice.label}</option>
        ))}
      </select>
    </label>
  )
}

/** Props of one action card. */
type ActionCardProps = {
  /** Action to show. */
  action: AutomationRuleActionDraft
  /** Position in the rule. */
  index: number
  /** Number of actions. */
  count: number
  /** Picker choices. */
  options: AutomationRuleEditorOptions
  /** Translator. */
  t: Translate
  /** Replaces the action. */
  onChange: (next: AutomationRuleActionDraft) => void
  /** Moves the action earlier (-1) or later (1). */
  onMove: (offset: -1 | 1) => void
  /** Removes the action. */
  onRemove: () => void
}

/**
 * One action with its order controls and settings.
 *
 * @param props - Card props.
 * @returns The card.
 */
function ActionCard({ action, count, index, onChange, onMove, onRemove, options, t }: ActionCardProps) {
  const type = action.type === 'saved' ? action.action.type : action.type
  const invalid = !isAutomationRuleActionDraftValid(action)
  return (
    <div
      aria-invalid={invalid || undefined}
      className="grid gap-3 rounded-lg border border-[var(--workbench-border)] p-3"
      data-testid={`automation-rule-edit-action-${index}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-[var(--workbench-text)]">
          {index + 1}. {t(actionLabelKeys[type])}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            aria-label={t('automation.ruleEdit.moveUp')}
            className="workbench-button-secondary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-55"
            data-testid={`automation-rule-edit-action-up-${index}`}
            disabled={index === 0}
            type="button"
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            aria-label={t('automation.ruleEdit.moveDown')}
            className="workbench-button-secondary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-55"
            data-testid={`automation-rule-edit-action-down-${index}`}
            disabled={index === count - 1}
            type="button"
            onClick={() => onMove(1)}
          >
            ↓
          </button>
          <button
            className="workbench-button-secondary min-h-9 px-3"
            data-testid={`automation-rule-edit-action-remove-${index}`}
            type="button"
            onClick={onRemove}
          >
            {t('automation.ruleEdit.remove')}
          </button>
        </div>
      </div>
      <ActionSettings action={action} index={index} options={options} t={t} onChange={onChange} />
    </div>
  )
}

/** Props of the settings of one action. */
type ActionSettingsProps = {
  /** Action to edit. */
  action: AutomationRuleActionDraft
  /** Position, for test selectors. */
  index: number
  /** Picker choices. */
  options: AutomationRuleEditorOptions
  /** Translator. */
  t: Translate
  /** Replaces the action. */
  onChange: (next: AutomationRuleActionDraft) => void
}

/**
 * Settings of one action, with pickers for members, Projects, statuses, and templates.
 *
 * @param props - Settings props.
 * @returns The settings fields.
 */
function ActionSettings({ action, index, onChange, options, t }: ActionSettingsProps) {
  const testId = `automation-rule-edit-action-${index}`
  switch (action.type) {
    case 'assign':
      return (
        <PickerField
          choices={options.members}
          label={t('automation.ruleEdit.assignee')}
          t={t}
          testId={`${testId}-member`}
          value={action.memberKey}
          onChange={(memberKey) => onChange({ ...action, memberKey })}
        />
      )
    case 'move':
      return (
        <PickerField
          choices={options.projects}
          emptyLabel={t('automation.ruleEdit.noProject')}
          label={t('automation.ruleEdit.project')}
          t={t}
          testId={`${testId}-project`}
          value={action.projectId}
          onChange={(projectId) => onChange({ ...action, projectId })}
        />
      )
    case 'update':
      return (
        <div className="grid grid-cols-2 gap-3 max-[760px]:grid-cols-1">
          <label className={labelClassName}>
            {t('automation.ruleEdit.updateField')}
            <select
              className={inputClassName}
              data-testid={`${testId}-field`}
              value={action.field}
              onChange={(event) => onChange({ ...action, field: readUpdateField(event.target.value), value: '' })}
            >
              {AUTOMATION_RULE_UPDATE_FIELDS.map((field) => (
                <option key={field} value={field}>{t(updateFieldLabelKeys[field])}</option>
              ))}
            </select>
          </label>
          <ValuePicker
            kind={action.field === 'workflowStatusId' ? 'status' : action.field === 'priority' ? 'priority' : 'text'}
            label={t('automation.ruleEdit.newValue')}
            options={options}
            t={t}
            testId={`${testId}-value`}
            value={action.value}
            onChange={(value) => onChange({ ...action, value })}
          />
        </div>
      )
    case 'create':
      return (
        <PickerField
          choices={options.workItemTemplates}
          label={t('automation.ruleEdit.template')}
          t={t}
          testId={`${testId}-template`}
          value={action.templateId}
          onChange={(templateId) => onChange({ ...action, templateId })}
        />
      )
    case 'comment':
      return (
        <label className={labelClassName}>
          {t('automation.ruleEdit.commentBody')}
          <textarea
            className="workbench-input min-h-20 px-3 py-2 text-[var(--workbench-text)]"
            data-testid={`${testId}-body`}
            value={action.body}
            onChange={(event) => onChange({ ...action, body: event.target.value })}
          />
        </label>
      )
    case 'notify':
      return (
        <div className="grid gap-3">
          <MemberListField
            label={t('automation.ruleEdit.recipients')}
            memberKeys={action.memberKeys}
            options={options}
            t={t}
            testId={`${testId}-recipients`}
            onChange={(memberKeys) => onChange({ ...action, memberKeys })}
          />
          <label className="flex items-center gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
            <input
              checked={action.notifyAssignee}
              data-testid={`${testId}-notify-assignee`}
              type="checkbox"
              onChange={(event) => onChange({ ...action, notifyAssignee: event.target.checked })}
            />
            {t('automation.rule.notifyAssignee')}
          </label>
          <label className={labelClassName}>
            {t('automation.ruleEdit.notificationTitle')}
            <input
              className={inputClassName}
              data-testid={`${testId}-title`}
              value={action.title}
              onChange={(event) => onChange({ ...action, title: event.target.value })}
            />
          </label>
          <label className={labelClassName}>
            {t('automation.ruleEdit.notificationBody')}
            <input
              className={inputClassName}
              data-testid={`${testId}-body`}
              value={action.body}
              onChange={(event) => onChange({ ...action, body: event.target.value })}
            />
          </label>
        </div>
      )
    case 'approval':
      return (
        <div className="grid gap-3">
          <MemberListField
            label={t('automation.ruleEdit.reviewers')}
            memberKeys={action.memberKeys}
            options={options}
            t={t}
            testId={`${testId}-reviewers`}
            onChange={(memberKeys) => onChange({ ...action, memberKeys })}
          />
          <div className="grid grid-cols-2 gap-3 max-[760px]:grid-cols-1">
            <label className={labelClassName}>
              {t('automation.ruleEdit.dueInHours')}
              <input
                className={inputClassName}
                data-testid={`${testId}-due`}
                min={1}
                type="number"
                value={action.dueInHours}
                onChange={(event) => onChange({ ...action, dueInHours: Number(event.target.value) })}
              />
            </label>
            <PickerField
              choices={options.statuses}
              emptyLabel={t('automation.ruleEdit.keepStatus')}
              label={t('automation.ruleEdit.completionStatus')}
              t={t}
              testId={`${testId}-completion-status`}
              value={action.completionStatusId}
              onChange={(completionStatusId) => onChange({ ...action, completionStatusId })}
            />
          </div>
        </div>
      )
    case 'webhook':
      return (
        <label className={labelClassName}>
          {t('automation.ruleEdit.webhookUrl')}
          <input
            className={inputClassName}
            data-testid={`${testId}-url`}
            placeholder="https://"
            type="url"
            value={action.url}
            onChange={(event) => onChange({ ...action, url: event.target.value })}
          />
        </label>
      )
    case 'saved':
      return (
        <p className="text-xs font-medium leading-5 text-[var(--workbench-muted)]" data-testid={`${testId}-saved`}>
          {t('automation.ruleEdit.savedAction')}
        </p>
      )
  }
}

/** Props of a single-choice picker. */
type PickerFieldProps = {
  /** Field label. */
  label: string
  /** Choices. */
  choices: AutomationRulePickerOption[]
  /** Label of the empty choice; absent shows a "choose" prompt. */
  emptyLabel?: string
  /** Translator. */
  t: Translate
  /** Test selector. */
  testId: string
  /** Current value. */
  value: string
  /** Called with the new value. */
  onChange: (value: string) => void
}

/**
 * Picks one option by ID.
 *
 * @param props - Picker props.
 * @returns The picker.
 */
function PickerField({ choices, emptyLabel, label, onChange, t, testId, value }: PickerFieldProps) {
  return (
    <label className={labelClassName}>
      {label}
      <select className={inputClassName} data-testid={testId} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{emptyLabel ?? t('automation.ruleEdit.choose')}</option>
        {withCurrentChoice(choices, value).map((choice) => (
          <option key={choice.id} value={choice.id}>{choice.label}</option>
        ))}
      </select>
    </label>
  )
}

/** Props of a member list picker. */
type MemberListFieldProps = {
  /** Field label. */
  label: string
  /** Chosen members. */
  memberKeys: string[]
  /** Picker choices. */
  options: AutomationRuleEditorOptions
  /** Translator. */
  t: Translate
  /** Test selector. */
  testId: string
  /** Called with the new member list. */
  onChange: (memberKeys: string[]) => void
}

/**
 * Chooses several members: the chosen ones as removable chips, and a picker to add one more.
 *
 * @param props - Field props.
 * @returns The field.
 */
function MemberListField({ label, memberKeys, onChange, options, t, testId }: MemberListFieldProps) {
  const available = options.members.filter((member) => !memberKeys.includes(member.id))
  return (
    <div className="grid gap-2" data-testid={testId}>
      <p className="text-xs font-semibold text-[var(--workbench-muted)]">{label}</p>
      {memberKeys.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {memberKeys.map((memberKey) => (
            <li className="workbench-badge flex items-center gap-1" key={memberKey}>
              {readOptionLabel(options.members, memberKey)}
              <button
                aria-label={`${t('automation.ruleEdit.remove')}: ${readOptionLabel(options.members, memberKey)}`}
                className="px-1 font-semibold"
                type="button"
                onClick={() => onChange(memberKeys.filter((key) => key !== memberKey))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <select
        aria-label={`${label}: ${t('automation.ruleEdit.addMember')}`}
        className={`${inputClassName} max-w-[360px]`}
        data-testid={`${testId}-add`}
        value=""
        onChange={(event) => {
          if (event.target.value) onChange([...memberKeys, event.target.value])
        }}
      >
        <option value="">{t('automation.ruleEdit.addMember')}</option>
        {available.map((member) => (
          <option key={member.id} value={member.id}>{member.label}</option>
        ))}
      </select>
    </div>
  )
}

/** Props of the dry run section. */
type DryRunSectionProps = {
  /** Rule being edited. */
  rule: AutomationRule
  /** Current draft. */
  draft: AutomationRuleDraft
  /** Whether the draft is complete enough to try. */
  canRun: boolean
  /** Picker choices. */
  options: AutomationRuleEditorOptions
  /** Translator. */
  t: Translate
  /** Runs the dry run. */
  onDryRun: (input: AutomationRuleDryRunInput) => Promise<AutomationRuleDryRunResult>
}

/**
 * Tries the edited rule on one Work Item and shows whether it matches and what it would do.
 *
 * @param props - Section props.
 * @returns The section.
 */
function DryRunSection({ canRun, draft, onDryRun, options, rule, t }: DryRunSectionProps) {
  const [teamId, setTeamId] = useState(options.teams[0]?.id ?? '')
  const [workItemId, setWorkItemId] = useState('')
  const [running, setRunning] = useState(false)
  const [tested, setTested] = useState<{ key: string, result: AutomationRuleDryRunResult }>()
  const [failed, setFailed] = useState<{ key: string, message: string }>()
  const latestRequestKey = useRef<string | undefined>(undefined)
  const input: AutomationRuleDryRunInput = {
    teamId,
    workItemId: workItemId.trim(),
    rule: {
      name: draft.name.trim(),
      enabled: rule.enabled,
      trigger: rule.trigger,
      conditions: createAutomationRuleDraftConditions(draft),
      actions: createAutomationRuleDraftActions(draft),
      retryPolicy: rule.retryPolicy,
      rateLimit: rule.rateLimit,
      allowReentry: rule.allowReentry,
      maxChainDepth: rule.maxChainDepth,
    },
  }
  // A result describes only the inputs it was run with; editing them hides it.
  const inputKey = JSON.stringify(input)
  const result = tested?.key === inputKey ? tested.result : undefined
  const failure = failed?.key === inputKey ? failed.message : undefined

  /** Sends the dry run for the chosen Work Item and ignores a response for superseded inputs. */
  async function run() {
    if (!canRun || !teamId || !workItemId.trim()) return
    const requestKey = inputKey
    latestRequestKey.current = requestKey
    setRunning(true)
    setFailed(undefined)
    try {
      const response = await onDryRun(input)
      if (latestRequestKey.current === requestKey) setTested({ key: requestKey, result: response })
    } catch (error) {
      if (latestRequestKey.current === requestKey) {
        setTested(undefined)
        setFailed({
          key: requestKey,
          message: error instanceof Error && error.message.trim()
            ? error.message
            : t('automation.ruleEdit.dryRunFailed'),
        })
      }
    } finally {
      if (latestRequestKey.current === requestKey) setRunning(false)
    }
  }

  return (
    <section className="grid gap-3 rounded-lg border border-[var(--workbench-border)] bg-surface p-3" data-testid="automation-rule-dry-run">
      <div>
        <h4 className="text-xs font-semibold text-[var(--workbench-text)]">{t('automation.ruleEdit.dryRunTitle')}</h4>
        <p className="mt-1 text-xs font-medium leading-5 text-[var(--workbench-muted)]">{t('automation.ruleEdit.dryRunHint')}</p>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-3 max-[760px]:grid-cols-1">
        <PickerField
          choices={options.teams}
          label={t('automation.ruleEdit.dryRunTeam')}
          t={t}
          testId="automation-rule-dry-run-team"
          value={teamId}
          onChange={setTeamId}
        />
        <label className={labelClassName}>
          {t('automation.ruleEdit.dryRunWorkItem')}
          <input
            className={inputClassName}
            data-testid="automation-rule-dry-run-work-item"
            value={workItemId}
            onChange={(event) => setWorkItemId(event.target.value)}
          />
        </label>
        <button
          className="workbench-button-secondary min-h-10 px-3 disabled:cursor-not-allowed disabled:opacity-55"
          data-testid="automation-rule-dry-run-submit"
          disabled={!canRun || running || !teamId || !workItemId.trim()}
          type="button"
          onClick={() => void run()}
        >
          {t(running ? 'automation.ruleEdit.dryRunRunning' : 'automation.ruleEdit.dryRunSubmit')}
        </button>
      </div>
      {failure ? <p className="text-xs font-semibold text-fg-red-700" role="alert">{failure}</p> : null}
      {result ? <DryRunResultView options={options} result={result} t={t} /> : null}
    </section>
  )
}

/** Props of a dry run result. */
type DryRunResultViewProps = {
  /** Result to show. */
  result: AutomationRuleDryRunResult
  /** Picker choices, for readable labels. */
  options: AutomationRuleEditorOptions
  /** Translator. */
  t: Translate
}

/**
 * Shows whether the rule matched, each condition's result, and the planned actions.
 *
 * @param props - Result props.
 * @returns The result.
 */
function DryRunResultView({ options, result, t }: DryRunResultViewProps) {
  return (
    <div aria-live="polite" className="grid gap-2" data-testid="automation-rule-dry-run-result">
      <p className={`text-sm font-semibold ${result.matched ? 'text-[var(--workbench-text)]' : 'text-fg-red-700'}`}>
        {t(result.matched ? 'automation.ruleEdit.dryRunMatched' : 'automation.ruleEdit.dryRunNotMatched')}
      </p>
      {result.conditions.length > 0 ? (
        <ul className="grid gap-1 text-xs font-medium text-[var(--workbench-muted)]">
          {result.conditions.map((condition) => (
            <li key={condition.index}>
              {t('automation.ruleEdit.dryRunCondition').replace('{number}', String(condition.index + 1))}
              {': '}
              {t(condition.matched ? 'automation.ruleEdit.dryRunConditionMet' : 'automation.ruleEdit.dryRunConditionNotMet')}
              {condition.readsEventFields ? ` (${t('automation.ruleEdit.dryRunEventFields')})` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {result.actions.length > 0 ? (
        <ol className="grid gap-1 text-xs font-medium text-[var(--workbench-text)]">
          {result.actions.map((action) => (
            <li key={action.index}>
              {action.index + 1}. {readActionLabel(action.type, t)}
              {describePlannedAction(action, options, t)}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}

/**
 * Describes what one planned action changes.
 *
 * @param action - Planned action.
 * @param options - Picker choices, for readable labels.
 * @param t - Translator.
 * @returns A short description, or nothing for actions without details.
 */
function describePlannedAction(
  action: AutomationRuleDryRunResult['actions'][number],
  options: AutomationRuleEditorOptions,
  t: Translate,
): ReactNode {
  if (action.changes) {
    if (action.changes.length === 0) return `: ${t('automation.ruleEdit.dryRunNoChange')}`
    return `: ${action.changes.map((change) =>
      `${change.field} ${formatDryRunValue(change.before, options)} → ${formatDryRunValue(change.after, options)}`).join(', ')}`
  }
  if (action.recipientMemberKeys) {
    return `: ${action.recipientMemberKeys.map((key) => readOptionLabel(options.members, key)).join(', ')}`
  }
  if (action.webhookHost) return `: ${action.webhookHost}`
  return null
}

/**
 * Formats a value from a dry run change with picker labels where the ID is known.
 *
 * @param value - Value to format.
 * @param options - Picker choices.
 * @returns Readable text.
 */
function formatDryRunValue(value: AutomationValue | undefined, options: AutomationRuleEditorOptions): string {
  if (value === undefined || value === null || value === '') return '—'
  if (typeof value !== 'string') return JSON.stringify(value)
  const known = [...options.members, ...options.statuses, ...options.projects].find((option) => option.id === value)
  return known?.label ?? value
}

/**
 * Lists the condition fields the editor offers by name.
 *
 * @param t - Translator.
 * @param customFields - Custom fields of the Workspace and Teams.
 * @returns Presets in display order.
 */
function createConditionFieldPresets(t: Translate, customFields: AutomationRulePickerOption[]): ConditionFieldPreset[] {
  return [
    { field: 'workItem.workflowStatusId', label: t('automation.ruleEdit.field.status'), kind: 'status' },
    { field: 'workItem.assigneeUserId', label: t('automation.ruleEdit.field.assignee'), kind: 'member' },
    { field: 'workItem.priority', label: t('automation.ruleEdit.field.priority'), kind: 'priority' },
    { field: 'workItem.assignedProjectId', label: t('automation.ruleEdit.field.project'), kind: 'project' },
    { field: 'workItem.teamId', label: t('automation.ruleEdit.field.team'), kind: 'team' },
    { field: 'workItem.title', label: t('automation.ruleEdit.field.title'), kind: 'text' },
    ...customFields.map((field): ConditionFieldPreset => ({
      field: `workItem.customFieldValues.${field.id}`,
      label: `${t('automation.ruleEdit.field.customField')}: ${field.label}`,
      kind: field.valueType ?? 'text',
    })),
  ]
}

/**
 * Keeps a saved value selectable even when it is no longer among the choices.
 *
 * @param choices - Current choices.
 * @param value - Saved value.
 * @returns Choices with the saved value added when missing.
 */
function withCurrentChoice(choices: AutomationRulePickerOption[], value: string): AutomationRulePickerOption[] {
  return !value || choices.some((choice) => choice.id === value) ? choices : [...choices, { id: value, label: value }]
}

/**
 * Reads the label of an option, falling back to its ID.
 *
 * @param choices - Choices.
 * @param id - Option ID.
 * @returns The label.
 */
function readOptionLabel(choices: AutomationRulePickerOption[], id: string): string {
  return choices.find((choice) => choice.id === id)?.label ?? id
}

/**
 * Reads the label of an action type from a dry run.
 *
 * @param type - Action type.
 * @param t - Translator.
 * @returns The label.
 */
function readActionLabel(type: string, t: Translate): string {
  const known = AUTOMATION_RULE_DRAFT_ACTION_TYPES.find((candidate) => candidate === type)
  return known ? t(actionLabelKeys[known]) : type
}

/**
 * Narrows a select value to an action type.
 *
 * @param value - Select value.
 * @returns The action type, `notify` when unknown.
 */
function readActionType(value: string): AutomationRuleDraftActionType {
  return AUTOMATION_RULE_DRAFT_ACTION_TYPES.find((type) => type === value) ?? 'notify'
}

/**
 * Narrows a select value to a condition operator.
 *
 * @param value - Select value.
 * @returns The operator, `equals` when unknown.
 */
function readConditionOperator(value: string): AutomationConditionOperator {
  return conditionOperators.find((operator) => operator === value) ?? 'equals'
}

/**
 * Narrows a select value to an update field.
 *
 * @param value - Select value.
 * @returns The field, the status when unknown.
 */
function readUpdateField(value: string): AutomationRuleUpdateField {
  return AUTOMATION_RULE_UPDATE_FIELDS.find((field) => field === value) ?? 'workflowStatusId'
}
