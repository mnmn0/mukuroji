import { createHash } from 'node:crypto'
import {
  AGENT_ACTIVITY_MAX_WAIT_MS,
  AGENT_RUN_ACTIVITY_MAX_TOOLS,
  type AgentRunActivity,
  type AgentToolActivity,
  type AgentToolKind,
} from '@mukuroji/contracts'

/** Longest tool or skill name kept; longer names are cut. */
const maximumToolNameLength = 128

/** Largest `tool_parameters` JSON string the receiver parses for MCP server, tool, and skill names. */
const maximumToolParametersLength = 16 * 1024

/** Decision sources of a tool permission that a person chose, as Claude Code reports them. */
const personDecisionSources: ReadonlySet<string> = new Set(['user_permanent', 'user_temporary', 'user_reject', 'user_abort'])

/** Kinds of activity event the receiver reads besides model request usage. */
export type AgentActivityEventKind = 'request' | 'error' | 'tool' | 'decision' | 'prompt'

/**
 * One telemetry event that places the agent's session on a timeline (ADR 0117). Only names, times,
 * durations, and outcomes are kept; prompts, tool input, and tool output never reach this type.
 */
export type AgentActivityEvent = {
  /** Kind of event. */
  kind: AgentActivityEventKind
  /** SHA-256 of the agent instance ID, or `unknown`. */
  instanceIdHash: string
  /** Event time in epoch milliseconds. */
  occurredAtMs: number
  /** Per-process event order the runtime sent, used to order events with the same time. */
  sequence?: number
  /** Hash of the runtime session ID, when the event named one. */
  sessionHash?: string
  /** Tool kind and name of a `tool` event. */
  tool?: { kind: AgentToolKind; name: string }
  /** Milliseconds a `tool` call ran. */
  durationMs?: number
  /** Whether a `tool` call failed. */
  failed?: boolean
  /** Whether a person made a `decision`, rather than a setting, a hook, or a classifier. */
  byPerson?: boolean
}

/** Kind of an activity row: tool time, or an estimated wait for a person. */
export type AgentActivityRowKind = 'tool' | 'wait'

/** Kinds of wait the receiver estimates. */
export type AgentWaitKind = 'approval' | 'prompt'

/** Activity added together for one member, agent instance, bucket, and tool or wait kind. */
export type AgentActivityRow = {
  /** Bucket start as an ISO 8601 UTC timestamp with second precision. */
  bucketStart: string
  /** SHA-256 of the agent instance ID, or `unknown`. */
  instanceIdHash: string
  /** Row kind. */
  kind: AgentActivityRowKind
  /** `<tool kind>:<tool name>` for a tool row, or the {@link AgentWaitKind} for a wait row. */
  name: string
  /** Tool calls or waits. */
  count: number
  /** Milliseconds the calls ran or the waits lasted. */
  durationMs: number
  /** Tool calls that failed; always 0 for a wait row. */
  failureCount: number
}

/** Last event time of one runtime session, used to measure the wait before its next prompt or decision. */
export type AgentSessionCursor = {
  /** `<instance hash>#<session hash>`. */
  sessionKey: string
  /** Time of the session's newest event the receiver saw, in epoch milliseconds. */
  lastEventAtMs: number
}

/**
 * Wait rows and cursor moves one export may save in its single wait transaction, next to its receipt;
 * DynamoDB allows 100 items. An export with more saves no waits (ADR 0117).
 */
export const AGENT_ACTIVITY_MAX_WAIT_ITEMS = 99

/** A cursor move that holds only while the cursor still has the value the waits were measured from. */
export type AgentSessionCursorClaim = AgentSessionCursor & {
  /** Cursor value read before measuring; absent when the session had no cursor. */
  previousLastEventAtMs?: number
}

/**
 * Hashes a runtime session ID, so the raw ID is never stored.
 *
 * @param sessionId - Session ID the runtime sent.
 * @returns The first 32 hexadecimal characters of its SHA-256 digest.
 */
export function hashAgentSessionId(sessionId: string): string {
  return createHash('sha256').update(`agent-session\u0000${sessionId}`).digest('hex').slice(0, 32)
}

/**
 * Builds the key of a session cursor.
 *
 * @param event - Event that names an instance and a session.
 * @returns `<instance hash>#<session hash>`, or undefined when the event names no session.
 */
