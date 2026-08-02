import { describe, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  DescribeTableCommand,
  DynamoDBClient,
  GetItemCommand,
  ScanCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import {
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  GetObjectAttributesCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import {
  GetCallerIdentityCommand,
  STSClient,
} from '@aws-sdk/client-sts'
import {
  calculateCrossDomainIntegrityResourceIdentityDigest,
  createCrossDomainIntegrityImmutableResourceIdentities,
  CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_TABLE_RESOURCE_TARGETS,
  serializeCrossDomainIntegrityResourceAttestation,
  type CrossDomainIntegrityResourceAttestation,
} from '../../data-integrity/cross-domain-integrity'
import {
  createMigrationDigest,
} from './migration-contract'
import type {
  CreateAwsWorkspaceSearchMigrationRehearsalIntegritySessionInput,
  WorkspaceSearchMigrationRateManagedAwsSession,
  WorkspaceSearchMigrationRehearsalIntegrityAwsPending,
  WorkspaceSearchMigrationRehearsalIntegrityAwsSession,
} from './migration-identity-aws'
import * as managedRateModule from './migration-describe-table-rate-managed-session'
import {
  createWorkspaceSearchMigrationRequestedResourcesBinding,
  type WorkspaceSearchMigrationRequestedResources,
} from './migration-identity'
import type {
  WorkspaceSearchMigrationDescribeTableRatePolicy,
} from './migration-describe-table-rate-budget'
import {
  createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
} from './migration-rehearsal-stage-child-material.test-fixture'
import {
  createWorkspaceSearchMigrationRehearsalPermit,
  createWorkspaceSearchMigrationRehearsalProductionAccountDigest,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_DEPLOYMENT_TRUST_ROOT_TAG_KEY,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ENVIRONMENT_TAG_KEY,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRODUCTION_ACCOUNT_DIGEST_TAG_KEY,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
} from './migration-rehearsal-permit'
import {
  parseWorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection,
} from './migration-rehearsal-integrity-rate-evidence'
import {
  createWorkspaceSearchMigrationRehearsalStageManifest,
} from './migration-rehearsal-stage-manifest'
import {
  selectWorkspaceSearchMigrationRehearsalStage,
} from './migration-rehearsal-stage-receipt'
import {
  createWorkspaceSearchMigrationRehearsalStageReservation,
} from './migration-rehearsal-stage-reservation'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND,
} from './migration-rehearsal-stage-reservation-aws'
import {
  createWorkspaceSearchMigrationRehearsalRateRecorder,
  type WorkspaceSearchMigrationRehearsalRateCommittedSegment,
  type WorkspaceSearchMigrationRehearsalRateRecorder,
} from './migration-rehearsal-rate-evidence'

/** Exact migration resources matching the source-controlled fixture target. */
const requested: WorkspaceSearchMigrationRequestedResources = {
  account: '111111111111',
  region: 'us-east-1',
  profile: 'migration-integrity-live-test',
  commit: 'a'.repeat(40),
  tables: {
    'project-directory': 'stage-project-directory',
    'work-items': 'stage-work-items',
    collaboration: 'stage-collaboration',
    documents: 'stage-documents',
    'workspace-search': 'stage-workspace-search',
    'migration-state': 'stage-migration-state',
  },
  journalBucket: 'stage-journal-bucket',
  journalKeyArn:
    'arn:aws:kms:us-east-1:111111111111:key/' +
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
}

/** Trusted base instant within the fixture permit and reservation. */
const admittedAtMilliseconds = Date.parse('2026-08-02T00:10:00.000Z')

/** Stable dedicated integrity key distinct from the fixture runtime key. */
const integrityKeySeed = new Uint8Array(32).fill(0x66)

/** Stable Workspace Audit pseudonym key. */
const auditKeySeed = new Uint8Array(32).fill(0x77)

/** Complete rate policy used by checkpoint seeding and the live session. */
function createRatePolicy(
  policyVersion: string,
): WorkspaceSearchMigrationDescribeTableRatePolicy {
  return {
    policyVersion,
    maximumAttemptsPerWindow: 1_000,
    maximumAttemptsPerLifecycle: 2_000,
    checkpointPageAttemptCapacity: 182,
    windowMilliseconds: 1_000,
    minimumAttemptIntervalMilliseconds: 1,
    minimumPageIntervalMilliseconds: 1,
    maximumAdmissionWaitMilliseconds: 5_000,
    throttleBackoffInitialMilliseconds: 1,
    throttleBackoffMaximumMilliseconds: 1,
  }
}

/** Options selecting adversarial permit and construction variants. */
type CreateIntegrityFixtureOptions = {
  /** Uses the evidence/runtime key as the dedicated integrity key. */
  readonly integrityEqualsRuntimeKey?: boolean
  /** Signs the permit with a distinct key while preserving its evidence key. */
  readonly distinctPermitVerificationKey?: boolean
  /** Authenticates a self-consistent vector not derived from the attestation. */
  readonly mismatchedPermitVector?: boolean
}

/** Complete pure fixture used before any AWS prototype is invoked. */
type IntegrityFixture = {
  /** Canonical private attestation object. */
  readonly attestation: CrossDomainIntegrityResourceAttestation
  /** Canonical private attestation bytes. */
  readonly attestationBytes: Uint8Array
  /** Dedicated integrity key seed retained by the test. */
  readonly integrityKey: Uint8Array
  /** Exact permit verification key seed retained by the test. */
  readonly permitVerificationKey: Uint8Array
  /** Exact evidence/runtime rate key seed retained by the test. */
  readonly runtimeKey: Uint8Array
  /** Parent publication key required by the genuine stage claim. */
  readonly publicationKey: Uint8Array
  /** Reissued permit matching the private attestation identity claims. */
  readonly permit: ReturnType<typeof createWorkspaceSearchMigrationRehearsalPermit>
  /** Genuine reissued first-stage selection matching the permit. */
  readonly selection: ReturnType<
    typeof selectWorkspaceSearchMigrationRehearsalStage
  >
  /** Genuine required reservation matching the reissued selection. */
  readonly reservation: ReturnType<
    typeof createWorkspaceSearchMigrationRehearsalStageReservation
  >
  /** Exact root predecessor raw segment. */
  readonly predecessor: WorkspaceSearchMigrationRehearsalRateCommittedSegment
  /** Permit-bound reviewed rate policy. */
  readonly ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy
  /** Permit-bound measured configuration digest. */
  readonly configurationBindingDigest: string
}

/** Creates one canonical private attestation with exact 2-of-6 overlap. */
function createResourceAttestation(): CrossDomainIntegrityResourceAttestation {
  const tableNames = [
    'integrity-audit-events',
    'integrity-file-proofing',
    requested.tables['project-directory'],
    'integrity-work-item-configuration',
    requested.tables['work-items'],
    'integrity-workspace-access',
  ]
  return {
    kind: 'mukuroji-cross-domain-integrity-resource-attestation',
    version: 1,
    scheme: CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    account: requested.account,
    region: requested.region,
    bucket: {
      target: 'bucket:file',
      bucketName: 'integrity-live-file-bucket',
      marker: {
        key: CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
        versionId: 'integrity-live-marker-version',
        checksumSha256: Buffer.alloc(32, 0x61).toString('base64'),
        size: 128,
      },
    },
    tables: CROSS_DOMAIN_INTEGRITY_TABLE_RESOURCE_TARGETS.map(
      (target, index) => {
        const tableName = tableNames[index] ?? ''
        return {
          target,
          tableName,
          tableArn:
            `arn:aws:dynamodb:${requested.region}:${requested.account}:` +
            `table/${tableName}`,
          tableId: `integrity-live-table-id-${index + 1}`,
          creationTime: `2026-01-0${index + 1}T00:00:00.000Z`,
        }
      },
    ),
  }
}

/** Creates a conventional lowercase SHA-256 digest. */
function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex')
}

