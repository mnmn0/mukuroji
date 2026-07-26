import { parseKnownFiles } from '@smithy/core/config'

/**
 * Parsed shared-profile map returned by the exact-pinned Smithy configuration
 * parser.
 */
export type WorkspaceSearchMigrationSharedProfiles =
  Awaited<ReturnType<typeof parseKnownFiles>>

/**
 * Loads shared profiles through the migration-owned boundary around Smithy's
 * internal parser.
 *
 * The exact `@smithy/core` version is intentionally pinned so an SDK upgrade
 * must explicitly validate this single compatibility boundary.
 *
 * @param profile - Explicit profile selected by the migration operator.
 * @returns Parsed shared configuration and credentials profiles.
 */
export function loadWorkspaceSearchMigrationSharedProfiles(
  profile: string,
): Promise<WorkspaceSearchMigrationSharedProfiles> {
  return parseKnownFiles({
    ignoreCache: true,
    profile,
  })
}
