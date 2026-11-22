import { useEffect, useRef, useState } from 'react'

/** One counted archive impact; a count that stopped early is a floor. */
export type ArchiveImpactCount = {
  /** Number of matching records counted. */
  count: number
  /** Whether the real number may be larger than `count`. */
  hasMore: boolean
}

/** What archiving a Team or Project affects, as the archive confirmation shows it. */
export type ArchiveImpactSummary = {
  /** Work Items that are neither completed nor canceled. */
  openWorkItems: ArchiveImpactCount
  /** Agent Runs still active on the affected Work Items. */
  activeAgentRuns: ArchiveImpactCount
  /** Active Planning entities scoped to the target. */
  planningEntities: number
  /** Planning links to the target's Work Items. */
  planningWorkItemLinks: number
  /** Planning dependencies on the Team's Work Items. */
  planningDependencies: number
  /** Active Webhook subscriptions that deliver events for the Team. */
  webhookSubscriptions: number
  /** Whether the server refuses the archive until the Planning references are removed. */
  archiveBlocked: boolean
}

/** Labels of the archive impact notice. */
export type ArchiveImpactLabels = {
  /** Shown while the counts load. */
  loading: string
  /** Shown when the counts could not be read. */
  loadError: string
  /** Heading above the counts. */
  title: string
  /** Shown when nothing is affected. */
  none: string
  /** Explains why the archive is refused. */
  blocked: string
  /** Explains what stays and what a restore brings back. */
  warning: string
  /** Formats a count that may be a floor, such as "1,000+". */
  count: (count: ArchiveImpactCount) => string
  /** Line for open Work Items. */
  openWorkItems: (count: string) => string
  /** Line for active Agent Runs. */
  activeAgentRuns: (count: string) => string
  /** Line for Planning entities. */
  planningEntities: (count: string) => string
  /** Line for Planning Work Item links. */
  planningWorkItemLinks: (count: string) => string
  /** Line for Planning dependencies. */
  planningDependencies: (count: string) => string
  /** Line for Webhook subscriptions. */
  webhookSubscriptions: (count: string) => string
}

/** Loading state of the archive impact of one target. */
export type ArchiveImpactState =
  | {
      /** The counts are loading. */
      status: 'loading'
    }
  | {
      /** The counts could not be read; the server still enforces its own checks. */
      status: 'error'
    }
  | {
      /** The counts are ready. */
      status: 'ready'
      /** Counts read for the target. */
      impact: ArchiveImpactSummary
    }

/**
 * Loads the archive impact of the target named by `targetKey`, again whenever the key changes.
 *
 * @param targetKey - Identity of the target, or undefined when no confirmation is open.
 * @param load - Reads the impact of the current target, or undefined when the viewer cannot.
 * @returns The loading state, or undefined when nothing is loaded.
 */
export function useArchiveImpact(
  targetKey: string | undefined,
  load: (() => Promise<ArchiveImpactSummary>) | undefined,
): ArchiveImpactState | undefined {
  const loadRef = useRef(load)
  const [loaded, setLoaded] = useState<{ key: string; state: ArchiveImpactState }>()
  const canLoad = load !== undefined

  useEffect(() => {
    loadRef.current = load
  })

  useEffect(() => {
    const currentLoad = loadRef.current
    if (targetKey === undefined || !canLoad || currentLoad === undefined) return
    let active = true
    currentLoad().then(
      (impact) => {
        if (active) setLoaded({ key: targetKey, state: { status: 'ready', impact } })
      },
      () => {
        if (active) setLoaded({ key: targetKey, state: { status: 'error' } })
      },
    )
    return () => {
      active = false
      // Reopening the same target must show fresh counts, never the ones read last time.
      setLoaded(undefined)
    }
  }, [canLoad, targetKey])

  if (targetKey === undefined || !canLoad) return undefined
  return loaded?.key === targetKey ? loaded.state : { status: 'loading' }
}

/**
 * Tells whether the confirmation must keep its archive button disabled.
 *
 * @param state - Loading state, or undefined when no impact is loaded.
 * @returns Whether the counts are still loading or say the server will refuse the archive.
 */
export function isArchiveImpactConfirmDisabled(state: ArchiveImpactState | undefined) {
  if (state === undefined || state.status === 'error') return false
  return state.status === 'loading' || state.impact.archiveBlocked
}
