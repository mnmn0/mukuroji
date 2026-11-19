import { z } from 'zod'
import type { CodingAgentMcpCompatibility } from '@mukuroji/contracts'

/** Largest health response body read, in bytes; a liveness body is far smaller. */
const maximumHealthBytes = 16 * 1024

const revision = z.number().int().positive().max(1_000_000)
const healthSchema = z.object({
  codingAgentMcp: z.object({ apiRevision: revision, minimumApiRevision: revision })
    .refine((range) => range.minimumApiRevision <= range.apiRevision),
})

/**
 * Reads a response body up to a byte limit.
 *
 * @param response - Response whose body is read.
 * @returns The body text, or undefined when it is missing or larger than the limit.
 */
async function readBoundedText(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader()
  if (!reader) return undefined
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maximumHealthBytes) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/**
 * Reads the MCP API revisions a server serves from its unauthenticated liveness endpoint.
 *
 * No credential is sent, and any failure (old server, network error, unexpected body) returns
 * undefined so that startup never fails because of this check.
 *
 * @param origin - Validated Mukuroji origin from MUKUROJI_MCP_URL.
 * @param fetcher - HTTP transport, injectable for isolated tests.
 * @returns The served range, or undefined when the server did not report one.
 */
export async function readServerCompatibility(
  origin: string,
  fetcher: (url: URL, init: RequestInit) => Promise<Response> = fetch,
): Promise<CodingAgentMcpCompatibility | undefined> {
  try {
    const response = await fetcher(new URL('/api/health', origin), {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5_000), headers: { Accept: 'application/json' },
    })
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel()
      return undefined
    }
    const text = await readBoundedText(response)
    if (text === undefined) return undefined
    const parsed = healthSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data.codingAgentMcp : undefined
  } catch {
    return undefined
  }
}
