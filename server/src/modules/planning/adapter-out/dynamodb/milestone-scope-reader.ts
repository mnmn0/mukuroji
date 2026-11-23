import { GetCommand } from '@aws-sdk/lib-dynamodb'

/** Team and Project a current Milestone sits in. */
export type PlanningMilestoneScope = {
  /** Team of the Milestone, when it is Team or Project scoped. */
  teamId?: string
  /** Project of the Milestone, when it is Project scoped. */
  projectId?: string
}

/** Strong reader of one Milestone's current scope. */
export type PlanningMilestoneScopeReader = {
  /**
   * Reads one Planning entity and returns its scope while it is an unarchived Milestone.
   *
   * @param workspaceId - Canonical Workspace ID.
   * @param entityId - Planning entity ID.
   * @returns The scope, or undefined when the entity is gone, archived, not a Milestone, or a
   * Project-scoped row without its Team.
   * @throws When the stored row does not belong to the requested key.
   */
  readCurrentMilestoneScope(workspaceId: string, entityId: string): Promise<PlanningMilestoneScope | undefined>
}

/** Options of {@link createDynamoDbPlanningMilestoneScopeReader}. */
export type DynamoDbPlanningMilestoneScopeReaderOptions = {
  /** DocumentClient used for the strongly consistent read. */
  documentClient: {
    /** Sends one GetItem. */
    send(command: GetCommand): Promise<{ Item?: Record<string, unknown> }>
  }
  /** Planning table name. */
  planningTableName: string
}

const ENTITY_RECORD_PREFIX = 'ENTITY#'

/**
 * Creates the Milestone scope reader over the Planning table.
 *
 * @param options - DocumentClient and Planning table name.
 * @returns Reader that strongly reads one entity row.
 */
export function createDynamoDbPlanningMilestoneScopeReader(
  options: DynamoDbPlanningMilestoneScopeReaderOptions,
): PlanningMilestoneScopeReader {
  return {
    async readCurrentMilestoneScope(workspaceId, entityId) {
      const recordKey = `${ENTITY_RECORD_PREFIX}${encodeURIComponent(entityId)}`
      const { Item: row } = await options.documentClient.send(new GetCommand({
        TableName: options.planningTableName,
        Key: { workspaceId, recordKey },
        ConsistentRead: true,
      }))
      if (!row) return undefined
      if (
        row.workspaceId !== workspaceId ||
        row.recordKey !== recordKey ||
        row.entryType !== 'planning-entity' ||
        row.id !== entityId
      ) {
        throw new Error('Planning Milestone row is invalid.')
      }
      if (row.type !== 'milestone' || row.archivedAt !== undefined) return undefined
      const teamId = readOptionalScopeId(row.teamId, 'Team')
      const projectId = readOptionalScopeId(row.projectId, 'Project')
      if (projectId !== undefined && teamId === undefined) return undefined
      return {
        ...(teamId === undefined ? {} : { teamId }),
        ...(projectId === undefined ? {} : { projectId }),
      }
    },
  }
}

/**
 * Reads an optional Team or Project ID of a stored row.
 *
 * @param value - Stored attribute.
 * @param label - Scope name used in the error.
 * @returns The ID, or undefined when absent.
 * @throws When the attribute is present but not a non-empty string.
 */
function readOptionalScopeId(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Planning Milestone ${label} scope is invalid.`)
  }
  return value
}
