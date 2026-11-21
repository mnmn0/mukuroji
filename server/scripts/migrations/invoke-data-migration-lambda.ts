import { createHash, createHmac, randomUUID, type Hash, type Hmac } from 'node:crypto'
import { Agent } from 'node:https'
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { SignatureV4 } from '@smithy/signature-v4'
import {
  computeDataMigrationRequestBinding,
  DATA_MIGRATION_INVOCATION_DEFAULTS,
  DATA_MIGRATION_MAX_PAGE_SIZE,
  DATA_MIGRATION_MAX_SEGMENTS,
  DATA_MIGRATION_OPERATOR_PROOF_HEADER,
  type DataMigrationInvocationRequest,
} from '../../src/modules/data-migration'

/** Process exit status: 0 done, 1 failed, 2 usage error, 3 paused or incomplete. */
export type DataMigrationLambdaCliExitCode = 0 | 1 | 2 | 3

/** Validity of an operator proof; the Lambda accepts at most 900 seconds. */
const PROOF_EXPIRES_SECONDS = 300

/** Flags that take a value. */
const VALUE_FLAGS = new Set([
  '--function-name',
  '--region',
  '--migration',
  '--segments',
  '--page-size',
  '--max-pages',
  '--max-writes-per-second',
])

/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set(['--apply'])

/** Pattern of a Lambda function name (not an ARN, so the proof binding matches). */
const FUNCTION_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u

/** Pattern of an AWS region name. */
const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-[0-9]$/u

/** Parsed command line. */
type DataMigrationLambdaCliCommand = {
  /** Function to invoke. */
  readonly functionName: string
  /** Region of the function. */
  readonly region: string
  /** Payload without nonce and proof. */
  readonly request: DataMigrationInvocationRequest
}

/** Response of one Lambda invocation. */
export type DataMigrationLambdaInvocationResult = {
  /** Lambda function error type, when the handler threw. */
  readonly functionError?: string
  /** Response payload text. */
  readonly payload: string
}

/** Injectable dependencies of the operator command. */
export type DataMigrationLambdaCliDependencies = {
  /**
   * Invokes the function synchronously once, without retries.
   *
   * @param input - Function, region and JSON payload.
   * @returns The response.
   */
  readonly invoke: (input: {
    /** Function name. */
    readonly functionName: string
    /** Region. */
    readonly region: string
    /** JSON payload. */
    readonly payload: string
  }) => Promise<DataMigrationLambdaInvocationResult>
  /**
   * Creates an operator proof: a presigned STS `GetCallerIdentity` URL with
   * the binding header signed, using the operator's own AWS credentials.
   *
   * @param input - Region and binding.
   * @returns The presigned URL.
   */
  readonly createProof: (input: {
    /** Region of the STS endpoint. */
    readonly region: string
    /** Binding digest. */
    readonly binding: string
  }) => Promise<string>
  /**
   * Creates a random nonce.
   *
   * @returns The nonce.
   */
  readonly createNonce: () => string
  /** Environment used for the default region. */
  readonly environment: Readonly<Record<string, string | undefined>>
  /**
   * Writes one stdout line.
   *
   * @param line - Line text.
   */
  readonly writeOutput: (line: string) => void
  /**
   * Writes one stderr line.
   *
   * @param line - Line text.
   */
  readonly writeError: (line: string) => void
}

