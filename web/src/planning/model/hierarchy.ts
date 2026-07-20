import type {
  PlanningEntity,
  PlanningEntityType,
  PlanningGoalFramework,
} from '@mukuroji/contracts'

/**
 * Planning subtree move で選択した移動先と継承 scope です。
 */
export type PlanningMoveSelection = {
  /** Parent-driven move で選択した target parent です。root move では省略します。 */
  parent?: PlanningEntity
  /** Subtree へ適用する target Team scope です。 */
  teamId?: string
  /** Subtree へ適用する target Project scope です。 */
  projectId?: string
}

const allowedParentTypesByEntityType: Partial<Record<PlanningEntityType, PlanningEntityType[]>> = {
  roadmap: ['portfolio'],
  initiative: ['roadmap'],
  goal: ['initiative'],
  phase: ['goal', 'initiative', 'roadmap'],
  milestone: ['phase', 'goal', 'initiative', 'roadmap'],
  release: ['phase', 'goal', 'initiative', 'roadmap'],
}

/**
 * Entity type と Goal / OKR framework に合う parent 候補を返します。
 *
 * @param entities - Active Planning entities です。
 * @param entityType - 作成または移動する entity type です。
 * @param goalFramework - Goal entity の OKR role です。
 * @returns Backend hierarchy rule と一致する parent 候補です。
 */
export function resolvePlanningParentCandidates(
  entities: PlanningEntity[],
  entityType: PlanningEntityType,
  goalFramework?: PlanningGoalFramework,
) {
  if (entityType === 'goal' && goalFramework === 'key-result') {
    return entities.filter((entity) =>
      entity.type === 'goal' && entity.goalFramework === 'objective',
    )
  }
  const allowedTypes = allowedParentTypesByEntityType[entityType] ?? []
  return entities.filter((entity) => allowedTypes.includes(entity.type))
}

/**
 * Parent selection または root scope fields から subtree move target を解決します。
 *
 * @param entities - Active Planning entities です。
 * @param parentId - 選択した parent ID です。空文字列は root move を表します。
 * @param rootTeamId - Root move で入力した Team ID です。
 * @param rootProjectId - Root move で入力した Project ID です。
 * @returns Parent の scope、または明示された root scope を持つ move selection です。
 */
export function resolvePlanningMoveSelection(
  entities: readonly PlanningEntity[],
  parentId: string,
  rootTeamId = '',
  rootProjectId = '',
): PlanningMoveSelection | undefined {
  if (parentId) {
    const parent = entities.find((entity) => entity.id === parentId)
    if (!parent) return undefined
    return {
      parent,
      ...(parent.teamId ? { teamId: parent.teamId } : {}),
      ...(parent.projectId ? { projectId: parent.projectId } : {}),
    }
  }

  const teamId = rootTeamId.trim()
  const projectId = rootProjectId.trim()
  return {
    ...(teamId ? { teamId } : {}),
    ...(projectId ? { projectId } : {}),
  }
}
