import { workItemImportHandler as appWorkItemImportHandler } from '../app/createApp'

/**
 * Durable Work Item import SQS batch を current RBAC で処理します。
 */
export const workItemImportHandler = appWorkItemImportHandler
