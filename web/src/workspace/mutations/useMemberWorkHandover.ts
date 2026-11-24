import { useMemo } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import { useWorkspaceWorkItems } from '../../issues/queries/useWorkItems'
import {
  createBulkOperationHandlers,
  type BulkOperationHandlers,
} from '../../bulk-operations/mutations/createBulkOperationHandlers'
import { listMemberWorkHandoverItems, type MemberWorkHandoverItem } from '../model/memberWorkHandover'

/** What a member handover is loading or showing. */
export type MemberWorkHandoverLoadState =
  | {
    /** The member's open Work Items are being read. */
    status: 'loading'
  }
  | {
    /** Reading the member's open Work Items failed. */
    status: 'failed'
  }
  | {
    /** The member's open Work Items were read. */
    status: 'loaded'
    /** Work Items whose responsibility moves. */
    items: MemberWorkHandoverItem[]
  }

/** State and actions of a member handover. */
export type MemberWorkHandoverController = {
  /** What the handover is loading or showing. */
  loadState: MemberWorkHandoverLoadState
  /** Reads the member's open Work Items again. */
  reload: () => void
  /** Preview, apply, retry, and undo of the handover bulk operation. */
  handlers: BulkOperationHandlers
}

/**
 * Reads a member's open Work Items and prepares the bulk operation that hands them over.
 *
 * The member's list is read again after an apply, retry, or undo so the dialog shows what is
 * still left with the member.
 *
 * @param accessToken - Access token for the Work Item and bulk operation APIs.
 * @param memberKey - Member whose open work is handed over.
 * @param t - Localized message resolver.
 * @returns The load state, a reload action, and the bulk handlers.
 */
export function useMemberWorkHandover(
  accessToken: string,
  memberKey: string,
  t: (key: MessageKey) => string,
): MemberWorkHandoverController {
  const query = useWorkspaceWorkItems(accessToken, true, false, { memberUserId: memberKey, openOnly: true })
  const { mutate } = query
  const handlers = useMemo(() => createBulkOperationHandlers({
    accessToken,
    guardRequest: (pending) => pending,
    mutationRequestRunner: createMutationRequestRunner(),
    // The server checks write permission on every Work Item during preview and apply.
    requireWriteScopes: () => undefined,
    revalidate: async () => {
      await mutate()
    },
    t,
  }), [accessToken, mutate, t])
  const loadState: MemberWorkHandoverLoadState = query.data
    ? { status: 'loaded', items: listMemberWorkHandoverItems(query.data, memberKey) }
    : query.error
      ? { status: 'failed' }
      : { status: 'loading' }
  return {
    loadState,
    reload: () => {
      void mutate()
    },
    handlers,
  }
}
