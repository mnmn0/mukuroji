import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveStaticFile } from './serve-static-directory'

describe('resolveStaticFile', () => {
  test('serves files under the root and rejects paths that escape it', () => {
    const parent = mkdtempSync(join(tmpdir(), 'static-root-'))
    const root = join(parent, 'site')
    mkdirSync(join(root, 'assets'), { recursive: true })
    writeFileSync(join(root, 'index.html'), '<!doctype html>')
    writeFileSync(join(root, 'assets', 'app.js'), '')
    mkdirSync(join(parent, 'site-other'))
    writeFileSync(join(parent, 'site-other', 'secret.txt'), '')
    writeFileSync(join(parent, 'outside.txt'), '')

    expect(resolveStaticFile(root, '/')).toBe(join(root, 'index.html'))
    expect(resolveStaticFile(root, '/assets/app.js')).toBe(join(root, 'assets', 'app.js'))
    expect(resolveStaticFile(root, '/../outside.txt')).toBeUndefined()
    // A sibling whose name starts with the root's name is still outside the root.
    expect(resolveStaticFile(root, '/../site-other/secret.txt')).toBeUndefined()
    expect(resolveStaticFile(root, '/missing.js')).toBeUndefined()
  })
})
