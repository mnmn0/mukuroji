import type { NotificationChannelDestinationProvider, NotificationMessageLocale } from '@mukuroji/contracts'

/** Team or Project that owns a shared chat channel destination. */
export type ChannelDestinationTarget =
  | {
      /** Team destination. */
      scope: 'team'
      /** Team ID. */
      teamId: string
    }
  | {
      /** Project destination. */
      scope: 'project'
      /** Team that owns the Project. */
      teamId: string
      /** Project ID, unique within its Team. */
      projectId: string
    }

/** Saved non-secret settings of a channel destination; the webhook lives in Secrets Manager. */
export type ChannelDestinationRecord = {
  /** Owner of the destination. */
  target: ChannelDestinationTarget
  /** Chat service of the webhook. */
  provider: NotificationChannelDestinationProvider
  /** Optional channel name shown on the settings screen. */
  label?: string
  /** Language posts are written in. */
  locale: NotificationMessageLocale
  /** Revision a later save or delete must name. */
  revision: number
  /** Last save time. */
  updatedAt: string
  /** Member who saved last. */
  updatedBy: string
}

/**
 * Builds a stable identity of a destination owner, used in storage keys and secret names.
 *
 * @param target - Team or Project.
 * @returns `team#<teamId>` or `project#<teamId>#<projectId>`.
 */
export function channelDestinationTargetKey(target: ChannelDestinationTarget): string {
  return target.scope === 'team'
    ? `team#${target.teamId}`
    : `project#${target.teamId}#${target.projectId}`
}

/**
 * Lists the destinations an event of a Team or Project goes to, most specific first. A Project
 * event goes to the Project's channel when it has one, otherwise to its Team's channel.
 *
 * @param teamId - Team of the event.
 * @param projectId - Project of the event, when it has one.
 * @returns Project destination (when a Project is named) followed by the Team destination.
 */
export function channelDestinationCandidates(teamId: string, projectId?: string): ChannelDestinationTarget[] {
  const team: ChannelDestinationTarget = { scope: 'team', teamId }
  return projectId ? [{ scope: 'project', teamId, projectId }, team] : [team]
}
