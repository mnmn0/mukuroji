import { type DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import {
  createTriageWakeIndexRepairItem,
  type CreateTriageWakeIndexRepairItemInput,
} from './triage-transactions'

/** Outcome of one wake-index repair attempt. */
export type TriageWakeIndexRepairOutcome = 'current' | 'repaired' | 'conflict'

/** Rewrites a stale wake-index position with a revision-conditional update (#484).
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
  if (!item?.Update) return 'current'
  try {
    await documentClient.send(new UpdateCommand(item.Update))
    return 'repaired'
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return 'conflict'
    }
    throw error
  }
}
