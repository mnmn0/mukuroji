import { describe, expect, test } from 'bun:test'
import { InvalidLocalEnvironmentError, planLocalEnvironment, readLocalSecrets } from './local-env'

const template = [
  '# comment',
  'MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY=',
  'ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET=',
  '# FLOCI_PORT=4566',
  '',
].join('\n')
const keyA = 'a'.repeat(64)
const keyB = 'b'.repeat(64)

/**
 * Returns a generator that yields the given values in order.
 *
 * @param values - Values to return on successive calls.
 * @returns The generator function.
 */
function sequence(...values: string[]): () => string {
  let index = 0
  return () => values[index++] ?? 'unexpected'
}

describe('planLocalEnvironment', () => {
  test('creates .env from the template and fills both secrets', () => {
    const plan = planLocalEnvironment(undefined, template, sequence(keyA, keyB))
    expect(plan.generated).toEqual(['MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY', 'ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET'])
    expect(plan.content).toBe(
      ['# comment', `MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY=${keyA}`, `ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET=${keyB}`, '# FLOCI_PORT=4566', ''].join('\n'),
    )
  })

  test('leaves a complete .env unchanged', () => {
    const existing = `MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY="${keyA}"\nexport ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET=${keyB}\n`
    const plan = planLocalEnvironment(existing, template, sequence())
    expect(plan).toEqual({ content: undefined, generated: [] })
  })

  test('appends only the missing secret and keeps other lines', () => {
    const existing = `FLOCI_PORT=4567\nMUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY=${keyA}\n`
    const plan = planLocalEnvironment(existing, template, sequence(keyB))
    expect(plan.generated).toEqual(['ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET'])
    expect(plan.content).toBe(`FLOCI_PORT=4567\nMUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY=${keyA}\nENTERPRISE_IDENTITY_TOKEN_HASH_SECRET=${keyB}\n`)
  })

  test('fills an empty secret in place', () => {
    const existing = `MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY=\nENTERPRISE_IDENTITY_TOKEN_HASH_SECRET=${keyB}`
    const plan = planLocalEnvironment(existing, template, sequence(keyA))
    expect(plan.content).toBe(`MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY=${keyA}\nENTERPRISE_IDENTITY_TOKEN_HASH_SECRET=${keyB}`)
  })

  test('accepts a valid secret followed by an inline comment', () => {
    const existing = `MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY=${keyA} # stable local key\nENTERPRISE_IDENTITY_TOKEN_HASH_SECRET=${keyB}\n`
    expect(planLocalEnvironment(existing, template, sequence())).toEqual({ content: undefined, generated: [] })
  })

  test('refuses to replace a malformed existing secret', () => {
    const existing = `MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY=not-hex\nENTERPRISE_IDENTITY_TOKEN_HASH_SECRET=${keyB}\n`
    expect(() => planLocalEnvironment(existing, template, sequence(keyA))).toThrow(InvalidLocalEnvironmentError)
  })
})

describe('readLocalSecrets', () => {
  test('ignores inline comments and quotes', () => {
    const content = `MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY=${keyA} # stable local key\nENTERPRISE_IDENTITY_TOKEN_HASH_SECRET="${keyB}" # quoted\n`
    expect(readLocalSecrets(content)).toEqual({
      MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY: keyA,
      ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET: keyB,
    })
  })

  test('omits empty secrets', () => {
    expect(readLocalSecrets('MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY=\n')).toEqual({})
  })
})
