import { useCallback, useState } from 'react'
import type { NotificationDestinationTestResult, NotificationMessageLocale } from '@mukuroji/contracts'
import {
  deleteChannelDestination,
  deletePersonalSlackDestination,
  saveChannelDestination,
  savePersonalSlackDestination,
  testChannelDestination,
  testPersonalSlackDestination,
  type ChannelDestinationOwner,
} from '../api/destinations'
import { NotificationsApiError } from '../api/errors'
import { slackDestinationOwnerKey, useSlackDestinationQuery, type SlackDestinationState } from '../queries/useSlackDestinationQuery'

/** State of a Slack destination as the settings card shows it. */
export type SlackDestinationView = SlackDestinationState['view']

/** Outcome shown under the card after the last action. */
export type SlackDestinationOutcome =
  | {
      /** Kind of outcome. */
      kind: 'saved' | 'deleted' | 'tested'
    }
  | {
      /** A test that Slack did not accept. */
      kind: 'test-failed'
      /** Safe failure code. */
      code?: NotificationDestinationTestResult['code']
    }
  | {
      /** A request that failed. */
      kind: 'error'
      /** Safe error code from the API. */
      code?: string
    }

/** Change the card asks for. */
export type SlackDestinationSaveInput = {
  /** New webhook URL; empty keeps the stored one. */
  webhookUrl: string
  /** Channel name, for a Team or Project channel. */
  label?: string
  /** Language of posts, for a Team or Project channel. */
  locale?: NotificationMessageLocale
}

/** Settings card controller of one Slack destination. */
export type SlackDestinationController = {
  /** Current state, or undefined while it loads. */
  view?: SlackDestinationView
  /** Whether the first read failed. */
  loadFailed: boolean
  /** Whether a change or test is running. */
  pending: boolean
  /** Outcome of the last action. */
  outcome?: SlackDestinationOutcome
  /** Reads the state again. */
  retry(): void
  /**
   * Saves the destination.
   * @returns True when the server accepted the change, so the card may clear the typed URL.
   */
  save(input: SlackDestinationSaveInput): Promise<boolean>
  /** Removes the destination. */
  remove(): void
  /** Sends a test message. */
  test(): void
}

/**
 * Loads and changes one Slack destination: the caller's own, or a Team or Project channel.
 *
 * @param accessToken - API access token, or undefined while the session loads.
 * @param owner - `personal` for the caller's own destination, otherwise the Team or Project.
 * @param locale - Display language, used for the personal test message.
 * @returns Controller for the settings card.
 */
export function useSlackDestination(
  accessToken: string | undefined,
  owner: 'personal' | ChannelDestinationOwner | undefined,
  locale: NotificationMessageLocale,
): SlackDestinationController {
  const ownerKey = owner === undefined ? undefined : slackDestinationOwnerKey(owner)
  const query = useSlackDestinationQuery(accessToken, owner)
  const [pending, setPending] = useState(false)
  // The outcome belongs to the owner it was reached for, so switching Teams or Projects drops it.
  const [result, setResult] = useState<{ ownerKey: string | undefined, outcome: SlackDestinationOutcome }>()
  const outcome = result && result.ownerKey === ownerKey ? result.outcome : undefined
  const { mutate } = query
  const revision = query.data?.revision ?? 0

  const run = useCallback(async (action: () => Promise<SlackDestinationOutcome>): Promise<boolean> => {
    if (pending || !accessToken || !owner) return false
    setPending(true)
    setResult(undefined)
    const actionOwnerKey = ownerKey
    try {
      const reached = await action()
      setResult({ ownerKey: actionOwnerKey, outcome: reached })
      return true
    } catch (error: unknown) {
      setResult({
        ownerKey: actionOwnerKey,
        outcome: {
          kind: 'error',
          ...(error instanceof NotificationsApiError && error.code ? { code: error.code } : {}),
        },
      })
      return false
    } finally {
      setPending(false)
      void mutate()
    }
  }, [accessToken, mutate, owner, ownerKey, pending])

  return {
    ...(query.data ? { view: query.data.view } : {}),
    loadFailed: Boolean(query.error),
    pending,
    ...(outcome ? { outcome } : {}),
    retry: () => { void mutate() },
    save: (input) => run(async () => {
      if (!accessToken || !owner) throw new Error('Slack destination is not ready.')
      const webhookUrl = input.webhookUrl.trim()
      if (owner === 'personal') {
        await savePersonalSlackDestination(accessToken, webhookUrl)
      } else {
        await saveChannelDestination(accessToken, owner, {
          ...(webhookUrl ? { webhookUrl } : {}),
          label: input.label?.trim() ?? '',
          locale: input.locale ?? 'ja',
          expectedRevision: revision,
        })
      }
      return { kind: 'saved' }
    }),
    remove: () => { void run(async () => {
      if (!accessToken || !owner) throw new Error('Slack destination is not ready.')
      if (owner === 'personal') await deletePersonalSlackDestination(accessToken)
      else await deleteChannelDestination(accessToken, owner, revision)
      return { kind: 'deleted' }
    }) },
    test: () => { void run(async () => {
      if (!accessToken || !owner) throw new Error('Slack destination is not ready.')
      const result = owner === 'personal'
        ? await testPersonalSlackDestination(accessToken, locale)
        : await testChannelDestination(accessToken, owner)
      return result.delivered ? { kind: 'tested' } : { kind: 'test-failed', ...(result.code ? { code: result.code } : {}) }
    }) },
  }
}
