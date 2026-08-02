import { createHash, createHmac } from 'node:crypto'
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  calculateCrossDomainIntegrityResourceIdentityDigest,
  createCrossDomainIntegrityImmutableResourceIdentities,
  CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_KIND,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_MAX_BYTES,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_VERSION,
  serializeCrossDomainIntegrityResourceAttestation,
  type CrossDomainIntegrityResourceAttestation,
} from '../../data-integrity/cross-domain-integrity'
import {
  createMigrationDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationRehearsalProductionAccountDigest,
  createWorkspaceSearchMigrationRehearsalPermit,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
  type WorkspaceSearchMigrationRehearsalPermitClaims,
} from './migration-rehearsal-permit'
import {
  consumeWorkspaceSearchMigrationRehearsalIntegrityRootPermitAuthorization,
  serializeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot,
  verifyWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_ATTESTATION_ROOT_MAX_BYTES,
  type WorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection,
} from './migration-rehearsal-integrity-rate-evidence'
import {
  createWorkspaceSearchMigrationRehearsalRateRecorder,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
} from './migration-rehearsal-rate-evidence'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
} from './migration-describe-table-rate-budget'
import {
  parseWorkspaceSearchMigrationRehearsalPermitClaims,
  parseWorkspaceSearchMigrationRehearsalPermitCliArguments,
  readWorkspaceSearchMigrationRehearsalPermitSigningKey,
  runWorkspaceSearchMigrationRehearsalPermitCli,
  writeWorkspaceSearchMigrationRehearsalPermitFileExclusive,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_CLAIMS_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_CLI_RESULT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_ISSUANCE_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_INTEGRITY_KEY_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_SIGNING_KEY_BYTES,
  workspaceSearchMigrationRehearsalPermitNodePublicationDependencies,
  workspaceSearchMigrationRehearsalPermitNodeSigningKeyReaderDependencies,
  type WorkspaceSearchMigrationRehearsalPermitCliDependencies,
  type WorkspaceSearchMigrationRehearsalPermitFileWriteOutcome,
  type WorkspaceSearchMigrationRehearsalPermitIssuanceClaims,
} from './migration-rehearsal-permit-cli'
import {
  deriveWorkspaceSearchMigrationRehearsalKeys,
  zeroizeWorkspaceSearchMigrationRehearsalKey,
} from './migration-rehearsal-key-derivation'
import {
  readWorkspaceSearchMigrationRehearsalPrivateInputFile,
} from './migration-rehearsal-private-input'

const claimsPath = '/restricted/rehearsal-permit-claims.json'
const keyPath = '/restricted/rehearsal-permit-signing.key'
const integrityKeyPath = '/restricted/rehearsal-integrity.key'
const integrityResourceAttestationPath =
  '/restricted/rehearsal-integrity-resource-attestation.json'
const integrityAttestationRootPath =
  '/restricted/rehearsal-integrity-attestation-root.json'
const integrityRootRateSegmentPath =
  '/restricted/rehearsal-integrity-root-rate-segment.jsonl'
const outputPath = '/restricted/rehearsal-permit.json'
const encoder = new TextEncoder()

/** Source-controlled deployment target retained by every permit fixture. */
const deploymentTargetId = 'test-rehearsal'

/** Reviewed configuration digest retained by every permit fixture. */
const configurationBindingDigest = createMigrationDigest('configuration')

/** Reviewed rate-policy digest retained by every permit fixture. */
const policyVersion = createMigrationDigest('rate-policy')

/** Creates one structurally strict minimal root projection for parser tests. */
function createStructuralRootProjection(
  productionAccount = '210987654321',
): WorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection {
  const aggregate: WorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection[
    'aggregate'
  ] = {
    version: 1,
    policyVersion,
    attemptCount: 12,
    forfeitedAttemptCount: 0,
    throttleCount: 0,
    budgetStopCount: 0,
    cadenceWaitCount: 0,
    cadenceWaitMilliseconds: 0,
    maximumInFlight: 1,
  }
  return {
    kind:
      'mukuroji-workspace-search-migration-rehearsal-integrity-attestation-root-projection',
    version: 1,
    deploymentTargetId,
    productionAccountDigest:
      createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
        productionAccount,
      ),
    configurationBindingDigest,
    policyVersion,
    attestation: {
      contentMac: createMigrationDigest('attestation-content'),
      byteLength: 1_024,
    },
    segment: {
      authenticationKeyFingerprint: createMigrationDigest('key-fingerprint'),
      segmentLocatorDigest: createMigrationDigest('segment-locator'),
      segmentOrdinal: 0,
      firstEventSequence: 1,
      eventCount: 24,
      firstCommittedEventSequence: 1,
      lastCommittedEventSequence: 24,
      terminalRecordMac: createMigrationDigest('terminal-record'),
      segmentDigest: createMigrationDigest('segment'),
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
      eventSequences: Array.from({ length: 12 }, (_value, index) => index + 13),
      cadenceWaitCount: 0,
      cadenceWaitMilliseconds: 0,
      startedAt: '2026-08-01T23:59:59.700Z',
      completedAt: '2026-08-01T23:59:59.900Z',
    },
    aggregate,
    aggregateDigest: createMigrationDigest(aggregate),
    tableOrderBindingMac: createMigrationDigest('table-order'),
    rootMac: createMigrationDigest('root'),
    startedAt: '2026-08-01T23:59:59.000Z',
    completedAt: '2026-08-01T23:59:59.999Z',
  }
}

/** Exact persisted root material paired with its authenticated projection. */
type PermitRootMaterial = {
  /** Exact minimal projection consumed from a genuine permit-purpose token. */
  readonly projection:
    WorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection
  /** Exact canonical newline-terminated owner-only root bytes. */
  readonly rootBytes: Uint8Array
  /** Exact canonical authenticated ordinal-zero rate-segment bytes. */
  readonly segmentBytes: Uint8Array
}

