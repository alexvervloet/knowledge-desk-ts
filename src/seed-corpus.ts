/**
 * The demo corpus, copied across from the Python seed unchanged.
 *
 * Documents are deliberately several paragraphs. At chunkSize 1000 with
 * chunkOverlap 150 a one-line document is one chunk, which makes retrieval a
 * no-op: every query returns the whole corpus and k means nothing. Multi-chunk
 * documents are what make ranking, and any measurement of it, real.
 *
 * Split out of seed.ts because eight documents of prose in the middle of the
 * seeding logic buries it.
 */

export const ACME_HANDBOOK = `Acme Corp employee handbook, revised for the current year.

Refunds are processed within five business days of the request reaching the
support queue. A refund on an order paid by card returns to the original card
and may take a further three to five days to appear, which is the card network's
timing and not something support can accelerate. Refunds on invoiced accounts are
issued as account credit by default; a customer who wants the money returned
instead has to ask, and that request needs a manager's approval because it
reverses a recognised payment.

Expenses are reimbursed monthly. Submit receipts by the last working day of the
month and the payment lands with the following month's salary. Anything over two
hundred dollars needs a line manager's approval before it is incurred, not after,
and the most common reason a claim is rejected is that this happened backwards.

Holiday is twenty-five days plus public holidays, accrued monthly from the start
date. Up to five unused days carry into the next year and expire at the end of
March. Anything beyond five days is lost, so managers are asked to plan leave
across the team rather than approving it first-come.

Parental leave is sixteen weeks at full pay for the primary carer and four weeks
for the secondary carer, available from the first day of employment with no
qualifying period. Leave can be taken in up to three blocks within the first year.
`

export const ACME_SECURITY = `Acme Corp security policy.

Production API keys are rotated every ninety days and stored in the company
vault. Rotation is automated and does not require a deployment; a service that
breaks on rotation is a service that has cached a credential it should have been
reading per request, and that is a bug to fix rather than a reason to extend the
rotation window.

Access to production data requires a named justification recorded at the time of
access. The justification is not reviewed before access is granted, because a
review gate turns an emergency into an outage. It is reviewed afterwards, weekly,
and an access without a justification is treated as an incident regardless of
whether anything was read.

Laptops are full-disk encrypted and enrolled in device management. A lost device
is reported the same day. Reporting late is the problem worth avoiding, so there
is no penalty attached to reporting at all.

Third-party services that will hold customer data need a review before signing,
and the review asks three questions: where the data is stored, who at the vendor
can read it, and what happens to it when the contract ends.
`

export const ACME_SALARY = `Acme Corp compensation bands, confidential to the People team.

Engineering is banded from E1 to E6. E1 starts at fifty-two thousand and E6 tops
out at one hundred and forty-eight thousand, with each band overlapping the next
by roughly fifteen percent so that a strong performer near the top of a band is
paid more than a new joiner in the band above.

Reviews happen twice a year. The budget for increases is set in advance as a
percentage of total payroll, which means every increase is funded from the same
pool and a manager arguing for one person is implicitly arguing against another.
This is stated plainly here because pretending otherwise makes the conversation
worse rather than kinder.

Equity is granted on joining and refreshed annually from the third year. Grants
vest monthly over four years with a one-year cliff on the initial grant only.

Offers above the midpoint of a band need People team approval, and offers above
the top of a band need an exception recorded with the reasoning.
`

export const ACME_INCIDENTS = `Acme Corp incident response runbook.

An incident starts when someone declares one. There is no severity threshold to
argue about first: declare it, then downgrade it if it turns out to be small. The
cost of a spurious incident is an hour of attention. The cost of a late one is
the outage plus the time spent deciding whether it counted.

The declaring person is the incident lead until they hand it over explicitly.
The lead does not debug. The lead keeps the timeline, decides what gets
communicated, and pulls in the people who do debug.

Customer communication goes out within thirty minutes of declaring, even when the
only honest content is that something is wrong and the cause is not yet known.
Silence reads as absence, and the status page is cheaper than the support queue.

Every incident gets a written review within five working days. The review names
what happened and what changes, and it does not name who made the mistake,
because a review that assigns blame is a review that stops receiving information.
`

