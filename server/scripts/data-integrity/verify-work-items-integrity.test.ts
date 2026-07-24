import { describe, expect, spyOn, test } from 'bun:test'
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  DescribeContinuousBackupsCommand,
  type DescribeContinuousBackupsCommandOutput,
  DescribeTableCommand,
  type DescribeTableCommandOutput,
  DescribeTimeToLiveCommand,
  type DescribeTimeToLiveCommandOutput,
  ScanCommand,
  type ScanCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  GetCallerIdentityCommand,
  type GetCallerIdentityCommandOutput,
} from '@aws-sdk/client-sts'
import type {
  WorkItemsIntegrityManifest,
} from './work-items-integrity'
import {
  AwsWorkItemsIntegrityReader,
  createAwsSdkTransport,
  parseWorkItemsIntegrityCliArguments,
  parseWorkItemsIntegrityDigestKey,
  runWorkItemsIntegrityCli,
  type WorkItemsIntegrityAwsReaderConfiguration,
  type WorkItemsIntegrityAwsSdkClientConfiguration,
  type WorkItemsIntegrityAwsTransport,
  type WorkItemsIntegrityManagedReadPort,
  writeManifestAtomically,
} from './verify-work-items-integrity'

const ROOT_DIRECTORY = resolve(import.meta.dir, '../../..')

/** Captured result from invoking the documented root-package CLI command. */
type RootCliResult = {
  /** Process exit status. */
  exitCode: number
  /** Complete standard-error text. */
  stderr: string
  /** Complete standard-output text. */
  stdout: string
}

/** Allowlisted command recorder used without AWS or network access. */
class RecordingAwsTransport implements WorkItemsIntegrityAwsTransport {
  /** Recorded recovery-state commands. */
  readonly continuousBackupsCommands: DescribeContinuousBackupsCommand[] = []
  /** Recorded table metadata commands. */
  readonly describeTableCommands: DescribeTableCommand[] = []
  /** Recorded TTL commands. */
  readonly describeTimeToLiveCommands: DescribeTimeToLiveCommand[] = []
  /** Recorded caller identity commands. */
  readonly callerIdentityCommands: GetCallerIdentityCommand[] = []
  /** Recorded scan commands. */
  readonly scanCommands: ScanCommand[] = []
  /** Number of transport closes. */
  closeCount = 0

  /**
   * Records transport closure.
   */
  close(): void {
    this.closeCount += 1
  }

  /**
   * Records a recovery-state command.
   *
   * @param command - Exact command under test.
   * @returns Empty fake response.
   */
  async describeContinuousBackups(
    command: DescribeContinuousBackupsCommand,
  ): Promise<DescribeContinuousBackupsCommandOutput> {
    this.continuousBackupsCommands.push(command)
    return { $metadata: {} }
  }

  /**
   * Records a table metadata command.
   *
   * @param command - Exact command under test.
   * @returns Empty fake response.
   */
  async describeTable(
    command: DescribeTableCommand,
  ): Promise<DescribeTableCommandOutput> {
    this.describeTableCommands.push(command)
    return { $metadata: {} }
  }

  /**
   * Records a TTL command.
   *
   * @param command - Exact command under test.
   * @returns Empty fake response.
   */
  async describeTimeToLive(
    command: DescribeTimeToLiveCommand,
  ): Promise<DescribeTimeToLiveCommandOutput> {
    this.describeTimeToLiveCommands.push(command)
    return { $metadata: {} }
  }

  /**
   * Records a caller identity command.
   *
   * @param command - Exact command under test.
   * @returns Fixed caller identity.
   */
  async readCallerIdentity(
    command: GetCallerIdentityCommand,
  ): Promise<GetCallerIdentityCommandOutput> {
    this.callerIdentityCommands.push(command)
    return {
      $metadata: {},
      Account: '123456789012',
    }
  }