/** Process-isolated selector preventing repository resolver mock leakage. */
const isolatedWorkerEnvironmentName =
  'MUKUROJI_INTEGRITY_LIVE_AWS_TEST_WORKER'

/** Whether this process owns the isolated module mocks and focused cases. */
const isIsolatedWorker =
  process.env[isolatedWorkerEnvironmentName] === '1'

/** Managed rate constructions observed only inside the isolated worker. */
const capturedRateConstructions: unknown[] = []

/** Original managed-rate factory retained before the worker installs a spy. */
const createManagedDescribeTableRate =
  managedRateModule.createWorkspaceSearchMigrationManagedDescribeTableRate

/** Dynamically loaded identity module after the isolated mocks are installed. */
let identityModule: typeof import('./migration-identity-aws') | undefined

if (isIsolatedWorker) {
  mock.module('./migration-deployment-targets', () => ({
    /** Resolves only the fixture's enabled source-controlled target. */
    resolveWorkspaceSearchMigrationRehearsalDeploymentTarget(
      targetId: string,
    ) {
      if (targetId !== 'fixture-rehearsal') {
        throw new Error('Unknown Workspace Search migration rehearsal target.')
      }
      return Object.freeze({
        targetId,
        version: 1,
        environment: 'non-production',
        deploymentAccount: requested.account,
        productionAccountDigest:
          createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
            '999999999999',
          ),
        region: requested.region,
        rehearsalEnabled: true,
        digest: digest('deployment-trust-root'),
      })
    },
  }))
  mock.module(
    './migration-describe-table-rate-managed-session',
    () => ({
      ...managedRateModule,
      /** Captures the derived recovery and allow lists before delegating. */
      async createWorkspaceSearchMigrationManagedDescribeTableRate(
        input: Parameters<
          typeof managedRateModule.createWorkspaceSearchMigrationManagedDescribeTableRate
        >[0],
      ) {
        capturedRateConstructions.push(input)
        return await createManagedDescribeTableRate(input)
      },
    }),
  )
  identityModule = await import('./migration-identity-aws')
}

/** Creates a production rate session only inside the isolated worker. */
async function createAwsWorkspaceSearchMigrationRateManagedSession(
  input: Parameters<
    NonNullable<typeof identityModule>[
      'createAwsWorkspaceSearchMigrationRateManagedSession'
    ]
  >[0],
): Promise<WorkspaceSearchMigrationRateManagedAwsSession> {
  const factory = identityModule
    ?.createAwsWorkspaceSearchMigrationRateManagedSession
  if (factory === undefined) throw new Error('identity-worker-not-loaded')
  return await factory(input)
}

/** Creates the dedicated permit-backed session only inside the worker. */
async function createAwsWorkspaceSearchMigrationRehearsalIntegritySession(
  input: CreateAwsWorkspaceSearchMigrationRehearsalIntegritySessionInput,
): Promise<WorkspaceSearchMigrationRehearsalIntegrityAwsSession> {
  const factory = identityModule
    ?.createAwsWorkspaceSearchMigrationRehearsalIntegritySession
  if (factory === undefined) throw new Error('identity-worker-not-loaded')
  return await factory(input)
}

/**
 * Reissues the authentic fixture permit/manifest/stage around real identities.
 *
 * @param options - Optional key-separation and vector mismatch variants.
 * @returns Complete pure permit, stage, attestation, and key fixture.
 */
