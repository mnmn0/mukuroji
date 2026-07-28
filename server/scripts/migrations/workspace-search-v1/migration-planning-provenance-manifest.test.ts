import { describe, expect, test } from 'bun:test'
import {
  createMigrationDigest,
  serializeCanonicalJson,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationSourceName,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationPlanningProvenanceManifestHead,
  createWorkspaceSearchMigrationPlanningProvenanceManifestPages,
  createWorkspaceSearchMigrationPlanningProvenanceSegments,
  parseWorkspaceSearchMigrationPlanningProvenanceManifestHead,
  parseWorkspaceSearchMigrationPlanningProvenanceManifestPage,
  parseWorkspaceSearchMigrationPlanningProvenanceSegment,
  replayWorkspaceSearchMigrationPlanningProvenanceManifest,
  serializeWorkspaceSearchMigrationPlanningProvenanceManifestHead,
  type WorkspaceSearchMigrationPlanningProvenanceArtifactRole,
  type WorkspaceSearchMigrationPlanningProvenanceEncodedManifestPage,
  type WorkspaceSearchMigrationPlanningProvenanceEncodedSegment,
  WorkspaceSearchMigrationPlanningProvenanceManifestError,
  type WorkspaceSearchMigrationPlanningProvenanceManifestReference,
  type WorkspaceSearchMigrationPlanningProvenanceManifestSummary,
  type WorkspaceSearchMigrationPlanningProvenanceSegmentLocator,
  type WorkspaceSearchMigrationPlanningProvenanceStoredManifestPage,
  type WorkspaceSearchMigrationPlanningProvenanceStoredSegment,
  WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_HEAD_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_MANIFEST_PAGES,
  WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_SEGMENTS,
  WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_PAGE_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_SEGMENT_MAX_BYTES,
} from './migration-planning-provenance-manifest'
import {
  createWorkspaceSearchMigrationPlanningProvenanceArtifact,
  type WorkspaceSearchMigrationPlanningProvenanceArtifact,
  type WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import {
  advanceWorkspaceSearchMigrationSourceEvidenceProgress,
  createInitialWorkspaceSearchMigrationSourceEvidenceProgress,
  createWorkspaceSearchMigrationSourceEvidencePage,
  serializeWorkspaceSearchMigrationSourceEvidencePage,
  type WorkspaceSearchMigrationPlanningAuthorityBinding,
} from './migration-source-evidence'
import {
  createWorkspaceSearchMigrationPlanningSourceArtifactObjectKey,
} from './migration-source-artifact'
import {
  createInitialWorkspaceSearchMigrationTargetEvidenceProgress,
  createWorkspaceSearchMigrationTargetEvidencePage,
  serializeWorkspaceSearchMigrationTargetEvidencePage,
} from './migration-target-evidence'
import {
  createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey,
} from './migration-target-artifact'

const runId = 'planning-provenance-manifest-run'
const configurationHash = digest('configuration')
const ownerId = 'planning-owner'
const retainedUntil = '2026-08-28T00:00:00.000Z'
const objectKeyPrefix =
  'workspace-search/migrations/planning-provenance-manifest-run/provenance'

describe('Workspace Search planning provenance manifest', () => {
  test(
    'segments complete entries, creates bounded manifest layers, and replays the exact artifact',
    () => {
      const artifact = createArtifact()
      const segments =
        createWorkspaceSearchMigrationPlanningProvenanceSegments({
          artifact,
          maximumSegmentBytes: 8_192,
          objectKeyPrefix,
        })
      expect(segments.length).toBeGreaterThanOrEqual(2)
      expect(segments.map(({ segment }) => segment.role))
        .toContain('evidence-pages')
      expect(segments.map(({ segment }) => segment.role))
        .toContain('historical-receipts')
      expect(segments.every(({ byteLength }) => byteLength <= 8_192))
        .toBe(true)
      expect(
        segments.flatMap(({ segment }) => segment.entries).length,
      ).toBe(6)

      const storedSegments = storeSegments(segments)
      const pages =
        createWorkspaceSearchMigrationPlanningProvenanceManifestPages({
          artifact,
          objectKeyPrefix,
          storedSegments,
          maximumManifestPageBytes: 8_192,
        })
      expect(pages.length).toBeGreaterThan(0)
      expect(pages.every(({ byteLength }) => byteLength <= 8_192))
        .toBe(true)
      const storedPages = storeManifestPages(pages)
      const head =
        createWorkspaceSearchMigrationPlanningProvenanceManifestHead({
          artifact,
          objectKeyPrefix,
          storedManifestPages: storedPages,
        })
      const headBytes =
        serializeWorkspaceSearchMigrationPlanningProvenanceManifestHead(
          head,
        )
      expect(headBytes.byteLength).toBeLessThanOrEqual(
        WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_HEAD_MAX_BYTES,
      )
      expect(
        parseWorkspaceSearchMigrationPlanningProvenanceManifestHead(
          headBytes,
        ),
      ).toEqual(head)
      for (const segment of segments) {
        expect(
          parseWorkspaceSearchMigrationPlanningProvenanceSegment(
            segment.bytes,
          ),
        ).toEqual(segment.segment)
      }
      for (const page of pages) {
        expect(
          parseWorkspaceSearchMigrationPlanningProvenanceManifestPage(
            page.bytes,
          ),
        ).toEqual(page.page)
      }

      const replayed =
        replayWorkspaceSearchMigrationPlanningProvenanceManifest({
          head,
          manifestPages: storedPages.map(({ encoded, reference }) => ({
            reference,
            bytes: encoded.bytes,
          })),
          segments: storedSegments.map(({ encoded, reference }) => ({
            reference,
            bytes: encoded.bytes,
          })),
        })
      expect(replayed).toEqual(artifact)
    },
  )

  test(
    'packs deterministically at entry boundaries and rejects an oversized complete entry',
    () => {
      const artifact = createArtifact(1_500)
      const first =
        createWorkspaceSearchMigrationPlanningProvenanceSegments({
          artifact,
          maximumSegmentBytes: 8_192,
          objectKeyPrefix,
        })
      const second =
        createWorkspaceSearchMigrationPlanningProvenanceSegments({
          artifact,
          maximumSegmentBytes: 8_192,
          objectKeyPrefix,
        })
      expect(
        first.map(({ bytes }) => Buffer.from(bytes).toString('hex')),
      ).toEqual(
        second.map(({ bytes }) => Buffer.from(bytes).toString('hex')),
      )
      for (const encoded of first) {
        expect(encoded.segment.entryCount).toBe(
          encoded.segment.entries.length,
        )
        expect(encoded.byteLength).toBeLessThanOrEqual(8_192)
      }

      expectManifestFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceSegments({
          artifact,
          maximumSegmentBytes: 2_048,
          objectKeyPrefix,
        })
      )
    },
  )

  test(
    'rejects missing, reordered, substituted, and byte-length-mismatched immutable references',
    () => {
      const artifact = createArtifact()
      const segments =
        createWorkspaceSearchMigrationPlanningProvenanceSegments({
          artifact,
          objectKeyPrefix,
        })
      const storedSegments = storeSegments(segments)
      expect(storedSegments.length).toBeGreaterThan(1)

      expectManifestFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceManifestPages({
          artifact,
          objectKeyPrefix,
          storedSegments: storedSegments.slice(1),
        })
      )
      expectManifestFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceManifestPages({
          artifact,
          objectKeyPrefix,
          storedSegments: [
            storedSegments[1],
            storedSegments[0],
          ].filter(isStoredSegment),
        })
      )
      const first = storedSegments[0]
      if (first === undefined) {
        throw new Error('Expected one stored segment.')
      }
      const wrongSegmentRole:
        WorkspaceSearchMigrationPlanningProvenanceStoredSegment = {
          ...first,
          reference: {
            ...first.reference,
            objectKey:
              `${objectKeyPrefix}/manifest-pages/${first.reference.contentDigest}.artifact`,
          },
        }
      expectManifestFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceManifestPages({
          artifact,
          objectKeyPrefix,
          storedSegments: [
            wrongSegmentRole,
            ...storedSegments.slice(1),
          ],
        })
      )
      const substituted: WorkspaceSearchMigrationPlanningProvenanceStoredSegment = {
        ...first,
        reference: {
          ...first.reference,
          versionId: 'substituted-version',
        },
      }
      const manifestPages =
        createWorkspaceSearchMigrationPlanningProvenanceManifestPages({
          artifact,
          objectKeyPrefix,
          storedSegments,
        })
      const storedPages = storeManifestPages(manifestPages)
      const firstPage = storedPages[0]
      if (firstPage === undefined) {
        throw new Error('Expected one stored manifest page.')
      }
      const wrongPageRole:
        WorkspaceSearchMigrationPlanningProvenanceStoredManifestPage = {
          ...firstPage,
          reference: {
            ...firstPage.reference,
            objectKey:
              `${objectKeyPrefix}/segments/${firstPage.reference.contentDigest}.artifact`,
          },
        }
      expectManifestFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceManifestHead({
          artifact,
          objectKeyPrefix,
          storedManifestPages: [
            wrongPageRole,
            ...storedPages.slice(1),
          ],
        })
      )
      const head =
        createWorkspaceSearchMigrationPlanningProvenanceManifestHead({
          artifact,
          objectKeyPrefix,
          storedManifestPages: storedPages,
        })
      expectManifestFailure(() =>
        replayWorkspaceSearchMigrationPlanningProvenanceManifest({
          head,
          manifestPages: storedPages.map(({ encoded, reference }) => ({
            reference,
            bytes: encoded.bytes,
          })),
          segments: [
            substituted,
            ...storedSegments.slice(1),
          ].map(({ encoded, reference }) => ({
            reference,
            bytes: encoded.bytes,
          })),
        })
      )
      const wrongLength: WorkspaceSearchMigrationPlanningProvenanceStoredSegment = {
        ...first,
        reference: {
          ...first.reference,
          byteLength: first.reference.byteLength + 1,
        },
      }
      expectManifestFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceManifestPages({
          artifact,
          objectKeyPrefix,
          storedSegments: [wrongLength, ...storedSegments.slice(1)],
        })
      )
    },
  )

  test(
    'rejects tampered manifest pages and data segments during complete replay',
    () => {
      const fixture = createStoredBundle()
      const firstPage = fixture.storedPages[0]
      const firstSegment = fixture.storedSegments[0]
      if (firstPage === undefined || firstSegment === undefined) {
        throw new Error('Expected stored manifest material.')
      }
      const tamperedPageBytes = new Uint8Array(firstPage.encoded.bytes)
      tamperedPageBytes[tamperedPageBytes.length - 1] =
        tamperedPageBytes[tamperedPageBytes.length - 1] === 0x7d
          ? 0x7c
          : 0x7d
      expectManifestFailure(() =>
        replayWorkspaceSearchMigrationPlanningProvenanceManifest({
          head: fixture.head,
          manifestPages: fixture.storedPages.map(
            ({ encoded, reference }, index) => ({
              reference,
              bytes: index === 0 ? tamperedPageBytes : encoded.bytes,
            }),
          ),
          segments: fixture.storedSegments.map(
            ({ encoded, reference }) => ({
              reference,
              bytes: encoded.bytes,
            }),
          ),
        })
      )

      const tamperedSegmentBytes =
        new Uint8Array(firstSegment.encoded.bytes)
      tamperedSegmentBytes[tamperedSegmentBytes.length - 1] =
        tamperedSegmentBytes[tamperedSegmentBytes.length - 1] === 0x7d
          ? 0x7c
          : 0x7d
      expectManifestFailure(() =>
        replayWorkspaceSearchMigrationPlanningProvenanceManifest({
          head: fixture.head,
          manifestPages: fixture.storedPages.map(
            ({ encoded, reference }) => ({
              reference,
              bytes: encoded.bytes,
            }),
          ),
          segments: fixture.storedSegments.map(
            ({ encoded, reference }, index) => ({
              reference,
              bytes: index === 0
                ? tamperedSegmentBytes
                : encoded.bytes,
            }),
          ),
        })
      )
    },
  )

  test(
    'rejects over-limit operation counts at parse and replay boundaries',
    () => {
      const fixture = createStoredBundle()
      const firstSegment = fixture.storedSegments[0]
      if (firstSegment === undefined) {
        throw new Error('Expected one stored provenance segment.')
      }
      const countCases = [
        {
          sourceOperationCount: 100_001,
          orphanOperationCount: 0,
          planOperationCount: 100_001,
        },
        {
          sourceOperationCount: 0,
          orphanOperationCount: 100_001,
          planOperationCount: 100_001,
        },
        {
          sourceOperationCount: 50_000,
          orphanOperationCount: 50_001,
          planOperationCount: 100_001,
        },
      ]
      for (const counts of countCases) {
        const segment = structuredClone(firstSegment.encoded.segment)
        Reflect.set(
          segment,
          'summary',
          createTamperedOperationCountSummary(segment.summary, counts),
        )
        Reflect.deleteProperty(segment, 'segmentDigest')
        Reflect.set(
          segment,
          'segmentDigest',
          createMigrationDigest(segment),
        )
        expectManifestFailure(() =>
          parseWorkspaceSearchMigrationPlanningProvenanceSegment(
            encodeCanonicalCandidate(segment),
          )
        )
      }

      const head = structuredClone(fixture.head)
      Reflect.set(
        head,
        'summary',
        createTamperedOperationCountSummary(head.summary, countCases[2]),
      )
      Reflect.deleteProperty(head, 'headDigest')
      Reflect.set(head, 'headDigest', createMigrationDigest(head))
      expectManifestFailure(() =>
        replayWorkspaceSearchMigrationPlanningProvenanceManifest({
          head,
          manifestPages: fixture.storedPages.map(
            ({ encoded, reference }) => ({
              reference,
              bytes: encoded.bytes,
            }),
          ),
          segments: fixture.storedSegments.map(
            ({ encoded, reference }) => ({
              reference,
              bytes: encoded.bytes,
            }),
          ),
        })
      )
    },
  )

  test(
    'rejects ordered page-locator digest and terminal-version substitution',
    () => {
      const fixture = createStoredBundle()
      const referencedPages = fixture.storedPages.map(
        ({ encoded, reference }) => ({
          reference,
          bytes: encoded.bytes,
        }),
      )
      const referencedSegments = fixture.storedSegments.map(
        ({ encoded, reference }) => ({
          reference,
          bytes: encoded.bytes,
        }),
      )
      const firstReferencedPage = referencedPages[0]
      if (firstReferencedPage === undefined) {
        throw new Error('Expected one referenced manifest page.')
      }
      expectManifestFailure(() =>
        replayWorkspaceSearchMigrationPlanningProvenanceManifest({
          head: fixture.head,
          manifestPages: [{
            ...firstReferencedPage,
            reference: {
              ...firstReferencedPage.reference,
              versionId: 'substituted-supplied-page-version',
            },
          }, ...referencedPages.slice(1)],
          segments: referencedSegments,
        })
      )
      const wrongSetDigest = structuredClone(fixture.head)
      Reflect.set(
        wrongSetDigest,
        'manifestPageLocatorsDigest',
        digest('substituted-page-locator-set'),
      )
      Reflect.deleteProperty(wrongSetDigest, 'headDigest')
      Reflect.set(
        wrongSetDigest,
        'headDigest',
        createMigrationDigest(wrongSetDigest),
      )
      expectManifestFailure(() =>
        replayWorkspaceSearchMigrationPlanningProvenanceManifest({
          head: wrongSetDigest,
          manifestPages: referencedPages,
          segments: referencedSegments,
        })
      )

      const wrongTerminalVersion = structuredClone(fixture.head)
      const terminalLocator = structuredClone(
        wrongTerminalVersion.terminalManifestPageLocator,
      )
      Reflect.set(terminalLocator, 'reference', {
        ...terminalLocator.reference,
        versionId: 'substituted-terminal-version',
      })
      Reflect.set(
        wrongTerminalVersion,
        'terminalManifestPageLocator',
        terminalLocator,
      )
      Reflect.deleteProperty(wrongTerminalVersion, 'headDigest')
      Reflect.set(
        wrongTerminalVersion,
        'headDigest',
        createMigrationDigest(wrongTerminalVersion),
      )
      expectManifestFailure(() =>
        replayWorkspaceSearchMigrationPlanningProvenanceManifest({
          head: wrongTerminalVersion,
          manifestPages: referencedPages,
          segments: referencedSegments,
        })
      )
    },
  )

  test('rejects builder inputs missing operation-specific required keys', () => {
    const artifact = createArtifact()
    const missingSegmentPrefixInput = {
      artifact,
      objectKeyPrefix,
    }
    Reflect.deleteProperty(
      missingSegmentPrefixInput,
      'objectKeyPrefix',
    )
    expectManifestFailure(() =>
      createWorkspaceSearchMigrationPlanningProvenanceSegments(
        missingSegmentPrefixInput,
      )
    )

    const segments =
      createWorkspaceSearchMigrationPlanningProvenanceSegments({
        artifact,
        objectKeyPrefix,
      })
    const storedSegments = storeSegments(segments)
    const missingPagePrefixInput = {
      artifact,
      objectKeyPrefix,
      storedSegments,
    }
    Reflect.deleteProperty(missingPagePrefixInput, 'objectKeyPrefix')
    expectManifestFailure(() =>
      createWorkspaceSearchMigrationPlanningProvenanceManifestPages(
        missingPagePrefixInput,
      )
    )

    const missingStoredSegmentsInput = {
      artifact,
      objectKeyPrefix,
      storedSegments,
    }
    Reflect.deleteProperty(
      missingStoredSegmentsInput,
      'storedSegments',
    )
    expectManifestFailure(() =>
      createWorkspaceSearchMigrationPlanningProvenanceManifestPages(
        missingStoredSegmentsInput,
      )
    )
  })

  test(
    'fails closed for Proxy, accessors, sparse arrays, shared bytes, and typed-array accessors',
    () => {
      const artifact = createArtifact()
      let proxyReads = 0
      const proxy = new Proxy(artifact, {
        get(target, key, receiver) {
          proxyReads += 1
          return Reflect.get(target, key, receiver)
        },
      })
      expectManifestFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceSegments({
          artifact: proxy,
          objectKeyPrefix,
        })
      )
      expect(proxyReads).toBe(0)

      let accessorReads = 0
      const accessorArtifact = structuredClone(artifact)
      Object.defineProperty(accessorArtifact, 'runId', {
        enumerable: true,
        get() {
          accessorReads += 1
          return runId
        },
      })
      expectManifestFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceSegments({
          artifact: accessorArtifact,
          objectKeyPrefix,
        })
      )
      expect(accessorReads).toBe(0)

      const sparseArtifact = structuredClone(artifact)
      const sparse: string[] = []
      sparse.length = 1
      Reflect.set(
        sparseArtifact.evidencePageWitnesses.sources,
        'documents',
        sparse,
      )
      expectManifestFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceSegments({
          artifact: sparseArtifact,
          objectKeyPrefix,
        })
      )

      const segments =
        createWorkspaceSearchMigrationPlanningProvenanceSegments({
          artifact,
          objectKeyPrefix,
        })
      const bytes = segments[0]?.bytes
      if (bytes === undefined) throw new Error('Expected one segment.')
      const shared = new Uint8Array(
        new SharedArrayBuffer(bytes.byteLength),
      )
      shared.set(bytes)
      expectManifestFailure(() =>
        parseWorkspaceSearchMigrationPlanningProvenanceSegment(shared)
      )

      let byteLengthReads = 0
      const accessorBytes = new Uint8Array(bytes)
      Object.defineProperty(accessorBytes, 'byteLength', {
        configurable: true,
        get() {
          byteLengthReads += 1
          return 0
        },
      })
      expect(
        parseWorkspaceSearchMigrationPlanningProvenanceSegment(
          accessorBytes,
        ),
      ).toEqual(segments[0]?.segment)
      expect(byteLengthReads).toBe(0)

      let byteProxyReads = 0
      const bytesProxy = new Proxy(bytes, {
        get(target, key, receiver) {
          byteProxyReads += 1
          return Reflect.get(target, key, receiver)
        },
      })
      expectManifestFailure(() =>
        parseWorkspaceSearchMigrationPlanningProvenanceSegment(
          bytesProxy,
        )
      )
      expect(byteProxyReads).toBe(0)
    },
  )

  test(
    'rejects foreign summary and historical-receipt bindings before manifest construction',
    () => {
      const artifact = createArtifact()
      const wrongSummary = structuredClone(artifact)
      Reflect.set(
        wrongSummary,
        'planOperationCount',
        wrongSummary.planOperationCount + 1,
      )
      expectManifestFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceSegments({
          artifact: wrongSummary,
          objectKeyPrefix,
        })
      )

      const wrongReceipt = structuredClone(artifact)
      const firstReceipt = wrongReceipt.historicalReceipts[0]
      if (firstReceipt === undefined) {
        throw new Error('Expected one historical receipt.')
      }
      Reflect.set(wrongReceipt.historicalReceipts, 0, {
        ...firstReceipt,
        ownerId: 'different-owner',
      })
      expectManifestFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceSegments({
          artifact: wrongReceipt,
          objectKeyPrefix,
        })
      )

      const wrongTable = structuredClone(artifact)
      Reflect.set(
        wrongTable.tableIds,
        'documents',
        'foreign-documents-table',
      )
      const segments =
        createWorkspaceSearchMigrationPlanningProvenanceSegments({
          artifact,
          objectKeyPrefix,
        })
      expectManifestFailure(() =>
        createWorkspaceSearchMigrationPlanningProvenanceManifestPages({
          artifact: wrongTable,
          objectKeyPrefix,
          storedSegments: storeSegments(segments),
        })
      )
    },
  )

  test(
    'keeps a maximum 1,000-page builder output within the compact-head ceiling',
    () => {
      const artifact = createMaximumManifestPageArtifact()
      const initialSegments =
        createWorkspaceSearchMigrationPlanningProvenanceSegments({
          artifact,
          objectKeyPrefix,
        })
      const entries = initialSegments.flatMap(({ segment }) =>
        segment.entries.map((entry, index) => ({
          entry,
          entryStartIndex: segment.entryStartIndex + index,
          role: segment.role,
          summary: segment.summary,
        }))
      )
      expect(entries).toHaveLength(
        WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_MANIFEST_PAGES,
      )
      const maximumSingleEntrySegmentBytes = Math.max(
        ...entries.map((entry) =>
          canonicalByteLength({
            kind: 'workspace-search-planning-provenance-segment',
            segmentVersion: 1,
            summary: entry.summary,
            role: entry.role,
            segmentIndex:
              WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_SEGMENTS - 1,
            segmentCount:
              WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_SEGMENTS,
            entryStartIndex: entry.entryStartIndex,
            entryCount: 1,
            entries: [entry.entry],
            segmentDigest: '0'.repeat(64),
          })
        ),
      )
      const segments =
        createWorkspaceSearchMigrationPlanningProvenanceSegments({
          artifact,
          maximumSegmentBytes: maximumSingleEntrySegmentBytes,
          objectKeyPrefix,
        })
      expect(segments).toHaveLength(
        WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_MANIFEST_PAGES,
      )
      const maximumVersionId = 'v'.repeat(2_048)
      const storedSegments = segments.map((encoded, index) => ({
        encoded,
        reference: {
          ...createReference(
            'segments',
            index,
            encoded.contentDigest,
            encoded.byteLength,
          ),
          versionId: maximumVersionId,
        },
      }))
      const locators = storedSegments.map(({ encoded, reference }) => ({
        role: encoded.segment.role,
        segmentIndex: encoded.segment.segmentIndex,
        segmentCount: encoded.segment.segmentCount,
        entryStartIndex: encoded.segment.entryStartIndex,
        entryCount: encoded.segment.entryCount,
        segmentDigest: encoded.segment.segmentDigest,
        reference,
      }))
      const summary = segments[0]?.segment.summary
      if (summary === undefined) {
        throw new Error('Expected maximum-boundary segments.')
      }
      const maximumSingleLocatorPageBytes = Math.max(
        ...locators.map((locator) =>
          canonicalByteLength(
            createManifestPageSizeCandidate(summary, [locator]),
          )
        ),
      )
      const adjacentPairMinimum = Math.min(
        ...locators.slice(0, -1).map((locator, index) => {
          const next = locators[index + 1]
          if (next === undefined) {
            throw new Error('Expected an adjacent segment locator.')
          }
          return canonicalByteLength(
            createManifestPageSizeCandidate(summary, [locator, next]),
          )
        }),
      )
      expect(adjacentPairMinimum).toBeGreaterThan(
        maximumSingleLocatorPageBytes,
      )
      const pages =
        createWorkspaceSearchMigrationPlanningProvenanceManifestPages({
          artifact,
          maximumManifestPageBytes: maximumSingleLocatorPageBytes,
          objectKeyPrefix,
          storedSegments,
        })
      expect(pages).toHaveLength(
        WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_MANIFEST_PAGES,
      )
      const storedPages = pages.map((encoded, index) => ({
        encoded,
        reference: {
          ...createReference(
            'manifest-pages',
            index,
            encoded.contentDigest,
            encoded.byteLength,
          ),
          versionId: maximumVersionId,
        },
      }))
      const head =
        createWorkspaceSearchMigrationPlanningProvenanceManifestHead({
          artifact,
          objectKeyPrefix,
          storedManifestPages: storedPages,
        })
      const headBytes =
        serializeWorkspaceSearchMigrationPlanningProvenanceManifestHead(
          head,
        )
      expect(head.manifestPageCount).toBe(
        WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_MANIFEST_PAGES,
      )
      expect(head.terminalManifestPageLocator.pageIndex).toBe(
        WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_MANIFEST_PAGES - 1,
      )
      expect(headBytes.byteLength).toBeLessThanOrEqual(
        WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_HEAD_MAX_BYTES,
      )
      expect(
        parseWorkspaceSearchMigrationPlanningProvenanceManifestHead(
          headBytes,
        ),
      ).toEqual(head)
    },
    30_000,
  )

  test('exports fixed hard byte ceilings for every immutable layer', () => {
    expect(
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_SEGMENT_MAX_BYTES,
    ).toBe(16 * 1024 * 1024)
    expect(
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_PAGE_MAX_BYTES,
    ).toBe(256 * 1024)
    expect(
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_HEAD_MAX_BYTES,
    ).toBe(256 * 1024)
  })
})

