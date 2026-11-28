/**
 * Contracts of the read-only Slack channel ingest (#828, ADR 0113).
 *
 * An internal Slack app delivers the messages of the channels its bot was invited to. A Workspace
 * administrator maps each channel to a Team or a Project; the mapping decides who can read the
 * stored messages. Slack is never the source of truth for any Mukuroji record.
 */

/** Fewest days a Workspace may keep ingested Slack messages. */
export const SLACK_INGEST_MIN_RETENTION_DAYS = 7

/** Most days a Workspace may keep ingested Slack messages. */
export const SLACK_INGEST_MAX_RETENTION_DAYS = 730

/** Days ingested Slack messages are kept until an administrator changes it. */
export const SLACK_INGEST_DEFAULT_RETENTION_DAYS = 90

/** Most messages one Work Item response lists. */
export const SLACK_WORK_ITEM_MESSAGE_LIMIT = 50

/** Where a Slack channel's messages are visible in Mukuroji. */
export type SlackChannelTarget =
  | {
      /** The channel is read by the viewers of a Team. */
      kind: 'team'
      /** Team ID. */
      teamId: string
    }
  | {
      /** The channel is read by the viewers of one Project. */
      kind: 'project'
      /** Team that owns the Project. */
      teamId: string
      /** Project ID. */
      projectId: string
    }

/** Progress of loading a newly mapped channel's earlier messages. */
export type SlackChannelBackfillStatus = 'pending' | 'running' | 'completed' | 'failed'

/** One Slack channel the bot has joined or was in. */
export type SlackChannelSummary = {
  /** Slack channel ID, such as `C0123456789`. */
  channelId: string
  /** Channel name without `#`, when Slack returned it. */
  name?: string
  /** Whether the channel is private. */
  isPrivate: boolean
  /** Whether the bot is still a member; messages arrive only while it is. */
  membership: 'joined' | 'left'
  /** Team or Project that reads the channel; unmapped channels are not stored. */
  target?: SlackChannelTarget
  /** Earlier-message load of the current mapping. */
  backfill?: {
    /** Load state. */
    status: SlackChannelBackfillStatus
    /** Messages and thread replies loaded so far. */
    importedCount: number
  }
  /** ISO 8601 time the channel row last changed. */
  updatedAt: string
}

/** Response of `GET /api/workspace/slack-ingest`. */
export type SlackIngestStatusResponse = {
  /** Whether the deployment has a Slack app secret for this Workspace. */
  configured: boolean
  /** Workspace ID an operator puts in the Slack app secret. */
  workspaceId: string
  /** Slack team the secret names, when configured. */
  slackTeamId?: string
  /** Days messages are kept. */
  retentionDays: number
  /** Settings revision for the retention update. */
  settingsRevision: number
  /** Channels the bot has joined, by name. */
  channels: SlackChannelSummary[]
}

/** Body of `PUT /api/workspace/slack-ingest/channels/:channelId/target`. */
export type UpdateSlackChannelTargetRequest = {
  /** New Team or Project, or `null` to stop ingesting and delete the stored messages. */
  target: SlackChannelTarget | null
}

/** Body of `PUT /api/workspace/slack-ingest/settings`. */
export type UpdateSlackIngestSettingsRequest = {
  /** Days messages are kept. */
  retentionDays: number
  /** Revision the caller read. */
  expectedRevision: number
}

/** One stored Slack message as a reader sees it. */
export type SlackMessageView = {
  /** Slack channel ID. */
  channelId: string
  /** Channel name, when known. */
  channelName?: string
  /** Slack message timestamp, which is its ID within the channel. */
  ts: string
  /** Parent message timestamp for a thread reply. */
  threadTs?: string
  /** Slack user ID of the author. */
  authorId: string
  /** Author display name, when Slack returned it. */
  authorName?: string
  /** Message text in Slack mrkdwn. */
  text: string
  /** ISO 8601 time the message was posted. */
  postedAt: string
  /** ISO 8601 time the message was last edited. */
  editedAt?: string
  /** Link that opens the message in Slack. */
  permalink: string
}

/** Response of `GET /api/teams/:teamId/issues/:issueId/slack-messages`. */
export type WorkItemSlackMessagesResponse = {
  /** Messages that mention the Work Item key, newest first. */
  messages: SlackMessageView[]
  /** Whether older matching messages were left out. */
  truncated: boolean
}

/** Slack channel ID shape: an uppercase letter and 8 to 20 uppercase letters or digits. */
const SLACK_CHANNEL_ID_PATTERN = /^[CG][A-Z0-9]{8,20}$/u

/** Directory ID shape accepted in a target. */
const DIRECTORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u

/**
 * Reports whether a value is a Slack public or private channel ID.
 *
 * @param value - Untrusted value.
 * @returns Whether the value is a channel ID.
 */
export function isSlackChannelId(value: unknown): value is string {
  return typeof value === 'string' && SLACK_CHANNEL_ID_PATTERN.test(value)
}

/**
 * Reports whether a value is an object that is not an array.
 *
 * @param value - Untrusted value.
 * @returns Whether the value is a plain record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads a directory ID field.
 *
 * @param value - Untrusted value.
 * @param name - Field name used in the error.
 * @returns The ID.
 * @throws TypeError when the value is not a directory ID.
 */
function readDirectoryId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !DIRECTORY_ID_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a Team or Project ID.`)
  }
  return value
}

/**
 * Parses a channel target.
 *
 * @param value - Untrusted value.
 * @returns The target.
 * @throws TypeError when the value is not a Team or Project target.
 */
export function parseSlackChannelTarget(value: unknown): SlackChannelTarget {
  if (!isRecord(value)) throw new TypeError('target must be an object.')
  const teamId = readDirectoryId(value.teamId, 'target.teamId')
  if (value.kind === 'team') return { kind: 'team', teamId }
  if (value.kind === 'project') {
    return { kind: 'project', teamId, projectId: readDirectoryId(value.projectId, 'target.projectId') }
  }
  throw new TypeError('target.kind must be team or project.')
}

/**
 * Parses the body of a channel target update.
 *
 * @param value - Parsed JSON body.
 * @returns The request.
 * @throws TypeError when the body is invalid.
 */
export function parseUpdateSlackChannelTargetRequest(value: unknown): UpdateSlackChannelTargetRequest {
  if (!isRecord(value) || !('target' in value)) throw new TypeError('target is required.')
  return { target: value.target === null ? null : parseSlackChannelTarget(value.target) }
}

/**
 * Reports whether a value is an allowed retention in days.
 *
 * @param value - Untrusted value.
 * @returns Whether the value is a whole number of days within the bounds.
 */
export function isSlackIngestRetentionDays(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= SLACK_INGEST_MIN_RETENTION_DAYS &&
    value <= SLACK_INGEST_MAX_RETENTION_DAYS
}

/**
 * Parses the body of a settings update.
 *
 * @param value - Parsed JSON body.
 * @returns The request.
 * @throws TypeError when the body is invalid.
 */
export function parseUpdateSlackIngestSettingsRequest(value: unknown): UpdateSlackIngestSettingsRequest {
  if (!isRecord(value)) throw new TypeError('A settings body is required.')
  if (!isSlackIngestRetentionDays(value.retentionDays)) {
    throw new TypeError(
      `retentionDays must be a whole number from ${SLACK_INGEST_MIN_RETENTION_DAYS} to ${SLACK_INGEST_MAX_RETENTION_DAYS}.`,
    )
  }
  const expectedRevision = value.expectedRevision
  if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new TypeError('expectedRevision must be a non-negative integer.')
  }
  return { retentionDays: value.retentionDays, expectedRevision }
}
