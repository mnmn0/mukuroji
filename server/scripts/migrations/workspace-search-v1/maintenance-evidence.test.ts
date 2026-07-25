import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  createMaintenanceEvidenceFileDigest,
  MaintenanceEvidenceError,
  maintenanceRuntimeControlSurfaces,
  parseMaintenanceEvidence,
} from './maintenance-evidence'

const encoder = new TextEncoder()

/**
 * Creates valid version-one maintenance evidence as an untrusted JSON object.
 *
 * @returns Complete evidence object suitable for mutation by rejection tests.
 */
function createEvidence(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    locator: 'change:CHG-2026-0042',
    runtimeMode: 'disabled',
    runtimeRevision: 42,
    drainStartedAt: '2026-07-25T01:00:00.000Z',
    drainCompletedAt: '2026-07-25T01:15:00.000Z',
    observedWriterMutations: 0,
    surfaces: maintenanceRuntimeControlSurfaces.map((surface) => ({
      surface,
      mode: 'disabled',
      status: 'current',
      revision: 42,
      observedAt: '2026-07-25T01:15:01.000Z',
    })),
  }
}

/**
 * Serializes an untrusted evidence object to exact UTF-8 file bytes.
 *
 * @param evidence - Evidence object.
 * @param indentation - Optional JSON indentation.
 * @returns Exact UTF-8 bytes.
 */
function serializeEvidence(
  evidence: Readonly<Record<string, unknown>>,
  indentation?: number,
): Uint8Array {
  return encoder.encode(JSON.stringify(evidence, undefined, indentation))
}

/**
 * Requires a mutable surface array from an evidence test object.
 *
 * @param evidence - Untrusted evidence object.
 * @returns Mutable surface array.
 */
function requireTestSurfaces(
  evidence: Readonly<Record<string, unknown>>,
): Record<string, unknown>[] {
  const surfaces = evidence.surfaces
  if (!Array.isArray(surfaces)) throw new Error('Invalid test fixture.')

  const records: Record<string, unknown>[] = []
  for (const surface of surfaces) {
    if (
      typeof surface !== 'object'
      || surface === null
      || Array.isArray(surface)
    ) {
      throw new Error('Invalid test fixture.')
    }
    records.push(surface)
  }
  return records
}

describe('Workspace Search maintenance evidence', () => {
  test('accepts all fourteen current disabled surfaces after a 900-second drain', () => {
    const bytes = serializeEvidence(createEvidence())
    const parsed = parseMaintenanceEvidence(bytes)
    const parsedEvidence: unknown = parsed.evidence

    expect(parsedEvidence).toEqual(createEvidence())
    expect(parsed.evidence.surfaces).toHaveLength(14)
    expect(parsed.fileSha256).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    )
    expect(parsed.fileSha256).toBe(createMaintenanceEvidenceFileDigest(bytes))
  })

  test('digests exact file bytes rather than normalized JSON', () => {
    const compact = serializeEvidence(createEvidence())
    const indented = serializeEvidence(createEvidence(), 2)

    expect(parseMaintenanceEvidence(compact).evidence)
      .toEqual(parseMaintenanceEvidence(indented).evidence)
    expect(createMaintenanceEvidenceFileDigest(compact))
      .not.toBe(createMaintenanceEvidenceFileDigest(indented))
  })

  test('rejects invalid global controls and incomplete drain evidence', () => {
    const invalidEvidence = [
      { ...createEvidence(), schemaVersion: 2 },
      { ...createEvidence(), runtimeMode: 'enabled' },
      { ...createEvidence(), runtimeRevision: 0 },
      { ...createEvidence(), runtimeRevision: 1.5 },
      { ...createEvidence(), observedWriterMutations: 1 },
      {
        ...createEvidence(),
        drainCompletedAt: '2026-07-25T01:14:59.999Z',
      },
      {
        ...createEvidence(),
        drainStartedAt: '2026-07-25T01:00:00Z',
      },
      {
        ...createEvidence(),
        drainStartedAt: '2026-02-30T01:00:00.000Z',
      },
      { ...createEvidence(), locator: '' },
      { ...createEvidence(), locator: 'https://user:secret@example.test/evidence' },
      { ...createEvidence(), extra: 'not-allowed' },
    ]

    for (const evidence of invalidEvidence) {
      expect(() => parseMaintenanceEvidence(serializeEvidence(evidence)))
        .toThrow(MaintenanceEvidenceError)
    }
  })

  test('rejects missing, duplicate, unknown, stale, or enabled surfaces', () => {
    const missing = createEvidence()
    missing.surfaces = requireTestSurfaces(missing).slice(0, -1)

    const duplicate = createEvidence()
    const duplicateSurfaces = requireTestSurfaces(duplicate)
    duplicateSurfaces[13] = { ...duplicateSurfaces[0] }
    duplicate.surfaces = duplicateSurfaces

    const unknown = createEvidence()
    requireTestSurfaces(unknown)[0].surface = 'tenant-secret-surface'

    const enabled = createEvidence()
    requireTestSurfaces(enabled)[0].mode = 'enabled'

    const stale = createEvidence()
    requireTestSurfaces(stale)[0].status = 'stale'

    const wrongRevision = createEvidence()
    requireTestSurfaces(wrongRevision)[0].revision = 41

    const observedBeforeDrain = createEvidence()
    requireTestSurfaces(observedBeforeDrain)[0].observedAt =
      '2026-07-25T01:14:59.999Z'

    const extraField = createEvidence()
    requireTestSurfaces(extraField)[0].tenant = 'tenant-secret-canary'

    for (const evidence of [
      missing,
      duplicate,
      unknown,
      enabled,
      stale,
      wrongRevision,
      observedBeforeDrain,
      extraField,
    ]) {
      expect(() => parseMaintenanceEvidence(serializeEvidence(evidence)))
        .toThrow(MaintenanceEvidenceError)
    }
  })

  test('rejects invalid UTF-8 and never includes raw identifiers in errors', () => {
    expect(() => parseMaintenanceEvidence(
      Uint8Array.from([0x7b, 0x22, 0xff, 0x22, 0x7d]),
    )).toThrow(MaintenanceEvidenceError)

    const evidence = createEvidence()
    evidence.locator = 'tenant-secret-canary@example.test?token=raw-secret'

    try {
      parseMaintenanceEvidence(serializeEvidence(evidence))
      throw new Error('Expected maintenance evidence failure.')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(MaintenanceEvidenceError)
      expect(error).toMatchObject({
        code: 'INVALID_MAINTENANCE_EVIDENCE',
        message: 'INVALID_MAINTENANCE_EVIDENCE',
      })
      expect(String(error)).not.toContain('tenant-secret-canary')
      expect(String(error)).not.toContain('raw-secret')
    }
  })
})