function createIntegrityFixture(
  options: CreateIntegrityFixtureOptions = {},
): IntegrityFixture {
  const base = createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture({
    requestedResourcesBinding:
      createWorkspaceSearchMigrationRequestedResourcesBinding(requested),
  })
  const runtimeKey = new Uint8Array(base.authenticationKey)
  const integrityKey = options.integrityEqualsRuntimeKey === true
    ? new Uint8Array(runtimeKey)
    : new Uint8Array(integrityKeySeed)
  const permitVerificationKey =
    options.distinctPermitVerificationKey === true
      ? new Uint8Array(32).fill(0x44)
      : new Uint8Array(runtimeKey)
  const attestation = createResourceAttestation()
  const attestationBytes = new TextEncoder().encode(
    serializeCrossDomainIntegrityResourceAttestation(attestation),
  )
  const derivedIdentities =
    createCrossDomainIntegrityImmutableResourceIdentities(
      attestation,
      integrityKey,
    )
  const permitIdentities = options.mismatchedPermitVector === true
    ? Object.freeze(derivedIdentities.map((identity, index) =>
      index === derivedIdentities.length - 1
        ? Object.freeze({
          target: identity.target,
          identityDigest: digest('mismatched-permit-vector'),
        })
        : identity))
    : derivedIdentities
  const identityDigest =
    calculateCrossDomainIntegrityResourceIdentityDigest(
      permitIdentities,
      integrityKey,
    )
  const integrityAttestationRoot =
    parseWorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection({
      ...base.permit.integrityAttestationRoot,
      attestation: {
        ...base.permit.integrityAttestationRoot.attestation,
        byteLength: attestationBytes.byteLength,
      },
    })
  const { permitMac: _permitMac, ...basePermitClaims } = base.permit
  const permit = createWorkspaceSearchMigrationRehearsalPermit({
    claims: {
      ...basePermitClaims,
      integrityResourceIdentities: permitIdentities,
      integrityResourceIdentityDigest: identityDigest,
      integrityAttestationRoot,
    },
    signingKey: permitVerificationKey,
  })
  const { manifestMac: _manifestMac, ...baseManifestClaims } = base.manifest
  const manifest = createWorkspaceSearchMigrationRehearsalStageManifest({
    claims: {
      ...baseManifestClaims,
      permitDigest: createMigrationDigest(permit),
      integrityResourceIdentities: permitIdentities,
      integrityResourceIdentityDigest: identityDigest,
      integrityAttestationRoot,
    },
    signingKey: runtimeKey,
  })
  const selection = selectWorkspaceSearchMigrationRehearsalStage({
    manifest,
    verificationKey: runtimeKey,
    previousReceipt: null,
    controlArguments: base.controlArguments,
    faultPlanDigest: null,
  })
  const reservation = createWorkspaceSearchMigrationRehearsalStageReservation({
    selection,
    nonce: new Uint8Array(32).fill(0x52),
    reservedAt: '2026-08-02T00:05:00.000Z',
    expiresAt: '2026-08-02T00:30:00.000Z',
    expectedPreviousRateSegment: integrityAttestationRoot.segment,
    expectedCurrentRateSegmentOrdinal: 1,
    expectedTargetPreimageArtifactContentDigest: null,
    signingKey: runtimeKey,
  })
  return Object.freeze({
    attestation,
    attestationBytes,
    integrityKey,
    permitVerificationKey,
    runtimeKey,
    publicationKey: new Uint8Array(base.publicationAuthenticationKey),
    permit,
    selection,
    reservation,
    predecessor: base.integrityAttestationRootSegment,
    ratePolicy: createRatePolicy(base.policyVersion),
    configurationBindingDigest: base.configurationBindingDigest,
  })
}

/** One fresh public factory input plus transferred byte-array references. */
type IntegrityFactoryInput = {
  /** Exact public factory input. */
  readonly input: CreateAwsWorkspaceSearchMigrationRehearsalIntegritySessionInput
  /** Caller-owned attestation expected to be overwritten. */
  readonly attestationBytes: Uint8Array
  /** Caller-owned integrity key expected to be overwritten. */
  readonly integrityKey: Uint8Array
}

/** Creates one fresh dedicated factory input from a pure fixture. */
function createFactoryInput(
  fixture: IntegrityFixture,
  rateRecorder?: WorkspaceSearchMigrationRehearsalRateRecorder,
  signal?: AbortSignal,
): IntegrityFactoryInput {
  const attestationBytes = new Uint8Array(fixture.attestationBytes)
  const integrityKey = new Uint8Array(fixture.integrityKey)
  const monotonicBase = Math.floor(performance.now())
  const input: CreateAwsWorkspaceSearchMigrationRehearsalIntegritySessionInput = {
    requested,
    ratePolicy: fixture.ratePolicy,
    ...(rateRecorder === undefined ? {} : { rateRecorder }),
    permit: fixture.permit,
    permitVerificationKey: new Uint8Array(fixture.permitVerificationKey),
    permitClock: () => new Date(
      admittedAtMilliseconds +
        Math.max(0, Math.floor(performance.now()) - monotonicBase),
    ),
    stageReservationClaim: {
      reservation: fixture.reservation,
      selection: fixture.selection,
      previousReceipt: null,
      stageKey: new Uint8Array(fixture.runtimeKey),
      publicationKey: new Uint8Array(fixture.publicationKey),
    },
    resourceAttestationBytes: attestationBytes,
    integrityDigestKey: integrityKey,
    ...(signal === undefined ? {} : { signal }),
  }
  return { input, attestationBytes, integrityKey }
}

/** Runs one task with a private static profile selected only by this test. */
async function withStaticProfile<Result>(
  task: () => Promise<Result>,
): Promise<Result> {
  const directory = await mkdtemp(join(tmpdir(), 'mukuroji-integrity-live-'))
  const credentialsFile = join(directory, 'credentials')
  const configFile = join(directory, 'config')
  await writeFile(
    credentialsFile,
    `[${requested.profile}]\n` +
      'aws_access_key_id = integrity-live-access-key\n' +
      'aws_secret_access_key = integrity-live-secret-key\n',
    { mode: 0o600 },
  )
  await writeFile(configFile, '', { mode: 0o600 })
  const previousCredentialsFile = process.env.AWS_SHARED_CREDENTIALS_FILE
  const previousConfigFile = process.env.AWS_CONFIG_FILE
  process.env.AWS_SHARED_CREDENTIALS_FILE = credentialsFile
  process.env.AWS_CONFIG_FILE = configFile
  try {
    return await task()
  } finally {
    if (previousCredentialsFile === undefined) {
      delete process.env.AWS_SHARED_CREDENTIALS_FILE
    } else {
      process.env.AWS_SHARED_CREDENTIALS_FILE = previousCredentialsFile
    }
    if (previousConfigFile === undefined) {
      delete process.env.AWS_CONFIG_FILE
    } else {
      process.env.AWS_CONFIG_FILE = previousConfigFile
    }
    await rm(directory, { recursive: true, force: true })
  }
}

