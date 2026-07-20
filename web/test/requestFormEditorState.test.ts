import { describe, expect, test } from 'bun:test'
import {
  getRequestFormEditorInstanceKey,
} from '../src/requests/model/editorState'
import { requestFormFixture } from '../src/requests/fixtures'

describe('request form editor state', () => {
  test('keeps the editor instance stable when only the persisted revision changes', () => {
    const persistedForm = {
      ...requestFormFixture,
      revision: requestFormFixture.revision + 1,
    }

    expect(getRequestFormEditorInstanceKey(requestFormFixture)).toBe(
      getRequestFormEditorInstanceKey(persistedForm),
    )
  })
})
