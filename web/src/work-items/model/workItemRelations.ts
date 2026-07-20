import type {
  WorkItemRelation,
  WorkItemRelationType,
} from '@mukuroji/contracts'

/**
 * Relation candidate filter が必要とする Work Item の最小構造です。
 */
type WorkItemRelationCandidateLike = {
  /**
   * Relation target の Work Item ID です。
   */
  id: string
  /**
   * Candidate の表示名です。
   */
  title: string
}

/**
 * 選択中 relation type で未接続の Work Item 候補を表示順に返します。
 *
 * 同じ target でも別 relation type の edge は候補から除外しません。
 *
 * @param candidates - 同一 Team 内の relation target 候補です。
 * @param currentWorkItemId - Self relation を除外する現在の Work Item ID です。
 * @param relations - 現在の Work Item が持つ既存 relation です。
 * @param relationType - 新規作成する relation type です。
 * @returns Self と同一 type の既存 edge を除外した候補です。
 */
export function resolveAvailableWorkItemRelationCandidates<T extends WorkItemRelationCandidateLike>(
  candidates: readonly T[],
  currentWorkItemId: string,
  relations: readonly WorkItemRelation[],
  relationType: WorkItemRelationType,
) {
  const relatedWorkItemIds = new Set(
    relations
      .filter((relation) => relation.type === relationType)
      .map((relation) => relation.targetWorkItemId),
  )

  return candidates
    .filter((candidate) =>
      candidate.id !== currentWorkItemId && !relatedWorkItemIds.has(candidate.id),
    )
    .sort((first, second) => first.title.localeCompare(second.title))
}
