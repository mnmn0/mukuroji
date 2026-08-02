import {
  chmod,
  link,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  readWorkspaceSearchMigrationRehearsalPrivateInputFile,
  WorkspaceSearchMigrationRehearsalPrivateInputError,
} from './migration-rehearsal-private-input'

/** Temporary directories removed after every restricted-input test. */
const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true })
  }
})

/** Creates one isolated temporary directory retained for cleanup. */
async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), 'mukuroji-rehearsal-private-input-'),
  )
  temporaryDirectories.push(directory)
  return directory
}

describe('Workspace Search migration rehearsal private input', () => {
  test('reads one exact current-owner mode-0600 single-link file', async () => {
    const directory = await createTemporaryDirectory()
    const path = join(directory, 'input.json')
    const expected = new TextEncoder().encode('{"safe":true}')
    await writeFile(path, expected, { mode: 0o600 })
    await chmod(path, 0o600)

    const actual =
      await readWorkspaceSearchMigrationRehearsalPrivateInputFile(
        path,
        expected.byteLength,
      )

    expect(actual).toEqual(expected)
    expect(actual).not.toBe(expected)
  })

  test('rejects a final symlink without following it', async () => {
    const directory = await createTemporaryDirectory()
    const target = join(directory, 'target.json')
    const alias = join(directory, 'alias.json')
    await writeFile(target, '{"safe":true}', { mode: 0o600 })
    await chmod(target, 0o600)
    await symlink(target, alias)

    expect(
      readWorkspaceSearchMigrationRehearsalPrivateInputFile(alias, 1_024),
    ).rejects.toBeInstanceOf(
      WorkspaceSearchMigrationRehearsalPrivateInputError,
    )
  })

  test('rejects group or world permission bits', async () => {
    const directory = await createTemporaryDirectory()
    const path = join(directory, 'shared.json')
    await writeFile(path, '{"safe":true}', { mode: 0o600 })
    await chmod(path, 0o640)

    expect(
      readWorkspaceSearchMigrationRehearsalPrivateInputFile(path, 1_024),
    ).rejects.toMatchObject({ code: 'INVALID_PRIVATE_INPUT' })
  })

  test('rejects a private inode reachable through multiple hard links', async () => {
    const directory = await createTemporaryDirectory()
    const path = join(directory, 'input.json')
    const alias = join(directory, 'alias.json')
    await writeFile(path, '{"safe":true}', { mode: 0o600 })
    await chmod(path, 0o600)
    await link(path, alias)

    expect(
      readWorkspaceSearchMigrationRehearsalPrivateInputFile(path, 1_024),
    ).rejects.toMatchObject({ code: 'INVALID_PRIVATE_INPUT' })
  })

  test('rejects empty, oversized, and invalid-limit inputs', async () => {
    const directory = await createTemporaryDirectory()
    const emptyPath = join(directory, 'empty.json')
    const fullPath = join(directory, 'full.json')
    await writeFile(emptyPath, '', { mode: 0o600 })
    await writeFile(fullPath, 'ab', { mode: 0o600 })
    await chmod(emptyPath, 0o600)
    await chmod(fullPath, 0o600)

    expect(
      readWorkspaceSearchMigrationRehearsalPrivateInputFile(
        emptyPath,
        1,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PRIVATE_INPUT' })
    expect(
      readWorkspaceSearchMigrationRehearsalPrivateInputFile(fullPath, 1),
    ).rejects.toMatchObject({ code: 'INVALID_PRIVATE_INPUT' })
    expect(
      readWorkspaceSearchMigrationRehearsalPrivateInputFile(fullPath, 0),
    ).rejects.toMatchObject({ code: 'INVALID_PRIVATE_INPUT' })
  })
})
