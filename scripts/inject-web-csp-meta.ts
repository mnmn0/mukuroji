import { readFileSync, writeFileSync } from 'node:fs'

/** Tag every built `index.html` starts its `<head>` with. */
const CHARSET_META = '<meta charset="UTF-8" />'

/** S3 bucket names the file bucket can have: lowercase, digits, and hyphens, without dots. */
const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/

/** AWS region names such as `ap-northeast-1` or `us-gov-west-1`. */
const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d+$/

/** Deployed values the narrowed policy names. */
export type WebCspMetaInput = {
  /** Name of the stack's file bucket. */
  fileBucketName: string
  /** Region the stack and its file bucket are deployed in. */
  region: string
  /** URL of the realtime WebSocket stage, such as `wss://abc.execute-api.ap-northeast-1.amazonaws.com/production`. */
  realtimeWebSocketUrl: string
}

/**
 * Builds the policy that narrows the CloudFront CSP to this stack's file bucket.
 *
 * CloudFront's policy allows any bucket on the regional S3 endpoint because it
 * cannot name the file bucket without a dependency cycle. A browser enforces
 * every policy it receives, so this second policy limits connections, images,
 * and media to the one bucket the app uses. Directives it leaves out stay
 * governed by the CloudFront policy alone.
 *
 * @param input - File bucket, region, and realtime WebSocket URL from the stack outputs.
 * @returns The policy for a `<meta http-equiv="Content-Security-Policy">` tag.
 * @throws Error when a value is not a bucket name, region, or `wss:` URL.
 */
export function buildWebCspMetaPolicy(input: WebCspMetaInput): string {
  if (!BUCKET_NAME_PATTERN.test(input.fileBucketName)) {
    throw new Error(`Invalid file bucket name: ${input.fileBucketName}`)
  }
  if (!REGION_PATTERN.test(input.region)) {
    throw new Error(`Invalid AWS region: ${input.region}`)
  }
  const realtimeUrl = new URL(input.realtimeWebSocketUrl)
  if (realtimeUrl.protocol !== 'wss:' || realtimeUrl.username !== '' || realtimeUrl.password !== '') {
    throw new Error(`Invalid realtime WebSocket URL: ${input.realtimeWebSocketUrl}`)
  }
  const urlSuffix = input.region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'
  const fileBucketOrigin = `https://${input.fileBucketName}.s3.${input.region}.${urlSuffix}`
  return [
    `connect-src 'self' ${realtimeUrl.origin} ${fileBucketOrigin}`,
    `img-src 'self' data: blob: ${fileBucketOrigin}`,
    `media-src 'self' blob: ${fileBucketOrigin}`,
  ].join('; ')
}

/**
 * Adds the policy to a built `index.html` before any script or stylesheet.
 *
 * @param html - Contents of the built `index.html`.
 * @param policy - Policy from {@link buildWebCspMetaPolicy}.
 * @returns The HTML with the policy right after the charset declaration.
 * @throws Error when the HTML has no charset tag or already declares a policy.
 */
export function injectWebCspMeta(html: string, policy: string): string {
  if (/http-equiv=["']?Content-Security-Policy/i.test(html)) {
    throw new Error('index.html already declares a Content-Security-Policy.')
  }
  if (!html.includes(CHARSET_META)) {
    throw new Error(`index.html has no ${CHARSET_META} tag to put the policy after.`)
  }
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}" />`
  return html.replace(CHARSET_META, `${CHARSET_META}\n    ${meta}`)
}

if (import.meta.main) {
  const [indexHtmlPath, fileBucketName, region, realtimeWebSocketUrl] = process.argv.slice(2)
  if (!indexHtmlPath || !fileBucketName || !region || !realtimeWebSocketUrl) {
    throw new Error('Usage: bun scripts/inject-web-csp-meta.ts <index.html> <file bucket> <region> <realtime WebSocket URL>')
  }
  const policy = buildWebCspMetaPolicy({ fileBucketName, region, realtimeWebSocketUrl })
  writeFileSync(indexHtmlPath, injectWebCspMeta(readFileSync(indexHtmlPath, 'utf8'), policy))
}
