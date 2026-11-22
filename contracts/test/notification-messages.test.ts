import { describe, expect, test } from 'bun:test'
import {
  NOTIFICATION_MESSAGE_TEMPLATES,
  createNotificationMessage,
  formatNotificationMessage,
  parseNotificationMessage,
} from '../src/notification-messages'

describe('notification messages', () => {
  test('every code has the same placeholders in Japanese and English', () => {
    for (const [code, templates] of Object.entries(NOTIFICATION_MESSAGE_TEMPLATES)) {
      const names = (text: string) => [...text.matchAll(/\{([A-Za-z]+)\}/g)].map((match) => match[1]).sort()
      expect({ code, names: names(templates.ja) }).toEqual({ code, names: names(templates.en) })
    }
  })

  test('writes the message in the reader language', () => {
    const message = createNotificationMessage('work-item.due-soon', { title: 'Release', dueDate: '2026-11-29' })
    expect(formatNotificationMessage(message, 'en')).toBe('Work Item "Release" is due on 2026-11-29.')
    expect(formatNotificationMessage(message, 'ja')).toBe('「Release」の期限は 2026-11-29 です。')
  })

  test('translates code parameters only in Japanese', () => {
    const message = createNotificationMessage('planning-update.health-changed', { health: 'at-risk', excerpt: 'Late' })
    expect(formatNotificationMessage(message, 'en')).toBe('Health changed to at-risk: Late')
    expect(formatNotificationMessage(message, 'ja')).toBe('Health が要注意になりました: Late')
  })

  test('keeps a placeholder that has no value and leaves out empty params', () => {
    expect(createNotificationMessage('work-item.overdue', {})).toEqual({ code: 'work-item.overdue' })
    expect(formatNotificationMessage({ code: 'work-item.overdue' }, 'en')).toBe('Work Item "{title}" is overdue.')
  })

  test('does not expand placeholders that appear inside a value', () => {
    const message = createNotificationMessage('work-item.overdue', { title: '{title}{dueDate}' })
    expect(formatNotificationMessage(message, 'ja')).toBe('「{title}{dueDate}」は期限を過ぎています。')
  })

  test('reads stored messages and rejects malformed ones', () => {
    expect(parseNotificationMessage({ code: 'work-item.updated' })).toEqual({ code: 'work-item.updated' })
    expect(parseNotificationMessage({ code: 'timesheet.unsubmitted-many', params: { count: 3, date: '2026-11-20' } }))
      .toEqual({ code: 'timesheet.unsubmitted-many', params: { count: 3, date: '2026-11-20' } })
    expect(parseNotificationMessage(undefined)).toBeUndefined()
    expect(parseNotificationMessage('work-item.updated')).toBeUndefined()
    expect(parseNotificationMessage({ code: 'unknown.code' })).toBeUndefined()
    expect(parseNotificationMessage({ code: 'toString' })).toBeUndefined()
    expect(parseNotificationMessage({ code: 'work-item.overdue', params: [] })).toBeUndefined()
    expect(parseNotificationMessage({ code: 'work-item.overdue', params: { 'bad-name': 'x' } })).toBeUndefined()
    expect(parseNotificationMessage({ code: 'work-item.overdue', params: { title: Number.NaN } })).toBeUndefined()
    expect(parseNotificationMessage({ code: 'work-item.overdue', params: { title: true } })).toBeUndefined()
    expect(parseNotificationMessage({ code: 'work-item.overdue', params: { title: 'x'.repeat(501) } })).toBeUndefined()
    const tooMany = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`p${String.fromCharCode(97 + index)}`, 'x']))
    expect(parseNotificationMessage({ code: 'work-item.overdue', params: tooMany })).toBeUndefined()
  })
})
