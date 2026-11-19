import { expect, test } from 'bun:test'
import {
  isMemberPreferenceTimeZone,
  readUpdateMemberPreferencesInput,
} from './member-preferences'

test('accepts known IANA time zones and rejects unknown or malformed names', () => {
  expect(isMemberPreferenceTimeZone('Asia/Tokyo')).toBe(true)
  expect(isMemberPreferenceTimeZone('America/Argentina/Buenos_Aires')).toBe(true)
  expect(isMemberPreferenceTimeZone('UTC')).toBe(true)
  expect(isMemberPreferenceTimeZone('Mars/Olympus')).toBe(false)
  expect(isMemberPreferenceTimeZone('')).toBe(false)
  expect(isMemberPreferenceTimeZone(' Asia/Tokyo')).toBe(false)
  expect(isMemberPreferenceTimeZone(`Asia/${'a'.repeat(80)}`)).toBe(false)
  expect(isMemberPreferenceTimeZone(9)).toBe(false)
})

test('reads a complete replacement and drops unset fields', () => {
  expect(readUpdateMemberPreferencesInput({
    fontSize: 'comfortable',
    locale: 'ja',
    revision: 4,
    theme: null,
    timeZone: 'Europe/London',
  })).toEqual({
    fontSize: 'comfortable',
    locale: 'ja',
    revision: 4,
    timeZone: 'Europe/London',
  })
  expect(readUpdateMemberPreferencesInput({ revision: 0 })).toEqual({ revision: 0 })
})

test('rejects unsupported values and revisions', () => {
  expect(readUpdateMemberPreferencesInput(undefined)).toBeUndefined()
  expect(readUpdateMemberPreferencesInput([])).toBeUndefined()
  expect(readUpdateMemberPreferencesInput({})).toBeUndefined()
  expect(readUpdateMemberPreferencesInput({ revision: -1 })).toBeUndefined()
  expect(readUpdateMemberPreferencesInput({ revision: 1.5 })).toBeUndefined()
  expect(readUpdateMemberPreferencesInput({ revision: Number.MAX_SAFE_INTEGER - 1 })).toBeUndefined()
  expect(readUpdateMemberPreferencesInput({ locale: 'fr', revision: 0 })).toBeUndefined()
  expect(readUpdateMemberPreferencesInput({ theme: 'blue', revision: 0 })).toBeUndefined()
  expect(readUpdateMemberPreferencesInput({ fontSize: 'huge', revision: 0 })).toBeUndefined()
  expect(readUpdateMemberPreferencesInput({ revision: 0, timeZone: 'Nowhere' })).toBeUndefined()
})
