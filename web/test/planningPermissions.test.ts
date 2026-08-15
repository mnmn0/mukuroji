import { describe, expect, test } from 'bun:test'
import type {
  PlanningEntity,
  PlanningUpdateTarget,
  PlanningUpdateTargetSummary,
  PlanningWorkItemSummary,
} from '@mukuroji/contracts'
import type { CurrentUser } from '../src/auth/api'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import {
  canAnnotatePlanningUpdateTarget,
  canLinkPlanningEntity,
  canManageAnyPlanningScope,
  canManagePlanningScope,
  canPublishPlanningUpdateTarget,
  canUpdatePlanningEntityStatus,
  canUpdatePlanningWorkItemLink,
  createPlanningAccessSnapshot,
  filterManageablePlanningScopeTeams,
} from '../src/planning/model/permissions'

const memberUser: CurrentUser = {
  username: 'member@example.com',
  attributes: { email: 'member@example.com' },
  groups: [],
  isSystemAdmin: false,
  workspaceRole: 'member',
  workspaceMemberStatus: 'active',
}
const scopedEntity = {
  teamId: 'team-1',
  projectId: 'project-1',
} as PlanningEntity
const workspaceEntity = {} as PlanningEntity
const scopedWorkItem = {
  teamId: 'team-1',
  projectId: 'project-1',
} as PlanningWorkItemSummary
const teams = [{
  id: 'team-1',
  name: 'Team 1',
  projects: [
    { id: 'project-1', name: 'Project 1' },
    { id: 'project-2', name: 'Project 2' },
  ],
}]