/**
 * Creates one coherent existing full provenance artifact fixture.
 *
 * @param paddingLength - Optional canonical page padding used for packing tests.
 * @returns Strict artifact accepted by the segmented compatibility boundary.
 */
function createArtifact(
  paddingLength = 0,
): WorkspaceSearchMigrationPlanningProvenanceArtifact {
  const receipt = createReceipt()
  const receiptDigest = createMigrationDigest(receipt)
  const authority: WorkspaceSearchMigrationPlanningAuthorityBinding = {
    ownerId,
    fenceToken: receipt.fenceToken,
    maintenanceEvidencePointerRevision: 11,
    maintenanceEvidenceReceiptDigest: receiptDigest,
  }
  const sourceEvidencePageBytes = {
    'project-directory': [
      createTerminalSourceEvidencePage(
        'project-directory',
        authority,
        paddingLength,
      ),
    ],
    'work-items': [
      createTerminalSourceEvidencePage(
        'work-items',
        authority,
        paddingLength,
      ),
    ],
    collaboration: [
      createTerminalSourceEvidencePage(
        'collaboration',
        authority,
        paddingLength,
      ),
    ],
    documents: [
      createTerminalSourceEvidencePage(
        'documents',
        authority,
        paddingLength,
      ),
    ],
  }
  return createWorkspaceSearchMigrationPlanningProvenanceArtifact({
    sourceEvidencePageBytes,
    targetEvidencePageBytes: [
      createTerminalTargetEvidencePage(authority),
    ],
    historicalReceiptBindings: [{
      configurationHash,
      stateTableId: tableIds['migration-state'],
      ownerId,
      receiptDigest,
      receipt,
    }],
  })
}

