import { describe, expect, test } from 'bun:test'
import {
  formatProjectTemplateDependencyLines,
  formatProjectTemplatePlanningOutline,
  listProjectTemplateWbsNumbers,
  parseProjectTemplateDependencyLines,
  parseProjectTemplatePlanningOutline,
} from '../src/automation/model/projectTemplatePlanning'

const workItems = [
  {
    title: '要件定義',
    startOffsetWorkingDays: 0,
    durationWorkingDays: 5,
    children: [{ title: 'ヒアリング', startOffsetWorkingDays: 0, durationWorkingDays: 2 }],
  },
  { title: '設計', startOffsetWorkingDays: 5, durationWorkingDays: 3 },
]

describe('Project template Phase / Milestone outline', () => {
  test('reads Phases with indented Milestones and standalone Milestones, and writes them back', () => {
    const text = ['準備 | 0 | 5', '  ◆ 要件確定 | 4', '', '◆A|B 判定 | 7', 'X|Y 段階 | 8 | 2'].join('\n')
    const result = parseProjectTemplatePlanningOutline(text)
    expect(result).toEqual({
      phases: [
        {
          title: '準備',
          startOffsetWorkingDays: 0,
          durationWorkingDays: 5,
          milestones: [{ title: '要件確定', offsetWorkingDays: 4 }],
        },
        { title: 'X|Y 段階', startOffsetWorkingDays: 8, durationWorkingDays: 2 },
      ],
      milestones: [{ title: 'A|B 判定', offsetWorkingDays: 7 }],
    })
    if (!('phases' in result)) throw new Error('The outline must parse.')
    const formatted = formatProjectTemplatePlanningOutline(result.phases, result.milestones)
    expect(formatted).toBe(['準備 | 0 | 5', '  ◆ 要件確定 | 4', 'X|Y 段階 | 8 | 2', '◆ A|B 判定 | 7'].join('\n'))
    expect(parseProjectTemplatePlanningOutline(formatted)).toEqual(result)
  })

  test('reports the first invalid line', () => {
    expect(parseProjectTemplatePlanningOutline('準備 | 4')).toEqual({ error: 'format', line: 1 })
    expect(parseProjectTemplatePlanningOutline('◆ 要件確定')).toEqual({ error: 'format', line: 1 })
    expect(parseProjectTemplatePlanningOutline('  ◆ 要件確定 | 4')).toEqual({ error: 'indent', line: 1 })
    expect(parseProjectTemplatePlanningOutline('準備 | 0 | 5\n  設計 | 1 | 2')).toEqual({ error: 'indent', line: 2 })
    expect(parseProjectTemplatePlanningOutline('準備 | 0 | 0')).toEqual({ error: 'days', line: 1 })
    expect(parseProjectTemplatePlanningOutline('◆ | 4')).toEqual({ error: 'title', line: 1 })
    expect(parseProjectTemplatePlanningOutline(`◆ ${'𠮷'.repeat(251)} | 4`)).toEqual({ error: 'title', line: 1 })
    expect(parseProjectTemplatePlanningOutline(Array.from({ length: 31 }, (_, index) => `◆ M${index} | 0`).join('\n')))
      .toEqual({ error: 'limit', line: 31 })
  })
})

describe('Project template dependency lines', () => {
  test('reads WBS number pairs with optional type and lag and writes them back', () => {
    expect(listProjectTemplateWbsNumbers(workItems)).toEqual(['1', '1.1', '2'])
    const result = parseProjectTemplateDependencyLines('1 -> 2\n1.1->2 ss +1\n\n1.1 -> 2', workItems)
    expect(result).toEqual({ error: 'duplicate', line: 4 })
    const valid = parseProjectTemplateDependencyLines('1 -> 2\n1.1->2 ss +1', workItems)
    expect(valid).toEqual({
      dependencies: [
        { predecessor: '1', successor: '2', type: 'finish-to-start', lagDays: 0 },
        { predecessor: '1.1', successor: '2', type: 'start-to-start', lagDays: 1 },
      ],
    })
    if (!('dependencies' in valid)) throw new Error('The lines must parse.')
    expect(formatProjectTemplateDependencyLines(valid.dependencies)).toBe('1 -> 2 FS\n1.1 -> 2 SS +1')
  })

  test('reports the first invalid line', () => {
    expect(parseProjectTemplateDependencyLines('1 => 2', workItems)).toEqual({ error: 'format', line: 1 })
    expect(parseProjectTemplateDependencyLines('1 -> 2 FS +400', workItems)).toEqual({ error: 'format', line: 1 })
    expect(parseProjectTemplateDependencyLines('1 -> 3', workItems)).toEqual({ error: 'reference', line: 1 })
    expect(parseProjectTemplateDependencyLines('2 -> 2', workItems)).toEqual({ error: 'self', line: 1 })
    expect(parseProjectTemplateDependencyLines('1.1 -> 1', workItems)).toEqual({ error: 'hierarchy', line: 1 })
  })
})
