/** Registers tests for the CloudFront distribution that serves the Web app and API. */
import { expect, test } from '@jest/globals';
import { Match } from 'aws-cdk-lib/assertions';
import {
  API_CONTENT_SECURITY_POLICY,
  buildWebContentSecurityPolicy,
} from '../lib/subsystems/web-response-headers';
import { synthesizedTemplate } from './test-support';

/**
 * Returns the only synthesized CloudFront distribution configuration.
 *
 * @returns The distribution's `DistributionConfig` property.
 */
function requireDistributionConfig(): Record<string, unknown> {
  const distributions = Object.values(
    synthesizedTemplate.findResources('AWS::CloudFront::Distribution'),
  );
  expect(distributions).toHaveLength(1);
  return distributions[0].Properties.DistributionConfig;
}

test('serves the SPA from a private bucket through origin access control', () => {
  synthesizedTemplate.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  synthesizedTemplate.hasResource('AWS::S3::Bucket', {
    DeletionPolicy: 'Retain',
    Properties: Match.objectLike({
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      OwnershipControls: {
        Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }],
      },
    }),
  });
  synthesizedTemplate.hasResourceProperties('AWS::S3::BucketPolicy', {
    Bucket: { Ref: Match.stringLikeRegexp('^WebBucket') },
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 's3:GetObject',
          Effect: 'Allow',
          Principal: { Service: 'cloudfront.amazonaws.com' },
        }),
      ]),
    }),
  });

  const config = requireDistributionConfig();
  expect(config).toEqual(expect.objectContaining({
    DefaultRootObject: 'index.html',
    HttpVersion: 'http2and3',
    PriceClass: 'PriceClass_200',
  }));
  expect(config.CustomErrorResponses).toBeUndefined();
  expect(config.DefaultCacheBehavior).toEqual(expect.objectContaining({
    ViewerProtocolPolicy: 'redirect-to-https',
    FunctionAssociations: [
      expect.objectContaining({ EventType: 'viewer-request' }),
    ],
  }));
});

/**
 * Returns the code of the one CloudFront Function whose logical ID starts with the prefix.
 *
 * @param logicalIdPrefix Construct ID the function's logical ID starts with.
 * @returns The inline function code.
 */
function requireFunctionCode(logicalIdPrefix: string): string {
  const functions = Object.entries(
    synthesizedTemplate.findResources('AWS::CloudFront::Function'),
  ).filter(([logicalId]) => logicalId.startsWith(logicalIdPrefix));
  expect(functions).toHaveLength(1);
  return functions[0][1].Properties.FunctionCode as string;
}

test('rewrites only extensionless routes to the SPA shell', () => {
  synthesizedTemplate.resourceCountIs('AWS::CloudFront::Function', 2);
  const code = requireFunctionCode('WebSpaRoutingFunction');
  const handler = new Function(`${code}; return handler;`)() as (
    event: { request: { uri: string } },
  ) => { uri: string };

  expect(handler({ request: { uri: '/' } }).uri).toBe('/index.html');
  expect(handler({ request: { uri: '/projects/refero/board' } }).uri)
    .toBe('/index.html');
  expect(handler({ request: { uri: '/assets/index-3f9a.js' } }).uri)
    .toBe('/assets/index-3f9a.js');
  expect(handler({ request: { uri: '/manifest.webmanifest' } }).uri)
    .toBe('/manifest.webmanifest');
});

test('forwards /api/* to the HTTP API without caching', () => {
  const config = requireDistributionConfig();
  const behaviors = config.CacheBehaviors as Record<string, unknown>[];

  expect(behaviors).toEqual([
    expect.objectContaining({
      PathPattern: '/api/*',
      AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'],
      // Managed CachingDisabled and AllViewerExceptHostHeader policies.
      CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
      OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac',
      ViewerProtocolPolicy: 'https-only',
      FunctionAssociations: [{
        EventType: 'viewer-request',
        FunctionARN: {
          'Fn::GetAtt': [
            expect.stringMatching(/^WebApiViewerAddressFunction/),
            'FunctionARN',
          ],
        },
      }],
    }),
  ]);
  const apiOrigin = (config.Origins as Record<string, unknown>[]).find(
    (origin) => origin.Id === behaviors[0].TargetOriginId,
  );
  expect(apiOrigin).toEqual(expect.objectContaining({
    CustomOriginConfig: expect.objectContaining({
      OriginProtocolPolicy: 'https-only',
    }),
    // The API trusts the viewer address header only with this origin secret.
    OriginCustomHeaders: [{
      HeaderName: 'x-mukuroji-edge-secret',
      HeaderValue: { Ref: 'EdgeOriginSecret' },
    }],
    DomainName: {
      'Fn::Select': [2, {
        'Fn::Split': ['/', {
          'Fn::GetAtt': [expect.stringMatching(/^HttpApi/), 'ApiEndpoint'],
        }],
      }],
    },
  }));
});

test('overwrites the viewer address header on every API request', () => {
  const code = requireFunctionCode('WebApiViewerAddressFunction');
  const handler = new Function(`${code}; return handler;`)() as (event: {
    request: { headers: Record<string, { value: string }> };
    viewer: { ip: string };
  }) => { headers: Record<string, { value: string }> };

  const request = handler({
    request: {
      headers: {
        authorization: { value: 'Bearer token' },
        'x-mukuroji-viewer-address': { value: '198.51.100.1' },
      },
    },
    viewer: { ip: '203.0.113.7' },
  });
  expect(request.headers).toEqual({
    authorization: { value: 'Bearer token' },
    'x-mukuroji-viewer-address': { value: '203.0.113.7' },
  });
});

