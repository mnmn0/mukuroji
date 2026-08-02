import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AttributeValue,
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb'
import {
  GetBucketTaggingCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { STSClient } from '@aws-sdk/client-sts'
import {
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
} from '../../data-integrity/cross-domain-integrity'
import { createMigrationDigest } from './migration-contract'
import {
  createAwsWorkspaceSearchMigrationIdentityPort,
  createAwsWorkspaceSearchMigrationNonProductionRehearsalSession,
  createAwsWorkspaceSearchMigrationRateManagedSession,
} from './migration-identity-aws'
import {
  createWorkspaceSearchMigrationRequestedResourcesBinding,
  type WorkspaceSearchMigrationRequestedResources,
} from './migration-identity'
import type {
  WorkspaceSearchMigrationDescribeTableRatePolicy,
} from './migration-describe-table-rate-budget'
import {
  createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
  type WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
} from './migration-rehearsal-stage-child-material.test-fixture'
import {
  createWorkspaceSearchMigrationRehearsalStageReservation,
  type WorkspaceSearchMigrationRehearsalStageReservation,
} from './migration-rehearsal-stage-reservation'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
} from './migration-rehearsal-stage-reservation-chain'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND,
} from './migration-rehearsal-stage-reservation-aws'
import {
  parseWorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection,
} from './migration-rehearsal-integrity-rate-evidence'
import {
  createWorkspaceSearchMigrationRehearsalProductionAccountDigest,
  createWorkspaceSearchMigrationRehearsalPermit,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_DEPLOYMENT_TRUST_ROOT_TAG_KEY,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ENVIRONMENT_TAG_KEY,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRODUCTION_ACCOUNT_DIGEST_TAG_KEY,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
} from './migration-rehearsal-permit'

const account = '123456789012'
const callerArn =
  `arn:aws:sts::${account}:assumed-role/MigrationRehearsal/` +
  'reviewed-session'
const permitKey = new Uint8Array(32).fill(9)
const deploymentTrustRootDigest = 'd'.repeat(64)
const deploymentTargetId = 'test-rehearsal'
const productionAccount = '210987654321'
const configurationBindingDigest = 'c'.repeat(64)
const fixedTime = new Date('2026-08-01T03:00:00.000Z')

/** Trusted instant inside the stage-fixture permit and reservation. */
const stageClaimTime = new Date('2026-08-02T00:10:00.000Z')

/** Canonical keyed resource vector used by the standalone guard fixture. */
const integrityResourceIdentities = Object.freeze(
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.map((target, index) =>
    Object.freeze({
      target,
      identityDigest: createMigrationDigest({
        label: `standalone-integrity-resource:${index}:${target}`,
      }),
    })
  ),
)

/** Exact resources selected by the isolated rehearsal fixture. */
const requested: WorkspaceSearchMigrationRequestedResources = {
  account,
  region: 'ap-northeast-1',
  profile: 'migration-rehearsal-test',
  commit: 'a'.repeat(40),
  tables: {
    'project-directory': 'rehearsal-project-directory',
    'work-items': 'rehearsal-work-items',
    collaboration: 'rehearsal-collaboration',
    documents: 'rehearsal-documents',
    'workspace-search': 'rehearsal-workspace-search',
    'migration-state': 'rehearsal-migration-state',
  },
  journalBucket: 'rehearsal-journal-bucket',
  journalKeyArn:
    `arn:aws:kms:ap-northeast-1:${account}:key/` +
    '11111111-2222-4333-8444-555555555555',
}

