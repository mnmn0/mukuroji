import type {
  CustomFieldDefinition,
  CustomFieldType,
  CustomFieldValidation,
  CustomFieldValue,
  WorkflowStatusCategory,
  WorkflowStatusDefinition,
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import {
  useMemo,
  useState,
  type FormEvent,
} from 'react'
import {
  createTranslator,
  type Locale,
} from '../i18n'
import {
  sortCustomFieldDefinitions,
} from './customFields'
import {
  resolveWorkflowCategoryToneClassName,
  sortWorkflowStatuses,
} from './workItemDisplay'

/**
 * Configuration panel の scope selector に表示する選択肢です。
 */
export type WorkItemConfigurationScopeOption = {
  /**
   * 親 container が scope を識別する安定値です。
   */
  value: string
  /**
   * Selector に表示する scope 名です。
   */
  label: string
  /**
   * Scope の用途を補足する任意説明です。
   */
  description?: string
}

/**
 * WorkItemConfigurationPanel が受け取る props です。
 */
export type WorkItemConfigurationPanelProps = {
  /**
   * 表示 locale です。
   */
  locale: Locale
  /**
   * API から取得した保存対象 configuration です。
   */
  configuration?: WorkItemConfiguration
  /**
   * Team override が無い場合に利用した継承元です。
   */
  inheritedFrom?: 'workspace' | 'default'
  /**
   * Scope selector の選択肢です。
   */
  scopeOptions: readonly WorkItemConfigurationScopeOption[]
  /**
   * 現在選択中の scope option value です。
   */
  selectedScopeValue: string
  /**
   * Configuration を取得中かどうかです。
   */
  isLoading?: boolean
  /**
   * Configuration 取得または保存 error の表示文言です。
   */
  errorMessage?: string
  /**
   * Owner/admin 以外で編集を無効にするかどうかです。
   */
  readOnly?: boolean
  /**
   * Scope selector が変更されたときの callback です。
   */
  onScopeChange: (scopeValue: string) => void
  /**
   * Configuration 全体を保存する callback です。
   */
  onSave?: (configuration: WorkItemConfiguration) => Promise<void>
}

const workflowStatusCategories = [
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
] as const satisfies readonly WorkflowStatusCategory[]

const customFieldTypes = [
  'text',
  'number',
  'boolean',
  'date',
  'select',
  'multi-select',
  'person',
  'currency',
  'duration',
  'formula',
] as const satisfies readonly CustomFieldType[]

/**
 * Workspace/Team workflow と custom field definition を一画面で編集します。
 *
 * Status rail と transition matrix を主役にし、頻繁な運用変更を静かに比較できる密度で描画します。
 */
export function WorkItemConfigurationPanel({
  configuration,
  selectedScopeValue,
  ...props
}: WorkItemConfigurationPanelProps) {
  const configurationIdentity = configuration
    ? [
        selectedScopeValue,
        configuration.scopeType,
        configuration.scopeId,
        configuration.revision,
        configuration.updatedAt ?? '',
      ].join(':')
    : `${selectedScopeValue}:empty`

  return (
    <WorkItemConfigurationPanelContent
      {...props}
      configuration={configuration}
      key={configurationIdentity}
      selectedScopeValue={selectedScopeValue}
    />
  )
}

function WorkItemConfigurationPanelContent({
  configuration,
  errorMessage,
  inheritedFrom,
  isLoading = false,
  locale,
  onSave,
  onScopeChange,
  readOnly = false,
  scopeOptions,
  selectedScopeValue,
}: WorkItemConfigurationPanelProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [draft, setDraft] = useState<WorkItemConfiguration | undefined>(() =>
    configuration ? cloneConfiguration(configuration) : undefined,
  )
  const [isSaving, setIsSaving] = useState(false)
  const [localErrorMessage, setLocalErrorMessage] = useState<string | undefined>()

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!draft || readOnly || !onSave) {
      return
    }

    setIsSaving(true)
    setLocalErrorMessage(undefined)

    try {
      await onSave(normalizeConfiguration(draft))
    } catch (error) {
      setLocalErrorMessage(
        error instanceof Error && error.message.trim()
          ? error.message
          : t('workItems.configuration.saveError'),
      )
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <section className="grid gap-5" data-testid="work-item-configuration-panel">
      <div className="workbench-toolbar grid grid-cols-[minmax(0,1fr)_minmax(240px,360px)] items-end gap-5 p-4 max-[760px]:grid-cols-1">
        <div className="min-w-0">
          <p className="workbench-eyebrow">{t('workItems.configuration.eyebrow')}</p>
          <h2 className="mt-2 text-xl font-semibold text-[var(--workbench-text)]">
            {t('workItems.configuration.title')}
          </h2>
          <p className="mt-2 max-w-[760px] text-sm font-medium leading-6 text-[var(--workbench-muted)]">
            {t('workItems.configuration.description')}
          </p>
        </div>
        <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
          {t('workItems.configuration.scope')}
          <select
            className="workbench-input min-h-11 w-full min-w-0 px-3"
            data-testid="work-item-configuration-scope"
            value={selectedScopeValue}
            onChange={(event) => onScopeChange(event.target.value)}
          >
            {scopeOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          {scopeOptions.find((option) => option.value === selectedScopeValue)?.description ? (
            <span className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
              {scopeOptions.find((option) => option.value === selectedScopeValue)?.description}
            </span>
          ) : null}
        </label>
      </div>

      {inheritedFrom ? (
        <p className="rounded-lg border border-teal-200 bg-teal-50 px-4 py-3 text-sm font-semibold text-teal-900" data-testid="work-item-configuration-inherited">
          {t(`workItems.configuration.inherited.${inheritedFrom}`)}
        </p>
      ) : null}

      {isLoading ? (
        <div className="workbench-panel grid min-h-52 place-items-center p-6 text-sm font-semibold text-[var(--workbench-muted)]">
          {t('workItems.configuration.loading')}
        </div>
      ) : !draft ? (
        <div className="workbench-panel grid min-h-52 place-items-center p-6 text-center text-sm font-semibold text-[var(--workbench-muted)]">
          {t('workItems.configuration.empty')}
        </div>
      ) : (
        <form className="grid gap-5" onSubmit={(event) => void handleSave(event)}>
          <fieldset className="contents" disabled={readOnly || isSaving}>
            <WorkflowConfigurationSection
              configuration={draft}
              locale={locale}
              onChange={setDraft}
            />
            <CustomFieldsConfigurationSection
              configuration={draft}
              locale={locale}
              onChange={setDraft}
            />
          </fieldset>

          <div className="workbench-toolbar sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 px-4 py-3 shadow-[0_12px_30px_rgba(23,32,29,0.12)]">
            <p className="text-sm font-medium text-[var(--workbench-muted)]">
              {readOnly
                ? t('workItems.configuration.readOnly')
                : t('workItems.configuration.revision').replace('{revision}', String(draft.revision))}
            </p>
            {!readOnly && onSave ? (
              <button
                className="workbench-button-primary min-h-10 px-5 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-300"
                disabled={isSaving}
                type="submit"
              >
                {isSaving
                  ? t('workItems.configuration.saving')
                  : t('workItems.configuration.save')}
              </button>
            ) : null}
          </div>
        </form>
      )}

      {errorMessage || localErrorMessage ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700" role="alert">
          {localErrorMessage ?? errorMessage}
        </p>
      ) : null}
    </section>
  )
}