/** Mutable observations and persisted mock items for one isolated AWS harness. */
type AwsHarnessState = {
  /** Current durable rate checkpoint item. */
  checkpointItem?: Readonly<Record<string, AttributeValue>>
  /** Current durable claimed stage-head item. */
  stageHeadItem?: Readonly<Record<string, AttributeValue>>
  /** Whether DescribeTable counts belong to the actual live run. */
  liveMode: boolean
  /** Exact live managed DescribeTable call count. */
  liveDescribeTableCount: number
  /** Exact physical table order observed through the managed rate client. */
  readonly liveDescribeTableNames: string[]
  /** Managed DynamoDB clients that issued live DescribeTable commands. */
  readonly liveDescribeTableClients: Set<DynamoDBClient>
  /** Exact live data-plane Scan call count. */
  liveScanCount: number
  /** Live read-only DynamoDB clients that issued Scan commands. */
  readonly liveScanClients: Set<DynamoDBClient>
  /** Live S3 command names observed before any mapped response. */
  readonly liveS3CommandNames: string[]
  /** Main control/checkpoint client, which must not issue live DescribeTable. */
  controlClient?: DynamoDBClient
  /** Total exact caller-identity calls including construction. */
  callerIdentityCount: number
  /** Mutable caller ARN used to exercise the second live STS gate. */
  callerArn: string
}

/** Returns an attested or synthetic valid DescribeTable response. */
function createDescribeTableOutput(
  fixture: IntegrityFixture,
  tableName: string,
): object {
  const attested = fixture.attestation.tables.find((table) =>
    table.tableName === tableName)
  return {
    $metadata: {},
    Table: {
      TableName: tableName,
      TableArn: attested?.tableArn ??
        `arn:aws:dynamodb:${requested.region}:${requested.account}:` +
          `table/${tableName}`,
      TableId: attested?.tableId ?? `seed-${tableName}`,
      TableStatus: 'ACTIVE',
      CreationDateTime: new Date(
        attested?.creationTime ?? '2026-01-01T00:00:00.000Z',
      ),
    },
  }
}

/**
 * Runs with official SDK prototype sends replaced by deterministic AWS reads.
 *
 * @param fixture - Exact permit, caller, tags, and attested AWS resources.
 * @param task - Test body receiving mutable observations and checkpoint state.
 * @returns Task result after restoring every SDK prototype.
 */
async function withAwsHarness<Result>(
  fixture: IntegrityFixture,
  task: (state: AwsHarnessState) => Promise<Result>,
): Promise<Result> {
  const originalDynamoSend = DynamoDBClient.prototype.send
  const originalS3Send = S3Client.prototype.send
  const originalStsSend = STSClient.prototype.send
  const state: AwsHarnessState = {
    liveMode: false,
    liveDescribeTableCount: 0,
    liveDescribeTableNames: [],
    liveDescribeTableClients: new Set(),
    liveScanCount: 0,
    liveScanClients: new Set(),
    liveS3CommandNames: [],
    callerIdentityCount: 0,
    callerArn: fixture.permit.callerArn,
  }
  Reflect.set(
    DynamoDBClient.prototype,
    'send',
    function (this: DynamoDBClient, ...callArguments: unknown[]): unknown {
      const command = callArguments[0]
      if (command instanceof DescribeTableCommand) {
        const tableName = command.input.TableName
        if (tableName === undefined) {
          return Promise.reject(new Error('missing-table-name'))
        }
        if (state.liveMode) {
          state.liveDescribeTableCount += 1
          state.liveDescribeTableNames.push(tableName)
          state.liveDescribeTableClients.add(this)
        }
        return Promise.resolve(createDescribeTableOutput(fixture, tableName))
      }
      if (command instanceof ScanCommand) {
        if (state.liveMode) {
          state.liveScanCount += 1
          state.liveScanClients.add(this)
        }
        return Promise.resolve({ $metadata: {}, Items: [] })
      }
      if (command instanceof GetItemCommand) {
        state.controlClient ??= this
        const recordKey = command.input.Key?.recordKey?.S
        const stageRead = recordKey?.startsWith('rehearsal-suite/v2/') === true
        const item = stageRead ? state.stageHeadItem : state.checkpointItem
        return Promise.resolve({
          $metadata: {},
          ...(item === undefined ? {} : { Item: structuredClone(item) }),
        })
      }
      if (command instanceof TransactWriteItemsCommand) {
        const item = command.input.TransactItems?.[0]?.Put?.Item
        if (item === undefined) {
          return Promise.reject(new Error('missing-transaction-put'))
        }
        if (item.kind?.S === WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND) {
          state.stageHeadItem = structuredClone(item)
        } else {
          state.checkpointItem = structuredClone(item)
        }
        return Promise.resolve({ $metadata: {} })
      }
      return Promise.reject(new Error('unexpected-dynamodb-command'))
    },
  )
  Reflect.set(
    S3Client.prototype,
    'send',
    function (...callArguments: unknown[]): unknown {
      const command = callArguments[0]
      if (state.liveMode && typeof command === 'object' && command !== null) {
        state.liveS3CommandNames.push(command.constructor.name)
      }
      if (command instanceof GetBucketTaggingCommand) {
        return Promise.resolve({
          $metadata: {},
          TagSet: [{
            Key: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ENVIRONMENT_TAG_KEY,
            Value: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
          }, {
            Key:
              WORKSPACE_SEARCH_MIGRATION_REHEARSAL_DEPLOYMENT_TRUST_ROOT_TAG_KEY,
            Value: fixture.permit.deploymentTrustRootDigest,
          }, {
            Key:
              WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRODUCTION_ACCOUNT_DIGEST_TAG_KEY,
            Value:
              createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
                fixture.permit.productionAccount,
              ),
          }],
        })
      }
      if (command instanceof GetBucketVersioningCommand) {
        return Promise.resolve({ $metadata: {}, Status: 'Enabled' })
      }
      if (command instanceof GetObjectAttributesCommand) {
        return Promise.resolve({
          $metadata: {},
          VersionId: fixture.attestation.bucket.marker.versionId,
          Checksum: {
            ChecksumSHA256:
              fixture.attestation.bucket.marker.checksumSha256,
          },
          ObjectSize: fixture.attestation.bucket.marker.size,
        })
      }
      if (command instanceof GetObjectTaggingCommand) {
        return Promise.resolve({ $metadata: {}, TagSet: [] })
      }
      if (command instanceof HeadObjectCommand) {
        return Promise.resolve({ $metadata: {} })
      }
      return Promise.reject(new Error('unexpected-s3-command'))
    },
  )
  Reflect.set(
    STSClient.prototype,
    'send',
    function (...callArguments: unknown[]): unknown {
      if (!(callArguments[0] instanceof GetCallerIdentityCommand)) {
        return Promise.reject(new Error('unexpected-sts-command'))
      }
      state.callerIdentityCount += 1
      return Promise.resolve({
        $metadata: {},
        Account: fixture.permit.account,
        Arn: state.callerArn,
        UserId: 'AROA12345678901234567:session',
      })
    },
  )
  try {
    return await withStaticProfile(async () => await task(state))
  } finally {
    Reflect.set(DynamoDBClient.prototype, 'send', originalDynamoSend)
    Reflect.set(S3Client.prototype, 'send', originalS3Send)
    Reflect.set(STSClient.prototype, 'send', originalStsSend)
  }
}

