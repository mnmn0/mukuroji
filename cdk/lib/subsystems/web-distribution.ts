import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { createFileBucketBrowserCorsRule } from './file-storage';
import { createWebResponseHeadersPolicies } from './web-response-headers';

/** Path pattern CloudFront forwards to the shared HTTP API. */
export const WEB_API_PATH_PATTERN = '/api/*';

/** Origin header carrying the secret that proves a request came through CloudFront. */
export const EDGE_ORIGIN_SECRET_HEADER = 'x-mukuroji-edge-secret';

/** Days a release copy under `releases/<commit SHA>/` stays restorable after its last upload. */
export const WEB_RELEASE_RETENTION_DAYS = 180;

/** Days a replaced or deleted Web file stays recoverable as a noncurrent version. */
export const WEB_NONCURRENT_VERSION_RETENTION_DAYS = 30;

/** Origin header carrying the viewer address CloudFront observed. */
export const EDGE_VIEWER_ADDRESS_HEADER = 'x-mukuroji-viewer-address';

/**
 * Viewer-request function that records the viewer address for the API.
 *
 * The HTTP API sees a CloudFront edge address as the TCP peer, so the API
 * reads the viewer address from this header instead. The function always
 * overwrites a value the client sent, and the API trusts the header only
 * when the origin secret header matches.
 */
const API_VIEWER_ADDRESS_FUNCTION_CODE = `function handler(event) {
  var request = event.request;
  request.headers['${EDGE_VIEWER_ADDRESS_HEADER}'] = { value: event.viewer.ip };
  return request;
}`;

/**
 * Viewer-request function that serves the SPA shell for client-side routes.
 *
 * Release copies under `releases/` and the `release-assets.txt` list exist
 * only for `web:deploy` and `web:rollback`, which read the bucket directly,
 * so the function answers 404 for them instead of serving old entry files.
 * Requests whose last path segment has no file extension are rewritten to
 * `/index.html`. Only the default (S3) behavior runs it, so `/api/*`
 * responses, including API 404s, reach the browser unchanged.
 */
const SPA_ROUTING_FUNCTION_CODE = `function handler(event) {
  var request = event.request;
  var uri = request.uri;
  try {
    // S3 decodes the key, so an encoded name such as /%72eleases/ must not slip past.
    uri = decodeURIComponent(uri);
  } catch (error) {
    // A malformed escape cannot name a release copy; S3 answers it as usual.
  }
  if (uri === '/releases' || uri.indexOf('/releases/') === 0 || uri === '/release-assets.txt') {
    return {
      statusCode: 404,
      statusDescription: 'Not Found',
      headers: { 'cache-control': { value: 'no-store' } },
    };
  }
  var lastSegment = request.uri.split('/').pop();
  if (lastSegment === '' || lastSegment.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}`;

/** CDK context key holding the optional custom domain that serves the Web app and `/api`. */
export const WEB_DOMAIN_NAME_CONTEXT_KEY = 'mukuroji:webDomainName';

/** CDK context key holding the us-east-1 ACM certificate ARN for the custom domain. */
export const WEB_CERTIFICATE_ARN_CONTEXT_KEY = 'mukuroji:webCertificateArn';

/** CDK context key holding the optional Route 53 hosted zone that receives the alias records. */
export const WEB_HOSTED_ZONE_ID_CONTEXT_KEY = 'mukuroji:webHostedZoneId';

/** Path of the SPA route that completes an enterprise SSO login. */
export const WEB_SSO_CALLBACK_PATH = '/auth/sso/callback';

/** Lowercase DNS name with at least two labels. */
const WEB_DOMAIN_NAME_PATTERN =
  /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Longest DNS name Route 53 and CloudFront accept. */
const WEB_DOMAIN_NAME_MAX_LENGTH = 253;

/** ACM certificate ARN in us-east-1, the only Region CloudFront reads. */
const WEB_CERTIFICATE_ARN_PATTERN =
  /^arn:aws:acm:us-east-1:[0-9]{12}:certificate\/[A-Za-z0-9-]{1,128}$/;

/** Route 53 public hosted zone ID. */
const WEB_HOSTED_ZONE_ID_PATTERN = /^[A-Z0-9]{1,32}$/;

