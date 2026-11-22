import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { BuildDriftBanner } from '../src/app/release/BuildDriftNotice'
import {
  buildDriftPairKey,
  classifyBuildDrift,
  fetchApiCommitSha,
  readApiCommitSha,
} from '../src/shared/release/buildDrift'

const web = '0123456789abcdef0123456789abcdef01234567'
const api = 'fedcba9876543210fedcba9876543210fedcba98'

describe('build drift', () => {
  test('reads only one full lowercase SHA from the health body', () => {
    expect(readApiCommitSha({ ok: true, applicationCommitSha: api })).toBe(api)
    for (const body of [null, 'x', {}, { applicationCommitSha: api.toUpperCase() }, { applicationCommitSha: `${api}0` }, { applicationCommitSha: 42 }]) {
      expect(readApiCommitSha(body)).toBeUndefined()
    }
  })

  test('reports drift only when both builds report different commits', () => {
    expect(classifyBuildDrift({ webCommitSha: web, apiCommitSha: web }, undefined)).toBe('none')
    expect(classifyBuildDrift({ webCommitSha: undefined, apiCommitSha: api }, undefined)).toBe('none')
    expect(classifyBuildDrift({ webCommitSha: web, apiCommitSha: undefined }, undefined)).toBe('none')
    expect(classifyBuildDrift({ webCommitSha: web, apiCommitSha: api }, undefined)).toBe('drift')
  })

  test('says a reload did not help only for the pair the user reloaded for', () => {
    const pair = buildDriftPairKey({ webCommitSha: web, apiCommitSha: api })
    expect(classifyBuildDrift({ webCommitSha: web, apiCommitSha: api }, pair)).toBe('persisting')
    const later = 'a'.repeat(40)
    expect(classifyBuildDrift({ webCommitSha: web, apiCommitSha: later }, pair)).toBe('drift')
  })

  test('asks /health without cache or credentials and rejects error answers', async () => {
    const requests: { url: string, init: RequestInit | undefined }[] = []
    const send = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init })
      return Response.json({ ok: true, status: 'alive', applicationCommitSha: api })
    }) satisfies typeof fetch
    expect(await fetchApiCommitSha('/api', send)).toBe(api)
    expect(requests[0].url).toBe('/api/health')
    expect(requests[0].init?.cache).toBe('no-store')
    expect(requests[0].init?.credentials).toBe('omit')

    const failing = (async () => new Response('', { status: 503 })) satisfies typeof fetch
    await expect(fetchApiCommitSha('/api', failing)).rejects.toThrow('503')
  })

  test('renders nothing while the builds match and a localized notice otherwise', () => {
    const noop = () => undefined
    expect(renderToStaticMarkup(<BuildDriftBanner state="none" onReload={noop} onDismiss={noop} />)).toBe('')
    const drift = renderToStaticMarkup(<BuildDriftBanner state="drift" onReload={noop} onDismiss={noop} />)
    expect(drift).toContain('role="status"')
    expect(drift).toContain('画面とサーバーのバージョンが異なります')
    const persisting = renderToStaticMarkup(<BuildDriftBanner state="persisting" onReload={noop} onDismiss={noop} />)
    expect(persisting).toContain('数分後にもう一度再読み込み')
  })
})
