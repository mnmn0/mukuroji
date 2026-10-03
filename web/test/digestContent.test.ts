import { expect, test } from 'bun:test'
import { observeDigestContent } from '../src/features/update-feed/model/digestContent'

test('first successful source hydration establishes baselines even after initial failures', () => {
  const initial = { scope: 'recent', feedFailed: false, savedFailed: false }
  let state = observeDigestContent(undefined, initial)
  expect(observeDigestContent(state, initial)).toBe(state)
  state = observeDigestContent(state, { ...initial, feedFailed: true, savedFailed: true })
  expect(state.generation).toBe(0)
  state = observeDigestContent(state, { ...initial, feed: 'revision1/read0' })
  expect(state.generation).toBe(0)
  state = observeDigestContent(state, { ...initial, feed: 'revision1/read0', saved: 0 })
  expect(state.generation).toBe(0)
  expect(state.saved).toBe(0)
})

test('known revision, read-state, definition, scope and availability changes invalidate once', () => {
  const observed = { scope: 'recent', feed: 'revision1/read0', saved: 0, feedFailed: false, savedFailed: false }
  let state = observeDigestContent(undefined, observed)
  state = observeDigestContent(state, { ...observed, feed: 'revision2/read0' })
  expect(state.generation).toBe(1)
  state = observeDigestContent(state, { ...observed, feed: 'revision2/read1' })
  expect(state.generation).toBe(2)
  state = observeDigestContent(state, { ...state, saved: 1 })
  expect(state.generation).toBe(3)
  state = observeDigestContent(state, { ...state, feed: undefined, feedFailed: true })
  expect(state.generation).toBe(4)
  expect(observeDigestContent(state, { ...state, feed: undefined, feedFailed: true })).toBe(state)
  state = observeDigestContent(state, { ...state, feed: 'revision2/read1', feedFailed: false })
  expect(state.generation).toBe(4)
  state = observeDigestContent(state, { ...observed, scope: 'saved:one', feed: undefined })
  expect(state.generation).toBe(5)
  state = observeDigestContent(state, { ...state, feed: 'new-scope-first-read' })
  expect(state.generation).toBe(5)
})
