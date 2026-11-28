import {
  INVESTMENT_GROUPS,
  MAX_INVESTMENT_CATEGORY_LABEL_LENGTH,
  MAX_WORKSPACE_INVESTMENT_CATEGORIES,
  PERSON_MONTH_HOURS_RANGE,
  isBuiltInInvestmentCategory,
  type InvestmentCategoryDefinition,
  type InvestmentGroup,
  type WorkspaceInvestmentCategorySettings,
} from '@mukuroji/contracts'
import { useState } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  addInvestmentCategory,
  hasInvestmentCategoryProblem,
  investmentGroupLabelKeys,
  readInvestmentCategoryDisplayName,
} from '../model/investmentCategories'

/** Props of the investment category editor. */
export type InvestmentCategoryFieldsProps = {
  /** Settings being edited. */
  settings: WorkspaceInvestmentCategorySettings
  /** Whether the fields are read-only, for example while the tenant is closing. */
  disabled: boolean
  /** Receives the edited settings. */
  onChange: (settings: WorkspaceInvestmentCategorySettings) => void
  /** Translator for labels. */
  t: (key: MessageKey) => string
}

/**
 * Reads an accounting group from a select value.
 *
 * @param value - Select value.
 * @returns The group, defaulting to Capex.
 */
function readGroup(value: string): InvestmentGroup {
  return INVESTMENT_GROUPS.find((group) => group === value) ?? 'capex'
}

/**
 * Edits the Workspace investment categories (ADR 0116): their names, Capex or Opex group, whether
 * they are in use, and the hours of a person-month. A category is retired rather than removed, so
 * Projects and Work Items that use it keep its name.
 *
 * @param props - Settings draft, lock state, change callback, and translator.
 * @returns The category list, the field that adds a category, and the person-month hours.
 */
export function InvestmentCategoryFields({ settings, disabled, onChange, t }: InvestmentCategoryFieldsProps) {
  const [newLabel, setNewLabel] = useState('')
  const [newGroup, setNewGroup] = useState<InvestmentGroup>('capex')
  const problem = hasInvestmentCategoryProblem(settings)
  const isFull = settings.categories.length >= MAX_WORKSPACE_INVESTMENT_CATEGORIES

  /**
   * Replaces one category in the draft.
   *
   * @param index - Position of the category.
   * @param category - Edited category.
   */
  const update = (index: number, category: InvestmentCategoryDefinition) => {
    onChange({ ...settings, categories: settings.categories.map((current, position) => position === index ? category : current) })
  }

  /**
   * Changes a category name. A built-in category with no name goes back to its translated name.
   *
   * @param index - Position of the category.
   * @param category - Category being renamed.
   * @param label - Typed name.
   */
  const rename = (index: number, category: InvestmentCategoryDefinition, label: string) => {
    const rest: InvestmentCategoryDefinition = { key: category.key, group: category.group, active: category.active }
    update(index, label.trim() === '' && isBuiltInInvestmentCategory(category.key) ? rest : { ...rest, label })
  }

  /** Adds the typed category and clears the field. */
  const add = () => {
    const next = addInvestmentCategory(settings, newLabel, newGroup)
    if (next === settings) return
    onChange(next)
    setNewLabel('')
  }

  return (
    <fieldset className="mt-5 grid gap-3" data-testid="tenant-investment-categories">
      <legend className="text-sm font-semibold text-[var(--workbench-text)]">
        {t('workspace.tenantAdministration.investmentCategories.title')}
      </legend>
      <p className="text-xs text-[var(--workbench-muted)]">
        {t('workspace.tenantAdministration.investmentCategories.hint')}
      </p>
      <ol className="grid gap-2">
        {settings.categories.map((category, index) => {
          const builtInLabel = isBuiltInInvestmentCategory(category.key)
            ? readInvestmentCategoryDisplayName(category.key, undefined, t)
            : undefined
          const name = category.label || builtInLabel || category.key
          return (
            <li className="flex min-w-0 flex-wrap items-center gap-2" data-testid="tenant-investment-category" key={category.key}>
              <input
                aria-label={`${t('workspace.tenantAdministration.investmentCategories.name')} ${name}`}
                className="workbench-input h-9 min-w-0 flex-1 basis-40 px-3"
                disabled={disabled}
                maxLength={MAX_INVESTMENT_CATEGORY_LABEL_LENGTH}
                onChange={(event) => rename(index, category, event.target.value)}
                placeholder={builtInLabel}
                value={category.label ?? ''}
              />
              <select
                aria-label={`${t('workspace.tenantAdministration.investmentCategories.group')} ${name}`}
                className="workbench-input h-9 min-w-0 px-2"
                disabled={disabled}
                onChange={(event) => update(index, { ...category, group: readGroup(event.target.value) })}
                value={category.group}
              >
                {INVESTMENT_GROUPS.map((group) => (
                  <option key={group} value={group}>{t(investmentGroupLabelKeys[group])}</option>
                ))}
              </select>
              <label className="inline-flex items-center gap-1.5 text-sm text-[var(--workbench-text)]">
                <input
                  checked={category.active}
                  disabled={disabled}
                  onChange={(event) => update(index, { ...category, active: event.target.checked })}
                  type="checkbox"
                />
                {t('workspace.tenantAdministration.investmentCategories.active')}
              </label>
            </li>
          )
        })}
      </ol>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input
          aria-label={t('workspace.tenantAdministration.investmentCategories.newName')}
          className="workbench-input h-9 min-w-0 flex-1 basis-40 px-3"
          disabled={disabled || isFull}
          maxLength={MAX_INVESTMENT_CATEGORY_LABEL_LENGTH}
          onChange={(event) => setNewLabel(event.target.value)}
          onKeyDown={(event) => {
            // Enter that confirms an IME conversion does not add the category.
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              add()
            }
          }}
          placeholder={t('workspace.tenantAdministration.investmentCategories.newName')}
          value={newLabel}
        />
        <select
          aria-label={t('workspace.tenantAdministration.investmentCategories.newGroup')}
          className="workbench-input h-9 min-w-0 px-2"
          disabled={disabled || isFull}
          onChange={(event) => setNewGroup(readGroup(event.target.value))}
          value={newGroup}
        >
          {INVESTMENT_GROUPS.map((group) => (
            <option key={group} value={group}>{t(investmentGroupLabelKeys[group])}</option>
          ))}
        </select>
        <button
          className="workbench-button-secondary min-h-9 px-3"
          disabled={disabled || isFull || newLabel.trim() === ''}
          onClick={add}
          type="button"
        >
          {t('workspace.tenantAdministration.investmentCategories.add')}
        </button>
      </div>
      <label className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-[var(--workbench-text)]">
        {t('workspace.tenantAdministration.investmentCategories.personMonthHours')}
        <input
          className="workbench-input h-9 w-24 px-3"
          disabled={disabled}
          max={PERSON_MONTH_HOURS_RANGE.max}
          min={PERSON_MONTH_HOURS_RANGE.min}
          onChange={(event) => onChange({ ...settings, personMonthHours: Number(event.target.value) })}
          step={1}
          type="number"
          value={Number.isFinite(settings.personMonthHours) ? settings.personMonthHours : ''}
        />
      </label>
      {problem ? (
        <p className="text-xs text-fg-red-700" role="alert">
          {t('workspace.tenantAdministration.investmentCategories.invalid')}
        </p>
      ) : null}
    </fieldset>
  )
}