test('accepts presigned browser file uploads from the Web origin', () => {
  synthesizedTemplate.hasResourceProperties('AWS::S3::Bucket', {
    CorsConfiguration: {
      CorsRules: Match.arrayWith([
        Match.objectLike({
          AllowedOrigins: [{
            'Fn::Join': ['', [
              'https://',
              { 'Fn::GetAtt': [Match.stringLikeRegexp('^WebDistribution'), 'DomainName'] },
            ]],
          }],
          AllowedMethods: ['GET', 'HEAD', 'PUT'],
        }),
      ]),
    },
  });
  synthesizedTemplate.hasOutput('WebUrl', {});
  synthesizedTemplate.hasOutput('WebBucketName', {});
  synthesizedTemplate.hasOutput('WebDistributionId', {});
});

/** Security headers both CloudFront behaviors send, overriding the origin. */
const sharedSecurityHeaders = {
  ContentTypeOptions: { Override: true },
  FrameOptions: { FrameOption: 'DENY', Override: true },
  ReferrerPolicy: { ReferrerPolicy: 'no-referrer', Override: true },
  StrictTransportSecurity: { AccessControlMaxAgeSec: 31_536_000, Override: true },
  XSSProtection: { Protection: false, Override: true },
};

/**
 * Returns the security headers of the response headers policy whose logical ID starts with the prefix.
 *
 * @param logicalIdPrefix Construct ID the policy's logical ID starts with.
 * @returns The policy's `SecurityHeadersConfig` property.
 */
function requireSecurityHeadersConfig(
  logicalIdPrefix: string,
): Record<string, unknown> {
  const policies = Object.entries(
    synthesizedTemplate.findResources('AWS::CloudFront::ResponseHeadersPolicy'),
  ).filter(([logicalId]) => logicalId.startsWith(logicalIdPrefix));
  expect(policies).toHaveLength(1);
  return policies[0][1].Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig;
}

test('builds a Web CSP that only loads code from the Web origin', () => {
  const policy = buildWebContentSecurityPolicy({
    fileBucketSource: 'https://*.s3.ap-northeast-1.amazonaws.com',
    realtimeWebSocketOrigin: 'wss://abc123.execute-api.ap-northeast-1.amazonaws.com',
  });

  expect(policy.split('; ')).toEqual([
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "worker-src 'self'",
    "connect-src 'self' wss://abc123.execute-api.ap-northeast-1.amazonaws.com https://*.s3.ap-northeast-1.amazonaws.com",
    "img-src 'self' data: blob: https://*.s3.ap-northeast-1.amazonaws.com",
    "media-src 'self' blob: https://*.s3.ap-northeast-1.amazonaws.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ]);
  expect(policy).not.toMatch(/unsafe-inline|unsafe-eval/);
});

test('sends the Web CSP and security headers with the SPA', () => {
  const config = requireDistributionConfig();
  expect(config.DefaultCacheBehavior).toEqual(expect.objectContaining({
    ResponseHeadersPolicyId: {
      Ref: expect.stringMatching(/^WebResponseHeadersPolicy/),
    },
  }));

  const headers = requireSecurityHeadersConfig('WebResponseHeadersPolicy');
  expect(headers).toEqual(expect.objectContaining(sharedSecurityHeaders));
  expect(headers.ContentSecurityPolicy).toEqual({
    ContentSecurityPolicy: {
      'Fn::Join': ['', [
        "default-src 'self'; script-src 'self'; style-src 'self'; worker-src 'self'; connect-src 'self' ",
        { 'Fn::GetAtt': [expect.stringMatching(/^RealtimeWebSocketApi/), 'ApiEndpoint'] },
        ' https://*.s3.',
        { Ref: 'AWS::Region' },
        '.',
        { Ref: 'AWS::URLSuffix' },
        "; img-src 'self' data: blob: https://*.s3.",
        { Ref: 'AWS::Region' },
        '.',
        { Ref: 'AWS::URLSuffix' },
        "; media-src 'self' blob: https://*.s3.",
        { Ref: 'AWS::Region' },
        '.',
        { Ref: 'AWS::URLSuffix' },
        "; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
      ]],
    },
    Override: true,
  });
});

test('sends a deny-all CSP and security headers with /api/* responses', () => {
  const behaviors = requireDistributionConfig().CacheBehaviors as Record<string, unknown>[];
  expect(behaviors[0]).toEqual(expect.objectContaining({
    PathPattern: '/api/*',
    ResponseHeadersPolicyId: {
      Ref: expect.stringMatching(/^ApiResponseHeadersPolicy/),
    },
  }));

  const headers = requireSecurityHeadersConfig('ApiResponseHeadersPolicy');
  expect(headers).toEqual(expect.objectContaining(sharedSecurityHeaders));
  expect(headers.ContentSecurityPolicy).toEqual({
    ContentSecurityPolicy: API_CONTENT_SECURITY_POLICY,
    Override: true,
  });
  expect(API_CONTENT_SECURITY_POLICY).toBe(
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
});
