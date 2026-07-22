import { expect, test } from 'bun:test'
import { InMemoryEnterpriseIdentityClient } from '../../enterprise-identity'
import { createEnterpriseIdentityCapabilities } from './enterprise-identity-capabilities'

test('exposes disjoint runtime capability views', () => {
  const capabilities = createEnterpriseIdentityCapabilities(
    new InMemoryEnterpriseIdentityClient(),
  )

  expect(Object.keys(capabilities.read).sort()).toEqual([
    'getActiveBreakGlassActivation',
    'getSnapshot',
  ])
  expect('issueScimToken' in capabilities.read).toBe(false)
  expect('rotateServiceAccountToken' in capabilities.scimDirectory).toBe(false)
  expect('getSnapshot' in capabilities.scimAuthentication).toBe(false)
  expect('issueScimToken' in capabilities.scimAuthentication).toBe(false)
  expect('authenticateScimToken' in capabilities.scimCredentialAdministration).toBe(false)
  expect('putIdentityProvider' in capabilities.ssoDiscovery).toBe(false)
  expect(
    'authenticateServiceAccountToken' in capabilities.serviceAccountAdministration,
  ).toBe(false)
  expect(
    'rotateServiceAccountToken' in capabilities.serviceAccountAuthentication,
  ).toBe(false)
})
