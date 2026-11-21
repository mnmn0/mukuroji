import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Principal that runs as a role but adds its statements to one customer-managed policy on
 * that role instead of the role's inline default policy.
 *
 * IAM limits a role's inline policies to 10,240 characters in total, while each
 * customer-managed policy has its own 6,144-character quota. Grants given to this principal
 * therefore stay off the role's shared inline budget.
 */
export class ManagedPolicyPrincipal extends iam.PrincipalBase {
  /** The role's account, so grants stay identity-based instead of resource-based. */
  override readonly principalAccount: string | undefined;

  /**
   * @param role Role the policy is attached to, whose principal the grants name.
   * @param policy Customer-managed policy that receives the statements.
   */
  constructor(
    private readonly role: iam.IRole,
    private readonly policy: iam.ManagedPolicy,
  ) {
    super();
    this.principalAccount = role.principalAccount;
  }

  /** The role's principal, which the grantee runs as. */
  get policyFragment(): iam.PrincipalPolicyFragment {
    return this.role.policyFragment;
  }

  /**
   * Keeps two principals of one role distinct when CDK deduplicates principals.
   *
   * @returns A key unique to the receiving policy.
   */
  dedupeString(): string | undefined {
    return `ManagedPolicyPrincipal:${this.policy.node.path}`;
  }

  /**
   * Adds a statement to the receiving managed policy.
   *
   * @param statement Statement to add.
   * @returns The policy that holds it.
   */
  override addToPrincipalPolicy(statement: iam.PolicyStatement): iam.AddToPrincipalPolicyResult {
    this.policy.addStatements(statement);
    return { statementAdded: true, policyDependable: this.policy };
  }
}
