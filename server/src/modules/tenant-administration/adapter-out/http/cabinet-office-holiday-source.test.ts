import { describe, expect, test } from 'bun:test'
import { parseCabinetOfficeHolidayCsv } from '../../domain/japanese-public-holidays'
import { createCabinetOfficeHolidaySource } from './cabinet-office-holiday-source'

/** Header and first row of the Cabinet Office CSV, as the Shift_JIS bytes it is served in. */
const SHIFT_JIS_SAMPLE = Uint8Array.from(Buffer.from(
  '8d9196af82cc8f6a93fa81458b7893fa8c8e93fa2c8d9196af82cc8f6a93fa81458b7893fa96bc8fcc0d0a323032362f312f312c8cb393fa0d0a',
  'hex',
))

describe('Cabinet Office holiday source', () => {
  test('decodes the Shift_JIS file the Cabinet Office serves', async () => {
    const source = createCabinetOfficeHolidaySource({
      url: 'https://example.test/syukujitsu.csv',
      fetcher: async () => new Response(SHIFT_JIS_SAMPLE),
    })

    expect(parseCabinetOfficeHolidayCsv(source.decode(await source.fetch())))
      .toEqual([{ date: '2026-01-01', name: '元日' }])
  })

  test('only fetches HTTPS without redirects and refuses an oversized or failed response', async () => {
    expect(() => createCabinetOfficeHolidaySource({ url: 'http://example.test/holidays.csv' })).toThrow('HTTPS')
    const requests: RequestInit[] = []
    const ok = createCabinetOfficeHolidaySource({
      url: 'https://example.test/holidays.csv',
      fetcher: async (_url, init) => {
        if (init) requests.push(init)
        return new Response('2026/1/1,元日')
      },
    })
    await ok.fetch()
    expect(requests[0]).toMatchObject({ redirect: 'error' })

    const oversized = createCabinetOfficeHolidaySource({
      url: 'https://example.test/holidays.csv',
      fetcher: async () => new Response(new Uint8Array(600 * 1024)),
    })
    await expect(oversized.fetch()).rejects.toThrow('too large')
    const failed = createCabinetOfficeHolidaySource({
      url: 'https://example.test/holidays.csv',
      fetcher: async () => new Response('', { status: 503 }),
    })
    await expect(failed.fetch()).rejects.toThrow('503')
  })
})
