import { describe, expect, test } from 'bun:test'
import {
  DynamoDBClient,
  type AttributeValue,
  type ScanCommandOutput,
} from '@aws-sdk/client-dynamodb'
import { S3Client } from '@aws-sdk/client-s3'
import { STSClient } from '@aws-sdk/client-sts'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { PROJECT_QUICK_ACCESS_MAX_ITEMS } from '@mukuroji/contracts'
import type { CrossDomainIntegrityManagedAwsReadPort } from './cross-domain-integrity-aws-types'
import * as dataIntegrityPublic from './index'
import {
  createCrossDomainIntegrityNormalizedPageReader,
  CrossDomainIntegrityNormalizedPageReaderFailure,
  type CrossDomainIntegrityNormalizedPageReader,
  type CrossDomainIntegrityNormalizedPageReaderConfiguration,
  type CrossDomainIntegrityNormalizedPageRequest,
  type CrossDomainIntegrityTableTarget,
} from './cross-domain-integrity-page-reader'

const ACCOUNT_ID = '123456789012'
const CHECKED_AT = '2026-08-01T00:00:00.000Z'
const AUDIT_KEY = new Uint8Array(32).fill(19)
const DIGEST_KEY = new Uint8Array(32).fill(23)

/**
 * Narrows an unknown test observation to a property record.
 *
 * @param value - Unknown reflected value.
 * @returns Whether the value is a non-array object record.
 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads the three module-private AWS clients for focused configuration assertions.
 *
 * @param reader - Concrete normalized reader under test.
 * @returns DynamoDB, S3, and STS clients owned by its raw adapter.
 */
function readConcreteAwsClients(
  reader: CrossDomainIntegrityNormalizedPageReader,
): readonly (DynamoDBClient | S3Client | STSClient)[] {
  const rawReader: unknown = Reflect.get(reader, 'reader')
  if (!isRecord(rawReader)) throw new Error('expected raw AWS reader')
  const dynamodb: unknown = Reflect.get(rawReader, 'dynamodb')
  const s3: unknown = Reflect.get(rawReader, 's3')
  const sts: unknown = Reflect.get(rawReader, 'sts')
  if (
    !(dynamodb instanceof DynamoDBClient) ||
    !(s3 instanceof S3Client) ||
    !(sts instanceof STSClient)
  ) {
    throw new Error('expected concrete AWS clients')
  }
  return [dynamodb, s3, sts]
}

/**
 * Resolves one Node handler's private immutable configuration for testing.
 *
 * @param handler - Node HTTP handler owned by an AWS client.
 * @returns Resolved handler configuration.
 */
async function readNodeHttpHandlerConfiguration(
  handler: NodeHttpHandler,
): Promise<Readonly<Record<string, unknown>>> {
  const provider: unknown = Reflect.get(handler, 'configProvider')
  if (!(provider instanceof Promise)) {
    throw new Error('expected Node HTTP handler configuration provider')
  }
  const configuration: unknown = await provider
  if (!isRecord(configuration)) {
    throw new Error('expected Node HTTP handler configuration')
  }
  return configuration
}

/** Optional deterministic behavior for the module-private raw reader fixture. */
type FixtureRawReaderOptions = {
  /** Account returned by the caller-identity check. */
  readonly callerAccount?: string
  /** Optional caller-identity failure. */
  readonly callerError?: unknown
  /** Ordered raw Scan pages. */
  readonly pages?: readonly ScanCommandOutput[]
  /** Optional raw Scan failure. */
  readonly scanError?: unknown
}

/** Captured low-level Scan request retained only inside this module test. */
type CapturedScanRequest = {
  /** Decoded continuation key supplied to the raw adapter. */
  readonly exclusiveStartKey?: Readonly<Record<string, AttributeValue>>
  /** Logical table selected by the normalized reader. */
  readonly target: CrossDomainIntegrityTableTarget
}

