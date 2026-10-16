import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  announce,
  readLiveAnnouncements,
  resetLiveAnnouncements,
  subscribeToLiveAnnouncements,
} from '../src/shared/lib/liveAnnouncements'
import { LiveAnnouncer } from '../src/shared/ui/LiveAnnouncer'

afterEach(() => {
  resetLiveAnnouncements()
})

describe('live announcements', () => {
  test('keeps the latest message per politeness level and notifies subscribers', () => {
    let notifications = 0
    const unsubscribe = subscribeToLiveAnnouncements(() => {
      notifications += 1
    })

    announce('Saved.', 'polite', 1_000)
    announce('Save failed.', 'assertive', 1_000)
    unsubscribe()
    announce('Ignored by the removed listener.', 'polite', 5_000)

    expect(notifications).toBe(2)
    expect(readLiveAnnouncements().assertive?.message).toBe('Save failed.')
    expect(readLiveAnnouncements().polite?.message).toBe('Ignored by the removed listener.')
  })

  test('ignores blank text and duplicate messages inside the duplicate window', () => {
    announce('   ', 'polite', 1_000)
    expect(readLiveAnnouncements().polite).toBeUndefined()

    announce('Saved.', 'polite', 1_000)
    const first = readLiveAnnouncements().polite
    announce('Saved.', 'polite', 1_200)
    expect(readLiveAnnouncements().polite).toBe(first)

    announce('Saved.', 'polite', 1_600)
    const repeated = readLiveAnnouncements().polite
    expect(repeated?.message).toBe('Saved.')
    expect(repeated?.id).not.toBe(first?.id)
  })

  test('re-announces an identical message from a different action inside the duplicate window', () => {
    const firstAction = {}
    const secondAction = {}
    announce('Saved.', 'polite', 1_000, firstAction)
    const firstId = readLiveAnnouncements().polite?.id
    announce('Saved.', 'polite', 1_100, firstAction)
    expect(readLiveAnnouncements().polite?.id).toBe(firstId)
    announce('Saved.', 'polite', 1_200, secondAction)
    expect(readLiveAnnouncements().polite?.id).not.toBe(firstId)
  })

  test('renders persistent role-less live regions with the latest messages', () => {
    const emptyMarkup = renderToStaticMarkup(<LiveAnnouncer />)
    expect(emptyMarkup).toContain('aria-live="polite"')
    expect(emptyMarkup).toContain('aria-live="assertive"')
    expect(emptyMarkup).not.toContain('role=')

    announce('Saved.', 'polite', 1_000)
    expect(renderToStaticMarkup(<LiveAnnouncer />)).toMatch(/<p data-announcement-id="\d+">Saved\.<\/p>/)
  })
})