/** Custom domain settings as read from CDK context; empty values mean not set. */
export type WebCustomDomainSettings = Readonly<{
  /** Custom domain such as `wbs.example.com`, or empty to keep the CloudFront domain. */
  readonly domainName?: string;
  /** Issued us-east-1 ACM certificate ARN covering the domain, or empty. */
  readonly certificateArn?: string;
  /** Route 53 public hosted zone where the stack creates the aliases, or empty. */
  readonly hostedZoneId?: string;
}>;

/** Validated custom domain that the distribution serves. */
export type WebCustomDomain = Readonly<{
  /** Lowercase custom domain name. */
  readonly domainName: string;
  /** us-east-1 ACM certificate ARN covering the domain. */
  readonly certificateArn: string;
  /** Route 53 hosted zone for the alias records, absent when DNS is managed outside the stack. */
  readonly hostedZoneId?: string;
}>;

/**
 * Validates the custom domain settings read from CDK context.
 *
 * Every value empty keeps the CloudFront domain. A domain needs its certificate,
 * and a hosted zone needs a domain, so a half-set configuration fails at synth
 * time instead of during the deployment.
 *
 * @param settings Values of the `mukuroji:web*` context keys.
 * @returns The custom domain, or `undefined` when none is configured.
 * @throws Error when a value is malformed or the values are incomplete.
 */
export function resolveWebCustomDomain(
  settings: WebCustomDomainSettings = {},
): WebCustomDomain | undefined {
  const domainName = settings.domainName?.trim() ?? '';
  const certificateArn = settings.certificateArn?.trim() ?? '';
  const hostedZoneId = settings.hostedZoneId?.trim() ?? '';
  if (domainName === '' && certificateArn === '' && hostedZoneId === '') {
    return undefined;
  }
  if (domainName === '' || certificateArn === '') {
    throw new Error(
      `Set ${WEB_DOMAIN_NAME_CONTEXT_KEY} and ${WEB_CERTIFICATE_ARN_CONTEXT_KEY} together; `
        + `${WEB_HOSTED_ZONE_ID_CONTEXT_KEY} also needs ${WEB_DOMAIN_NAME_CONTEXT_KEY}.`,
    );
  }
  if (
    domainName.length > WEB_DOMAIN_NAME_MAX_LENGTH
    || !WEB_DOMAIN_NAME_PATTERN.test(domainName)
  ) {
    throw new Error(
      `${WEB_DOMAIN_NAME_CONTEXT_KEY} must be a lowercase DNS name such as wbs.example.com.`,
    );
  }
  if (!WEB_CERTIFICATE_ARN_PATTERN.test(certificateArn)) {
    throw new Error(
      `${WEB_CERTIFICATE_ARN_CONTEXT_KEY} must be an ACM certificate ARN in us-east-1.`,
    );
  }
  if (hostedZoneId !== '' && !WEB_HOSTED_ZONE_ID_PATTERN.test(hostedZoneId)) {
    throw new Error(`${WEB_HOSTED_ZONE_ID_CONTEXT_KEY} must be a Route 53 hosted zone ID.`);
  }
  return {
    domainName,
    certificateArn,
    ...(hostedZoneId === '' ? {} : { hostedZoneId }),
  };
}

/**
 * Creates Route 53 A and AAAA aliases from the custom domain to the distribution.
 *
 * Without a hosted zone the operator points the custom domain at the
 * distribution domain outside the stack.
 *
 * @param scope Stack scope used directly to keep construct paths flat.
 * @param distribution Distribution the aliases target.
 * @param domainName Custom domain the records answer for.
 * @param hostedZoneId Route 53 hosted zone that receives the records.
 */
function buildWebAliasRecords(
  scope: cdk.Stack,
  distribution: cloudfront.Distribution,
  domainName: string,
  hostedZoneId: string,
): void {
  const aliasTarget = {
    dnsName: distribution.distributionDomainName,
    hostedZoneId: route53Targets.CloudFrontTarget.getHostedZoneId(scope),
  };
  for (const type of ['A', 'AAAA']) {
    new route53.CfnRecordSet(scope, `WebAlias${type}Record`, {
      aliasTarget,
      hostedZoneId,
      name: domainName,
      type,
    });
  }
}