/** Module-private raw reader fixture used to verify the public normalization boundary. */
class FixtureRawReader implements CrossDomainIntegrityManagedAwsReadPort {
  /** Number of caller-account checks issued before page reads. */
  callerAccountReadCount = 0

  /** Captured raw Scan requests in invocation order. */
  readonly scanRequests: CapturedScanRequest[] = []

  /** Configured deterministic behavior. */
  private readonly options: FixtureRawReaderOptions

  /** Next configured Scan page index. */
  private pageIndex = 0

  /**
   * Creates one deterministic raw reader fixture.
   *
   * @param options - Optional caller and Scan behavior.
   */
  constructor(options: FixtureRawReaderOptions = {}) {
    this.options = options
  }

  /** Releases no resources for the in-memory fixture. */
  close(): void {}

  /** Rejects unexpected exact-version attributes reads. */
  async getObjectAttributes(): Promise<never> {
    throw new Error('unexpected exact-version read')
  }

  /** Rejects unexpected exact-version tagging reads. */
  async getObjectTagging(): Promise<never> {
    throw new Error('unexpected exact-version read')
  }

  /** Rejects unexpected exact-version HEAD reads. */
  async headObject(): Promise<never> {
    throw new Error('unexpected exact-version read')
  }

  /** Returns or rejects the configured caller-account observation. */
  async readCallerAccount(): Promise<string> {
    this.callerAccountReadCount += 1
    if (this.options.callerError !== undefined) throw this.options.callerError
    return this.options.callerAccount ?? ACCOUNT_ID
  }

  /** Returns or rejects the next configured low-level Scan page. */
  async scanPage(
    target: CrossDomainIntegrityTableTarget,
    exclusiveStartKey?: Record<string, AttributeValue>,
  ): Promise<ScanCommandOutput> {
    this.scanRequests.push(exclusiveStartKey === undefined
      ? { target }
      : { exclusiveStartKey, target })
    if (this.options.scanError !== undefined) throw this.options.scanError
    const page = this.options.pages?.[this.pageIndex]
    this.pageIndex += 1
    return page ?? { $metadata: {}, Count: 0, Items: [], ScannedCount: 0 }
  }
}

/** Creates a complete valid isolated normalized-reader configuration. */
function readerConfiguration(): CrossDomainIntegrityNormalizedPageReaderConfiguration {
  return {
    accountId: ACCOUNT_ID,
    bucketName: 'restore-drill-scratch',
    pageSize: 25,
    region: 'ap-northeast-1',
    tableNames: {
      'audit-events': 'restore-audit-events',
      'file-proofing': 'restore-file-proofing',
      'project-directory': 'restore-project-directory',
      'work-item-configuration': 'restore-work-item-configuration',
      'work-items': 'restore-work-items',
      'workspace-access': 'restore-workspace-access',
    },
  }
}

/**
 * Creates the common high-level page request.
 *
 * @param cursor - Optional opaque DynamoDB continuation cursor.
 * @param target - Logical table whose raw rows are normalized.
 * @returns A complete deterministic normalized-page request.
 */
function pageRequest(
  cursor?: string,
  target: CrossDomainIntegrityTableTarget = 'work-items',
): CrossDomainIntegrityNormalizedPageRequest {
  return {
    auditPseudonymKey: AUDIT_KEY,
    checkedAt: CHECKED_AT,
    ...(cursor === undefined ? {} : { cursor }),
    digestKey: DIGEST_KEY,
    remainingItemCapacity: 1_000,
    signal: AbortSignal.timeout(60_000),
    target,
  }
}

/**
 * Creates one low-level Team-owned Project reference.
 *
 * @param teamId - Team identifier stored in the preference.
 * @param projectId - Project identifier stored in the preference.
 * @returns A DynamoDB map attribute for the ordered item list.
 */
function quickAccessProjectReference(
  teamId: string,
  projectId: string,
): AttributeValue {
  return {
    M: {
      projectId: { S: projectId },
      teamId: { S: teamId },
    },
  }
}

