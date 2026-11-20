import { createDataMigrationLambdaDependencies } from '../app/composition/data-migration'
import { createLazySingleton } from '../app/composition/lazy-singleton'
import {
  handleDataMigrationInvocation,
  type DataMigrationInvocationResponse,
} from '../modules/data-migration'

/** Subset of the Lambda context the handler reads. */
export type DataMigrationLambdaContext = {
  /** Lambda request identifier. */
  readonly awsRequestId: string
  /** Name of the invoked function. */
  readonly functionName: string
  /** ARN of the invoked function, which names the account. */
  readonly invokedFunctionArn: string
  /**
   * Returns the milliseconds left before the function times out.
   *
   * @returns Remaining time.
   */
  readonly getRemainingTimeInMillis: () => number
}

/** Dependencies built once per execution environment. */
const getDependencies = createLazySingleton(() => createDataMigrationLambdaDependencies())

/**
 * Operator-invoked entrypoint of the data migration Lambda. It is never
 * scheduled; an operator invokes it with `bun run data:migrate:aws`.
 *
 * @param event - Invocation payload.
 * @param context - Lambda context.
 * @returns A content-free response.
 */
export async function handler(
  event: unknown,
  context: DataMigrationLambdaContext,
): Promise<DataMigrationInvocationResponse> {
  return await handleDataMigrationInvocation(
    event,
    {
      requestId: context.awsRequestId,
      functionName: context.functionName,
      accountId: context.invokedFunctionArn.split(':')[4] ?? '',
      remainingMilliseconds: context.getRemainingTimeInMillis(),
    },
    getDependencies(),
  )
}
