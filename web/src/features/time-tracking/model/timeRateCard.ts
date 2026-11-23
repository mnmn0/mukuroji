import type { SaveTimeRateCardRequest, TimeRateCard, TimeRateCardMemberRate } from '@mukuroji/contracts'
import { parseMajorAmount, toMajorAmountInput } from './timeReport'

/** Editable text of one member row. */
export type TimeRateCardMemberDraft = {
  /** Typed hourly rate in major units; empty means no own rate. */
  rate: string
  /** Chosen job role ID; empty means none. */
  jobRoleId: string
}

/** Editable text of a whole rate card. */
export type TimeRateCardDraft = {
  /** ISO 4217 currency typed by the manager. */
  currency: string
  /** Typed job role rates in major units, keyed by job role ID; empty means no rate. */
  jobRoleRates: Record<string, string>
  /** Member rows keyed by member key. */
  memberRates: Record<string, TimeRateCardMemberDraft>
}

/** Result of turning a draft into a save request. */
export type TimeRateCardDraftResult =
  | {
    /** The draft is valid. */
    ok: true
    /** Request body to send. */
    request: SaveTimeRateCardRequest
  }
  | {
    /** The draft is invalid. */
    ok: false
    /** Which part is invalid. */
    reason: 'currency' | 'amount'
  }

/**
 * Creates the editable text of a stored rate card.
 *
 * @param rateCard - Stored or empty card.
 * @returns Draft whose amounts are shown in major units.
 */
export function createTimeRateCardDraft(rateCard: TimeRateCard): TimeRateCardDraft {
  return {
    currency: rateCard.currency,
    jobRoleRates: Object.fromEntries(rateCard.jobRoleRates.map((rate) => [
      rate.jobRoleId,
      toMajorAmountInput(rate.hourlyRateMinor, rateCard.currency),
    ])),
    memberRates: Object.fromEntries(rateCard.memberRates.map((rate) => [rate.userId, {
      rate: rate.hourlyRateMinor === undefined ? '' : toMajorAmountInput(rate.hourlyRateMinor, rateCard.currency),
      jobRoleId: rate.jobRoleId ?? '',
    }])),
  }
}

/**
 * Turns a draft into the request that replaces the whole card.
 *
 * Rows left empty are dropped, so clearing a row removes it from the card.
 *
 * @param draft - Edited text.
 * @param expectedRevision - Revision the draft was made from.
 * @returns The request, or which part of the draft is invalid.
 */
export function toSaveTimeRateCardRequest(draft: TimeRateCardDraft, expectedRevision: number): TimeRateCardDraftResult {
  const currency = draft.currency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/u.test(currency)) return { ok: false, reason: 'currency' }
  const jobRoleRates: SaveTimeRateCardRequest['jobRoleRates'] = []
  for (const [jobRoleId, text] of Object.entries(draft.jobRoleRates)) {
    if (text.trim() === '') continue
    const hourlyRateMinor = parseMajorAmount(text, currency)
    if (hourlyRateMinor === undefined) return { ok: false, reason: 'amount' }
    jobRoleRates.push({ jobRoleId, hourlyRateMinor })
  }
  const memberRates: TimeRateCardMemberRate[] = []
  for (const [userId, row] of Object.entries(draft.memberRates)) {
    const hourlyRateMinor = row.rate.trim() === '' ? undefined : parseMajorAmount(row.rate, currency)
    if (row.rate.trim() !== '' && hourlyRateMinor === undefined) return { ok: false, reason: 'amount' }
    if (hourlyRateMinor === undefined && row.jobRoleId === '') continue
    memberRates.push({
      userId,
      ...(hourlyRateMinor === undefined ? {} : { hourlyRateMinor }),
      ...(row.jobRoleId === '' ? {} : { jobRoleId: row.jobRoleId }),
    })
  }
  return { ok: true, request: { currency, memberRates, jobRoleRates, expectedRevision } }
}
