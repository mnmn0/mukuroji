import { createHash } from 'node:crypto'
import type {
  WorkspaceSearchMigrationRehearsalArtifactEvidence,
  WorkspaceSearchMigrationRehearsalEvidenceClaims,
} from './migration-rehearsal-evidence'
import {
  consumeWorkspaceSearchMigrationRehearsalFinalizedSuitePreparation,
} from './migration-rehearsal-suite-finalizer'
import {
  createAuthenticWorkspaceSearchMigrationRehearsalSuiteFixture,
} from './migration-rehearsal-suite-finalizer.test-fixture'

/** Returns one deterministic conventional digest for a fixture label. */
function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex')
}

/** Creates exact immutable references for the prepared child artifacts. */
function createReferences(
  artifacts: readonly {
    /** Canonical child artifact purpose. */
    readonly kind: WorkspaceSearchMigrationRehearsalArtifactEvidence['kind']
    /** SHA-256 digest of exact canonical bytes. */
    readonly contentDigest: string
    /** Exact canonical byte length. */
    readonly byteLength: number
  }[],
): readonly WorkspaceSearchMigrationRehearsalArtifactEvidence[] {
  return Object.freeze(artifacts.map((artifact) => Object.freeze({
    kind: artifact.kind,
    contentDigest: artifact.contentDigest,
    byteLength: artifact.byteLength,
    immutableVersionDigest: digest(`immutable-version:${artifact.kind}`),
    retainedUntil: '2027-08-03T00:00:00.000Z',
  })))
}

/**
 * Creates one complete suite-derived canonical evidence claim set.
 *
 * @returns Fresh detached claims containing all-eight reconciliation evidence.
 */
export async function createAuthenticWorkspaceSearchMigrationRehearsalEvidenceClaims():
Promise<WorkspaceSearchMigrationRehearsalEvidenceClaims> {
  const fixture =
    await createAuthenticWorkspaceSearchMigrationRehearsalSuiteFixture()
  const material =
    consumeWorkspaceSearchMigrationRehearsalFinalizedSuitePreparation(
      fixture.suite,
    )
  return material.finalize(createReferences(material.artifacts))
}
