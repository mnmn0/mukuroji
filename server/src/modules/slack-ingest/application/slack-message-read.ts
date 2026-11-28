import {
  SLACK_WORK_ITEM_MESSAGE_LIMIT,
  type SlackChannelTarget,
  type SlackMessageView,
  type WorkItemSlackMessagesResponse,
} from '@mukuroji/contracts'
import { retentionCutoffTs, slackTsToIso } from '../domain/slack-message'
import type { SlackChannelRecord, SlackIngestStore, StoredSlackMessage } from './ports/slack-ingest-ports'

/** Most key references read for one Work Item. */
const KEY_REFERENCE_READ_LIMIT = 200

/** Ports of the message read. */
export type SlackMessageReadPorts = {
  /** Ingest rows. */
  store: SlackIngestStore
  /**
   * Reports whether the caller may read a channel's target.
   *
   * @param target - Team or Project.
   * @returns Whether the caller is at least a viewer there.
   */
  canReadTarget(target: SlackChannelTarget): Promise<boolean>
  /**
   * Returns the current time.
   *
   * @returns Now.
   */
  now(): Date
}

/**
 * Converts a stored message to its response shape.
 *
 * @param message - Stored message.
 * @param channel - Its channel.
 * @returns The view.
 */
function toMessageView(message: StoredSlackMessage, channel: SlackChannelRecord): SlackMessageView {
  return {
    channelId: message.channelId,
    ...(channel.name ? { channelName: channel.name } : {}),
    ts: message.ts,
    ...(message.threadTs ? { threadTs: message.threadTs } : {}),
    authorId: message.userId,
    ...(message.authorName ? { authorName: message.authorName } : {}),
    text: message.text,
    postedAt: slackTsToIso(message.ts),
    ...(message.editedTs ? { editedAt: slackTsToIso(message.editedTs) } : {}),
    permalink: message.permalink,
  }
}

/**
 * Lists the Slack messages that mention a Work Item key, limited to the channels whose Team or
 * Project the caller can read. The caller has already checked access to the Work Item.
 *
 * @param workspaceId - Workspace ID.
 * @param key - The Work Item's current key.
 * @param ports - Ports.
 * @returns Messages newest first.
 */
export async function listWorkItemSlackMessages(
  workspaceId: string,
  key: string,
  ports: SlackMessageReadPorts,
): Promise<WorkItemSlackMessagesResponse> {
  const { refs, truncated } = await ports.store.listMessageRefsByKey(workspaceId, key, KEY_REFERENCE_READ_LIMIT)
  if (refs.length === 0) return { messages: [], truncated: false }
  const channelIds = [...new Set(refs.map((ref) => ref.channelId))]
  const readable = new Map<string, SlackChannelRecord>()
  for (const channelId of channelIds) {
    const channel = await ports.store.getChannel(workspaceId, channelId)
    if (channel?.target && await ports.canReadTarget(channel.target)) readable.set(channelId, channel)
  }
  const settings = await ports.store.getSettings(workspaceId)
  const cutoff = retentionCutoffTs(Math.floor(ports.now().getTime() / 1000), settings.retentionDays)
  const messages = (await ports.store.getMessages(
    workspaceId,
    refs.filter((ref) => readable.has(ref.channelId) && ref.ts >= cutoff),
  )).sort((left, right) => right.ts.localeCompare(left.ts))
  const views: SlackMessageView[] = []
  for (const message of messages.slice(0, SLACK_WORK_ITEM_MESSAGE_LIMIT)) {
    const channel = readable.get(message.channelId)
    if (channel) views.push(toMessageView(message, channel))
  }
  return { messages: views, truncated: truncated || messages.length > SLACK_WORK_ITEM_MESSAGE_LIMIT }
}