/**
 * Creates a valid low-level Project quick-access sidecar row.
 *
 * @param overrides - Exact attributes that should replace valid defaults.
 * @returns One raw DynamoDB item suitable for the normalization boundary.
 */
function quickAccessRawItem(
  overrides: Readonly<Record<string, AttributeValue>> = {},
): Record<string, AttributeValue> {
  return {
    directoryId: {
      S: 'PROJECT_QUICK_ACCESS#workspace%231#demo%40example.com',
    },
    entryKey: { S: 'PREFERENCE' },
    entryType: { S: 'project-quick-access' },
    items: {
      L: [quickAccessProjectReference('core-team', 'refero')],
    },
    memberKey: { S: 'demo@example.com' },
    revision: { N: '1' },
    updatedAt: { S: CHECKED_AT },
    workspaceId: { S: 'workspace#1' },
    ...overrides,
  }
}

/**
 * Creates a valid low-level member display preference sidecar row.
 *
 * @param overrides - Exact attributes that should replace valid defaults.
 * @returns One raw DynamoDB item suitable for the normalization boundary.
 */
function memberPreferencesRawItem(
  overrides: Readonly<Record<string, AttributeValue>> = {},
): Record<string, AttributeValue> {
  return {
    directoryId: {
      S: 'MEMBER_PREFERENCES#workspace%231#demo%40example.com',
    },
    entryKey: { S: 'PREFERENCE' },
    entryType: { S: 'member-preferences' },
    locale: { S: 'en' },
    memberKey: { S: 'demo@example.com' },
    revision: { N: '2' },
    timeZone: { S: 'Asia/Tokyo' },
    updatedAt: { S: CHECKED_AT },
    workspaceId: { S: 'workspace#1' },
    ...overrides,
  }
}

/**
 * Creates a valid low-level Project code reservation row.
 *
 * @param overrides - Exact attributes that should replace valid defaults.
 * @returns One raw DynamoDB item suitable for the normalization boundary.
 */
function projectCodeRawItem(
  overrides: Readonly<Record<string, AttributeValue>> = {},
): Record<string, AttributeValue> {
  return {
    directoryId: { S: 'PROJECT_CODE#workspace%231' },
    entryKey: { S: 'CODE#OPS-1' },
    entryType: { S: 'project-code' },
    workspaceId: { S: 'workspace#1' },
    teamId: { S: 'core-team' },
    projectId: { S: 'refero' },
    code: { S: 'OPS-1' },
    createdAt: { S: CHECKED_AT },
    ...overrides,
  }
}

/**
 * Creates a valid low-level Project ID reservation row.
 *
 * @param overrides - Exact attributes that should replace valid defaults.
 * @returns One raw DynamoDB item suitable for the normalization boundary.
 */
function projectIdRawItem(
  overrides: Readonly<Record<string, AttributeValue>> = {},
): Record<string, AttributeValue> {
  return {
    directoryId: { S: 'PROJECT_ID#workspace%231' },
    entryKey: { S: 'PROJECT#refero' },
    entryType: { S: 'project-id' },
    workspaceId: { S: 'workspace#1' },
    projectId: { S: 'refero' },
    createdAt: { S: CHECKED_AT },
    ...overrides,
  }
}

/**
 * Creates a valid low-level OrgUnit structure row.
 *
 * @param overrides - Exact attributes that should replace valid defaults.
 * @returns One raw DynamoDB item suitable for the normalization boundary.
 */
function orgStructureRawItem(
  overrides: Readonly<Record<string, AttributeValue>> = {},
): Record<string, AttributeValue> {
  return {
    directoryId: { S: 'ORG_STRUCTURE#workspace%231' },
    entryKey: { S: 'STRUCTURE' },
    entryType: { S: 'org-structure' },
    workspaceId: { S: 'workspace#1' },
    orgUnits: { L: [{ M: { id: { S: 'sales' }, name: { S: 'Sales' } } }] },
    teamAssignments: { L: [{ M: { teamId: { S: 'team-1' }, orgUnitId: { S: 'sales' } } }] },
    revision: { N: '1' },
    updatedAt: { S: CHECKED_AT },
    ...overrides,
  }
}

