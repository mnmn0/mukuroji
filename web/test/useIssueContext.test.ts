import { expect, test } from 'bun:test'
import { refreshAuxiliaryContextQuery } from '../src/issues/mutations/useIssueContext'

test('keeps a committed context mutation successful when auxiliary revalidation fails', async () => {
  const originalConsoleError = console.error
  console.error = () => undefined

  try {
    await expect(
      refreshAuxiliaryContextQuery('accepted-resolution history', async () => {
        throw new Error('transient history failure')
      }),
    ).resolves.toBeUndefined()
  } finally {
    console.error = originalConsoleError
  }
})