/** Usage text. */
const USAGE = [
  'Usage: bun run data:migrate:aws <list|run|verify> --function-name <name> [flags]',
  '',
  'Invokes the deployed data migration Lambda (stack output DataMigrationFunctionName)',
  'with your AWS credentials. run is a dry run unless --apply is given; --apply signs',
  'an STS GetCallerIdentity proof so the Lambda records who ran the migration.',
  '',
  'Flags:',
  '  --function-name <name>           Function name, not an ARN (required).',
  '  --region <region>                Region of the function (default AWS_REGION / AWS_DEFAULT_REGION).',
  '  --migration <id>                 Migration identifier (run and verify).',
  `  --segments <n>                   Parallel scan segments, 1-${DATA_MIGRATION_MAX_SEGMENTS} (default ${DATA_MIGRATION_INVOCATION_DEFAULTS.segments}).`,
  `  --page-size <n>                  Rows per page, 1-${DATA_MIGRATION_MAX_PAGE_SIZE}.`,
  '  --max-pages <n>                  Page budget of this invocation.',
  `  --max-writes-per-second <n>      Write budget for run (default ${DATA_MIGRATION_INVOCATION_DEFAULTS.maxWritesPerSecond}).`,
  '  --apply                          run only: write rows and checkpoints.',
  '',
  'Exit status: 0 completed or pass, 1 failed, 2 usage error, 3 paused or incomplete.',
].join('\n')

/** Usage error raised while parsing the command line. */
class DataMigrationLambdaCliUsageError extends Error {
  /**
   * Creates a usage error.
   */
  constructor() {
    super('INVALID_USAGE')
    this.name = 'DataMigrationLambdaCliUsageError'
  }
}

/**
 * SHA-256 checksum for request signing, backed by `node:crypto`; with a
 * secret it computes HMAC-SHA-256.
 */
class NodeSha256 {
  /** Running digest. */
  private state: Hash | Hmac

  /** HMAC key, if any. */
  private readonly secret: string | ArrayBuffer | ArrayBufferView | undefined

  /**
   * Creates a checksum.
   *
   * @param secret - HMAC key; omitted for a plain digest.
   */
  constructor(secret?: string | ArrayBuffer | ArrayBufferView) {
    this.secret = secret
    this.state = NodeSha256.start(secret)
  }

  /**
   * Starts a digest.
   *
   * @param secret - HMAC key, if any.
   * @returns The digest state.
   */
  private static start(secret: string | ArrayBuffer | ArrayBufferView | undefined): Hash | Hmac {
    if (secret === undefined) return createHash('sha256')
    return createHmac('sha256', NodeSha256.toBytes(secret))
  }

  /**
   * Converts signing input to bytes.
   *
   * @param data - Input.
   * @returns The bytes.
   */
  private static toBytes(data: string | ArrayBuffer | ArrayBufferView): Uint8Array {
    if (typeof data === 'string') return Buffer.from(data, 'utf8')
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    return new Uint8Array(data)
  }

  /**
   * Adds input.
   *
   * @param data - Input.
   */
  update(data: string | ArrayBuffer | ArrayBufferView): void {
    this.state.update(NodeSha256.toBytes(data))
  }

  /**
   * Finishes the digest.
   *
   * @returns The digest bytes.
   */
  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.state.digest())
  }

  /**
   * Restarts the digest with the same key.
   */
  reset(): void {
    this.state = NodeSha256.start(this.secret)
  }
}

/**
 * Presigns an STS `GetCallerIdentity` request with the binding header signed.
 *
 * @param input - Region and binding.
 * @returns The presigned URL.
 */
export async function createStsOperatorProof(input: {
  /** Region of the STS endpoint. */
  readonly region: string
  /** Binding digest. */
  readonly binding: string
  /** Signing credentials; defaults to the AWS SDK provider chain of the operator. */
  readonly credentials?: ConstructorParameters<typeof SignatureV4>[0]['credentials']
}): Promise<string> {
  const hostname = `sts.${input.region}.amazonaws.com`
  const signer = new SignatureV4({
    service: 'sts',
    region: input.region,
    credentials: input.credentials ?? fromNodeProviderChain(),
    sha256: NodeSha256,
  })
  const presigned = await signer.presign({
    method: 'GET',
    protocol: 'https:',
    hostname,
    path: '/',
    query: { Action: 'GetCallerIdentity', Version: '2011-06-15' },
    headers: { host: hostname, [DATA_MIGRATION_OPERATOR_PROOF_HEADER]: input.binding },
  }, { expiresIn: PROOF_EXPIRES_SECONDS })
  const url = new URL(`https://${hostname}/`)
  for (const [name, value] of Object.entries(presigned.query ?? {})) {
    if (typeof value === 'string') url.searchParams.append(name, value)
  }
  return url.toString()
}

