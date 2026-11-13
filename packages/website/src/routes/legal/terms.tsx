import { Title } from "@solidjs/meta";
import {
	CLOUD_LICENSE_URL,
	Contact,
	EFFECTIVE_DATE,
	LICENSE_URL,
	OPERATOR,
} from "~/components/legal";

export default function Terms() {
	return (
		<>
			<Title>Terms of Service · Pulsify Cloud</Title>
			<h1>Pulsify Cloud Terms of Service</h1>
			<p>Effective {EFFECTIVE_DATE}.</p>
			<p>
				These terms are the contract between you and us for Pulsify Cloud. You
				accept them when you sign in for the first time, and each time you use
				the service after a new version takes effect. If you do not agree, do
				not use Pulsify Cloud.
			</p>

			<h2>1. Who we are and what these terms cover</h2>
			<p>
				Pulsify Cloud is operated by {OPERATOR.name}, {OPERATOR.form},{" "}
				{OPERATOR.address}, registered under {OPERATOR.registration} ("
				<strong>Pulsify</strong>", "<strong>we</strong>"). "<strong>You</strong>
				" are the person who creates the account, and the company or
				organization you act for. If you act for one, you confirm that you may
				bind it.
			</p>
			<p>
				"<strong>Pulsify Cloud</strong>" or the "<strong>service</strong>" is
				the hosted relay and storage at <code>api.pulsify.cloud</code> and its
				dashboard at <code>pulsify.cloud</code>. "<strong>Customer Data</strong>
				" is everything your application and its users send to your project:
				documents and their history, document and root names, user identifiers,
				grants and presence.
			</p>
			<p>
				The Pulsify software you install yourself is not covered by these terms.
				Its licenses govern it: <a href={LICENSE_URL}>Apache 2.0</a> for the
				engine and the cloud client, and the{" "}
				<a href={CLOUD_LICENSE_URL}>Functional Source License</a> for the cloud
				server.
			</p>
			<p>
				The <a href="/legal/dpa">Data Processing Addendum</a> and the plans and
				prices on the <a href="/pricing">pricing page</a> are part of these
				terms. The <a href="/legal/privacy">Privacy Policy</a> explains how we
				handle your own personal data.
			</p>

			<h2>2. Your account</h2>
			<ul>
				<li>
					Pulsify Cloud is a tool for building software. You use it for your
					business or profession, not as a consumer, and you are at least 18.
				</li>
				<li>
					An account is an email address, and whoever controls that address
					controls the account. Keep the address yours and tell us if you lose
					it.
				</li>
				<li>
					Your project's token secret and API key give full access to its data.
					Keep them on your servers, never in client code, and rotate them from
					the dashboard if they leak. You are responsible for everything done
					with your secrets and through your account.
				</li>
				<li>
					We write to your account's address for sign-in codes, billing and
					notices under these terms. A notice is given when we send it there.
				</li>
			</ul>

			<h2>3. The service and its plans</h2>
			<p>
				We give you the right to use Pulsify Cloud for your own applications,
				within the plan you chose, for as long as these terms apply. The right
				is personal to you: you may put Pulsify Cloud behind your own products,
				but not resell it as a hosting service of its own.
			</p>
			<p>
				The <a href="/pricing">pricing page</a> describes each plan: what it
				includes, its limits, and what happens at a limit. On Free, uploads stop
				at the limits. On Pro, usage beyond the included amounts is billed.
				Usage is what our meters record; they are authoritative unless you show
				an obvious error.
			</p>
			<p>
				We may improve, change or remove features. If a change materially
				reduces what your plan gives you, we tell you 30 days ahead, and you may
				close your account as described in section 9.
			</p>
			<p>
				Features marked beta or preview are for evaluation: they may change or
				disappear without notice and come with no commitment of any kind.
			</p>
			<p>
				We work to keep Pulsify Cloud available and your data safe, and we
				answer support requests sent to <Contact /> as well as we can. Free and
				Pro carry no uptime or response-time commitment and no service credits.
				A commitment of that kind exists only in a separate written agreement
				signed with us.
			</p>

			<h2>4. Fees and payment</h2>
			<ul>
				<li>
					<strong>Merchant of record.</strong> Subscriptions are sold by Polar
					Software, Inc. ("Polar"), our reseller and merchant of record. Polar
					takes your payment, adds the taxes that apply in your country, and
					issues your invoices. Its checkout terms apply to the payment itself.
				</li>
				<li>
					<strong>Prices.</strong> Prices are in euros and exclude VAT and
					similar taxes, which are added at checkout.
				</li>
				<li>
					<strong>Subscription.</strong> Pro is billed in advance, each month or
					each year, and renews for the same period until you cancel. Usage
					beyond the included amounts is billed afterwards, at the rates on the
					pricing page at the time of the usage.
				</li>
				<li>
					<strong>Cancelling.</strong> You can cancel at any time from the
					billing portal in the dashboard. Pro then lasts until the end of the
					period you paid for, and the project returns to Free.
				</li>
				<li>
					<strong>Refunds.</strong> Fees already paid are not refunded, except
					where these terms or the law say otherwise, or where Polar grants a
					refund under its own buyer terms.
				</li>
				<li>
					<strong>Price changes.</strong> We may change prices with 30 days'
					notice. A new price applies from your next renewal, and to usage after
					the notice period.
				</li>
				<li>
					<strong>Failed payment.</strong> If a payment fails or is reversed, we
					may return the project to Free or suspend it until the amount due is
					paid.
				</li>
				<li>
					<strong>Returning to Free.</strong> A project above the Free limits
					keeps its data but refuses uploads. If it is still above them 30 days
					after we tell you, we may delete data to bring it back within them.
				</li>
			</ul>

			<h2>5. Your data</h2>
			<ul>
				<li>
					<strong>It stays yours.</strong> You keep every right to Customer
					Data. You allow us to host, copy, transmit and process it only as
					needed to run, secure and support the service, and to comply with the
					law.
				</li>
				<li>
					<strong>You answer for it.</strong> You are responsible for Customer
					Data: that you have the right to store it with us, that it is lawful,
					and that your users were told what they must be told.
				</li>
				<li>
					<strong>Personal data.</strong> When Customer Data contains personal
					data, you are its controller and we process it for you under the{" "}
					<a href="/legal/dpa">Data Processing Addendum</a>.
				</li>
				<li>
					<strong>Confidentiality.</strong> We treat Customer Data as
					confidential. We look at it only when needed to keep the service
					running and secure, when you ask us for help, or when the law requires
					it.
				</li>
				<li>
					<strong>Location.</strong> Data is stored on Cloudflare's network. A
					root is stored near the first client that opens it, anywhere in the
					world, and cannot be pinned to a country or region.
				</li>
				<li>
					<strong>Backups.</strong> Storage is replicated, but we do not restore
					data on request. Keep your own copy of anything you cannot afford to
					lose; the local stores of Pulsify clients are one way to do it.
				</li>
				<li>
					<strong>Regulated data.</strong> Pulsify Cloud is not certified for
					data under special regimes, such as health data hosting (HDS, HIPAA)
					or payment card data (PCI DSS). Do not store such data unless you have
					verified that the service meets the rules that apply to you.
				</li>
				<li>
					<strong>Statistics.</strong> We may use measurements of how the
					service is used, such as message counts and storage sizes, to operate
					and improve it. Published figures never identify you or your users.
				</li>
			</ul>

			<h2>6. Acceptable use</h2>
			<p>You must not, and must not let anyone:</p>
			<ul>
				<li>
					store or transmit content that is illegal, that infringes someone's
					rights, or that contains malware;
				</li>
				<li>
					use the service to send spam, to attack or probe other systems, or to
					harm other customers;
				</li>
				<li>
					get around limits, metering or access control, including by opening
					several accounts to multiply the Free plan;
				</li>
				<li>
					load-test the service beyond your plan's limits without our written
					agreement;
				</li>
				<li>
					test the security of the service in a way that reaches other
					customers' data or degrades the service. Tell us about the
					vulnerabilities you find at <Contact />;
				</li>
				<li>
					use the service where a failure could cause death, injury or
					environmental damage;
				</li>
				<li>
					use the service in breach of export control or sanctions laws that
					apply to you or to us.
				</li>
			</ul>
			<p>
				Anyone can report illegal content to <Contact />. When we learn of
				content that is plainly illegal, or receive an order from an authority,
				we may disable access to it. We tell you what we did and why, unless the
				law forbids it.
			</p>

			<h2>7. Intellectual property and feedback</h2>
			<p>
				We keep all rights to Pulsify Cloud, its documentation and the Pulsify
				name and logo. These terms give you a right to use the service, nothing
				more. The open-source packages remain under their own licenses.
			</p>
			<p>
				If you send us suggestions or bug reports, we may use them freely,
				without owing you anything. Feedback never includes Customer Data.
			</p>

			<h2>8. Suspension</h2>
			<p>We may suspend a project, in whole or in part, when:</p>
			<ul>
				<li>
					it breaks section 6 or puts the service or other customers at risk;
				</li>
				<li>an amount due stays unpaid;</li>
				<li>the law or an authority requires it.</li>
			</ul>
			<p>
				We warn you first when we reasonably can, suspend no more than needed,
				and lift the suspension once its cause is gone.
			</p>

			<h2>9. Term and termination</h2>
			<ul>
				<li>
					<strong>By you.</strong> These terms apply for as long as you have an
					account. You can close it at any time with "Delete project" in the
					dashboard. A subscription must have ended first; closing does not
					refund the current period.
				</li>
				<li>
					<strong>By us, for breach.</strong> We may close your account if you
					break these terms and do not fix it within 10 days of our notice, or
					at once if the breach is serious, repeated or cannot be fixed.
				</li>
				<li>
					<strong>By us, inactive Free projects.</strong> We may delete a Free
					project that no client has connected to for 6 months, 30 days after
					telling you.
				</li>
				<li>
					<strong>By us, without cause.</strong> We may end the service, or your
					account, with 30 days' notice. We then refund the part of your fees
					that covers the time after the end.
				</li>
				<li>
					<strong>By you, after a change.</strong> If you close your account
					because of a change announced under section 3 or 13, we refund the
					part of your fees that covers the time after the closing.
				</li>
				<li>
					<strong>Afterwards.</strong> When the account ends, your project stops
					answering at once. Export what you need before: your clients can read
					their documents until then. Customer Data and the account are deleted
					within 30 days of the end, in practice within minutes when you delete
					the project yourself, and copies in backups expire within 30 more
					days. We keep what the law requires us to keep.
				</li>
			</ul>
			<p>
				Sections 4 (for amounts due), 5, 7, 10, 11, 12 and 14 survive the end of
				these terms.
			</p>

			<h2>10. No warranty</h2>
			<p>
				We provide Pulsify Cloud with reasonable care and skill. Beyond that,
				and as far as the law allows, the service is provided "as is" and "as
				available": we do not promise that it will be uninterrupted or free of
				errors, that it will meet your particular needs, or that data will never
				be lost.
			</p>

			<h2>11. Liability</h2>
			<ul>
				<li>
					<strong>Excluded losses.</strong> Neither of us is liable to the other
					for indirect loss, nor for lost profits, revenue, business, customers,
					goodwill or anticipated savings, nor for the cost of a replacement
					service.
				</li>
				<li>
					<strong>Cap.</strong> Each of us is liable to the other, for
					everything arising from these terms and the service, up to the greater
					of the fees you paid for Pulsify Cloud in the 12 months before the
					event that caused the loss, and 100 euros.
				</li>
				<li>
					<strong>What is not limited.</strong> Nothing in these terms limits
					liability for death or personal injury, for fraud, for wilful
					misconduct or gross negligence, your duty to pay fees, your duties
					under section 12, or any liability that the law does not allow to be
					limited.
				</li>
				<li>
					<strong>Events outside our control.</strong> Neither of us is liable
					for a failure caused by an event beyond its reasonable control, such
					as a failure of the internet or of a hosting, network or payment
					provider, an attack on the network, or a decision of an authority.
					This does not release you from paying fees.
				</li>
			</ul>
			<p>
				The prices of Pulsify Cloud, and the existence of a free plan, reflect
				this sharing of risk.
			</p>

			<h2>12. Claims about your data or your use</h2>
			<p>
				If someone makes a claim against us because of Customer Data, your
				application, or your breach of section 5 or 6, you will defend us and
				pay the damages, costs and reasonable legal fees that result. We will
				tell you about the claim promptly, let you run the defence, and help you
				at your cost. You may not settle in a way that binds us without our
				agreement.
			</p>

			<h2>13. Changes to these terms</h2>
			<p>
				We may change these terms. For a change that matters, we write to your
				account's address at least 30 days before it takes effect. If you
				disagree, close your account before that date; if you keep using the
				service after it, you accept the new version. Changes required by law or
				that only clarify the text can take effect at once. This page always
				shows the version in force and its date.
			</p>

			<h2>14. General</h2>
			<ul>
				<li>
					<strong>Law and courts.</strong> French law governs these terms. As
					far as the law allows, the courts of {OPERATOR.courts} have exclusive
					jurisdiction over any dispute about them or about the service.
				</li>
				<li>
					<strong>Time limit.</strong> A claim about these terms or the service
					must be brought within one year of the day the claimant knew, or
					should have known, the facts behind it.
				</li>
				<li>
					<strong>Transfer.</strong> We may transfer these terms to a company we
					set up to run Pulsify Cloud, or to one that takes over the service,
					and will tell you when we do. You may transfer them with our written
					agreement.
				</li>
				<li>
					<strong>Whole agreement.</strong> These terms, with the documents
					named in section 1, are the whole agreement between us about Pulsify
					Cloud. Your own purchasing terms do not apply. A separate agreement
					signed by both of us prevails over these terms where they differ.
				</li>
				<li>
					<strong>If a clause fails.</strong> If a court finds a clause invalid,
					the rest still applies. Not enforcing a right at one time does not
					give it up.
				</li>
				<li>
					<strong>Relationship.</strong> We are independent parties: nothing
					here makes either of us the other's agent, partner or employee.
				</li>
				<li>
					<strong>Language.</strong> These terms are written in English, and the
					English text is the one that binds.
				</li>
			</ul>

			<h2>15. Contact</h2>
			<p>
				Questions about these terms, and notices to us, go to <Contact />.
			</p>
		</>
	);
}
