import { expect, test } from 'bun:test'
import {
  listOrgUnitSubtreeIds,
  listOrgUnitTeamIds,
  ORG_UNIT_MAX_DEPTH,
  parseOrgStructure,
  resolveOrgUnitPath,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../project-data-error'
import {
  listUnknownOrgStructureTeamIds,
  readReplaceOrgStructureCommand,
  readStoredOrgStructure,
} from './org-structure'

/**
 * Reads a command and returns the issue code of its 400 error.
 *
 * @param value - Request body.
 * @returns The error message, which names the issue.
 */
function readIssue(value: unknown): string {
  try {
    readReplaceOrgStructureCommand(value)
  } catch (error) {
    if (error instanceof ProjectDataError && error.status === 400) return error.message
    throw error
  }
  throw new Error('Expected the command to be refused.')
}

test('orders OrgUnits parents first and trims names', () => {
  expect(readReplaceOrgStructureCommand({
    expectedRevision: 2,
    orgUnits: [
      { id: 'east', name: ' East ', parentId: 'sales' },
      { id: 'sales', name: 'Sales' },
    ],
    teamAssignments: [{ teamId: 'team-1', orgUnitId: 'east' }],
  })).toEqual({
    expectedRevision: 2,
    orgUnits: [
      { id: 'sales', name: 'Sales' },
      { id: 'east', name: 'East', parentId: 'sales' },
    ],
    teamAssignments: [{ teamId: 'team-1', orgUnitId: 'east' }],
  })
})

test('refuses cycles, unknown parents, duplicates, deep trees, and Teams in two OrgUnits', () => {
  const base = { expectedRevision: 0, teamAssignments: [] }
  expect(readIssue({ ...base, orgUnits: [{ id: 'a', name: 'A', parentId: 'a' }] })).toContain('cycle')
  expect(readIssue({
    ...base,
    orgUnits: [{ id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }],
  })).toContain('cycle')
  expect(readIssue({ ...base, orgUnits: [{ id: 'a', name: 'A', parentId: 'missing' }] }))
    .toContain('unknown-parent')
  expect(readIssue({ ...base, orgUnits: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] }))
    .toContain('duplicate-org-unit-id')
  expect(readIssue({ ...base, orgUnits: [{ id: 'a b', name: 'A' }] })).toContain('invalid-org-unit-id')
  expect(readIssue({ ...base, orgUnits: [{ id: 'a', name: '  ' }] })).toContain('invalid-org-unit-name')
  const chain = Array.from({ length: ORG_UNIT_MAX_DEPTH + 1 }, (_, index) => ({
    id: `level-${index}`,
    name: `Level ${index}`,
    ...(index === 0 ? {} : { parentId: `level-${index - 1}` }),
  }))
  expect(readIssue({ ...base, orgUnits: chain })).toContain('too-deep')
  expect(() => readReplaceOrgStructureCommand({ ...base, orgUnits: chain.slice(0, ORG_UNIT_MAX_DEPTH) }))
    .not.toThrow()
  expect(readIssue({
    expectedRevision: 0,
    orgUnits: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    teamAssignments: [{ teamId: 't', orgUnitId: 'a' }, { teamId: 't', orgUnitId: 'b' }],
  })).toContain('duplicate-team')
  expect(readIssue({
    expectedRevision: 0,
    orgUnits: [{ id: 'a', name: 'A' }],
    teamAssignments: [{ teamId: 't', orgUnitId: 'missing' }],
  })).toContain('unknown-org-unit')
  expect(readIssue({ expectedRevision: -1, orgUnits: [], teamAssignments: [] })).toContain('invalid-shape')
  expect(readIssue([])).toContain('invalid-shape')
})

test('lists the subtree, its Teams, and the display path of an OrgUnit', () => {
  const structure = {
    orgUnits: [
      { id: 'sales', name: 'Sales' },
      { id: 'east', name: 'East', parentId: 'sales' },
      { id: 'tokyo', name: 'Tokyo', parentId: 'east' },
      { id: 'engineering', name: 'Engineering' },
    ],
    teamAssignments: [
      { teamId: 'tokyo-team', orgUnitId: 'tokyo' },
      { teamId: 'sales-team', orgUnitId: 'sales' },
      { teamId: 'platform', orgUnitId: 'engineering' },
    ],
  }
  expect(listOrgUnitSubtreeIds(structure.orgUnits, 'east').sort()).toEqual(['east', 'tokyo'])
  expect(listOrgUnitSubtreeIds(structure.orgUnits, 'missing')).toEqual([])
  expect(listOrgUnitTeamIds(structure, 'sales')).toEqual(['tokyo-team', 'sales-team'])
  expect(listOrgUnitTeamIds(structure, 'east')).toEqual(['tokyo-team'])
  expect(resolveOrgUnitPath(structure.orgUnits, 'tokyo').map((orgUnit) => orgUnit.name))
    .toEqual(['Sales', 'East', 'Tokyo'])
})

test('fails closed on a malformed stored structure', () => {
  const stored = {
    orgUnits: [{ id: 'a', name: 'A' }],
    teamAssignments: [{ teamId: 't', orgUnitId: 'a' }],
    revision: 3,
    updatedAt: '2026-11-20T00:00:00.000Z',
  }
  expect(readStoredOrgStructure(stored)).toEqual(stored)
  expect(parseOrgStructure({ ...stored, revision: '3' })).toBeUndefined()
  expect(() => readStoredOrgStructure({ ...stored, revision: 0 })).toThrow(ProjectDataError)
  expect(() => readStoredOrgStructure({ ...stored, orgUnits: [{ id: 'a', name: 'A', parentId: 'a' }] }))
    .toThrow(ProjectDataError)
  // Every save writes a canonical UTC time, so a row without one or with another form is broken.
  const { updatedAt: _updatedAt, ...withoutUpdatedAt } = stored
  expect(() => readStoredOrgStructure(withoutUpdatedAt)).toThrow(ProjectDataError)
  expect(() => readStoredOrgStructure({ ...stored, updatedAt: '2026-11-20' })).toThrow(ProjectDataError)
  expect(() => readStoredOrgStructure({ ...stored, updatedAt: '2026-11-20T09:00:00+09:00' }))
    .toThrow(ProjectDataError)
})

test('names Team memberships whose Team does not exist', () => {
  expect(listUnknownOrgStructureTeamIds(
    [{ teamId: 'known', orgUnitId: 'a' }, { teamId: 'gone', orgUnitId: 'a' }],
    new Set(['known']),
  )).toEqual(['gone'])
})