/** Seeds the durable checkpoint with the root's exact twelve prior attempts. */
async function seedRootRateCheckpoint(fixture: IntegrityFixture): Promise<void> {
  const session = await createAwsWorkspaceSearchMigrationRateManagedSession({
    requested,
    ratePolicy: fixture.ratePolicy,
    bootstrapRateCheckpoint: true,
    recoverInterruptedCleanup: false,
    recoverInterruptedAttempt: false,
  })
  const tableNames = Object.values(requested.tables)
  for (let index = 0; index < 12; index += 1) {
    const tableName = tableNames[index % tableNames.length]
    if (tableName === undefined) throw new Error('missing-seed-table')
    await session.describeTable(tableName)
  }
  await session.close()
}

/** Creates the authentic raw stage-one rate recorder for one live operation. */
async function createLiveRecorder(
  fixture: IntegrityFixture,
): Promise<WorkspaceSearchMigrationRehearsalRateRecorder> {
  return await createWorkspaceSearchMigrationRehearsalRateRecorder({
    segmentLocatorDigest: digest('dedicated-integrity-live-segment'),
    segmentOrdinal: 1,
    previousSegmentDigest: fixture.predecessor.segmentDigest,
    previousRecordMac: fixture.predecessor.terminalRecordMac,
    firstEventSequence:
      fixture.predecessor.firstEventSequence + fixture.predecessor.eventCount,
    anchorUtc: '2026-08-02T00:10:00.000Z',
    monotonicAnchorMilliseconds: Math.floor(performance.now()),
    policyVersion: fixture.ratePolicy.policyVersion,
    configurationBindingDigest: fixture.configurationBindingDigest,
    authenticationKey: new Uint8Array(fixture.runtimeKey),
    /** Accepts every exact append in process memory for focused verification. */
    async appendDurably(): Promise<void> {},
  })
}

/** Complete live session state supplied to one lifecycle-focused test. */
type PreparedLiveSession = {
  /** Dedicated narrow session. */
  readonly session: WorkspaceSearchMigrationRehearsalIntegrityAwsSession
  /** Exact raw rate recorder for the stage-one segment. */
  readonly recorder: WorkspaceSearchMigrationRehearsalRateRecorder
  /** Pure permit/stage/attestation fixture. */
  readonly fixture: IntegrityFixture
  /** Mutable AWS observations. */
  readonly state: AwsHarnessState
}

/**
 * Seeds root count twelve and creates one genuine dedicated live session.
 *
 * @param options - Optional fixture key-separation variants.
 * @param task - Test body receiving the narrow session and raw recorder.
 */
async function withPreparedLiveSession(
  options: CreateIntegrityFixtureOptions,
  task: (prepared: PreparedLiveSession) => Promise<void>,
): Promise<void> {
  const fixture = createIntegrityFixture(options)
  await withAwsHarness(fixture, async (state) => {
    await seedRootRateCheckpoint(fixture)
    state.liveDescribeTableCount = 0
    const recorder = await createLiveRecorder(fixture)
    const factory = createFactoryInput(fixture, recorder)
    const session =
      await createAwsWorkspaceSearchMigrationRehearsalIntegritySession(
        factory.input,
      )
    try {
      expectZeroized(factory.attestationBytes)
      expectZeroized(factory.integrityKey)
      await task({ session, recorder, fixture, state })
    } finally {
      try {
        await recorder.flush()
      } catch {
        // A test may already have closed the recorder after finalization.
      }
      try {
        await recorder.close()
      } catch {
        // Preserve the focused assertion while exhausting recorder cleanup.
      }
      await session.close()
    }
  })
}

