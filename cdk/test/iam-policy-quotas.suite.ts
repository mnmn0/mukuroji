/** Registers tests that keep every IAM role within the IAM policy size and count quotas. */
import { expect, test } from '@jest/globals';
import type { Template } from 'aws-cdk-lib/assertions';
import { createTemplate, synthesizedTemplate } from './test-support';

/** IAM limit on the combined size of a role's inline policies, in non-whitespace characters. */
const ROLE_INLINE_POLICY_QUOTA = 10_240;

/** IAM limit on the size of one customer-managed policy, in non-whitespace characters. */
const MANAGED_POLICY_QUOTA = 6_144;

/** IAM default limit on the number of managed policies attached to one role. */
const ROLE_MANAGED_POLICY_COUNT_QUOTA = 10;

/**
 * Share of a size quota the estimate may use. The rest is headroom for ARNs longer than the
 * estimate and for statements later changes add.
 */
const SIZE_BUDGET_RATIO = 0.8;

/** Length assumed for any ARN, URL, or name that CloudFormation resolves at deploy time. */
const RESOLVED_VALUE_LENGTH = 128;

/** Entries assumed for a list parameter split at deploy time, such as Bedrock model ARNs. */
const SPLIT_LIST_ENTRIES = 8;

/** Pseudo parameters resolved to their longest value in any commercial or GovCloud partition. */
const PSEUDO_PARAMETER_VALUES: Readonly<Record<string, string>> = {
  'AWS::AccountId': '0'.repeat(12),
  'AWS::Partition': 'aws-us-gov',
  'AWS::Region': 'x'.repeat(14),
  'AWS::URLSuffix': 'amazonaws.com.cn',
};

/** A CloudFormation resource as the template stores it. */
type TemplateResource = {
  /** CloudFormation resource type, such as `AWS::IAM::Role`. */
  readonly Type?: unknown;
  /** Resource properties. */
  readonly Properties?: Record<string, unknown>;
};

/** Running totals of one role's policy usage while the template is scanned. */
type RoleUsageTotals = {
  /** Estimated size of the inline policies counted so far. */
  inlineSize: number;
  /** Estimated size of each customer-managed policy counted so far, by logical ID. */
  managedSizes: Record<string, number>;
  /** Number of managed policies counted so far. */
  managedCount: number;
};

/** Estimated policy usage of one role. */
type RolePolicyUsage = {
  /** Logical ID of the role. */
  readonly role: string;
  /** Estimated size of every inline policy of the role together. */
  readonly inlineSize: number;
  /** Estimated size of each customer-managed policy attached to the role, by logical ID. */
  readonly managedSizes: Readonly<Record<string, number>>;
  /** Number of customer-managed and AWS-managed policies attached to the role. */
  readonly managedCount: number;
};

/**
 * Reports whether a value is a plain object.
 *
 * @param value Value to check.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Picks the longest of resolved candidate values.
 *
 * @param candidates Resolved values.
 * @returns The candidate whose JSON form is longest.
 */
function longest(candidates: readonly unknown[]): unknown {
  return candidates.reduce<unknown>((best, candidate) =>
    JSON.stringify(candidate).length > JSON.stringify(best ?? '').length ? candidate : best, '');
}

/**
 * Replaces CloudFormation intrinsics with values at least as long as the deployed ones, so a
 * policy's length approximates the size IAM counts after deployment.
 *
 * @param value Policy document fragment.
 * @returns The fragment with intrinsics resolved to placeholder strings or lists.
 */
function resolveConservatively(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(resolveConservatively);
  if (!isRecord(value)) return value;
  if ('Ref' in value) {
    const name = value.Ref;
    return typeof name === 'string' && name in PSEUDO_PARAMETER_VALUES
      ? PSEUDO_PARAMETER_VALUES[name]
      : 'r'.repeat(RESOLVED_VALUE_LENGTH);
  }
  if ('Fn::GetAtt' in value || 'Fn::ImportValue' in value) return 'a'.repeat(RESOLVED_VALUE_LENGTH);
  const join = value['Fn::Join'];
  if (Array.isArray(join) && typeof join[0] === 'string' && Array.isArray(join[1])) {
    const separator = join[0];
    return join[1].map((part) => {
      const resolved = resolveConservatively(part);
      return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
    }).join(separator);
  }
  if (Array.isArray(value['Fn::If'])) {
    return longest(value['Fn::If'].slice(1).map(resolveConservatively));
  }
  if (Array.isArray(value['Fn::Select'])) {
    const list = resolveConservatively(value['Fn::Select'][1]);
    return Array.isArray(list) ? longest(list) : list;
  }
  if ('Fn::Split' in value) {
    return Array.from({ length: SPLIT_LIST_ENTRIES }, () => 's'.repeat(RESOLVED_VALUE_LENGTH));
  }
  const sub = value['Fn::Sub'];
  if (typeof sub === 'string' || Array.isArray(sub)) {
    const pattern = Array.isArray(sub) ? sub[0] : sub;
    if (typeof pattern === 'string') {
      return pattern.replace(/\$\{([^}]+)\}/g, (_, name: string) =>
        PSEUDO_PARAMETER_VALUES[name] ?? 'x'.repeat(RESOLVED_VALUE_LENGTH));
    }
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, resolveConservatively(entry)]),
  );
}