/**
 * Stops a deployment whose SSO callback is not on the custom domain.
 *
 * The SSO app client allows one callback URL. Once the app moves to the custom
 * domain, a callback left on the CloudFront domain would send users back to an
 * origin whose session storage does not hold the login state.
 *
 * @param scope Stack that directly owns the rule.
 * @param domainName Custom domain the app is served on.
 * @param ssoRedirectUri Value of the `CognitoSsoRedirectUri` parameter.
 */
function requireSsoCallbackOnCustomDomain(
  scope: cdk.Stack,
  domainName: string,
  ssoRedirectUri: string,
): void {
  const expected = `https://${domainName}${WEB_SSO_CALLBACK_PATH}`;
  new cdk.CfnRule(scope, 'WebSsoCallbackOnCustomDomain', {
    assertions: [{
      assert: cdk.Fn.conditionOr(
        cdk.Fn.conditionEquals(ssoRedirectUri, ''),
        cdk.Fn.conditionEquals(ssoRedirectUri, expected),
      ),
      assertDescription:
        `CognitoSsoRedirectUri must be empty or ${expected} while ${WEB_DOMAIN_NAME_CONTEXT_KEY} is set.`,
    }],
  });
}

/** Inputs required to serve the Web app and the API from one origin. */
export type WebDistributionInput = Readonly<{
  /** Shared HTTP API reached under `/api/*`. */
  readonly httpApi: apigatewayv2.HttpApi;
  /** File bucket whose browser uploads must accept the Web origin. */
  readonly fileBucket: s3.Bucket;
  /** Realtime WebSocket API the Web app connects to. */
  readonly realtimeWebSocketApi: apigatewayv2.IWebSocketApi;
  /** Secret CloudFront sends to the API with every `/api/*` request. */
  readonly edgeOriginSecret: string;
  /** Value of the `CognitoSsoRedirectUri` parameter, checked against the custom domain. */
  readonly ssoRedirectUri: string;
  /** Custom domain from CDK context, or `undefined` to serve only the CloudFront domain. */
  readonly customDomain?: WebCustomDomain;
}>;

/** Resources that host the built Web app. */
export type WebDistributionResources = Readonly<{
  /** Private bucket holding the built Web assets. */
  readonly webBucket: s3.Bucket;
  /** CloudFront distribution serving the Web app and `/api/*`. */
  readonly webDistribution: cloudfront.Distribution;
  /**
   * Canonical HTTPS origin of the app, without a trailing slash. It is the
   * custom domain when one is configured, otherwise the CloudFront domain.
   */
  readonly webOrigin: string;
  /**
   * Comma-separated HTTPS origins a browser can load the app from: the custom
   * domain when configured, and always the CloudFront domain.
   */
  readonly webBrowserOrigins: string;
}>;

/**
 * Serves the Web app and the API from one CloudFront domain.
 *
 * The built SPA lives in a private, versioned bucket read through origin
 * access control. Release copies under `releases/` expire after
 * {@link WEB_RELEASE_RETENTION_DAYS} days, and replaced or deleted files stay
 * recoverable for {@link WEB_NONCURRENT_VERSION_RETENTION_DAYS} days.
 * `scripts/deploy-web.sh` removes hashed `assets/` files that no kept release
 * uses, because an age-based rule would also expire assets of a live release. `/api/*` goes to the HTTP API without caching, so the browser
 * calls the API on the same origin and needs no CORS. CloudFront adds the
 * viewer address and an origin secret to each API request, so rate limits and
 * enterprise IP policies see the user's address instead of an edge address.
 * The file bucket also accepts presigned browser uploads from this origin.
 * Both behaviors send security headers; the Web app's CSP limits connections
 * to this origin, the realtime WebSocket API, and the file bucket.
 *
 * An optional custom domain from CDK context (`cdk.json`) serves the same
 * distribution, and then becomes the canonical origin used in Email links.
 * The CloudFront domain keeps working.
 *
 * @param scope Stack scope used directly to keep construct paths flat.
 * @param input HTTP API, realtime API, and file bucket shared with the rest of the stack.
 * @returns The Web bucket, distribution, and the app's canonical HTTPS origin.
 */
