import { useMemo } from 'react'
import type { PlanningSnapshot, PlanningUpdate } from '@mukuroji/contracts'
import { useWorkItemScheduleBaselines } from '../../work-items/queries/useWorkItemScheduleBaselines'
import {
  createPlanningBaselineDelayCandidates,
  listPlanningTargetBaselineWorkItems,
  type PlanningBaselineDelaysView,
} from '../model/baselineDelayEvidence'
import type { PlanningUpdateTargetView } from '../model/statusUpdateView'

/**
 * Reads the active baselines of the selected update target and lists what is behind them.
 *
 * @param accessToken - Bearer token, or undefined before sign-in.
 * @param snapshot - Authorized Planning snapshot.
 * @param target - Selected Project or Initiative.
 * @param updates - Published updates of the target, newest first; the first one is the previous update.
 * @param enabled - Whether the viewer can publish an update for the target.
 * @returns The delay view, or undefined when the composer shows no delay section.
 */
export function usePlanningBaselineDelays(
  accessToken: string | undefined,
  snapshot: PlanningSnapshot | undefined,
  target: PlanningUpdateTargetView | undefined,
  updates: readonly PlanningUpdate[] | undefined,
  enabled: boolean,
): PlanningBaselineDelaysView | undefined {
  const active = Boolean(accessToken && snapshot && target && enabled)
  const scopeWorkItems = useMemo(
    () => active && snapshot && target ? listPlanningTargetBaselineWorkItems(snapshot, target) : [],
    [active, snapshot, target],
  )
  const hasProjects = scopeWorkItems.some((workItem) => workItem.assignedProjectId !== undefined)
  const baselineFor = useWorkItemScheduleBaselines(accessToken, scopeWorkItems, active && hasProjects)
  return useMemo(() => {
    if (!active || !snapshot || !target) return undefined
    if (hasProjects && !baselineFor) return { status: 'loading' }
    return {
      status: 'ready',
      candidates: createPlanningBaselineDelayCandidates(
        snapshot,
        target,
        baselineFor ?? (() => undefined),
        updates?.[0]?.evidence ?? [],
      ),
    }
  }, [active, baselineFor, hasProjects, snapshot, target, updates])
}
