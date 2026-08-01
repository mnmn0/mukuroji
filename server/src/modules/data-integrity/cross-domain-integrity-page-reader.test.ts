import { describe, expect, test } from 'bun:test'
import type {
  AttributeValue,
  ScanCommandOutput,
} from '@aws-sdk/client-dynamodb'
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

/** Creates the common high-level page request. */
function pageRequest(cursor?: string): CrossDomainIntegrityNormalizedPageRequest {
  return {
    auditPseudonymKey: AUDIT_KEY,
    checkedAt: CHECKED_AT,
    ...(cursor === undefined ? {} : { cursor }),
    digestKey: DIGEST_KEY,
    remainingItemCapacity: 1_000,
    target: 'work-items',
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
