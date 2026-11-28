import {
  type SlackChannelSummary,
  type SlackChannelTarget,
  type SlackIngestStatusResponse,
  type UpdateSlackIngestSettingsRequest,
} from '@mukuroji/contracts'
import { SlackIngestError } from '../errors'
import type {
  SlackChannelRecord,
  SlackIngestAuditInput,
  SlackIngestConfigSource,
  SlackIngestQueue,
  SlackIngestStore,
} from './ports/slack-ingest-ports'

/** Ports of the administration use cases. */
export type SlackIngestAdminPorts<AuditContext> = {
  /** Slack app settings. */
  config: SlackIngestConfigSource
  /** Ingest rows. */
  store: SlackIngestStore<AuditContext>
  /** Worker queue. */
  queue: SlackIngestQueue
}

/**
 * Converts a channel row to its response shape.
 *
 * @param record - Channel row.
 * @returns The summary.
 */
function toChannelSummary(record: SlackChannelRecord): SlackChannelSummary {
  return {
    channelId: record.channelId,
    ...(record.name ? { name: record.name } : {}),
    isPrivate: record.isPrivate,
    membership: record.membership,
    ...(record.target ? { target: record.target } : {}),
    ...(record.backfill ? { backfill: { ...record.backfill } } : {}),
    updatedAt: record.updatedAt,
  }
}

/**
 * Reads whether the Slack app is set up for a Workspace, its retention, and the bot's channels.
 *
 * @param workspaceId - Workspace ID.
 * @param ports - Ports.
 * @returns The status.
 */
export async function readSlackIngestStatus<AuditContext>(
  workspaceId: string,
  ports: SlackIngestAdminPorts<AuditContext>,
): Promise<SlackIngestStatusResponse> {
  const [config, settings, channels] = await Promise.all([
    ports.config.read(),
    ports.store.getSettings(workspaceId),
    ports.store.listChannels(workspaceId),
  ])
  const configured = config?.workspaceId === workspaceId
  return {
    configured,
    workspaceId,
    ...(configured && config ? { slackTeamId: config.teamId } : {}),
    retentionDays: settings.retentionDays,
    settingsRevision: settings.revision,
    channels: channels
      .map(toChannelSummary)
      .sort((left, right) => (left.name ?? left.channelId).localeCompare(right.name ?? right.channelId)),
  }
}

/**
 * Maps a channel to a Team or Project, or unmaps it. Mapping loads the channel's earlier
 * messages; unmapping deletes the stored ones. The caller has checked that the target exists.
 *
 * @param workspaceId - Workspace ID.
 * @param channelId - Channel ID.
 * @param target - New target, or `null` to unmap.
 * @param ports - Ports.
 * @param audit - Audit context of the change.
 * @returns The channel after the change.
 * @throws SlackIngestError `not-found` for a channel the bot has not seen.
 */
export async function updateSlackChannelTarget<AuditContext>(
  workspaceId: string,
  channelId: string,
  target: SlackChannelTarget | null,
  ports: SlackIngestAdminPorts<AuditContext>,
  audit: SlackIngestAuditInput<AuditContext>,
): Promise<SlackChannelSummary> {
  const channel = await ports.store.getChannel(workspaceId, channelId)
  if (!channel) throw new SlackIngestError('not-found', 'SlackChannelNotFound', 'The bot has not joined this channel.')
  const updated = await ports.store.setChannelTarget(
    workspaceId,
    channelId,
    target ?? undefined,
    channel.mappingRevision,
    audit,
  )
  try {
    if (!updated.target) {
      await ports.queue.send({
        kind: 'prune',
        workspaceId,
        channelId,
        mode: 'all',
        mappingRevision: updated.mappingRevision,
      })
    } else if (updated.membership === 'joined') {
      await ports.queue.send({
        kind: 'backfill',
        workspaceId,
        channelId,
        mappingRevision: updated.mappingRevision,
      })
    }
  } catch (error) {
    console.error('Slack ingest job could not be queued after a mapping change.', { channelId, error })
    throw new SlackIngestError(
      'unavailable',
      'SlackIngestQueueUnavailable',
      'The mapping was saved, but loading or deleting messages could not start. Save it again.',
    )
  }
  return toChannelSummary(updated)
}

/**
 * Saves the retention. A shorter retention deletes the stored messages that fall out of it.
 * Saving the same retention again queues that deletion again, so an administrator can retry
 * after a failure that left it unqueued.
 *
 * @param workspaceId - Workspace ID.
 * @param request - New retention and the revision read.
 * @param ports - Ports.
 * @param audit - Audit context of the change.
 * @returns The new retention and revision.
 */
export async function updateSlackIngestSettings<AuditContext>(
  workspaceId: string,
  request: UpdateSlackIngestSettingsRequest,
  ports: SlackIngestAdminPorts<AuditContext>,
  audit: SlackIngestAuditInput<AuditContext>,
): Promise<{ retentionDays: number, settingsRevision: number }> {
  const previous = await ports.store.getSettings(workspaceId)
  const saved = await ports.store.saveSettings(workspaceId, request.retentionDays, request.expectedRevision, audit)
  if (saved.retentionDays <= previous.retentionDays) {
    const channels = await ports.store.listChannels(workspaceId)
    for (const channel of channels) {
      if (!channel.target) continue
      await ports.queue.send({
        kind: 'prune',
        workspaceId,
        channelId: channel.channelId,
        mode: 'expired',
        mappingRevision: channel.mappingRevision,
      })
    }
  }
  return { retentionDays: saved.retentionDays, settingsRevision: saved.revision }
}
