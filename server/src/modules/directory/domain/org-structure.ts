import {
  parseOrgStructure,
  readOrgStructureDraft,
  type OrgStructure,
  type OrgStructureIssue,
  type OrgUnit,
  type OrgUnitTeamAssignment,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../project-data-error'

/** Largest stored revision of an OrgUnit structure. */
const ORG_STRUCTURE_MAX_REVISION = Number.MAX_SAFE_INTEGER - 1

/** Validated request that replaces the OrgUnit structure of a Workspace. */
export type ReplaceOrgStructureCommand = {
  /** Revision the caller read. */
  expectedRevision: number
  /** OrgUnits ordered so that every parent comes before its children. */
  orgUnits: OrgUnit[]
  /** Team memberships. */
  teamAssignments: OrgUnitTeamAssignment[]
}

/** Structure of a Workspace that has never saved one: no OrgUnits, so Teams behave as before. */
export const EMPTY_ORG_STRUCTURE: OrgStructure = Object.freeze({
  orgUnits: [],
  teamAssignments: [],
  revision: 0,
})

/**
 * Reads the untrusted body of `PUT /api/org-structure`.
 *
 * @param value - Untrusted request body.
 * @returns The validated command.
 * @throws ProjectDataError with status 400 and code `InvalidOrgStructure` when the body is invalid.
 */
export function readReplaceOrgStructureCommand(value: unknown): ReplaceOrgStructureCommand {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidOrgStructure('invalid-shape')
  }
  const record: Record<string, unknown> = { ...value }
  const expectedRevision = record.expectedRevision
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    expectedRevision > ORG_STRUCTURE_MAX_REVISION
  ) {
    throw invalidOrgStructure('invalid-shape')
  }
  const draft = readOrgStructureDraft(record.orgUnits, record.teamAssignments)
  if (!draft.ok) throw invalidOrgStructure(draft.issue)
  return { expectedRevision, orgUnits: draft.orgUnits, teamAssignments: draft.teamAssignments }
}

/**
 * Validates a stored OrgUnit structure.
 *
 * @param value - Stored structure fields.
 * @returns The structure.
 * @throws ProjectDataError with status 503 when the stored structure is malformed, so an
 * unreadable structure never silently widens or narrows access.
 */
export function readStoredOrgStructure(value: unknown): OrgStructure {
  const structure = parseOrgStructure(value)
  if (!structure || structure.revision === 0) {
    throw new ProjectDataError(503, 'OrgStructureUnavailable', 'The stored OrgUnit structure is invalid.')
  }
  return structure
}

/**
 * Lists the Team memberships whose Team is not one of the Workspace's Teams.
 *
 * @param teamAssignments - Requested memberships.
 * @param teamIds - Teams of the Workspace, archived ones included.
 * @returns Team identifiers that do not exist.
 */
export function listUnknownOrgStructureTeamIds(
  teamAssignments: readonly OrgUnitTeamAssignment[],
  teamIds: ReadonlySet<string>,
): string[] {
  return teamAssignments
    .filter((assignment) => !teamIds.has(assignment.teamId))
    .map((assignment) => assignment.teamId)
}

/**
 * Creates the validation error of a refused structure.
 *
 * @param issue - First issue found.
 * @returns The error answered with status 400.
 */
function invalidOrgStructure(issue: OrgStructureIssue) {
  return new ProjectDataError(400, 'InvalidOrgStructure', `The OrgUnit structure is invalid: ${issue}.`)
}
