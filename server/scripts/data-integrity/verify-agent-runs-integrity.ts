import { randomUUID } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { fromIni } from '@aws-sdk/credential-provider-ini'
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import {
  assertAgentRunIntegrityBounds,
  runAgentRunsIntegrityCheck,
  type AgentRunIntegrityBounds,
  type AgentRunIntegrityClient,
  type AgentRunIntegrityEvidence,
  type AgentRunIntegrityTeam,
  type AgentRunWorkItemLookup,
  type AgentRunWorkItemState,
} from '../../src/modules/agent-runs'

/** Flags the `check` command accepts; `--team` may repeat. */
const checkFlagNames = new Set([
  '--correlation-id',
  '--max-items',
  '--max-pages',
  '--page-size',
  '--profile',
  '--region',
  '--table',
  '--team',
  '--work-items-table',
])

/** Usage printed by `help`. */
const helpPayload = {
  status: 'help',
  commands: [
    'bun run --silent agent-runs:integrity -- check --region <region> --table <table> [--profile <profile>] [--team <workspaceId>/<teamId> ...] [--work-items-table <table>] --page-size <n> --max-pages <n> --max-items <n> [--correlation-id <id>]',
    'bun run --silent agent-runs:integrity -- help',
  ],
}

/** Exit status: 0 pass, 1 broken or incomplete, 2 usage or read error. */
type AgentRunsIntegrityCliExitCode = 0 | 1 | 2

/** Validated `check` arguments. */
export type AgentRunsIntegrityCheckArguments = {
  /** Command name. */
  command: 'check'
  /** AWS Region. */
  region: string
  /** Agent Run table name. */
  tableName: string
  /** Work Items table name; when present, the Work Item of each active run is read too. */
  workItemsTableName?: string
  /** Named credential profile; the default chain when absent. */
  profile?: string
  /** Teams to check; every Team is discovered when absent. */
  teams?: AgentRunIntegrityTeam[]
  /** Read ceilings. */
  bounds: AgentRunIntegrityBounds
  /** ID that joins the evidence with logs; generated when absent. */
  correlationId?: string
}

/** Validated CLI arguments. */
export type AgentRunsIntegrityCliArguments = AgentRunsIntegrityCheckArguments | {
  /** Command name. */
  command: 'help'
}

/** Injectable resources of the CLI. */
export type AgentRunsIntegrityCliDependencies = {
  /**
   * Creates the DynamoDB client of a check.
   * @param configuration - Validated `check` arguments.
   * @returns Client limited to Query, Scan, and Get.
   */
  createClient(configuration: AgentRunsIntegrityCheckArguments): AgentRunIntegrityClient
  /**
   * Reads the current time.
   * @returns Now.
   */
  now(): Date
  /**
   * Writes one line of standard output.
   * @param line - Line without its newline.
   */
  writeOut(line: string): void
  /**
   * Writes one line of standard error.
   * @param line - Line without its newline.
   */
  writeError(line: string): void
}

/** Usage error whose message is safe to print. */
class AgentRunsIntegrityUsageError extends Error {
  /**
   * Creates a usage error.
   * @param message - Safe description that never echoes argument values.
   */
  constructor(message: string) {
    super(message)
    this.name = 'AgentRunsIntegrityUsageError'
  }
}

/**
 * Checks for terminal control characters in an operator argument.
 *
 * @param value - Untrusted argument value.
 * @returns True when the value contains an ASCII control character.
 */
function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true
  }
  return false
}

/**
 * Parses a positive integer flag.
 *
 * @param flags - Parsed flags.
 * @param name - Flag name.
 * @returns The integer.
 */
function requireInteger(flags: ReadonlyMap<string, string[]>, name: string): number {
  const value = requireSingle(flags, name)
  if (!/^[1-9][0-9]{0,6}$/u.test(value)) throw new AgentRunsIntegrityUsageError(`${name} must be a positive integer.`)
  return Number(value)
}

/**
 * Reads a flag that must appear exactly once.
 *
 * @param flags - Parsed flags.
 * @param name - Flag name.
 * @returns The value.
 */
function requireSingle(flags: ReadonlyMap<string, string[]>, name: string): string {
  const value = optionalSingle(flags, name)
  if (value === undefined) throw new AgentRunsIntegrityUsageError(`${name} is required.`)
  return value
}

/**
 * Reads a flag that may appear at most once.
 *
 * @param flags - Parsed flags.
 * @param name - Flag name.
 * @returns The value or undefined.
 */
