import { describe, expect, test } from 'bun:test'
import {
  createWorkspaceAccessMutationSession,
  getBulkInvitationRunner,
} from '../src/workspace/mutations/workspaceAccessMutationSession'

describe('getBulkInvitationRunner', () => {
  test('keeps a lost bulk invitation key across other mutations and snapshot refreshes', async () => {
    const session = createWorkspaceAccessMutationSession('token-1')
    const keys: string[] = []
    const invite = () => getBulkInvitationRunner('owner@example.com').run(
      'workspace-invitation:create:sato@example.com',
      'fingerprint',
      async (context) => {
        keys.push(context.idempotencyKey)
        if (keys.length === 1) throw new TypeError('Failed to fetch')
      },
      (error) => error instanceof TypeError,
    )

    await expect(invite()).rejects.toThrow('Failed to fetch')
    // Another invitation succeeds before the retry, and its snapshot refresh discards the
    // session runner's retained contexts.
    await session.requestRunner.run('workspace-invitation:create', 'other', async () => undefined)
    session.requestRunner.discardRetainedContexts()
    await invite()

    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(keys[0])
  })

  test('gives each administrator their own runner', () => {
    expect(getBulkInvitationRunner('owner@example.com')).toBe(getBulkInvitationRunner('owner@example.com'))
    expect(getBulkInvitationRunner('admin@example.com')).not.toBe(getBulkInvitationRunner('owner@example.com'))
  })
})