function WorkflowConfigurationSection({
  configuration,
  locale,
  onChange,
}: {
  /** 編集中 configuration です。 */
  configuration: WorkItemConfiguration
  /** 表示 locale です。 */
  locale: Locale
  /** Draft 全体を更新する callback です。 */
  onChange: (configuration: WorkItemConfiguration) => void
}) {
  const t = createTranslator(locale)
  const statuses = sortWorkflowStatuses(configuration.workflow.statuses)
  const updateWorkflow = (workflow: WorkItemConfiguration['workflow']) => {
    onChange({ ...configuration, workflow })
  }
  const updateStatus = (statusId: string, patch: Partial<WorkflowStatusDefinition>) => {
    updateWorkflow({
      ...configuration.workflow,
      statuses: statuses.map((status) => status.id === statusId ? { ...status, ...patch } : status),
    })
  }
  const moveStatus = (statusId: string, direction: -1 | 1) => {
    const currentIndex = statuses.findIndex((status) => status.id === statusId)
    const targetIndex = currentIndex + direction

    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= statuses.length) {
      return
    }

    const nextStatuses = [...statuses]
    const [status] = nextStatuses.splice(currentIndex, 1)

    if (!status) {
      return
    }

    nextStatuses.splice(targetIndex, 0, status)
    updateWorkflow({
      ...configuration.workflow,
      statuses: nextStatuses.map((candidate, index) => ({ ...candidate, sortOrder: index })),
    })
  }
  const addStatus = () => {
    const id = createUniqueDefinitionId('status', statuses.map((status) => status.id))
    const nextStatus: WorkflowStatusDefinition = {
      category: 'started',
      id,
      name: t('workItems.configuration.newStatus'),
      sortOrder: statuses.length,
    }

    updateWorkflow({
      ...configuration.workflow,
      initialStatusId: configuration.workflow.initialStatusId || id,
      statuses: [...statuses, nextStatus],
    })
  }
  const toggleTransition = (fromStatusId: string, toStatusId: string, enabled: boolean) => {
    const withoutTransition = configuration.workflow.transitions.filter(
      (transition) =>
        transition.fromStatusId !== fromStatusId || transition.toStatusId !== toStatusId,
    )

    updateWorkflow({
      ...configuration.workflow,
      transitions: enabled
        ? [...withoutTransition, { fromStatusId, toStatusId }]
        : withoutTransition,
    })
  }

  return (
    <section className="workbench-panel overflow-hidden">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(240px,360px)] items-end gap-5 border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-4 max-[760px]:grid-cols-1">
        <div>
          <p className="workbench-eyebrow">{t('workItems.configuration.workflowEyebrow')}</p>
          <h3 className="mt-2 text-lg font-semibold text-[var(--workbench-text)]">
            {t('workItems.configuration.workflowTitle')}
          </h3>
          <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
            {t('workItems.configuration.workflowDescription')}
          </p>
        </div>
        <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
          {t('workItems.configuration.workflowName')}
          <input
            className="workbench-input min-h-10 px-3"
            required
            value={configuration.workflow.name}
            onChange={(event) => updateWorkflow({
              ...configuration.workflow,
              name: event.target.value,
            })}
          />
        </label>
      </div>

      <div className="grid grid-cols-[minmax(0,0.92fr)_minmax(520px,1.08fr)] gap-0 max-[1180px]:grid-cols-1">
        <div className="min-w-0 border-r border-[var(--workbench-border)] p-5 max-[1180px]:border-b max-[1180px]:border-r-0">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold text-[var(--workbench-text)]">
                {t('workItems.configuration.statusRailTitle')}
              </h4>
              <p className="mt-1 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                {t('workItems.configuration.statusRailDescription')}
              </p>
            </div>
            <button
              className="workbench-button-secondary min-h-9 px-3"
              onClick={addStatus}
              type="button"
            >
              + {t('workItems.configuration.addStatus')}
            </button>
          </div>

          <ol className="grid gap-2">
            {statuses.map((status, index) => (
              <li
                className="grid grid-cols-[32px_minmax(140px,1fr)_minmax(130px,0.7fr)_auto] items-center gap-2 rounded-lg border border-[var(--workbench-border)] bg-white p-2 max-[680px]:grid-cols-[32px_minmax(0,1fr)_auto]"
                data-testid={`workflow-status-${status.id}`}
                key={status.id}
              >
                <span
                  aria-hidden="true"
                  className={`grid h-8 w-8 place-items-center rounded-full text-xs font-bold ${resolveWorkflowCategoryToneClassName(status.category)}`}
                >
                  {index + 1}
                </span>
                <div className="grid min-w-0 gap-1">
                  <input
                    aria-label={t('workItems.configuration.statusName').replace('{index}', String(index + 1))}
                    className="workbench-input min-h-9 min-w-0 px-2"
                    required
                    value={status.name}
                    onChange={(event) => updateStatus(status.id, { name: event.target.value })}
                  />
                  <code className="truncate text-[11px] font-semibold text-[var(--workbench-muted)]">
                    {status.id}
                  </code>
                </div>
                <select
                  aria-label={t('workItems.configuration.statusCategory').replace('{status}', status.name)}
                  className="workbench-input min-h-9 min-w-0 px-2 max-[680px]:col-start-2"
                  value={status.category}
                  onChange={(event) => updateStatus(status.id, {
                    category: event.target.value as WorkflowStatusCategory,
                  })}
                >
                  {workflowStatusCategories.map((category) => (
                    <option key={category} value={category}>
                      {t(`workItems.statusCategory.${category}`)}
                    </option>
                  ))}
                </select>
                <div className="flex items-center justify-end gap-1 max-[680px]:row-span-2 max-[680px]:row-start-1">
                  <button
                    aria-label={t('workItems.configuration.moveStatusUp').replace('{status}', status.name)}
                    className="workbench-button-secondary grid h-9 w-9 place-items-center disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={index === 0}
                    onClick={() => moveStatus(status.id, -1)}
                    type="button"
                  >
                    ↑
                  </button>
                  <button
                    aria-label={t('workItems.configuration.moveStatusDown').replace('{status}', status.name)}
                    className="workbench-button-secondary grid h-9 w-9 place-items-center disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={index === statuses.length - 1}
                    onClick={() => moveStatus(status.id, 1)}
                    type="button"
                  >
                    ↓
                  </button>
                </div>
                <label className="col-start-2 col-end-4 flex min-h-8 cursor-pointer items-center gap-2 text-xs font-semibold text-[var(--workbench-muted)] max-[680px]:col-end-3">
                  <input
                    checked={configuration.workflow.initialStatusId === status.id}
                    className="h-4 w-4 accent-[var(--workbench-primary)]"
                    name="workflow-initial-status"
                    onChange={() => updateWorkflow({
                      ...configuration.workflow,
                      initialStatusId: status.id,
                    })}
                    type="radio"
                  />
                  {t('workItems.configuration.initialStatus')}
                </label>
              </li>
            ))}
          </ol>
        </div>

        <div className="min-w-0 p-5">
          <h4 className="text-sm font-semibold text-[var(--workbench-text)]">
            {t('workItems.configuration.transitionTitle')}
          </h4>
          <p className="mt-1 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
            {t('workItems.configuration.transitionDescription')}
          </p>
          <div className="mt-4 overflow-x-auto rounded-lg border border-[var(--workbench-border)]">
            <table className="w-full min-w-[520px] border-collapse text-center text-xs">
              <thead>
                <tr className="bg-[var(--workbench-surface-muted)] text-[var(--workbench-muted)]">
                  <th className="sticky left-0 z-10 min-w-36 border-r border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 py-3 text-left" scope="col">
                    {t('workItems.configuration.transitionFromTo')}
                  </th>
                  {statuses.map((status) => (
                    <th className="min-w-24 px-2 py-3 font-semibold" key={status.id} scope="col">
                      {status.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {statuses.map((fromStatus) => (
                  <tr className="border-t border-[var(--workbench-border)]" key={fromStatus.id}>
                    <th className="sticky left-0 z-10 border-r border-[var(--workbench-border)] bg-white px-3 py-3 text-left text-sm font-semibold text-[var(--workbench-text)]" scope="row">
                      {fromStatus.name}
                    </th>
                    {statuses.map((toStatus) => {
                      const isSelf = fromStatus.id === toStatus.id
                      const isAllowed = configuration.workflow.transitions.some(
                        (transition) =>
                          transition.fromStatusId === fromStatus.id &&
                          transition.toStatusId === toStatus.id,
                      )

                      return (
                        <td className={isSelf ? 'bg-[var(--workbench-surface-muted)] px-2 py-3' : 'px-2 py-3'} key={toStatus.id}>
                          {isSelf ? (
                            <span aria-label={t('workItems.configuration.transitionSame')}>—</span>
                          ) : (
                            <input
                              aria-label={t('workItems.configuration.transitionLabel')
                                .replace('{from}', fromStatus.name)
                                .replace('{to}', toStatus.name)}
                              checked={isAllowed}
                              className="h-4 w-4 accent-[var(--workbench-primary)]"
                              onChange={(event) => toggleTransition(
                                fromStatus.id,
                                toStatus.id,
                                event.target.checked,
                              )}
                              type="checkbox"
                            />
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  )
}

function CustomFieldsConfigurationSection({
  configuration,
  locale,
  onChange,
}: {
  /** 編集中 configuration です。 */
  configuration: WorkItemConfiguration
  /** 表示 locale です。 */
  locale: Locale
  /** Draft 全体を更新する callback です。 */
  onChange: (configuration: WorkItemConfiguration) => void
}) {
  const t = createTranslator(locale)
  const fields = sortCustomFieldDefinitions(configuration.customFields)
  const updateFields = (customFields: CustomFieldDefinition[]) => {
    onChange({ ...configuration, customFields })
  }
  const updateField = (
    fieldId: string,
    update: (field: CustomFieldDefinition) => CustomFieldDefinition,
  ) => {
    updateFields(fields.map((field) => field.id === fieldId ? update(field) : field))
  }
  const addField = () => {
    const id = createUniqueDefinitionId('field', fields.map((field) => field.id))

    updateFields([
      ...fields,
      {
        id,
        name: t('workItems.configuration.newField'),
        required: false,
        sortOrder: fields.length,
        type: 'text',
      },
    ])
  }
  const moveField = (fieldId: string, direction: -1 | 1) => {
    const currentIndex = fields.findIndex((field) => field.id === fieldId)
    const targetIndex = currentIndex + direction

    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= fields.length) {
      return
    }

    const nextFields = [...fields]
    const [field] = nextFields.splice(currentIndex, 1)

    if (!field) {
      return
    }

    nextFields.splice(targetIndex, 0, field)
    updateFields(nextFields.map((candidate, index) => ({ ...candidate, sortOrder: index })))
  }

  return (
    <section className="workbench-panel overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-4">
        <div>
          <p className="workbench-eyebrow">{t('workItems.configuration.fieldsEyebrow')}</p>
          <h3 className="mt-2 text-lg font-semibold text-[var(--workbench-text)]">
            {t('workItems.configuration.fieldsTitle')}
          </h3>
          <p className="mt-1 max-w-[760px] text-sm font-medium leading-6 text-[var(--workbench-muted)]">
            {t('workItems.configuration.fieldsDescription')}
          </p>
        </div>
        <button className="workbench-button-secondary min-h-10 px-4" onClick={addField} type="button">
          + {t('workItems.configuration.addField')}
        </button>
      </div>

      <div className="grid gap-3 p-5">
        {fields.map((field, index) => (
          <CustomFieldDefinitionCard
            field={field}
            index={index}
            isFirst={index === 0}
            isLast={index === fields.length - 1}
            key={field.id}
            locale={locale}
            onMove={(direction) => moveField(field.id, direction)}
            onUpdate={(update) => updateField(field.id, update)}
          />
        ))}
        {fields.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[var(--workbench-border-strong)] px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
            {t('workItems.configuration.noFields')}
          </p>
        ) : null}
      </div>
    </section>
  )
}

function CustomFieldDefinitionCard({
  field,
  index,
  isFirst,
  isLast,
  locale,
  onMove,
  onUpdate,
}: {
  /** 編集対象 field definition です。 */
  field: CustomFieldDefinition
  /** 一覧内の zero-based index です。 */
  index: number
  /** 最初の field かどうかです。 */
  isFirst: boolean
  /** 最後の field かどうかです。 */
  isLast: boolean
  /** 表示 locale です。 */
  locale: Locale
  /** Field の表示順を移動する callback です。 */
  onMove: (direction: -1 | 1) => void
  /** Field definition を更新する callback です。 */
  onUpdate: (update: (field: CustomFieldDefinition) => CustomFieldDefinition) => void
}) {
  const t = createTranslator(locale)
  const validation = field.validation ?? {}
  const updateValidation = (patch: Partial<CustomFieldValidation>) => {
    onUpdate((current) => ({
      ...current,
      validation: compactValidation({ ...current.validation, ...patch }),
    }))
  }
  const supportsOptions = field.type === 'select' || field.type === 'multi-select'
  const supportsNumberValidation = field.type === 'number' || field.type === 'currency' || field.type === 'duration'
  const supportsLengthValidation = field.type === 'text' || field.type === 'multi-select'

  return (
    <article className="rounded-lg border border-[var(--workbench-border)] bg-white" data-testid={`custom-field-definition-${field.id}`}>
      <div className="grid grid-cols-[40px_minmax(180px,1fr)_minmax(150px,0.7fr)_auto] items-end gap-3 border-b border-[var(--workbench-border)] p-3 max-[760px]:grid-cols-[40px_minmax(0,1fr)_auto]">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-[var(--workbench-surface-muted)] text-xs font-bold text-[var(--workbench-muted)]">
          {index + 1}
        </span>
        <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
          {t('workItems.configuration.fieldName')}
          <input
            className="workbench-input min-h-10 min-w-0 px-3"
            required
            value={field.name}
            onChange={(event) => onUpdate((current) => ({ ...current, name: event.target.value }))}
          />
          <code className="truncate text-[11px] font-semibold text-[var(--workbench-muted)]">
            {field.id}
          </code>
        </label>
        <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)] max-[760px]:col-start-2">
          {t('workItems.configuration.fieldType')}
          <select
            className="workbench-input min-h-10 min-w-0 px-3"
            value={field.type}
            onChange={(event) => onUpdate((current) =>
              normalizeFieldForType(current, event.target.value as CustomFieldType),
            )}
          >
            {customFieldTypes.map((type) => (
              <option key={type} value={type}>{t(`workItems.fieldType.${type}`)}</option>
            ))}
          </select>
        </label>
        <div className="flex items-center justify-end gap-1 max-[760px]:row-span-2 max-[760px]:row-start-1">
          <button
            aria-label={t('workItems.configuration.moveFieldUp').replace('{field}', field.name)}
            className="workbench-button-secondary grid h-9 w-9 place-items-center disabled:cursor-not-allowed disabled:opacity-40"
            disabled={isFirst}
            onClick={() => onMove(-1)}
            type="button"
          >
            ↑
          </button>
          <button
            aria-label={t('workItems.configuration.moveFieldDown').replace('{field}', field.name)}
            className="workbench-button-secondary grid h-9 w-9 place-items-center disabled:cursor-not-allowed disabled:opacity-40"
            disabled={isLast}
            onClick={() => onMove(1)}
            type="button"
          >
            ↓
          </button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3 p-3 max-[1040px]:grid-cols-2 max-[620px]:grid-cols-1">
        <label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 text-sm font-semibold text-[var(--workbench-text)]">
          <input
            checked={field.required}
            className="h-4 w-4 accent-[var(--workbench-primary)]"
            disabled={field.type === 'formula'}
            onChange={(event) => onUpdate((current) => ({ ...current, required: event.target.checked }))}
            type="checkbox"
          />
          {t('workItems.configuration.fieldRequired')}
        </label>
        <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
          {t('workItems.configuration.fieldProjects')}
          <input
            className="workbench-input min-h-10 min-w-0 px-3"
            placeholder={t('workItems.configuration.fieldProjectsPlaceholder')}
            value={field.projectIds?.join(', ') ?? ''}
            onChange={(event) => onUpdate((current) => ({
              ...current,
              projectIds: parseCommaSeparatedValues(event.target.value),
            }))}
          />
        </label>
        {field.type === 'currency' ? (
          <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
            {t('workItems.configuration.currencyCode')}
            <input
              className="workbench-input min-h-10 min-w-0 px-3 uppercase"
              maxLength={3}
              value={field.currencyCode ?? 'USD'}
              onChange={(event) => onUpdate((current) => ({
                ...current,
                currencyCode: event.target.value.toUpperCase(),
              }))}
            />
          </label>
        ) : null}
        {field.type === 'duration' ? (
          <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
            {t('workItems.configuration.durationUnit')}
            <select
              className="workbench-input min-h-10 min-w-0 px-3"
              value={field.durationUnit ?? 'hours'}
              onChange={(event) => onUpdate((current) => ({
                ...current,
                durationUnit: event.target.value as NonNullable<CustomFieldDefinition['durationUnit']>,
              }))}
            >
              {(['minutes', 'hours', 'days'] as const).map((unit) => (
                <option key={unit} value={unit}>{t(`workItems.durationUnit.${unit}`)}</option>
              ))}
            </select>
          </label>
        ) : null}
        {field.type === 'formula' ? (
          <label className="col-span-3 grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)] max-[1040px]:col-span-2 max-[620px]:col-span-1">
            {t('workItems.configuration.formulaExpression')}
            <input
              className="workbench-input min-h-10 min-w-0 px-3 font-mono text-sm"
              placeholder="{estimate} * {rate}"
              value={field.formulaExpression ?? ''}
              onChange={(event) => onUpdate((current) => ({
                ...current,
                formulaExpression: event.target.value,
              }))}
            />
          </label>
        ) : (
          <CustomFieldDefaultControl field={field} locale={locale} onUpdate={onUpdate} />
        )}
      </div>

      {supportsOptions ? (
        <CustomFieldOptionsEditor
          field={field}
          locale={locale}
          onUpdate={onUpdate}
        />
      ) : null}

      {supportsNumberValidation || supportsLengthValidation || field.type === 'text' ? (
        <div className="grid grid-cols-5 gap-3 border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-3 max-[980px]:grid-cols-2 max-[620px]:grid-cols-1">
          {supportsNumberValidation ? (
            <>
              <ValidationNumberInput
                label={t('workItems.configuration.validationMin')}
                value={validation.min}
                onChange={(value) => updateValidation({ min: value })}
              />
              <ValidationNumberInput
                label={t('workItems.configuration.validationMax')}
                value={validation.max}
                onChange={(value) => updateValidation({ max: value })}
              />
            </>
          ) : null}
          {supportsLengthValidation ? (
            <>
              <ValidationNumberInput
                integer
                label={t('workItems.configuration.validationMinLength')}
                value={validation.minLength}
                onChange={(value) => updateValidation({ minLength: value })}
              />
              <ValidationNumberInput
                integer
                label={t('workItems.configuration.validationMaxLength')}
                value={validation.maxLength}
                onChange={(value) => updateValidation({ maxLength: value })}
              />
            </>
          ) : null}
          {field.type === 'text' ? (
            <label className="col-span-3 grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)] max-[980px]:col-span-2 max-[620px]:col-span-1">
              {t('workItems.configuration.validationPattern')}
              <input
                className="workbench-input min-h-10 min-w-0 px-3 font-mono text-sm"
                value={validation.pattern ?? ''}
                onChange={(event) => updateValidation({ pattern: event.target.value || undefined })}
              />
            </label>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

function CustomFieldOptionsEditor({
  field,
  locale,
  onUpdate,
}: {
  /** Stable option ID を保持する field definition です。 */
  field: CustomFieldDefinition
  /** 表示 locale です。 */
  locale: Locale
  /** Field definition の更新 callback です。 */
  onUpdate: (update: (field: CustomFieldDefinition) => CustomFieldDefinition) => void
}) {
  const t = createTranslator(locale)
  const options = [...(field.options ?? [])].sort(
    (first, second) => first.sortOrder - second.sortOrder || first.name.localeCompare(second.name),
  )
  const updateOptions = (
    update: (current: NonNullable<CustomFieldDefinition['options']>) =>
      NonNullable<CustomFieldDefinition['options']>,
  ) => {
    onUpdate((current) => {
      const nextOptions = update([...(current.options ?? [])]).map((option, index) => ({
        ...option,
        sortOrder: index,
      }))
      const nextOptionIds = new Set(nextOptions.map((option) => option.id))
      const filteredDefaultValues = Array.isArray(current.defaultValue)
        ? current.defaultValue.filter((optionId) => nextOptionIds.has(optionId))
        : undefined
      const nextDefaultValue = filteredDefaultValues
        ? filteredDefaultValues.length > 0 ? filteredDefaultValues : undefined
        : typeof current.defaultValue === 'string' && nextOptionIds.has(current.defaultValue)
          ? current.defaultValue
          : undefined

      return {
        ...current,
        defaultValue: nextDefaultValue,
        options: nextOptions,
      }
    })
  }
  const addOption = () => {
    updateOptions((current) => [
      ...current,
      {
        id: createPersistentOptionId(current.map((option) => option.id)),
        name: t('workItems.configuration.newOption'),
        sortOrder: current.length,
      },
    ])
  }
  const moveOption = (optionId: string, direction: -1 | 1) => {
    updateOptions((current) => {
      const sorted = [...current].sort((first, second) => first.sortOrder - second.sortOrder)
      const currentIndex = sorted.findIndex((option) => option.id === optionId)
      const targetIndex = currentIndex + direction

      if (currentIndex < 0 || targetIndex < 0 || targetIndex >= sorted.length) {
        return sorted
      }

      const [option] = sorted.splice(currentIndex, 1)
      if (option) {
        sorted.splice(targetIndex, 0, option)
      }
      return sorted
    })
  }

  return (
    <section className="grid gap-3 border-t border-[var(--workbench-border)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-[var(--workbench-text)]">
          {t('workItems.configuration.fieldOptions')}
        </h4>
        <button
          className="workbench-button-secondary min-h-9 px-3"
          onClick={addOption}
          type="button"
        >
          + {t('workItems.configuration.addOption')}
        </button>
      </div>
      <ol className="grid gap-2">
        {options.map((option, index) => (
          <li
            className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-2"
            data-testid={`custom-field-option-${field.id}-${option.id}`}
            key={option.id}
          >
            <label className="grid min-w-0 gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('workItems.configuration.optionName').replace('{index}', String(index + 1))}
              <input
                className="workbench-input min-h-9 min-w-0 px-3 text-sm text-[var(--workbench-text)]"
                required
                value={option.name}
                onChange={(event) => updateOptions((current) => current.map((candidate) =>
                  candidate.id === option.id
                    ? { ...candidate, name: event.target.value }
                    : candidate,
                ))}
              />
              <code className="truncate text-[11px] font-semibold text-[var(--workbench-muted)]">
                {option.id}
              </code>
            </label>
            <div className="flex items-center justify-end gap-1">
              <button
                aria-label={t('workItems.configuration.moveOptionUp').replace('{option}', option.name)}
                className="workbench-button-secondary grid h-9 w-9 place-items-center disabled:opacity-40"
                disabled={index === 0}
                onClick={() => moveOption(option.id, -1)}
                type="button"
              >
                ↑
              </button>
              <button
                aria-label={t('workItems.configuration.moveOptionDown').replace('{option}', option.name)}
                className="workbench-button-secondary grid h-9 w-9 place-items-center disabled:opacity-40"
                disabled={index === options.length - 1}
                onClick={() => moveOption(option.id, 1)}
                type="button"
              >
                ↓
              </button>
              <button
                aria-label={t('workItems.configuration.removeOption').replace('{option}', option.name)}
                className="workbench-button-secondary h-9 px-3 text-red-700"
                onClick={() => updateOptions((current) => current.filter(
                  (candidate) => candidate.id !== option.id,
                ))}
                type="button"
              >
                {t('workItems.configuration.remove')}
              </button>
            </div>
          </li>
        ))}
      </ol>
      {options.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--workbench-border-strong)] px-4 py-5 text-center text-sm font-medium text-[var(--workbench-muted)]">
          {t('workItems.configuration.noOptions')}
        </p>
      ) : null}
    </section>
  )
}

function CustomFieldDefaultControl({
  field,
  locale,
  onUpdate,
}: {
  /** Default value を編集する field definition です。 */
  field: CustomFieldDefinition
  /** 表示 locale です。 */
  locale: Locale
  /** Field definition を更新する callback です。 */
  onUpdate: (update: (field: CustomFieldDefinition) => CustomFieldDefinition) => void
}) {
  const t = createTranslator(locale)
  const updateDefault = (defaultValue: CustomFieldValue | undefined) => {
    onUpdate((current) => ({ ...current, defaultValue }))
  }

  if (field.type === 'boolean') {
    return (
      <label className="flex min-h-10 cursor-pointer items-center gap-3 self-end rounded-lg border border-[var(--workbench-border)] bg-white px-3 text-sm font-semibold text-[var(--workbench-text)]">
        <input
          checked={field.defaultValue === true}
          className="h-4 w-4 accent-[var(--workbench-primary)]"
          onChange={(event) => updateDefault(event.target.checked)}
          type="checkbox"
        />
        {t('workItems.configuration.defaultValue')}
      </label>
    )
  }

  if (field.type === 'select' || field.type === 'multi-select') {
    const selectedValues = Array.isArray(field.defaultValue)
      ? field.defaultValue
      : typeof field.defaultValue === 'string' ? [field.defaultValue] : []

    return (
      <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
        {t('workItems.configuration.defaultValue')}
        <select
          className="workbench-input min-h-10 min-w-0 px-3"
          multiple={field.type === 'multi-select'}
          size={field.type === 'multi-select' ? 3 : undefined}
          value={field.type === 'multi-select' ? selectedValues : selectedValues[0] ?? ''}
          onChange={(event) => {
            const nextValues = Array.from(event.target.selectedOptions).map((option) => option.value).filter(Boolean)

            updateDefault(field.type === 'multi-select' ? nextValues : nextValues[0])
          }}
        >
          {field.type === 'select' ? <option value="">—</option> : null}
          {field.options?.map((option) => (
            <option key={option.id} value={option.id}>{option.name}</option>
          ))}
        </select>
      </label>
    )
  }

  const isNumeric = field.type === 'number' || field.type === 'currency' || field.type === 'duration'

  return (
    <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
      {t('workItems.configuration.defaultValue')}
      <input
        className="workbench-input min-h-10 min-w-0 px-3"
        type={isNumeric ? 'number' : field.type === 'date' ? 'date' : 'text'}
        value={serializeDefaultValue(field.defaultValue)}
        onChange={(event) => updateDefault(parseDefaultValue(field.type, event.target.value))}
      />
    </label>
  )
}

function ValidationNumberInput({
  integer = false,
  label,
  onChange,
  value,
}: {
  /** 非負整数だけを許可するかどうかです。 */
  integer?: boolean
  /** Input label です。 */
  label: string
  /** 数値変更 callback です。 */
  onChange: (value: number | undefined) => void
  /** 現在値です。 */
  value?: number
}) {
  return (
    <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
      {label}
      <input
        className="workbench-input min-h-10 min-w-0 px-3"
        min={integer ? 0 : undefined}
        step={integer ? 1 : 'any'}
        type="number"
        value={value ?? ''}
        onChange={(event) => {
          const nextValue = event.target.value ? Number(event.target.value) : undefined

          onChange(nextValue !== undefined && Number.isFinite(nextValue) ? nextValue : undefined)
        }}
      />
    </label>
  )
}

function cloneConfiguration(configuration: WorkItemConfiguration): WorkItemConfiguration {
  return {
    ...configuration,
    workflow: {
      ...configuration.workflow,
      statuses: configuration.workflow.statuses.map((status) => ({ ...status })),
      transitions: configuration.workflow.transitions.map((transition) => ({ ...transition })),
    },
    customFields: configuration.customFields.map((field) => ({
      ...field,
      defaultValue: Array.isArray(field.defaultValue) ? [...field.defaultValue] : field.defaultValue,
      options: field.options?.map((option) => ({ ...option })),
      projectIds: field.projectIds ? [...field.projectIds] : undefined,
      validation: field.validation ? { ...field.validation } : undefined,
    })),
  }
}

function normalizeConfiguration(configuration: WorkItemConfiguration): WorkItemConfiguration {
  return {
    ...cloneConfiguration(configuration),
    workflow: {
      ...configuration.workflow,
      statuses: sortWorkflowStatuses(configuration.workflow.statuses).map((status, index) => ({
        ...status,
        name: status.name.trim(),
        sortOrder: index,
      })),
      transitions: [...configuration.workflow.transitions].sort(
        (first, second) =>
          first.fromStatusId.localeCompare(second.fromStatusId) ||
          first.toStatusId.localeCompare(second.toStatusId),
      ),
    },
    customFields: sortCustomFieldDefinitions(configuration.customFields).map((field, index) => ({
      ...field,
      name: field.name.trim(),
      options: field.options?.map((option, optionIndex) => ({
        ...option,
        name: option.name.trim(),
        sortOrder: optionIndex,
      })),
      sortOrder: index,
    })),
  }
}

function normalizeFieldForType(
  field: CustomFieldDefinition,
  type: CustomFieldType,
): CustomFieldDefinition {
  return {
    id: field.id,
    name: field.name,
    projectIds: field.projectIds,
    required: type === 'formula' ? false : field.required,
    sortOrder: field.sortOrder,
    type,
    ...(type === 'select' || type === 'multi-select'
      ? { options: field.options ?? [] }
      : {}),
    ...(type === 'currency' ? { currencyCode: field.currencyCode ?? 'USD' } : {}),
    ...(type === 'duration' ? { durationUnit: field.durationUnit ?? 'hours' } : {}),
    ...(type === 'formula' ? { formulaExpression: field.formulaExpression ?? '' } : {}),
    ...(type !== 'formula' && isCompatibleDefaultValue(type, field.defaultValue)
      ? { defaultValue: field.defaultValue }
      : {}),
    ...(supportsValidation(type) ? { validation: field.validation } : {}),
  }
}

function supportsValidation(type: CustomFieldType) {
  return type === 'text' || type === 'number' || type === 'currency' || type === 'duration' || type === 'multi-select'
}

function isCompatibleDefaultValue(
  type: CustomFieldType,
  value: CustomFieldValue | undefined,
) {
  if (value === undefined) {
    return false
  }

  if (type === 'boolean') {
    return typeof value === 'boolean'
  }
  if (type === 'number' || type === 'currency' || type === 'duration') {
    return typeof value === 'number'
  }
  if (type === 'multi-select') {
    return Array.isArray(value)
  }

  return typeof value === 'string'
}

function parseCommaSeparatedValues(value: string) {
  const values = value.split(',').map((item) => item.trim()).filter(Boolean)

  return values.length > 0 ? [...new Set(values)] : undefined
}

function parseDefaultValue(type: CustomFieldType, value: string): CustomFieldValue | undefined {
  if (!value) {
    return undefined
  }

  if (type === 'number' || type === 'currency' || type === 'duration') {
    const numericValue = Number(value)

    return Number.isFinite(numericValue) ? numericValue : undefined
  }

  return value
}

function serializeDefaultValue(value: CustomFieldValue | undefined) {
  if (value === undefined || Array.isArray(value)) {
    return ''
  }

  return String(value)
}

function compactValidation(validation: CustomFieldValidation) {
  const entries = Object.entries(validation).filter(([, value]) => value !== undefined && value !== '')

  return entries.length > 0 ? Object.fromEntries(entries) as CustomFieldValidation : undefined
}

function createUniqueDefinitionId(prefix: string, existingIds: readonly string[]) {
  const existingIdSet = new Set(existingIds)
  let index = existingIds.length + 1
  let candidate = `${prefix}-${index}`

  while (existingIdSet.has(candidate)) {
    index += 1
    candidate = `${prefix}-${index}`
  }

  return candidate
}

function createPersistentOptionId(existingIds: readonly string[]) {
  const existingIdSet = new Set(existingIds)
  let id: string

  do {
    id = `option-${crypto.randomUUID()}`
  } while (existingIdSet.has(id))

  return id
}
