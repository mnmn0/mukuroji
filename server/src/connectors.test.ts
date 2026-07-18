import { describe, expect, test } from 'bun:test'
import {
  BUILT_IN_CONNECTOR_CATALOG,
  ConnectorAdapterError,
  ConnectorRegistry,
  createConnectorOriginMarker,
  decideConnectorInboundSync,
  type ConnectorAdapter,
} from './connectors'

const ORIGIN_SIGNING_SECRET = 'connector-origin-signing-secret-at-least-thirty-two-bytes'
const PREVIOUS_ORIGIN_SIGNING_SECRET =
  'previous-connector-origin-signing-secret-at-least-thirty-two-bytes'

function createAdapter(): ConnectorAdapter {
  return {
    definition: BUILT_IN_CONNECTOR_CATALOG[0]!,
    async connect() {
      return { accessToken: 'token', externalAccountId: 'org', scopes: ['repo'] }
    },
    async refresh(credential) {
      return credential
    },
    async disconnect() {},
    async pull() {
      return { items: [] }
    },
    async push(_credential, mutation) {
      return {
        externalId: mutation.externalId,
        resourceType: mutation.resourceType,
        externalUrl: 'https://github.com/example/repo/issues/1',
        externalVersion: '2',
        metadata: {},
        originMarker: mutation.originMarker,
      }
    },
  }
}

describe('ConnectorRegistry', () => {
  test('covers every provider exposed by the developer platform contract', () => {
    expect(BUILT_IN_CONNECTOR_CATALOG.map((definition) => definition.id)).toEqual([
      'github',
      'gitlab',
      'slack',
      'microsoft-teams',
      'gmail',
      'outlook',
      'google-calendar',
      'outlook-calendar',
      'google-drive',
      'onedrive',
      'dropbox',
    ])
  })

  test('source-control adapter を provider ID で解決する', () => {
    const registry = new ConnectorRegistry([createAdapter()])
    expect(registry.get('github').definition.category).toBe('source-control')
    expect(() => registry.get('slack')).toThrow(ConnectorAdapterError)
  })

  test('rejects adapter metadata or resource capabilities that drift from the catalog', () => {
    for (const definition of [
      { ...BUILT_IN_CONNECTOR_CATALOG[0]!, name: 'GitHub Enterprise' },
      { ...BUILT_IN_CONNECTOR_CATALOG[0]!, usesOAuthPkce: false },
      { ...BUILT_IN_CONNECTOR_CATALOG[0]!, resourceTypes: ['issue'] as const },
      {
        ...BUILT_IN_CONNECTOR_CATALOG[0]!,
        resourceTypes: ['issue', 'merge-request', 'commit', 'deploy', 'issue'] as const,
      },
    ]) {
      expect(() => new ConnectorRegistry([{
        ...createAdapter(),
        definition: {
          ...definition,
          resourceTypes: [...definition.resourceTypes],
        },
      }])).toThrow(ConnectorAdapterError)
    }
  })
})

