import { SLACK_INGEST_DEFAULT_RETENTION_DAYS, type SlackChannelTarget } from '@mukuroji/contracts'
import { SlackIngestError } from '../../errors'
import type {
  SlackChannelRecord,
  SlackIngestAuditInput,
  SlackIngestSettings,
  SlackIngestStore,
  SlackInstallation,
  SlackMessageRef,
  SlackMessageWriteOutcome,
  StoredSlackMessage,
} from '../../application/ports/slack-ingest-ports'

/** Stored message or tombstone. */
type Entry = {
  /** Message, absent for a tombstone. */
  message?: StoredSlackMessage
  /** Stored version. */
  version: string
}

/**
 * Builds a map key of one message.
 *
 * @param ref - Message.
 * @returns The key.
 */
function refKey(ref: SlackMessageRef): string {
  return `${ref.channelId}#${ref.ts}`
}

/** In-memory Slack ingest store for one process, used by tests and local runs. */
export class InMemorySlackIngestStore implements SlackIngestStore {
  /** Settings by Workspace. */
  readonly settings = new Map<string, SlackIngestSettings>()
  /** Installations by Workspace. */
  readonly installations = new Map<string, SlackInstallation>()
  /** Channels by Workspace and channel. */
  readonly channels = new Map<string, SlackChannelRecord>()
  /** Messages by Workspace, channel, and timestamp. */
  readonly messages = new Map<string, Entry>()
  /** User names by Workspace and user. */
  readonly users = new Map<string, string | null>()
  /** Audit records of administrator changes. */
  readonly audits: { eventType: string, context: unknown }[] = []

  /**
   * Reads the settings.
   *
   * @param workspaceId - Workspace ID.
   * @returns The settings or the defaults.
   */
  async getSettings(workspaceId: string): Promise<SlackIngestSettings> {
    return this.settings.get(workspaceId) ?? { retentionDays: SLACK_INGEST_DEFAULT_RETENTION_DAYS, revision: 0 }
  }

  /**
   * Saves the retention.
   *
   * @param workspaceId - Workspace ID.
   * @param retentionDays - New retention.
   * @param expectedRevision - Revision read.
   * @param audit - Audit input.
   * @returns The saved settings.
   */
  async saveSettings(
    workspaceId: string,
    retentionDays: number,
    expectedRevision: number,
    audit: SlackIngestAuditInput<unknown>,
  ): Promise<SlackIngestSettings> {
    const current = await this.getSettings(workspaceId)
    if (current.revision !== expectedRevision) {
      throw new SlackIngestError('conflict', 'SlackIngestSettingsConflict', 'The settings changed.')
    }
    const saved = { retentionDays, revision: expectedRevision + 1 }
    this.settings.set(workspaceId, saved)
    this.audits.push({ eventType: 'slack_ingest.settings_updated', context: audit.context })
    return saved
  }

  /**
   * Reads the installation.
   *
   * @param workspaceId - Workspace ID.
   * @returns The installation.
   */
  async getInstallation(workspaceId: string): Promise<SlackInstallation | undefined> {
    return this.installations.get(workspaceId)
  }

  /**
   * Saves the installation.
   *
   * @param workspaceId - Workspace ID.
   * @param installation - Installation.
   */
  async putInstallation(workspaceId: string, installation: SlackInstallation): Promise<void> {
    this.installations.set(workspaceId, installation)
  }

  /**
   * Reads a channel.
   *
   * @param workspaceId - Workspace ID.
   * @param channelId - Channel ID.
   * @returns The channel.
   */
  async getChannel(workspaceId: string, channelId: string): Promise<SlackChannelRecord | undefined> {
    const channel = this.channels.get(`${workspaceId}#${channelId}`)
    return channel ? structuredClone(channel) : undefined
  }

  /**
   * Lists channels.
   *
   * @param workspaceId - Workspace ID.
   * @returns Channels.
   */
  async listChannels(workspaceId: string): Promise<SlackChannelRecord[]> {
    return [...this.channels.entries()]
      .filter(([key]) => key.startsWith(`${workspaceId}#`))
      .map(([, channel]) => structuredClone(channel))
  }

  /**
   * Records membership.
   *
   * @param workspaceId - Workspace ID.
   * @param channel - Channel facts.
   * @returns The channel.
   */
  async recordMembership(
    workspaceId: string,
    channel: { channelId: string, name?: string, isPrivate: boolean, membership: 'joined' | 'left', now: string },
  ): Promise<SlackChannelRecord> {
    const existing = this.channels.get(`${workspaceId}#${channel.channelId}`)
    const record: SlackChannelRecord = {
      ...existing,
      channelId: channel.channelId,
      ...(channel.name ? { name: channel.name } : existing?.name ? { name: existing.name } : {}),
      isPrivate: channel.isPrivate,
      membership: channel.membership,
      mappingRevision: existing?.mappingRevision ?? 0,
      updatedAt: channel.now,
    }
    this.channels.set(`${workspaceId}#${channel.channelId}`, record)
    return structuredClone(record)
  }