/** Default dependencies using the operator's AWS credentials. */
const defaultDependencies: DataMigrationLambdaCliDependencies = {
  invoke: async (input) => {
    const client = new LambdaClient({
      region: input.region,
      maxAttempts: 1,
      requestHandler: new NodeHttpHandler({
        httpsAgent: new Agent({ keepAlive: true, keepAliveMsecs: 30_000 }),
      }),
    })
    const output = await client.send(new InvokeCommand({
      FunctionName: input.functionName,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(input.payload, 'utf8'),
    }))
    return {
      ...(output.FunctionError === undefined ? {} : { functionError: output.FunctionError }),
      payload: Buffer.from(output.Payload ?? new Uint8Array()).toString('utf8'),
    }
  },
  createProof: createStsOperatorProof,
  createNonce: () => randomUUID(),
  environment: process.env,
  writeOutput: (line) => console.log(line),
  writeError: (line) => console.error(line),
}

/**
 * Parses the command line.
 *
 * @param arguments_ - Arguments after the script path.
 * @param environment - Environment for the default region.
 * @returns The parsed command.
 * @throws DataMigrationLambdaCliUsageError for unknown commands, flags or values.
 */
export function parseDataMigrationLambdaCliArguments(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): DataMigrationLambdaCliCommand {
  const [command, ...rest] = arguments_
  if (command !== 'list' && command !== 'run' && command !== 'verify') throw new DataMigrationLambdaCliUsageError()
  const values = new Map<string, string>()
  const booleans = new Set<string>()
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index] ?? ''
    if (BOOLEAN_FLAGS.has(flag) && !booleans.has(flag)) {
      booleans.add(flag)
      continue
    }
    const value = rest[index + 1]
    if (!VALUE_FLAGS.has(flag) || values.has(flag) || value === undefined || value.startsWith('--')) {
      throw new DataMigrationLambdaCliUsageError()
    }
    values.set(flag, value)
    index += 1
  }
  const functionName = values.get('--function-name') ?? ''
  const region = values.get('--region') ?? environment.AWS_REGION ?? environment.AWS_DEFAULT_REGION ?? ''
  if (!FUNCTION_NAME_PATTERN.test(functionName) || !REGION_PATTERN.test(region)) {
    throw new DataMigrationLambdaCliUsageError()
  }
  if (command === 'list') {
    if (values.size !== (values.has('--region') ? 2 : 1) || booleans.size > 0) throw new DataMigrationLambdaCliUsageError()
    return { functionName, region, request: { command } }
  }
  const migrationId = values.get('--migration')
  if (migrationId === undefined) throw new DataMigrationLambdaCliUsageError()
  if (command === 'verify' && (booleans.has('--apply') || values.has('--max-writes-per-second'))) {
    throw new DataMigrationLambdaCliUsageError()
  }
  const segments = readInteger(values.get('--segments'), DATA_MIGRATION_MAX_SEGMENTS)
  const pageSize = readInteger(values.get('--page-size'), DATA_MIGRATION_MAX_PAGE_SIZE)
  const maxPages = readInteger(values.get('--max-pages'), Number.MAX_SAFE_INTEGER)
  const maxWritesPerSecond = readInteger(
    values.get('--max-writes-per-second'),
    DATA_MIGRATION_INVOCATION_DEFAULTS.maxWritesPerSecondLimit,
  )
  return {
    functionName,
    region,
    request: {
      command,
      migrationId,
      ...(booleans.has('--apply') ? { apply: true } : {}),
      ...(segments === undefined ? {} : { segments }),
      ...(pageSize === undefined ? {} : { pageSize }),
      ...(maxPages === undefined ? {} : { maxPages }),
      ...(maxWritesPerSecond === undefined ? {} : { maxWritesPerSecond }),
    },
  }
}

