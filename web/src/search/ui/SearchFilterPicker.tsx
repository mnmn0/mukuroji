import { useState } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  canAddSearchFilterId,
  filterSearchFilterOptions,
  includeSelectedSearchFilterOptions,
  type SearchFilterOption,
} from '../model/filterOptions'

/**
 * Props for a multi-select picker over one Workspace Search ID filter.
 */
export type SearchFilterPickerProps = {
  /** Visible name of the filter. */
  label: string
  /** Known options, such as visible Teams, Projects, or members. */
  options: readonly SearchFilterOption[]
  /** IDs currently in the Search filter. */
  selectedValues: readonly string[]
  /** Replaces the selected IDs of this filter. */
  onChange: (values: string[]) => void
  /** Optional note shown under the list, such as a loading or load-failure message. */
  statusMessage?: string
  /** Reloads the options after a load failure; the retry action is shown only when set. */
  onRetry?: () => void
  /** Stable test ID for the picker root. */
  testId?: string
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Renders a narrowable checkbox list so a user can filter by name without knowing IDs.
 *
 * Selected IDs that are not among the options stay listed by ID, and a typed ID that matches no
 * option can still be added, which keeps the earlier ID-based filtering available.
 *
 * @param props - Options, selection, change callback, and labels.
 * @returns The picker fieldset.
 */
export function SearchFilterPicker({
  label,
  onChange,
  onRetry,
  options,
  selectedValues,
  statusMessage,
  t,
  testId,
}: SearchFilterPickerProps) {
  const [query, setQuery] = useState('')
  const selected = new Set(selectedValues)
  const allOptions = includeSelectedSearchFilterOptions(options, selectedValues)
  const visibleOptions = filterSearchFilterOptions(allOptions, query)
  const typedId = query.trim()
  const canAddTypedId = canAddSearchFilterId(allOptions, query)

  /**
   * Toggles one ID while keeping the order in which IDs were selected.
   *
   * @param value - ID to add or remove.
   * @param checked - Whether the ID should be selected.
   */
  const toggle = (value: string, checked: boolean) => {
    const withoutValue = selectedValues.filter((selectedValue) => selectedValue !== value)
    onChange(checked ? [...withoutValue, value] : withoutValue)
  }

  return (
    <fieldset className="grid min-w-0 gap-2" data-testid={testId}>
      <legend className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
        {label}
      </legend>
      <input
        aria-label={`${label}: ${t('search.filters.pickerQuery')}`}
        className="workbench-input min-h-9 px-3 text-sm"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          // Enter that confirms an IME conversion must not add the composed text as an ID.
          if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault()
            if (canAddTypedId) {
              toggle(typedId, true)
              setQuery('')
            }
          }
        }}
        placeholder={t('search.filters.pickerQuery')}
        type="search"
        value={query}
      />
      <div className="workbench-input grid max-h-40 min-h-10 content-start gap-0.5 overflow-y-auto p-1.5">
        {visibleOptions.map((option) => (
          <label
            className="flex min-w-0 cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)]"
            key={option.value}
            title={option.value}
          >
            <input
              checked={selected.has(option.value)}
              className="h-4 w-4 shrink-0 accent-[var(--workbench-primary)]"
              onChange={(event) => toggle(option.value, event.target.checked)}
              type="checkbox"
              value={option.value}
            />
            <span className="min-w-0 truncate font-medium">{option.label}</span>
            {option.description ? (
              <span className="min-w-0 truncate text-xs text-[var(--workbench-muted)]">{option.description}</span>
            ) : null}
          </label>
        ))}
        {visibleOptions.length === 0 && !canAddTypedId ? (
          <p className="px-1.5 py-1 text-xs text-[var(--workbench-muted)]">{t('search.filters.pickerEmpty')}</p>
        ) : null}
        {canAddTypedId ? (
          <button
            className="rounded px-1.5 py-1 text-left text-sm font-medium text-[var(--workbench-primary-text)] hover:bg-[var(--workbench-surface-muted)]"
            onClick={() => {
              toggle(typedId, true)
              setQuery('')
            }}
            type="button"
          >
            {t('search.filters.pickerAddId').replace('{id}', typedId)}
          </button>
        ) : null}
      </div>
      <div className="flex min-h-5 flex-wrap items-center justify-between gap-2 text-xs text-[var(--workbench-muted)]">
        <span>
          {selected.size > 0
            ? t('search.filters.pickerSelected').replace('{count}', String(selected.size))
            : t('search.filters.pickerAll')}
          {statusMessage ? ` · ${statusMessage}` : ''}
        </span>
        {onRetry ? (
          <button
            className="font-semibold text-[var(--workbench-primary-text)] hover:underline"
            onClick={onRetry}
            type="button"
          >
            {t('search.filters.membersRetry')}
          </button>
        ) : null}
        {selected.size > 0 ? (
          <button
            className="font-semibold text-[var(--workbench-primary-text)] hover:underline"
            onClick={() => onChange([])}
            type="button"
          >
            {t('search.filters.pickerClear')}
          </button>
        ) : null}
      </div>
    </fieldset>
  )
}
