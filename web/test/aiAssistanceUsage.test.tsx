import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { getAiAssistanceUsage } from '../src/features/ai-assistance/api'
import { aiAssistanceUsageFixture } from '../src/features/ai-assistance/fixtures'
import { AiAssistanceUsageSection } from '../src/features/ai-assistance/ui/AiAssistanceUsageSection'
import { createTranslator } from '../src/shared/i18n/i18n'

const t = createTranslator('en')
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('AI usage API', () => {
  test('requests the chosen month and returns the validated summary', async () => {
    const urls: string[] = []
    globalThis.fetch = async (input) => {
      urls.push(input instanceof Request ? input.url : String(input))
      return Response.json(aiAssistanceUsageFixture)
    }

    expect(await getAiAssistanceUsage('access-token', '2026-11')).toEqual(aiAssistanceUsageFixture)
    expect(urls[0]).toEndWith('/api/ai-assistance/usage?month=2026-11')
  })

  test('rejects a negative count, a malformed month, or an over-long member ID, and drops unknown fields', async () => {
    globalThis.fetch = async () => Response.json({
      ...aiAssistanceUsageFixture,
      totals: { ...aiAssistanceUsageFixture.totals, inputTokens: -1 },
    })
    await expect(getAiAssistanceUsage('access-token')).rejects.toBeDefined()

    globalThis.fetch = async () => Response.json({ ...aiAssistanceUsageFixture, month: '2026-13' })
    await expect(getAiAssistanceUsage('access-token')).rejects.toBeDefined()

    const longMember = { ...aiAssistanceUsageFixture.members[0], memberId: 'm'.repeat(320) }
    globalThis.fetch = async () => Response.json({ ...aiAssistanceUsageFixture, members: [longMember] })
    expect((await getAiAssistanceUsage('access-token')).members[0]?.memberId).toHaveLength(320)

    globalThis.fetch = async () => Response.json({
      ...aiAssistanceUsageFixture,
      members: [{ ...longMember, memberId: 'm'.repeat(321) }],
    })
    await expect(getAiAssistanceUsage('access-token')).rejects.toBeDefined()

    globalThis.fetch = async () => Response.json({ ...aiAssistanceUsageFixture, unexpected: true })
    expect(await getAiAssistanceUsage('access-token')).toEqual(aiAssistanceUsageFixture)
  })
})

describe('AiAssistanceUsageSection', () => {
  test('shows the totals against the cap, the 80% notice, and both breakdowns', () => {
    const html = renderToStaticMarkup(
      <AiAssistanceUsageSection
        locale="en"
        resolveMemberLabel={(memberId) => (memberId === 'member-aiko' ? 'Aiko' : undefined)}
        t={t}
        usage={aiAssistanceUsageFixture}
      />,
    )

    expect(html).toContain('AI usage this month has reached 80% of a monthly limit.')
    expect(html).toContain('908,700')
    expect(html).toContain('$41.27 (+1 without an estimate) / $50.00')
    expect(html).toContain('Aiko')
    expect(html).toContain('member-ren')
  })

  test('shows the exhausted and paused notices instead of the warning', () => {
    const html = renderToStaticMarkup(
      <AiAssistanceUsageSection
        locale="en"
        t={t}
        usage={{ ...aiAssistanceUsageFixture, deploymentPaused: true, exhausted: true }}
      />,
    )

    expect(html).toContain('reached a monthly limit')
    expect(html).toContain('paused AI assistance for the whole deployment')
    expect(html).not.toContain('has reached 80%')
  })

  test('offers a retry when the usage could not be loaded', () => {
    const html = renderToStaticMarkup(
      <AiAssistanceUsageSection loadError locale="en" onRetry={() => undefined} t={t} />,
    )

    expect(html).toContain('role="alert"')
    expect(html).toContain('<button')
  })
})
