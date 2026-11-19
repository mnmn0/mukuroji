import { describe, expect, test } from 'bun:test'
import { buildWebCspMetaPolicy, injectWebCspMeta } from './inject-web-csp-meta'

/** Stack outputs of a typical deployment. */
const deployedValues = {
  fileBucketName: 'mukuroji-filebucketcdfcd6de-1a2b3c4d5e6f',
  region: 'ap-northeast-1',
  realtimeWebSocketUrl: 'wss://abc123.execute-api.ap-northeast-1.amazonaws.com/production',
}

describe('buildWebCspMetaPolicy', () => {
  test('names only the realtime API and the stack file bucket', () => {
    expect(buildWebCspMetaPolicy(deployedValues)).toBe(
      "connect-src 'self' wss://abc123.execute-api.ap-northeast-1.amazonaws.com "
      + 'https://mukuroji-filebucketcdfcd6de-1a2b3c4d5e6f.s3.ap-northeast-1.amazonaws.com; '
      + "img-src 'self' data: blob: https://mukuroji-filebucketcdfcd6de-1a2b3c4d5e6f.s3.ap-northeast-1.amazonaws.com; "
      + "media-src 'self' blob: https://mukuroji-filebucketcdfcd6de-1a2b3c4d5e6f.s3.ap-northeast-1.amazonaws.com",
    )
  })

  test('uses the China endpoint suffix in China regions', () => {
    expect(buildWebCspMetaPolicy({ ...deployedValues, region: 'cn-north-1' }))
      .toContain('.s3.cn-north-1.amazonaws.com.cn')
  })

  test.each([
    ['a bucket name with a wildcard', { fileBucketName: '*' }],
    ['a bucket name that could close the attribute', { fileBucketName: 'files" onload="x' }],
    ['a dotted bucket name', { fileBucketName: 'files.example' }],
    ['an invalid region', { region: 'ap-northeast-1; script-src *' }],
    ['a non-WebSocket realtime URL', { realtimeWebSocketUrl: 'https://abc123.execute-api.ap-northeast-1.amazonaws.com/production' }],
    ['a realtime URL with credentials', { realtimeWebSocketUrl: 'wss://user:pass@abc123.execute-api.ap-northeast-1.amazonaws.com/production' }],
  ])('rejects %s', (_label, override) => {
    expect(() => buildWebCspMetaPolicy({ ...deployedValues, ...override })).toThrow()
  })
})

describe('injectWebCspMeta', () => {
  const html = [
    '<!doctype html>',
    '<html lang="ja">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <script src="/theme-bootstrap.js"></script>',
    '  </head>',
    '</html>',
  ].join('\n')

  test('puts the policy before every script', () => {
    const result = injectWebCspMeta(html, "connect-src 'self'")
    const metaIndex = result.indexOf('<meta http-equiv="Content-Security-Policy" content="connect-src \'self\'" />')

    expect(metaIndex).toBeGreaterThan(result.indexOf('<meta charset="UTF-8" />'))
    expect(metaIndex).toBeLessThan(result.indexOf('<script'))
  })

  test('refuses HTML that already declares a policy', () => {
    const once = injectWebCspMeta(html, "connect-src 'self'")
    expect(() => injectWebCspMeta(once, "connect-src 'self'")).toThrow('already declares')
  })

  test('refuses HTML without the charset tag', () => {
    expect(() => injectWebCspMeta('<html><head></head></html>', "connect-src 'self'")).toThrow('charset')
  })
})
