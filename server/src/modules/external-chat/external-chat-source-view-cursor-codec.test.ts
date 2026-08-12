import { describe, expect, test } from 'bun:test'
import type { ExternalChatSyncCursorScope } from './external-chat-sync-service'
import {
  AuthenticatedExternalChatSyncCursorCodec,
  type ExternalChatSourceViewCursorClockPort,
  type ExternalChatSourceViewCursorKey,
  type ExternalChatSourceViewCursorKeyPort,
} from './external-chat-source-view-cursor-codec'

const initialNow = '2026-08-06T03:00:00.000Z'

/** Mutable canonical clock used by expiry tests. */
class CursorClock implements ExternalChatSourceViewCursorClockPort {
  /** Current canonical timestamp. */
  current = initialNow

  /** Returns the configured cursor clock timestamp. */
  now(): string {
    return this.current
  }
}

/** Workspace-scoped in-memory cursor key ring used by codec contract tests. */
class CursorKeys implements ExternalChatSourceViewCursorKeyPort {
  /** Current active rotation identifier. */
  activeKeyId = 'cursor-key-one'

  /** Retained keys by rotation identifier. */
  readonly records = new Map<string, ExternalChatSourceViewCursorKey>([
    ['cursor-key-one', createKey('cursor-key-one', 11)],
    ['cursor-key-two', createKey('cursor-key-two', 29)],
  ])

  /** Resolves the active key for new cursor encryption. */
  async getActiveKey(workspaceId: string): Promise<ExternalChatSourceViewCursorKey> {
    requireFixtureWorkspace(workspaceId)
    const key = this.records.get(this.activeKeyId)
    if (!key) throw new Error('Expected the active fixture cursor key.')
    return key
  }

  /** Resolves one active or retained key for decryption. */
  async getKey(
    workspaceId: string,
    keyId: string,
  ): Promise<ExternalChatSourceViewCursorKey | undefined> {
    requireFixtureWorkspace(workspaceId)
    return this.records.get(keyId)
  }
}

describe('AuthenticatedExternalChatSyncCursorCodec', () => {
  test('encrypts the provider cursor and round-trips only in its exact scope', async () => {
    const fixture = createCodecFixture()
    const scope = createCursorScope()
    const providerCursor = 'provider-private-cursor:page-2'

    const cursor = await fixture.codec.encode(scope, providerCursor)

    expect(cursor).toStartWith('v1.cursor-key-one.')
    expect(cursor).not.toContain(providerCursor)
    expect(cursor).not.toContain(scope.workspaceId)
    await expect(fixture.codec.decode(scope, cursor)).resolves.toBe(providerCursor)

    const mismatchedScopes: ExternalChatSyncCursorScope[] = [
      { ...scope, principalId: 'principal-other' },
      { ...scope, linkId: 'link-other' },
      { ...scope, provider: 'microsoft-teams' },
      { ...scope, linkRevision: scope.linkRevision + 1 },
      { ...scope, authorizationRevision: scope.authorizationRevision + 1 },
    ]
    for (const mismatched of mismatchedScopes) {
      await expect(fixture.codec.decode(mismatched, cursor)).rejects.toMatchObject({
        code: 'ExternalChatValidationFailed',
      })
    }
  })

  test('rejects tampering and expires the authenticated cursor at its boundary', async () => {
    const fixture = createCodecFixture(60_000)
    const scope = createCursorScope()
    const cursor = await fixture.codec.encode(scope, 'private-page-two')
    const final = cursor.at(-1)
    if (!final) throw new Error('Expected an encoded cursor.')
    const tampered = `${cursor.slice(0, -1)}${final === 'A' ? 'B' : 'A'}`

    await expect(fixture.codec.decode(scope, tampered)).rejects.toMatchObject({
      code: 'ExternalChatValidationFailed',
    })
    fixture.clock.current = '2026-08-06T03:00:59.999Z'
    await expect(fixture.codec.decode(scope, cursor)).resolves.toBe('private-page-two')
    fixture.clock.current = '2026-08-06T03:01:00.000Z'
    await expect(fixture.codec.decode(scope, cursor)).rejects.toMatchObject({
      code: 'ExternalChatValidationFailed',
    })
  })

  test('decrypts retained rotation keys and fails closed after their removal', async () => {
    const fixture = createCodecFixture()
    const scope = createCursorScope()
    const oldCursor = await fixture.codec.encode(scope, 'old-key-provider-cursor')
    fixture.keys.activeKeyId = 'cursor-key-two'
    const newCursor = await fixture.codec.encode(scope, 'new-key-provider-cursor')

    await expect(fixture.codec.decode(scope, oldCursor)).resolves.toBe('old-key-provider-cursor')
    await expect(fixture.codec.decode(scope, newCursor)).resolves.toBe('new-key-provider-cursor')
    fixture.keys.records.delete('cursor-key-one')
    await expect(fixture.codec.decode(scope, oldCursor)).rejects.toMatchObject({
      code: 'ExternalChatValidationFailed',
    })
  })

  test('rejects malformed envelopes, noncanonical tokens, and oversized TTL policies', async () => {
    const fixture = createCodecFixture()
    const scope = createCursorScope()
    const cursor = await fixture.codec.encode(scope, 'private-page-two')
    const parts = cursor.split('.')
    const invalidCursors = [
      parts.slice(0, 4).join('.'),
      ['v2', ...parts.slice(1)].join('.'),
      [parts[0], parts[1], 'AA', parts[3], parts[4]].join('.'),
      [parts[0], parts[1], parts[2], parts[3], 'AA'].join('.'),
      [parts[0], parts[1], `${parts[2]}=`, parts[3], parts[4]].join('.'),
    ]
    for (const invalid of invalidCursors) {
      await expect(fixture.codec.decode(scope, invalid)).rejects.toMatchObject({
        code: 'ExternalChatValidationFailed',
      })
    }
    expect(() => createCodecFixture(24 * 60 * 60 * 1_000 + 1)).toThrow(
      'The external chat cursor lifetime is invalid.',
    )
  })
})

/** Complete cursor codec fixture. */
type CursorCodecFixture = {
  /** Authenticated codec under test. */
  codec: AuthenticatedExternalChatSyncCursorCodec
  /** Mutable clock. */
  clock: CursorClock
  /** Mutable rotation key ring. */
  keys: CursorKeys
}

/** Creates one isolated authenticated cursor codec fixture. */
function createCodecFixture(ttlMs = 15 * 60 * 1_000): CursorCodecFixture {
  const clock = new CursorClock()
  const keys = new CursorKeys()
  const codec = new AuthenticatedExternalChatSyncCursorCodec({
    keys,
    clock,
    options: { ttlMs },
  })
  return { codec, clock, keys }
}

/** Creates one exact viewer/link/provider authorization scope. */
function createCursorScope(): ExternalChatSyncCursorScope {
  return {
    workspaceId: 'workspace-cursor',
    principalId: 'principal-cursor',
    linkId: 'link-cursor',
    provider: 'slack',
    linkRevision: 4,
    authorizationRevision: 9,
  }
}

/** Creates one deterministic 32-byte fixture rotation key. */
function createKey(keyId: string, byte: number): ExternalChatSourceViewCursorKey {
  return { keyId, key: new Uint8Array(32).fill(byte) }
}

/** Requires the only Workspace owned by the fixture key ring. */
function requireFixtureWorkspace(workspaceId: string): void {
  if (workspaceId !== 'workspace-cursor') throw new Error('Cursor key Workspace mismatch.')
}
