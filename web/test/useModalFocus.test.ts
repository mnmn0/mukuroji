import { describe, expect, test } from 'bun:test'
import { activateModalFocus } from '../src/shared/ui/useModalFocus'

describe('Modal focus management', () => {
  test('focuses on open, traps Tab in both directions, closes on Escape, and restores focus', () => {
    const hadDocument = 'document' in globalThis
    const originalDocument = globalThis.document
    const listeners = new Map<string, EventListener>()
    let activeElement: unknown
    let closeCount = 0
    let previousFocusCount = 0

    const previous = {
      focus: () => {
        activeElement = previous
        previousFocusCount += 1
      },
      isConnected: true,
    }
    const first = {
      focus: () => {
        activeElement = first
      },
      isConnected: true,
    }
    const last = {
      focus: () => {
        activeElement = last
      },
      isConnected: true,
    }
    const focusable = [first, last]
    const container = {
      contains: (element: unknown) => focusable.includes(element as typeof first),
      focus: () => {
        activeElement = container
      },
      querySelector: () => first,
      querySelectorAll: () => focusable,
    }
    const fakeDocument = {
      addEventListener: (name: string, listener: EventListener) => {
        listeners.set(name, listener)
      },
      get activeElement() {
        return activeElement
      },
      removeEventListener: (name: string, listener: EventListener) => {
        if (listeners.get(name) === listener) {
          listeners.delete(name)
        }
      },
    }

    activeElement = previous
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: fakeDocument,
    })

    try {
      const cleanup = activateModalFocus(
        container as unknown as HTMLElement,
        () => {
          closeCount += 1
        },
      )
      const keydown = listeners.get('keydown')

      expect(activeElement).toBe(first)
      expect(keydown).toBeDefined()

      activeElement = last
      let prevented = false
      keydown?.({
        key: 'Tab',
        preventDefault: () => {
          prevented = true
        },
        shiftKey: false,
      } as unknown as Event)
      expect(prevented).toBeTrue()
      expect(activeElement).toBe(first)

      prevented = false
      keydown?.({
        key: 'Tab',
        preventDefault: () => {
          prevented = true
        },
        shiftKey: true,
      } as unknown as Event)
      expect(prevented).toBeTrue()
      expect(activeElement).toBe(last)

      prevented = false
      keydown?.({
        key: 'Escape',
        preventDefault: () => {
          prevented = true
        },
        shiftKey: false,
      } as unknown as Event)
      expect(prevented).toBeTrue()
      expect(closeCount).toBe(1)

      cleanup()
      expect(listeners.has('keydown')).toBeFalse()
      expect(activeElement).toBe(previous)
      expect(previousFocusCount).toBe(1)
    } finally {
      if (hadDocument) {
        Object.defineProperty(globalThis, 'document', {
          configurable: true,
          value: originalDocument,
        })
      } else {
        Reflect.deleteProperty(globalThis, 'document')
      }
    }
  })
})