  /**
   * Records a scan command.
   *
   * @param command - Exact command under test.
   * @returns Empty fake scan page.
   */
  async scan(command: ScanCommand): Promise<ScanCommandOutput> {
    this.scanCommands.push(command)
    return { $metadata: {}, Items: [] }
  }
}

/** Managed reader that throws one raw AWS-shaped error before any DynamoDB read. */
class FailingAwsReadPort implements WorkItemsIntegrityManagedReadPort {
  /** Number of close calls observed after failure. */
  closeCount = 0
  /** Canary that must never reach stderr. */
  private readonly canary: string

  /**
   * Creates a failing reader.
   *
   * @param canary - Raw error text that must remain redacted.
   */
  constructor(canary: string) {
    this.canary = canary
  }

  /**
   * Records resource cleanup.
   */
  close(): void {
    this.closeCount += 1
  }

  /**
   * Returns no recovery response because the caller read always fails first.
   *
   * @returns Empty fake response.
   */
  async describeContinuousBackups(): Promise<DescribeContinuousBackupsCommandOutput> {
    return { $metadata: {} }
  }

  /**
   * Returns no table response because the caller read always fails first.
   *
   * @returns Empty fake response.
   */
  async describeTable(): Promise<DescribeTableCommandOutput> {
    return { $metadata: {} }
  }

  /**
   * Returns no TTL response because the caller read always fails first.
   *
   * @returns Empty fake response.
   */
  async describeTimeToLive(): Promise<DescribeTimeToLiveCommandOutput> {
    return { $metadata: {} }
  }

  /**
   * Throws an AWS-shaped error containing a raw canary.
   *
   * @returns This method never resolves.
   */
  async readCallerAccount(): Promise<string> {
    throw {
      $metadata: { requestId: this.canary },
      message: this.canary,
    }
  }

  /**
   * Returns no scan page because the caller read always fails first.
   *
   * @returns Empty fake scan page.
   */
  async scanPage(): Promise<ScanCommandOutput> {
    return { $metadata: {}, Items: [] }
  }
}

/**
 * Creates a complete file-writing fixture without tenant data.
 *
 * @returns Signed-manifest-shaped JSON fixture.
 */
function createManifestFileFixture(): WorkItemsIntegrityManifest {
  return {
    digest: {
      algorithm: 'HMAC-SHA-256',
      contentDigest: '1'.repeat(64),
      keyFingerprint: '2'.repeat(64),
      keySetDigest: '3'.repeat(64),
      version: 1,
    },
    descriptor: {
      baseKey: [
        { name: 'directoryTeamId', type: 'HASH' },
        { name: 'issueId', type: 'RANGE' },
      ],
      billingMode: 'PAY_PER_REQUEST',
      encryption: 'AWS_OWNED',
      globalSecondaryIndexes: [
        {
          key: [
            { name: 'directoryProjectId', type: 'HASH' },
            { name: 'sortOrder', type: 'RANGE' },
          ],
          name: 'AssignedProjectIssueIndex',
          projection: 'ALL',
          status: 'ACTIVE',
        },
        {
          key: [
            { name: 'directoryTeamId', type: 'HASH' },
            { name: 'sortOrder', type: 'RANGE' },
          ],
          name: 'TeamIssueSortOrderIndex',
          projection: 'ALL',
          status: 'ACTIVE',
        },
        {
          key: [
            { name: 'directoryTeamId', type: 'HASH' },
            { name: 'updatedAt', type: 'RANGE' },
          ],
          name: 'TeamIssueUpdatedAtIndex',
          projection: 'ALL',
          status: 'ACTIVE',
        },
      ],
      ttlStatus: 'DISABLED',
    },
    kind: 'mukuroji-work-items-integrity-manifest',
    manifestMac: '4'.repeat(64),
    manifestVersion: 1,
    observed: {
      callerAccount: '123456789012',
      tableArn: 'arn:aws:dynamodb:ap-northeast-1:123456789012:table/work-items',
      tableCreationTime: '2026-07-01T00:00:00.000Z',
      tableId: 'table-id',
    },
    pitr: {
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-20T00:00:00.000Z',
      status: 'ENABLED',
    },
    requested: {
      account: '123456789012',
      profile: 'integrity-read-only',
      region: 'ap-northeast-1',
      tableName: 'work-items',
    },
    restore: null,
    role: 'source',
    scan: {
      captureContext: 'writer-fenced',
      completedAt: '2026-07-20T00:00:01.000Z',
      consistentRead: true,
      itemCount: 0,
      logicalPartitionCount: 0,
      pageCount: 1,
      snapshotIsolation: false,
      startedAt: '2026-07-20T00:00:00.000Z',
    },
    workflowSchemaVersion: 1,
    workItemSchemaVersion: 1,
  }
}

