import { type DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import {
  createTriageWakeIndexRepairItem,
  type CreateTriageWakeIndexRepairItemInput,
} from './triage-transactions'

/** Outcome of one wake-index repair attempt. */
export type TriageWakeIndexRepairOutcome = 'current' | 'repaired' | 'conflict'

/** Rewrites a stale wake-index position with a revision-conditional update (#484).
 *
 * The write goes through TransactWriteItems because the schedule role may only update the
 * Request Intake table inside a transaction.
 *
 * @param documentClient Request Intake DocumentClient.
 * @param input The entry, its stored row, and the table settings.
 * @returns Whether the index was already current, rewritten, or lost a revision race.
 */
export async function repairTriageWakeIndex(
  documentClient: Pick<DynamoDBDocumentClient, 'send'>,
  input: CreateTriageWakeIndexRepairItemInput,
): Promise<TriageWakeIndexRepairOutcome> {
  const item = createTriageWakeIndexRepairItem(input)
  if (!item) return 'current'
  try {
    await documentClient.send(new TransactWriteCommand({ TransactItems: [item] }))
    return 'repaired'
  } catch (error) {
    if (isConditionalCancellation(error)) return 'conflict'
    throw error
  }
}

/** Detects a transaction cancelled only by the item's revision condition. */
function isConditionalCancellation(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') return false
  const reasons: unknown = Reflect.get(error, 'CancellationReasons')
  if (!Array.isArray(reasons) || reasons.length !== 1) return false
  const reason: unknown = reasons[0]
  return typeof reason === 'object' && reason !== null &&
    Reflect.get(reason, 'Code') === 'ConditionalCheckFailed'
}