function optionalSingle(flags: ReadonlyMap<string, string[]>, name: string): string | undefined {
  const values = flags.get(name) ?? []
  if (values.length > 1) throw new AgentRunsIntegrityUsageError(`${name} must appear once.`)
  const value = values[0]
  if (value === undefined) return undefined
  if (value.trim().length === 0 || containsControlCharacter(value)) {
    throw new AgentRunsIntegrityUsageError(`${name} must not be blank or contain control characters.`)
  }
  return value
}

/**
 * Parses a `--team <workspaceId>/<teamId>` value.
 *
 * @param value - Flag value.
 * @returns The Team.
 */
function parseTeamFlag(value: string): AgentRunIntegrityTeam {
  const parts = value.split('/')
  const [directoryId, teamId] = parts
  if (parts.length !== 2 || !directoryId || !teamId || containsControlCharacter(value)) {
    throw new AgentRunsIntegrityUsageError('--team must be <workspaceId>/<teamId>.')
  }
  return { directoryId, teamId }
}

/**
 * Parses strict CLI arguments without consulting environment variables.
 *
 * @param arguments_ - Arguments after the script path.
 * @returns Validated arguments.
 */
export function parseAgentRunsIntegrityCliArguments(arguments_: readonly string[]): AgentRunsIntegrityCliArguments {
  const [command, ...rest] = arguments_
  if (command === 'help' || command === '--help') {
    if (rest.length > 0) throw new AgentRunsIntegrityUsageError('help takes no arguments.')
    return { command: 'help' }
  }
  if (command !== 'check') throw new AgentRunsIntegrityUsageError('The command must be check or help.')
  if (rest.length % 2 !== 0) throw new AgentRunsIntegrityUsageError('Every flag needs a value.')
  const flags = new Map<string, string[]>()
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index]
    const value = rest[index + 1]
    if (name === undefined || value === undefined || !checkFlagNames.has(name)) {
      throw new AgentRunsIntegrityUsageError('Unknown flag.')
    }
    flags.set(name, [...(flags.get(name) ?? []), value])
  }
  const region = requireSingle(flags, '--region')
  if (!/^[a-z]{2}(-[a-z]+)+-[0-9]$/u.test(region)) throw new AgentRunsIntegrityUsageError('--region is not an AWS Region.')
  const tableName = requireSingle(flags, '--table')
  if (!/^[A-Za-z0-9_.-]{3,255}$/u.test(tableName)) throw new AgentRunsIntegrityUsageError('--table is not a DynamoDB table name.')
  const bounds = {
    pageSize: requireInteger(flags, '--page-size'),
    maxPages: requireInteger(flags, '--max-pages'),
    maxItems: requireInteger(flags, '--max-items'),
  }
  try {
    assertAgentRunIntegrityBounds(bounds)
  } catch (error) {
    throw new AgentRunsIntegrityUsageError(error instanceof RangeError ? error.message : 'The bounds are invalid.')
  }
  const workItemsTableName = optionalSingle(flags, '--work-items-table')
  if (workItemsTableName !== undefined && !/^[A-Za-z0-9_.-]{3,255}$/u.test(workItemsTableName)) {
    throw new AgentRunsIntegrityUsageError('--work-items-table is not a DynamoDB table name.')
  }
  const teamValues = flags.get('--team')
  const teams = teamValues?.map(parseTeamFlag)
  const profile = optionalSingle(flags, '--profile')
  const correlationId = optionalSingle(flags, '--correlation-id')
  return {
    command: 'check',
    region,
    tableName,
    bounds,
    ...(workItemsTableName === undefined ? {} : { workItemsTableName }),
    ...(profile === undefined ? {} : { profile }),
    ...(teams === undefined ? {} : { teams }),
    ...(correlationId === undefined ? {} : { correlationId }),
  }
}

/**
 * Creates a DynamoDB document client for the selected Region and profile. The SDK's own endpoint
 * configuration, such as `AWS_ENDPOINT_URL` for an emulator, applies as usual.
 *
 * @param configuration - Validated `check` arguments.
 * @returns Document client.
 */
function createDefaultClient(configuration: AgentRunsIntegrityCheckArguments): AgentRunIntegrityClient {
  const client = new DynamoDBClient({
    region: configuration.region,
    ...(configuration.profile === undefined ? {} : { credentials: fromIni({ profile: configuration.profile }) }),
  })
  return DynamoDBDocumentClient.from(client)
}

