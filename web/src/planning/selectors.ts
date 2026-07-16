import type {
  PlanningEntity,
  PlanningWorkItemSummary,
} from '@mukuroji/contracts'

/**
 * Entity detail form の React identity を返します。
 *
 * @param entity - Detail に表示する Planning entity です。
 * @returns Uncontrolled form の初期値が変わったときに更新される stable key です。
 */
export function createPlanningEntityDetailKey(entity: PlanningEntity) {
  return [
    entity.id,
    entity.parentId ?? '',
    entity.teamId ?? '',
    entity.projectId ?? '',
    entity.health,
    entity.risk,
    entity.forecast.startDate,
    entity.forecast.endDate,
    entity.statusUpdates.length,
    entity.updatedAt,
  ].join('\0')
}

/**
 * Planning entity が新しい link や rollover を受け取れる open state か判定します。
 *
 * @param entity - 判定対象の Planning entity です。
 * @returns Archive、completed、canceled のいずれでもなければ true です。
 */
export function isOpenPlanningEntity(entity: PlanningEntity) {
  return !entity.archivedAt && entity.status !== 'completed' && entity.status !== 'canceled'
}

/**
 * Planning entity が選択中 Work Item の link target として有効か判定します。
 *
 * @param entity - Link 候補の Planning entity です。
 * @param workItem - 選択中の canonical Work Item です。
 * @returns Open かつ Team / Project scope が Work Item と互換なら true です。
 */
export function isPlanningWorkItemLinkCandidate(
  entity: PlanningEntity,
  workItem: PlanningWorkItemSummary,
) {
  return isOpenPlanningEntity(entity) &&
    (!entity.teamId || entity.teamId === workItem.teamId) &&
    (!entity.projectId || entity.projectId === workItem.projectId)
}

/**
 * Source Cycle と安全に rollover できる target Cycle 候補を返します。
 *
 * @param source - Rollover 元 Cycle です。
 * @param cycles - Current user が管理できる Cycle 一覧です。
 * @returns 同 scope・cadence で source より後続する open Cycle 一覧です。
 */
export function resolvePlanningCycleRolloverTargets(
  source: PlanningEntity | undefined,
  cycles: readonly PlanningEntity[],
) {
  if (!source || source.type !== 'cycle' || !source.cadence || !isOpenPlanningEntity(source)) {
    return []
  }
  return cycles.filter((target) =>
    target.id !== source.id &&
    target.type === 'cycle' &&
    target.teamId === source.teamId &&
    target.projectId === source.projectId &&
    target.cadence?.unit === source.cadence?.unit &&
    target.cadence?.count === source.cadence?.count &&
    target.baseline.startDate > source.baseline.endDate &&
    target.forecast.startDate > source.forecast.endDate &&
    isOpenPlanningEntity(target),
  )
}