/** Runs the exact real live checker once and returns its outer pending handle. */
async function runLive(
  prepared: PreparedLiveSession,
  signal?: AbortSignal,
): Promise<{
  /** Caller-owned audit key consumed by the live invocation. */
  readonly auditKey: Uint8Array
  /** Session-owned outer pending handle. */
  readonly pending: WorkspaceSearchMigrationRehearsalIntegrityAwsPending
}> {
  const auditKey = new Uint8Array(auditKeySeed)
  prepared.state.liveMode = true
  try {
    const pending = await prepared.session.runRehearsalIntegrityLiveSession({
      auditPseudonymKey: auditKey,
      pageSize: 100,
      maxPages: 10,
      maxItems: 100,
      maximumDurationMilliseconds: 60_000,
      ...(signal === undefined ? {} : { signal }),
    })
    return { auditKey, pending }
  } catch (error: unknown) {
    throw new Error(
      `live failure after STS=${prepared.state.callerIdentityCount}, ` +
        `Describe=${prepared.state.liveDescribeTableCount}, ` +
        `Scan=${prepared.state.liveScanCount}, ` +
        `tables=${prepared.state.liveDescribeTableNames.join(',')}, ` +
        `S3=${prepared.state.liveS3CommandNames.join(',')}`,
      { cause: error },
    )
  } finally {
    prepared.state.liveMode = false
  }
}

/** Requires every byte of one transferred byte vector to be overwritten. */
function expectZeroized(bytes: Uint8Array): void {
  expect([...bytes]).toEqual(Array.from({ length: bytes.byteLength }, () => 0))
}

