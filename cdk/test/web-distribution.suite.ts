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

/** `https://` origin of the distribution's own CloudFront domain. */
const distributionOrigin = {
  'Fn::Join': ['', [
    'https://',
    { 'Fn::GetAtt': [Match.stringLikeRegexp('^WebDistribution'), 'DomainName'] },
  ]],
};

/** `https://` origin of the optional custom domain parameter. */
const customDomainOrigin = {
  'Fn::Join': ['', ['https://', { Ref: 'WebDomainName' }]],
};

test('accepts presigned browser file uploads from the Web origins', () => {
  synthesizedTemplate.hasResourceProperties('AWS::S3::Bucket', {
    CorsConfiguration: {
      CorsRules: Match.arrayWith([
        Match.objectLike({
          // Only the CloudFront origin without a custom domain, both origins with one.
          AllowedOrigins: {
            'Fn::If': [
              'WebCustomDomainConfigured',
              [customDomainOrigin, distributionOrigin],
              [distributionOrigin],
            ],
          },
          AllowedMethods: ['GET', 'HEAD', 'PUT'],
        }),
      ]),
    },
  });
  synthesizedTemplate.hasOutput('WebUrl', {
    Value: {
      'Fn::If': ['WebCustomDomainConfigured', customDomainOrigin, distributionOrigin],
    },
  });
  synthesizedTemplate.hasOutput('WebBucketName', {});
  synthesizedTemplate.hasOutput('WebDistributionId', {});
  synthesizedTemplate.hasOutput('WebDistributionDomainName', {
    Value: { 'Fn::GetAtt': [Match.stringLikeRegexp('^WebDistribution'), 'DomainName'] },
  });
});

test('declares the custom domain parameters as optional and paired', () => {
  const parameters = synthesizedTemplate.findParameters('*');
  for (const name of ['WebDomainName', 'WebCertificateArn', 'WebHostedZoneId']) {
    expect(parameters[name]).toEqual(expect.objectContaining({
      Type: 'String',
      Default: '',
    }));
  }
  const domainPattern = new RegExp(parameters.WebDomainName.AllowedPattern);
  expect(domainPattern.test('')).toBe(true);
  expect(domainPattern.test('wbs.example.co.jp')).toBe(true);
  expect(domainPattern.test('localhost')).toBe(false);
  expect(domainPattern.test('WBS.example.com')).toBe(false);
  expect(domainPattern.test('https://wbs.example.com')).toBe(false);
  const certificatePattern = new RegExp(parameters.WebCertificateArn.AllowedPattern);
  expect(certificatePattern.test('')).toBe(true);
  expect(certificatePattern.test(
    'arn:aws:acm:us-east-1:123456789012:certificate/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b',
  )).toBe(true);
  // CloudFront reads certificates only from us-east-1.
  expect(certificatePattern.test(
    'arn:aws:acm:ap-northeast-1:123456789012:certificate/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b',
  )).toBe(false);

  const rule = synthesizedTemplate.toJSON().Rules.WebCustomDomainParametersComplete;
  expect(rule.Assertions).toEqual([expect.objectContaining({
    Assert: {
      'Fn::Or': [
        {
          'Fn::And': [
            { 'Fn::Equals': [{ Ref: 'WebDomainName' }, ''] },
            { 'Fn::Equals': [{ Ref: 'WebCertificateArn' }, ''] },
            { 'Fn::Equals': [{ Ref: 'WebHostedZoneId' }, ''] },
          ],
        },
        {
          'Fn::And': [
            { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'WebDomainName' }, ''] }] },
            { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'WebCertificateArn' }, ''] }] },
          ],
        },
      ],
    },
  })]);
});

test('serves the custom domain with its certificate only when configured', () => {
  const config = requireDistributionConfig();

  expect(config.Aliases).toEqual({
    'Fn::If': [
      'WebCustomDomainConfigured',
      [{ Ref: 'WebDomainName' }],
      { Ref: 'AWS::NoValue' },
    ],
  });
  expect(config.ViewerCertificate).toEqual({
    'Fn::If': [
      'WebCustomDomainConfigured',
      {
        AcmCertificateArn: { Ref: 'WebCertificateArn' },
        MinimumProtocolVersion: 'TLSv1.2_2021',
        SslSupportMethod: 'sni-only',
      },
      { Ref: 'AWS::NoValue' },
    ],
  });
});

test('creates Route 53 aliases only when a hosted zone is configured', () => {
  const records = synthesizedTemplate.findResources('AWS::Route53::RecordSet');
  expect(Object.values(records).map((record) => record.Properties.Type).sort())
    .toEqual(['A', 'AAAA']);
  for (const record of Object.values(records)) {
    expect(record.Condition).toBe('WebHostedZoneConfigured');
    expect(record.Properties).toEqual(expect.objectContaining({
      HostedZoneId: { Ref: 'WebHostedZoneId' },
      Name: { Ref: 'WebDomainName' },
      AliasTarget: {
        DNSName: { 'Fn::GetAtt': [expect.stringMatching(/^WebDistribution/), 'DomainName'] },
        HostedZoneId: expect.anything(),
      },
    }));
  }
});

test('links notification Email to the canonical app origin', () => {
  const scheduledJobs = Object.values(
    synthesizedTemplate.findResources('AWS::Lambda::Function'),
  ).filter((resource) =>
    resource.Properties.Environment?.Variables?.NOTIFICATION_EMAIL_APP_ORIGIN !== undefined);
  expect(scheduledJobs).toHaveLength(1);
  expect(
    scheduledJobs[0].Properties.Environment.Variables.NOTIFICATION_EMAIL_APP_ORIGIN,
  ).toEqual({
    'Fn::If': [
      'WebCustomDomainConfigured',
      { 'Fn::Join': ['', ['https://', { Ref: 'WebDomainName' }]] },
      {
        'Fn::Join': ['', [
          'https://',
          { 'Fn::GetAtt': [expect.stringMatching(/^WebDistribution/), 'DomainName'] },
        ]],
      },
    ],
  });
});
