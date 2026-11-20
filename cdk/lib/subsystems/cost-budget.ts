import * as cdk from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';

/** Inputs for the monthly AWS cost budget. */
export type CostBudgetInputs = Readonly<{
  /** Monthly USD amount that the alerts compare the account's cost against. */
  readonly monthlyBudgetUsd: cdk.CfnParameter;
  /** Address that receives the alerts; empty sends them to `fallbackEmail`. */
  readonly alertEmail: cdk.CfnParameter;
  /** Address used when `alertEmail` is empty, normally the initial owner's email. */
  readonly fallbackEmail: cdk.CfnParameter;
}>;

/** Budget resource exposed for assertions and outputs. */
export type CostBudgetResources = Readonly<{
  /** Monthly cost budget for the account. */
  readonly monthlyCostBudget: budgets.CfnBudget;
}>;

/** Alerts sent per month, as a percentage of the budget. */
const BUDGET_ALERTS: readonly Readonly<{
  /** Whether the alert compares actual or forecasted cost. */
  readonly notificationType: 'ACTUAL' | 'FORECASTED';
  /** Percentage of the monthly budget that triggers the alert. */
  readonly thresholdPercent: number;
}>[] = [
  { notificationType: 'ACTUAL', thresholdPercent: 80 },
  { notificationType: 'ACTUAL', thresholdPercent: 100 },
  { notificationType: 'FORECASTED', thresholdPercent: 100 },
];

/**
 * Creates the monthly AWS cost budget and its email alerts.
 *
 * The budget covers the whole account rather than resources with the cost allocation tag,
 * because a tag reaches Budgets only after someone activates it in the Billing console, and
 * some charges (data transfer, tax) carry no resource tag. Deploy into a dedicated account
 * so the account's cost is the application's cost.
 *
 * @param scope - Stack that directly owns the budget.
 * @param inputs - Budget amount and alert recipient parameters.
 * @returns The budget resource.
 */
export function buildCostBudget(
  scope: cdk.Stack,
  inputs: CostBudgetInputs,
): CostBudgetResources {
  const alertEmailBlank = new cdk.CfnCondition(scope, 'CostBudgetAlertEmailBlank', {
    expression: cdk.Fn.conditionEquals(inputs.alertEmail.valueAsString, ''),
  });
  const alertAddress = cdk.Token.asString(cdk.Fn.conditionIf(
    alertEmailBlank.logicalId,
    inputs.fallbackEmail.valueAsString,
    inputs.alertEmail.valueAsString,
  ));
  const monthlyCostBudget = new budgets.CfnBudget(scope, 'MonthlyCostBudget', {
    budget: {
      budgetType: 'COST',
      timeUnit: 'MONTHLY',
      budgetLimit: {
        amount: inputs.monthlyBudgetUsd.valueAsNumber,
        unit: 'USD',
      },
    },
    notificationsWithSubscribers: BUDGET_ALERTS.map((alert) => ({
      notification: {
        notificationType: alert.notificationType,
        comparisonOperator: 'GREATER_THAN',
        threshold: alert.thresholdPercent,
        thresholdType: 'PERCENTAGE',
      },
      subscribers: [{ subscriptionType: 'EMAIL', address: alertAddress }],
    })),
  });

  return { monthlyCostBudget };
}