if (isIsolatedWorker) {
describe('permit-backed #163 AWS outer gate', () => {
  test('rejects wrong attestation, key, vector, aliases, and selectors before AWS', async () => {
    const originalStsSend = STSClient.prototype.send
    let stsCount = 0
    Reflect.set(STSClient.prototype, 'send', function (): unknown {
      stsCount += 1
      return Promise.reject(new Error('must-not-reach-sts'))
    })
    try {
      const base = createIntegrityFixture()
      const wrongKeyFactory = createFactoryInput(base)
      wrongKeyFactory.input.integrityDigestKey.fill(0x21)
      await expect(
        createAwsWorkspaceSearchMigrationRehearsalIntegritySession(
          wrongKeyFactory.input,
        ),
      ).rejects.toMatchObject({ code: 'NON_PRODUCTION_REHEARSAL_GUARD_FAILED' })
      expectZeroized(wrongKeyFactory.attestationBytes)
      expectZeroized(wrongKeyFactory.integrityKey)

      const mismatchedVector = createIntegrityFixture({
        mismatchedPermitVector: true,
      })
      const vectorFactory = createFactoryInput(mismatchedVector)
      await expect(
        createAwsWorkspaceSearchMigrationRehearsalIntegritySession(
          vectorFactory.input,
        ),
      ).rejects.toMatchObject({ code: 'NON_PRODUCTION_REHEARSAL_GUARD_FAILED' })
      expectZeroized(vectorFactory.attestationBytes)
      expectZeroized(vectorFactory.integrityKey)

      const wrongAttestation = createFactoryInput(base)
      const changedAttestation = {
        ...base.attestation,
        bucket: {
          ...base.attestation.bucket,
          bucketName: 'different-integrity-file-bucket',
        },
      }
      wrongAttestation.attestationBytes.set(
        new TextEncoder().encode(
          serializeCrossDomainIntegrityResourceAttestation(changedAttestation),
        ).subarray(0, wrongAttestation.attestationBytes.byteLength),
      )
      await expect(
        createAwsWorkspaceSearchMigrationRehearsalIntegritySession(
          wrongAttestation.input,
        ),
      ).rejects.toMatchObject({ code: 'NON_PRODUCTION_REHEARSAL_GUARD_FAILED' })
      expectZeroized(wrongAttestation.attestationBytes)
      expectZeroized(wrongAttestation.integrityKey)

      const sameKey = createIntegrityFixture({
        integrityEqualsRuntimeKey: true,
      })
      const sameKeyFactory = createFactoryInput(sameKey)
      await expect(
        createAwsWorkspaceSearchMigrationRehearsalIntegritySession(
          sameKeyFactory.input,
        ),
      ).rejects.toMatchObject({ code: 'NON_PRODUCTION_REHEARSAL_GUARD_FAILED' })
      expectZeroized(sameKeyFactory.attestationBytes)
      expectZeroized(sameKeyFactory.integrityKey)

      const mismatchedPermitKey = createIntegrityFixture({
        distinctPermitVerificationKey: true,
      })
      const mismatchedPermitKeyFactory = createFactoryInput(
        mismatchedPermitKey,
      )
      await expect(
        createAwsWorkspaceSearchMigrationRehearsalIntegritySession(
          mismatchedPermitKeyFactory.input,
        ),
      ).rejects.toMatchObject({ code: 'NON_PRODUCTION_REHEARSAL_GUARD_FAILED' })
      expectZeroized(mismatchedPermitKeyFactory.attestationBytes)
      expectZeroized(mismatchedPermitKeyFactory.integrityKey)

      const sharedPermitKey = createFactoryInput(base)
      Reflect.set(
        sharedPermitKey.input,
        'permitVerificationKey',
        new Uint8Array(new SharedArrayBuffer(32)),
      )
      await expect(
        createAwsWorkspaceSearchMigrationRehearsalIntegritySession(
          sharedPermitKey.input,
        ),
      ).rejects.toMatchObject({ code: 'NON_PRODUCTION_REHEARSAL_GUARD_FAILED' })

      const forbiddenSelector = createFactoryInput(base)
      await expect(Reflect.apply(
        createAwsWorkspaceSearchMigrationRehearsalIntegritySession,
        undefined,
        [{ ...forbiddenSelector.input, bootstrapRateCheckpoint: true }],
      )).rejects.toMatchObject({ code: 'NON_PRODUCTION_REHEARSAL_GUARD_FAILED' })
      const missingStage = createFactoryInput(base)
      const { stageReservationClaim: _stageClaim, ...withoutStage } =
        missingStage.input
      await expect(Reflect.apply(
        createAwsWorkspaceSearchMigrationRehearsalIntegritySession,
        undefined,
        [withoutStage],
      )).rejects.toMatchObject({ code: 'NON_PRODUCTION_REHEARSAL_GUARD_FAILED' })
      expect(stsCount).toBe(0)
    } finally {
      Reflect.set(STSClient.prototype, 'send', originalStsSend)
    }
  })

  test('exposes only the narrow surface and executes genuine exact twelve once', async () => {
    await withPreparedLiveSession({}, async (prepared) => {
      expect(Object.keys(prepared.session).sort()).toEqual([
        'close',
        'collectRehearsalReconciliation',
        'disposeRehearsalIntegrityLiveSession',
        'finalizeRehearsalIntegrityLiveSession',
        'interruptDescribeTableRate',
        'measureConfiguration',
        'readDescribeTableRateEvidence',
        'readRehearsalClaimedStageHead',
        'readRehearsalEvidenceSessionBinding',
        'readRequestedResourcesBinding',
        'runRehearsalIntegrityLiveSession',
        'scanTargetPage',
        'sealAndReadDescribeTableRateEvidence',
      ])
      for (const forbidden of [
        'commitNextSourceEvidencePage',
        'createRateManagedMeasurementSession',
        'describeTable',
        'faultController',
        'interruptMutationAdmission',
        'rate',
        'runWithMutationAdmissionGuard',
        'scanSourcePage',
        'transport',
      ]) {
        expect(Reflect.has(prepared.session, forbidden)).toBe(false)
      }
      const rateConstruction = capturedRateConstructions.at(-1)
      expect(
        typeof rateConstruction === 'object' && rateConstruction !== null,
      ).toBe(true)
      if (typeof rateConstruction !== 'object' || rateConstruction === null) {
        throw new Error('missing-dedicated-rate-construction')
      }
      expect(Reflect.get(rateConstruction, 'recoveryTableNames')).toEqual([
        requested.tables['project-directory'],
        requested.tables['work-items'],
        requested.tables.collaboration,
        requested.tables.documents,
        requested.tables['workspace-search'],
        requested.tables['migration-state'],
      ])
      expect(Reflect.get(rateConstruction, 'allowedTableNames')).toEqual([
        requested.tables['project-directory'],
        requested.tables['work-items'],
        requested.tables.collaboration,
        requested.tables.documents,
        requested.tables['workspace-search'],
        requested.tables['migration-state'],
        prepared.fixture.attestation.tables[0]?.tableName,
        prepared.fixture.attestation.tables[1]?.tableName,
        prepared.fixture.attestation.tables[3]?.tableName,
        prepared.fixture.attestation.tables[5]?.tableName,
      ])
      expect(Reflect.get(rateConstruction, 'bootstrap')).toBe(false)
      expect(
        Reflect.get(rateConstruction, 'recoverInterruptedCleanup'),
      ).toBe(false)
      expect(
        Reflect.get(rateConstruction, 'recoverInterruptedAttempt'),
      ).toBe(false)
      const { auditKey, pending } = await runLive(prepared)
      expectZeroized(auditKey)
      expect(prepared.state.liveDescribeTableCount).toBe(12)
      expect(prepared.state.liveScanCount).toBe(6)
      const expectedPass = prepared.fixture.attestation.tables.map(
        (table) => table.tableName,
      )
      expect(prepared.state.liveDescribeTableNames).toEqual([
        ...expectedPass,
        ...expectedPass,
      ])
      expect(prepared.state.liveDescribeTableClients.size).toBe(1)
      for (const client of prepared.state.liveDescribeTableClients) {
        expect(client).not.toBe(prepared.state.controlClient)
        expect(prepared.state.liveScanClients.has(client)).toBe(false)
      }
      const replayAuditKey = new Uint8Array(auditKeySeed)
      await expect(prepared.session.runRehearsalIntegrityLiveSession({
        auditPseudonymKey: replayAuditKey,
        pageSize: 100,
        maxPages: 10,
        maxItems: 100,
        maximumDurationMilliseconds: 60_000,
      })).rejects.toMatchObject({
        code: 'INVALID_REHEARSAL_INTEGRITY_LIVE_SESSION',
      })
      expectZeroized(replayAuditKey)
      expect(prepared.state.liveDescribeTableCount).toBe(12)
      prepared.session.disposeRehearsalIntegrityLiveSession(pending)
      expect(() =>
        prepared.session.disposeRehearsalIntegrityLiveSession(pending)
      ).toThrow('INVALID_REHEARSAL_INTEGRITY_LIVE_SESSION')
    })
  })

  test('rejects an evidence-key audit alias before live AWS and exact ARN at live STS', async () => {
    await withPreparedLiveSession({}, async (prepared) => {
      const callerIdentityCount = prepared.state.callerIdentityCount
      const auditKey = new Uint8Array(prepared.fixture.runtimeKey)
      prepared.state.liveMode = true
      try {
        await expect(prepared.session.runRehearsalIntegrityLiveSession({
          auditPseudonymKey: auditKey,
          pageSize: 100,
          maxPages: 10,
          maxItems: 100,
          maximumDurationMilliseconds: 60_000,
        })).rejects.toMatchObject({
          code: 'INVALID_REHEARSAL_INTEGRITY_LIVE_SESSION',
        })
      } finally {
        prepared.state.liveMode = false
      }
      expectZeroized(auditKey)
      expect(prepared.state.callerIdentityCount).toBe(callerIdentityCount)
      expect(prepared.state.liveDescribeTableCount).toBe(0)
      expect(prepared.state.liveScanCount).toBe(0)
    })
    await withPreparedLiveSession({}, async (prepared) => {
      const callerIdentityCount = prepared.state.callerIdentityCount
      prepared.state.callerArn =
        `arn:aws:sts::${requested.account}:` +
        'assumed-role/Rehearsal/other-session'
      const auditKey = new Uint8Array(auditKeySeed)
      prepared.state.liveMode = true
      try {
        await expect(prepared.session.runRehearsalIntegrityLiveSession({
          auditPseudonymKey: auditKey,
          pageSize: 100,
          maxPages: 10,
          maxItems: 100,
          maximumDurationMilliseconds: 60_000,
        })).rejects.toMatchObject({
          code: 'INVALID_REHEARSAL_INTEGRITY_LIVE_SESSION',
        })
      } finally {
        prepared.state.liveMode = false
      }
      expectZeroized(auditKey)
      expect(prepared.state.callerIdentityCount).toBe(
        callerIdentityCount + 1,
      )
      expect(prepared.state.liveDescribeTableCount).toBe(0)
      expect(prepared.state.liveScanCount).toBe(0)
    })
  })

  test('finalizes with the authenticated runtime key and burns double use', async () => {
    await withPreparedLiveSession({}, async (prepared) => {
      const { pending } = await runLive(prepared)
      const current = await prepared.recorder.flush()
      await prepared.recorder.close()
      const rateKey = new Uint8Array(prepared.fixture.runtimeKey)
      const result = prepared.session.finalizeRehearsalIntegrityLiveSession({
        pending,
        canonicalSegmentBytes: current.canonicalBytes,
        predecessorSegmentBytes: prepared.fixture.predecessor.canonicalBytes,
        rateAuthenticationKey: rateKey,
      })
      expectZeroized(rateKey)
      expect(result.interval.describeTableCallCount).toBe(12)
      expect(result.interval.tablePassCount).toBe(2)
      const replayKey = new Uint8Array(prepared.fixture.runtimeKey)
      expect(() => prepared.session.finalizeRehearsalIntegrityLiveSession({
        pending,
        canonicalSegmentBytes: current.canonicalBytes,
        predecessorSegmentBytes: prepared.fixture.predecessor.canonicalBytes,
        rateAuthenticationKey: replayKey,
      })).toThrow('INVALID_REHEARSAL_INTEGRITY_LIVE_SESSION')
      expectZeroized(replayKey)
      await prepared.session.sealAndReadDescribeTableRateEvidence()
    })
  })

  test('rejects integrity-key aliases and foreign re-MAC runtime keys', async () => {
    await withPreparedLiveSession({}, async (prepared) => {
      const { pending } = await runLive(prepared)
      const current = await prepared.recorder.flush()
      const equalKey = new Uint8Array(prepared.fixture.integrityKey)
      expect(() => prepared.session.finalizeRehearsalIntegrityLiveSession({
        pending,
        canonicalSegmentBytes: current.canonicalBytes,
        predecessorSegmentBytes: prepared.fixture.predecessor.canonicalBytes,
        rateAuthenticationKey: equalKey,
      })).toThrow('INVALID_REHEARSAL_INTEGRITY_LIVE_SESSION')
      expectZeroized(equalKey)
    })
    await withPreparedLiveSession({}, async (prepared) => {
      const { pending } = await runLive(prepared)
      const current = await prepared.recorder.flush()
      const foreignKey = new Uint8Array(32).fill(0x31)
      expect(() => prepared.session.finalizeRehearsalIntegrityLiveSession({
        pending,
        canonicalSegmentBytes: current.canonicalBytes,
        predecessorSegmentBytes: prepared.fixture.predecessor.canonicalBytes,
        rateAuthenticationKey: foreignKey,
      })).toThrow('INVALID_REHEARSAL_INTEGRITY_LIVE_SESSION')
      expectZeroized(foreignKey)
    })
  })

  test('abort, seal, and close burn every unfinalized outer pending', async () => {
    await withPreparedLiveSession({}, async (prepared) => {
      const controller = new AbortController()
      const { pending } = await runLive(prepared, controller.signal)
      controller.abort()
      expect(() =>
        prepared.session.disposeRehearsalIntegrityLiveSession(pending)
      ).toThrow('INVALID_REHEARSAL_INTEGRITY_LIVE_SESSION')
    })
    await withPreparedLiveSession({}, async (prepared) => {
      const { pending } = await runLive(prepared)
      await prepared.session.sealAndReadDescribeTableRateEvidence()
      expect(() =>
        prepared.session.disposeRehearsalIntegrityLiveSession(pending)
      ).toThrow('INVALID_REHEARSAL_INTEGRITY_LIVE_SESSION')
    })
    await withPreparedLiveSession({}, async (prepared) => {
      const { pending } = await runLive(prepared)
      await prepared.session.close()
      expect(() =>
        prepared.session.disposeRehearsalIntegrityLiveSession(pending)
      ).toThrow('INVALID_REHEARSAL_INTEGRITY_LIVE_SESSION')
      const afterCloseKey = new Uint8Array(auditKeySeed)
      await expect(prepared.session.runRehearsalIntegrityLiveSession({
        auditPseudonymKey: afterCloseKey,
        pageSize: 100,
        maxPages: 10,
        maxItems: 100,
        maximumDurationMilliseconds: 60_000,
      })).rejects.toMatchObject({
        code: 'INVALID_REHEARSAL_INTEGRITY_LIVE_SESSION',
      })
      expectZeroized(afterCloseKey)
    })
  }, 15_000)
})
} else {
  describe('permit-backed #163 AWS outer gate isolation', () => {
    test('passes every factory and lifecycle case in an isolated worker', async () => {
      const subprocess = Bun.spawn({
        cmd: [process.execPath, 'test', import.meta.path],
        env: {
          ...process.env,
          [isolatedWorkerEnvironmentName]: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [exitCode, standardOutput, standardError] = await Promise.all([
        subprocess.exited,
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
      ])
      if (exitCode !== 0) {
        throw new Error(
          `isolated integrity AWS worker failed:\n${standardError}${standardOutput}`,
        )
      }
    }, 30_000)
  })
}
