import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { createFileBucketBrowserCorsRule } from './file-storage';

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

/** Inputs required to serve the Web app and the API from one origin. */
export type WebDistributionInput = Readonly<{
  /** Shared HTTP API reached under `/api/*`. */
  readonly httpApi: apigatewayv2.HttpApi;
  /** File bucket whose browser uploads must accept the Web origin. */
  readonly fileBucket: s3.Bucket;
  /** Secret CloudFront sends to the API with every `/api/*` request. */
  readonly edgeOriginSecret: string;
}>;

/** Resources that host the built Web app. */
export type WebDistributionResources = Readonly<{
  /** Private bucket holding the built Web assets. */
  readonly webBucket: s3.Bucket;
  /** CloudFront distribution serving the Web app and `/api/*`. */
  readonly webDistribution: cloudfront.Distribution;
  /** HTTPS origin of the distribution, without a trailing slash. */
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
 *
 * @param scope Stack scope used directly to keep construct paths flat.
 * @param input HTTP API and file bucket shared with the rest of the stack.
 * @returns The Web bucket, distribution, and its HTTPS origin.
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
  const webDistribution = new cloudfront.Distribution(scope, 'WebDistribution', {
    comment: 'mukuroji Web app and API on one origin',
    defaultBehavior: {
      origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
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
  const webOrigin = `https://${webDistribution.distributionDomainName}`;

  input.fileBucket.addCorsRule(createFileBucketBrowserCorsRule([webOrigin]));

  return { webBucket, webDistribution, webOrigin };
}
