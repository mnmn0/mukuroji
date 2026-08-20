import { afterEach, describe, expect, test } from 'bun:test'
import {
  getProjectDirectory,
  ProjectDirectoryApiError,
} from '../src/projects/api'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('enterprise session API error propagation', () => {
  test('preserves a structured session code from the project directory API', async () => {
    installErrorResponse(403, 'EnterpriseSessionIpDenied')

    const error = await getProjectDirectory('access-token', 'ja')
      .catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ProjectDirectoryApiError)
    expect(error).toMatchObject({
      code: 'EnterpriseSessionIpDenied',
      status: 403,
    })
  })

})

function installErrorResponse(status: number, code: string) {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    code,
    message: 'Enterprise session policy rejected the request.',
  }), {
    headers: { 'Content-Type': 'application/json' },
    status,
  })) as typeof fetch
}
