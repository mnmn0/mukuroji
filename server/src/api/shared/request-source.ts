import { timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { getConnInfo } from 'hono/aws-lambda'
import type { Context } from 'hono'
import { resolveRequestClientKey } from './http'
import { getEnv } from './runtime-config'

/** Origin header carrying the secret CloudFront adds to every API request. */
export const EDGE_ORIGIN_SECRET_HEADER = 'x-mukuroji-edge-secret'

/** Origin header carrying the viewer address CloudFront observed. */
export const EDGE_VIEWER_ADDRESS_HEADER = 'x-mukuroji-viewer-address'

/** Runtime variable holding the secret CloudFront sends in `EDGE_ORIGIN_SECRET_HEADER`. */
const EDGE_ORIGIN_SECRET_ENVIRONMENT_NAME = 'MUKUROJI_EDGE_ORIGIN_SECRET'

/**
 * Returns the viewer address CloudFront forwarded, when the request proves it came through CloudFront.
 *
 * The HTTP API stays publicly reachable, so a direct caller can send both headers. Only a caller
 * that also knows the origin secret, which CloudFront adds as an origin custom header, gets its
 * forwarded address trusted.
 *
 * @param presentedSecret - Untrusted `EDGE_ORIGIN_SECRET_HEADER` value.
 * @param viewerAddress - Untrusted `EDGE_VIEWER_ADDRESS_HEADER` value.
 * @param expectedSecret - Configured origin secret; blank disables the edge path.
 * @returns The IP literal CloudFront observed, or `undefined` when it cannot be trusted.
 */
export function resolveEdgeViewerAddress(
  presentedSecret: string | undefined,
  viewerAddress: string | undefined,
  expectedSecret: string | undefined,
) {
  if (!expectedSecret || !presentedSecret || viewerAddress === undefined) return undefined
  const presented = Buffer.from(presentedSecret, 'utf8')
  const expected = Buffer.from(expectedSecret, 'utf8')
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return undefined
  }
  const address = viewerAddress.trim()
  return isIP(address) === 0 ? undefined : address
}

/**
 * Resolves the client address used for rate limits and enterprise IP policies.
 *
 * A request that came through CloudFront uses the viewer address CloudFront observed. Any other
 * request uses the transport peer, or the first forwarded address when that peer is a configured
 * trusted proxy.
 *
 * @param c - Hono request context.
 * @returns The trusted client address, or a stable unavailable marker.
 */
export function resolveTrustedRequestSource(c: Context) {
  const edgeViewerAddress = resolveEdgeViewerAddress(
    c.req.header(EDGE_ORIGIN_SECRET_HEADER),
    c.req.header(EDGE_VIEWER_ADDRESS_HEADER),
    getEnv(EDGE_ORIGIN_SECRET_ENVIRONMENT_NAME)?.trim(),
  )
  if (edgeViewerAddress) return edgeViewerAddress

  let transportSource: string | undefined
  try {
    transportSource = getConnInfo(c).remote.address
  } catch {
    transportSource = undefined
  }
  return resolveRequestClientKey(
    transportSource,
    c.req.header('X-Forwarded-For'),
    new Set(
      (getEnv('MUKUROJI_REQUEST_TRUSTED_PROXY_ADDRESSES') ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  )
}
