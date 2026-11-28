import type { TeamInvestmentAssignments, WorkspaceInvestmentCategorySettings } from '@mukuroji/contracts'

/** One category a select offers: active categories, plus a retired one an item already holds. */
export type InvestmentCategoryChoice = {
  /** Category key. */
  key: string
  /** Whether the category is retired and kept only because an item holds it. */
  retired: boolean
}

/**
 * Sets or clears the category of one Project or Work Item.
 *
 * @param map - Saved categories keyed by ID.
 * @param id - Project or Work Item ID.
 * @param categoryKey - New category key, or an empty string to clear it.
 * @returns A copy of the map with the change.
 */
function setCategory(map: Readonly<Record<string, string>>, id: string, categoryKey: string): Readonly<Record<string, string>> {
  const next = Object.fromEntries(Object.entries(map).filter(([key]) => key !== id))
  return categoryKey === '' ? next : { ...next, [id]: categoryKey }
}

/**
 * Sets or clears a Project's default investment category.
 *
 * @param assignments - Edited assignments.
 * @param projectId - Project ID.
 * @param categoryKey - Category key, or an empty string to clear it.
 * @returns Assignments with the change.
 */
export function setProjectInvestmentCategory(
  assignments: TeamInvestmentAssignments,
  projectId: string,
  categoryKey: string,
): TeamInvestmentAssignments {
  return { ...assignments, projects: setCategory(assignments.projects, projectId, categoryKey) }
}

/**
 * Sets or clears a Work Item's own investment category.
 *
 * @param assignments - Edited assignments.
 * @param workItemId - Work Item ID.
 * @param categoryKey - Category key, or an empty string to clear it.
 * @returns Assignments with the change.
 */
export function setWorkItemInvestmentCategory(
  assignments: TeamInvestmentAssignments,
  workItemId: string,
  categoryKey: string,
): TeamInvestmentAssignments {
  return { ...assignments, workItems: setCategory(assignments.workItems, workItemId, categoryKey) }
}

/**
 * Lists the categories a select offers for one item.
 *
 * The server accepts a retired category only when the item already held it, so a retired
 * category is offered only for the item that holds it.
 *
 * @param settings - Workspace categories.
 * @param heldKey - Category the item holds now, if any.
 * @returns Offered categories in Workspace order.
 */
export function listInvestmentCategoryChoices(
  settings: WorkspaceInvestmentCategorySettings,
  heldKey: string | undefined,
): InvestmentCategoryChoice[] {
  const choices = settings.categories
    .filter((category) => category.active || category.key === heldKey)
    .map((category) => ({ key: category.key, retired: !category.active }))
  if (heldKey !== undefined && !choices.some((choice) => choice.key === heldKey)) {
    choices.push({ key: heldKey, retired: true })
  }
  return choices
}