/**
 * Runs the exact documented silent root-package command.
 *
 * @param arguments_ - CLI arguments after the script separator.
 * @returns Captured process result.
 */
async function runRootCli(arguments_: readonly string[]): Promise<RootCliResult> {
  const process_ = Bun.spawn({
    cmd: [
      process.execPath,
      'run',
      '--silent',
      'work-items:integrity',
      '--',
      ...arguments_,
    ],
    cwd: ROOT_DIRECTORY,
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process_.stdout).text(),
    new Response(process_.stderr).text(),
    process_.exited,
  ])
  return { exitCode, stderr, stdout }
}

/**
 * Restores one endpoint override after an isolated construction test.
 *
 * @param name - Exact endpoint environment variable.
 * @param value - Previous value, or undefined when it was absent.
 */
function restoreEnvironmentVariable(
  name: 'AWS_ENDPOINT_URL' | 'AWS_ENDPOINT_URL_DYNAMODB' | 'AWS_ENDPOINT_URL_STS',
  value: string | undefined,
): void {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}

describe('Work Items integrity CLI argument parsing', () => {
  test('requires every explicit source manifest boundary', () => {
    expect(parseWorkItemsIntegrityCliArguments([
      'manifest',
      '--role',
      'source',
      '--account',
      '123456789012',
      '--region',
      'ap-northeast-1',
      '--table',
      'production-WorkItems',
      '--profile',
      'integrity-read-only',
      '--digest-key-file',
      '/secure/integrity-key.hex',
      '--output',
      '/evidence/source.json',
      '--source-consistency',
      'writer-fenced',
    ])).toEqual({
      account: '123456789012',
      command: 'manifest',
      digestKeyFile: '/secure/integrity-key.hex',
      output: '/evidence/source.json',
      profile: 'integrity-read-only',
      region: 'ap-northeast-1',
      role: 'source',
      sourceConsistency: 'writer-fenced',
      tableName: 'production-WorkItems',
    })
  })

  test('accepts an isolated restore without source consistency', () => {
    expect(parseWorkItemsIntegrityCliArguments([
      'manifest',
      '--role',
      'restore',
      '--account',
      '123456789012',
      '--region',
      'us-gov-west-1',
      '--table',
      'restored.WorkItems',
      '--profile',
      'restore-read-only',
      '--digest-key-file',
      'integrity-key.hex',
      '--output',
      'restore.json',
    ])).toEqual({
      account: '123456789012',
      command: 'manifest',
      digestKeyFile: 'integrity-key.hex',
      output: 'restore.json',
      profile: 'restore-read-only',
      region: 'us-gov-west-1',
      role: 'restore',
      tableName: 'restored.WorkItems',
    })
  })

  test('requires source consistency and rejects it for restore manifests', () => {
    expect(() => parseWorkItemsIntegrityCliArguments([
      'manifest',
      '--role',
      'source',
      '--account',
      '123456789012',
      '--region',
      'ap-northeast-1',
      '--table',
      'production-WorkItems',
      '--profile',
      'integrity-read-only',
      '--digest-key-file',
      'integrity-key.hex',
      '--output',
      'source.json',
    ])).toThrow('INVALID_USAGE')

    expect(() => parseWorkItemsIntegrityCliArguments([
      'manifest',
      '--role',
      'restore',
      '--account',
      '123456789012',
      '--region',
      'ap-northeast-1',
      '--table',
      'restored-WorkItems',
      '--profile',
      'restore-read-only',
      '--digest-key-file',
      'integrity-key.hex',
      '--output',
      'restore.json',
      '--source-consistency',
      'live-observation',
    ])).toThrow('INVALID_USAGE')
  })

  test('rejects an output that resolves to the digest key path', () => {
    expect(() => parseWorkItemsIntegrityCliArguments([
      'manifest',
      '--role',
      'source',
      '--account',
      '123456789012',
      '--region',
      'ap-northeast-1',
      '--table',
      'production-WorkItems',
      '--profile',
      'integrity-read-only',
      '--digest-key-file',
      './secure/../integrity-key.hex',
      '--output',
      'integrity-key.hex',
      '--source-consistency',
      'writer-fenced',
    ])).toThrow('INVALID_USAGE')
  })

  test('parses only the three explicit offline comparison inputs', () => {
    expect(parseWorkItemsIntegrityCliArguments([
      'compare',
      '--source-manifest',
      'source.json',
      '--restore-manifest',
      'restore.json',
      '--digest-key-file',
      'integrity-key.hex',
    ])).toEqual({
      command: 'compare',
      digestKeyFile: 'integrity-key.hex',
      restoreManifest: 'restore.json',
      sourceManifest: 'source.json',
    })
  })

  test('rejects unknown, duplicate, missing, and positional arguments', () => {
    const invalidArgumentLists = [
      [],
      ['unknown'],
      ['help', '--verbose'],
      ['compare', '--source-manifest', 'source.json'],
      [
        'compare',
        '--source-manifest',
        'source.json',
        '--source-manifest',
        'other.json',
        '--restore-manifest',
        'restore.json',
        '--digest-key-file',
        'key.hex',
      ],
      [
        'compare',
        '--source-manifest',
        'source.json',
        '--restore-manifest',
        'restore.json',
        '--digest-key-file',
        'key.hex',
        '--verbose',
        'true',
      ],
      [
        'compare',
        '--source-manifest',
        'source.json',
        '--restore-manifest',
        'restore.json',
        '--digest-key-file',
        '--unexpected-flag',
      ],
    ]

    for (const arguments_ of invalidArgumentLists) {
      expect(() => parseWorkItemsIntegrityCliArguments(arguments_)).toThrow('INVALID_USAGE')
    }
  })

  test('rejects implicit or malformed AWS boundaries', () => {
    const sourceArguments = [
      'manifest',
      '--role',
      'source',
      '--account',
      '123456789012',
      '--region',
      'ap-northeast-1',
      '--table',
      'production-WorkItems',
      '--profile',
      'integrity-read-only',
      '--digest-key-file',
      'integrity-key.hex',
      '--output',
      'source.json',
      '--source-consistency',
      'live-observation',
    ]

    const accountIndex = sourceArguments.indexOf('123456789012')
    const regionIndex = sourceArguments.indexOf('ap-northeast-1')
    const tableIndex = sourceArguments.indexOf('production-WorkItems')
    const profileIndex = sourceArguments.indexOf('integrity-read-only')

    const malformedAccount = sourceArguments.with(accountIndex, '1234')
    const malformedRegion = sourceArguments.with(regionIndex, 'localhost')
    const malformedTable = sourceArguments.with(tableIndex, 'table/with/slash')
    const malformedProfile = sourceArguments.with(profileIndex, ' profile ')

    expect(() => parseWorkItemsIntegrityCliArguments(malformedAccount)).toThrow('INVALID_USAGE')
    expect(() => parseWorkItemsIntegrityCliArguments(malformedRegion)).toThrow('INVALID_USAGE')
    expect(() => parseWorkItemsIntegrityCliArguments(malformedTable)).toThrow('INVALID_USAGE')
    expect(() => parseWorkItemsIntegrityCliArguments(malformedProfile)).toThrow('INVALID_USAGE')
  })

  test('accepts both machine-readable help spellings', () => {
    expect(parseWorkItemsIntegrityCliArguments(['help'])).toEqual({ command: 'help' })
    expect(parseWorkItemsIntegrityCliArguments(['--help'])).toEqual({ command: 'help' })
  })

  test('returns usage exit status without echoing an unknown argument', async () => {
    const errorWriter = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const exitCode = await runWorkItemsIntegrityCli(['private-tenant-secret'])

      expect(exitCode).toBe(2)
      expect(errorWriter).toHaveBeenCalledWith(
        '{"operation":"unknown","status":"error","code":"INVALID_USAGE"}',
      )
      expect(JSON.stringify(errorWriter.mock.calls)).not.toContain('private-tenant-secret')
    } finally {
      errorWriter.mockRestore()
    }
  })

  test('returns machine-readable help without touching AWS or files', async () => {
    const outputWriter = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const exitCode = await runWorkItemsIntegrityCli(['help'])

      expect(exitCode).toBe(0)
      expect(outputWriter).toHaveBeenCalledTimes(1)
      expect(outputWriter).toHaveBeenCalledWith(expect.stringContaining('"status":"help"'))
    } finally {
      outputWriter.mockRestore()
    }
  })
})

