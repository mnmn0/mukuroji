import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  createAutomationActionExecutor,
  createProductionAppDependencies,
  DynamoDbTeamIssuesClient,
  runWithAppDependencies,
} from '../app/createApp'
import {
  AutomationEngine,
  DynamoDbAutomationClient,
} from '../modules/automation/automation'
import {
  createAutomationEventProcessor,
  processAutomationEventBatch,
  type BatchResponse,
  type DynamoStreamEvent,
} from '../modules/automation/adapter-in/events/automation-event'

const dynamoDbClient = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' })
const documentClient = DynamoDBDocumentClient.from(dynamoDbClient, {
  marshallOptions: { removeUndefinedValues: true },
})
const automationClient = new DynamoDbAutomationClient(
  process.env.AUTOMATION_TABLE_NAME ?? 'mukuroji-automation',
  documentClient,
  dynamoDbClient,
)
const automationEventProcessor = createAutomationEventProcessor(
  automationClient,
  new AutomationEngine(automationClient, createAutomationActionExecutor()),
  new DynamoDbTeamIssuesClient(),
)

/** AuditEvents stream を version 固定 automation execution へ配送します。 */
export async function handler(event: DynamoStreamEvent): Promise<BatchResponse> {
  const dependencies = createProductionAppDependencies()
  return await runWithAppDependencies(
    dependencies,
    () => processAutomationEventBatch(event, automationEventProcessor),
  )
}

export * from '../modules/automation/adapter-in/events/automation-event'
