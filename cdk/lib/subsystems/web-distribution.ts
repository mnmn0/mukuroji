import * as cdk from 'aws-cdk-lib';
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
 * Requests whose last path segment has no file extension are rewritten to
 * `/index.html`. Only the default (S3) behavior runs it, so `/api/*`
 * responses, including API 404s, reach the browser unchanged.
 */
const SPA_ROUTING_FUNCTION_CODE = `function handler(event) {
  var request = event.request;
  var lastSegment = request.uri.split('/').pop();
  if (lastSegment === '' || lastSegment.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}`;

/** Lowercase DNS name with at least two labels, or empty for the CloudFront domain. */
const WEB_DOMAIN_NAME_PATTERN =
  '^(|([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?)$';

/** ACM certificate ARN in us-east-1, the only Region CloudFront reads, or empty. */
const WEB_CERTIFICATE_ARN_PATTERN =
  '^(|arn:aws:acm:us-east-1:[0-9]{12}:certificate/[A-Za-z0-9-]{1,128})$';

/** Route 53 public hosted zone ID, or empty to manage DNS outside the stack. */
const WEB_HOSTED_ZONE_ID_PATTERN = '^(|[A-Z0-9]{1,32})$';

/** Viewer TLS policy used once the distribution serves a custom certificate. */
const WEB_CUSTOM_DOMAIN_TLS_POLICY = 'TLSv1.2_2021';

/** Optional custom domain parameters and the conditions derived from them. */
type WebCustomDomain = Readonly<{
  /** Custom domain name, empty when the CloudFront domain is used. */
  readonly domainName: string;
  /** us-east-1 ACM certificate ARN covering the custom domain. */
  readonly certificateArn: string;
  /** Route 53 hosted zone that receives the alias records. */
  readonly hostedZoneId: string;
  /** True when a custom domain and its certificate are configured. */
  readonly configured: cdk.CfnCondition;
  /** True when the stack also manages the Route 53 alias records. */
  readonly hostedZoneConfigured: cdk.CfnCondition;
}>;

/**
 * Declares the optional custom domain parameters for the Web distribution.
 *
 * All three parameters default to empty, which keeps the CloudFront domain and
 * leaves the synthesized resources unchanged. A domain needs a certificate,
 * and a hosted zone needs a domain.
 *
 * @param scope Stack that directly owns the parameters, rule, and conditions.
 * @returns Parameter values and the conditions that gate the custom domain.
 */
function declareWebCustomDomain(scope: cdk.Stack): WebCustomDomain {
  const domainName = new cdk.CfnParameter(scope, 'WebDomainName', {
    type: 'String',
    default: '',
    maxLength: 253,
    allowedPattern: WEB_DOMAIN_NAME_PATTERN,
    constraintDescription:
      'WebDomainName must be empty or a lowercase DNS name such as wbs.example.com.',
    description:
      'Optional custom domain that serves the Web app and /api. Empty keeps the CloudFront domain.',
  });
  const certificateArn = new cdk.CfnParameter(scope, 'WebCertificateArn', {
    type: 'String',
    default: '',
    allowedPattern: WEB_CERTIFICATE_ARN_PATTERN,
    constraintDescription:
      'WebCertificateArn must be empty or an ACM certificate ARN in us-east-1.',
    description:
      'Issued us-east-1 ACM certificate covering WebDomainName. Required with WebDomainName.',
  });
  const hostedZoneId = new cdk.CfnParameter(scope, 'WebHostedZoneId', {
    type: 'String',
    default: '',
    allowedPattern: WEB_HOSTED_ZONE_ID_PATTERN,
    constraintDescription: 'WebHostedZoneId must be empty or a Route 53 hosted zone ID.',
    description:
      'Optional Route 53 public hosted zone where the stack creates A and AAAA aliases for WebDomainName.',
  });
  const domainEmpty = cdk.Fn.conditionEquals(domainName.valueAsString, '');
  const certificateEmpty = cdk.Fn.conditionEquals(certificateArn.valueAsString, '');
  const hostedZoneEmpty = cdk.Fn.conditionEquals(hostedZoneId.valueAsString, '');
  new cdk.CfnRule(scope, 'WebCustomDomainParametersComplete', {
    assertions: [{
      assert: cdk.Fn.conditionOr(
        cdk.Fn.conditionAnd(domainEmpty, certificateEmpty, hostedZoneEmpty),
        cdk.Fn.conditionAnd(
          cdk.Fn.conditionNot(domainEmpty),
          cdk.Fn.conditionNot(certificateEmpty),
        ),
      ),
      assertDescription:
        'Set WebDomainName and WebCertificateArn together; WebHostedZoneId also needs WebDomainName.',
    }],
  });
  const configured = new cdk.CfnCondition(scope, 'WebCustomDomainConfigured', {
    expression: cdk.Fn.conditionNot(domainEmpty),
  });
  const hostedZoneConfigured = new cdk.CfnCondition(
    scope,
    'WebHostedZoneConfigured',
    { expression: cdk.Fn.conditionNot(hostedZoneEmpty) },
  );
  return {
    domainName: domainName.valueAsString,
    certificateArn: certificateArn.valueAsString,
    hostedZoneId: hostedZoneId.valueAsString,
    configured,
    hostedZoneConfigured,
  };
}

