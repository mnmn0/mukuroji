import { describe, expect, test } from 'bun:test'
import {
  advanceDeepLinkTraversal,
  MAX_DEEP_LINK_AUTO_PAGES,
  type DeepLinkTraversalState,
} from '../src/issues/model/deepLinkTraversal'

describe('deep-link cursor traversal', () => {
  test('caps automatic loading and resets the count for a new target', () => {
    let state: DeepLinkTraversalState = { requestedPages: 0 }

    for (let index = 0; index < MAX_DEEP_LINK_AUTO_PAGES; index += 1) {
      const result = advanceDeepLinkTraversal(state, 'very-old-item', true)
      expect(result.shouldLoad).toBe(true)
      state = result.state
    }

    expect(
      advanceDeepLinkTraversal(state, 'very-old-item', true).shouldLoad,
    ).toBe(false)
    expect(
      advanceDeepLinkTraversal(state, 'different-item', true),
    ).toEqual({
      shouldLoad: true,
      exhausted: false,
      state: { requestedPages: 1, targetId: 'different-item' },
    })
  })

  test('does not consume the budget while pagination is unavailable', () => {
    expect(
      advanceDeepLinkTraversal(
        { requestedPages: 2, targetId: 'item-1' },
        'item-1',
        false,
      ),
    ).toEqual({
      shouldLoad: false,
      exhausted: false,
      state: { requestedPages: 2, targetId: 'item-1' },
    })
  })

  test('bounds missing Sources targets independently for context and source links', () => {
    let state: DeepLinkTraversalState = { requestedPages: 0 }

    for (const targetId of [
      'item:missing-context',
      'source:document:missing-source',
    ]) {
      for (let index = 0; index < MAX_DEEP_LINK_AUTO_PAGES; index += 1) {
        const result = advanceDeepLinkTraversal(state, targetId, true)
        expect(result.shouldLoad).toBe(true)
        state = result.state
      }

      expect(advanceDeepLinkTraversal(state, targetId, true)).toEqual({
        shouldLoad: false,
        exhausted: true,
        state: {
          requestedPages: MAX_DEEP_LINK_AUTO_PAGES,
          targetId,
        },
      })
    }
  })

  test('bounds missing conversation roots and replies with separate target budgets', () => {
    let state: DeepLinkTraversalState = { requestedPages: 0 }

    for (const targetId of [
      'root:missing-root:missing-comment',
      'reply:loaded-root:missing-reply',
    ]) {
      for (let index = 0; index < MAX_DEEP_LINK_AUTO_PAGES; index += 1) {
        const result = advanceDeepLinkTraversal(state, targetId, true)
        expect(result.shouldLoad).toBe(true)
        state = result.state
      }

      expect(
        advanceDeepLinkTraversal(state, targetId, true).shouldLoad,
      ).toBe(false)
    }
  })
})