  /**
   * Changes a mapping.
   *
   * @param workspaceId - Workspace ID.
   * @param channelId - Channel ID.
   * @param target - Target.
   * @param expectedRevision - Revision read.
   * @param audit - Audit input.
   * @returns The channel.
   */
  async setChannelTarget(
    workspaceId: string,
    channelId: string,
    target: SlackChannelTarget | undefined,
    expectedRevision: number,
    audit: SlackIngestAuditInput<unknown>,
  ): Promise<SlackChannelRecord> {
    const existing = this.channels.get(`${workspaceId}#${channelId}`)
    if (!existing) throw new SlackIngestError('not-found', 'SlackChannelNotFound', 'Unknown channel.')
    if (existing.mappingRevision !== expectedRevision) {
      throw new SlackIngestError('conflict', 'SlackChannelMappingConflict', 'The channel changed.')
    }
    const { target: _previousTarget, backfill: _previousBackfill, ...rest } = existing
    const record: SlackChannelRecord = {
      ...rest,
      ...(target ? { target, backfill: { status: 'pending', importedCount: 0 } } : {}),
      mappingRevision: expectedRevision + 1,
      updatedAt: audit.now,
    }
    this.channels.set(`${workspaceId}#${channelId}`, record)
    this.audits.push({ eventType: target ? 'slack_ingest.channel_mapped' : 'slack_ingest.channel_unmapped', context: audit.context })
    return structuredClone(record)
  }

  /**
   * Updates a load.
   *
   * @param workspaceId - Workspace ID.
   * @param channelId - Channel ID.
   * @param mappingRevision - Mapping revision.
   * @param backfill - Load state.
   * @param now - Time.
   * @returns Whether the mapping was current.
   */
  async updateBackfill(
    workspaceId: string,
    channelId: string,
    mappingRevision: number,
    backfill: NonNullable<SlackChannelRecord['backfill']>,
    now: string,
  ): Promise<boolean> {
    const existing = this.channels.get(`${workspaceId}#${channelId}`)
    if (!existing?.target || existing.mappingRevision !== mappingRevision) return false
    this.channels.set(`${workspaceId}#${channelId}`, { ...existing, backfill: { ...backfill }, updatedAt: now })
    return true
  }

  /**
   * Writes a message.
   *
   * @param workspaceId - Workspace ID.
   * @param message - Message.
   * @returns The outcome.
   */
  async putMessage(workspaceId: string, message: StoredSlackMessage): Promise<SlackMessageWriteOutcome> {
    const key = `${workspaceId}#${refKey(message)}`
    const existing = this.messages.get(key)
    if (existing && (!existing.message || existing.version >= message.version)) return 'stale'
    this.messages.set(key, { message: structuredClone(message), version: message.version })
    return 'written'
  }

  /**
   * Deletes a message.
   *
   * @param workspaceId - Workspace ID.
   * @param ref - Message.
   * @param eventTs - Deletion timestamp.
   */
  async deleteMessage(workspaceId: string, ref: SlackMessageRef, eventTs: string): Promise<void> {
    this.messages.set(`${workspaceId}#${refKey(ref)}`, { version: eventTs })
  }

  /**
   * Reads messages.
   *
   * @param workspaceId - Workspace ID.
   * @param refs - Messages.
   * @returns Existing messages.
   */
  async getMessages(workspaceId: string, refs: readonly SlackMessageRef[]): Promise<StoredSlackMessage[]> {
    return refs.flatMap((ref) => {
      const message = this.messages.get(`${workspaceId}#${refKey(ref)}`)?.message
      return message ? [structuredClone(message)] : []
    })
  }

  /**
   * Lists messages by key.
   *
   * @param workspaceId - Workspace ID.
   * @param key - Work Item key.
   * @param limit - Most references.
   * @returns References.
   */
  async listMessageRefsByKey(
    workspaceId: string,
    key: string,
    limit: number,
  ): Promise<{ refs: SlackMessageRef[], truncated: boolean }> {
    const refs = [...this.messages.entries()]
      .filter(([entryKey, entry]) => entryKey.startsWith(`${workspaceId}#`) && entry.message?.keys.includes(key))
      .flatMap(([, entry]) => entry.message ? [{ channelId: entry.message.channelId, ts: entry.message.ts }] : [])
      .sort((left, right) => refKey(left).localeCompare(refKey(right)))
    return { refs: refs.slice(0, limit), truncated: refs.length > limit }
  }

  /**
   * Deletes channel messages.
   *
   * @param workspaceId - Workspace ID.
   * @param channelId - Channel ID.
   * @param beforeTs - Cutoff.
   * @param limit - Most messages.
   * @returns Count and whether none remain.
   */
  async deleteChannelMessages(
    workspaceId: string,
    channelId: string,
    beforeTs: string | undefined,
    limit: number,
  ): Promise<{ deleted: number, done: boolean }> {
    const prefix = `${workspaceId}#${channelId}#`
    const keys = [...this.messages.keys()]
      .filter((key) => key.startsWith(prefix) && (beforeTs === undefined || key.slice(prefix.length) <= beforeTs))
      .sort()
    for (const key of keys.slice(0, limit)) this.messages.delete(key)
    return { deleted: Math.min(limit, keys.length), done: keys.length < limit }
  }

  /**
   * Reads a cached name.
   *
   * @param workspaceId - Workspace ID.
   * @param userId - User ID.
   * @returns The name.
   */
  async getUserName(workspaceId: string, userId: string): Promise<string | null | undefined> {
    const key = `${workspaceId}#${userId}`
    return this.users.has(key) ? this.users.get(key) : undefined
  }

  /**
   * Caches a name.
   *
   * @param workspaceId - Workspace ID.
   * @param userId - User ID.
   * @param name - Name.
   */
  async putUserName(workspaceId: string, userId: string, name: string | null): Promise<void> {
    this.users.set(`${workspaceId}#${userId}`, name)
  }
}
