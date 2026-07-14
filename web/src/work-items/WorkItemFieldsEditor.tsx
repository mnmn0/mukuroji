import type {
  CustomFieldDefinition,
  CustomFieldValue,
} from '@mukuroji/contracts'
import { useMemo } from 'react'
import {
  createTranslator,
  type Locale,
} from '../i18n'
import {
  createCustomFieldFormName,
  formatCustomFieldValue,
  isCustomFieldApplicable,
  sortCustomFieldDefinitions,
} from './customFields'

/**
 * Person custom field で選択できる Workspace member です。
 */
export type WorkItemPersonOption = {
  /**
   * Custom field value として保存する member key です。
   */
  id: string
  /**
   * Select に表示する member 名です。
   */
  name: string
  /**
   * 同名 member を識別するために併記するメールアドレスです。
   */
  email?: string
}

/**
 * WorkItemFieldsEditor が受け取る props です。
 */
export type WorkItemFieldsEditorProps = {
  /**
   * 表示 locale です。
   */
  locale: Locale
  /**
   * 解決済み custom field definition 一覧です。
   */
  definitions: readonly CustomFieldDefinition[]
  /**
   * Field ID ごとの現在 value です。
   */
  values?: Readonly<Record<string, CustomFieldValue>>
  /**
   * Project scope の適用可否を判定する Project ID です。
   */
  projectId?: string
  /**
   * Person field の選択候補です。
   */
  personOptions?: readonly WorkItemPersonOption[]
  /**
   * API または client validation の field 別表示メッセージです。
   */
  errors?: Readonly<Record<string, string | undefined>>
  /**
   * 全 control を無効化するかどうかです。
   */
  disabled?: boolean
  /**
   * Formula 以外も参照専用表示にするかどうかです。
   */
  readOnly?: boolean
  /**
   * Fieldset を識別する任意の test ID です。
   */
  testId?: string
}

/**
 * Work Item detail/create form に全 custom field type を描画します。
 *
 * Formula は常に read-only で、保存対象の FormData には含めません。
 */
export function WorkItemFieldsEditor({
  definitions,
  disabled = false,
  errors = {},
  locale,
  personOptions = [],
  projectId,
  readOnly = false,
  testId = 'work-item-fields-editor',
  values = {},
}: WorkItemFieldsEditorProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const applicableDefinitions = sortCustomFieldDefinitions(definitions).filter((definition) =>
    isCustomFieldApplicable(definition, projectId),
  )

  return (
    <fieldset
      className="grid min-w-0 gap-4"
      data-testid={testId}
      disabled={disabled || readOnly}
    >
      <legend className="sr-only">{t('workItems.fields.title')}</legend>
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-[var(--workbench-text)]">
            {t('workItems.fields.title')}
          </h3>
          <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
            {t('workItems.fields.description')}
          </p>
        </div>
        <span className="workbench-badge flex-none">
          {applicableDefinitions.length}
        </span>
      </div>

      {applicableDefinitions.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--workbench-border-strong)] bg-white px-4 py-6 text-center text-sm font-medium text-[var(--workbench-muted)]">
          {t('workItems.fields.empty')}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
          {applicableDefinitions.map((definition) => (
            <CustomFieldControl
              definition={definition}
              errorMessage={errors[definition.id]}
              key={definition.id}
              locale={locale}
              personOptions={personOptions}
              value={values[definition.id]}
            />
          ))}
        </div>
      )}
    </fieldset>
  )
}