/** Creates one genuine persisted root for end-to-end permit issuance tests. */
async function createPermitRootMaterial(
  masterKey: Uint8Array,
  integrityKey: Uint8Array,
  attestation: CrossDomainIntegrityResourceAttestation,
  rootLabel = 'primary',
): Promise<PermitRootMaterial> {
  const derivedKeys = deriveWorkspaceSearchMigrationRehearsalKeys(masterKey)
  const runtimeKey = derivedKeys.runtimeKey
  const publicationKey = derivedKeys.publicationKey
  try {
    const recorder =
      await createWorkspaceSearchMigrationRehearsalRateRecorder({
        segmentLocatorDigest: createMigrationDigest(
          `root-segment-locator:${rootLabel}`,
        ),
        segmentOrdinal: 0,
        previousSegmentDigest: null,
        previousRecordMac: null,
        firstEventSequence: 1,
        anchorUtc: '2026-08-01T23:59:59.000Z',
        monotonicAnchorMilliseconds: 1_000,
        policyVersion,
        configurationBindingDigest,
        authenticationKey: runtimeKey,
        /** Accepts exact in-memory durable appends for the fixture. */
        async appendDurably(): Promise<void> {},
      })
    for (let sequence = 1; sequence <= 12; sequence += 1) {
      recorder.record({
        version:
          WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
        kind: 'attempt',
        phase: sequence <= 6 ? 'measurement' : 'integrity-check',
        sequence,
        observedAtMilliseconds: 1_000 + sequence * 10,
        remainingNormalAdmissionAttempts: 100 - sequence,
        remainingWindowAttempts: 9,
        remainingPageAttempts: 5,
        inFlight: 1,
      })
    }
    const committed = await recorder.flush()
    const aggregate = {
      version:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
      policyVersion,
      attemptCount: 12,
      forfeitedAttemptCount: 0,
      throttleCount: 0,
      budgetStopCount: 0,
      cadenceWaitCount: 0,
      cadenceWaitMilliseconds: 0,
      maximumInFlight: 1,
    } satisfies WorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection[
      'aggregate'
    ]
    const attestationBytes = createIntegrityResourceAttestationBytes(
      attestation,
    )
    const resourceIdentities =
      createCrossDomainIntegrityImmutableResourceIdentities(
        attestation,
        integrityKey,
      )
    const resourceIdentityDigest =
      calculateCrossDomainIntegrityResourceIdentityDigest(
        resourceIdentities,
        integrityKey,
      )
    const tableOrderBindingDigest = createMigrationDigest(
      attestation.tables.map((table) => ({
        target: table.target,
        tableName: table.tableName,
      })),
    )
    const segment = Object.freeze({
      authenticationKeyFingerprint: committed.authenticationKeyFingerprint,
      segmentLocatorDigest: committed.segmentLocatorDigest,
      segmentOrdinal: committed.segmentOrdinal,
      firstEventSequence: committed.firstEventSequence,
      eventCount: committed.eventCount,
      firstCommittedEventSequence: committed.firstCommittedEventSequence,
      lastCommittedEventSequence: committed.lastCommittedEventSequence,
      terminalRecordMac: committed.terminalRecordMac,
      segmentDigest: committed.segmentDigest,
    })
    const interval = Object.freeze({
      kind:
        'mukuroji-workspace-search-migration-rehearsal-integrity-rate-interval',
      version: 1,
      phase: 'integrity-check',
      tablePassCount: 1,
      describeTableCallCount: 6,
      firstAttemptSequence: 7,
      lastAttemptSequence: 12,
      attemptSequences: Object.freeze([7, 8, 9, 10, 11, 12]),
      firstEventSequence: 13,
      lastEventSequence: 24,
      eventSequences: Object.freeze(
        Array.from({ length: 12 }, (_value, index) => index + 13),
      ),
      cadenceWaitCount: 0,
      cadenceWaitMilliseconds: 0,
      startedAt: '2026-08-01T23:59:59.070Z',
      completedAt: '2026-08-01T23:59:59.120Z',
    })
    const rootClaims = Object.freeze({
      kind:
        'mukuroji-workspace-search-migration-rehearsal-integrity-attestation-root',
      version: 1,
      deploymentTargetId,
      deploymentTrustRootDigest: 'd'.repeat(64),
      productionAccountDigest:
        createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
          '210987654321',
        ),
      account: attestation.account,
      region: attestation.region,
      callerArn:
        'arn:aws:sts::123456789012:assumed-role/RehearsalOperator/session-01',
      commit: 'a'.repeat(40),
      requestedResourcesBinding: 'b'.repeat(64),
      configurationBindingDigest,
      policyVersion,
      evidenceKeyDigest: derivedKeys.runtimeKeyDigest,
      publicationKeyDigest: derivedKeys.publicationKeyDigest,
      attestation: Object.freeze({
        contentMac: createHmac('sha256', runtimeKey)
          .update(
            'mukuroji:workspace-search-migration:root-attestation-content:v1\0',
            'utf8',
          )
          .update(attestationBytes)
          .digest('hex'),
        byteLength: attestationBytes.byteLength,
        resourceIdentityScheme:
          CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
        resourceIdentities,
        resourceIdentityDigest,
      }),
      predecessor: null,
      segment,
      interval,
      aggregate,
      aggregateDigest: createMigrationDigest(aggregate),
      startedAt: '2026-08-01T23:59:59.000Z',
      completedAt: '2026-08-01T23:59:59.500Z',
      tableOrderBindingMac: createHmac('sha256', runtimeKey)
        .update(
          'mukuroji:workspace-search-migration:integrity-table-order-binding:v1\0',
          'utf8',
        )
        .update(tableOrderBindingDigest, 'utf8')
        .digest('hex'),
    })
    const root = Object.freeze({
      ...rootClaims,
      rootMac: createHmac('sha256', runtimeKey)
        .update(
          'mukuroji:workspace-search-migration:integrity-attestation-root:v1\0',
          'utf8',
        )
        .update(serializeCanonicalJson(rootClaims), 'utf8')
        .digest('hex'),
    })
    const rootBytes = encoder.encode(
      serializeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot(
        root,
      ),
    )
    const authorizations =
      verifyWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot({
        rootBytes,
        canonicalSegmentBytes: committed.canonicalBytes,
        resourceAttestationBytes: attestationBytes,
        rateAuthenticationKey: runtimeKey,
      })
    const projection =
      consumeWorkspaceSearchMigrationRehearsalIntegrityRootPermitAuthorization({
        authorization: authorizations.permit,
        expected: {
          deploymentTargetId,
          deploymentTrustRootDigest: 'd'.repeat(64),
          productionAccountDigest:
            createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
              '210987654321',
            ),
          account: attestation.account,
          region: attestation.region,
          callerArn:
            'arn:aws:sts::123456789012:assumed-role/RehearsalOperator/session-01',
          commit: 'a'.repeat(40),
          requestedResourcesBinding: 'b'.repeat(64),
          configurationBindingDigest,
          policyVersion,
          evidenceKeyDigest: derivedKeys.runtimeKeyDigest,
          publicationKeyDigest: derivedKeys.publicationKeyDigest,
          resourceIdentityScheme:
            CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
          resourceIdentities,
          resourceIdentityDigest,
          issuedAt: '2026-08-02T00:00:00.000Z',
        },
      })
    attestationBytes.fill(0)
    return Object.freeze({
      projection,
      rootBytes,
      segmentBytes: committed.canonicalBytes.slice(),
    })
  } finally {
    zeroizeWorkspaceSearchMigrationRehearsalKey(publicationKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(runtimeKey)
  }
}

/** Creates one complete genuine root-backed CLI issuance fixture. */
async function createRootBackedIssuanceFixture() {
  const masterKey = createSigningKey()
  const integrityKey = createIntegrityKey()
  const attestation = createIntegrityResourceAttestation()
  const root = await createPermitRootMaterial(
    masterKey,
    integrityKey,
    attestation,
  )
  const claims = createPermitClaims(
    masterKey,
    integrityKey,
    attestation,
    root.projection,
  )
  const attestationBytes = createIntegrityResourceAttestationBytes(
    attestation,
  )
  return {
    masterKey,
    integrityKey,
    attestation,
    attestationBytes,
    root,
    claims,
  }
}

/**
 * Builds one exact reviewed permit claims fixture.
 *
 * @param evidenceKey - Exact key whose digest is reviewed in the claims.
 * @returns Canonical valid rehearsal permit claims.
 */
