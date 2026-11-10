import type { Construct } from 'constructs';
import type { MukurojiStackProps } from '../lib/stacks/mukuroji-stack';

/** Context key that turns on the optional restore drill. */
export const RESTORE_DRILL_CONTEXT_KEY = 'mukuroji:restoreDrill';

/** Context key that seeds the demo members, Teams, Projects, and Work Items. */
export const DEMO_DATA_CONTEXT_KEY = 'mukuroji:demoData';

/** Optional-module switches the stack receives through its Props. */
type StackModuleProps = Pick<MukurojiStackProps, 'restoreDrillEnabled' | 'demoDataEnabled'>;

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
    demoDataEnabled: readBooleanContext(app, DEMO_DATA_CONTEXT_KEY),
  };
}
