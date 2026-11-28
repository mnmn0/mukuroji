import type { Construct } from 'constructs';
import type { MukurojiStackProps } from '../lib/stacks/mukuroji-stack';
import {
  WEB_CERTIFICATE_ARN_CONTEXT_KEY,
  WEB_DOMAIN_NAME_CONTEXT_KEY,
  WEB_HOSTED_ZONE_ID_CONTEXT_KEY,
  type WebCustomDomainSettings,
} from '../lib/subsystems/web-distribution';

/** Context key that turns on the optional restore drill. */
export const RESTORE_DRILL_CONTEXT_KEY = 'mukuroji:restoreDrill';

/** Context key that seeds the demo members, Teams, Projects, and Work Items. */
export const DEMO_DATA_CONTEXT_KEY = 'mukuroji:demoData';

/** Context key that turns on the optional external connector workers. */
export const CONNECTORS_CONTEXT_KEY = 'mukuroji:connectors';

/** Context key that turns on the optional GitHub App module of the review inbox (ADR 0079). */
export const GITHUB_APP_CONTEXT_KEY = 'mukuroji:githubApp';

/** Context key that turns on the optional request email ingestion. */
export const REQUEST_EMAIL_CONTEXT_KEY = 'mukuroji:requestEmail';

/** Context key that turns on the optional tenant export and closure workers. */
export const TENANT_LIFECYCLE_CONTEXT_KEY = 'mukuroji:tenantLifecycle';

/** Context key that turns on Software factory: Agent Runs, Agent settings, and agent credentials. */
export const SOFTWARE_FACTORY_CONTEXT_KEY = 'mukuroji:softwareFactory';

/** Optional-module switches the stack receives through its Props. */
type StackModuleProps = Pick<
  MukurojiStackProps,
  | 'restoreDrillEnabled'
  | 'connectorsEnabled'
  | 'githubAppEnabled'
  | 'requestEmailEnabled'
  | 'tenantLifecycleEnabled'
  | 'softwareFactoryEnabled'
  | 'demoDataEnabled'
>;

/** Module switches that deploy every optional module, for full-coverage synthesis and checks. */
export const ALL_STACK_MODULE_PROPS: StackModuleProps = {
  restoreDrillEnabled: true,
  connectorsEnabled: true,
  githubAppEnabled: true,
  requestEmailEnabled: true,
  tenantLifecycleEnabled: true,
  softwareFactoryEnabled: true,
  demoDataEnabled: true,
};

/**
 * Reads a boolean CDK context value given in `cdk.json` or as `-c key=true`.
 *
 * @param scope Construct whose context is read.
 * @param key Context key.
 * @returns Whether the value is `true` or the string `"true"`.
 */
function readBooleanContext(scope: Construct, key: string): boolean {
  const value: unknown = scope.node.tryGetContext(key);
  return value === true || value === 'true';
}

/**
 * Resolves which optional modules to deploy from the app's CDK context.
 *
 * The composition root reads context once so the stack itself depends only on its Props.
 *
 * @param app App whose context selects the modules.
 * @returns Module switches to pass to `MukurojiStack`.
 */
export function readStackModuleProps(app: Construct): StackModuleProps {
  return {
    restoreDrillEnabled: readBooleanContext(app, RESTORE_DRILL_CONTEXT_KEY),
    connectorsEnabled: readBooleanContext(app, CONNECTORS_CONTEXT_KEY),
    githubAppEnabled: readBooleanContext(app, GITHUB_APP_CONTEXT_KEY),
    requestEmailEnabled: readBooleanContext(app, REQUEST_EMAIL_CONTEXT_KEY),
    tenantLifecycleEnabled: readBooleanContext(app, TENANT_LIFECYCLE_CONTEXT_KEY),
    softwareFactoryEnabled: readBooleanContext(app, SOFTWARE_FACTORY_CONTEXT_KEY),
    demoDataEnabled: readBooleanContext(app, DEMO_DATA_CONTEXT_KEY),
  };
}

/**
 * Reads a string CDK context value given in `cdk.json` or as `-c key=value`.
 *
 * @param scope Construct whose context is read.
 * @param key Context key.
 * @returns The value, or an empty string when the key is not set.
 * @throws Error when the value is set but is not a string.
 */
function readStringContext(scope: Construct, key: string): string {
  const value: unknown = scope.node.tryGetContext(key);
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new Error(`CDK context ${key} must be a string.`);
  }
  return value;
}

/**
 * Reads the optional custom domain for the Web app from the app's CDK context.
 *
 * The stack validates the values, so this only collects them.
 *
 * @param app App whose context holds the `mukuroji:web*` keys.
 * @returns Custom domain settings to pass to `MukurojiStack`.
 */
export function readWebCustomDomainSettings(app: Construct): WebCustomDomainSettings {
  return {
    domainName: readStringContext(app, WEB_DOMAIN_NAME_CONTEXT_KEY),
    certificateArn: readStringContext(app, WEB_CERTIFICATE_ARN_CONTEXT_KEY),
    hostedZoneId: readStringContext(app, WEB_HOSTED_ZONE_ID_CONTEXT_KEY),
  };
}
