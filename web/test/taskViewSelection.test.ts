import { describe, expect, test } from 'bun:test'
import {
  createTaskViewActionSelection,
  createFocusedTaskViewActionSelection,
  createTaskViewItemKey,
  createTaskViewSelectionKeyboardAction,
  createTaskViewSelectionState,
  parseTaskViewItemKey,
  reduceTaskViewSelection,
  type TaskViewSelectionKeyboardInput,
  type TaskViewSelectionState,
} from '../src/task-views/model/taskViewSelection'

const firstKey = createTaskViewItemKey('team-1', 'same-id')
const secondKey = createTaskViewItemKey('team-2', 'same-id')
const thirdKey = createTaskViewItemKey('team-2', 'third')
const fourthKey = createTaskViewItemKey('team-1', 'fourth')
const orderedKeys = [firstKey, secondKey, thirdKey, fourthKey]

/**
 * Creates unguarded keyboard facts for selection tests.
 *
 * @param key - Browser key value.
 * @returns Keyboard input facts.
 */
function createKeyboardInput(key: string): TaskViewSelectionKeyboardInput {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    isEditableTarget: false,
    isModalOpen: false,
  }
}

describe('task view selection identity', () => {
  test('creates a direct focus snapshot without inheriting unrelated selection', () => {
    expect(createFocusedTaskViewActionSelection({
      expectedRevision: 12,
      teamId: 'team-2',
      workItemId: 'focused',
    })).toEqual({
      focusedTarget: {
        expectedRevision: 12,
        teamId: 'team-2',
        workItemId: 'focused',
      },
      mode: 'none',
      targets: [],
    })
  })

  test('uses a collision-safe Team-qualified key for equal local Work Item IDs', () => {
    expect(firstKey).not.toBe(secondKey)
    expect(parseTaskViewItemKey(firstKey)).toEqual({ teamId: 'team-1', workItemId: 'same-id' })
    expect(parseTaskViewItemKey(secondKey)).toEqual({ teamId: 'team-2', workItemId: 'same-id' })
    expect(parseTaskViewItemKey('same-id')).toBeUndefined()
  })

  test('projects permission-safe reducer state into the canonical action selection', () => {
    const state = {
      focusedKey: secondKey,
      anchorKey: firstKey,
      selectedKeys: [firstKey, 'inaccessible', secondKey],
    } satisfies TaskViewSelectionState
    const selection = createTaskViewActionSelection(state, [
      { teamId: 'team-1', workItemId: 'same-id', expectedRevision: 3 },
      { teamId: 'team-2', workItemId: 'same-id', expectedRevision: 8 },
    ])

    expect(selection).toEqual({
      mode: 'multiple',
      targets: [
        { teamId: 'team-1', workItemId: 'same-id', expectedRevision: 3 },
        { teamId: 'team-2', workItemId: 'same-id', expectedRevision: 8 },
      ],
      focusedTarget: { teamId: 'team-2', workItemId: 'same-id', expectedRevision: 8 },
      anchorTarget: { teamId: 'team-1', workItemId: 'same-id', expectedRevision: 3 },
    })
  })
})

