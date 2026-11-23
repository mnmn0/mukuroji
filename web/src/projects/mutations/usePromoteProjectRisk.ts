import {
  PROJECT_RAID_TEXT_MAX_LENGTH,
  PROJECT_RAID_TITLE_MAX_LENGTH,
  type CuratedContextItem,
} from '@mukuroji/contracts'
import { useCallback, useMemo, useState } from 'react'
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
   * Curated risks already added to this Project's log while the Work Item stays open. It outlives
   * the decisions tab, so switching collaboration tabs does not offer the same risk again.
   */
  promotedItemIds: ReadonlySet<string>
  /**
   * Set when the Project log could not be read, so it is unknown whether the viewer may add
   * risks. Promotion is then not offered, and `retry` reads the log again.
   */
  capabilityError?: {
    /** Reads the Project log again. */
    retry: () => void
  }
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
 * Identifies one curated risk promoted to one Project log.
 *
 * @param teamId - Team that owns the Project.
 * @param projectId - Project whose log received the risk.
 * @param itemId - Curated risk item.
 * @returns A key unique to the destination and the item.
 */
function promotionKey(teamId: string, projectId: string, itemId: string) {
  return JSON.stringify([teamId, projectId, itemId])
}

/**
 * Returns the promotion of a Work Item's curated risks to its Project's risk log.
 *
 * The new risk starts with medium probability and impact, so the owner rates it in the log. Each
 * curated risk keeps its own Idempotency-Key, so a retried promotion is not added twice, even when
 * two risks have the same text. A promoted risk is remembered per destination Project for as long
 * as the hook's owner stays mounted, so moving the Work Item to another Project offers it again.
 * Promotion is offered only when the server says the viewer may edit the Project log, so a
 * Project viewer or a member without Enterprise `projects.write` is not shown a button that
 * always fails.
 *
 * @param scope - Session, Team, Project, and Work Item.
 * @returns The promotion, or `undefined` when the Work Item has no Project or session, or the
 * viewer may not edit the Project log. When the log could not be read, the promotion carries
 * `capabilityError` instead of being dropped, so the failure is shown with a retry.
 */
export function usePromoteProjectRisk({
  accessToken,
  teamId,
  projectId,
  workItemId,
}: ProjectRiskPromotionScope): ProjectRiskPromotion | undefined {
  const save = useSaveProjectRaidEntry({ accessToken, teamId, projectId: projectId ?? '' })
  const [promotedKeys, setPromotedKeys] = useState<ReadonlySet<string>>(() => new Set())
  const log = useProjectRaidLog(accessToken, teamId, projectId ?? '', projectId !== undefined)
  const promote = useCallback(async (item: CuratedContextItem) => {
    if (!teamId || !projectId) return
    // The destination is fixed when the promotion starts, so one finishing after the Work Item
    // moved to another Project is remembered for the Project that received it.
    const key = promotionKey(teamId, projectId, item.id)
    const description = item.body.trim()
    await save(undefined, {
      kind: 'risk',
      title: truncate(item.title.trim(), PROJECT_RAID_TITLE_MAX_LENGTH),
      ...(description ? { description: truncate(description, PROJECT_RAID_TEXT_MAX_LENGTH) } : {}),
      probability: 3,
      impact: 3,
      relatedWorkItemIds: [workItemId],
      status: 'open',
    }, `promote-risk:${item.id}`)
    setPromotedKeys((current) => new Set(current).add(key))
  }, [projectId, save, teamId, workItemId])
  const promotedItemIds = useMemo(() => {
    const ids = new Set<string>()
    if (!teamId || !projectId) return ids
    for (const key of promotedKeys) {
      const parsed: unknown = JSON.parse(key)
      if (Array.isArray(parsed) && parsed[0] === teamId && parsed[1] === projectId && typeof parsed[2] === 'string') {
        ids.add(parsed[2])
      }
    }
    return ids
  }, [projectId, promotedKeys, teamId])
  const { mutate: reloadLog } = log
  const retry = useCallback(() => {
    void reloadLog()
  }, [reloadLog])
  if (!accessToken || !teamId || !projectId) return undefined
  const search = new URLSearchParams({ teamId, tab: 'permissions' })
  const promotion = {
    promote,
    logPath: `/projects/${encodeURIComponent(projectId)}/issues?${search.toString()}`,
    promotedItemIds,
  }
  if (log.data === undefined && log.error !== undefined) return { ...promotion, capabilityError: { retry } }
  return log.data?.viewer?.canEdit === true ? promotion : undefined
}
