import { expect, test } from 'bun:test'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import { readWorkspaceMemberNamesForDisplay } from './workspace-access'

/**
 * Builds an error shaped like one the AWS SDK throws.
 *
 * @param name - SDK error name.
 * @returns The error.
 */
function createAwsError(name: string) {
  const error = new Error(`${name} from DynamoDB`)
  error.name = name
  return error
}

test('falls back only when the member name read fails for a transient reason', async () => {
  const names = new Map([['sato@example.com', '佐藤']])
  await expect(readWorkspaceMemberNamesForDisplay('workspace-1', async () => names)).resolves.toBe(names)

  for (const name of ['ProvisionedThroughputExceededException', 'ThrottlingException', 'TimeoutError']) {
    await expect(readWorkspaceMemberNamesForDisplay('workspace-1', async () => {
      throw createAwsError(name)
    })).resolves.toBeUndefined()
  }
  await expect(readWorkspaceMemberNamesForDisplay('workspace-1', async () => {
    throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
  })).resolves.toBeUndefined()

  // Denied access and invalid stored rows will not pass on their own, so they are not hidden.
  await expect(readWorkspaceMemberNamesForDisplay('workspace-1', async () => {
    throw createAwsError('AccessDeniedException')
  })).rejects.toMatchObject({ name: 'AccessDeniedException' })
  await expect(readWorkspaceMemberNamesForDisplay('workspace-1', async () => {
    throw new WorkspaceAccessError(503, 'InvalidWorkspaceAccessData', 'Workspace access data is invalid.')
  })).rejects.toMatchObject({ code: 'InvalidWorkspaceAccessData' })
})
