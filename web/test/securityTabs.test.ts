import { describe, expect, test } from 'bun:test'
import {
  enterpriseSecurityTabs,
  readEnterpriseSecurityTab,
  resolveEnterpriseSecurityTabTarget,
} from '../src/security/model/tabs'

describe('enterprise security tabs', () => {
  test('accepts supported URL state and falls back to overview', () => {
    expect(readEnterpriseSecurityTab('provisioning')).toBe('provisioning')
    expect(readEnterpriseSecurityTab('unknown')).toBe('overview')
    expect(readEnterpriseSecurityTab(null)).toBe('overview')
  })

  test('wraps arrow navigation and supports Home and End', () => {
    expect(
      resolveEnterpriseSecurityTabTarget(
        'overview',
        'ArrowLeft',
        enterpriseSecurityTabs,
      ),
    ).toBe('privileged')
    expect(
      resolveEnterpriseSecurityTabTarget(
        'privileged',
        'ArrowRight',
        enterpriseSecurityTabs,
      ),
    ).toBe('overview')
    expect(
      resolveEnterpriseSecurityTabTarget(
        'sessions',
        'Home',
        enterpriseSecurityTabs,
      ),
    ).toBe('overview')
    expect(
      resolveEnterpriseSecurityTabTarget(
        'identity',
        'End',
        enterpriseSecurityTabs,
      ),
    ).toBe('privileged')
  })

  test('ignores unrelated keys and missing current tabs', () => {
    expect(
      resolveEnterpriseSecurityTabTarget(
        'identity',
        'Enter',
        enterpriseSecurityTabs,
      ),
    ).toBeUndefined()
    expect(
      resolveEnterpriseSecurityTabTarget('identity', 'ArrowRight', [
        'overview',
      ]),
    ).toBeUndefined()
  })
})
