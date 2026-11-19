import {
  createDynamoDbClient,
  createDynamoDbDocumentClient,
} from '../../infrastructure/aws/dynamodb-client'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import { createCycleScheduleHandler } from '../../modules/planning/adapter-in/schedules/cycle-schedule'
import { createDynamoDbCycleScheduleSource } from '../../modules/planning/adapter-out/dynamodb/cycle-schedule-source'
import { createPlanningClient } from './api-dependencies'

/**
 * Creates the production Cycle automation schedule handler.
 *
 * @returns A handler that creates next Cycles and carries over unfinished Work Items.
 */
export function createProductionCycleScheduleHandler() {
  const environment = loadServerConfig().environment
  const planningTableName = environment.PLANNING_TABLE_NAME?.trim()
  const workItemsTableName = environment.WORK_ITEMS_TABLE_NAME?.trim()
  if (!planningTableName) throw new Error('PLANNING_TABLE_NAME is required.')
  if (!workItemsTableName) throw new Error('WORK_ITEMS_TABLE_NAME is required.')
  return createCycleScheduleHandler({
    source: createDynamoDbCycleScheduleSource({
      documentClient: createDynamoDbDocumentClient(createDynamoDbClient()),
      planningTableName,
      workItemsTableName,
      ...(environment.PLANNING_UPDATE_SCHEDULE_INDEX_NAME?.trim()
        ? { indexName: environment.PLANNING_UPDATE_SCHEDULE_INDEX_NAME.trim() }
        : {}),
    }),
    planning: createPlanningClient(),
  })
}