/**
 * Reads an optional positive integer flag within bounds.
 *
 * @param value - Flag value, if given.
 * @param maximum - Largest accepted value.
 * @returns The integer, or `undefined` when absent.
 */
function readInteger(value: string | undefined, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (!/^[1-9][0-9]*$/u.test(value)) throw new DataMigrationLambdaCliUsageError()
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > maximum) throw new DataMigrationLambdaCliUsageError()
  return parsed
}

/**
 * Maps a Lambda response to an exit status.
 *
 * @param response - Parsed response.
 * @returns Exit status.
 */
function exitCodeOf(response: Readonly<Record<string, unknown>>): DataMigrationLambdaCliExitCode {
  if (response.operation === 'list' && response.status === undefined) return 0
  if (response.status === 'completed' || response.status === 'pass') return 0
  if (response.status === 'paused' || response.status === 'incomplete') return 3
  return 1
}

/**
 * Invokes the data migration Lambda once and prints its JSON response.
 *
 * @param arguments_ - Arguments after the script path.
 * @param dependencies - Injectable dependencies used by tests.
 * @returns Process exit status.
 */
export async function runDataMigrationLambdaCli(
  arguments_: readonly string[],
  dependencies: DataMigrationLambdaCliDependencies = defaultDependencies,
): Promise<DataMigrationLambdaCliExitCode> {
  if (arguments_[0] === 'help' || arguments_[0] === '--help') {
    dependencies.writeOutput(USAGE)
    return 0
  }
  let command: DataMigrationLambdaCliCommand
  try {
    command = parseDataMigrationLambdaCliArguments(arguments_, dependencies.environment)
  } catch {
    dependencies.writeError(JSON.stringify({ status: 'error', code: 'INVALID_USAGE' }))
    dependencies.writeError(USAGE)
    return 2
  }
  let payload: DataMigrationInvocationRequest = command.request
  try {
    if (payload.apply === true) {
      const withNonce = { ...payload, nonce: dependencies.createNonce() }
      const binding = computeDataMigrationRequestBinding(command.functionName, withNonce)
      payload = {
        ...withNonce,
        operatorProof: await dependencies.createProof({ region: command.region, binding }),
      }
    }
  } catch (error: unknown) {
    dependencies.writeError(JSON.stringify({
      status: 'error',
      code: 'OPERATOR_PROOF_FAILED',
      ...(error instanceof Error ? { detail: error.name } : {}),
    }))
    return 1
  }
  let result: DataMigrationLambdaInvocationResult
  try {
    result = await dependencies.invoke({
      functionName: command.functionName,
      region: command.region,
      payload: JSON.stringify(payload),
    })
  } catch (error: unknown) {
    dependencies.writeError(JSON.stringify({
      status: 'error',
      code: 'INVOKE_FAILED',
      ...(error instanceof Error ? { detail: error.name } : {}),
    }))
    return 1
  }
  if (result.functionError !== undefined) {
    dependencies.writeError(JSON.stringify({ status: 'error', code: 'FUNCTION_ERROR', detail: result.functionError }))
    return 1
  }
  let response: unknown
  try {
    response = JSON.parse(result.payload)
  } catch {
    response = undefined
  }
  if (typeof response !== 'object' || response === null || Array.isArray(response)) {
    dependencies.writeError(JSON.stringify({ status: 'error', code: 'RESPONSE_INVALID' }))
    return 1
  }
  const record = Object.fromEntries(Object.entries(response))
  const exitCode = exitCodeOf(record)
  if (exitCode === 1) dependencies.writeError(JSON.stringify(record))
  else dependencies.writeOutput(JSON.stringify(record))
  return exitCode
}

if (import.meta.main) {
  void runDataMigrationLambdaCli(Bun.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode
  })
}
