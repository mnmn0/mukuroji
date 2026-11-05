/** Registers tests for the CloudFront distribution that serves the Web app and API. */
import { expect, test } from '@jest/globals';
import { Match } from 'aws-cdk-lib/assertions';
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

test('rewrites only extensionless routes to the SPA shell', () => {
  const functions = Object.values(
    synthesizedTemplate.findResources('AWS::CloudFront::Function'),
  );
  expect(functions).toHaveLength(1);
  const code = functions[0].Properties.FunctionCode as string;
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
    }),
  ]);
  const apiOrigin = (config.Origins as Record<string, unknown>[]).find(
    (origin) => origin.Id === behaviors[0].TargetOriginId,
  );
  expect(apiOrigin).toEqual(expect.objectContaining({
    CustomOriginConfig: expect.objectContaining({
      OriginProtocolPolicy: 'https-only',
    }),
    DomainName: {
      'Fn::Select': [2, {
        'Fn::Split': ['/', {
          'Fn::GetAtt': [expect.stringMatching(/^HttpApi/), 'ApiEndpoint'],
        }],
      }],
    },
  }));
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