function createPermitClaims(
  masterKey = createSigningKey(),
  integrityKey = createIntegrityKey(),
  attestation = createIntegrityResourceAttestation(),
  integrityAttestationRoot = createStructuralRootProjection(),
): WorkspaceSearchMigrationRehearsalPermitIssuanceClaims {
  const derivedKeys = deriveWorkspaceSearchMigrationRehearsalKeys(masterKey)
  const resourceIdentities =
    createCrossDomainIntegrityImmutableResourceIdentities(
      attestation,
      integrityKey,
    )
  try {
    return {
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND,
      permitVersion: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION,
      stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
      approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
      account: '123456789012',
      productionAccount: '210987654321',
      region: 'ap-northeast-1',
      callerArn:
        'arn:aws:sts::123456789012:assumed-role/RehearsalOperator/session-01',
      commit: 'a'.repeat(40),
      deploymentTargetId,
      deploymentTrustRootDigest: 'd'.repeat(64),
      requestedResourcesBinding: 'b'.repeat(64),
      configurationBindingDigest,
      policyVersion,
      integrityResourceIdentityDigest:
        calculateCrossDomainIntegrityResourceIdentityDigest(
          resourceIdentities,
          integrityKey,
        ),
      evidenceKeyDigest: derivedKeys.runtimeKeyDigest,
      publicationKeyDigest: derivedKeys.publicationKeyDigest,
      integrityAttestationRoot,
      issuedAt: '2026-08-02T00:00:00.000Z',
      expiresAt: '2026-08-05T00:00:00.000Z',
    }
  } finally {
    zeroizeWorkspaceSearchMigrationRehearsalKey(derivedKeys.runtimeKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(derivedKeys.publicationKey)
  }
}

/** Creates one dedicated nonzero #163 integrity key distinct from all stage keys. */
function createIntegrityKey(): Uint8Array {
  return Uint8Array.from(
    {
      length:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_INTEGRITY_KEY_BYTES,
    },
    (_value, index) => index + 1,
  )
}

/** Builds one exact canonical seven-resource private attestation fixture. */
function createIntegrityResourceAttestation(
  account = '123456789012',
  region = 'ap-northeast-1',
  tableNameSuffix = '',
): CrossDomainIntegrityResourceAttestation {
  return {
    kind: CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_KIND,
    version: CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_VERSION,
    scheme: CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    account,
    region,
    bucket: {
      target: 'bucket:file',
      bucketName: 'mukuroji-file-rehearsal',
      marker: {
        key: CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
        versionId: 'marker-version-01',
        checksumSha256:
          'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        size: 128,
      },
    },
    tables: [
      createTableAttestation(
        'table:audit-events',
        `AuditEvents${tableNameSuffix}`,
        1,
        account,
        region,
      ),
      createTableAttestation(
        'table:file-proofing',
        `FileProofing${tableNameSuffix}`,
        2,
        account,
        region,
      ),
      createTableAttestation(
        'table:project-directory',
        `ProjectDirectory${tableNameSuffix}`,
        3,
        account,
        region,
      ),
      createTableAttestation(
        'table:work-item-configuration',
        `WorkItemConfiguration${tableNameSuffix}`,
        4,
        account,
        region,
      ),
      createTableAttestation(
        'table:work-items',
        `WorkItems${tableNameSuffix}`,
        5,
        account,
        region,
      ),
      createTableAttestation(
        'table:workspace-access',
        `WorkspaceAccess${tableNameSuffix}`,
        6,
        account,
        region,
      ),
    ],
  }
}

/** Builds one exact private DynamoDB resource-attestation entry. */
function createTableAttestation(
  target:
    | 'table:audit-events'
    | 'table:file-proofing'
    | 'table:project-directory'
    | 'table:work-item-configuration'
    | 'table:work-items'
    | 'table:workspace-access',
  tableName: string,
  ordinal: number,
  account: string,
  region: string,
) {
  return {
    target,
    tableName,
    tableArn:
      `arn:aws:dynamodb:${region}:${account}:table/${tableName}`,
    tableId: `table-id-${ordinal}`,
    creationTime: `2026-08-01T00:00:0${ordinal}.000Z`,
  }
}

/** Serializes one exact canonical private resource attestation. */
function createIntegrityResourceAttestationBytes(
  value: unknown = createIntegrityResourceAttestation(),
): Uint8Array {
  return encoder.encode(
    serializeCrossDomainIntegrityResourceAttestation(value),
  )
}

/** Serializes one claims value to exact canonical file bytes. */
function createClaimsBytes(value: unknown = createPermitClaims()): Uint8Array {
  return encoder.encode(serializeCanonicalJson(value))
}

/** Creates one nonzero exact-length raw signing key. */
function createSigningKey(): Uint8Array {
  return Uint8Array.from(
    { length: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_SIGNING_KEY_BYTES },
    (_value, index) => 255 - index,
  )
}

/** Builds one exact canonical authenticated permit byte vector. */
function createPermitBytes(
  signingKey = createSigningKey(),
): Uint8Array {
  const integrityKey = createIntegrityKey()
  const attestation = createIntegrityResourceAttestation()
  const issuanceClaims = createPermitClaims(
    signingKey,
    integrityKey,
    attestation,
  )
  const integrityResourceIdentities =
    createCrossDomainIntegrityImmutableResourceIdentities(
      attestation,
      integrityKey,
    )
  const claims: WorkspaceSearchMigrationRehearsalPermitClaims = {
    ...issuanceClaims,
    integrityResourceIdentityScheme:
      CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    integrityResourceIdentities,
  }
  return encoder.encode(serializeCanonicalJson(
    createWorkspaceSearchMigrationRehearsalPermit({
      claims,
      signingKey,
    }),
  ))
}

/** Builds one exact ordered issuance command. */
function createPermitCliArguments(
  finalOutputPath = outputPath,
  attestationPath = integrityResourceAttestationPath,
  rootPath = integrityAttestationRootPath,
  rootSegmentPath = integrityRootRateSegmentPath,
): string[] {
  return [
    '--claims-file',
    claimsPath,
    '--signing-key-file',
    keyPath,
    '--integrity-key-file',
    integrityKeyPath,
    '--integrity-resource-attestation-file',
    attestationPath,
    '--integrity-attestation-root-file',
    rootPath,
    '--integrity-root-rate-segment-file',
    rootSegmentPath,
    '--output-file',
    finalOutputPath,
    '--approval',
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_ISSUANCE_APPROVAL,
  ]
}

/**
 * Creates deterministic in-memory input and process-output dependencies.
 *
 * @param files - Exact private path-to-byte fixtures.
 * @param writer - Injected exclusive durable writer.
 * @returns Recording dependency boundary.
 */
function createTestDependencies(
  files: ReadonlyMap<string, Uint8Array>,
  writer: (
    outputPath: string,
    permitBytes: Uint8Array,
  ) => Promise<WorkspaceSearchMigrationRehearsalPermitFileWriteOutcome> =
    async () => 'created',
) {
  const reads: Array<readonly [string, number]> = []
  const keyReads: string[] = []
  const integrityKeyReads: string[] = []
  const integrityResourceAttestationReads:
    Array<readonly [string, number]> = []
  const integrityAttestationRootReads:
    Array<readonly [string, number]> = []
  const integrityRootRateSegmentReads:
    Array<readonly [string, number]> = []
  const writes: Array<readonly [string, Uint8Array]> = []
  const stdoutLines: string[] = []
  const stderrLines: string[] = []
  const dependencies:
    WorkspaceSearchMigrationRehearsalPermitCliDependencies = {
      readInputFile: async (path, maximumBytes) => {
        reads.push([path, maximumBytes])
        const bytes = files.get(path)
        if (bytes === undefined) throw new Error('raw private read failure')
        return bytes
      },
      readSigningKeyFile: async (path) => {
        keyReads.push(path)
        const bytes = files.get(path)
        if (bytes === undefined) throw new Error('raw private key failure')
        return bytes
      },
      readIntegrityKeyFile: async (path) => {
        integrityKeyReads.push(path)
        const bytes = files.get(path)
        if (bytes === undefined) {
          throw new Error('raw private integrity key failure')
        }
        return bytes
      },
      readIntegrityResourceAttestationFile: async (
        path,
        maximumBytes,
      ) => {
        integrityResourceAttestationReads.push([path, maximumBytes])
        const bytes = files.get(path)
        if (bytes === undefined) {
          throw new Error('raw private resource attestation failure')
        }
        return bytes
      },
      readIntegrityAttestationRootFile: async (path, maximumBytes) => {
        integrityAttestationRootReads.push([path, maximumBytes])
        const bytes = files.get(path)
        if (bytes === undefined) {
          throw new Error('raw private integrity root failure')
        }
        return bytes
      },
      readIntegrityRootRateSegmentFile: async (path, maximumBytes) => {
        integrityRootRateSegmentReads.push([path, maximumBytes])
        const bytes = files.get(path)
        if (bytes === undefined) {
          throw new Error('raw private root segment failure')
        }
        return bytes
      },
      writePermitFileExclusive: async (path, permitBytes) => {
        writes.push([path, Uint8Array.from(permitBytes)])
        return await writer(path, permitBytes)
      },
      writeStdoutLine: (line) => {
        stdoutLines.push(line)
      },
      writeStderrLine: (line) => {
        stderrLines.push(line)
      },
    }
  return {
    dependencies,
    integrityKeyReads,
    integrityAttestationRootReads,
    integrityRootRateSegmentReads,
    integrityResourceAttestationReads,
    keyReads,
    reads,
    stderrLines,
    stdoutLines,
    writes,
  }
}

describe('Workspace Search migration rehearsal permit CLI parser', () => {
  test('accepts only the exact ordered flags and issuance approval', () => {
    expect(
      parseWorkspaceSearchMigrationRehearsalPermitCliArguments(
        createPermitCliArguments(),
      ),
    ).toEqual({
      claimsFile: claimsPath,
      signingKeyFile: keyPath,
      integrityKeyFile: integrityKeyPath,
      integrityResourceAttestationFile:
        integrityResourceAttestationPath,
      integrityAttestationRootFile: integrityAttestationRootPath,
      integrityRootRateSegmentFile: integrityRootRateSegmentPath,
      outputFile: outputPath,
      approval:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_ISSUANCE_APPROVAL,
    })

    for (const invalid of [
      [],
      createPermitCliArguments().slice(0, -1),
      [
        '--signing-key-file',
        keyPath,
        '--claims-file',
        claimsPath,
        '--integrity-key-file',
        integrityKeyPath,
        '--integrity-resource-attestation-file',
        integrityResourceAttestationPath,
        '--integrity-attestation-root-file',
        integrityAttestationRootPath,
        '--integrity-root-rate-segment-file',
        integrityRootRateSegmentPath,
        '--output-file',
        outputPath,
        '--approval',
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_ISSUANCE_APPROVAL,
      ],
      createPermitCliArguments().map((value) =>
        value === WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_ISSUANCE_APPROVAL
          ? 'wrong-approval'
          : value
      ),
      createPermitCliArguments().map((value) =>
        value === claimsPath ? '   ' : value
      ),
    ]) {
      expect(() =>
        parseWorkspaceSearchMigrationRehearsalPermitCliArguments(invalid)
      ).toThrow('INVALID_USAGE')
    }
  })

  test('snapshots accessor-backed arguments exactly once', () => {
    let reads = 0
    const arguments_ = new Proxy(createPermitCliArguments(), {
      get: (target, property, receiver) => {
        if (property === '0') reads += 1
        return Reflect.get(target, property, receiver)
      },
    })

    const parsed =
      parseWorkspaceSearchMigrationRehearsalPermitCliArguments(arguments_)

    expect(parsed.outputFile).toBe(outputPath)
    expect(reads).toBe(1)
  })
})

describe('Workspace Search migration rehearsal permit claims', () => {
  test('detaches strict claims and rejects extras or accessors without reading them', () => {
    const claims = createPermitClaims()
    const parsed =
      parseWorkspaceSearchMigrationRehearsalPermitClaims(claims)
    expect(parsed).toEqual(claims)
    expect(parsed).not.toBe(claims)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalPermitClaims({
        ...claims,
        accountAlias: claims.account,
      })
    ).toThrow('INVALID_CLAIMS_FILE')

    let accessorReads = 0
    const accessorClaims = { ...claims }
    Object.defineProperty(accessorClaims, 'account', {
      enumerable: true,
      get: () => {
        accessorReads += 1
        return claims.account
      },
    })
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalPermitClaims(accessorClaims)
    ).toThrow('INVALID_CLAIMS_FILE')
    expect(accessorReads).toBe(0)
  })
})

