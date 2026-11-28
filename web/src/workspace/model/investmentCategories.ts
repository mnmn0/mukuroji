import {
  INVESTMENT_GROUPS,
  MAX_WORKSPACE_INVESTMENT_CATEGORIES,
  UNCLASSIFIED_INVESTMENT_GROUP_KEY,
  isBuiltInInvestmentCategory,
  readInvestmentGroup,
  readWorkspaceInvestmentCategorySettings,
  type BuiltInInvestmentCategory,
  type InvestmentCategoryDefinition,
  type InvestmentGroup,
  type WorkspaceInvestmentCategorySettings,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Translated name of each built-in investment category. */
const builtInLabelKeys = {
  'new-development': 'workspace.investmentCategory.newDevelopment',
  enhancement: 'workspace.investmentCategory.enhancement',
  maintenance: 'workspace.investmentCategory.maintenance',
  operations: 'workspace.investmentCategory.operations',
  management: 'workspace.investmentCategory.management',
} as const satisfies Record<BuiltInInvestmentCategory, MessageKey>

/** Translated name of each accounting group. */
export const investmentGroupLabelKeys = {
  capex: 'workspace.investmentGroup.capex',
  opex: 'workspace.investmentGroup.opex',
} as const satisfies Record<InvestmentGroup, MessageKey>

/**
 * Returns the display name of an investment category (ADR 0116).
 *
 * @param key - Category key, or `unclassified`.
 * @param settings - Workspace categories, when loaded.
 * @param t - Translator.
 * @returns The Workspace name, the translated built-in name, or the key.
 */
export function readInvestmentCategoryDisplayName(
  key: string,
  settings: WorkspaceInvestmentCategorySettings | undefined,
  t: (key: MessageKey) => string,
): string {
  if (key === UNCLASSIFIED_INVESTMENT_GROUP_KEY) return t('workspace.investmentCategory.unclassified')
  const label = settings?.categories.find((category) => category.key === key)?.label
  if (label) return label
  return isBuiltInInvestmentCategory(key) ? t(builtInLabelKeys[key]) : key
}

/**
 * Reports whether edited investment categories would be refused by the server.
 *
 * @param settings - Edited settings.
 * @returns True when the settings cannot be saved.
 */
export function hasInvestmentCategoryProblem(settings: WorkspaceInvestmentCategorySettings): boolean {
  return readWorkspaceInvestmentCategorySettings(settings) === undefined
}

/**
 * Adds a Workspace investment category with a generated key.
 *
 * @param settings - Edited settings.
 * @param label - Typed name.
 * @param group - Accounting group of the new category.
 * @param createKeySuffix - Creates the random part of the key.
 * @returns Settings with the category added, or the same settings when the name is empty or the list is full.
 */
export function addInvestmentCategory(
  settings: WorkspaceInvestmentCategorySettings,
  label: string,
  group: InvestmentGroup,
  createKeySuffix: () => string = () => crypto.randomUUID().replaceAll('-', '').slice(0, 12),
): WorkspaceInvestmentCategorySettings {
  const name = label.trim()
  if (name.length === 0 || settings.categories.length >= MAX_WORKSPACE_INVESTMENT_CATEGORIES) return settings
  const category: InvestmentCategoryDefinition = { key: `custom-${createKeySuffix()}`, label: name, group, active: true }
  return { ...settings, categories: [...settings.categories, category] }
}

/** Minutes, person-months, and share of one investment category or group in a report. */
export type InvestmentReportRow = {
  /** Category key, `unclassified`, or an accounting group. */
  key: string
  /** Minutes in the period. */
  minutes: number
  /** Minutes divided by the Workspace person-month hours. */
  personMonths: number
  /** Share of the report total, 0 to 100. */
  sharePercent: number
}

/**
 * Totals report groups by accounting group, so Capex and Opex can be compared beside the categories.
 * Unclassified time and categories the settings do not know are left out of both groups.
 *
 * @param groups - Report groups keyed by category.
 * @param settings - Workspace categories.
 * @param totalMinutes - Report total, the base of the share.
 * @returns One row per accounting group, in display order.
 */
export function summarizeInvestmentGroups(
  groups: readonly { key: string; minutes: number }[],
  settings: WorkspaceInvestmentCategorySettings,
  totalMinutes: number,
): InvestmentReportRow[] {
  return INVESTMENT_GROUPS.map((group) => {
    const minutes = groups
      .filter((row) => readInvestmentGroup(settings, row.key) === group)
      .reduce((sum, row) => sum + row.minutes, 0)
    return { key: group, minutes, ...measureInvestmentTime(minutes, settings, totalMinutes) }
  })
}

/**
 * Converts minutes to person-months and a share of the report.
 *
 * @param minutes - Minutes of a row.
 * @param settings - Workspace categories with the person-month hours.
 * @param totalMinutes - Report total.
 * @returns Person-months rounded to two decimals and the share rounded to one decimal.
 */
export function measureInvestmentTime(
  minutes: number,
  settings: WorkspaceInvestmentCategorySettings,
  totalMinutes: number,
): { personMonths: number; sharePercent: number } {
  return {
    personMonths: Math.round((minutes / 60 / settings.personMonthHours) * 100) / 100,
    sharePercent: totalMinutes > 0 ? Math.round((minutes / totalMinutes) * 1000) / 10 : 0,
  }
}