export function agentSessionKey(event: Pick<AgentActivityEvent, 'instanceIdHash' | 'sessionHash'>): string | undefined {
  return event.sessionHash === undefined ? undefined : `${event.instanceIdHash}#${event.sessionHash}`
}

/**
 * Removes control characters and key separators from a tool name.
 *
 * @param value - Raw name.
 * @returns A trimmed name, or undefined when nothing is left.
 */
function cleanToolName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.replace(/[\p{Cc}#]/gu, '').trim().slice(0, maximumToolNameLength)
  return name === '' ? undefined : name
}

/**
 * Reads the MCP server, MCP tool, and skill names from the `tool_parameters` JSON string. Every other
 * key, including Bash commands, is dropped without being kept.
 *
 * @param value - `tool_parameters` attribute, when present.
 * @returns The names that were present.
 */
function readToolParameterNames(value: unknown): { mcpServer?: string; mcpTool?: string; skill?: string } {
  if (typeof value !== 'string' || value.length > maximumToolParametersLength) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const mcpServer = cleanToolName(Reflect.get(parsed, 'mcp_server_name'))
  const mcpTool = cleanToolName(Reflect.get(parsed, 'mcp_tool_name'))
  const skill = cleanToolName(Reflect.get(parsed, 'skill_name'))
  return {
    ...(mcpServer === undefined ? {} : { mcpServer }),
    ...(mcpTool === undefined ? {} : { mcpTool }),
    ...(skill === undefined ? {} : { skill }),
  }
}

/**
 * Classifies a tool call by kind and name (ADR 0117). MCP tools are named `<server>/<tool>` and
 * skills by their skill name; without tool details from the runtime, an MCP tool of a user-configured
 * server stays `mcp/unknown` and a skill stays the built-in `Skill` tool.
 *
 * @param toolName - `tool_name` attribute.
 * @param attributes - Other attributes that may carry MCP or skill names.
 * @returns The tool kind and name, or undefined when the event names no tool.
 */
export function classifyAgentTool(
  toolName: unknown,
  attributes: { toolParameters?: unknown; mcpServerName?: unknown; mcpToolName?: unknown; skillName?: unknown },
): { kind: AgentToolKind; name: string } | undefined {
  const name = cleanToolName(toolName)
  if (name === undefined) return undefined
  const parameters = readToolParameterNames(attributes.toolParameters)
  const mcpServer = cleanToolName(attributes.mcpServerName) ?? parameters.mcpServer
  const mcpTool = cleanToolName(attributes.mcpToolName) ?? parameters.mcpTool
  if (mcpServer !== undefined) return { kind: 'mcp', name: `${mcpServer}/${mcpTool ?? 'unknown'}`.slice(0, maximumToolNameLength) }
  if (name.startsWith('mcp__')) {
    const [server, ...rest] = name.slice('mcp__'.length).split('__')
    const tool = rest.join('__')
    return { kind: 'mcp', name: `${server === '' || server === undefined ? 'unknown' : server}/${tool === '' ? 'unknown' : tool}` }
  }
  if (name === 'mcp_tool') return { kind: 'mcp', name: 'unknown/unknown' }
  const skill = cleanToolName(attributes.skillName) ?? parameters.skill
  if (name === 'Skill' && skill !== undefined) return { kind: 'skill', name: skill }
  return { kind: 'builtin', name }
}

/**
 * Checks whether a permission decision was a person's choice.
 *
 * @param source - `source` or `decision_source` attribute.
 * @returns True for `user_permanent`, `user_temporary`, `user_reject`, and `user_abort`.
 */
export function isPersonDecisionSource(source: unknown): boolean {
  return typeof source === 'string' && personDecisionSources.has(source)
}

/**
 * Formats the start of the bucket that holds a time. Mirrors the usage buckets so a run reads both
 * with the same range.
 *
 * @param epochMs - Time in epoch milliseconds.
 * @param bucketSeconds - Bucket length in seconds.
 * @returns Bucket start such as `2026-11-22T17:05:10Z`.
 */
function bucketStartOf(epochMs: number, bucketSeconds: number): string {
  const bucketMs = bucketSeconds * 1_000
  return `${new Date(Math.floor(epochMs / bucketMs) * bucketMs).toISOString().slice(0, 19)}Z`
}

/**
 * Builds the key that identifies an activity row within a member's activity.
 *
 * @param row - Row identity.
 * @returns `<bucket start>#<instance hash>#<kind>#<name>`.
 */
export function agentActivityRowKey(row: Pick<AgentActivityRow, 'bucketStart' | 'instanceIdHash' | 'kind' | 'name'>): string {
  return `${row.bucketStart}#${row.instanceIdHash}#${row.kind}#${row.name}`
}

/**
 * Orders events of one session by time, then by the runtime's sequence.
 *
 * @param left - First event.
 * @param right - Second event.
 * @returns Sort order.
 */
function byTimeThenSequence(left: AgentActivityEvent, right: AgentActivityEvent): number {
  return left.occurredAtMs - right.occurredAtMs || (left.sequence ?? 0) - (right.sequence ?? 0)
}

/**
 * Returns the row a wait event would add to, when the event can start a wait at all.
 *
 * @param event - Activity event.
 * @returns The wait kind, or undefined for events that never end a wait.
 */
function waitKindOf(event: AgentActivityEvent): AgentWaitKind | undefined {
  if (event.kind === 'prompt') return 'prompt'
  if (event.kind === 'decision' && event.byPerson === true) return 'approval'
  return undefined
}

/** Activity rows of one export and the session cursors to move forward after they are saved. */
export type AgentActivityLayout = {
  /**
   * One slot per row the export's well-formed events could add to, tool rows first and then wait rows,
   * each in key order: the accepted row, or undefined. The slots depend only on the export, so a retry
   * keeps its chunk layout.
   */
  slots: (AgentActivityRow | undefined)[]
  /** Number of leading tool slots; the rest are wait slots. */
  toolSlotCount: number
  /** Sessions among the well-formed events; independent of the cursors, like the slots. */
  sessionCount: number
  /** Newest event time per session among the accepted events. */
  cursors: AgentSessionCursor[]
}

/**
 * Adds an export's activity events into rows (ADR 0117). Tool calls add their time; a prompt, or a
 * permission decision a person made, adds the gap from the session's previous event as a wait. The
 * previous event is the newest earlier event of the same session in the export, or else the stored
 * cursor of the session. Gaps longer than {@link AGENT_ACTIVITY_MAX_WAIT_MS} are not counted.
 *
 * @param wellFormedEvents - Well-formed activity events, inside the time window or not.
 * @param acceptedEvents - Accepted activity events, a subset of the well-formed ones.
 * @param storedCursors - Stored last event time per session key.
 * @param bucketSeconds - Bucket length in seconds.
 * @returns Row slots and the cursors to save.
 */
export function layoutAgentActivityRows(
  wellFormedEvents: readonly AgentActivityEvent[],
  acceptedEvents: readonly AgentActivityEvent[],
  storedCursors: ReadonlyMap<string, number>,
  bucketSeconds: number,
): AgentActivityLayout {
  const slotKeys = new Map<string, Pick<AgentActivityRow, 'bucketStart' | 'instanceIdHash' | 'kind' | 'name'>>()
  for (const event of wellFormedEvents) {
    const identity = rowIdentityOf(event, bucketSeconds)
    if (identity) slotKeys.set(agentActivityRowKey(identity), identity)
  }
  const rows = new Map<string, AgentActivityRow>()
  /**
   * Adds one amount to a row.
   * @param identity - Row identity.
   * @param durationMs - Milliseconds to add.
   * @param failed - Whether a tool call failed.
   */
  const add = (identity: Pick<AgentActivityRow, 'bucketStart' | 'instanceIdHash' | 'kind' | 'name'>, durationMs: number, failed: boolean) => {
    const key = agentActivityRowKey(identity)
    const row = rows.get(key) ?? { ...identity, count: 0, durationMs: 0, failureCount: 0 }
    row.count += 1
    row.durationMs += durationMs
    if (failed) row.failureCount += 1
    rows.set(key, row)
  }
  const sessions = new Map<string, AgentActivityEvent[]>()
  for (const event of acceptedEvents) {
    if (event.kind === 'tool' && event.tool !== undefined) {
      const identity = rowIdentityOf(event, bucketSeconds)
      if (identity) add(identity, event.durationMs ?? 0, event.failed === true)
    }
    const sessionKey = agentSessionKey(event)
    if (sessionKey === undefined) continue
    const list = sessions.get(sessionKey) ?? []
    list.push(event)
    sessions.set(sessionKey, list)
  }
  const cursors: AgentSessionCursor[] = []
  for (const [sessionKey, events] of [...sessions.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    let previous = storedCursors.get(sessionKey)
    const stored = previous
    for (const event of events.sort(byTimeThenSequence)) {
      const waitKind = waitKindOf(event)
      if (waitKind !== undefined && previous !== undefined) {
        const gap = event.occurredAtMs - previous
        if (gap > 0 && gap <= AGENT_ACTIVITY_MAX_WAIT_MS) {
          add({
            bucketStart: bucketStartOf(event.occurredAtMs, bucketSeconds),
            instanceIdHash: event.instanceIdHash,
            kind: 'wait',
            name: waitKind,
          }, gap, false)
        }
      }
      previous = previous === undefined ? event.occurredAtMs : Math.max(previous, event.occurredAtMs)
    }
    if (previous !== undefined && (stored === undefined || previous > stored)) cursors.push({ sessionKey, lastEventAtMs: previous })
  }
  const keys = [...slotKeys.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  const toolKeys = keys.filter(([, identity]) => identity.kind !== 'wait').map(([key]) => key)
  const waitKeys = keys.filter(([, identity]) => identity.kind === 'wait').map(([key]) => key)
  const sessionCount = new Set(wellFormedEvents.flatMap((event) => {
    const key = agentSessionKey(event)
    return key === undefined ? [] : [key]
  })).size
  return { slots: [...toolKeys, ...waitKeys].map((key) => rows.get(key)), toolSlotCount: toolKeys.length, sessionCount, cursors }
}

/**
 * Returns the row an event adds to, independent of the session cursor.
 *
 * @param event - Activity event.
 * @param bucketSeconds - Bucket length in seconds.
 * @returns The row identity, or undefined for events that add to no row.
 */
function rowIdentityOf(event: AgentActivityEvent, bucketSeconds: number): Pick<AgentActivityRow, 'bucketStart' | 'instanceIdHash' | 'kind' | 'name'> | undefined {
  const bucketStart = bucketStartOf(event.occurredAtMs, bucketSeconds)
  if (event.kind === 'tool' && event.tool !== undefined) {
    return { bucketStart, instanceIdHash: event.instanceIdHash, kind: 'tool', name: `${event.tool.kind}:${event.tool.name}` }
  }
  // A wait slot exists for every event that could end a wait, whether or not a gap is known, so the
  // slots do not move when a retry reads a newer cursor.
  const waitKind = event.sessionHash === undefined ? undefined : waitKindOf(event)
  return waitKind === undefined ? undefined : { bucketStart, instanceIdHash: event.instanceIdHash, kind: 'wait', name: waitKind }
}

/**
 * Derives a stable ID for the activity of one export, so a retried export adds nothing twice.
 *
 * @param memberKey - Member that sent the export.
 * @param events - Well-formed activity events in export order.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
export function deriveAgentActivityBatchId(memberKey: string, events: readonly AgentActivityEvent[]): string {
  const hash = createHash('sha256').update(`agent-activity-batch\u0000${memberKey}`)
  for (const event of events) {
    hash.update([
      '',
      event.kind,
      event.instanceIdHash,
      String(event.occurredAtMs),
      String(event.sequence ?? ''),
      event.sessionHash ?? '',
      event.tool === undefined ? '' : `${event.tool.kind}:${event.tool.name}`,
      String(event.durationMs ?? ''),
      event.failed === true ? '1' : '0',
      event.byPerson === true ? '1' : '0',
    ].join('\u0000'))
  }
  return hash.digest('hex')
}

/**
 * Splits a stored tool row name into its kind and name.
 *
 * @param name - `<tool kind>:<tool name>`.
 * @returns Kind and name, or undefined when the name is malformed.
 */
export function parseAgentToolRowName(name: string): { kind: AgentToolKind; name: string } | undefined {
  const separator = name.indexOf(':')
  if (separator <= 0) return undefined
  const kind = name.slice(0, separator)
  const tool = name.slice(separator + 1)
  if ((kind !== 'builtin' && kind !== 'mcp' && kind !== 'skill') || tool === '') return undefined
  return { kind, name: tool }
}

/**
 * Orders tools with the longest total time first, then by kind and name.
 *
 * @param left - First tool.
 * @param right - Second tool.
 * @returns Sort order.
 */
function byDurationThenName(left: AgentToolActivity, right: AgentToolActivity): number {
  const difference = right.durationMs - left.durationMs
  if (difference !== 0) return difference
  const leftKey = `${left.kind}:${left.name}`
  const rightKey = `${right.kind}:${right.name}`
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
}

/**
 * Adds activity rows together for a response.
 *
 * @param rows - Rows of one run.
 * @param hasMore - Whether more rows existed than were read.
 * @param maxTools - Largest number of tools to list; a caller that adds runs together passes no limit and cuts afterwards.
 * @returns The activity, or undefined when nothing was found and nothing was left unread.
 */
export function summarizeAgentActivity(
  rows: readonly AgentActivityRow[],
  hasMore: boolean,
  maxTools: number = AGENT_RUN_ACTIVITY_MAX_TOOLS,
): AgentRunActivity | undefined {
  if (rows.length === 0 && !hasMore) return undefined
  const tools = new Map<string, AgentToolActivity>()
  const activity: AgentRunActivity = {
    toolCount: 0,
    toolDurationMs: 0,
    toolFailureCount: 0,
    tools: [],
    approvalWait: { count: 0, durationMs: 0 },
    promptWait: { count: 0, durationMs: 0 },
    hasMore,
  }
  for (const row of rows) {
    if (row.kind === 'wait') {
      const wait = row.name === 'approval' ? activity.approvalWait : row.name === 'prompt' ? activity.promptWait : undefined
      if (!wait) continue
      wait.count += row.count
      wait.durationMs += row.durationMs
      continue
    }
    const tool = parseAgentToolRowName(row.name)
    if (!tool) continue
    const key = `${tool.kind}:${tool.name}`
    const saved = tools.get(key) ?? { ...tool, count: 0, durationMs: 0, failureCount: 0 }
    saved.count += row.count
    saved.durationMs += row.durationMs
    saved.failureCount += row.failureCount
    tools.set(key, saved)
    activity.toolCount += row.count
    activity.toolDurationMs += row.durationMs
    activity.toolFailureCount += row.failureCount
  }
  activity.tools = [...tools.values()].sort(byDurationThenName).slice(0, maxTools)
  return activity
}

/**
 * Adds run activity summaries together.
 *
 * @param activities - Activity of individual runs.
 * @param maxTools - Largest number of tools to list.
 * @returns The combined activity, or undefined when no run has activity.
 */
export function combineAgentRunActivity(
  activities: readonly (AgentRunActivity | undefined)[],
  maxTools: number = AGENT_RUN_ACTIVITY_MAX_TOOLS,
): AgentRunActivity | undefined {
  const present = activities.filter((activity): activity is AgentRunActivity => activity !== undefined)
  if (present.length === 0) return undefined
  const tools = new Map<string, AgentToolActivity>()
  for (const activity of present) {
    for (const tool of activity.tools) {
      const key = `${tool.kind}:${tool.name}`
      const saved = tools.get(key) ?? { kind: tool.kind, name: tool.name, count: 0, durationMs: 0, failureCount: 0 }
      saved.count += tool.count
      saved.durationMs += tool.durationMs
      saved.failureCount += tool.failureCount
      tools.set(key, saved)
    }
  }
  return {
    toolCount: present.reduce((sum, activity) => sum + activity.toolCount, 0),
    toolDurationMs: present.reduce((sum, activity) => sum + activity.toolDurationMs, 0),
    toolFailureCount: present.reduce((sum, activity) => sum + activity.toolFailureCount, 0),
    tools: [...tools.values()].sort(byDurationThenName).slice(0, maxTools),
    approvalWait: {
      count: present.reduce((sum, activity) => sum + activity.approvalWait.count, 0),
      durationMs: present.reduce((sum, activity) => sum + activity.approvalWait.durationMs, 0),
    },
    promptWait: {
      count: present.reduce((sum, activity) => sum + activity.promptWait.count, 0),
      durationMs: present.reduce((sum, activity) => sum + activity.promptWait.durationMs, 0),
    },
    hasMore: present.some((activity) => activity.hasMore),
  }
}
