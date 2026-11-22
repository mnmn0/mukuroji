import type {
  DirectoryArchiveImpactCount,
  DirectoryArchiveImpactResponse,
  DirectoryArchiveImpactTarget,
} from '@mukuroji/contracts'
import type { ReactNode } from 'react'

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
  count: (count: DirectoryArchiveImpactCount) => string
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
      /** The counts are loading or being refreshed. */
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
      impact: DirectoryArchiveImpactResponse
    }

/**
 * Props of a component that reads the archive impact of one target and renders its children
 * with the loading state. The app supplies it so shared confirmation dialogs stay free of
 * data fetching; it is mounted only while a confirmation is open.
 */
export type ArchiveImpactGateProps = {
  /** Team or Project about to be archived. */
  target: DirectoryArchiveImpactTarget
  /** Renders the confirmation body for the current loading state. */
  children: (state: ArchiveImpactState) => ReactNode
}

/**
 * Tells whether the confirmation must keep its archive button disabled.
 *
 * @param state - Loading state, or undefined when no impact is read.
 * @returns Whether the counts are still loading or say the server will refuse the archive.
 */
export function isArchiveImpactConfirmDisabled(state: ArchiveImpactState | undefined) {
  if (state === undefined || state.status === 'error') return false
  return state.status === 'loading' || state.impact.archiveBlocked
}
