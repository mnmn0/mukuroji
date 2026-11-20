import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { Construct } from 'constructs';

/** HSTS lifetime CloudFront sends with every response (one year). */
const STRICT_TRANSPORT_SECURITY_MAX_AGE = cdk.Duration.days(365);

/**
 * Policy for every `/api/*` response.
 *
 * The API answers with JSON, files, and redirects, never with a page that
 * loads resources, so nothing may load, run, or frame a response even if a
 * browser renders one as a document.
 */
export const API_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Sources outside the Web origin that the browser app must reach. */
export type WebContentSecurityPolicySources = Readonly<{
  /**
   * Origin of the realtime WebSocket API, such as
   * `wss://abc123.execute-api.ap-northeast-1.amazonaws.com`.
   */
  readonly realtimeWebSocketOrigin: string;
  /**
   * Source matching the file bucket that presigned upload, preview, and PDF
   * URLs point at, such as `https://*.s3.ap-northeast-1.amazonaws.com`.
   *
   * The file bucket's CORS rule names the distribution's domain, so this
   * policy cannot name the bucket without a dependency cycle. It matches the
   * regional S3 endpoint instead, and `scripts/deploy-web.sh` narrows it to
   * the bucket itself with a `<meta>` policy in `index.html`.
   */
  readonly fileBucketSource: string;
}>;

/**
 * Builds the Content-Security-Policy for the Web app.
 *
 * Scripts, styles, workers, and fonts load only from the Web origin, so a
 * script injected into a page cannot run. `connect-src` names the API (same
 * origin), the realtime WebSocket API, and the file bucket only, so a script
 * that does run cannot send stored tokens to another host. Images and media
 * also allow the file bucket for previews, `data:` for the authenticator QR
 * code, and `blob:` for downloads built in the browser.
 *
 * @param sources Sources for the realtime API and the file bucket.
 * @returns The policy as one header value.
 */
export function buildWebContentSecurityPolicy(
  sources: WebContentSecurityPolicySources,
): string {
  const { fileBucketSource, realtimeWebSocketOrigin } = sources;
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "worker-src 'self'",
    `connect-src 'self' ${realtimeWebSocketOrigin} ${fileBucketSource}`,
    `img-src 'self' data: blob: ${fileBucketSource}`,
    `media-src 'self' blob: ${fileBucketSource}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Response headers policies for the two CloudFront behaviors. */
export type WebResponseHeadersPolicies = Readonly<{
  /** Policy for the SPA and its static files. */
  readonly webResponseHeadersPolicy: cloudfront.ResponseHeadersPolicy;
  /** Policy for `/api/*` responses. */
  readonly apiResponseHeadersPolicy: cloudfront.ResponseHeadersPolicy;
}>;

/**
 * Builds the security headers shared by both behaviors.
 *
 * CloudFront overrides any value the origin sent, so the API cannot weaken
 * them by accident. `X-XSS-Protection: 0` turns off the legacy filter that
 * current guidance considers harmful; the CSP replaces it.
 *
 * @param contentSecurityPolicy Policy for the behavior.
 * @returns The CloudFront security headers configuration.
 */
function createSecurityHeadersBehavior(
  contentSecurityPolicy: string,
): cloudfront.ResponseSecurityHeadersBehavior {
  return {
    contentSecurityPolicy: { contentSecurityPolicy, override: true },
    contentTypeOptions: { override: true },
    frameOptions: {
      frameOption: cloudfront.HeadersFrameOption.DENY,
      override: true,
    },
    referrerPolicy: {
      referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
      override: true,
    },
    strictTransportSecurity: {
      accessControlMaxAge: STRICT_TRANSPORT_SECURITY_MAX_AGE,
      override: true,
    },
    xssProtection: { protection: false, override: true },
  };
}

/**
 * Creates the response headers policies for the Web app and the API.
 *
 * @param scope Stack scope used directly to keep construct paths flat.
 * @param sources Sources the Web app's CSP must allow.
 * @returns Policies for the default behavior and the `/api/*` behavior.
 */
export function createWebResponseHeadersPolicies(
  scope: Construct,
  sources: WebContentSecurityPolicySources,
): WebResponseHeadersPolicies {
  const webResponseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
    scope,
    'WebResponseHeadersPolicy',
    {
      comment: 'Security headers and CSP for the mukuroji Web app.',
      securityHeadersBehavior: createSecurityHeadersBehavior(
        buildWebContentSecurityPolicy(sources),
      ),
    },
  );
  const apiResponseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
    scope,
    'ApiResponseHeadersPolicy',
    {
      comment: 'Security headers for mukuroji API responses.',
      securityHeadersBehavior: createSecurityHeadersBehavior(
        API_CONTENT_SECURITY_POLICY,
      ),
    },
  );
  return { apiResponseHeadersPolicy, webResponseHeadersPolicy };
}
