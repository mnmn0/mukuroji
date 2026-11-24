import { expect, test } from 'bun:test'
import type { WorkspaceMember, WorkspaceMemberCredentialProgress } from '../workspace-access'
import {
  changeMemberSystemAdministrator,
  type MemberSystemAdministratorPorts,
} from './member-system-administrator'

const workspaceId = 'workspace-1'

/** Active member the ports return. */
const member: WorkspaceMember = {
  id: 'member-1',
  memberKey: 'sato@example.com',
  email: 'sato@example.com',
  role: 'member',
  status: 'active',
  version: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
}

/**
 * Creates ports that log each step.
 *
 * @param progress - Progress the store reports for the idempotency key.
 * @param overrides - Ports the test replaces.
 * @returns The ports and the step log.
 */
function createPorts(
  progress: WorkspaceMemberCredentialProgress,
  overrides: Partial<MemberSystemAdministratorPorts> = {},
) {
  const steps: string[] = []
  const ports: MemberSystemAdministratorPorts = {
    getActiveMember: async () => member,
    isAccountInWorkspace: async () => {
      steps.push('directory')
      return true
    },
    isSystemAdministrator: async () => {
      steps.push('read-group')
      return false
    },
    readActionProgress: async () => progress,
    recordAction: async (_workspaceId, _actor, _memberKey, _action, _auditContext, options) => {
      steps.push(options?.completed ? 'record-completed' : 'record')
      return { completed: options?.completed === true }
    },
    markActionApplying: async () => {
      steps.push('applying')
    },
    completeAction: async () => {
      steps.push('complete')
    },
    addSystemAdministrator: async () => {
      steps.push('add')
    },
    removeSystemAdministrator: async () => {
      steps.push('remove')
    },
    reportFailure: () => {
      steps.push('report')
    },
    ...overrides,
  }
  return { ports, steps }
}

const input = {
  workspaceId,
  actorMemberKey: 'owner@example.com',
  memberKey: 'sato@example.com',
  systemAdministrator: true,
}

test('records, marks, changes, and completes a grant in that order', async () => {
  const { ports, steps } = createPorts('none')

  const result = await changeMemberSystemAdministrator(ports, input)

  expect(result).toEqual({ systemAdministrator: true })
  expect(steps).toEqual(['directory', 'read-group', 'record', 'applying', 'add', 'complete'])
})

test('records a request for the current state as completed in one write, so no retry can resume it', async () => {
  const { ports, steps } = createPorts('none', {
    isSystemAdministrator: async () => {
      steps.push('read-group')
      return true
    },
  })

  const result = await changeMemberSystemAdministrator(ports, input)

  expect(result).toEqual({ systemAdministrator: true })
  expect(steps).toEqual(['directory', 'read-group', 'record-completed'])
})

test('does not change the group again for a replay of a completed change', async () => {
  const { ports, steps } = createPorts('completed')

  const result = await changeMemberSystemAdministrator(ports, input)

  expect(result.systemAdministrator).toBe(true)
  expect(steps).toEqual([])
})

test('resumes a recorded change without re-reading the group, so a replay finishes it', async () => {
  const { ports, steps } = createPorts('recorded')

  await changeMemberSystemAdministrator(ports, { ...input, systemAdministrator: false })

  expect(steps).toEqual(['directory', 'record', 'applying', 'remove', 'complete'])
})

test('checks the sign-in account again before resuming a recorded change', async () => {
  const { ports, steps } = createPorts('recorded', {
    isAccountInWorkspace: async () => {
      steps.push('directory')
      return false
    },
  })

  await expect(changeMemberSystemAdministrator(ports, input)).rejects.toMatchObject({
    status: 409,
    code: 'MemberSystemAdministratorUnavailable',
  })
  expect(steps).toEqual(['directory'])
})

test('reports a failed completion mark without failing the finished change', async () => {
  const { ports, steps } = createPorts('none', {
    completeAction: async () => {
      throw new Error('store unavailable')
    },
  })

  const result = await changeMemberSystemAdministrator(ports, input)

  expect(result.systemAdministrator).toBe(true)
  expect(steps.at(-1)).toBe('report')
})

test('refuses a member who is not active', async () => {
  const { ports, steps } = createPorts('none', { getActiveMember: async () => undefined })

  await expect(changeMemberSystemAdministrator(ports, input)).rejects.toMatchObject({
    status: 404,
    code: 'WorkspaceMemberNotFound',
  })
  expect(steps).toEqual([])
})
