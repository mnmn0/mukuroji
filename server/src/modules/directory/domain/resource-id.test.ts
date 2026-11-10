import { describe, expect, test } from 'bun:test'
import { isTriageTeamIdentifier } from '../../triage'
import { createDirectoryResourceId } from './resource-id'

describe('createDirectoryResourceId', () => {
  test('keeps the slug that ASCII names produced before', () => {
    expect(createDirectoryResourceId('team', ['Core Team', 'Core Team'], [])).toBe('core-team')
    expect(createDirectoryResourceId('project', ['  Refero  ', 'Refero'], [])).toBe('refero')
    expect(createDirectoryResourceId('team', ['Support v2', 'Support v2'], [])).toBe('support-v2')
  })

  test('folds full-width forms and accents into ASCII', () => {
    expect(createDirectoryResourceId('team', ['ＡＰＩ　Ｔｅａｍ', 'ＡＰＩ　Ｔｅａｍ'], [])).toBe('api-team')
    expect(createDirectoryResourceId('team', ['Café Ops', 'Café Ops'], [])).toBe('cafe-ops')
  })

  test('uses the English name when the Japanese name is not ASCII', () => {
    expect(createDirectoryResourceId('team', ['開発部', 'Development'], [])).toBe('development')
    expect(createDirectoryResourceId('team', ['開発部 API', 'Dev API'], [])).toBe('dev-api')
  })

  test('numbers the ID by kind when no name is ASCII', () => {
    expect(createDirectoryResourceId('team', ['開発部', '開発部'], [])).toBe('team-1')
    expect(createDirectoryResourceId('project', ['新規プロジェクト', '新規プロジェクト'], [])).toBe('project-1')
    expect(createDirectoryResourceId('team', ['開発部 API', '開発部 API'], [])).toBe('team-1')
    expect(createDirectoryResourceId('team', ['・・・', '---'], [])).toBe('team-1')
  })

  test('skips IDs already used in the directory', () => {
    expect(createDirectoryResourceId('team', ['開発部', '開発部'], ['team-1', 'team-2'])).toBe('team-3')
    expect(createDirectoryResourceId('team', ['Core Team', 'Core Team'], ['core-team'])).toBe('core-team-2')
    expect(
      createDirectoryResourceId('team', ['Core Team', 'Core Team'], ['core-team', 'core-team-2']),
    ).toBe('core-team-3')
  })

  test('caps long ASCII names without leaving a trailing separator', () => {
    const id = createDirectoryResourceId('project', [`${'a'.repeat(63)} b`, ''], [])

    expect(id).toBe('a'.repeat(63))
  })

  test('produces Team IDs that Triage and Request intake accept for Japanese names', () => {
    const names = ['開発部', '営業・企画', 'カスタマーサポート第２課', '開発部 API', 'ＱＡ']
    const usedIds: string[] = []

    for (const name of names) {
      const id = createDirectoryResourceId('team', [name, name], usedIds)
      usedIds.push(id)
      expect(isTriageTeamIdentifier(id)).toBe(true)
    }
    expect(usedIds).toEqual(['team-1', 'team-2', 'team-3', 'team-4', 'qa'])
  })
})