describe('Work Items integrity AWS adapter', () => {
  test('constructs only the exact allowlisted read commands and closes its transport', async () => {
    const transport = new RecordingAwsTransport()
    let capturedConfiguration: WorkItemsIntegrityAwsReaderConfiguration | undefined
    const reader = new AwsWorkItemsIntegrityReader(
      {
        profile: 'integrity-read-only',
        region: 'ap-northeast-1',
      },
      (configuration) => {
        capturedConfiguration = configuration
        return transport
      },
    )
    const cursor = {
      directoryTeamId: { S: 'cursor-team' },
      issueId: { S: 'cursor-issue' },
    }

    await expect(reader.readCallerAccount()).resolves.toBe('123456789012')
    await reader.describeTable('work-items')
    await reader.describeContinuousBackups('work-items')
    await reader.describeTimeToLive('work-items')
    await reader.scanPage('work-items')
    await reader.scanPage('work-items', cursor)
    reader.close()

    expect(capturedConfiguration).toEqual({
      profile: 'integrity-read-only',
      region: 'ap-northeast-1',
    })
    expect(transport.callerIdentityCommands).toHaveLength(1)
    expect(transport.callerIdentityCommands[0]).toBeInstanceOf(
      GetCallerIdentityCommand,
    )
    expect(transport.callerIdentityCommands[0]?.input).toEqual({})
    expect(transport.describeTableCommands).toHaveLength(1)
    expect(transport.describeTableCommands[0]).toBeInstanceOf(
      DescribeTableCommand,
    )
    expect(transport.describeTableCommands[0]?.input).toEqual({
      TableName: 'work-items',
    })
    expect(transport.continuousBackupsCommands).toHaveLength(1)
    expect(transport.continuousBackupsCommands[0]).toBeInstanceOf(
      DescribeContinuousBackupsCommand,
    )
    expect(transport.continuousBackupsCommands[0]?.input).toEqual({
      TableName: 'work-items',
    })
    expect(transport.describeTimeToLiveCommands).toHaveLength(1)
    expect(transport.describeTimeToLiveCommands[0]).toBeInstanceOf(
      DescribeTimeToLiveCommand,
    )
    expect(transport.describeTimeToLiveCommands[0]?.input).toEqual({
      TableName: 'work-items',
    })
    expect(transport.scanCommands).toHaveLength(2)
    expect(transport.scanCommands[0]).toBeInstanceOf(ScanCommand)
    expect(transport.scanCommands[0]?.input).toEqual({
      ConsistentRead: true,
      TableName: 'work-items',
    })
    expect(transport.scanCommands[1]).toBeInstanceOf(ScanCommand)
    expect(transport.scanCommands[1]?.input).toEqual({
      ConsistentRead: true,
      ExclusiveStartKey: cursor,
      TableName: 'work-items',
    })
    expect(transport.closeCount).toBe(1)
  })

  test('pins both explicit-profile SDK clients to partition-specific official endpoints', () => {
    const endpointCases = [
      {
        region: 'ap-northeast-1',
        suffix: 'amazonaws.com',
      },
      {
        region: 'cn-north-1',
        suffix: 'amazonaws.com.cn',
      },
      {
        region: 'eusc-de-east-1',
        suffix: 'amazonaws.eu',
      },
      {
        region: 'us-iso-east-1',
        suffix: 'c2s.ic.gov',
      },
      {
        region: 'us-isob-east-1',
        suffix: 'sc2s.sgov.gov',
      },
      {
        region: 'eu-isoe-west-1',
        suffix: 'cloud.adc-e.uk',
      },
      {
        region: 'us-isof-south-1',
        suffix: 'csp.hci.ic.gov',
      },
      {
        region: 'us-gov-west-1',
        suffix: 'amazonaws.com',
      },
    ]
    const previousGlobalEndpoint = process.env.AWS_ENDPOINT_URL
    const previousDynamoDbEndpoint = process.env.AWS_ENDPOINT_URL_DYNAMODB
    const previousStsEndpoint = process.env.AWS_ENDPOINT_URL_STS
    try {
      process.env.AWS_ENDPOINT_URL = 'https://attacker.invalid/global'
      process.env.AWS_ENDPOINT_URL_DYNAMODB = 'https://attacker.invalid/dynamodb'
      process.env.AWS_ENDPOINT_URL_STS = 'https://attacker.invalid/sts'

      for (const endpointCase of endpointCases) {
        const transport = new RecordingAwsTransport()
        let dynamodbConfiguration:
          WorkItemsIntegrityAwsSdkClientConfiguration | undefined
        let stsConfiguration: WorkItemsIntegrityAwsSdkClientConfiguration | undefined
        const created = createAwsSdkTransport(
          {
            profile: 'integrity-read-only',
            region: endpointCase.region,
          },
          (nextDynamodbConfiguration, nextStsConfiguration) => {
            dynamodbConfiguration = nextDynamodbConfiguration
            stsConfiguration = nextStsConfiguration
            return transport
          },
        )

        expect(created).toBe(transport)
        expect(dynamodbConfiguration).toMatchObject({
          endpoint: `https://dynamodb.${endpointCase.region}.${endpointCase.suffix}/`,
          profile: 'integrity-read-only',
          region: endpointCase.region,
        })
        expect(stsConfiguration).toMatchObject({
          endpoint: `https://sts.${endpointCase.region}.${endpointCase.suffix}/`,
          profile: 'integrity-read-only',
          region: endpointCase.region,
        })
        expect(dynamodbConfiguration?.credentials).toBe(stsConfiguration?.credentials)
      }
      expect(() => createAwsSdkTransport({
        profile: 'integrity-read-only',
        region: 'ap-northeast-1.attacker.invalid',
      })).toThrow('INVALID_USAGE')
    } finally {
      restoreEnvironmentVariable('AWS_ENDPOINT_URL', previousGlobalEndpoint)
      restoreEnvironmentVariable(
        'AWS_ENDPOINT_URL_DYNAMODB',
        previousDynamoDbEndpoint,
      )
      restoreEnvironmentVariable('AWS_ENDPOINT_URL_STS', previousStsEndpoint)
    }
  })

  test('redacts raw AWS errors and closes the managed reader', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mukuroji-integrity-aws-error-'))
    const digestKeyPath = join(directory, 'digest-key.hex')
    const outputPath = join(directory, 'manifest.json')
    const rawCanary = 'RAW-AWS-ERROR-CANARY-DO-NOT-LEAK'
    const reader = new FailingAwsReadPort(rawCanary)
    const errorWriter = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await writeFile(digestKeyPath, 'ab'.repeat(32), { mode: 0o600 })
      const exitCode = await runWorkItemsIntegrityCli([
        'manifest',
        '--role',
        'source',
        '--account',
        '123456789012',
        '--region',
        'ap-northeast-1',
        '--table',
        'work-items',
        '--profile',
        'integrity-read-only',
        '--digest-key-file',
        digestKeyPath,
        '--output',
        outputPath,
        '--source-consistency',
        'writer-fenced',
      ], {
        /** Returns the deterministic failing reader. */
        createReader: () => reader,
      })

      expect(exitCode).toBe(1)
      expect(errorWriter).toHaveBeenCalledWith(
        '{"operation":"manifest","status":"error","code":"AWS_READ_FAILED"}',
      )
      expect(JSON.stringify(errorWriter.mock.calls)).not.toContain(rawCanary)
      expect(JSON.stringify(errorWriter.mock.calls)).not.toContain(digestKeyPath)
      expect(reader.closeCount).toBe(1)
      await expect(stat(outputPath)).rejects.toBeDefined()
    } finally {
      errorWriter.mockRestore()
      await rm(directory, { force: true, recursive: true })
    }
  })
})

