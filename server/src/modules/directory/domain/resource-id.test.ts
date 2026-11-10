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

  test('uses a random kind-prefixed ID when no name is ASCII', () => {
    const fixedSuffix = () => '0a1b2c3d4e5f'

    expect(createDirectoryResourceId('team', ['開発部', '開発部'], [], fixedSuffix)).toBe('team-0a1b2c3d4e5f')
    expect(
      createDirectoryResourceId('project', ['新規プロジェクト', '新規プロジェクト'], [], fixedSuffix),
    ).toBe('project-0a1b2c3d4e5f')
    expect(createDirectoryResourceId('team', ['開発部 API', '開発部 API'], [], fixedSuffix)).toBe('team-0a1b2c3d4e5f')
    expect(createDirectoryResourceId('team', ['・・・', '---'], [], fixedSuffix)).toBe('team-0a1b2c3d4e5f')
    expect(createDirectoryResourceId('team', ['開発部', '開発部'], [])).toMatch(/^team-[0-9a-f]{12}$/u)
  })

  test('gives concurrent creations from the same snapshot different fallback IDs', () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => createDirectoryResourceId('project', ['新規', '新規'], [])),
    )

    expect(ids.size).toBe(50)
  })

  test('skips IDs already used in the directory', () => {
    const suffixes = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc']
    const nextSuffix = () => suffixes.shift() ?? 'dddddddddddd'

    expect(
      createDirectoryResourceId('team', ['開発部', '開発部'], ['team-aaaaaaaaaaaa', 'team-bbbbbbbbbbbb'], nextSuffix),
    ).toBe('team-cccccccccccc')
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
    expect(usedIds.at(-1)).toBe('qa')
    expect(new Set(usedIds).size).toBe(names.length)
  })
})
