import { describe, expect, test } from 'bun:test'
import { listOfferedSearchEntityTypes } from '../src/search/model/searchEntityTypeOptions'

describe('listOfferedSearchEntityTypes', () => {
  const all = ['work-item', 'file', 'document'] as const

  test('hides the unindexed file type', () => {
    expect(listOfferedSearchEntityTypes(all, undefined)).toEqual(['work-item', 'document'])
    expect(listOfferedSearchEntityTypes(all, ['work-item'])).toEqual(['work-item', 'document'])
  })

  test('keeps file visible while it is selected so it can be cleared', () => {
    expect(listOfferedSearchEntityTypes(all, ['file'])).toEqual(['work-item', 'file', 'document'])
  })
})