export const GLOBEX_PRODUCTS = `Globex Inc product overview.

Globex manufactures industrial widgets and ships them worldwide. The current
range covers three families: the standard series for general assembly work, the
heavy series rated for continuous load, and the precision series held to a
tighter tolerance for instrumentation customers.

Lead time is four weeks for standard, six for heavy, and eight to ten for
precision, measured from a confirmed order rather than from first contact.
Precision orders carry a longer tail because each batch is measured individually
and a batch that fails measurement is remade rather than sold down as standard.

Minimum order quantity is fifty units for standard and heavy, and ten for
precision. Below that the setup cost dominates the unit price to the point where
the quote stops being useful to the customer.

Warranty is twenty-four months from delivery against manufacturing defect. Wear
in normal service is not a defect, and the distinction is made by inspection
rather than by the age of the part.
`

export const GLOBEX_ONBOARDING = `Globex Inc new hire onboarding.

New hires complete orientation during their first week. Orientation covers the
safety briefing, the site tour, and the systems access request, and none of the
three can be skipped or done remotely because two of them are physical and the
third depends on the first two being signed off.

Week two is shadowing. A new hire on the production floor pairs with an
experienced operator and does not run a machine alone. On the commercial side the
equivalent is sitting in on customer calls without leading one.

The probation period is six months with a review at three. The review at three
months is the one that matters: it exists so that nothing in the six-month review
is a surprise, and a manager who saves feedback for month six has run the process
wrong.

Equipment is issued on day one. A new hire who arrives to no laptop should treat
that as a failure of the process and escalate rather than wait, because waiting
is how a first week gets lost.
`

export const GLOBEX_PRICING = `Globex Inc pricing and discount policy, commercial team only.

List price for the standard series is fourteen dollars per unit at the minimum
order quantity, falling to nine dollars fifty at ten thousand units. The heavy
series starts at thirty-one dollars and the precision series at eighty-eight,
with the same volume curve applied proportionally.

Sales may discount up to eight percent without approval. Between eight and
fifteen percent needs the commercial director. Beyond fifteen percent needs the
finance director, and in practice that conversation is about whether the order is
strategic rather than about the margin, so it is worth framing it that way.

Payment terms are thirty days net. Sixty-day terms are available to customers
with twelve months of clean payment history and are withdrawn after a single
missed payment rather than after a pattern, because the pattern is what the
withdrawal is meant to prevent.

Quotes expire after thirty days. Material costs move faster than that and an
expired quote reissued at the same number is a decision, not an administrative
step.
`

export const GLOBEX_SUPPLIERS = `Globex Inc supplier list and terms, commercial team only.

Raw stock comes from two suppliers by design rather than one. The primary holds
roughly seventy percent of volume on a twelve-month contract; the secondary holds
the balance on rolling three-month terms and is priced about four percent higher.
That four percent is the cost of not being a single supplier's hostage, and it is
reviewed annually with the explicit understanding that the cheaper answer is the
fragile one.

Tooling is single-sourced because the tolerances are specific to that vendor's
process, and this is a known risk with no current mitigation beyond holding six
months of spare tooling on site.

Payment to suppliers is thirty days, matching what Globex asks of its own
customers. Paying suppliers later than Globex expects to be paid has been raised
as a cash flow option twice and rejected both times.

A supplier who misses two consecutive delivery windows moves to weekly review.
`

export interface SeedDocument {
  path: string
  content: string
  /** The group whose members may read it. Absent means everyone in the org. */
  group?: string
}

export interface SeedOrg {
  slug: string
  name: string
  owner: string
  /**
   * A second member who is NOT in the restricted group. Together with the owner
   * this is the pair that makes an intra-org boundary visible.
   */
  member: string
  group: string
  documents: SeedDocument[]
}

export const ORGS: SeedOrg[] = [
  {
    slug: 'acme',
    name: 'Acme Corp',
    owner: 'owner@acme.test',
    member: 'analyst@acme.test',
    group: 'people-team',
    documents: [
      { path: 'handbook.md', content: ACME_HANDBOOK },
      { path: 'security.md', content: ACME_SECURITY },
      { path: 'incidents.md', content: ACME_INCIDENTS },
      { path: 'compensation.md', content: ACME_SALARY, group: 'people-team' },
    ],
  },
  {
    slug: 'globex',
    name: 'Globex Inc',
    owner: 'owner@globex.test',
    member: 'operator@globex.test',
    group: 'commercial',
    documents: [
      { path: 'products.md', content: GLOBEX_PRODUCTS },
      { path: 'onboarding.md', content: GLOBEX_ONBOARDING },
      { path: 'pricing.md', content: GLOBEX_PRICING, group: 'commercial' },
      { path: 'suppliers.md', content: GLOBEX_SUPPLIERS, group: 'commercial' },
    ],
  },
]
