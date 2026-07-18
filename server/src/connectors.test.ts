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
    expect(decideConnectorInboundSync({
      state,
      eventId: 'evt_old',
      externalVersion: '11',
      actualWorkItemRevision: 4,
      originSigningSecret: ORIGIN_SIGNING_SECRET,
    }).kind).toBe('duplicate')
    expect(decideConnectorInboundSync({
      state,
      eventId: 'evt_echo',
      externalVersion: '11',
      originMarker: createConnectorOriginMarker(
        'ins_1',
        'link_1',
        4,
        'operation-1',
        ORIGIN_SIGNING_SECRET,
      ),
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
})