describe('task view focus and range reducer', () => {
  test('maps J, K, Space, and Shift navigation to shared reducer transitions', () => {
    let state = createTaskViewSelectionState()
    const firstMove = createTaskViewSelectionKeyboardAction(
      createKeyboardInput('j'),
      state,
      orderedKeys,
    )
    if (!firstMove) throw new Error('Expected J to create a navigation action.')
    state = reduceTaskViewSelection(state, firstMove)
    expect(state).toEqual({
      anchorKey: firstKey,
      focusedKey: firstKey,
      selectedKeys: [],
    })

    const toggle = createTaskViewSelectionKeyboardAction(
      createKeyboardInput(' '),
      state,
      orderedKeys,
    )
    if (!toggle) throw new Error('Expected Space to create a toggle action.')
    state = reduceTaskViewSelection(state, toggle)
    expect(state.selectedKeys).toEqual([firstKey])

    const secondMove = createTaskViewSelectionKeyboardAction(
      createKeyboardInput('J'),
      state,
      orderedKeys,
    )
    if (!secondMove) throw new Error('Expected J to create a navigation action.')
    state = reduceTaskViewSelection(state, secondMove)
    expect(state).toMatchObject({ anchorKey: secondKey, focusedKey: secondKey })

    const rangeMove = createTaskViewSelectionKeyboardAction(
      { ...createKeyboardInput('j'), shiftKey: true },
      state,
      orderedKeys,
    )
    if (!rangeMove) throw new Error('Expected Shift+J to create a range action.')
    state = reduceTaskViewSelection(state, rangeMove)
    expect(state).toEqual({
      anchorKey: secondKey,
      focusedKey: thirdKey,
      selectedKeys: [secondKey, thirdKey],
    })

    const previousMove = createTaskViewSelectionKeyboardAction(
      createKeyboardInput('k'),
      state,
      orderedKeys,
    )
    if (!previousMove) throw new Error('Expected K to create a navigation action.')
    expect(reduceTaskViewSelection(state, previousMove).focusedKey).toBe(secondKey)
  })

  test('supports explicit anchored ranges and Shift+Space', () => {
    const state = {
      anchorKey: firstKey,
      focusedKey: thirdKey,
      selectedKeys: [firstKey],
    } satisfies TaskViewSelectionState
    const shiftSpace = createTaskViewSelectionKeyboardAction(
      { ...createKeyboardInput('Space'), shiftKey: true },
      state,
      orderedKeys,
    )
    if (!shiftSpace) throw new Error('Expected Shift+Space to create a range action.')

    expect(reduceTaskViewSelection(state, shiftSpace)).toEqual({
      anchorKey: firstKey,
      focusedKey: thirdKey,
      selectedKeys: [firstKey, secondKey, thirdKey],
    })
    expect(reduceTaskViewSelection(state, {
      type: 'select',
      key: fourthKey,
      mode: 'range',
      orderedKeys,
    }).selectedKeys).toEqual(orderedKeys)
  })

  test('prunes deleted or inaccessible identities and restores valid focus', () => {
    const state = {
      focusedKey: thirdKey,
      anchorKey: firstKey,
      selectedKeys: [firstKey, secondKey, thirdKey],
    } satisfies TaskViewSelectionState

    expect(reduceTaskViewSelection(state, {
      type: 'prune',
      availableKeys: [secondKey, fourthKey],
    })).toEqual({
      focusedKey: secondKey,
      anchorKey: secondKey,
      selectedKeys: [secondKey],
    })
    expect(reduceTaskViewSelection({
      focusedKey: 'deleted',
      selectedKeys: [],
    }, {
      type: 'prune',
      availableKeys: [fourthKey],
    })).toEqual({
      focusedKey: fourthKey,
      anchorKey: fourthKey,
      selectedKeys: [],
    })
  })

  test('retains state identity when Project, Team, or My Tasks pruning changes nothing', () => {
    const cases = [
      {
        availableKeys: orderedKeys,
        state: {
          anchorKey: firstKey,
          focusedKey: firstKey,
          selectedKeys: [firstKey, thirdKey],
        },
      },
      {
        availableKeys: orderedKeys,
        state: {
          anchorKey: secondKey,
          focusedKey: secondKey,
          selectedKeys: [],
        },
      },
      {
        availableKeys: [],
        state: { selectedKeys: [] },
      },
    ] satisfies Array<{
      availableKeys: readonly string[]
      state: TaskViewSelectionState
    }>

    for (const { availableKeys, state } of cases) {
      const result = reduceTaskViewSelection(state, {
        availableKeys,
        type: 'prune',
      })

      expect(result).toBe(state)
    }
  })

  test('guards editable, IME, modal, and action-modified keyboard events', () => {
    const state = { focusedKey: firstKey, selectedKeys: [] }
    const guardedInputs: TaskViewSelectionKeyboardInput[] = [
      { ...createKeyboardInput('j'), isEditableTarget: true },
      { ...createKeyboardInput('j'), isComposing: true },
      { ...createKeyboardInput('j'), isModalOpen: true },
      { ...createKeyboardInput('j'), metaKey: true },
      { ...createKeyboardInput('j'), ctrlKey: true },
      { ...createKeyboardInput('j'), altKey: true },
      { ...createKeyboardInput('Space'), repeat: true },
    ]

    expect(guardedInputs.map((input) =>
      createTaskViewSelectionKeyboardAction(input, state, orderedKeys)
    )).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined])
  })
})
