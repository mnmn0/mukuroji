import type {
  DocumentRelationTarget,
  WorkspaceSearchResult,
} from '@mukuroji/contracts'
import { parseCanonicalWorkItemId } from './relations'

/**
 * Link picker で選べる relation target 種別です。
 */
export type DocumentLinkTargetKind = DocumentRelationTarget['kind']

/**
 * Link picker が候補として表示する relation target です。
 */
export type DocumentLinkTargetOption = {
  /**
   * 選択時に保存する canonical relation target です。
   */
  target: DocumentRelationTarget
  /**
   * 候補の主見出しです。
   */
  title: string
  /**
   * Project 名や Work Item key などの補助見出しです。
   */
  subtitle?: string
  /**
   * Work Item の workflow status code です。
   */
  status?: string
}

/**
 * Relation target を種別と ID で一意に識別する key を作ります。
 *
 * @param target - Canonical relation target です。
 * @returns 種別と ID を結合した key です。
 */
export function createDocumentRelationTargetKey(
  target: DocumentRelationTarget,
): string {
  return `${target.kind}:${readDocumentRelationTargetValue(target)}`
}

/**
 * Relation target の canonical ID を返します。
 *
 * @param target - Canonical relation target です。
 * @returns Work Item、Project、Goal の ID です。
 */
export function readDocumentRelationTargetValue(
  target: DocumentRelationTarget,
): string {
  switch (target.kind) {
    case 'work-item':
      return target.workItemId
    case 'project':
      return target.projectId
    case 'goal':
      return target.goalId
  }
}

/**
 * Workspace search の結果を link picker の候補に変換します。
 *
 * Search API は permission-filtered な結果だけを返すため、閲覧できない対象は
 * 候補に現れません。Work Item の ID は relation と同じ canonical 形式です。
 *
 * @param kind - Picker で選択中の relation target 種別です。
 * @param results - Workspace search の結果です。
 * @returns 指定種別に一致する候補です。
 */
export function toDocumentLinkTargetOptions(
  kind: DocumentLinkTargetKind,
  results: readonly WorkspaceSearchResult[],
): DocumentLinkTargetOption[] {
  const options: DocumentLinkTargetOption[] = []
  for (const result of results) {
    if (kind === 'work-item' && result.entityType === 'work-item') {
      if (!parseCanonicalWorkItemId(result.id)) continue
      options.push({
        target: { kind: 'work-item', workItemId: result.id },
        title: result.title,
        ...(result.subtitle ? { subtitle: result.subtitle } : {}),
        ...(result.status ? { status: result.status } : {}),
      })
    } else if (kind === 'project' && result.entityType === 'project') {
      options.push({
        target: { kind: 'project', projectId: result.id },
        title: result.title,
        ...(result.subtitle ? { subtitle: result.subtitle } : {}),
      })
    }
  }
  return deduplicateDocumentLinkTargetOptions(options)
}

/**
 * Picker の入力を、そのまま保存できる relation target として解釈します。
 *
 * 検索 index に出ない対象も ID で link できるようにするための fallback です。
 * Work Item は `team/<teamId>/issue/<issueId>` 形式だけを受け付けます。
 *
 * @param kind - Picker で選択中の relation target 種別です。
 * @param query - 利用者の入力です。
 * @returns 有効な ID の場合の relation target です。
 */
export function parseDocumentLinkTargetQuery(
  kind: DocumentLinkTargetKind,
  query: string,
): DocumentRelationTarget | undefined {
  const value = query.trim()
  if (
    value.length === 0 ||
    value.length > 500 ||
    /\s/u.test(value)
  ) {
    return undefined
  }
  if (kind === 'work-item') {
    const parsed = parseCanonicalWorkItemId(value)
    return parsed
      ? {
          kind: 'work-item',
          workItemId: `team/${parsed.teamId}/issue/${parsed.issueId}`,
        }
      : undefined
  }
  if (value.includes('/')) return undefined
  return kind === 'project'
    ? { kind: 'project', projectId: value }
    : { kind: 'goal', goalId: value }
}

/**
 * Keeps the first candidate for each relation target, preserving search order.
 *
 * @param options - Candidates in search-relevance order.
 * @returns Candidates without repeated targets.
 */
function deduplicateDocumentLinkTargetOptions(
  options: readonly DocumentLinkTargetOption[],
): DocumentLinkTargetOption[] {
  const seen = new Set<string>()
  return options.filter((option) => {
    const key = createDocumentRelationTargetKey(option.target)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
