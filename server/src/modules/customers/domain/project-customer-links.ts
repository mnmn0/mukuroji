import type { Customer, CustomerRequest, ProjectCustomerLinks } from '@mukuroji/contracts'

/**
 * Counts Customer Request to Project links one record at a time, so a store can stream its
 * records without holding them. It keeps only the counts and the names of linked Customers.
 */
export class ProjectCustomerLinkAccumulator {
  /** Request counts by Project, then by Customer. */
  readonly #counts = new Map<string, Map<string, number>>()

  /** Customers with at least one counted request. */
  readonly #linkedCustomers = new Set<string>()

  /** Display names of the Customers seen so far that some counted request links. */
  readonly #names = new Map<string, string>()

  /** Customers left out, such as those hidden by a pending deletion or merge. */
  readonly #isUnavailable: (customerId: string) => boolean

  /**
   * @param isUnavailable - True for a Customer whose links must not be shown.
   */
  constructor(isUnavailable: (customerId: string) => boolean) {
    this.#isUnavailable = isUnavailable
  }

  /**
   * Counts one request's Project links.
   *
   * @param request - Request record, in any order relative to its Customer.
   */
  addRequest(request: CustomerRequest): void {
    // A merged request's links live on in its target, so it would count twice.
    if (request.status === 'merged' || this.#isUnavailable(request.customerId)) return
    for (const projectId of new Set(request.projectLinks.map((link) => link.projectId))) {
      const customers = this.#counts.get(projectId) ?? new Map<string, number>()
      customers.set(request.customerId, (customers.get(request.customerId) ?? 0) + 1)
      this.#counts.set(projectId, customers)
      this.#linkedCustomers.add(request.customerId)
    }
  }

  /**
   * Records the name of a Customer whose requests were counted.
   *
   * @param customer - Customer record, after any retention redaction.
   */
  addCustomer(customer: Customer): void {
    if (this.#isUnavailable(customer.id) || !this.isLinked(customer.id)) return
    this.#names.set(customer.id, customer.name)
  }

  /**
   * Checks whether a counted request belongs to a Customer.
   *
   * @param customerId - Customer to look for.
   * @returns True when some counted request of the Customer links a Project.
   */
  isLinked(customerId: string): boolean {
    return this.#linkedCustomers.has(customerId)
  }

  /**
   * Builds the list. Requests whose Customer record was never added are left out.
   *
   * @returns One entry for each linked Project, ordered by Project ID, with Customers ordered by name.
   */
  result(): ProjectCustomerLinks[] {
    return [...this.#counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([projectId, customers]) => {
        const linked = [...customers.entries()]
          .flatMap(([customerId, requestCount]) => {
            const name = this.#names.get(customerId)
            return name === undefined ? [] : [{ customerId, name, requestCount }]
          })
          .sort((left, right) => left.name.localeCompare(right.name) || left.customerId.localeCompare(right.customerId))
        return linked.length > 0 ? [{ projectId, customers: linked }] : []
      })
  }
}