describe('Workspace Search migration rehearsal permit signing-key reader', () => {
  test('reads only an exact stable owner mode-0600 regular file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mukuroji-key-reader-'))
    const signingKeyPath = join(directory, 'signing.key')
    const expected = createSigningKey()
    try {
      await writeFile(signingKeyPath, expected, { mode: 0o600 })
      await chmod(signingKeyPath, 0o600)

      const observed =
        await readWorkspaceSearchMigrationRehearsalPermitSigningKey(
          signingKeyPath,
        )

      expect(observed).toEqual(expected)
      expect(observed).not.toBe(expected)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('rejects a final symlink, excess permission bits, and a wrong owner without exposing paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mukuroji-key-guard-'))
    const signingKeyPath = join(directory, 'signing.key')
    const symlinkPath = join(directory, 'signing-link.key')
    try {
      await writeFile(signingKeyPath, createSigningKey(), { mode: 0o600 })
      await chmod(signingKeyPath, 0o640)
      await expect(
        readWorkspaceSearchMigrationRehearsalPermitSigningKey(
          signingKeyPath,
        ),
      ).rejects.toThrow('INVALID_SIGNING_KEY')

      await chmod(signingKeyPath, 0o600)
      await writeFile(signingKeyPath, createSigningKey().slice(0, 31))
      await expect(
        readWorkspaceSearchMigrationRehearsalPermitSigningKey(
          signingKeyPath,
        ),
      ).rejects.toThrow('INVALID_SIGNING_KEY')

      await writeFile(signingKeyPath, createSigningKey())
      await chmod(signingKeyPath, 0o600)
      await symlink(signingKeyPath, symlinkPath)
      let symlinkFailure = ''
      try {
        await readWorkspaceSearchMigrationRehearsalPermitSigningKey(
          symlinkPath,
        )
      } catch (error: unknown) {
        symlinkFailure = error instanceof Error ? error.message : ''
      }
      expect(symlinkFailure).toBe('INVALID_SIGNING_KEY')
      expect(symlinkFailure).not.toContain(symlinkPath)

      const currentUserId =
        workspaceSearchMigrationRehearsalPermitNodeSigningKeyReaderDependencies.currentUserId()
      await expect(
        readWorkspaceSearchMigrationRehearsalPermitSigningKey(
          signingKeyPath,
          {
            ...workspaceSearchMigrationRehearsalPermitNodeSigningKeyReaderDependencies,
            currentUserId: () => currentUserId + 1,
          },
        ),
      ).rejects.toThrow('INVALID_SIGNING_KEY')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('rejects a pre/post inode change and zeroizes its bounded working buffer', async () => {
    const signingKey = createSigningKey()
    let statCalls = 0
    let workingBuffer: Uint8Array | undefined
    let readCalls = 0

    await expect(
      readWorkspaceSearchMigrationRehearsalPermitSigningKey(
        keyPath,
        {
          currentUserId: () => 501,
          openFileNoFollow: async () => ({
            stat: async () => {
              statCalls += 1
              return {
                device: 1,
                inode: statCalls === 1 ? 10 : 11,
                ownerUserId: 501,
                mode: 0o100600,
                size: 32,
                changedAtMilliseconds: 1,
                modifiedAtMilliseconds: 1,
                regularFile: true,
              }
            },
            read: async (buffer, offset, length) => {
              workingBuffer = buffer
              readCalls += 1
              if (readCalls > 1) return 0
              const bytesToRead = Math.min(length, signingKey.byteLength)
              buffer.set(signingKey.slice(0, bytesToRead), offset)
              return bytesToRead
            },
            close: async () => {},
          }),
        },
      ),
    ).rejects.toThrow('INVALID_SIGNING_KEY')

    expect(workingBuffer).toBeDefined()
    if (workingBuffer !== undefined) {
      expect([...workingBuffer]).toEqual(
        Array.from({ length: 33 }, () => 0),
      )
    }
  })
})