/** Resources matching the authenticated reusable stage fixture. */
const stageRequested: WorkspaceSearchMigrationRequestedResources = {
  account: '111111111111',
  region: 'us-east-1',
  profile: requested.profile,
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

/** Rate policy large enough for one isolated composition lifecycle. */
const ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy = {
  policyVersion: 'b'.repeat(64),
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

/**
 * Creates one parser-validated ordinal-zero root projection.
 *
 * @param rootStartedAt - Trusted root operation start before permit issuance.
 * @param rootCompletedAt - Trusted root completion before permit issuance.
 * @returns Structurally strict projection bound to the standalone permit.
 */
function createIntegrityAttestationRootProjection(
  rootStartedAt: string,
  rootCompletedAt: string,
) {
  const aggregate = {
    version: 1,
    policyVersion: ratePolicy.policyVersion,
    attemptCount: 12,
    forfeitedAttemptCount: 0,
    throttleCount: 0,
    budgetStopCount: 0,
    cadenceWaitCount: 0,
    cadenceWaitMilliseconds: 0,
    maximumInFlight: 1,
  }
  return parseWorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-integrity-attestation-root-projection',
    version: 1,
    deploymentTargetId,
    productionAccountDigest:
      createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
        productionAccount,
      ),
    configurationBindingDigest,
    policyVersion: ratePolicy.policyVersion,
    attestation: {
      contentMac: createMigrationDigest('identity-root-attestation'),
      byteLength: 1_024,
    },
    segment: {
      authenticationKeyFingerprint:
        createMigrationDigest('identity-root-rate-key'),
      segmentLocatorDigest:
        createMigrationDigest('identity-root-segment-locator'),
      segmentOrdinal: 0,
      firstEventSequence: 1,
      eventCount: 24,
      firstCommittedEventSequence: 1,
      lastCommittedEventSequence: 24,
      terminalRecordMac:
        createMigrationDigest('identity-root-terminal-record'),
      segmentDigest: createMigrationDigest('identity-root-segment'),
    },
    interval: {
      kind:
        'mukuroji-workspace-search-migration-rehearsal-integrity-rate-interval',
      version: 1,
      phase: 'integrity-check',
      tablePassCount: 1,
      describeTableCallCount: 6,
      firstAttemptSequence: 7,
      lastAttemptSequence: 12,
      attemptSequences: [7, 8, 9, 10, 11, 12],
      firstEventSequence: 13,
      lastEventSequence: 24,
      eventSequences: Array.from(
        { length: 12 },
        (_value, index) => index + 13,
      ),
      cadenceWaitCount: 0,
      cadenceWaitMilliseconds: 0,
      startedAt: rootStartedAt,
      completedAt: rootCompletedAt,
    },
    aggregate,
    aggregateDigest: createMigrationDigest(aggregate),
    tableOrderBindingMac:
      createMigrationDigest('identity-root-table-order'),
    rootMac: createMigrationDigest('identity-root'),
    startedAt: rootStartedAt,
    completedAt: rootCompletedAt,
  })
}

/** Creates one permit bound to the exact fixture role and resources. */
function createPermit() {
  return createWorkspaceSearchMigrationRehearsalPermit({
    claims: {
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND,
      permitVersion:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION,
      stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
      approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
      account,
      productionAccount,
      region: requested.region,
      callerArn,
      commit: requested.commit,
      deploymentTargetId,
      deploymentTrustRootDigest,
      requestedResourcesBinding:
        createWorkspaceSearchMigrationRequestedResourcesBinding(requested),
      configurationBindingDigest,
      policyVersion: ratePolicy.policyVersion,
      integrityResourceIdentityScheme:
        CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
      integrityResourceIdentities,
      integrityResourceIdentityDigest: 'c'.repeat(64),
      evidenceKeyDigest: createHash('sha256')
        .update(permitKey)
        .digest('hex'),
      publicationKeyDigest: createHash('sha256')
        .update('publication-key', 'utf8')
        .digest('hex'),
      integrityAttestationRoot:
        createIntegrityAttestationRootProjection(
          '2026-07-31T23:59:58.000Z',
          '2026-07-31T23:59:59.999Z',
        ),
      issuedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-08-01T06:00:00.000Z',
    },
    signingKey: permitKey,
  })
}

/** Authenticated reservation material matching the stage factory resources. */
type StageFactoryFixture = {
  /** Complete authentic permit, manifest, and selection fixture. */
  readonly material:
    WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture
  /** Exact authentic first-stage reservation. */
  readonly reservation:
    WorkspaceSearchMigrationRehearsalStageReservation
}

/**
 * Creates authentic first-stage material bound to the integration resources.
 *
 * @returns Fresh stage key, permit, selection, and reservation.
 */
function createStageFactoryFixture(): StageFactoryFixture {
  const material =
    createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture({
      requestedResourcesBinding:
        createWorkspaceSearchMigrationRequestedResourcesBinding(
          stageRequested,
        ),
      configurationBindingDigest: 'c'.repeat(64),
      policyVersion: ratePolicy.policyVersion,
    })
  const reservation =
    createWorkspaceSearchMigrationRehearsalStageReservation({
      selection: material.selection,
      nonce: new Uint8Array(32).fill(0x51),
      reservedAt: '2026-08-02T00:05:00.000Z',
      expiresAt: '2026-08-02T00:30:00.000Z',
      expectedPreviousRateSegment: null,
      expectedCurrentRateSegmentOrdinal: 0,
      expectedTargetPreimageArtifactContentDigest: null,
      signingKey: material.authenticationKey,
    })
  return Object.freeze({ material, reservation })
}

