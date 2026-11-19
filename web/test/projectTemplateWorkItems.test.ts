import { describe, expect, test } from 'bun:test'
import {
  AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_LIMIT,
} from '@mukuroji/contracts'
import {
  countProjectTemplateWorkItems,
  formatProjectTemplateWorkItemOutline,
  parseProjectTemplateWorkItemOutline,
} from '../src/automation/model/projectTemplateWorkItems'

describe('Project template WBS outline', () => {
  test('reads indented lines into a Work Item tree and writes it back', () => {
    const text = [
      '要件定義 | 0 | 5',
      '  ヒアリング | 0 | 2',
      '    議事録 | 1 | 1',
      '',
      '  A|B 比較 | 2 | 3',
      '設計 | 5 | 10',
    ].join('\n')
    const result = parseProjectTemplateWorkItemOutline(text)
    expect(result).toEqual({
      workItems: [
        {
          title: '要件定義',
          startOffsetWorkingDays: 0,
          durationWorkingDays: 5,
          children: [
            {
              title: 'ヒアリング',
              startOffsetWorkingDays: 0,
              durationWorkingDays: 2,
              children: [{ title: '議事録', startOffsetWorkingDays: 1, durationWorkingDays: 1 }],
            },
            { title: 'A|B 比較', startOffsetWorkingDays: 2, durationWorkingDays: 3 },
          ],
        },
        { title: '設計', startOffsetWorkingDays: 5, durationWorkingDays: 10 },
      ],
    })
    if (!('workItems' in result)) throw new Error('Expected Work Items.')
    expect(countProjectTemplateWorkItems(result.workItems)).toBe(5)
    expect(formatProjectTemplateWorkItemOutline(result.workItems)).toBe(text.replace('\n\n', '\n'))
    expect(parseProjectTemplateWorkItemOutline('')).toEqual({ workItems: [] })
    expect(formatProjectTemplateWorkItemOutline(undefined)).toBe('')
  })

  test('reports the first invalid line', () => {
    expect(parseProjectTemplateWorkItemOutline('A | 0')).toEqual({ error: 'format', line: 1 })
    expect(parseProjectTemplateWorkItemOutline('A | 0 | 1\n    B | 0 | 1')).toEqual({ error: 'indent', line: 2 })
    expect(parseProjectTemplateWorkItemOutline('A | 0 | 1\n B | 0 | 1')).toEqual({ error: 'indent', line: 2 })
    expect(parseProjectTemplateWorkItemOutline('\tA | 0 | 1')).toEqual({ error: 'indent', line: 1 })
    expect(parseProjectTemplateWorkItemOutline('A | 0 | 1\n  | 0 | 1')).toEqual({ error: 'title', line: 2 })
    expect(parseProjectTemplateWorkItemOutline('A | x | 1')).toEqual({ error: 'days', line: 1 })
    expect(parseProjectTemplateWorkItemOutline('A | 0 | 0')).toEqual({ error: 'days', line: 1 })
    expect(parseProjectTemplateWorkItemOutline('A | -1 | 2')).toEqual({ error: 'days', line: 1 })
    expect(parseProjectTemplateWorkItemOutline(
      ['A | 0 | 1', '  B | 0 | 1', '    C | 0 | 1', '      D | 0 | 1', '        E | 0 | 1'].join('\n'),
    )).toEqual({ error: 'depth', line: 5 })
    expect(parseProjectTemplateWorkItemOutline(
      Array.from({ length: AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_LIMIT + 1 }, (_, index) => `Item ${index} | 0 | 1`).join('\n'),
    )).toEqual({ error: 'limit', line: AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_LIMIT + 1 })
  })
})
