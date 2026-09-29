#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { acknowledgeKnownNagFindings } from '../lib/acknowledge-nag-findings';
import { MukurojiStack } from '../lib/stacks/mukuroji-stack';

const app = new cdk.App();
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
const stack = new MukurojiStack(app, 'Mukuroji');
acknowledgeKnownNagFindings(stack);