/**
 * Creates a valid low-level Team-wide grant receipt row.
 *
 * @param overrides - Exact attributes that should replace valid defaults.
 * @returns One raw DynamoDB item suitable for the normalization boundary.
 */
function teamGrantRequestRawItem(
  overrides: Readonly<Record<string, AttributeValue>> = {},
): Record<string, AttributeValue> {
  return {
    directoryId: { S: 'TEAM_GRANT_REQUEST#workspace%231' },
    entryKey: { S: 'KEY#key-hash' },
    entryType: { S: 'team-grant-request' },
    workspaceId: { S: 'workspace#1' },
    requestFingerprint: { S: 'request-fingerprint' },
    createdAt: { S: CHECKED_AT },
    ...overrides,
  }
}

/**
 * Wraps one raw row in a complete single-page DynamoDB response.
 *
 * @param item - Raw DynamoDB item returned by Scan.
 * @returns A terminal single-row Scan page.
 */
function rawItemPage(item: Record<string, AttributeValue>): ScanCommandOutput {
  return {
    $metadata: {},
    Count: 1,
    Items: [item],
    ScannedCount: 1,
  }
}

/** Replaces the concrete raw port only inside this module-local contract test. */
function installFixtureRawReader(
  reader: CrossDomainIntegrityNormalizedPageReader,
  fixture: FixtureRawReader,
): void {
  reader.close()
  Object.defineProperty(reader, 'reader', { value: fixture })
}