/**
 * Creates 999 evidence witnesses plus one receipt for the 1,000-page boundary.
 *
 * @returns Strict full artifact whose entries can pack one per segment.
 */
function createMaximumManifestPageArtifact():
  WorkspaceSearchMigrationPlanningProvenanceArtifact {
  const receipt = createReceipt()
  const receiptDigest = createMigrationDigest(receipt)
  const authority: WorkspaceSearchMigrationPlanningAuthorityBinding = {
    ownerId,
    fenceToken: receipt.fenceToken,
    maintenanceEvidencePointerRevision: 11,
    maintenanceEvidenceReceiptDigest: receiptDigest,
  }
  return createWorkspaceSearchMigrationPlanningProvenanceArtifact({
    sourceEvidencePageBytes: {
      'project-directory': createSourceEvidencePageChain(
        'project-directory',
        authority,
        995,
      ),
      'work-items': [
        createTerminalSourceEvidencePage(
          'work-items',
          authority,
          512,
        ),
      ],
      collaboration: [
        createTerminalSourceEvidencePage(
          'collaboration',
          authority,
          512,
        ),
      ],
      documents: [
        createTerminalSourceEvidencePage(
          'documents',
          authority,
          512,
        ),
      ],
    },
    targetEvidencePageBytes: [
      createTerminalTargetEvidencePage(authority),
    ],
    historicalReceiptBindings: [{
      configurationHash,
      stateTableId: tableIds['migration-state'],
      ownerId,
      receiptDigest,
      receipt,
    }],
  })
}