export function buildWebDistribution(
  scope: cdk.Stack,
  input: WebDistributionInput,
): WebDistributionResources {
  const { customDomain } = input;
  const webBucket = new s3.Bucket(scope, 'WebBucket', {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    lifecycleRules: [
      {
        expiration: cdk.Duration.days(WEB_RELEASE_RETENTION_DAYS),
        id: 'ExpireOldWebReleases',
        prefix: 'releases/',
      },
      {
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        id: 'ExpireReplacedWebFiles',
        noncurrentVersionExpiration: cdk.Duration.days(
          WEB_NONCURRENT_VERSION_RETENTION_DAYS,
        ),
      },
      {
        expiredObjectDeleteMarker: true,
        id: 'RemoveExpiredWebDeleteMarkers',
      },
    ],
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    versioned: true,
  });
  const spaRoutingFunction = new cloudfront.Function(scope, 'WebSpaRoutingFunction', {
    code: cloudfront.FunctionCode.fromInline(SPA_ROUTING_FUNCTION_CODE),
    comment: 'Serves index.html for mukuroji client-side routes.',
    runtime: cloudfront.FunctionRuntime.JS_2_0,
  });
  const apiViewerAddressFunction = new cloudfront.Function(
    scope,
    'WebApiViewerAddressFunction',
    {
      code: cloudfront.FunctionCode.fromInline(API_VIEWER_ADDRESS_FUNCTION_CODE),
      comment: 'Forwards the mukuroji viewer address to the API.',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    },
  );
  const httpApiDomainName = cdk.Fn.select(
    2,
    cdk.Fn.split('/', input.httpApi.apiEndpoint),
  );
  const { apiResponseHeadersPolicy, webResponseHeadersPolicy } =
    createWebResponseHeadersPolicies(scope, {
      fileBucketSource: `https://*.s3.${scope.region}.${scope.urlSuffix}`,
      realtimeWebSocketOrigin: input.realtimeWebSocketApi.apiEndpoint,
    });
  const webDistribution = new cloudfront.Distribution(scope, 'WebDistribution', {
    comment: 'mukuroji Web app and API on one origin',
    defaultBehavior: {
      origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      responseHeadersPolicy: webResponseHeadersPolicy,
      functionAssociations: [{
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        function: spaRoutingFunction,
      }],
    },
    additionalBehaviors: {
      [WEB_API_PATH_PATTERN]: {
        origin: new origins.HttpOrigin(httpApiDomainName, {
          customHeaders: { [EDGE_ORIGIN_SECRET_HEADER]: input.edgeOriginSecret },
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        }),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy:
          cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy: apiResponseHeadersPolicy,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        functionAssociations: [{
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          function: apiViewerAddressFunction,
        }],
      },
    },
    defaultRootObject: 'index.html',
    ...(customDomain === undefined ? {} : {
      certificate: acm.Certificate.fromCertificateArn(
        scope,
        'WebCertificate',
        customDomain.certificateArn,
      ),
      domainNames: [customDomain.domainName],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      sslSupportMethod: cloudfront.SSLMethod.SNI,
    }),
    httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
  });
  const distributionOrigin = `https://${webDistribution.distributionDomainName}`;
  let webOrigin = distributionOrigin;
  const browserOrigins = [distributionOrigin];
  if (customDomain !== undefined) {
    webOrigin = `https://${customDomain.domainName}`;
    browserOrigins.unshift(webOrigin);
    if (customDomain.hostedZoneId !== undefined) {
      buildWebAliasRecords(
        scope,
        webDistribution,
        customDomain.domainName,
        customDomain.hostedZoneId,
      );
    }
    requireSsoCallbackOnCustomDomain(scope, customDomain.domainName, input.ssoRedirectUri);
  }

  input.fileBucket.addCorsRule(createFileBucketBrowserCorsRule(browserOrigins));

  const webBrowserOrigins = cdk.Token.asString(cdk.Fn.conditionIf(
    customDomain.configured.logicalId,
    `${customOrigin},${distributionOrigin}`,
    distributionOrigin,
  ));

  return { webBucket, webDistribution, webOrigin, webBrowserOrigins };
}