describe('Work Items integrity file boundaries', () => {
  test('publishes mode-0600 evidence and removes its temporary hard link', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mukuroji-integrity-output-'))
    const outputPath = join(directory, 'manifest.json')
    try {
      await writeManifestAtomically(outputPath, createManifestFileFixture())

      const output = await stat(outputPath)
      expect(output.mode & 0o077).toBe(0)
      expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(
        createManifestFileFixture(),
      )
      expect(await readdir(directory)).toEqual(['manifest.json'])
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test('preserves an existing evidence file byte-for-byte and fails closed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mukuroji-integrity-no-clobber-'))
    const outputPath = join(directory, 'manifest.json')
    const existingEvidence = Buffer.from('existing-signed-evidence\n', 'utf8')
    try {
      await writeFile(outputPath, existingEvidence, { mode: 0o600 })

      await expect(
        writeManifestAtomically(outputPath, createManifestFileFixture()),
      ).rejects.toThrow('OUTPUT_FILE_WRITE_FAILED')

      expect(await readFile(outputPath)).toEqual(existingEvidence)
      expect(await readdir(directory)).toEqual(['manifest.json'])
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test('rejects oversized and non-regular manifest input before parsing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mukuroji-integrity-input-'))
    const digestKeyPath = join(directory, 'digest-key.hex')
    const invalidUtf8Path = join(directory, 'invalid-utf8.json')
    const oversizedPath = join(directory, 'oversized.json')
    const errorWriter = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await writeFile(digestKeyPath, 'ab'.repeat(32), { mode: 0o600 })
      await writeFile(invalidUtf8Path, Buffer.from([0xc3, 0x28]))
      await writeFile(oversizedPath, Buffer.alloc(1024 * 1024 + 1, 0x20))

      const oversizedExitCode = await runWorkItemsIntegrityCli([
        'compare',
        '--source-manifest',
        oversizedPath,
        '--restore-manifest',
        oversizedPath,
        '--digest-key-file',
        digestKeyPath,
      ])
      const directoryExitCode = await runWorkItemsIntegrityCli([
        'compare',
        '--source-manifest',
        directory,
        '--restore-manifest',
        directory,
        '--digest-key-file',
        digestKeyPath,
      ])
      const invalidUtf8ExitCode = await runWorkItemsIntegrityCli([
        'compare',
        '--source-manifest',
        invalidUtf8Path,
        '--restore-manifest',
        invalidUtf8Path,
        '--digest-key-file',
        digestKeyPath,
      ])

      expect(oversizedExitCode).toBe(1)
      expect(directoryExitCode).toBe(1)
      expect(invalidUtf8ExitCode).toBe(1)
      expect(errorWriter).toHaveBeenNthCalledWith(
        1,
        '{"operation":"compare","status":"error","code":"INPUT_FILE_INVALID"}',
      )
      expect(errorWriter).toHaveBeenNthCalledWith(
        2,
        '{"operation":"compare","status":"error","code":"INPUT_FILE_INVALID"}',
      )
      expect(errorWriter).toHaveBeenNthCalledWith(
        3,
        '{"operation":"compare","status":"error","code":"INPUT_FILE_INVALID"}',
      )
    } finally {
      errorWriter.mockRestore()
      await rm(directory, { force: true, recursive: true })
    }
  })
})