/**
 * Estimates the size IAM counts for a deployed policy document, which excludes whitespace.
 *
 * @param document Policy document from the template.
 * @returns Estimated number of non-whitespace characters.
 */
function estimatePolicySize(document: unknown): number {
  return JSON.stringify(resolveConservatively(document)).replace(/\s/g, '').length;
}

/**
 * Lists the logical IDs of the template roles a policy resource is attached to.
 *
 * @param resource `AWS::IAM::Policy` or `AWS::IAM::ManagedPolicy` resource.
 * @returns Logical IDs referenced in its `Roles` property.
 */
function attachedRoleIds(resource: TemplateResource): string[] {
  const roles = resource.Properties?.Roles;
  if (!Array.isArray(roles)) return [];
  return roles.flatMap((role) => isRecord(role) && typeof role.Ref === 'string' ? [role.Ref] : []);
}

/**
 * Estimates the inline and managed policy usage of every role in a template.
 *
 * @param template Synthesized stack template.
 * @returns One usage entry per `AWS::IAM::Role`.
 */
function measureRolePolicies(template: Template): RolePolicyUsage[] {
  const resources: Record<string, TemplateResource> = template.toJSON().Resources;
  const usage = new Map<string, RoleUsageTotals>();
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== 'AWS::IAM::Role') continue;
    const embedded = resource.Properties?.Policies;
    const awsManaged = resource.Properties?.ManagedPolicyArns;
    usage.set(logicalId, {
      inlineSize: (Array.isArray(embedded) ? embedded : [])
        .reduce((total: number, policy: unknown) =>
          total + (isRecord(policy) ? estimatePolicySize(policy.PolicyDocument) : 0), 0),
      managedSizes: {},
      managedCount: Array.isArray(awsManaged) ? awsManaged.length : 0,
    });
  }
  for (const [logicalId, resource] of Object.entries(resources)) {
    const isInline = resource.Type === 'AWS::IAM::Policy';
    if (!isInline && resource.Type !== 'AWS::IAM::ManagedPolicy') continue;
    const size = estimatePolicySize(resource.Properties?.PolicyDocument);
    for (const roleId of attachedRoleIds(resource)) {
      const role = usage.get(roleId);
      if (!role) continue;
      if (isInline) {
        role.inlineSize += size;
      } else {
        role.managedSizes[logicalId] = size;
        role.managedCount += 1;
      }
    }
  }
  return [...usage].map(([role, entry]) => ({ role, ...entry }));
}

/**
 * Lists the quota findings of a template's roles.
 *
 * @param template Synthesized stack template.
 * @returns One message per role or policy over its budget.
 */
function findQuotaViolations(template: Template): string[] {
  const inlineBudget = ROLE_INLINE_POLICY_QUOTA * SIZE_BUDGET_RATIO;
  const managedBudget = MANAGED_POLICY_QUOTA * SIZE_BUDGET_RATIO;
  return measureRolePolicies(template).flatMap((usage) => {
    const { role, inlineSize, managedSizes, managedCount } = usage;
    return [
      ...(inlineSize > inlineBudget
        ? [`${role}: inline policies ~${inlineSize} chars > ${inlineBudget}`]
        : []),
      ...Object.entries(managedSizes)
        .filter(([, size]) => size > managedBudget)
        .map(([policy, size]) =>
          `${role}: managed policy ${policy} ~${size} chars > ${managedBudget}`),
      ...(managedCount > ROLE_MANAGED_POLICY_COUNT_QUOTA
        ? [`${role}: ${managedCount} managed policies > ${ROLE_MANAGED_POLICY_COUNT_QUOTA}`]
        : []),
    ];
  });
}

test('keeps every role within the IAM policy quotas with every optional module on', () => {
  expect(findQuotaViolations(synthesizedTemplate)).toEqual([]);
});

test('keeps every role within the IAM policy quotas with the default modules', () => {
  expect(findQuotaViolations(createTemplate({}))).toEqual([]);
});

test('keeps the API data grants out of the API role inline policy budget', () => {
  const usage = measureRolePolicies(synthesizedTemplate)
    .find(({ role }) => role.startsWith('ApiFunctionServiceRole'));
  expect(usage).toBeDefined();
  expect(Object.keys(usage?.managedSizes ?? {})).toEqual(expect.arrayContaining([
    expect.stringMatching(/^ApiTableDataPolicy/),
    expect.stringMatching(/^ApiAnalyticsTablePolicy/),
    expect.stringMatching(/^ApiFeatureDataPolicy/),
    expect.stringMatching(/^ApiTransactionConditionPolicy/),
  ]));
});
