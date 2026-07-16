import type {
  MutationRequestContext,
  MutationRequestRunner,
} from '../api/mutationHeaders'

/** HTTP mutation と refresh を同じ logical mutation として実行します。 */
export function runAutomationManagementMutation<TResult>(
  runner: MutationRequestRunner,
  operationKey: string,
  fingerprint: string,
  request: (context: MutationRequestContext) => Promise<TResult>,
  refresh: () => Promise<unknown>,
  reportError: (error: unknown) => void,
) {
  return runner.run(operationKey, fingerprint, async (context) => {
    try {
      const result = await request(context)
      await refresh()
      return result
    } catch (error) {
      reportError(error)
      throw error
    }
  })
}
