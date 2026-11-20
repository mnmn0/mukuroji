import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  createAccessToken,
  getTestAppDependencies,
  resetTestApp,
  setTestAppDependencies,
  withTestEnvironment,
} = createApiTestHarness()
import type { AuditEventV1 as AuditEvent } from '../../../audit/audit'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

afterEach(() => {
  resetTestApp()
})

/** Cognito configuration that binds accepted access tokens to one user pool and client. */
const COGNITO_ENVIRONMENT = {
  AUDIT_EVENTS_TABLE_NAME: 'rejection-audit-test',
  COGNITO_USER_POOL_ID: 'ap-northeast-1_rejection',
  COGNITO_CLIENT_ID: 'mukuroji-main-client',
  COGNITO_SSO_CLIENT_ID: undefined,
  COGNITO_ISSUER: undefined,
}

/** Issuer of the configured Cognito user pool. */
const CONFIGURED_ISSUER = 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_rejection'

/**
 * Captures the audit events the rejection middleware writes.
 *
 * @returns The captured events, appended as they are written.
 */
function captureAuditEvents() {
  const events: AuditEvent[] = []
  const auditEvents = getTestAppDependencies().workspace.auditEvents
  setTestAppDependencies({
    auditEvents: {
      ...auditEvents,
      async putEvent(event: AuditEvent) {
        events.push(event)
      },
    },
  })
  return events
}

/**
 * Sends a rejected Enterprise Security mutation.
 *
 * @param claims - Access token claims of the caller.
 * @returns The response.
 */
async function sendRejectedPolicyUpdate(claims: Record<string, unknown>) {
  return await app.request('/api/enterprise/security/policy', {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${createAccessToken([], claims)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  })
}

test('records a rejected Enterprise Security mutation from an active member of the configured pool', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'member' })
  const events = captureAuditEvents()

  await withTestEnvironment(COGNITO_ENVIRONMENT, async () => {
    const response = await sendRejectedPolicyUpdate({
      iss: CONFIGURED_ISSUER,
      client_id: 'mukuroji-main-client',
      token_use: 'access',
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  expect(events.map((event) => event.eventType)).toEqual(['enterprise-security.request-rejected'])
})

test('does not record a rejected mutation for a token from another user pool', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'member' })
  const events = captureAuditEvents()

  await withTestEnvironment(COGNITO_ENVIRONMENT, async () => {
    const response = await sendRejectedPolicyUpdate({
      iss: 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_other',
      client_id: 'mukuroji-main-client',
      token_use: 'access',
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  expect(events).toEqual([])
})

test('does not record a rejected mutation for a deactivated member', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'member', workspaceStatus: 'deactivated' })
  const events = captureAuditEvents()

  await withTestEnvironment(COGNITO_ENVIRONMENT, async () => {
    const response = await sendRejectedPolicyUpdate({
      iss: CONFIGURED_ISSUER,
      client_id: 'mukuroji-main-client',
      token_use: 'access',
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  expect(events).toEqual([])
})