/**
 * Creates one completed multi-page empty source chain with stable authority.
 *
 * @param source - Fixed logical source chain.
 * @param authority - Exact durable planning authority.
 * @param pageCount - Positive number of pages to create.
 * @returns Exact canonical page bytes in chain order.
 */
function createSourceEvidencePageChain(
  source: WorkspaceSearchMigrationSourceName,
  authority: WorkspaceSearchMigrationPlanningAuthorityBinding,
  pageCount: number,
): readonly Uint8Array[] {
  const identity = {
    purpose: 'planning',
    runId,
    configurationHash,
    source,
    sourceTableId: tableIds[source],
    stateTableId: tableIds['migration-state'],
  } satisfies Parameters<
    typeof createInitialWorkspaceSearchMigrationSourceEvidenceProgress
  >[0]
  let progress =
    createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
  const pageBytes: Uint8Array[] = []
  for (let index = 0; index < pageCount; index += 1) {
    const completed = index === pageCount - 1
    const artifactDigest = digest(`source-artifact:${source}:${index}`)
    const page =
      createWorkspaceSearchMigrationSourceEvidencePage({
        identity,
        planningAuthority: authority,
        sourceArtifacts: [{
          objectKey:
            createWorkspaceSearchMigrationPlanningSourceArtifactObjectKey(
              artifactDigest,
            ),
          versionId:
            `source-version-${source}-${index}-${'x'.repeat(512)}`,
          contentDigest: artifactDigest,
        }],
        previousProgress: progress,
        pageResult: {
          checkpoint: {
            completed,
            ...(
              completed
                ? {}
                : { cursor: { page: { N: String(index + 1) } } }
            ),
            aggregate: {
              ...progress.checkpoint.aggregate,
              pageCount: index + 1,
            },
            keyDigestState: {
              ...progress.checkpoint.keyDigestState,
            },
            contentDigestState: {
              ...progress.checkpoint.contentDigestState,
            },
          },
          sourceRows: [],
          invalidRows: [],
          sourceBindings: [],
        },
      })
    pageBytes.push(
      serializeWorkspaceSearchMigrationSourceEvidencePage(page),
    )
    progress =
      advanceWorkspaceSearchMigrationSourceEvidenceProgress(
        progress,
        page,
      )
  }
  return pageBytes
}

