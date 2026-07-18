import { describe, expect, test } from 'bun:test'
import {
  canMutateWorkspaceContent,
  type CurrentUser,
} from '../src/auth/api'

const activeMember: CurrentUser = {
  attributes: {},
  groups: [],
  isSystemAdmin: false,
  username: 'member',
  workspaceMemberStatus: 'active',
  workspaceRole: 'member',
}

describe('Workspace content capability', () => {
  test('allows active owners and members to create initial content', () => {
    expect(canMutateWorkspaceContent(activeMember)).toBe(true)
    expect(canMutateWorkspaceContent({
      ...activeMember,
      workspaceRole: 'owner',
    })).toBe(true)
  })

  test('denies guests and deactivated memberships', () => {
    expect(canMutateWorkspaceContent({
      ...activeMember,
      workspaceRole: 'guest',
    })).toBe(false)
    expect(canMutateWorkspaceContent({
      ...activeMember,
      workspaceMemberStatus: 'deactivated',
    })).toBe(false)
  })
})
