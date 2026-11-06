#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { acknowledgeKnownNagFindings } from '../lib/acknowledge-nag-findings';
import {
  OPTIONAL_MODULES_CONTEXT_KEY,
  parseOptionalModules,
} from '../lib/config/optional-modules';
import { MukurojiStack } from '../lib/stacks/mukuroji-stack';

const app = new cdk.App();
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
const stack = new MukurojiStack(app, 'Mukuroji', {
  optionalModules: parseOptionalModules(
    app.node.tryGetContext(OPTIONAL_MODULES_CONTEXT_KEY),
  ),
});
acknowledgeKnownNagFindings(stack);