/** Runs with a private static profile selected only by this test. */
async function withStaticProfile<Result>(
  task: () => Promise<Result>,
): Promise<Result> {
  const directory = await mkdtemp(
    join(tmpdir(), 'mukuroji-migration-rehearsal-profile-'),
  )
  const credentialsFile = join(directory, 'credentials')
  const configFile = join(directory, 'config')
  await writeFile(
    credentialsFile,
    `[${requested.profile}]\n` +
      'aws_access_key_id = rehearsal-access-key\n' +
      'aws_secret_access_key = rehearsal-secret-key\n',
    { mode: 0o600 },
  )
  await writeFile(configFile, '', { mode: 0o600 })
  const previousCredentialsFile =
    process.env.AWS_SHARED_CREDENTIALS_FILE
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

describe('non-production migration rehearsal AWS guard', () => {
  test('authenticates STS and journal tag before the first rate mutation', async () => {
    const originalStsSend = STSClient.prototype.send
    const originalS3Send = S3Client.prototype.send
    const originalDynamoDbSend = DynamoDBClient.prototype.send
    const events: string[] = []
    let permitTime = new Date(fixedTime)
    let checkpointItem:
      Readonly<Record<string, AttributeValue>> | undefined
    Reflect.set(STSClient.prototype, 'send', function (): unknown {
      events.push('sts')
      return Promise.resolve({
        $metadata: {},
        Account: account,
        Arn: callerArn,
        UserId: 'AROA12345678901234567:reviewed-session',
      })
    })
    Reflect.set(
      S3Client.prototype,
      'send',
      function (...callArguments: unknown[]): unknown {
        const command = callArguments[0]
        if (!(command instanceof GetBucketTaggingCommand)) {
          return Promise.reject(new Error('unexpected-s3-command'))
        }
        events.push('journal-tag')
        return Promise.resolve({
          $metadata: {},
          TagSet: [{
            Key: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ENVIRONMENT_TAG_KEY,
            Value: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
          }, {
            Key:
              WORKSPACE_SEARCH_MIGRATION_REHEARSAL_DEPLOYMENT_TRUST_ROOT_TAG_KEY,
            Value: deploymentTrustRootDigest,
          }, {
            Key:
              WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRODUCTION_ACCOUNT_DIGEST_TAG_KEY,
            Value:
              createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
                '210987654321',
              ),
          }],
        })
      },
    )
    Reflect.set(
      DynamoDBClient.prototype,
      'send',
      function (...callArguments: unknown[]): unknown {
        const command = callArguments[0]
        if (command instanceof GetItemCommand) {
          events.push('rate-read')
          return Promise.resolve({
            $metadata: {},
            ...(checkpointItem === undefined
              ? {}
              : { Item: structuredClone(checkpointItem) }),
          })
        }
        if (command instanceof TransactWriteItemsCommand) {
          events.push('rate-write')
          const item = command.input.TransactItems?.[0]?.Put?.Item
          if (item === undefined) {
            return Promise.reject(new Error('expected-rate-checkpoint'))
          }
          checkpointItem = structuredClone(item)
          return Promise.resolve({ $metadata: {} })
        }
        return Promise.reject(new Error('unexpected-dynamodb-command'))
      },
    )
    try {
      await withStaticProfile(async () => {
        const session =
          await createAwsWorkspaceSearchMigrationNonProductionRehearsalSession({
            requested,
            ratePolicy,
            bootstrapRateCheckpoint: true,
            recoverInterruptedCleanup: false,
            recoverInterruptedAttempt: false,
            permit: createPermit(),
            permitVerificationKey: permitKey,
            permitClock: () => new Date(permitTime),
          })
        const permitValidity = session.readRehearsalPermitValidity()
        expect(permitValidity).toEqual({
          issuedAt: '2026-08-01T00:00:00.000Z',
          expiresAt: '2026-08-01T06:00:00.000Z',
        })
        expect(Object.isFrozen(permitValidity)).toBe(true)
        expect(session.readRehearsalClaimedStageHead()).toBeUndefined()
        expect(() => session.createRehearsalArtifactPublisher({
          clock: () => new Date(fixedTime),
          requestTimeoutMilliseconds: 1_000,
        })).toThrow('NON_PRODUCTION_REHEARSAL_GUARD_FAILED')
        expect(() => session.createRehearsalEvidencePublisher({
          clock: () => new Date(fixedTime),
          requestTimeoutMilliseconds: 1_000,
        })).toThrow('NON_PRODUCTION_REHEARSAL_GUARD_FAILED')
        const measurementSession =
          await session.createRateManagedMeasurementSession()
        const admittedEventCount = events.length
        permitTime = new Date('2026-08-01T06:00:00.000Z')
        await expect(
          session.describeTable(requested.tables.documents),
        ).rejects.toMatchObject({
          code: 'NON_PRODUCTION_REHEARSAL_GUARD_FAILED',
        })
        await expect(
          measurementSession.describeTable(requested.tables.documents),
        ).rejects.toMatchObject({
          code: 'NON_PRODUCTION_REHEARSAL_GUARD_FAILED',
        })
        expect(() => session.readRehearsalPermitValidity()).toThrow(
          'NON_PRODUCTION_REHEARSAL_GUARD_FAILED',
        )
        expect(events).toHaveLength(admittedEventCount)
        measurementSession.close()
        await session.close()
      })
      expect(events.slice(0, 2)).toEqual(['sts', 'journal-tag'])
      expect(events.indexOf('rate-read')).toBeGreaterThan(
        events.indexOf('journal-tag'),
      )
      expect(events.indexOf('rate-write')).toBeGreaterThan(
        events.indexOf('journal-tag'),
      )
    } finally {
      Reflect.set(STSClient.prototype, 'send', originalStsSend)
      Reflect.set(S3Client.prototype, 'send', originalS3Send)
      Reflect.set(
        DynamoDBClient.prototype,
        'send',
        originalDynamoDbSend,
      )
    }
  })

  test('claims stage material and seals rate before publication-only I/O', async () => {
    const originalStsSend = STSClient.prototype.send
    const originalS3Send = S3Client.prototype.send
    const originalDynamoDbSend = DynamoDBClient.prototype.send
    const fixture = createStageFactoryFixture()
    const rawReservation = structuredClone(fixture.reservation)
    const rawSelection = structuredClone(fixture.material.selection)
    const rawStageKey = new Uint8Array(
      fixture.material.authenticationKey,
    )
    let admissionTime = new Date(stageClaimTime)
    const events: string[] = []
    let stageHeadItem:
      Readonly<Record<string, AttributeValue>> | undefined
    let checkpointItem:
      Readonly<Record<string, AttributeValue>> | undefined
    let artifactPut: PutObjectCommand | undefined
    Reflect.set(STSClient.prototype, 'send', function (): unknown {
      events.push('sts')
      Reflect.set(
        rawReservation,
        'expiresAt',
        '2026-08-02T00:09:00.000Z',
      )
      Reflect.set(rawSelection.entry, 'command', 'release')
      rawStageKey.fill(0)
      return Promise.resolve({
        $metadata: {},
        Account: fixture.material.permit.account,
        Arn: fixture.material.permit.callerArn,
        UserId: 'AROA12345678901234567:session',
      })
    })
    Reflect.set(
      S3Client.prototype,
      'send',
      function (...callArguments: unknown[]): unknown {
        const command = callArguments[0]
        if (command instanceof PutObjectCommand) {
          events.push('artifact-put')
          artifactPut = command
          admissionTime = new Date('2026-08-02T00:30:00.000Z')
          return Promise.resolve({ $metadata: {}, VersionId: 'version-1' })
        }
        if (command instanceof HeadObjectCommand) {
          const put = artifactPut
          if (put === undefined) {
            return Promise.reject(new Error('missing-artifact-put'))
          }
          events.push('artifact-head')
          return Promise.resolve({
            $metadata: {},
            VersionId: 'version-1',
            ContentLength: put.input.ContentLength,
            ContentType: put.input.ContentType,
            ChecksumSHA256: put.input.ChecksumSHA256,
            ChecksumType: 'FULL_OBJECT',
            ServerSideEncryption: put.input.ServerSideEncryption,
            SSEKMSKeyId: put.input.SSEKMSKeyId,
            BucketKeyEnabled: put.input.BucketKeyEnabled,
            ObjectLockMode: put.input.ObjectLockMode,
            ObjectLockRetainUntilDate:
              put.input.ObjectLockRetainUntilDate,
            Metadata: put.input.Metadata,
          })
        }
        if (!(command instanceof GetBucketTaggingCommand)) {
          return Promise.reject(new Error('unexpected-s3-command'))
        }
        events.push('journal-tag')
        return Promise.resolve({
          $metadata: {},
          TagSet: [{
            Key: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ENVIRONMENT_TAG_KEY,
            Value: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
          }, {
            Key:
              WORKSPACE_SEARCH_MIGRATION_REHEARSAL_DEPLOYMENT_TRUST_ROOT_TAG_KEY,
            Value: fixture.material.permit.deploymentTrustRootDigest,
          }, {
            Key:
              WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRODUCTION_ACCOUNT_DIGEST_TAG_KEY,
            Value:
              createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
                fixture.material.permit.productionAccount,
              ),
          }],
        })
      },
    )
    Reflect.set(
      DynamoDBClient.prototype,
      'send',
      function (...callArguments: unknown[]): unknown {
        const command = callArguments[0]
        if (command instanceof GetItemCommand) {
          const recordKey = command.input.Key?.recordKey?.S
          const isStageRead =
            recordKey?.startsWith('rehearsal-suite/v2/') === true
          events.push(isStageRead ? 'stage-read' : 'rate-read')
          const item = isStageRead ? stageHeadItem : checkpointItem
          return Promise.resolve({
            $metadata: {},
            ...(item === undefined
              ? {}
              : { Item: structuredClone(item) }),
          })
        }
        if (command instanceof TransactWriteItemsCommand) {
          const item = command.input.TransactItems?.[0]?.Put?.Item
          if (item === undefined) {
            return Promise.reject(new Error('expected-state-put'))
          }
          if (
            item.kind?.S ===
              WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND
          ) {
            events.push('stage-write')
            stageHeadItem = structuredClone(item)
          } else {
            events.push('rate-write')
            checkpointItem = structuredClone(item)
          }
          return Promise.resolve({ $metadata: {} })
        }
        return Promise.reject(new Error('unexpected-dynamodb-command'))
      },
    )
    try {
      await withStaticProfile(async () => {
        const session =
          await createAwsWorkspaceSearchMigrationNonProductionRehearsalSession({
            requested: stageRequested,
            ratePolicy,
            bootstrapRateCheckpoint: true,
            recoverInterruptedCleanup: false,
            recoverInterruptedAttempt: false,
            permit: fixture.material.permit,
            permitVerificationKey:
              fixture.material.authenticationKey,
            permitClock: () => new Date(admissionTime),
            stageReservationClaim: {
              reservation: rawReservation,
              selection: rawSelection,
              previousReceipt: null,
              stageKey: rawStageKey,
              publicationKey:
                fixture.material.publicationAuthenticationKey,
            },
          })
        const claimedHead = session.readRehearsalClaimedStageHead()
        expect(claimedHead).toEqual({
          manifestDigest: fixture.material.selection.manifestDigest,
          completedStageOrdinal: 0,
          headReceiptDigest: null,
          activeReservationDigest:
            createMigrationDigest(fixture.reservation),
          activeStageOrdinal: 1,
          activeExpiresAt: '2026-08-02T00:30:00.000Z',
          abandonmentCount: 0,
          abandonmentRootDigest:
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
          revision: 1,
        })
        expect(Object.isFrozen(claimedHead)).toBe(true)
        const rereadHead = session.readRehearsalClaimedStageHead()
        expect(rereadHead).toEqual(claimedHead)
        expect(rereadHead).not.toBe(claimedHead)
        expect(Object.keys(claimedHead ?? {})).toEqual([
          'manifestDigest',
          'completedStageOrdinal',
          'headReceiptDigest',
          'activeReservationDigest',
          'activeStageOrdinal',
          'activeExpiresAt',
          'abandonmentCount',
          'abandonmentRootDigest',
          'revision',
        ])
        const measurementSession =
          await session.createRateManagedMeasurementSession()
        admissionTime = new Date('2026-08-02T00:30:00.000Z')
        const rejectedEventCount = events.length
        await expect(
          session.describeTable(stageRequested.tables.documents),
        ).rejects.toMatchObject({
          code: 'NON_PRODUCTION_REHEARSAL_GUARD_FAILED',
        })
        await expect(
          measurementSession.describeTable(stageRequested.tables.documents),
        ).rejects.toMatchObject({
          code: 'NON_PRODUCTION_REHEARSAL_GUARD_FAILED',
        })
        expect(events).toHaveLength(rejectedEventCount)
        await measurementSession.close()
        admissionTime = new Date(stageClaimTime)
        expect(Reflect.set(
          session,
          'measuredConfigurationHash',
          createHash('sha256')
            .update('sealed-publication-configuration', 'utf8')
            .digest('hex'),
        )).toBe(true)
        expect(Reflect.set(
          session,
          'measuredConfiguration',
          Object.freeze({}),
        )).toBe(true)
        const sessionBinding =
          session.readRehearsalEvidenceSessionBinding()
        const runtimeKeyDigest = createHash('sha256')
          .update(fixture.material.authenticationKey)
          .digest('hex')
        const publicationKeyDigest = createHash('sha256')
          .update(fixture.material.publicationAuthenticationKey)
          .digest('hex')
        expect(sessionBinding.evidenceKeyDigest).toBe(runtimeKeyDigest)
        expect(sessionBinding.publicationKeyDigest).toBe(
          publicationKeyDigest,
        )
        expect(sessionBinding.evidenceKeyDigest).not.toBe(
          sessionBinding.publicationKeyDigest,
        )
        expect(sessionBinding).toMatchObject({
          evidenceKeyDigest: fixture.material.permit.evidenceKeyDigest,
          publicationKeyDigest:
            fixture.material.permit.publicationKeyDigest,
        })
        const sealedEvidence =
          session.sealAndReadDescribeTableRateEvidence()
        expect(
          session.sealAndReadDescribeTableRateEvidence(),
        ).toBe(sealedEvidence)
        await expect(sealedEvidence).resolves.toMatchObject({
          policyVersion: ratePolicy.policyVersion,
        })
        expect(() => session.readDescribeTableRateEvidence()).toThrow(
          'MANAGED_DESCRIBE_TABLE_RATE_FAILED',
        )
        await expect(
          session.describeTable(stageRequested.tables.documents),
        ).rejects.toMatchObject({ code: 'INVALID_STATE' })
        await expect(session.measureConfiguration()).rejects.toThrow()
        const publisher = session.createRehearsalArtifactPublisher({
          clock: () => new Date(stageClaimTime),
          requestTimeoutMilliseconds: 1_000,
        })
        admissionTime = new Date('2026-08-02T00:29:59.999Z')
        await expect(publisher.publishArtifact({
          artifactBytes: new TextEncoder().encode('{"sealed":true}'),
          completedAt: '2026-08-02T00:10:00.000Z',
          kind: 'scenario-results',
          retainedUntil: '2027-08-02T00:10:00.000Z',
        })).resolves.toMatchObject({
          kind: 'scenario-results',
        })
        const publishedEventCount = events.length
        await expect(publisher.publishArtifact({
          artifactBytes: new TextEncoder().encode('{"expired":true}'),
          completedAt: '2026-08-02T00:10:01.000Z',
          kind: 'scenario-results',
          retainedUntil: '2027-08-02T00:10:01.000Z',
        })).rejects.toMatchObject({
          code: 'PERMIT_INACTIVE',
        })
        expect(events).toHaveLength(publishedEventCount)
        publisher.close()
        await session.close()
        expect(
          session.sealAndReadDescribeTableRateEvidence(),
        ).toBe(sealedEvidence)

        const replayEventOffset = events.length
        await expect(
          createAwsWorkspaceSearchMigrationNonProductionRehearsalSession({
            requested: stageRequested,
            ratePolicy,
            bootstrapRateCheckpoint: true,
            recoverInterruptedCleanup: false,
            recoverInterruptedAttempt: false,
            permit: fixture.material.permit,
            permitVerificationKey:
              fixture.material.authenticationKey,
            permitClock: () => new Date(stageClaimTime),
            stageReservationClaim: {
              reservation: fixture.reservation,
              selection: fixture.material.selection,
              previousReceipt: null,
              stageKey: fixture.material.authenticationKey,
              publicationKey:
                fixture.material.publicationAuthenticationKey,
            },
          }),
        ).rejects.toMatchObject({
          reason: 'invalid-lifecycle',
        })
        expect(events.slice(replayEventOffset)).toEqual([
          'sts',
          'journal-tag',
          'stage-read',
          'rate-read',
          'rate-read',
        ])
      })
      expect(rawReservation.expiresAt).toBe(
        '2026-08-02T00:09:00.000Z',
      )
      expect(rawSelection.entry.command).toBe('release')
      expect(rawStageKey).toEqual(new Uint8Array(32))
      expect(events.slice(0, 4)).toEqual([
        'sts',
        'journal-tag',
        'stage-read',
        'stage-write',
      ])
      expect(events.indexOf('rate-read')).toBeGreaterThan(
        events.indexOf('stage-write'),
      )
      expect(events.indexOf('rate-write')).toBeGreaterThan(
        events.indexOf('stage-write'),
      )
    } finally {
      Reflect.set(STSClient.prototype, 'send', originalStsSend)
      Reflect.set(S3Client.prototype, 'send', originalS3Send)
      Reflect.set(
        DynamoDBClient.prototype,
        'send',
        originalDynamoDbSend,
      )
    }
  })

  test('fails closed on a substituted stage key before STS', async () => {
    const originalStsSend = STSClient.prototype.send
    const fixture = createStageFactoryFixture()
    let stsCount = 0
    Reflect.set(STSClient.prototype, 'send', function (): unknown {
      stsCount += 1
      return Promise.reject(new Error('must-not-reach-sts'))
    })
    try {
      await expect(
        createAwsWorkspaceSearchMigrationNonProductionRehearsalSession({
          requested: stageRequested,
          ratePolicy,
          bootstrapRateCheckpoint: true,
          recoverInterruptedCleanup: false,
          recoverInterruptedAttempt: false,
          permit: fixture.material.permit,
          permitVerificationKey: fixture.material.authenticationKey,
          permitClock: () => new Date(stageClaimTime),
          stageReservationClaim: {
            reservation: fixture.reservation,
            selection: fixture.material.selection,
            previousReceipt: null,
            stageKey: new Uint8Array(32).fill(0x52),
            publicationKey:
              fixture.material.publicationAuthenticationKey,
          },
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_STAGE_RESERVATION_STATE',
      })
      expect(stsCount).toBe(0)
    } finally {
      Reflect.set(STSClient.prototype, 'send', originalStsSend)
    }
  })

  test('surfaces an uncertain stage CAS before any rate checkpoint I/O', async () => {
    const originalStsSend = STSClient.prototype.send
    const originalS3Send = S3Client.prototype.send
    const originalDynamoDbSend = DynamoDBClient.prototype.send
    const fixture = createStageFactoryFixture()
    const events: string[] = []
    Reflect.set(STSClient.prototype, 'send', function (): unknown {
      events.push('sts')
      return Promise.resolve({
        $metadata: {},
        Account: fixture.material.permit.account,
        Arn: fixture.material.permit.callerArn,
        UserId: 'AROA12345678901234567:session',
      })
    })
    Reflect.set(
      S3Client.prototype,
      'send',
      function (...callArguments: unknown[]): unknown {
        if (!(callArguments[0] instanceof GetBucketTaggingCommand)) {
          return Promise.reject(new Error('unexpected-s3-command'))
        }
        events.push('journal-tag')
        return Promise.resolve({
          $metadata: {},
          TagSet: [{
            Key: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ENVIRONMENT_TAG_KEY,
            Value: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
          }, {
            Key:
              WORKSPACE_SEARCH_MIGRATION_REHEARSAL_DEPLOYMENT_TRUST_ROOT_TAG_KEY,
            Value: fixture.material.permit.deploymentTrustRootDigest,
          }, {
            Key:
              WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRODUCTION_ACCOUNT_DIGEST_TAG_KEY,
            Value:
              createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
                fixture.material.permit.productionAccount,
              ),
          }],
        })
      },
    )
    Reflect.set(
      DynamoDBClient.prototype,
      'send',
      function (...callArguments: unknown[]): unknown {
        const command = callArguments[0]
        if (command instanceof GetItemCommand) {
          const recordKey = command.input.Key?.recordKey?.S
          if (
            recordKey?.startsWith('rehearsal-suite/v2/') !== true
          ) {
            events.push('rate-read')
            return Promise.reject(new Error('must-not-reach-rate-read'))
          }
          events.push('stage-read')
          return Promise.resolve({ $metadata: {} })
        }
        if (command instanceof TransactWriteItemsCommand) {
          const kind =
            command.input.TransactItems?.[0]?.Put?.Item?.kind?.S
          if (
            kind !==
              WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND
          ) {
            events.push('rate-write')
            return Promise.reject(new Error('must-not-reach-rate-write'))
          }
          events.push('stage-write')
          return Promise.reject(new Error('uncertain-stage-transport'))
        }
        return Promise.reject(new Error('unexpected-dynamodb-command'))
      },
    )
    try {
      await withStaticProfile(async () => {
        await expect(
          createAwsWorkspaceSearchMigrationNonProductionRehearsalSession({
            requested: stageRequested,
            ratePolicy,
            bootstrapRateCheckpoint: true,
            recoverInterruptedCleanup: false,
            recoverInterruptedAttempt: false,
            permit: fixture.material.permit,
            permitVerificationKey:
              fixture.material.authenticationKey,
            permitClock: () => new Date(stageClaimTime),
            stageReservationClaim: {
              reservation: fixture.reservation,
              selection: fixture.material.selection,
              previousReceipt: null,
              stageKey: fixture.material.authenticationKey,
              publicationKey:
                fixture.material.publicationAuthenticationKey,
            },
          }),
        ).rejects.toMatchObject({
          code: 'STAGE_RESERVATION_TRANSPORT_UNCERTAIN',
        })
      })
      expect(events).toEqual([
        'sts',
        'journal-tag',
        'stage-read',
        'stage-write',
        'stage-read',
      ])
    } finally {
      Reflect.set(STSClient.prototype, 'send', originalStsSend)
      Reflect.set(S3Client.prototype, 'send', originalS3Send)
      Reflect.set(
        DynamoDBClient.prototype,
        'send',
        originalDynamoDbSend,
      )
    }
  })

  test('keeps rehearsal stage claims outside the production capability', async () => {
    const fixture = createStageFactoryFixture()
    let claimGetterReads = 0
    const productionInput = {
      requested: stageRequested,
      ratePolicy,
      bootstrapRateCheckpoint: true,
      recoverInterruptedCleanup: false,
      recoverInterruptedAttempt: false,
      get stageReservationClaim() {
        claimGetterReads += 1
        return {
          reservation: fixture.reservation,
          selection: fixture.material.selection,
          stageKey: fixture.material.authenticationKey,
        }
      },
    }
    await expect(
      createAwsWorkspaceSearchMigrationRateManagedSession(
        productionInput,
      ),
    ).rejects.toBeInstanceOf(Error)
    expect(claimGetterReads).toBe(0)

    const productionSession =
      createAwsWorkspaceSearchMigrationIdentityPort(stageRequested)
    try {
      const reflectiveRead = Reflect.get(
        productionSession,
        'readRehearsalClaimedStageHead',
      )
      expect(typeof reflectiveRead).toBe('function')
      if (typeof reflectiveRead !== 'function') {
        throw new Error('Expected guarded reflective stage-head reader.')
      }
      expect(() => Reflect.apply(
        reflectiveRead,
        productionSession,
        [],
      )).toThrow('NON_PRODUCTION_REHEARSAL_GUARD_FAILED')
    } finally {
      productionSession.close()
    }
  })

  test('rejects a malformed permit before creating any AWS request', async () => {
    const originalStsSend = STSClient.prototype.send
    let stsCount = 0
    Reflect.set(STSClient.prototype, 'send', function (): unknown {
      stsCount += 1
      return Promise.reject(new Error('must-not-reach-sts'))
    })
    try {
      await withStaticProfile(async () => {
        await expect(
          createAwsWorkspaceSearchMigrationNonProductionRehearsalSession({
            requested,
            ratePolicy,
            bootstrapRateCheckpoint: true,
            recoverInterruptedCleanup: false,
            recoverInterruptedAttempt: false,
            permit: { ...createPermit(), stage: 'production' },
            permitVerificationKey: permitKey,
            permitClock: () => new Date(fixedTime),
          }),
        ).rejects.toMatchObject({
          code: 'NON_PRODUCTION_REHEARSAL_GUARD_FAILED',
        })
      })
      expect(stsCount).toBe(0)
    } finally {
      Reflect.set(STSClient.prototype, 'send', originalStsSend)
    }
  })

  test('rejects caller or journal-tag drift before rate state I/O', async () => {
    const driftCases:
      readonly (
        | 'caller'
        | 'deployment-trust-tag'
        | 'environment-tag'
        | 'production-account-tag'
      )[] = [
        'caller',
        'deployment-trust-tag',
        'environment-tag',
        'production-account-tag',
      ]
    for (const drift of driftCases) {
      const originalStsSend = STSClient.prototype.send
      const originalS3Send = S3Client.prototype.send
      const originalDynamoDbSend = DynamoDBClient.prototype.send
      let dynamoDbCount = 0
      Reflect.set(STSClient.prototype, 'send', function (): unknown {
        return Promise.resolve({
          $metadata: {},
          Account: account,
          Arn: drift === 'caller'
            ? `arn:aws:sts::${account}:assumed-role/Other/session`
            : callerArn,
          UserId: drift === 'caller'
            ? 'AROA12345678901234567:session'
            : 'AROA12345678901234567:reviewed-session',
        })
      })
      Reflect.set(S3Client.prototype, 'send', function (): unknown {
        return Promise.resolve({
          $metadata: {},
          TagSet: [
            {
              Key: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ENVIRONMENT_TAG_KEY,
              Value: drift === 'environment-tag'
                ? 'production'
                : WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
            },
            {
              Key:
                WORKSPACE_SEARCH_MIGRATION_REHEARSAL_DEPLOYMENT_TRUST_ROOT_TAG_KEY,
              Value: drift === 'deployment-trust-tag'
                ? 'e'.repeat(64)
                : deploymentTrustRootDigest,
            },
            {
              Key:
                WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRODUCTION_ACCOUNT_DIGEST_TAG_KEY,
              Value:
                createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
                  drift === 'production-account-tag'
                    ? '999999999999'
                    : '210987654321',
                ),
            },
          ],
        })
      })
      Reflect.set(DynamoDBClient.prototype, 'send', function (): unknown {
        dynamoDbCount += 1
        return Promise.reject(new Error('must-not-reach-dynamodb'))
      })
      try {
        await withStaticProfile(async () => {
          await expect(
            createAwsWorkspaceSearchMigrationNonProductionRehearsalSession({
              requested,
              ratePolicy,
              bootstrapRateCheckpoint: true,
              recoverInterruptedCleanup: false,
              recoverInterruptedAttempt: false,
              permit: createPermit(),
              permitVerificationKey: permitKey,
              permitClock: () => new Date(fixedTime),
            }),
          ).rejects.toMatchObject({
            code: 'NON_PRODUCTION_REHEARSAL_GUARD_FAILED',
          })
        })
        expect(dynamoDbCount).toBe(0)
      } finally {
        Reflect.set(STSClient.prototype, 'send', originalStsSend)
        Reflect.set(S3Client.prototype, 'send', originalS3Send)
        Reflect.set(
          DynamoDBClient.prototype,
          'send',
          originalDynamoDbSend,
        )
      }
    }
  })
})