describe('Work Items integrity documented root command', () => {
  test('emits standalone help JSON without Bun prefixes or stderr', async () => {
    const result = await runRootCli(['help'])
    let payload: unknown
    payload = JSON.parse(result.stdout)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(payload).toMatchObject({ status: 'help' })
    expect(result.stdout.trim().split('\n')).toHaveLength(1)
  })

  test('does not echo an unknown secret argument from the Bun wrapper', async () => {
    const rawCanary = 'PRIVATE-CLI-CANARY-DO-NOT-ECHO'
    const result = await runRootCli([rawCanary])

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr.trim()).toBe(
      '{"operation":"unknown","status":"error","code":"INVALID_USAGE"}',
    )
    expect(`${result.stdout}${result.stderr}`).not.toContain(rawCanary)
    expect(result.stderr.trim().split('\n')).toHaveLength(1)
  })
})

describe('Work Items integrity digest key parsing', () => {
  test('accepts exactly 32 lowercase hexadecimal bytes with one optional LF', () => {
    const hexadecimalKey = 'ab'.repeat(32)

    expect(Buffer.from(parseWorkItemsIntegrityDigestKey(hexadecimalKey)).toString('hex'))
      .toBe(hexadecimalKey)
    expect(Buffer.from(parseWorkItemsIntegrityDigestKey(`${hexadecimalKey}\n`)).toString('hex'))
      .toBe(hexadecimalKey)
  })

  test('rejects uppercase, short, CRLF, extra newline, and non-hexadecimal keys', () => {
    const hexadecimalKey = 'ab'.repeat(32)
    const invalidKeys = [
      hexadecimalKey.toUpperCase(),
      hexadecimalKey.slice(2),
      `${hexadecimalKey}\r\n`,
      `${hexadecimalKey}\n\n`,
      `${hexadecimalKey.slice(0, -1)}g`,
    ]

    for (const invalidKey of invalidKeys) {
      expect(() => parseWorkItemsIntegrityDigestKey(invalidKey)).toThrow('DIGEST_KEY_INVALID')
    }
  })

  test('rejects a digest key file readable by group or other users', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mukuroji-integrity-cli-'))
    const keyPath = join(directory, 'digest-key.hex')
    const errorWriter = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await writeFile(keyPath, 'ab'.repeat(32), { mode: 0o600 })
      await chmod(keyPath, 0o644)

      const exitCode = await runWorkItemsIntegrityCli([
        'compare',
        '--source-manifest',
        join(directory, 'source.json'),
        '--restore-manifest',
        join(directory, 'restore.json'),
        '--digest-key-file',
        keyPath,
      ])

      expect(exitCode).toBe(2)
      expect(errorWriter).toHaveBeenCalledWith(
        '{"operation":"compare","status":"error","code":"DIGEST_KEY_INVALID"}',
      )
      expect(JSON.stringify(errorWriter.mock.calls)).not.toContain(keyPath)
    } finally {
      errorWriter.mockRestore()
      await rm(directory, { force: true, recursive: true })
    }
  })
})
