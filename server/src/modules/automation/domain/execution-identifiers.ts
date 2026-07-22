import { createHash } from 'node:crypto'
import type { AutomationRule } from '@mukuroji/contracts'
import { AutomationError } from './automation-error'

/**
 * Creates a deterministic execution identifier for a logical Rule/event pair.
 *
 * @param rule - Pinned rule definition.
 * @param eventId - Durable trigger event identifier.
 * @returns A version-independent execution identifier.
 */
export function createAutomationExecutionId(rule: AutomationRule, eventId: string): string {
  const digest = createHash('sha256')
    .update(`${rule.workspaceId}\0${rule.id}\0${requireText(eventId, 'Event ID')}`)
    .digest('hex')
  return `automation_${digest.slice(0, 48)}`
}

/**
 * Creates a deterministic execution identifier for a recurring definition slot.
 *
 * @param workspaceId - Owning Workspace identifier.
 * @param recurringWorkId - Recurring definition identifier.
 * @param scheduledFor - ISO timestamp of the scheduled slot.
 * @returns A deterministic recurring execution identifier.
 */
export function createRecurringExecutionId(
  workspaceId: string,
  recurringWorkId: string,
  scheduledFor: string,
): string {
  const normalizedScheduledFor = normalizeTimestamp(scheduledFor)
  const digest = createHash('sha256')
    .update(
      `${requireText(workspaceId, 'Workspace ID')}\0` +
      `${requireText(recurringWorkId, 'Recurring Work ID')}\0${normalizedScheduledFor}`,
    )
    .digest('hex')
  return `recurring_${digest.slice(0, 48)}`
}

/**
 * Creates a deterministic action receipt identifier.
 *
 * @param executionId - Parent execution identifier.
 * @param actionIndex - Zero-based action index.
 * @returns A stable action receipt identifier.
 */
export function createAutomationActionId(executionId: string, actionIndex: number): string {
  if (!Number.isSafeInteger(actionIndex) || actionIndex < 0) {
    throw invalidInput('Action index must be a non-negative integer.')
  }
  return `${requireText(executionId, 'Execution ID')}:action:${String(actionIndex).padStart(4, '0')}`
}

/** Normalizes a valid timestamp to ISO UTC representation. */
function normalizeTimestamp(value: string): string {
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) throw invalidInput('Timestamp is invalid.')
  return timestamp.toISOString()
}

/** Reads required text. */
function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidInput(`${label} is required.`)
  }
  return value.trim()
}

/** Creates the stable invalid-input error. */
function invalidInput(message: string): AutomationError {
  return new AutomationError('invalid-input', 'InvalidAutomationInput', message)
}
