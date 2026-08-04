import type {
  CustomFieldDefinition,
  CustomFieldValue,
  WorkItemConfiguration,
  WorkItemPatch,
} from '@mukuroji/contracts'
import type { ProjectTask } from '../api/tasks'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import type { WorkItemPersonOption } from '../../work-items/ui/WorkItemFieldsEditor'
import {
  formatCustomFieldValue,
  isCustomFieldApplicable,
  sortCustomFieldDefinitions,
} from '../../work-items/model/customFields'
import { TaskInlineField } from './TaskInlineField'

/** Props accepted by the compact inline custom-field editor. */
export type TaskInlineCustomFieldsProps = {
  /** Work Item configuration containing the applicable definitions. */
  configuration?: WorkItemConfiguration
  /** Locale used when formatting typed field values. */
  locale: Locale
  /** Person IDs mapped to display names. */
  personLabels: Readonly<Record<string, string>>
  /** Person options available to person custom fields. */
  personOptions: readonly WorkItemPersonOption[]
  /** Translator used for typed value labels. */
  t: (key: MessageKey) => string
  /** Work Item whose custom fields are being edited. */
  task: ProjectTask
  /** Shared optimistic mutation callback. */
  onUpdateTask: (task: ProjectTask, input: WorkItemPatch) => Promise<ProjectTask>
}

/**
 * Renders applicable custom fields as compact inline editors.
 *
 * Formula fields stay read-only because their values are derived by the server.
 *
 * @param props - Configuration, Work Item values, and mutation callbacks.
 * @returns Compact custom-field controls, or null when no fields apply.
 */
export function TaskInlineCustomFields({
  configuration,
  locale,
  onUpdateTask,
  personLabels,
  personOptions,
  t,
  task,
}: TaskInlineCustomFieldsProps) {
  const definitions = configuration?.customFields.filter((definition) =>
    isCustomFieldApplicable(definition, task.assignedProjectId),
  ) ?? []

  if (definitions.length === 0) {
    return null
  }

  return (
    <div className="mt-2 grid min-w-0 gap-1.5" data-testid={`task-inline-custom-fields-${task.id}`}>
      {sortCustomFieldDefinitions(definitions).map((definition) => {
        const value = task.customFieldValues[definition.id]
        const displayValue = formatInlineCustomFieldValue(
          definition,
          value,
          locale,
          personLabels,
          t,
        )

        if (definition.type === 'formula') {
          return (
            <span
              className="max-w-full truncate px-1.5 py-0.5 text-xs font-medium text-[var(--workbench-muted)]"
              key={definition.id}
              title={`${definition.name}: ${displayValue}`}
            >
              {definition.name}: {displayValue}
            </span>
          )
        }

        const options = resolveInlineCustomFieldOptions(
          definition,
          value,
          personLabels,
          personOptions,
          t,
        )
        const isSelect = options.length > 0

        return (
          <div className="flex min-w-0 items-center gap-1.5" key={definition.id}>
            <span className="max-w-[9rem] truncate text-[11px] font-semibold text-[var(--workbench-muted)]">
              {definition.name}:
            </span>
            <TaskInlineField
              ariaLabel={`${t('tasks.inline.customFields')}: ${definition.name}`}
              displayValue={displayValue}
              fieldKey={`customField:${definition.id}`}
              kind={isSelect ? 'select' : definition.type === 'date' ? 'date' : 'text'}
              options={options}
              testId={`task-inline-custom-field-${task.id}-${definition.id}`}
              value={resolveInlineCustomFieldInputValue(definition, value)}
              onCommit={(nextValue) => onUpdateTask(task, {
                customFieldValues: {
                  [definition.id]: parseInlineCustomFieldValue(definition, nextValue),
                },
              }).then(() => undefined)}
            />
          </div>
        )
      })}
    </div>
  )
}

/** Formats a typed custom-field value for a compact task-view trigger. */
function formatInlineCustomFieldValue(
  definition: CustomFieldDefinition,
  value: CustomFieldValue | undefined,
  locale: Locale,
  personLabels: Readonly<Record<string, string>>,
  t: (key: MessageKey) => string,
) {
  return formatCustomFieldValue(definition, value, {
    durationUnitLabels: {
      days: t('workItems.durationUnit.days'),
      hours: t('workItems.durationUnit.hours'),
      minutes: t('workItems.durationUnit.minutes'),
    },
    emptyLabel: t('tasks.calendar.empty'),
    falseLabel: t('workItems.fields.booleanFalse'),
    locale,
    personLabels,
    trueLabel: t('workItems.fields.booleanTrue'),
  })
}

/** Returns select options for select, boolean, and person custom fields. */
function resolveInlineCustomFieldOptions(
  definition: CustomFieldDefinition,
  value: CustomFieldValue | undefined,
  personLabels: Readonly<Record<string, string>>,
  personOptions: readonly WorkItemPersonOption[],
  t: (key: MessageKey) => string,
) {
  if (definition.type === 'boolean') {
    return [
      { label: t('workItems.fields.booleanTrue'), value: 'true' },
      { label: t('workItems.fields.booleanFalse'), value: 'false' },
    ]
  }

  if (definition.type === 'select') {
    const options = [...(definition.options ?? [])]
      .sort((first, second) => first.sortOrder - second.sortOrder || first.name.localeCompare(second.name))
      .map((option) => ({ label: option.name, value: option.id }))

    return [
      { label: t('workItems.fields.selectPlaceholder'), value: '' },
      ...options,
    ]
  }

  if (definition.type === 'person') {
    const selectedPersonId = typeof value === 'string' ? value : ''
    const selectedPerson = selectedPersonId && !personOptions.some((person) => person.id === selectedPersonId)
      ? [{
          label: personLabels[selectedPersonId] ?? selectedPersonId,
          value: selectedPersonId,
        }]
      : []

    return [
      ...(selectedPersonId ? [] : [{ label: t('workItems.fields.personPlaceholder'), value: '' }]),
      ...selectedPerson,
      ...personOptions.map((person) => ({
        label: person.email && person.email !== person.name
          ? `${person.name} (${person.email})`
          : person.name,
        value: person.id,
      })),
    ]
  }

  return []
}

/** Converts a typed value to the string consumed by the shared inline control. */
function resolveInlineCustomFieldInputValue(
  definition: CustomFieldDefinition,
  value: CustomFieldValue | undefined,
) {
  if (Array.isArray(value)) {
    return value.join(', ')
  }

  if (definition.type === 'boolean') {
    return value === true ? 'true' : 'false'
  }

  return value === undefined ? '' : String(value)
}

/** Parses an inline string back into the custom-field value expected by the API. */
function parseInlineCustomFieldValue(
  definition: CustomFieldDefinition,
  value: string,
): CustomFieldValue | null {
  const trimmedValue = value.trim()

  if (!trimmedValue && definition.type !== 'boolean') {
    return null
  }

  if (definition.type === 'boolean') {
    return value === 'true'
  }

  if (
    definition.type === 'number' ||
    definition.type === 'currency' ||
    definition.type === 'duration'
  ) {
    const numberValue = Number(trimmedValue)
    return Number.isFinite(numberValue) ? numberValue : null
  }

  if (definition.type === 'multi-select') {
    const values = trimmedValue
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)

    return values.length > 0 ? [...new Set(values)] : null
  }

  return trimmedValue
}
