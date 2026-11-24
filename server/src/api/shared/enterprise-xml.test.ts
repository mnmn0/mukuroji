import { describe, expect, test } from 'bun:test'
import { decodeEnterpriseXml } from './enterprise-xml'

describe('decodeEnterpriseXml', () => {
  test('decodes the predefined entities once', () => {
    expect(decodeEnterpriseXml('a&lt;b&gt;c&quot;d&apos;e&amp;f')).toBe('a<b>c"d\'e&f')
  })

  test('keeps an escaped entity as text instead of decoding it twice', () => {
    expect(decodeEnterpriseXml('&amp;lt;')).toBe('&lt;')
    expect(decodeEnterpriseXml('https://idp.example/sso?a=1&amp;amp;b=2')).toBe('https://idp.example/sso?a=1&amp;b=2')
  })
})