describe('cross-domain normalized page reader boundary', () => {
  test('exports no raw normalization function from the public barrel', () => {
    expect('readCrossDomainIntegrityAwsNormalizedPage' in dataIntegrityPublic).toBe(false)
  })

  test('bounds every concrete AWS client request and retry budget', async () => {
    const reader = createCrossDomainIntegrityNormalizedPageReader(
      readerConfiguration(),
    )
    try {
      const handlers: NodeHttpHandler[] = []
      for (const client of readConcreteAwsClients(reader)) {
        expect(await client.config.maxAttempts()).toBe(3)
        expect(await client.config.region()).toBe('ap-northeast-1')
        const handler = client.config.requestHandler
        if (!(handler instanceof NodeHttpHandler)) {
          throw new Error('expected bounded Node HTTP handler')
        }
        handlers.push(handler)
        const configuration = await readNodeHttpHandlerConfiguration(handler)
        expect({
          connectionTimeout: configuration.connectionTimeout,
          requestTimeout: configuration.requestTimeout,
          throwOnRequestTimeout: configuration.throwOnRequestTimeout,
        }).toEqual({
          connectionTimeout: 5_000,
          requestTimeout: 30_000,
          throwOnRequestTimeout: true,
        })
      }
      expect(new Set(handlers).size).toBe(3)
    } finally {
      reader.close()
    }
  })

  test('checks the caller account and round-trips only an opaque canonical cursor', async () => {
    const rawKey = { id: { S: 'workspace-private-row' } }
    const fixture = new FixtureRawReader({
      pages: [
        {
          $metadata: {},
          Count: 0,
          Items: [],
          LastEvaluatedKey: rawKey,
          ScannedCount: 0,
        },
        { $metadata: {}, Count: 0, Items: [], ScannedCount: 0 },
      ],
    })
    const reader = createCrossDomainIntegrityNormalizedPageReader(
      readerConfiguration(),
    )
    installFixtureRawReader(reader, fixture)
    try {
      const first = await reader.readPage(pageRequest())
      expect(first.nextCursor).toStartWith('dynamodb-key-v1.')
      expect(first.nextCursor).not.toContain('workspace-private-row')
      if (!first.nextCursor) throw new Error('expected continuation cursor')
      const second = await reader.readPage(pageRequest(first.nextCursor))
      expect(second.nextCursor).toBeUndefined()
      expect(fixture.callerAccountReadCount).toBe(2)
      expect(fixture.scanRequests).toEqual([
        { target: 'work-items' },
        { exclusiveStartKey: rawKey, target: 'work-items' },
      ])
    } finally {
      reader.close()
    }
  })

  test('accepts a canonical Project quick-access sidecar row as auxiliary data', async () => {
    const fixture = new FixtureRawReader({
      pages: [rawItemPage(quickAccessRawItem({
        items: {
          L: [
            quickAccessProjectReference('core-team', 'shared-project'),
            quickAccessProjectReference('design-team', 'shared-project'),
          ],
        },
      }))],
    })
    const reader = createCrossDomainIntegrityNormalizedPageReader(
      readerConfiguration(),
    )
    installFixtureRawReader(reader, fixture)
    try {
      await expect(reader.readPage(pageRequest(undefined, 'project-directory')))
        .resolves.toMatchObject({
          auditCandidates: [],
          externalFileFailureCodes: [],
          items: [],
          retainedUnitCount: 0,
        })
      expect(fixture.scanRequests).toEqual([{ target: 'project-directory' }])
    } finally {
      reader.close()
    }
  })

  test('fails closed on malformed Project quick-access sidecar rows', async () => {
    const malformedRows = [
      quickAccessRawItem({ directoryId: { S: 'workspace#1' } }),
      quickAccessRawItem({ revision: { N: '0' } }),
      quickAccessRawItem({ revision: { N: String(Number.MAX_SAFE_INTEGER) } }),
      quickAccessRawItem({
        items: {
          L: [quickAccessProjectReference('core/team', 'refero')],
        },
      }),
      quickAccessRawItem({
        items: {
          L: [quickAccessProjectReference(' core-team', 'refero')],
        },
      }),
      quickAccessRawItem({
        items: {
          L: [quickAccessProjectReference('core-team', 'refero ')],
        },
      }),
      quickAccessRawItem({
        items: {
          L: [
            quickAccessProjectReference('core-team', 'refero'),
            quickAccessProjectReference('core-team', 'refero'),
          ],
        },
      }),
      quickAccessRawItem({
        items: {
          L: Array.from({ length: PROJECT_QUICK_ACCESS_MAX_ITEMS + 1 }, (_, index) =>
            quickAccessProjectReference('core-team', `project-${index}`)
          ),
        },
      }),
    ]

    for (const row of malformedRows) {
      const fixture = new FixtureRawReader({ pages: [rawItemPage(row)] })
      const reader = createCrossDomainIntegrityNormalizedPageReader(
        readerConfiguration(),
      )
      installFixtureRawReader(reader, fixture)
      try {
        await expect(reader.readPage(pageRequest(undefined, 'project-directory')))
          .rejects.toEqual(
            new CrossDomainIntegrityNormalizedPageReaderFailure(
              'AWS_RESPONSE_INVALID',
            ),
          )
      } finally {
        reader.close()
      }
    }
  })

  test('accepts a canonical member preference sidecar row as auxiliary data', async () => {
    const fixture = new FixtureRawReader({ pages: [rawItemPage(memberPreferencesRawItem())] })
    const reader = createCrossDomainIntegrityNormalizedPageReader(readerConfiguration())
    installFixtureRawReader(reader, fixture)
    try {
      await expect(reader.readPage(pageRequest(undefined, 'project-directory')))
        .resolves.toMatchObject({ items: [], retainedUnitCount: 0 })
    } finally {
      reader.close()
    }
  })

  test('fails closed on malformed member preference sidecar rows', async () => {
    const malformedRows = [
      memberPreferencesRawItem({ directoryId: { S: 'workspace#1' } }),
      memberPreferencesRawItem({ entryKey: { S: 'OTHER' } }),
      memberPreferencesRawItem({ revision: { N: '0' } }),
      memberPreferencesRawItem({ locale: { S: 'fr' } }),
      memberPreferencesRawItem({ timeZone: { S: 'Not/AZone' } }),
    ]

    for (const row of malformedRows) {
      const fixture = new FixtureRawReader({ pages: [rawItemPage(row)] })
      const reader = createCrossDomainIntegrityNormalizedPageReader(readerConfiguration())
      installFixtureRawReader(reader, fixture)
      try {
        await expect(reader.readPage(pageRequest(undefined, 'project-directory')))
          .rejects.toEqual(
            new CrossDomainIntegrityNormalizedPageReaderFailure('AWS_RESPONSE_INVALID'),
          )
      } finally {
        reader.close()
      }
    }
  })

  test('accepts Work Item key registry rows in the Work Items table as auxiliary data', async () => {
    const fixture = new FixtureRawReader({
      pages: [{
        $metadata: {},
        Count: 2,
        Items: [
          {
            directoryTeamId: { S: 'workspace-1#work-item-key-registry' },
            issueId: { S: 'prefix#CT' },
            entryType: { S: 'work-item-key-prefix' },
            directoryId: { S: 'workspace-1' },
            keyPrefix: { S: 'CT' },
            teamId: { S: 'core-team' },
            registeredAt: { S: CHECKED_AT },
          },
          {
            directoryTeamId: { S: 'workspace-1#work-item-key-registry' },
            issueId: { S: 'key#CT-1' },
            entryType: { S: 'work-item-key' },
            directoryId: { S: 'workspace-1' },
            key: { S: 'CT-1' },
            teamId: { S: 'core-team' },
            workItemId: { S: 'ct-1' },
            registeredAt: { S: CHECKED_AT },
          },
        ],
        ScannedCount: 2,
      }],
    })
    const reader = createCrossDomainIntegrityNormalizedPageReader(readerConfiguration())
    installFixtureRawReader(reader, fixture)
    try {
      await expect(reader.readPage(pageRequest())).resolves.toMatchObject({ items: [] })
    } finally {
      reader.close()
    }
  })

  test('fails closed on a malformed Work Item key registry row', async () => {
    const fixture = new FixtureRawReader({
      pages: [rawItemPage({
        directoryTeamId: { S: 'workspace-1#work-item-key-registry' },
        issueId: { S: 'team#core-team' },
        entryType: { S: 'work-item-key-counter' },
        directoryId: { S: 'workspace-1' },
        teamId: { S: 'core-team' },
        keyPrefix: { S: 'CT' },
        lastNumber: { N: '-1' },
        registeredAt: { S: CHECKED_AT },
      })],
    })
    const reader = createCrossDomainIntegrityNormalizedPageReader(readerConfiguration())
    installFixtureRawReader(reader, fixture)
    try {
      await expect(reader.readPage(pageRequest())).rejects.toEqual(
        new CrossDomainIntegrityNormalizedPageReaderFailure('AWS_RESPONSE_INVALID'),
      )
    } finally {
      reader.close()
    }
  })

  test('accepts a canonical Project code reservation row as auxiliary data', async () => {
    const fixture = new FixtureRawReader({ pages: [rawItemPage(projectCodeRawItem())] })
    const reader = createCrossDomainIntegrityNormalizedPageReader(
      readerConfiguration(),
    )
    installFixtureRawReader(reader, fixture)
    try {
      await expect(reader.readPage(pageRequest(undefined, 'project-directory')))
        .resolves.toMatchObject({ items: [], retainedUnitCount: 0 })
    } finally {
      reader.close()
    }
  })

  test('fails closed on malformed Project code reservation rows', async () => {
    const malformedRows = [
      projectCodeRawItem({ directoryId: { S: 'workspace#1' } }),
      projectCodeRawItem({ entryKey: { S: 'CODE#OPS-2' } }),
      projectCodeRawItem({ projectId: { S: '' } }),
      projectCodeRawItem({ createdAt: { S: 'yesterday' } }),
      // A reservation the writer never produces: not upper-case, or not a valid code at all.
      projectCodeRawItem({ code: { S: 'ops-1' }, entryKey: { S: 'CODE#ops-1' } }),
      projectCodeRawItem({ code: { S: 'OPS 1' }, entryKey: { S: 'CODE#OPS 1' } }),
    ]

    for (const row of malformedRows) {
      const fixture = new FixtureRawReader({ pages: [rawItemPage(row)] })
      const reader = createCrossDomainIntegrityNormalizedPageReader(
        readerConfiguration(),
      )
      installFixtureRawReader(reader, fixture)
      try {
        await expect(reader.readPage(pageRequest(undefined, 'project-directory')))
          .rejects.toEqual(
            new CrossDomainIntegrityNormalizedPageReaderFailure(
              'AWS_RESPONSE_INVALID',
            ),
          )
      } finally {
        reader.close()
      }
    }
  })

  test('accepts a canonical Team-wide grant receipt and fails closed on a malformed one', async () => {
    const accepted = new FixtureRawReader({ pages: [rawItemPage(teamGrantRequestRawItem())] })
    const reader = createCrossDomainIntegrityNormalizedPageReader(readerConfiguration())
    installFixtureRawReader(reader, accepted)
    try {
      await expect(reader.readPage(pageRequest(undefined, 'project-directory')))
        .resolves.toMatchObject({ items: [], retainedUnitCount: 0 })
    } finally {
      reader.close()
    }

    const malformedRows = [
      teamGrantRequestRawItem({ directoryId: { S: 'TEAM_GRANT_REQUEST#workspace#1' } }),
      teamGrantRequestRawItem({ entryKey: { S: 'key-hash' } }),
      teamGrantRequestRawItem({ requestFingerprint: { S: '' } }),
      teamGrantRequestRawItem({ createdAt: { S: 'yesterday' } }),
    ]
    for (const row of malformedRows) {
      const fixture = new FixtureRawReader({ pages: [rawItemPage(row)] })
      const malformed = createCrossDomainIntegrityNormalizedPageReader(readerConfiguration())
      installFixtureRawReader(malformed, fixture)
      try {
        await expect(malformed.readPage(pageRequest(undefined, 'project-directory')))
          .rejects.toEqual(new CrossDomainIntegrityNormalizedPageReaderFailure('AWS_RESPONSE_INVALID'))
      } finally {
        malformed.close()
      }
    }
  })

  test('accepts a canonical OrgUnit structure row and fails closed on a malformed one', async () => {
    const accepted = new FixtureRawReader({ pages: [rawItemPage(orgStructureRawItem())] })
    const reader = createCrossDomainIntegrityNormalizedPageReader(readerConfiguration())
    installFixtureRawReader(reader, accepted)
    try {
      await expect(reader.readPage(pageRequest(undefined, 'project-directory')))
        .resolves.toMatchObject({ items: [], retainedUnitCount: 0 })
    } finally {
      reader.close()
    }

    const malformedRows = [
      orgStructureRawItem({ directoryId: { S: 'ORG_STRUCTURE#workspace#1' } }),
      orgStructureRawItem({ entryKey: { S: 'OTHER' } }),
      orgStructureRawItem({ revision: { N: '0' } }),
      orgStructureRawItem({ updatedAt: { S: 'yesterday' } }),
      orgStructureRawItem({
        orgUnits: { L: [{ M: { id: { S: 'sales' }, name: { S: 'Sales' }, parentId: { S: 'sales' } } }] },
      }),
    ]
    for (const row of malformedRows) {
      const fixture = new FixtureRawReader({ pages: [rawItemPage(row)] })
      const malformed = createCrossDomainIntegrityNormalizedPageReader(readerConfiguration())
      installFixtureRawReader(malformed, fixture)
      try {
        await expect(malformed.readPage(pageRequest(undefined, 'project-directory')))
          .rejects.toEqual(new CrossDomainIntegrityNormalizedPageReaderFailure('AWS_RESPONSE_INVALID'))
      } finally {
        malformed.close()
      }
    }
  })

  test('accepts a canonical Project ID reservation row as auxiliary data', async () => {
    const fixture = new FixtureRawReader({ pages: [rawItemPage(projectIdRawItem())] })
    const reader = createCrossDomainIntegrityNormalizedPageReader(
      readerConfiguration(),
    )
    installFixtureRawReader(reader, fixture)
    try {
      await expect(reader.readPage(pageRequest(undefined, 'project-directory')))
        .resolves.toMatchObject({ items: [], retainedUnitCount: 0 })
    } finally {
      reader.close()
    }
  })

  test('fails closed on malformed Project ID reservation rows', async () => {
    const malformedRows = [
      projectIdRawItem({ directoryId: { S: 'workspace#1' } }),
      projectIdRawItem({ directoryId: { S: 'PROJECT_ID#workspace#1' } }),
      projectIdRawItem({ entryKey: { S: 'PROJECT#other' } }),
      projectIdRawItem({ projectId: { S: '' } }),
      projectIdRawItem({ projectId: { S: 'a/b' }, entryKey: { S: 'PROJECT#a/b' } }),
      projectIdRawItem({ createdAt: { S: 'yesterday' } }),
    ]

    for (const row of malformedRows) {
      const fixture = new FixtureRawReader({ pages: [rawItemPage(row)] })
      const reader = createCrossDomainIntegrityNormalizedPageReader(
        readerConfiguration(),
      )
      installFixtureRawReader(reader, fixture)
      try {
        await expect(reader.readPage(pageRequest(undefined, 'project-directory')))
          .rejects.toEqual(
            new CrossDomainIntegrityNormalizedPageReaderFailure(
              'AWS_RESPONSE_INVALID',
            ),
          )
      } finally {
        reader.close()
      }
    }
  })

  test('rejects malformed cursors before caller identity or Scan requests', async () => {
    const fixture = new FixtureRawReader()
    const reader = createCrossDomainIntegrityNormalizedPageReader(
      readerConfiguration(),
    )
    installFixtureRawReader(reader, fixture)
    try {
      await expect(reader.readPage(pageRequest('dynamodb-key-v1.***')))
        .rejects.toEqual(
          new CrossDomainIntegrityNormalizedPageReaderFailure('CURSOR_INVALID'),
        )
      expect(fixture.callerAccountReadCount).toBe(0)
      expect(fixture.scanRequests).toEqual([])
    } finally {
      reader.close()
    }
  })

  test('fails closed on a mismatched caller account before scanning', async () => {
    const fixture = new FixtureRawReader({ callerAccount: '999999999999' })
    const reader = createCrossDomainIntegrityNormalizedPageReader(
      readerConfiguration(),
    )
    installFixtureRawReader(reader, fixture)
    try {
      await expect(reader.readPage(pageRequest())).rejects.toEqual(
        new CrossDomainIntegrityNormalizedPageReaderFailure(
          'AWS_RESPONSE_INVALID',
        ),
      )
      expect(fixture.callerAccountReadCount).toBe(1)
      expect(fixture.scanRequests).toEqual([])
    } finally {
      reader.close()
    }
  })

  test('maps raw STS and SDK failures to the stable public failure', async () => {
    for (const fixture of [
      new FixtureRawReader({ callerError: new Error('raw sts details') }),
      new FixtureRawReader({ scanError: new Error('raw dynamodb details') }),
    ]) {
      const reader = createCrossDomainIntegrityNormalizedPageReader(
        readerConfiguration(),
      )
      installFixtureRawReader(reader, fixture)
      try {
        await expect(reader.readPage(pageRequest())).rejects.toEqual(
          new CrossDomainIntegrityNormalizedPageReaderFailure(
            'AWS_RESPONSE_INVALID',
          ),
        )
      } finally {
        reader.close()
      }
    }
  })
})
