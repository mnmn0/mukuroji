import { expect, test } from 'bun:test'
import type { PlanningViewerTeamGrant } from '@mukuroji/contracts'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import { keepViewerTeamGrants } from '../src/planning/queries/usePlanningSnapshot'

test('keeps the cached viewer Team grants when a mutation snapshot has none', () => {
  const grants: PlanningViewerTeamGrant[] = [{ teamId: 'core', role: 'member' }]
  const cached = { ...planningSnapshotFixture, viewerTeamGrants: grants }
  expect(keepViewerTeamGrants(planningSnapshotFixture, cached).viewerTeamGrants).toEqual(grants)
  expect(keepViewerTeamGrants({ ...planningSnapshotFixture, viewerTeamGrants: [] }, cached).viewerTeamGrants).toEqual([])
  expect(keepViewerTeamGrants(planningSnapshotFixture, undefined)).toBe(planningSnapshotFixture)
})