describe('planning permissions', () => {
  test('allows a workspace member with a project manager role to manage scoped plans', () => {
    const access = createPlanningAccessSnapshot(teams, { 'project-1': 'manager' })

    expect(canManageAnyPlanningScope(memberUser, access)).toBe(true)
    expect(canManagePlanningScope(memberUser, scopedEntity, access)).toBe(true)
    expect(canUpdatePlanningEntityStatus(memberUser, scopedEntity, access)).toBe(true)
    expect(canUpdatePlanningWorkItemLink(memberUser, scopedWorkItem, access)).toBe(true)
  })

  test('allows project members to post scoped updates but not structural or workspace-scoped updates', () => {
    const access = createPlanningAccessSnapshot(teams, { 'project-1': 'member' })

    expect(canManageAnyPlanningScope(memberUser, access)).toBe(false)
    expect(canManagePlanningScope(memberUser, scopedEntity, access)).toBe(false)
    expect(canUpdatePlanningEntityStatus(memberUser, scopedEntity, access)).toBe(true)
    expect(canUpdatePlanningEntityStatus(memberUser, workspaceEntity, access)).toBe(false)
    expect(canLinkPlanningEntity(memberUser, workspaceEntity, access)).toBe(true)
  })

  test('keeps workspace administration and project roles as separate scoped requirements', () => {
    const adminUser: CurrentUser = { ...memberUser, workspaceRole: 'admin' }
    const access = createPlanningAccessSnapshot(teams, {})

    expect(canManagePlanningScope(adminUser, workspaceEntity, access)).toBe(true)
    expect(canUpdatePlanningEntityStatus(adminUser, workspaceEntity, access)).toBe(true)
    expect(canManagePlanningScope(adminUser, scopedEntity, access)).toBe(false)
    expect(canUpdatePlanningEntityStatus(adminUser, scopedEntity, access)).toBe(false)
  })

  test('only exposes Team and Project create scopes managed by the current user', () => {
    const directory = [
      ...teams,
      {
        id: 'team-2',
        name: 'Team 2',
        projects: [{ id: 'project-3', name: 'Project 3' }],
      },
    ]
    const access = createPlanningAccessSnapshot(directory, {
      'project-1': 'manager',
      'project-2': 'viewer',
      'project-3': 'member',
    })

    expect(filterManageablePlanningScopeTeams(memberUser, directory, access)).toEqual([{
      ...teams[0],
      projects: [{ id: 'project-1', name: 'Project 1' }],
    }])
  })

  test('limits configured update publishing to the cadence owner or a manager override', () => {
    const target = {
      type: 'project',
      teamId: 'team-1',
      projectId: 'project-1',
    } satisfies PlanningUpdateTarget
    const updateTargets = [{
      target,
      cadence: {
        updateOwnerMemberKey: 'member@example.com',
        cadence: { unit: 'week', count: 1 },
        timeZone: 'UTC',
        nextDueAt: '2026-08-10T09:00:00.000Z',
        reminderHoursBefore: 24,
      },
      updateState: 'current',
      latestVersion: 0,
      updatedAt: '2026-08-09T09:00:00.000Z',
    }] satisfies PlanningUpdateTargetSummary[]
    const memberAccess = createPlanningAccessSnapshot(teams, { 'project-1': 'member' })
    const anotherMember = {
      ...memberUser,
      attributes: { email: 'another@example.com' },
      username: 'another@example.com',
    }

    expect(canPublishPlanningUpdateTarget(
      memberUser,
      target,
      [],
      updateTargets,
      memberAccess,
    )).toBe(true)
    expect(canPublishPlanningUpdateTarget(
      anotherMember,
      target,
      [],
      updateTargets,
      memberAccess,
    )).toBe(false)
    expect(canPublishPlanningUpdateTarget(
      anotherMember,
      target,
      [],
      updateTargets,
      createPlanningAccessSnapshot(teams, { 'project-1': 'manager' }),
    )).toBe(true)
    expect(canPublishPlanningUpdateTarget(
      memberUser,
      target,
      [],
      [],
      memberAccess,
    )).toBe(false)
    expect(canPublishPlanningUpdateTarget(
      anotherMember,
      target,
      [],
      [],
      createPlanningAccessSnapshot(teams, { 'project-1': 'manager' }),
    )).toBe(false)
  })

  test('allows a workspace-scope Initiative owner or manager override after cadence setup', () => {
    const sourceInitiative = planningSnapshotFixture.entities.find(
      (candidate) => candidate.id === 'initiative-onboarding',
    )
    if (!sourceInitiative) throw new Error('Planning Initiative fixture is required.')
    const initiative = {
      ...sourceInitiative,
      id: 'workspace-initiative',
      projectId: undefined,
      teamId: undefined,
    }
    const target = {
      type: 'initiative',
      entityId: initiative.id,
    } satisfies PlanningUpdateTarget
    const updateTargets = [{
      target,
      cadence: {
        updateOwnerMemberKey: 'member@example.com',
        cadence: { unit: 'month', count: 1 },
        timeZone: 'UTC',
        nextDueAt: '2026-09-01T09:00:00.000Z',
        reminderHoursBefore: 24,
      },
      updateState: 'current',
      latestVersion: 0,
      updatedAt: '2026-08-09T09:00:00.000Z',
    }] satisfies PlanningUpdateTargetSummary[]
    const anotherMember = {
      ...memberUser,
      attributes: { email: 'another@example.com' },
      username: 'another@example.com',
    }

    expect(canPublishPlanningUpdateTarget(
      memberUser,
      target,
      [initiative],
      updateTargets,
      createPlanningAccessSnapshot(teams, {}),
    )).toBe(true)
    expect(canPublishPlanningUpdateTarget(
      anotherMember,
      target,
      [initiative],
      updateTargets,
      createPlanningAccessSnapshot(teams, {}),
    )).toBe(false)
    expect(canPublishPlanningUpdateTarget(
      { ...anotherMember, workspaceRole: 'admin' },
      target,
      [initiative],
      updateTargets,
      createPlanningAccessSnapshot(teams, {}),
    )).toBe(true)
  })

  test('allows update annotations only for a member of the current target scope', () => {
    const projectTarget = {
      type: 'project',
      teamId: 'team-1',
      projectId: 'project-1',
    } satisfies PlanningUpdateTarget
    const initiative = planningSnapshotFixture.entities.find(
      (candidate) => candidate.id === 'initiative-onboarding',
    )
    if (!initiative) throw new Error('Planning Initiative fixture is required.')
    const scopedInitiative = {
      ...initiative,
      id: 'initiative-1',
      projectId: 'project-1',
      teamId: 'team-1',
    }
    const workspaceInitiative = {
      ...initiative,
      id: 'workspace-initiative',
      projectId: undefined,
      teamId: undefined,
    }

    expect(canAnnotatePlanningUpdateTarget(
      memberUser,
      projectTarget,
      [],
      createPlanningAccessSnapshot(teams, { 'project-1': 'viewer' }),
    )).toBe(false)
    expect(canAnnotatePlanningUpdateTarget(
      memberUser,
      projectTarget,
      [],
      createPlanningAccessSnapshot(teams, { 'project-1': 'member' }),
    )).toBe(true)
    expect(canAnnotatePlanningUpdateTarget(
      memberUser,
      { type: 'initiative', entityId: scopedInitiative.id },
      [scopedInitiative],
      createPlanningAccessSnapshot(teams, { 'project-1': 'member' }),
    )).toBe(true)
    expect(canAnnotatePlanningUpdateTarget(
      memberUser,
      { type: 'initiative', entityId: workspaceInitiative.id },
      [workspaceInitiative],
      createPlanningAccessSnapshot(teams, {}),
    )).toBe(true)
    expect(canAnnotatePlanningUpdateTarget(
      { ...memberUser, workspaceRole: 'guest' },
      { type: 'initiative', entityId: workspaceInitiative.id },
      [workspaceInitiative],
      createPlanningAccessSnapshot(teams, {}),
    )).toBe(false)
  })

  test('fails closed when an unqualified Project role matches IDs under multiple Teams', () => {
    const duplicateDirectory = [
      teams[0]!,
      {
        id: 'team-2',
        name: 'Team 2',
        projects: [{ id: 'project-1', name: 'Duplicate Project 1' }],
      },
    ]
    const access = createPlanningAccessSnapshot(duplicateDirectory, {
      'project-1': 'manager',
    })

    expect(access.ambiguousProjectIds.has('project-1')).toBe(true)
    expect(canManageAnyPlanningScope(memberUser, access)).toBe(false)
    expect(canManagePlanningScope(memberUser, {
      projectId: 'project-1',
      teamId: 'team-1',
    }, access)).toBe(false)
    expect(canManagePlanningScope(memberUser, {
      projectId: 'project-1',
      teamId: 'team-2',
    }, access)).toBe(false)
    expect(canAnnotatePlanningUpdateTarget(
      memberUser,
      { type: 'project', projectId: 'project-1', teamId: 'team-1' },
      [],
      access,
    )).toBe(false)
    expect(canManagePlanningScope(
      { ...memberUser, isSystemAdmin: true },
      { projectId: 'project-1', teamId: 'team-2' },
      access,
    )).toBe(true)
  })
})
