import type { SearchViewLayout, WorkspaceSearchResult } from '@mukuroji/contracts'

const resultFieldAliases: Record<string, string> = {
  assignee: 'assigneeUserId',
  creator: 'creatorUserId',
  project: 'projectId',
  team: 'teamId',
  type: 'entityType',
  workItemType: 'workItemTypeId',
}

/**
 * Saved viewのmulti-sortを全layoutで共有できるようsearch resultへ安定適用します。
 *
 * 同値の場合はentityType、teamId、idで決定的に並べます。relevanceはAPI順を維持します。
 */
export function sortWorkspaceSearchResults(
  results: readonly WorkspaceSearchResult[],
  layout: SearchViewLayout,
) {
  const sourceOrder = new Map(results.map((result, index) => [createResultKey(result), index]))

  return [...results].sort((left, right) => {
    for (const rule of layout.sort) {
      if (rule.field === 'relevance') {
        const orderDifference = (sourceOrder.get(createResultKey(left)) ?? 0) -
          (sourceOrder.get(createResultKey(right)) ?? 0)
        if (orderDifference !== 0) {
          return rule.direction === 'asc' ? -orderDifference : orderDifference
        }
        continue
      }

      const leftValue = resolveWorkspaceSearchResultFieldValue(left, rule.field)
      const rightValue = resolveWorkspaceSearchResultFieldValue(right, rule.field)
      const leftMissing = isMissingSearchResultValue(leftValue)
      const rightMissing = isMissingSearchResultValue(rightValue)

      if (leftMissing !== rightMissing) {
        return leftMissing ? 1 : -1
      }

      const comparison = compareSearchResultValues(leftValue, rightValue)
      if (comparison !== 0) {
        return rule.direction === 'asc' ? comparison : -comparison
      }
    }

    return left.entityType.localeCompare(right.entityType) ||
      (left.teamId ?? '').localeCompare(right.teamId ?? '') ||
      left.id.localeCompare(right.id)
  })
}

/**
 * Built-in alias と custom field ID を同じ saved layout field から解決します。
 */
export function resolveWorkspaceSearchResultFieldValue(
  result: WorkspaceSearchResult,
  field: string,
) {
  const customFieldId = field.startsWith('custom:') ? field.slice('custom:'.length) : undefined
  if (customFieldId) {
    return result.customFields?.[customFieldId]
  }

  const resultField = resultFieldAliases[field] ?? field
  const builtInValue = (result as unknown as Record<string, unknown>)[resultField]
  return builtInValue ?? result.customFields?.[field]
}

function compareSearchResultValues(left: unknown, right: unknown) {
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right
  }

  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return Number(left) - Number(right)
  }

  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

function isMissingSearchResultValue(value: unknown) {
  return value === undefined || value === null || value === ''
}

function createResultKey(result: WorkspaceSearchResult) {
  return `${result.entityType}:${result.teamId ?? ''}:${result.id}`
}