/**
 * Creates one canonical completed empty planning source evidence page.
 *
 * @param source - Fixed logical source chain.
 * @param authority - Exact durable planning authority.
 * @param paddingLength - Optional bounded version-ID padding.
 * @returns Exact canonical source evidence-page bytes.
 */
function createTerminalSourceEvidencePage(
  source: WorkspaceSearchMigrationSourceName,
  authority: WorkspaceSearchMigrationPlanningAuthorityBinding,
  paddingLength: number,
): Uint8Array {
  const identity = {
    purpose: 'planning',
    runId,
    configurationHash,
    source,
    sourceTableId: tableIds[source],
    stateTableId: tableIds['migration-state'],
  } satisfies Parameters<
    typeof createInitialWorkspaceSearchMigrationSourceEvidenceProgress
  >[0]
  const initial =
    createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
  const artifactDigest = digest(`source-artifact:${source}`)
  const page = createWorkspaceSearchMigrationSourceEvidencePage({
    identity,
    planningAuthority: authority,
    sourceArtifacts: [{
      objectKey:
        createWorkspaceSearchMigrationPlanningSourceArtifactObjectKey(
          artifactDigest,
        ),
      versionId:
        `source-version-${source}-${'x'.repeat(Math.min(paddingLength, 512))}`,
      contentDigest: artifactDigest,
    }],
    previousProgress: initial,
    pageResult: {
      checkpoint: {
        ...initial.checkpoint,
        completed: true,
        aggregate: {
          ...initial.checkpoint.aggregate,
          pageCount: 1,
        },
      },
      sourceRows: [],
      invalidRows: [],
      sourceBindings: [],
    },
  })
  return serializeWorkspaceSearchMigrationSourceEvidencePage(page)
}

