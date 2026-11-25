import useSWR from 'swr'
import type { NotificationMessageLocale } from '@mukuroji/contracts'
import { getChannelDestination, getPersonalSlackDestination, type ChannelDestinationOwner } from '../api/destinations'

/** Whose Slack destination is read: the caller's own, or a Team or Project channel. */
export type SlackDestinationOwner = 'personal' | ChannelDestinationOwner

/** Slack destination as the settings card reads it. */
export type SlackDestinationState = {
  /** What the card shows. */
  view: {
    /** Whether a webhook is registered. */
    configured: boolean
    /** Channel name, for a Team or Project channel. */
    label?: string
    /** Language of posts, for a Team or Project channel. */
    locale?: NotificationMessageLocale
    /** Whether the caller may change and test it. */
    canManage: boolean
  }
  /** Revision the next change must name; always 0 for the caller's own destination. */
  revision: number
}

/**
 * Builds a stable key part for an owner.
 *
 * @param owner - Destination owner.
 * @returns `personal`, or the Team and Project IDs.
 */
export function slackDestinationOwnerKey(owner: SlackDestinationOwner): string {
  return owner === 'personal' ? 'personal' : `${owner.teamId}/${owner.projectId ?? ''}`
}

/**
 * Reads one Slack destination.
 *
 * @param accessToken - API access token.
 * @param owner - Destination owner.
 * @returns The state the card shows and the revision to change it with.
 */
async function readSlackDestination(accessToken: string, owner: SlackDestinationOwner): Promise<SlackDestinationState> {
  if (owner === 'personal') {
    const state = await getPersonalSlackDestination(accessToken)
    return { view: { configured: state.configured, canManage: true }, revision: 0 }
  }
  const destination = await getChannelDestination(accessToken, owner)
  return {
    view: {
      configured: destination.configured,
      ...(destination.label ? { label: destination.label } : {}),
      locale: destination.locale,
      canManage: destination.canManage,
    },
    revision: destination.revision,
  }
}

/**
 * Loads one Slack destination. The webhook URL is never part of the response.
 *
 * @param accessToken - API access token, or undefined while the session loads.
 * @param owner - Destination owner, or undefined while the route resolves.
 * @returns SWR state of the destination.
 */
export function useSlackDestinationQuery(accessToken: string | undefined, owner: SlackDestinationOwner | undefined) {
  const key = accessToken && owner ? ['slack-destination', accessToken, slackDestinationOwnerKey(owner)] as const : null
  return useSWR(
    key,
    async () => {
      if (!accessToken || !owner) throw new Error('Slack destination query is not ready.')
      return await readSlackDestination(accessToken, owner)
    },
    { revalidateOnFocus: false, shouldRetryOnError: false },
  )
}
