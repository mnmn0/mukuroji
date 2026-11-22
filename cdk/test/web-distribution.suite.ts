/** Registers tests for the CloudFront distribution that serves the Web app and API. */
import { expect, test } from '@jest/globals';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  API_CONTENT_SECURITY_POLICY,
  buildWebContentSecurityPolicy,
} from '../lib/subsystems/web-response-headers';
import { ALL_STACK_MODULE_PROPS, readWebCustomDomainSettings } from '../bin/stack-modules';
import {
  resolveWebCustomDomain,
  WEB_CERTIFICATE_ARN_CONTEXT_KEY,
  WEB_DOMAIN_NAME_CONTEXT_KEY,
  WEB_HOSTED_ZONE_ID_CONTEXT_KEY,
  WEB_SSO_CALLBACK_PATH,
} from '../lib/subsystems/web-distribution';
import { createTemplate, synthesizedTemplate } from './test-support';

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

test('versions the Web bucket and expires old releases and replaced files', () => {
  const webBuckets = Object.entries(
    synthesizedTemplate.findResources('AWS::S3::Bucket'),
  ).filter(([logicalId]) => logicalId.startsWith('WebBucket'));
  expect(webBuckets).toHaveLength(1);
  const properties = webBuckets[0][1].Properties;

  expect(properties.VersioningConfiguration).toEqual({ Status: 'Enabled' });
  expect(properties.LifecycleConfiguration).toEqual({
    Rules: [
      {
        ExpirationInDays: 180,
        Id: 'ExpireOldWebReleases',
        Prefix: 'releases/',
        Status: 'Enabled',
      },
      {
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
        Id: 'ExpireReplacedWebFiles',
        NoncurrentVersionExpiration: { NoncurrentDays: 30 },
        Status: 'Enabled',
      },
      {
        ExpiredObjectDeleteMarker: true,
        Id: 'RemoveExpiredWebDeleteMarkers',
        Status: 'Enabled',
      },
    ],
  });
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

test('answers 404 for release copies instead of serving them', () => {
  const code = requireFunctionCode('WebSpaRoutingFunction');
  const handler = new Function(`${code}; return handler;`)() as (
    event: { request: { uri: string } },
  ) => { uri?: string; statusCode?: number; headers?: Record<string, { value: string }> };

  for (const uri of [
    '/releases',
    '/releases/',
    '/releases/0123456789abcdef0123456789abcdef01234567/index.html',
    '/releases/0123456789abcdef0123456789abcdef01234567/release-assets.txt',
    '/%72eleases/0123456789abcdef0123456789abcdef01234567/index.html',
    '/release-assets.txt',
  ]) {
    const response = handler({ request: { uri } });
    expect(response.statusCode).toBe(404);
    expect(response.headers).toEqual({ 'cache-control': { value: 'no-store' } });
  }
  // Names that only start like the release prefix stay ordinary paths.
  expect(handler({ request: { uri: '/releases-notes' } }).uri).toBe('/index.html');
  expect(handler({ request: { uri: '/%E0%A4%A' } }).uri).toBe('/index.html');
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

test('serves only the CloudFront domain without a custom domain', () => {
  synthesizedTemplate.hasResourceProperties('AWS::S3::Bucket', {
    CorsConfiguration: {
      CorsRules: Match.arrayWith([
        Match.objectLike({
          AllowedOrigins: [distributionOrigin],
          AllowedMethods: ['GET', 'HEAD', 'PUT'],
        }),
      ]),
    },
  });
  synthesizedTemplate.hasOutput('WebUrl', { Value: distributionOrigin });
  synthesizedTemplate.hasOutput('WebBucketName', {});
  synthesizedTemplate.hasOutput('WebDistributionId', {});
  synthesizedTemplate.hasOutput('WebDistributionDomainName', {
    Value: { 'Fn::GetAtt': [Match.stringLikeRegexp('^WebDistribution'), 'DomainName'] },
  });

  const config = requireDistributionConfig();
  expect(config.Aliases).toBeUndefined();
  expect(config.ViewerCertificate).toBeUndefined();
  expect(synthesizedTemplate.findResources('AWS::Route53::RecordSet')).toEqual({});
  const template = synthesizedTemplate.toJSON();
  expect(Object.keys(template.Parameters)).not.toEqual(
    expect.arrayContaining([expect.stringMatching(/^Web(DomainName|CertificateArn|HostedZoneId)$/)]),
  );
  expect(template.Rules.WebSsoCallbackOnCustomDomain).toBeUndefined();
  expect(template.Conditions?.WebCustomDomainConfigured).toBeUndefined();
});

test('links notification Email to the CloudFront origin without a custom domain', () => {
  const scheduledJobs = Object.values(
    synthesizedTemplate.findResources('AWS::Lambda::Function'),
  ).filter((resource) =>
    resource.Properties.Environment?.Variables?.NOTIFICATION_EMAIL_APP_ORIGIN !== undefined);
  expect(scheduledJobs).toHaveLength(1);
  expect(
    scheduledJobs[0].Properties.Environment.Variables.NOTIFICATION_EMAIL_APP_ORIGIN,
  ).toEqual({
    'Fn::Join': ['', [
      'https://',
      { 'Fn::GetAtt': [expect.stringMatching(/^WebDistribution/), 'DomainName'] },
    ]],
  });
});

/** Custom domain used by the configured-domain assertions. */
const customDomainName = 'wbs.example.co.jp';

/** us-east-1 certificate ARN used by the configured-domain assertions. */
const customCertificateArn =
  'arn:aws:acm:us-east-1:123456789012:certificate/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';

/** Template synthesized once with a custom domain and a Route 53 hosted zone. */
let customDomainTemplate: Template | undefined;

/**
 * Synthesizes the stack with a custom domain on first use and reuses it afterwards.
 *
 * @returns Template of a stack whose CDK context sets every `mukuroji:web*` key.
 */
function requireCustomDomainTemplate(): Template {
  if (customDomainTemplate === undefined) {
    const app = new cdk.App({
      context: {
        [WEB_DOMAIN_NAME_CONTEXT_KEY]: customDomainName,
        [WEB_CERTIFICATE_ARN_CONTEXT_KEY]: customCertificateArn,
        [WEB_HOSTED_ZONE_ID_CONTEXT_KEY]: 'Z0123456789ABCDEFGHIJ',
      },
    });
    customDomainTemplate = createTemplate({
      ...ALL_STACK_MODULE_PROPS,
      webCustomDomain: readWebCustomDomainSettings(app),
    });
  }
  return customDomainTemplate;
}

test('reads the custom domain from CDK context', () => {
  const app = new cdk.App({
    context: {
      [WEB_DOMAIN_NAME_CONTEXT_KEY]: customDomainName,
      [WEB_CERTIFICATE_ARN_CONTEXT_KEY]: customCertificateArn,
    },
  });
  expect(readWebCustomDomainSettings(app)).toEqual({
    domainName: customDomainName,
    certificateArn: customCertificateArn,
    hostedZoneId: '',
  });
  expect(readWebCustomDomainSettings(new cdk.App())).toEqual({
    domainName: '',
    certificateArn: '',
    hostedZoneId: '',
  });
  expect(() => readWebCustomDomainSettings(
    new cdk.App({ context: { [WEB_DOMAIN_NAME_CONTEXT_KEY]: 1 } }),
  )).toThrow(`CDK context ${WEB_DOMAIN_NAME_CONTEXT_KEY} must be a string.`);
});

test('the committed cdk.json declares a valid custom domain setting', () => {
  const cdkJson: unknown = JSON.parse(
    readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'),
  );
  const app = new cdk.App({
    context: typeof cdkJson === 'object' && cdkJson !== null && 'context' in cdkJson
      && typeof cdkJson.context === 'object' && cdkJson.context !== null
      ? { ...cdkJson.context }
      : {},
  });
  // The keys stay in cdk.json so the domain is changed there; empty keeps the CloudFront domain.
  for (const key of [
    WEB_DOMAIN_NAME_CONTEXT_KEY,
    WEB_CERTIFICATE_ARN_CONTEXT_KEY,
    WEB_HOSTED_ZONE_ID_CONTEXT_KEY,
  ]) {
    expect(typeof app.node.tryGetContext(key)).toBe('string');
  }
  expect(() => resolveWebCustomDomain(readWebCustomDomainSettings(app))).not.toThrow();
});

test('accepts only a complete, well-formed custom domain', () => {
  expect(resolveWebCustomDomain()).toBeUndefined();
  expect(resolveWebCustomDomain({ domainName: ' ', certificateArn: '', hostedZoneId: '' }))
    .toBeUndefined();
  expect(resolveWebCustomDomain({
    domainName: customDomainName,
    certificateArn: customCertificateArn,
    hostedZoneId: '',
  })).toEqual({ domainName: customDomainName, certificateArn: customCertificateArn });
  expect(resolveWebCustomDomain({
    domainName: customDomainName,
    certificateArn: customCertificateArn,
    hostedZoneId: 'Z0123456789',
  })).toEqual({
    domainName: customDomainName,
    certificateArn: customCertificateArn,
    hostedZoneId: 'Z0123456789',
  });

  const incomplete = /together/;
  expect(() => resolveWebCustomDomain({ domainName: customDomainName })).toThrow(incomplete);
  expect(() => resolveWebCustomDomain({ certificateArn: customCertificateArn })).toThrow(incomplete);
  expect(() => resolveWebCustomDomain({ hostedZoneId: 'Z0123456789' })).toThrow(incomplete);
  for (const domainName of ['localhost', 'WBS.example.com', 'https://wbs.example.com', 'wbs.example.com.']) {
    expect(() => resolveWebCustomDomain({ domainName, certificateArn: customCertificateArn }))
      .toThrow(`${WEB_DOMAIN_NAME_CONTEXT_KEY} must be a lowercase DNS name`);
  }
  // CloudFront reads certificates only from us-east-1.
  expect(() => resolveWebCustomDomain({
    domainName: customDomainName,
    certificateArn: customCertificateArn.replace('us-east-1', 'ap-northeast-1'),
  })).toThrow(`${WEB_CERTIFICATE_ARN_CONTEXT_KEY} must be an ACM certificate ARN in us-east-1.`);
  expect(() => resolveWebCustomDomain({
    domainName: customDomainName,
    certificateArn: customCertificateArn,
    hostedZoneId: 'not-a-zone',
  })).toThrow(`${WEB_HOSTED_ZONE_ID_CONTEXT_KEY} must be a Route 53 hosted zone ID.`);
});

test('serves the custom domain with its certificate and Route 53 aliases', () => {
  const template = requireCustomDomainTemplate();
  const distributions = Object.values(template.findResources('AWS::CloudFront::Distribution'));
  expect(distributions).toHaveLength(1);
  const config = distributions[0].Properties.DistributionConfig;
  expect(config.Aliases).toEqual([customDomainName]);
  expect(config.ViewerCertificate).toEqual({
    AcmCertificateArn: customCertificateArn,
    MinimumProtocolVersion: 'TLSv1.2_2021',
    SslSupportMethod: 'sni-only',
  });

  const records = Object.values(template.findResources('AWS::Route53::RecordSet'));
  expect(records.map((record) => record.Properties.Type).sort()).toEqual(['A', 'AAAA']);
  for (const record of records) {
    expect(record.Condition).toBeUndefined();
    expect(record.Properties).toEqual(expect.objectContaining({
      HostedZoneId: 'Z0123456789ABCDEFGHIJ',
      Name: customDomainName,
      AliasTarget: {
        DNSName: { 'Fn::GetAtt': [expect.stringMatching(/^WebDistribution/), 'DomainName'] },
        HostedZoneId: expect.anything(),
      },
    }));
  }
});

test('makes the custom domain the canonical app URL', () => {
  const template = requireCustomDomainTemplate();
  const customOrigin = `https://${customDomainName}`;
  template.hasOutput('WebUrl', { Value: customOrigin });
  template.hasResourceProperties('AWS::S3::Bucket', {
    CorsConfiguration: {
      CorsRules: Match.arrayWith([
        Match.objectLike({
          AllowedOrigins: [customOrigin, distributionOrigin],
          AllowedMethods: ['GET', 'HEAD', 'PUT'],
        }),
      ]),
    },
  });
  const emailJobs = Object.values(template.findResources('AWS::Lambda::Function'))
    .filter((resource) =>
      resource.Properties.Environment?.Variables?.NOTIFICATION_EMAIL_APP_ORIGIN !== undefined);
  expect(emailJobs).toHaveLength(1);
  expect(emailJobs[0].Properties.Environment.Variables.NOTIFICATION_EMAIL_APP_ORIGIN)
    .toBe(customOrigin);
  const userPools = Object.values(template.findResources('AWS::Cognito::UserPool'));
  expect(JSON.stringify(userPools)).toContain(`${customOrigin}/login`);
  expect(JSON.stringify(userPools)).toContain(`${customOrigin}/forgot-password`);
});

test('requires the SSO callback on the custom domain', () => {
  const rule = requireCustomDomainTemplate().toJSON().Rules.WebSsoCallbackOnCustomDomain;
  expect(rule.Assertions).toEqual([expect.objectContaining({
    Assert: {
      'Fn::Or': [
        { 'Fn::Equals': [{ Ref: 'CognitoSsoRedirectUri' }, ''] },
        {
          'Fn::Equals': [
            { Ref: 'CognitoSsoRedirectUri' },
            `https://${customDomainName}${WEB_SSO_CALLBACK_PATH}`,
          ],
        },
      ],
    },
  })]);
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

/**
 * Reads the default Web bucket name prefix of the GitHub deploy access template.
 *
 * @returns The `WebBucketNamePrefix` parameter default, or `undefined` when it is missing.
 */
function readWebBucketNamePrefix(): string | undefined {
  const template: unknown = JSON.parse(
    readFileSync(path.join(__dirname, '../deploy-access/github-deploy-access.template.json'), 'utf8'),
  );
  let value: unknown = template;
  for (const key of ['Parameters', 'WebBucketNamePrefix', 'Default']) {
    value = typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

test('the GitHub deploy role may write only to the Web bucket name CloudFormation generates', () => {
  const webBucketIds = Object.keys(synthesizedTemplate.findResources('AWS::S3::Bucket')).filter((id) =>
    /^WebBucket[0-9A-F]{8}$/.test(id),
  );
  expect(webBucketIds).toHaveLength(1);
  // CloudFormation names the bucket `<stack name>-<logical ID>-<random suffix>` in lowercase.
  expect(readWebBucketNamePrefix()).toBe(`mukuroji-${webBucketIds[0]?.toLowerCase()}-`);
});

test('runtime-control AppConfig resources carry the tag the GitHub deploy role requires to change them', () => {
  for (const type of ['AWS::AppConfig::Application', 'AWS::AppConfig::Environment', 'AWS::AppConfig::ConfigurationProfile']) {
    const resources = Object.values(synthesizedTemplate.findResources(type));
    expect(resources.length).toBeGreaterThan(0);
    for (const resource of resources) {
      expect(resource.Properties.Tags).toEqual(
        expect.arrayContaining([{ Key: 'mukuroji:application', Value: 'mukuroji' }]),
      );
    }
  }
});