/**
 * Creates one canonical completed empty planning target evidence page.
 *
 * @param authority - Exact durable planning authority.
 * @returns Exact canonical target evidence-page bytes.
 */
function createTerminalTargetEvidencePage(
  authority: WorkspaceSearchMigrationPlanningAuthorityBinding,
): Uint8Array {
  const identity = {
    purpose: 'planning',
    runId,
    configurationHash,
    targetTableId: tableIds['workspace-search'],
    stateTableId: tableIds['migration-state'],
  } satisfies Parameters<
    typeof createInitialWorkspaceSearchMigrationTargetEvidenceProgress
  >[0]
  const initial =
    createInitialWorkspaceSearchMigrationTargetEvidenceProgress(identity)
  const artifactDigest = digest('target-artifact')
  const page = createWorkspaceSearchMigrationTargetEvidencePage({
    identity,
    planningAuthority: authority,
    targetArtifacts: [{
      objectKey:
        createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey(
          artifactDigest,
        ),
      versionId: 'target-version-1',
      contentDigest: artifactDigest,
    }],
    previousProgress: initial,
    pageResult: {
      checkpoint: {
        ...initial.checkpoint,
        completed: true,
        aggregate: {
          ...initial.checkpoint.aggregate,
          pageCount: 1,
        },
      },
      targetRows: [],
      invalidRows: [],
      observedTargetBindings: [],
    },
  })
  return serializeWorkspaceSearchMigrationTargetEvidencePage(page)
}