/**
 * Checks that a value is a parseable timestamp string.
 *
 * @param value - Untrusted attribute value.
 * @returns True for a non-empty string that `Date.parse` accepts.
 */
function isTimestampAttribute(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))
}

/**
 * Creates the Work Item lookup of a check. It reads only the key, creation time, and archive time
 * of one Work Items row with a strongly consistent Get, so no title or member reaches the check.
 *
 * @param client - Client that sends the Get.
 * @param tableName - Work Items table name.
 * @returns Lookup for the check.
 */
export function createWorkItemLookup(client: AgentRunIntegrityClient, tableName: string): AgentRunWorkItemLookup {
  return {
    async read({ directoryId, teamId, workItemId }): Promise<AgentRunWorkItemState> {
      const response = await client.send(new GetCommand({
        TableName: tableName,
        Key: { directoryTeamId: `${directoryId}#team#${teamId}`, issueId: workItemId },
        ConsistentRead: true,
        ProjectionExpression: '#issueId, #createdAt, #archivedAt',
        ExpressionAttributeNames: { '#issueId': 'issueId', '#createdAt': 'createdAt', '#archivedAt': 'archivedAt' },
      }))
      const item = response.Item
      if (item === undefined) return { kind: 'missing' }
      if (item.issueId !== workItemId || !isTimestampAttribute(item.createdAt)) return { kind: 'malformed' }
      // Unarchiving removes the attribute, so any stored value must be a timestamp.
      if (item.archivedAt !== undefined && !isTimestampAttribute(item.archivedAt)) return { kind: 'malformed' }
      return { kind: 'present', createdAt: item.createdAt, archived: item.archivedAt !== undefined }
    },
  }
}

/** Production resources of the CLI. */
const defaultDependencies: AgentRunsIntegrityCliDependencies = {
  createClient: createDefaultClient,
  now: () => new Date(),
  writeOut: (line) => console.log(line),
  writeError: (line) => console.error(line),
}

/**
 * Chooses the exit status of a finished check.
 *
 * @param evidence - Evidence of the check.
 * @returns 0 only for a complete check without violations.
 */
function exitCodeOf(evidence: AgentRunIntegrityEvidence): AgentRunsIntegrityCliExitCode {
  return evidence.status === 'pass' ? 0 : 1
}

/**
 * Runs the operator CLI and writes one JSON line: the evidence on standard output, or a stable
 * error on standard error. Raw AWS errors are not printed because they can carry key values.
 *
 * @param arguments_ - Arguments after the script path.
 * @param dependencies - Injectable resources used by tests.
 * @returns Process exit status.
 */
export async function runAgentRunsIntegrityCli(
  arguments_: readonly string[],
  dependencies: AgentRunsIntegrityCliDependencies = defaultDependencies,
): Promise<AgentRunsIntegrityCliExitCode> {
  let configuration: AgentRunsIntegrityCliArguments
  try {
    configuration = parseAgentRunsIntegrityCliArguments(arguments_)
  } catch (error) {
    const message = error instanceof AgentRunsIntegrityUsageError ? error.message : 'The arguments are invalid.'
    dependencies.writeError(JSON.stringify({ status: 'error', code: 'USAGE_INVALID', message }))
    return 2
  }
  if (configuration.command === 'help') {
    dependencies.writeOut(JSON.stringify(helpPayload))
    return 0
  }
  const correlationId = configuration.correlationId ?? randomUUID()
  try {
    const client = dependencies.createClient(configuration)
    const evidence = await runAgentRunsIntegrityCheck({
      client,
      tableName: configuration.tableName,
      ...(configuration.workItemsTableName === undefined
        ? {}
        : { workItems: createWorkItemLookup(client, configuration.workItemsTableName) }),
      ...(configuration.teams === undefined ? {} : { teams: configuration.teams }),
      bounds: configuration.bounds,
      correlationId,
      now: dependencies.now(),
    })
    dependencies.writeOut(JSON.stringify(evidence))
    return exitCodeOf(evidence)
  } catch (error) {
    const name = error instanceof Error && /^[A-Za-z]{1,64}$/u.test(error.name) ? error.name : 'Error'
    dependencies.writeError(JSON.stringify({ status: 'error', code: 'READ_FAILED', correlationId, errorName: name }))
    return 2
  }
}

if (import.meta.main) {
  void runAgentRunsIntegrityCli(Bun.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode
  })
}
