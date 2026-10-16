import type { CreateWebhookTriageEntryInput } from '@mukuroji/contracts'
import { TriageError } from './triage-entry'

/** Fields a Triage webhook envelope may contain. */
const ENVELOPE_KEYS = new Set(['eventId', 'title', 'body', 'requester'])

/** Fields the envelope's requester may contain. */
const REQUESTER_KEYS = new Set(['name', 'email'])

/**
 * Validates the JSON envelope a Triage-purpose inbound webhook delivers.
 *
 * The envelope carries only the content of the entry. Routing, owner, SLA, and every
 * other Triage decision come from the endpoint and the Team configuration, so unknown
 * fields are rejected instead of ignored.
 *
 * @param value - Parsed JSON body.
 * @returns The normalized envelope.
 */
export function readWebhookTriageEnvelope(value: unknown): CreateWebhookTriageEntryInput {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !ENVELOPE_KEYS.has(key))) {
    throw invalidEnvelope('The envelope must contain only eventId, title, body, and requester.')
  }
  const requester = value.requester
  if (!isPlainRecord(requester) || Object.keys(requester).some((key) => !REQUESTER_KEYS.has(key))) {
    throw invalidEnvelope('requester must contain only name and email.')
  }
  const email = requester.email === undefined ? undefined : readEmail(requester.email)
  return {
    eventId: readText(value.eventId, 'eventId', 200),
    title: readText(value.title, 'title', 500),
    body: readText(value.body, 'body', 8_000),
    requesterDisplayName: readText(requester.name, 'requester.name', 300),
    ...(email ? { requesterEmail: email } : {}),
  }
}

/**
 * Reads one required trimmed text field.
 *
 * @param value - Untrusted value.
 * @param field - Field name used in the error message.
 * @param maxLength - Maximum length after trimming.
 * @returns The trimmed text.
 */
function readText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw invalidEnvelope(`${field} must be a string.`)
  const text = value.trim()
  if (!text || text.length > maxLength) throw invalidEnvelope(`${field} must be 1 to ${maxLength} characters.`)
  return text
}

/**
 * Reads and normalizes the optional requester email.
 *
 * The envelope is validated before the delivery is recorded, so an address the entry
 * would reject must fail here instead of consuming the delivery's idempotency key.
 *
 * @param value - Untrusted value.
 * @returns The lowercased address.
 */
function readEmail(value: unknown): string {
  const email = readText(value, 'requester.email', 320).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw invalidEnvelope('requester.email must be an email address.')
  return email
}

/**
 * Checks for a non-array object.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a plain record.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Creates the shared envelope validation error.
 *
 * @param message - Safe description of the problem.
 * @returns A 400 Triage error.
 */
function invalidEnvelope(message: string): TriageError {
  return new TriageError(400, 'InvalidTriageWebhookEnvelope', message)
}
