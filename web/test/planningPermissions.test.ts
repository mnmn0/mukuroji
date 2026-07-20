import { describe, expect, test } from 'bun:test'
import type { PlanningEntity, PlanningWorkItemSummary } from '@mukuroji/contracts'
import type { CurrentUser } from '../src/auth/api'
import {
  canLinkPlanningEntity,
  canManageAnyPlanningScope,
  canManagePlanningScope,
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
})