describe('Workspace Search migration rehearsal permit CLI runner', () => {
  test('emits one stable usage failure without reading or writing files', async () => {
    const harness = createTestDependencies(new Map())

    const exitCode = await runWorkspaceSearchMigrationRehearsalPermitCli(
      [],
      harness.dependencies,
    )

    expect(exitCode).toBe(2)
    expect(harness.reads).toEqual([])
    expect(harness.writes).toEqual([])
    expect(harness.stdoutLines).toEqual([])
    expect(harness.stderrLines).toEqual([
      serializeCanonicalJson({
        code: 'INVALID_USAGE',
        kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_CLI_RESULT_KIND,
        status: 'error',
      }),
    ])
  })

  test('writes one canonical mode-0600 permit, reports only its digest, and zeroizes the key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mukuroji-permit-cli-'))
    const finalOutputPath = join(directory, 'permit.json')
    const callerKey = createSigningKey()
    const expectedKey = Uint8Array.from(callerKey)
    const integrityKey = createIntegrityKey()
    const attestation = createIntegrityResourceAttestation()
    const rootMaterial = await createPermitRootMaterial(
      callerKey,
      integrityKey,
      attestation,
    )
    const claims = createPermitClaims(
      callerKey,
      integrityKey,
      attestation,
      rootMaterial.projection,
    )
    const integrityResourceIdentities =
      createCrossDomainIntegrityImmutableResourceIdentities(
        attestation,
        integrityKey,
      )
    const expectedDerivedKeys =
      deriveWorkspaceSearchMigrationRehearsalKeys(expectedKey)
    const expectedPermit = createWorkspaceSearchMigrationRehearsalPermit({
      claims: {
        ...claims,
        integrityResourceIdentityScheme:
          CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
        integrityResourceIdentities,
      },
      signingKey: expectedDerivedKeys.runtimeKey,
    })
    zeroizeWorkspaceSearchMigrationRehearsalKey(
      expectedDerivedKeys.runtimeKey,
    )
    zeroizeWorkspaceSearchMigrationRehearsalKey(
      expectedDerivedKeys.publicationKey,
    )
    const expectedPermitBytes = encoder.encode(
      serializeCanonicalJson(expectedPermit),
    )
    const attestationBytes = createIntegrityResourceAttestationBytes(
      attestation,
    )
    const harness = createTestDependencies(
      new Map([
        [claimsPath, createClaimsBytes(claims)],
        [keyPath, callerKey],
        [integrityKeyPath, integrityKey],
        [integrityResourceAttestationPath, attestationBytes],
        [integrityAttestationRootPath, rootMaterial.rootBytes],
        [integrityRootRateSegmentPath, rootMaterial.segmentBytes],
      ]),
      writeWorkspaceSearchMigrationRehearsalPermitFileExclusive,
    )
    try {
      const exitCode = await runWorkspaceSearchMigrationRehearsalPermitCli(
        createPermitCliArguments(finalOutputPath),
        harness.dependencies,
      )

      expect(exitCode).toBe(0)
      expect(harness.stderrLines).toEqual([])
      expect(harness.reads).toEqual([
        [
          claimsPath,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_CLAIMS_MAX_BYTES,
        ],
      ])
      expect(harness.keyReads).toEqual([keyPath])
      expect(harness.integrityKeyReads).toEqual([integrityKeyPath])
      expect(harness.integrityResourceAttestationReads).toEqual([
        [
          integrityResourceAttestationPath,
          CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_MAX_BYTES,
        ],
      ])
      expect(harness.integrityAttestationRootReads).toEqual([
        [
          integrityAttestationRootPath,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_ATTESTATION_ROOT_MAX_BYTES,
        ],
      ])
      expect(harness.integrityRootRateSegmentReads).toEqual([
        [
          integrityRootRateSegmentPath,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
        ],
      ])
      expect(harness.writes).toHaveLength(1)
      expect(harness.writes[0]?.[0]).toBe(finalOutputPath)
      expect(harness.writes[0]?.[1]).toEqual(expectedPermitBytes)
      expect(await readFile(finalOutputPath)).toEqual(
        Buffer.from(expectedPermitBytes),
      )
      expect((await stat(finalOutputPath)).mode & 0o777).toBe(0o600)
      const permitDigest = createHash('sha256')
        .update(expectedPermitBytes)
        .digest('hex')
      expect(harness.stdoutLines).toEqual([
        serializeCanonicalJson({
          kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_CLI_RESULT_KIND,
          permitDigest,
          status: 'succeeded',
        }),
      ])
      expect(harness.stdoutLines[0]).not.toContain(claims.account)
      expect(harness.stdoutLines[0]).not.toContain(claims.callerArn)
      expect(harness.stdoutLines[0]).not.toContain(finalOutputPath)
      expect([...callerKey]).toEqual(Array.from({ length: 32 }, () => 0))
      expect([...integrityKey]).toEqual(Array.from({ length: 32 }, () => 0))
      expect([...attestationBytes]).toEqual(
        Array.from({ length: attestationBytes.byteLength }, () => 0),
      )
      expect([...rootMaterial.rootBytes]).toEqual(
        Array.from({ length: rootMaterial.rootBytes.byteLength }, () => 0),
      )
      expect([...rootMaterial.segmentBytes]).toEqual(
        Array.from({ length: rootMaterial.segmentBytes.byteLength }, () => 0),
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('accepts an exact reconciled durable permit publication', async () => {
    const fixture = await createRootBackedIssuanceFixture()
    const harness = createTestDependencies(
      new Map([
        [claimsPath, createClaimsBytes(fixture.claims)],
        [keyPath, fixture.masterKey],
        [integrityKeyPath, fixture.integrityKey],
        [integrityResourceAttestationPath, fixture.attestationBytes],
        [integrityAttestationRootPath, fixture.root.rootBytes],
        [integrityRootRateSegmentPath, fixture.root.segmentBytes],
      ]),
      async () => 'reconciled',
    )

    const exitCode = await runWorkspaceSearchMigrationRehearsalPermitCli(
      createPermitCliArguments(),
      harness.dependencies,
    )

    expect(exitCode).toBe(0)
    expect(harness.writes).toHaveLength(1)
    expect(harness.stderrLines).toEqual([])
    expect(harness.stdoutLines).toHaveLength(1)
  })

  test('rejects injected root projections and trusted target, configuration, policy, or time drift', async () => {
    for (const drift of [
      'projection',
      'target',
      'configuration',
      'policy',
      'time',
    ]) {
      const fixture = await createRootBackedIssuanceFixture()
      let claims = fixture.claims
      let expectedCode = 'INVALID_INTEGRITY_ATTESTATION_ROOT'
      if (drift === 'projection') {
        claims = {
          ...claims,
          integrityAttestationRoot: {
            ...claims.integrityAttestationRoot,
            rootMac: createMigrationDigest('injected-root'),
          },
        }
      } else if (drift === 'target') {
        claims = {
          ...claims,
          deploymentTargetId: 'other-rehearsal',
          integrityAttestationRoot: {
            ...claims.integrityAttestationRoot,
            deploymentTargetId: 'other-rehearsal',
          },
        }
      } else if (drift === 'configuration') {
        const replacement = createMigrationDigest('other-configuration')
        claims = {
          ...claims,
          configurationBindingDigest: replacement,
          integrityAttestationRoot: {
            ...claims.integrityAttestationRoot,
            configurationBindingDigest: replacement,
          },
        }
      } else if (drift === 'policy') {
        const replacement = createMigrationDigest('other-policy')
        claims = {
          ...claims,
          policyVersion: replacement,
          integrityAttestationRoot: {
            ...claims.integrityAttestationRoot,
            policyVersion: replacement,
            aggregate: {
              ...claims.integrityAttestationRoot.aggregate,
              policyVersion: replacement,
            },
            aggregateDigest: createMigrationDigest({
              ...claims.integrityAttestationRoot.aggregate,
              policyVersion: replacement,
            }),
          },
        }
      } else {
        claims = {
          ...claims,
          issuedAt: '2026-08-01T23:59:59.400Z',
        }
        expectedCode = 'INVALID_CLAIMS_FILE'
      }
      const harness = createTestDependencies(new Map([
        [claimsPath, createClaimsBytes(claims)],
        [keyPath, fixture.masterKey],
        [integrityKeyPath, fixture.integrityKey],
        [integrityResourceAttestationPath, fixture.attestationBytes],
        [integrityAttestationRootPath, fixture.root.rootBytes],
        [integrityRootRateSegmentPath, fixture.root.segmentBytes],
      ]))

      const exitCode = await runWorkspaceSearchMigrationRehearsalPermitCli(
        createPermitCliArguments(),
        harness.dependencies,
      )

      expect(exitCode).toBe(2)
      expect(harness.writes).toEqual([])
      expect(harness.stderrLines).toEqual([
        serializeCanonicalJson({
          code: expectedCode,
          kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_CLI_RESULT_KIND,
          status: 'error',
        }),
      ])
    }
  })

  test('rejects a different valid root, mismatched bytes, attestation, or runtime key', async () => {
    for (const mismatch of [
      'different-root',
      'segment',
      'noncanonical-root',
      'tampered-segment',
      'attestation',
      'runtime-key',
    ]) {
      const fixture = await createRootBackedIssuanceFixture()
      let claims = fixture.claims
      let rootBytes = fixture.root.rootBytes
      let segmentBytes = fixture.root.segmentBytes
      let attestationBytes = fixture.attestationBytes
      let unrelatedKey: Uint8Array | undefined
      if (mismatch === 'different-root' || mismatch === 'segment') {
        const otherRoot = await createPermitRootMaterial(
          fixture.masterKey,
          fixture.integrityKey,
          fixture.attestation,
          'other-valid-root',
        )
        if (mismatch === 'different-root') rootBytes = otherRoot.rootBytes
        segmentBytes = otherRoot.segmentBytes
      } else if (mismatch === 'noncanonical-root') {
        rootBytes = encoder.encode(
          ` ${new TextDecoder().decode(fixture.root.rootBytes)}`,
        )
      } else if (mismatch === 'tampered-segment') {
        segmentBytes = fixture.root.segmentBytes.slice()
        segmentBytes[0] = (segmentBytes[0] ?? 0) ^ 1
      } else if (mismatch === 'attestation') {
        const otherAttestation = createIntegrityResourceAttestation(
          '123456789012',
          'ap-northeast-1',
          'Other',
        )
        claims = createPermitClaims(
          fixture.masterKey,
          fixture.integrityKey,
          otherAttestation,
          fixture.root.projection,
        )
        attestationBytes = createIntegrityResourceAttestationBytes(
          otherAttestation,
        )
      } else {
        unrelatedKey = createSigningKey()
        unrelatedKey[0] = (unrelatedKey[0] ?? 0) ^ 1
        const otherRoot = await createPermitRootMaterial(
          unrelatedKey,
          fixture.integrityKey,
          fixture.attestation,
          'other-runtime-key',
        )
        rootBytes = otherRoot.rootBytes
        segmentBytes = otherRoot.segmentBytes
      }
      const harness = createTestDependencies(new Map([
        [claimsPath, createClaimsBytes(claims)],
        [keyPath, fixture.masterKey],
        [integrityKeyPath, fixture.integrityKey],
        [integrityResourceAttestationPath, attestationBytes],
        [integrityAttestationRootPath, rootBytes],
        [integrityRootRateSegmentPath, segmentBytes],
      ]))

      const exitCode = await runWorkspaceSearchMigrationRehearsalPermitCli(
        createPermitCliArguments(),
        harness.dependencies,
      )
      unrelatedKey?.fill(0)

      expect(exitCode).toBe(2)
      expect(harness.writes).toEqual([])
      expect(harness.stderrLines).toEqual([
        serializeCanonicalJson({
          code: 'INVALID_INTEGRITY_ATTESTATION_ROOT',
          kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_CLI_RESULT_KIND,
          status: 'error',
        }),
      ])
    }
  })

  test('rejects noncanonical and extra-key claims before reading a key or writing', async () => {
    const claims = createPermitClaims()
    for (const claimsBytes of [
      encoder.encode(JSON.stringify(claims, undefined, 2)),
      createClaimsBytes({ ...claims, rawExtra: 'tenant-secret-extra' }),
    ]) {
      const key = createSigningKey()
      const harness = createTestDependencies(new Map([
        [claimsPath, claimsBytes],
        [keyPath, key],
      ]))

      const exitCode = await runWorkspaceSearchMigrationRehearsalPermitCli(
        createPermitCliArguments(),
        harness.dependencies,
      )

      expect(exitCode).toBe(2)
      expect(harness.reads).toEqual([
        [
          claimsPath,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_CLAIMS_MAX_BYTES,
        ],
      ])
      expect(harness.writes).toEqual([])
      expect(harness.stdoutLines).toEqual([])
      expect(harness.stderrLines).toEqual([
        serializeCanonicalJson({
          code: 'INVALID_CLAIMS_FILE',
          kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_CLI_RESULT_KIND,
          status: 'error',
        }),
      ])
      expect(harness.stderrLines[0]).not.toContain('tenant-secret-extra')
    }
  })

  test('rejects and zeroizes a wrong-length raw key', async () => {
    const key = Uint8Array.of(9, 8, 7)
    const harness = createTestDependencies(new Map([
      [claimsPath, createClaimsBytes()],
      [keyPath, key],
    ]))

    const exitCode = await runWorkspaceSearchMigrationRehearsalPermitCli(
      createPermitCliArguments(),
      harness.dependencies,
    )

    expect(exitCode).toBe(2)
    expect(harness.writes).toEqual([])
    expect(harness.stderrLines).toEqual([
      serializeCanonicalJson({
        code: 'INVALID_SIGNING_KEY',
        kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_CLI_RESULT_KIND,
        status: 'error',
      }),
    ])
    expect([...key]).toEqual([0, 0, 0])
  })

  test('rejects and zeroizes a key that does not match the reviewed evidence-key digest', async () => {
    const reviewedKey = createSigningKey()
    const suppliedKey = createSigningKey()
    suppliedKey[0] = suppliedKey[0] === 0 ? 1 : 0
    const harness = createTestDependencies(new Map([
      [claimsPath, createClaimsBytes(createPermitClaims(reviewedKey))],
      [keyPath, suppliedKey],
    ]))

    const exitCode = await runWorkspaceSearchMigrationRehearsalPermitCli(
      createPermitCliArguments(),
      harness.dependencies,
    )

    expect(exitCode).toBe(2)
    expect(harness.writes).toEqual([])
    expect(harness.stdoutLines).toEqual([])
    expect(harness.stderrLines).toEqual([
      serializeCanonicalJson({
        code: 'INVALID_SIGNING_KEY',
        kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_CLI_RESULT_KIND,
        status: 'error',
      }),
    ])
    expect([...suppliedKey]).toEqual(Array.from({ length: 32 }, () => 0))
  })

  test('rejects a dedicated integrity key equal to the master or either derived stage key', async () => {
    for (const keyRole of ['master', 'runtime', 'publication']) {
      const masterKey = createSigningKey()
      const derivedKeys = deriveWorkspaceSearchMigrationRehearsalKeys(
        masterKey,
      )
      const integrityKey = Uint8Array.from(
        keyRole === 'master'
          ? masterKey
          : keyRole === 'runtime'
            ? derivedKeys.runtimeKey
            : derivedKeys.publicationKey,
      )
      const claims = createPermitClaims(masterKey)
      const harness = createTestDependencies(new Map([
        [claimsPath, createClaimsBytes(claims)],
        [keyPath, masterKey],
        [integrityKeyPath, integrityKey],
      ]))

      const exitCode = await runWorkspaceSearchMigrationRehearsalPermitCli(
        createPermitCliArguments(),
        harness.dependencies,
      )

      expect(exitCode).toBe(2)
      expect(harness.writes).toEqual([])
      expect(harness.stderrLines).toEqual([
        serializeCanonicalJson({
          code: 'INVALID_INTEGRITY_KEY',
          kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_CLI_RESULT_KIND,
          status: 'error',
        }),
      ])
      expect([...masterKey]).toEqual(Array.from({ length: 32 }, () => 0))
      expect([...integrityKey]).toEqual(
        Array.from({ length: 32 }, () => 0),
      )
      zeroizeWorkspaceSearchMigrationRehearsalKey(derivedKeys.runtimeKey)
      zeroizeWorkspaceSearchMigrationRehearsalKey(
        derivedKeys.publicationKey,
      )
    }
  })

  test('rejects malformed, noncanonical, and wrong-account or wrong-Region resource attestations without a permit', async () => {
    const cases = [
      {
        attestation: createIntegrityResourceAttestation(),
        bytes: encoder.encode('{'),
      },
      {
        attestation: createIntegrityResourceAttestation(),
        bytes: encoder.encode(JSON.stringify(
          createIntegrityResourceAttestation(),
        )),
      },
      {
        attestation: createIntegrityResourceAttestation(
          '999999999999',
          'ap-northeast-1',
        ),
        bytes: createIntegrityResourceAttestationBytes(
          createIntegrityResourceAttestation(
            '999999999999',
            'ap-northeast-1',
          ),
        ),
      },
      {
        attestation: createIntegrityResourceAttestation(
          '123456789012',
          'us-west-2',
        ),
        bytes: createIntegrityResourceAttestationBytes(
          createIntegrityResourceAttestation(
            '123456789012',
            'us-west-2',
          ),
        ),
      },
    ]
    for (const candidate of cases) {
      const masterKey = createSigningKey()
      const integrityKey = createIntegrityKey()
      const claims = createPermitClaims(
        masterKey,
        integrityKey,
        candidate.attestation,
      )
      const attestationBytes = candidate.bytes
      const harness = createTestDependencies(new Map([
        [claimsPath, createClaimsBytes(claims)],
        [keyPath, masterKey],
        [integrityKeyPath, integrityKey],
        [integrityResourceAttestationPath, attestationBytes],
      ]))

      const exitCode = await runWorkspaceSearchMigrationRehearsalPermitCli(
        createPermitCliArguments(),
        harness.dependencies,
      )

      expect(exitCode).toBe(2)
      expect(harness.writes).toEqual([])
      expect(harness.stdoutLines).toEqual([])
      expect(harness.stderrLines).toEqual([
        serializeCanonicalJson({
          code: 'INVALID_INTEGRITY_RESOURCE_ATTESTATION',
          kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_CLI_RESULT_KIND,
          status: 'error',
        }),
      ])
    }
  })

  test('rejects symlink and non-owner-only resource-attestation paths without a permit', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'mukuroji-permit-attestation-guard-'),
    )
    const targetPath = join(directory, 'attestation.json')
    const symlinkPath = join(directory, 'attestation-link.json')
    const wrongModePath = join(directory, 'attestation-shared.json')
    try {
      const attestationBytes = createIntegrityResourceAttestationBytes()
      await writeFile(targetPath, attestationBytes, { mode: 0o600 })
      await chmod(targetPath, 0o600)
      await symlink(targetPath, symlinkPath)
      await writeFile(wrongModePath, attestationBytes, { mode: 0o600 })
      await chmod(wrongModePath, 0o640)

      for (const unsafePath of [symlinkPath, wrongModePath]) {
        const masterKey = createSigningKey()
        const integrityKey = createIntegrityKey()
        const harness = createTestDependencies(new Map([
          [claimsPath, createClaimsBytes()],
          [keyPath, masterKey],
          [integrityKeyPath, integrityKey],
        ]))

        const exitCode =
          await runWorkspaceSearchMigrationRehearsalPermitCli(
            createPermitCliArguments(outputPath, unsafePath),
            {
              ...harness.dependencies,
              readIntegrityResourceAttestationFile:
                readWorkspaceSearchMigrationRehearsalPrivateInputFile,
            },
          )

        expect(exitCode).toBe(2)
        expect(harness.writes).toEqual([])
        expect(harness.stderrLines).toEqual([
          serializeCanonicalJson({
            code: 'INVALID_INTEGRITY_RESOURCE_ATTESTATION',
            kind:
              WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_CLI_RESULT_KIND,
            status: 'error',
          }),
        ])
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('rejects symlink or non-owner-only root and root-segment paths', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'mukuroji-permit-root-input-guard-'),
    )
    try {
      for (const role of ['root', 'segment']) {
        for (const unsafeKind of ['symlink', 'mode']) {
          const fixture = await createRootBackedIssuanceFixture()
          const targetPath = join(
            directory,
            `${role}-${unsafeKind}-target`,
          )
          const unsafePath = join(
            directory,
            `${role}-${unsafeKind}-unsafe`,
          )
          const bytes = role === 'root'
            ? fixture.root.rootBytes
            : fixture.root.segmentBytes
          await writeFile(targetPath, bytes, { mode: 0o600 })
          await chmod(targetPath, 0o600)
          if (unsafeKind === 'symlink') {
            await symlink(targetPath, unsafePath)
          } else {
            await writeFile(unsafePath, bytes, { mode: 0o600 })
            await chmod(unsafePath, 0o640)
          }
          const harness = createTestDependencies(new Map([
            [claimsPath, createClaimsBytes(fixture.claims)],
            [keyPath, fixture.masterKey],
            [integrityKeyPath, fixture.integrityKey],
            [
              integrityResourceAttestationPath,
              fixture.attestationBytes,
            ],
            [integrityAttestationRootPath, fixture.root.rootBytes],
            [
              integrityRootRateSegmentPath,
              fixture.root.segmentBytes,
            ],
          ]))
          const exitCode =
            await runWorkspaceSearchMigrationRehearsalPermitCli(
              createPermitCliArguments(
                outputPath,
                integrityResourceAttestationPath,
                role === 'root' ? unsafePath : integrityAttestationRootPath,
                role === 'segment'
                  ? unsafePath
                  : integrityRootRateSegmentPath,
              ),
              {
                ...harness.dependencies,
                ...(role === 'root'
                  ? {
                    readIntegrityAttestationRootFile:
                      readWorkspaceSearchMigrationRehearsalPrivateInputFile,
                  }
                  : {
                    readIntegrityRootRateSegmentFile:
                      readWorkspaceSearchMigrationRehearsalPrivateInputFile,
                  }),
              },
            )

          expect(exitCode).toBe(2)
          expect(harness.writes).toEqual([])
          expect(harness.stderrLines).toEqual([
            serializeCanonicalJson({
              code: role === 'root'
                ? 'INVALID_INTEGRITY_ATTESTATION_ROOT'
                : 'INVALID_INTEGRITY_ROOT_RATE_SEGMENT',
              kind:
                WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_CLI_RESULT_KIND,
              status: 'error',
            }),
          ])
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('never overwrites an existing final permit path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mukuroji-permit-exists-'))
    const finalOutputPath = join(directory, 'permit.json')
    const existingBytes = Buffer.from('existing-private-permit')
    await writeFile(finalOutputPath, existingBytes, { mode: 0o600 })
    const key = createSigningKey()
    const integrityKey = createIntegrityKey()
    const attestation = createIntegrityResourceAttestation()
    const rootMaterial = await createPermitRootMaterial(
      key,
      integrityKey,
      attestation,
    )
    const claims = createPermitClaims(
      key,
      integrityKey,
      attestation,
      rootMaterial.projection,
    )
    const harness = createTestDependencies(
      new Map([
        [claimsPath, createClaimsBytes(claims)],
        [keyPath, key],
        [integrityKeyPath, integrityKey],
        [
          integrityResourceAttestationPath,
          createIntegrityResourceAttestationBytes(attestation),
        ],
        [integrityAttestationRootPath, rootMaterial.rootBytes],
        [integrityRootRateSegmentPath, rootMaterial.segmentBytes],
      ]),
      writeWorkspaceSearchMigrationRehearsalPermitFileExclusive,
    )
    try {
      const exitCode = await runWorkspaceSearchMigrationRehearsalPermitCli(
        createPermitCliArguments(finalOutputPath),
        harness.dependencies,
      )

      expect(exitCode).toBe(1)
      expect(await readFile(finalOutputPath)).toEqual(existingBytes)
      expect(harness.stdoutLines).toEqual([])
      expect(harness.stderrLines).toEqual([
        serializeCanonicalJson({
          code: 'OUTPUT_FILE_EXISTS',
          kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_CLI_RESULT_KIND,
          status: 'error',
        }),
      ])
      expect([...key]).toEqual(Array.from({ length: 32 }, () => 0))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('redacts write failures and sensitive claims without retrying publication', async () => {
    const rawCanary = 'raw-output-path-account-arn-failure'
    const key = createSigningKey()
    const integrityKey = createIntegrityKey()
    const attestation = createIntegrityResourceAttestation()
    const rootMaterial = await createPermitRootMaterial(
      key,
      integrityKey,
      attestation,
    )
    const claims = createPermitClaims(
      key,
      integrityKey,
      attestation,
      rootMaterial.projection,
    )
    let writerCalls = 0
    const harness = createTestDependencies(
      new Map([
        [claimsPath, createClaimsBytes(claims)],
        [keyPath, key],
        [integrityKeyPath, integrityKey],
        [
          integrityResourceAttestationPath,
          createIntegrityResourceAttestationBytes(attestation),
        ],
        [integrityAttestationRootPath, rootMaterial.rootBytes],
        [integrityRootRateSegmentPath, rootMaterial.segmentBytes],
      ]),
      async () => {
        writerCalls += 1
        throw new Error(rawCanary)
      },
    )

    const exitCode = await runWorkspaceSearchMigrationRehearsalPermitCli(
      createPermitCliArguments(),
      harness.dependencies,
    )

    expect(exitCode).toBe(1)
    expect(writerCalls).toBe(1)
    expect(harness.stdoutLines).toEqual([])
    expect(harness.stderrLines).toEqual([
      serializeCanonicalJson({
        code: 'OUTPUT_FILE_WRITE_FAILED',
        kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_CLI_RESULT_KIND,
        status: 'error',
      }),
    ])
    expect(harness.stderrLines[0]).not.toContain(rawCanary)
    expect(harness.stderrLines[0]).not.toContain(
      createPermitClaims().account,
    )
    expect(harness.stderrLines[0]).not.toContain(
      createPermitClaims().callerArn,
    )
    expect(harness.stderrLines[0]).not.toContain(outputPath)
    expect([...key]).toEqual(Array.from({ length: 32 }, () => 0))
  })
})

describe('Workspace Search migration rehearsal permit atomic publication', () => {
  test('reconciles an exact canonical final permit without replacing it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mukuroji-permit-reconcile-'))
    const finalPath = join(directory, 'permit.json')
    const permitBytes = createPermitBytes()
    try {
      await writeFile(finalPath, permitBytes, { mode: 0o600 })
      await chmod(finalPath, 0o600)

      const outcome =
        await writeWorkspaceSearchMigrationRehearsalPermitFileExclusive(
          finalPath,
          permitBytes,
        )

      expect(outcome).toBe('reconciled')
      expect(await readFile(finalPath)).toEqual(Buffer.from(permitBytes))
      expect(await readdir(directory)).toEqual(['permit.json'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('reconciles a lost successful hard-link response and removes the temporary link', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mukuroji-permit-link-loss-'))
    const finalPath = join(directory, 'permit.json')
    const permitBytes = createPermitBytes()
    try {
      const outcome =
        await writeWorkspaceSearchMigrationRehearsalPermitFileExclusive(
          finalPath,
          permitBytes,
          {
            ...workspaceSearchMigrationRehearsalPermitNodePublicationDependencies,
            linkFile: async (temporaryPath, publishedPath) => {
              await workspaceSearchMigrationRehearsalPermitNodePublicationDependencies.linkFile(
                temporaryPath,
                publishedPath,
              )
              throw new Error('simulated lost link response')
            },
          },
        )

      expect(outcome).toBe('reconciled')
      expect(await readFile(finalPath)).toEqual(Buffer.from(permitBytes))
      expect(await readdir(directory)).toEqual(['permit.json'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('removes and durably records a partial temporary write failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mukuroji-permit-partial-'))
    const finalPath = join(directory, 'permit.json')
    const permitBytes = createPermitBytes()
    try {
      await expect(
        writeWorkspaceSearchMigrationRehearsalPermitFileExclusive(
          finalPath,
          permitBytes,
          {
            ...workspaceSearchMigrationRehearsalPermitNodePublicationDependencies,
            createTemporaryFile: async (temporaryPath) => {
              const file =
                await workspaceSearchMigrationRehearsalPermitNodePublicationDependencies.createTemporaryFile(
                  temporaryPath,
                )
              return {
                ...file,
                write: async (bytes) => {
                  await file.write(bytes.slice(0, 7))
                  throw new Error('simulated partial temporary write')
                },
              }
            },
          },
        ),
      ).rejects.toThrow('OUTPUT_FILE_WRITE_FAILED')
      expect(await readdir(directory)).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('never overwrites mismatched, wrong-mode, or symlink final entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mukuroji-permit-unsafe-final-'))
    const finalPath = join(directory, 'permit.json')
    const targetPath = join(directory, 'target.json')
    const permitBytes = createPermitBytes()
    const mismatch = Buffer.from('existing-private-permit')
    try {
      await writeFile(finalPath, mismatch, { mode: 0o600 })
      expect(
        await writeWorkspaceSearchMigrationRehearsalPermitFileExclusive(
          finalPath,
          permitBytes,
        ),
      ).toBe('exists')
      expect(await readFile(finalPath)).toEqual(mismatch)

      await rm(finalPath)
      await writeFile(finalPath, permitBytes, { mode: 0o600 })
      await chmod(finalPath, 0o640)
      expect(
        await writeWorkspaceSearchMigrationRehearsalPermitFileExclusive(
          finalPath,
          permitBytes,
        ),
      ).toBe('exists')
      expect((await stat(finalPath)).mode & 0o777).toBe(0o640)

      await rm(finalPath)
      await writeFile(finalPath, permitBytes, { mode: 0o600 })
      await chmod(finalPath, 0o600)
      expect(
        await writeWorkspaceSearchMigrationRehearsalPermitFileExclusive(
          finalPath,
          permitBytes,
          {
            ...workspaceSearchMigrationRehearsalPermitNodePublicationDependencies,
            openFileNoFollow: async (path) => {
              const file =
                await workspaceSearchMigrationRehearsalPermitNodePublicationDependencies.openFileNoFollow(
                  path,
                )
              if (path !== finalPath) return file
              return {
                ...file,
                stat: async () => {
                  const status = await file.stat()
                  return {
                    ...status,
                    ownerUserId: status.ownerUserId + 1,
                  }
                },
              }
            },
          },
        ),
      ).toBe('exists')
      expect(await readFile(finalPath)).toEqual(Buffer.from(permitBytes))

      await rm(finalPath)
      await writeFile(targetPath, permitBytes, { mode: 0o600 })
      await chmod(targetPath, 0o600)
      await symlink(targetPath, finalPath)
      expect(
        await writeWorkspaceSearchMigrationRehearsalPermitFileExclusive(
          finalPath,
          permitBytes,
        ),
      ).toBe('exists')
      expect(await readFile(targetPath)).toEqual(Buffer.from(permitBytes))
      expect((await readdir(directory)).sort()).toEqual([
        'permit.json',
        'target.json',
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
