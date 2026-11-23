import {
  PROJECT_RAID_TEXT_MAX_LENGTH,
  PROJECT_RAID_TITLE_MAX_LENGTH,
  type CuratedContextItem,
} from '@mukuroji/contracts'
import { useCallback, useState } from 'react'
import { useProjectRaidLog } from '../queries/useProjectRaidLog'
import { useSaveProjectRaidEntry } from './useSaveProjectRaidEntry'

/** Work Item whose curated risks may be promoted to its Project's log. */
export type ProjectRiskPromotionScope = {
  /** Cognito access token. */
  accessToken?: string
  /** Team that owns the Work Item and its Project. */
  teamId?: string
  /** Project the Work Item is assigned to; promotion is unavailable without one. */
  projectId?: string
  /** Work Item the risk was recorded on, linked as related on the new entry. */
  workItemId: string
}

/** Promotion bound to one Work Item, with the link to the Project log it writes to. */
export type ProjectRiskPromotion = {
  /**
   * Adds the curated risk to the Project log as an open risk related to the Work Item.
   *
   * @param item - Curated risk item.
   */
  promote: (item: CuratedContextItem) => Promise<void>
  /** Application path of the Project log, in the Project's permissions tab. */
  logPath: string
  /**
   * Curated risks already added to the log while this Work Item stays open. It outlives the
   * decisions tab, so switching collaboration tabs does not offer the same risk again.
   */
  promotedItemIds: ReadonlySet<string>
}

/**
 * Shortens text to a maximum length without splitting a surrogate pair.
 *
 * @param text - Text to shorten.
 * @param maxLength - Longest allowed length in UTF-16 code units.
 * @returns The text, cut at a character boundary when it is too long.
 */
function truncate(text: string, maxLength: number) {
  if (text.length <= maxLength) return text
  let end = maxLength
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return text.slice(0, end)
}

/**
 * Returns the promotion of a Work Item's curated risks to its Project's risk log.
 *
 * The new risk starts with medium probability and impact, so the owner rates it in the log. A
 * retried failed promotion of the same item reuses its Idempotency-Key, so it is not added twice,
 * and a promoted item is remembered for as long as the hook's owner stays mounted.
 *
 * @param scope - Session, Team, Project, and Work Item.
 * Promotion is offered only when the server says the viewer may edit the Project log, so a
 * Project viewer or a member without Enterprise `projects.write` is not shown a button that
 * always fails.
 *
 * @returns The promotion, or `undefined` when the Work Item has no Project or session, or the
 * viewer may not edit the Project log.
 */
export function usePromoteProjectRisk({
  accessToken,
  teamId,
  projectId,
  workItemId,
}: ProjectRiskPromotionScope): ProjectRiskPromotion | undefined {
  const save = useSaveProjectRaidEntry({ accessToken, teamId, projectId: projectId ?? '' })
  const [promotedItemIds, setPromotedItemIds] = useState<ReadonlySet<string>>(() => new Set())
  const log = useProjectRaidLog(accessToken, teamId, projectId ?? '', projectId !== undefined)
  const promote = useCallback(async (item: CuratedContextItem) => {
    const description = item.body.trim()
    await save(undefined, {
      kind: 'risk',
      title: truncate(item.title.trim(), PROJECT_RAID_TITLE_MAX_LENGTH),
      ...(description ? { description: truncate(description, PROJECT_RAID_TEXT_MAX_LENGTH) } : {}),
      probability: 3,
      impact: 3,
      relatedWorkItemIds: [workItemId],
      status: 'open',
    })
    setPromotedItemIds((current) => new Set(current).add(item.id))
  }, [save, workItemId])
  if (!accessToken || !teamId || !projectId || log.data?.viewer?.canEdit !== true) return undefined
  const search = new URLSearchParams({ teamId, tab: 'permissions' })
  return {
    promote,
    logPath: `/projects/${encodeURIComponent(projectId)}/issues?${search.toString()}`,
    promotedItemIds,
  }
}