/** Fixed six-table physical identity fixture. */
const tableIds: WorkspaceSearchMigrationSealedPlanningTableIds = {
  'project-directory': 'project-directory-table-id',
  'work-items': 'work-items-table-id',
  collaboration: 'collaboration-table-id',
  documents: 'documents-table-id',
  'workspace-search': 'workspace-search-table-id',
  'migration-state': 'migration-state-table-id',
}

/**
 * Creates one canonical historical maintenance receipt.
 *
 * @returns Strict receipt bound to the fixture transition.
 */
function createReceipt(): WorkspaceSearchMaintenanceEvidenceReceipt {
  return {
    runId,
    evidenceDigest: digest('maintenance-evidence'),
    evidenceLocator:
      'workspace-search/v1/maintenance/manifest-fixture.json',
    runtimeRevision: 3,
    fenceToken: 7,
    validatedAt: '2026-07-28T00:02:00.000Z',
    oldestObservationAt: '2026-07-28T00:01:00.000Z',
    validUntil: '2026-07-28T00:06:00.001Z',
  }
}

/**
 * Creates exact rich immutable references for encoded data segments.
 *
 * @param encoded - Ordered locally encoded segments.
 * @returns Complete stored-segment envelopes.
 */
function storeSegments(
  encoded:
    readonly WorkspaceSearchMigrationPlanningProvenanceEncodedSegment[],
): readonly WorkspaceSearchMigrationPlanningProvenanceStoredSegment[] {
  return encoded.map((segment, index) => ({
    encoded: segment,
    reference: createReference(
      'segments',
      index,
      segment.contentDigest,
      segment.byteLength,
    ),
  }))
}

/**
 * Creates exact rich immutable references for encoded manifest pages.
 *
 * @param encoded - Ordered locally encoded manifest pages.
 * @returns Complete stored manifest-page envelopes.
 */
function storeManifestPages(
  encoded:
    readonly WorkspaceSearchMigrationPlanningProvenanceEncodedManifestPage[],
): readonly WorkspaceSearchMigrationPlanningProvenanceStoredManifestPage[] {
  return encoded.map((page, index) => ({
    encoded: page,
    reference: createReference(
      'manifest-pages',
      index,
      page.contentDigest,
      page.byteLength,
    ),
  }))
}

/**
 * Creates one complete stored bundle fixture.
 *
 * @returns Artifact, stored segments/pages, and compact final head.
 */
function createStoredBundle(): {
  /** Existing strict full artifact. */
  readonly artifact: WorkspaceSearchMigrationPlanningProvenanceArtifact
  /** Complete stored data segments. */
  readonly storedSegments:
    readonly WorkspaceSearchMigrationPlanningProvenanceStoredSegment[]
  /** Complete stored manifest pages. */
  readonly storedPages:
    readonly WorkspaceSearchMigrationPlanningProvenanceStoredManifestPage[]
  /** Compact immutable manifest head. */
  readonly head: ReturnType<
    typeof createWorkspaceSearchMigrationPlanningProvenanceManifestHead
  >
} {
  const artifact = createArtifact()
  const storedSegments = storeSegments(
    createWorkspaceSearchMigrationPlanningProvenanceSegments({
      artifact,
      objectKeyPrefix,
    }),
  )
  const storedPages = storeManifestPages(
    createWorkspaceSearchMigrationPlanningProvenanceManifestPages({
      artifact,
      objectKeyPrefix,
      storedSegments,
    }),
  )
  return {
    artifact,
    storedSegments,
    storedPages,
    head: createWorkspaceSearchMigrationPlanningProvenanceManifestHead({
      artifact,
      objectKeyPrefix,
      storedManifestPages: storedPages,
    }),
  }
}

