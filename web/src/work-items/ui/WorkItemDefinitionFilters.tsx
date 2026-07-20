import type {
  CustomFieldDefinition,
  CustomFieldValue,
  WorkflowStatusCategory,
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import { useMemo } from 'react'
import {
  createTranslator,
  type Locale,
} from '../../shared/i18n/i18n'
import {
  sortCustomFieldDefinitions,
} from '../model/customFields'
import type { WorkItemPersonOption } from './WorkItemFieldsEditor'
import type { WorkItemDefinitionFilter } from '../model/workItemFilters'

/**
 * WorkItemDefinitionFilters が受け取る props です。
 */
export type WorkItemDefinitionFiltersProps = {
  /** Filter 対象 Work Item に適用される configuration です。 */
  configuration?: WorkItemConfiguration
  /** 同一画面上の control ID を衝突させない接頭辞です。 */
  idPrefix: string
  /** 表示 locale です。 */
  locale: Locale
  /** Person field で選択できる Workspace member です。 */
  personOptions?: readonly WorkItemPersonOption[]
  /** 現在の filter 値です。 */
  value: WorkItemDefinitionFilter
  /** Filter 値を変更する callback です。 */
  onChange: (value: WorkItemDefinitionFilter) => void
}

const workflowStatusCategories = [
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
] as const satisfies readonly WorkflowStatusCategory[]

/**
 * Workflow category と型付き custom field value の一覧 filter controls を描画します。
 */
export function WorkItemDefinitionFilters({
  configuration,
  idPrefix,
  locale,
  onChange,
  personOptions = [],
  value,
}: WorkItemDefinitionFiltersProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const definitions = useMemo(
    () => sortCustomFieldDefinitions(configuration?.customFields ?? []),
    [configuration?.customFields],
  )
  const selectedDefinition = definitions.find(
    (definition) => definition.id === value.customFieldId,
  )
  const fieldId = `${idPrefix}-custom-field-filter`
  const valueId = `${idPrefix}-custom-field-value-filter`

  return (
    <div
      className="flex min-w-0 flex-wrap items-end gap-2"
      data-testid={`${idPrefix}-definition-filters`}
    >
      <label className="grid min-w-[150px] gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
        {t('workItems.filter.category')}
        <select
          className="workbench-input h-9 min-w-0 px-3 text-sm text-[var(--workbench-text)]"
          data-testid={`${idPrefix}-category-filter`}
          value={value.category}
          onChange={(event) => onChange({
            ...value,
            category: event.target.value as WorkItemDefinitionFilter['category'],
          })}
        >
          <option value="all">{t('workItems.filter.categoryAll')}</option>
          {workflowStatusCategories.map((category) => (
            <option key={category} value={category}>
              {t(`workItems.statusCategory.${category}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="grid min-w-[170px] gap-1 text-xs font-semibold text-[var(--workbench-muted)]" htmlFor={fieldId}>
        {t('workItems.filter.customField')}
        <select
          className="workbench-input h-9 min-w-0 px-3 text-sm text-[var(--workbench-text)]"
          data-testid={`${idPrefix}-custom-field-filter`}
          id={fieldId}
          value={value.customFieldId}
          onChange={(event) => onChange({
            ...value,
            customFieldId: event.target.value,
            customFieldValue: undefined,
          })}
        >
          <option value="">{t('workItems.filter.customFieldAll')}</option>
          {definitions.map((definition) => (
            <option key={definition.id} value={definition.id}>{definition.name}</option>
          ))}
        </select>
      </label>
      {selectedDefinition ? (
        <CustomFieldFilterValueControl
          definition={selectedDefinition}
          inputId={valueId}
          locale={locale}
          personOptions={personOptions}
          value={value.customFieldValue}
          onChange={(customFieldValue) => onChange({ ...value, customFieldValue })}
        />
      ) : null}
    </div>
  )
}

function CustomFieldFilterValueControl({
  definition,
  inputId,
  locale,
  onChange,
  personOptions,
  value,
}: {
  /** Filter 対象 definition です。 */
  definition: CustomFieldDefinition
  /** Label と control を結び付ける DOM ID です。 */
  inputId: string
  /** 表示 locale です。 */
  locale: Locale
  /** Typed value の変更 callback です。 */
  onChange: (value: CustomFieldValue | undefined) => void
  /** Person field の候補です。 */
  personOptions: readonly WorkItemPersonOption[]
  /** 現在の typed filter value です。 */
  value?: CustomFieldValue
}) {
  const t = createTranslator(locale)
  const label = t('workItems.filter.value').replace('{field}', definition.name)
  const inputClassName = 'workbench-input h-9 min-w-0 px-3 text-sm text-[var(--workbench-text)]'

  if (definition.type === 'boolean') {
    return (
      <label className="grid min-w-[150px] gap-1 text-xs font-semibold text-[var(--workbench-muted)]" htmlFor={inputId}>
        {label}
        <select
          className={inputClassName}
          id={inputId}
          value={typeof value === 'boolean' ? String(value) : ''}
          onChange={(event) => onChange(
            event.target.value === '' ? undefined : event.target.value === 'true',
          )}
        >
          <option value="">{t('workItems.filter.valueAll')}</option>
          <option value="true">{t('workItems.fields.booleanTrue')}</option>
          <option value="false">{t('workItems.fields.booleanFalse')}</option>
        </select>
      </label>
    )
  }

  if (definition.type === 'select') {
    return (
      <label className="grid min-w-[170px] gap-1 text-xs font-semibold text-[var(--workbench-muted)]" htmlFor={inputId}>
        {label}
        <select
          className={inputClassName}
          id={inputId}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value || undefined)}
        >
          <option value="">{t('workItems.filter.valueAll')}</option>
          {definition.options?.map((option) => (
            <option key={option.id} value={option.id}>{option.name}</option>
          ))}
        </select>
      </label>
    )
  }

  if (definition.type === 'multi-select') {
    const selectedValues = Array.isArray(value) ? value : []

    return (
      <div className="flex min-w-[190px] items-end gap-2">
        <label className="grid min-w-0 flex-1 gap-1 text-xs font-semibold text-[var(--workbench-muted)]" htmlFor={inputId}>
          {label}
          <select
            className={`${inputClassName} h-auto min-h-9 py-1`}
            id={inputId}
            multiple
            size={Math.min(4, Math.max(2, definition.options?.length ?? 0))}
            value={selectedValues}
            onChange={(event) => {
              const values = Array.from(event.target.selectedOptions).map((option) => option.value)

              onChange(values.length > 0 ? values : undefined)
            }}
          >
            {definition.options?.map((option) => (
              <option key={option.id} value={option.id}>{option.name}</option>
            ))}
          </select>
        </label>
        <button
          className="workbench-button-secondary h-9 px-3 disabled:opacity-50"
          disabled={selectedValues.length === 0}
          onClick={() => onChange(undefined)}
          type="button"
        >
          {t('workItems.filter.clearValue')}
        </button>
      </div>
    )
  }

  if (definition.type === 'person') {
    const selectedValue = typeof value === 'string' ? value : ''
    const hasSelectedOption = personOptions.some((person) => person.id === selectedValue)

    return (
      <label className="grid min-w-[190px] gap-1 text-xs font-semibold text-[var(--workbench-muted)]" htmlFor={inputId}>
        {label}
        <select
          className={inputClassName}
          id={inputId}
          value={selectedValue}
          onChange={(event) => onChange(event.target.value || undefined)}
        >
          <option value="">{t('workItems.filter.valueAll')}</option>
          {selectedValue && !hasSelectedOption ? (
            <option value={selectedValue}>{selectedValue}</option>
          ) : null}
          {personOptions.map((person) => (
            <option key={person.id} value={person.id}>
              {person.email && person.email !== person.name
                ? `${person.name} (${person.email})`
                : person.name}
            </option>
          ))}
        </select>
      </label>
    )
  }

  const isNumeric =
    definition.type === 'number' ||
    definition.type === 'currency' ||
    definition.type === 'duration' ||
    definition.type === 'formula'
  const inputValue = isNumeric
    ? typeof value === 'number' ? String(value) : ''
    : typeof value === 'string' ? value : ''

  return (
    <label className="grid min-w-[180px] gap-1 text-xs font-semibold text-[var(--workbench-muted)]" htmlFor={inputId}>
      {label}
      <input
        className={inputClassName}
        id={inputId}
        placeholder={t('workItems.filter.valuePlaceholder')}
        type={isNumeric ? 'number' : definition.type === 'date' ? 'date' : 'search'}
        value={inputValue}
        onChange={(event) => {
          if (!event.target.value) {
            onChange(undefined)
            return
          }

          if (isNumeric) {
            const numericValue = Number(event.target.value)

            onChange(Number.isFinite(numericValue) ? numericValue : undefined)
            return
          }

          onChange(event.target.value)
        }}
      />
    </label>
  )
}