function CustomFieldControl({
  definition,
  errorMessage,
  locale,
  personOptions,
  value,
}: {
  /** Field control の definition です。 */
  definition: CustomFieldDefinition
  /** Field 下部へ表示する validation message です。 */
  errorMessage?: string
  /** 表示 locale です。 */
  locale: Locale
  /** Person field の選択候補です。 */
  personOptions: readonly WorkItemPersonOption[]
  /** Field の現在 value です。 */
  value?: CustomFieldValue
}) {
  const t = createTranslator(locale)
  const inputId = `work-item-field-${toDomToken(definition.id)}`
  const errorId = `${inputId}-error`
  const descriptionId = `${inputId}-description`
  const name = createCustomFieldFormName(definition.id)
  const describedBy = [
    definition.type === 'currency' || definition.type === 'duration' ? descriptionId : undefined,
    errorMessage ? errorId : undefined,
  ].filter(Boolean).join(' ') || undefined
  const wide = definition.type === 'text' || definition.type === 'formula' || definition.type === 'multi-select'

  return (
    <div
      className={`workbench-panel-muted grid min-w-0 gap-2 p-3 ${wide ? 'col-span-2 max-[720px]:col-span-1' : ''}`}
      data-field-id={definition.id}
      data-field-type={definition.type}
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <label className="min-w-0 truncate text-sm font-semibold text-[var(--workbench-text)]" htmlFor={inputId}>
          {definition.name}
        </label>
        <div className="flex flex-none items-center gap-2">
          {definition.required && definition.type !== 'formula' ? (
            <span className="workbench-badge-danger">{t('workItems.fields.required')}</span>
          ) : null}
          <span className="workbench-badge">{t(`workItems.fieldType.${definition.type}`)}</span>
        </div>
      </div>

      <CustomFieldInput
        describedBy={describedBy}
        definition={definition}
        inputId={inputId}
        locale={locale}
        name={name}
        personOptions={personOptions}
        value={value}
      />

      {definition.type === 'currency' ? (
        <p className="text-xs font-medium text-[var(--workbench-muted)]" id={descriptionId}>
          {definition.currencyCode ?? 'USD'}
        </p>
      ) : null}
      {definition.type === 'duration' ? (
        <p className="text-xs font-medium text-[var(--workbench-muted)]" id={descriptionId}>
          {t(`workItems.durationUnit.${definition.durationUnit ?? 'hours'}`)}
        </p>
      ) : null}
      {errorMessage ? (
        <p className="text-xs font-semibold text-red-700" id={errorId} role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  )
}

function CustomFieldInput({
  describedBy,
  definition,
  inputId,
  locale,
  name,
  personOptions,
  value,
}: {
  /** Input の aria-describedby です。 */
  describedBy?: string
  /** Field control の definition です。 */
  definition: CustomFieldDefinition
  /** Label と input を結び付ける DOM ID です。 */
  inputId: string
  /** 表示 locale です。 */
  locale: Locale
  /** FormData parse helper と共有する input name です。 */
  name: string
  /** Person field の選択候補です。 */
  personOptions: readonly WorkItemPersonOption[]
  /** Field の現在 value です。 */
  value?: CustomFieldValue
}) {
  const t = createTranslator(locale)
  const commonInputProps = {
    'aria-describedby': describedBy,
    className: 'workbench-input min-h-10 w-full min-w-0 px-3 disabled:cursor-not-allowed disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]',
    id: inputId,
    name,
    required: definition.required,
  }

  if (definition.type === 'formula') {
    return (
      <output
        aria-live="polite"
        aria-readonly="true"
        className="min-h-10 rounded-lg border border-[var(--workbench-border)] bg-white px-3 py-2 text-sm font-semibold text-[var(--workbench-text)]"
        id={inputId}
      >
        {formatCustomFieldValue(definition, value, {
          emptyLabel: t('workItems.fields.formulaPending'),
          locale,
        })}
      </output>
    )
  }

  if (definition.type === 'boolean') {
    return (
      <label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg border border-[var(--workbench-border-strong)] bg-white px-3 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={inputId}>
        <input name={name} type="hidden" value="false" />
        <input
          aria-describedby={describedBy}
          className="h-4 w-4 accent-[var(--workbench-primary)]"
          defaultChecked={value === true}
          id={inputId}
          name={name}
          type="checkbox"
          value="true"
        />
        {t('workItems.fields.booleanLabel')}
      </label>
    )
  }

  if (definition.type === 'select' || definition.type === 'multi-select') {
    const options = [...(definition.options ?? [])].sort(
      (first, second) => first.sortOrder - second.sortOrder || first.name.localeCompare(second.name),
    )
    const selectedValue = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []

    return (
      <select
        {...commonInputProps}
        defaultValue={definition.type === 'multi-select' ? selectedValue : selectedValue[0] ?? ''}
        multiple={definition.type === 'multi-select'}
        size={definition.type === 'multi-select' ? Math.min(5, Math.max(2, options.length)) : undefined}
      >
        {definition.type === 'select' ? (
          <option value="">{t('workItems.fields.selectPlaceholder')}</option>
        ) : null}
        {options.map((option) => (
          <option key={option.id} value={option.id}>{option.name}</option>
        ))}
      </select>
    )
  }

  if (definition.type === 'person') {
    const selectedValue = typeof value === 'string' ? value : ''
    const hasSelectedOption = personOptions.some((person) => person.id === selectedValue)

    return (
      <select {...commonInputProps} defaultValue={selectedValue}>
        <option value="">{t('workItems.fields.personPlaceholder')}</option>
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
    )
  }

  if (
    definition.type === 'number' ||
    definition.type === 'currency' ||
    definition.type === 'duration'
  ) {
    return (
      <input
        {...commonInputProps}
        defaultValue={typeof value === 'number' ? String(value) : ''}
        max={definition.validation?.max}
        min={definition.validation?.min}
        step="any"
        type="number"
      />
    )
  }

  if (definition.type === 'date') {
    return (
      <input
        {...commonInputProps}
        defaultValue={typeof value === 'string' ? value : ''}
        type="date"
      />
    )
  }

  return (
    <input
      {...commonInputProps}
      defaultValue={typeof value === 'string' ? value : ''}
      maxLength={definition.validation?.maxLength}
      minLength={definition.validation?.minLength}
      pattern={definition.validation?.pattern}
      type="text"
    />
  )
}

function toDomToken(value: string) {
  return value.replaceAll(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'field'
}
