/** Largest webhook body read. GitHub caps deliveries at 25 MB; the events read here are far smaller. */
export const GITHUB_WEBHOOK_MAX_BODY_BYTES = 5 * 1024 * 1024

/** Result of reading a webhook body. */
export type GitHubWebhookBodyRead =
  | { kind: 'body', bytes: Uint8Array }
  | { kind: 'too-large' }

/**
 * Reads a webhook body without reading past {@link GITHUB_WEBHOOK_MAX_BODY_BYTES}.
 *
 * @param request - Untrusted request.
 * @param maximumBytes - Largest body read.
 * @returns The exact bytes, or `too-large`.
 */
export async function readGitHubWebhookBody(
  request: Request,
  maximumBytes = GITHUB_WEBHOOK_MAX_BODY_BYTES,
): Promise<GitHubWebhookBodyRead> {
  const declared = Number(request.headers.get('Content-Length') ?? '0')
  if (Number.isFinite(declared) && declared > maximumBytes) return { kind: 'too-large' }
  if (!request.body) return { kind: 'body', bytes: new Uint8Array() }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel()
        return { kind: 'too-large' }
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { kind: 'body', bytes }
}