/**
 * Serves the distribution on the custom domain when one is configured.
 *
 * The L2 distribution cannot take a certificate that exists only under a
 * condition, so the alias and certificate are set on the L1 resource and
 * resolve to `AWS::NoValue` without a custom domain.
 *
 * @param distribution Distribution serving the Web app and `/api/*`.
 * @param domain Custom domain parameters and conditions.
 */
function applyWebCustomDomain(
  distribution: cloudfront.Distribution,
  domain: WebCustomDomain,
): void {
  const resource = distribution.node.defaultChild;
  if (!(resource instanceof cloudfront.CfnDistribution)) {
    throw new Error('The Web distribution has no CloudFront distribution resource.');
  }
  resource.addPropertyOverride(
    'DistributionConfig.Aliases',
    cdk.Fn.conditionIf(
      domain.configured.logicalId,
      [domain.domainName],
      cdk.Aws.NO_VALUE,
    ),
  );
  resource.addPropertyOverride(
    'DistributionConfig.ViewerCertificate',
    cdk.Fn.conditionIf(
      domain.configured.logicalId,
      {
        AcmCertificateArn: domain.certificateArn,
        MinimumProtocolVersion: WEB_CUSTOM_DOMAIN_TLS_POLICY,
        SslSupportMethod: 'sni-only',
      },
      cdk.Aws.NO_VALUE,
    ),
  );
}

/**
 * Creates Route 53 A and AAAA aliases from the custom domain to the distribution.
 *
 * The records exist only when a hosted zone is configured. Without one the
 * operator points the custom domain at the distribution domain outside the stack.
 *
 * @param scope Stack scope used directly to keep construct paths flat.
 * @param distribution Distribution the aliases target.
 * @param domain Custom domain parameters and conditions.
 */
function buildWebAliasRecords(
  scope: cdk.Stack,
  distribution: cloudfront.Distribution,
  domain: WebCustomDomain,
): void {
  const aliasTarget = {
    dnsName: distribution.distributionDomainName,
    hostedZoneId: route53Targets.CloudFrontTarget.getHostedZoneId(scope),
  };
  for (const type of ['A', 'AAAA']) {
    const record = new route53.CfnRecordSet(scope, `WebAlias${type}Record`, {
      aliasTarget,
      hostedZoneId: domain.hostedZoneId,
      name: domain.domainName,
      type,
    });
    record.cfnOptions.condition = domain.hostedZoneConfigured;
  }
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
}>;

/**
 * Serves the Web app and the API from one CloudFront domain.
 *
 * The built SPA lives in a private bucket read through origin access
 * control. `/api/*` goes to the HTTP API without caching, so the browser
 * calls the API on the same origin and needs no CORS. CloudFront adds the
 * viewer address and an origin secret to each API request, so rate limits and
 * enterprise IP policies see the user's address instead of an edge address.
 * The file bucket also accepts presigned browser uploads from this origin.
 * Both behaviors send security headers; the Web app's CSP limits connections
 * to this origin, the realtime WebSocket API, and the file bucket.
 *
 * The optional `WebDomainName` and `WebCertificateArn` parameters serve the
 * same distribution on a custom domain, which then becomes the canonical
 * origin used in notification links. The CloudFront domain keeps working.
 *
 * @param scope Stack scope used directly to keep construct paths flat.
 * @param input HTTP API, realtime API, and file bucket shared with the rest of the stack.
 * @returns The Web bucket, distribution, and the app's canonical HTTPS origin.
 */
export function buildWebDistribution(
  scope: cdk.Stack,
  input: WebDistributionInput,
): WebDistributionResources {
  const webBucket = new s3.Bucket(scope, 'WebBucket', {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
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
    httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
  });
  const customDomain = declareWebCustomDomain(scope);
  applyWebCustomDomain(webDistribution, customDomain);
  buildWebAliasRecords(scope, webDistribution, customDomain);
  const distributionOrigin = `https://${webDistribution.distributionDomainName}`;
  const customOrigin = `https://${customDomain.domainName}`;
  const webOrigin = cdk.Token.asString(cdk.Fn.conditionIf(
    customDomain.configured.logicalId,
    customOrigin,
    distributionOrigin,
  ));
  const browserOrigins = cdk.Token.asList(cdk.Fn.conditionIf(
    customDomain.configured.logicalId,
    [customOrigin, distributionOrigin],
    [distributionOrigin],
  ));

  input.fileBucket.addCorsRule(createFileBucketBrowserCorsRule(browserOrigins));

  return { webBucket, webDistribution, webOrigin };
}
