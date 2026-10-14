import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getInitialLocale,
  setLocalePreference,
  subscribeToLocalePreference,
} from '../src/shared/i18n/i18n'

/** Minimal in-memory `localStorage` replacement. */
class MemoryStorage {
  /** Stored key/value pairs. */
  private readonly values = new Map<string, string>()

  /**
   * Reads a stored value.
   *
   * @param key - Storage key.
   * @returns The stored value, or `null` when absent.
   */
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  /**
   * Stores a value.
   *
   * @param key - Storage key.
   * @param value - Value to store.
   */
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

/** Fake browser window exposing only what the locale helpers use. */
class FakeWindow extends EventTarget {
  /** Saved preferences. */
  readonly localStorage = new MemoryStorage()
  /** Browser language used when no preference is saved. */
  readonly navigator = { language: 'ja-JP' }
}

let fakeWindow = new FakeWindow()

beforeEach(() => {
  fakeWindow = new FakeWindow()
  Reflect.set(globalThis, 'window', fakeWindow)
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window')
})

describe('subscribeToLocalePreference', () => {
  test('notifies subscribers when this tab saves a locale', () => {
    let notifications = 0
    const unsubscribe = subscribeToLocalePreference(() => {
      notifications += 1
    })

    setLocalePreference('en')

    expect(notifications).toBe(1)
    expect(getInitialLocale()).toBe('en')

    unsubscribe()
    setLocalePreference('ja')
    expect(notifications).toBe(1)
  })

  test('notifies subscribers when another tab saves the locale key only', () => {
    let notifications = 0
    const unsubscribe = subscribeToLocalePreference(() => {
      notifications += 1
    })

    fakeWindow.dispatchEvent(Object.assign(new Event('storage'), { key: 'mukuroji.locale' }))
    fakeWindow.dispatchEvent(Object.assign(new Event('storage'), { key: 'mukuroji.auth' }))
    expect(notifications).toBe(1)

    unsubscribe()
    fakeWindow.dispatchEvent(Object.assign(new Event('storage'), { key: 'mukuroji.locale' }))
    expect(notifications).toBe(1)
  })
})