describe('connector sync recovery', () => {
  const state = {
    installationId: 'ins_1',
    linkId: 'link_1',
    workItemRevision: 4,
    lastExternalVersion: '10',
    lastExternalEventId: 'evt_old',
  }

  test('duplicate/self-origin/out-of-order event を side effect なしで skip する', () => {
    const originMarker = createConnectorOriginMarker(
      'ins_1',
      'link_1',
      4,
      'operation-1',
      ORIGIN_SIGNING_SECRET,
    )
    expect(decideConnectorInboundSync({
      state,
      eventId: 'evt_old',
      externalVersion: '11',
      actualWorkItemRevision: 4,
      originSigningSecret: ORIGIN_SIGNING_SECRET,
    }).kind).toBe('duplicate')
    expect(decideConnectorInboundSync({
      state: { ...state, lastExternalVersion: '11' },
      eventId: 'evt_echo',
      externalVersion: '11',
      originMarker,
      expectedOriginMarker: originMarker,
      actualWorkItemRevision: 4,
      originSigningSecret: ORIGIN_SIGNING_SECRET,
    }).kind).toBe('self-origin')
    expect(decideConnectorInboundSync({
      state,
      eventId: 'evt_stale',
      externalVersion: '9',
      actualWorkItemRevision: 4,
      originSigningSecret: ORIGIN_SIGNING_SECRET,
    }).kind).toBe('stale')
  })

  test('Work Item revision drift を user-visible conflict にする', () => {
    expect(decideConnectorInboundSync({
      state,
      eventId: 'evt_new',
      externalVersion: '11',
      actualWorkItemRevision: 5,
      originSigningSecret: ORIGIN_SIGNING_SECRET,
    })).toEqual({
      kind: 'conflict',
      reason: 'Work Item changed after the connector link was read.',
      expectedWorkItemRevision: 4,
      actualWorkItemRevision: 5,
    })
  })

  test('新しい version と一致 revision を apply する', () => {
    expect(decideConnectorInboundSync({
      state,
      eventId: 'evt_new',
      externalVersion: '11',
      actualWorkItemRevision: 4,
      originSigningSecret: ORIGIN_SIGNING_SECRET,
    })).toEqual({ kind: 'apply' })
  })

  test('compares integer versions without losing precision', () => {
    expect(decideConnectorInboundSync({
      state: {
        ...state,
        lastExternalVersion: '90071992547409931234567890',
      },
      eventId: 'evt_large_new',
      externalVersion: '90071992547409931234567891',
      actualWorkItemRevision: 4,
      originSigningSecret: ORIGIN_SIGNING_SECRET,
    })).toEqual({ kind: 'apply' })
    expect(decideConnectorInboundSync({
      state: {
        ...state,
        lastExternalVersion: '90071992547409931234567891',
      },
      eventId: 'evt_large_stale',
      externalVersion: '90071992547409931234567890',
      actualWorkItemRevision: 4,
      originSigningSecret: ORIGIN_SIGNING_SECRET,
    }).kind).toBe('stale')
  })

  test('forged origin marker cannot suppress an inbound event', () => {
    const authentic = createConnectorOriginMarker(
      'ins_1',
      'link_1',
      4,
      'operation-1',
      ORIGIN_SIGNING_SECRET,
    )
    const forged = `${authentic.slice(0, -1)}x`
    expect(decideConnectorInboundSync({
      state,
      eventId: 'evt_forged',
      externalVersion: '11',
      originMarker: forged,
      actualWorkItemRevision: 4,
      originSigningSecret: ORIGIN_SIGNING_SECRET,
    })).toEqual({ kind: 'apply' })
  })

  test('accepts an authentic origin marker signed before key rotation', () => {
    const originMarker = createConnectorOriginMarker(
      'ins_1',
      'link_1',
      4,
      'operation-before-rotation',
      PREVIOUS_ORIGIN_SIGNING_SECRET,
    )
    expect(decideConnectorInboundSync({
      state: { ...state, lastExternalVersion: '11' },
      eventId: 'evt_rotated_echo',
      externalVersion: '11',
      originMarker,
      expectedOriginMarker: originMarker,
      actualWorkItemRevision: 4,
      originSigningSecret: ORIGIN_SIGNING_SECRET,
      previousOriginSigningSecrets: [PREVIOUS_ORIGIN_SIGNING_SECRET],
    })).toEqual({
      kind: 'self-origin',
      reason: 'Event echoes a mukuroji outbound mutation.',
    })
    expect(decideConnectorInboundSync({
      state,
      eventId: 'evt_without_grace_key',
      externalVersion: '11',
      originMarker,
      expectedOriginMarker: originMarker,
      actualWorkItemRevision: 4,
      originSigningSecret: ORIGIN_SIGNING_SECRET,
    })).toEqual({ kind: 'apply' })
  })

  test('binds self-origin suppression to the exact operation and returned version', () => {
    const originMarker = createConnectorOriginMarker(
      'ins_1',
      'link_1',
      4,
      'operation-1',
      ORIGIN_SIGNING_SECRET,
    )
    expect(decideConnectorInboundSync({
      state: { ...state, lastExternalVersion: '11' },
      eventId: 'evt_provider_edit',
      externalVersion: '12',
      originMarker,
      expectedOriginMarker: originMarker,
      actualWorkItemRevision: 4,
      originSigningSecret: ORIGIN_SIGNING_SECRET,
    })).toEqual({ kind: 'apply' })
    const anotherOperationMarker = createConnectorOriginMarker(
      'ins_1',
      'link_1',
      4,
      'operation-2',
      ORIGIN_SIGNING_SECRET,
    )
    expect(decideConnectorInboundSync({
      state: { ...state, lastExternalVersion: '11' },
      eventId: 'evt_other_operation',
      externalVersion: '11',
      originMarker: anotherOperationMarker,
      expectedOriginMarker: originMarker,
      actualWorkItemRevision: 4,
      originSigningSecret: ORIGIN_SIGNING_SECRET,
    })).toMatchObject({ kind: 'stale' })
  })
})
