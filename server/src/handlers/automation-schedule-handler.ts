import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  createAutomationActionExecutor,
  createProductionAppDependencies,
  runWithAppDependencies,
} from '../app/createApp'
import {
  DynamoDbAutomationClient,
} from '../modules/automation/automation'
import {
  SecretsManagerAutomationInboundWebhookSecretStore,
} from '../modules/automation/automation-inbound-webhook'
import {
  processAutomationSchedule,
  resolveAutomationScheduleProcessingTime,
  type AutomationScheduleEvent,
} from '../modules/automation/adapter-in/schedules/automation-schedule'

const dynamoDbClient = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' })
const documentClient = DynamoDBDocumentClient.from(dynamoDbClient, {
  marshallOptions: { removeUndefinedValues: true },
})
const automationClient = new DynamoDbAutomationClient(
  process.env.AUTOMATION_TABLE_NAME ?? 'mukuroji-automation',
  documentClient,
  dynamoDbClient,
)
const inboundWebhookSecrets = new SecretsManagerAutomationInboundWebhookSecretStore()

/** Due automation work を timezone/DST policy に従って materialize します。 */
export async function handler(event: AutomationScheduleEvent = {}) {
  const dependencies = createProductionAppDependencies()
  return await runWithAppDependencies(
    dependencies,
    () =>
      processAutomationSchedule(
        resolveAutomationScheduleProcessingTime(event),
        {
          client: automationClient,
          actionExecutor: createAutomationActionExecutor(),
          inboundWebhookSecrets,
        },
      ),
  )
}

export * from '../modules/automation/adapter-in/schedules/automation-schedule'