/**
 * Creates one rich immutable reference matching exact canonical bytes.
 *
 * @param role - Fixed immutable-artifact storage role.
 * @param index - Stable fixture object position.
 * @param contentDigest - Exact SHA-256 byte digest.
 * @param byteLength - Exact canonical byte length.
 * @returns Complete exact-version reference.
 */
function createReference(
  role: WorkspaceSearchMigrationPlanningProvenanceArtifactRole,
  index: number,
  contentDigest: string,
  byteLength: number,
): WorkspaceSearchMigrationPlanningProvenanceManifestReference {
  return {
    objectKey: `${objectKeyPrefix}/${role}/${contentDigest}.artifact`,
    versionId: `version-${role}-${index}`,
    contentDigest,
    byteLength,
    retainUntil: retainedUntil,
  }
}

/**
 * Creates one self-consistent summary with caller-selected operation counts.
 *
 * @param summary - Existing strict summary to preserve outside the counts.
 * @param counts - Replacement source, orphan, and total operation counts.
 * @returns Summary with a recomputed self-digest.
 */
function createTamperedOperationCountSummary(
  summary: WorkspaceSearchMigrationPlanningProvenanceManifestSummary,
  counts: Readonly<
    Pick<
      WorkspaceSearchMigrationPlanningProvenanceManifestSummary,
      | 'sourceOperationCount'
      | 'orphanOperationCount'
      | 'planOperationCount'
    >
  >,
): WorkspaceSearchMigrationPlanningProvenanceManifestSummary {
  const candidate = structuredClone(summary)
  Reflect.set(
    candidate,
    'sourceOperationCount',
    counts.sourceOperationCount,
  )
  Reflect.set(
    candidate,
    'orphanOperationCount',
    counts.orphanOperationCount,
  )
  Reflect.set(candidate, 'planOperationCount', counts.planOperationCount)
  Reflect.deleteProperty(candidate, 'summaryDigest')
  Reflect.set(
    candidate,
    'summaryDigest',
    createMigrationDigest(candidate),
  )
  return candidate
}

/**
 * Serializes one JSON-safe test candidate canonically.
 *
 * @param value - Candidate manifest value.
 * @returns Canonical UTF-8 bytes.
 */
function encodeCanonicalCandidate(value: unknown): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJson(value))
}

/**
 * Creates the conservative page shape used by production locator packing.
 *
 * @param summary - Complete artifact summary copied into the page.
 * @param locators - Candidate contiguous segment locators.
 * @returns Maximum-index canonical page-size candidate.
 */
function createManifestPageSizeCandidate(
  summary: WorkspaceSearchMigrationPlanningProvenanceManifestSummary,
  locators:
    readonly WorkspaceSearchMigrationPlanningProvenanceSegmentLocator[],
) {
  const first = locators[0]
  if (first === undefined) {
    throw new Error('Expected at least one segment locator.')
  }
  return {
    kind: 'workspace-search-planning-provenance-manifest-page',
    manifestPageVersion: 1,
    summary,
    pageIndex:
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_MANIFEST_PAGES - 1,
    pageCount:
      WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_MANIFEST_PAGES,
    segmentStartIndex: first.segmentIndex,
    segmentCount: locators.length,
    segments: locators,
    pageDigest: '0'.repeat(64),
  }
}

/**
 * Computes one canonical JSON value's exact UTF-8 byte length.
 *
 * @param value - JSON-safe canonical candidate.
 * @returns Exact canonical UTF-8 byte length.
 */
function canonicalByteLength(value: unknown): number {
  return Buffer.byteLength(serializeCanonicalJson(value), 'utf8')
}

/**
 * Checks a possibly missing stored segment for array fixture narrowing.
 *
 * @param value - Candidate stored segment.
 * @returns Whether the segment is defined.
 */
function isStoredSegment(
  value:
    WorkspaceSearchMigrationPlanningProvenanceStoredSegment | undefined,
): value is WorkspaceSearchMigrationPlanningProvenanceStoredSegment {
  return value !== undefined
}

/**
 * Creates a stable digest for one fixture label.
 *
 * @param label - Stable fixture label.
 * @returns Lowercase SHA-256 digest.
 */
function digest(label: string): string {
  return createMigrationDigest({ label })
}

/**
 * Requires one public manifest boundary to fail with a stable redacted error.
 *
 * @param operation - Deferred invalid invocation.
 */
function expectManifestFailure(operation: () => unknown): void {
  try {
    operation()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(
      WorkspaceSearchMigrationPlanningProvenanceManifestError,
    )
    if (
      error instanceof
        WorkspaceSearchMigrationPlanningProvenanceManifestError
    ) {
      expect(error.code).toBe(
        'INVALID_PLANNING_PROVENANCE_MANIFEST',
      )
      expect(error.message).toBe(
        'INVALID_PLANNING_PROVENANCE_MANIFEST',
      )
      return
    }
  }
  throw new Error('Expected planning provenance manifest failure.')
}
