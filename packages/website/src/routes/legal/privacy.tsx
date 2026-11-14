import { Seo } from "~/components/Seo";
import { Contact, EFFECTIVE_DATE, OPERATOR } from "~/components/legal";

export default function Privacy() {
	return (
		<>
			<Seo
				title="Privacy Policy · Pulsify"
				description="What personal data Pulsify handles, why and for how long. No analytics, no ads, no tracking cookies."
			/>
			<h1>Privacy Policy</h1>
			<p>Effective {EFFECTIVE_DATE}.</p>
			<p>
				This policy says what personal data we handle when you visit{" "}
				<code>pulsify.cloud</code> or hold a Pulsify Cloud account, why, for how
				long, and what you can do about it. The short version: we keep your
				email address and what is needed to run and bill your project. We run no
				analytics, show no ads, set no tracking cookies and sell no data.
			</p>

			<h2>1. Who is responsible</h2>
			<p>
				The controller of the data described here is {OPERATOR.name},{" "}
				{OPERATOR.form}, {OPERATOR.address} ("we"). Write to <Contact /> about
				anything in this policy.
			</p>

			<h2>2. Data stored by applications built on Pulsify Cloud</h2>
			<p>
				This policy does not cover the documents that an application stores in
				Pulsify Cloud. If you use such an application, its publisher decides
				what is stored and why, and its own privacy policy applies. We only host
				that data on the publisher's behalf, under our{" "}
				<a href="/legal/dpa">Data Processing Addendum</a>. Send your requests to
				the publisher; if you send them to us, we pass them on.
			</p>

			<h2>3. What we handle, why and for how long</h2>
			<table>
				<thead>
					<tr>
						<th>Data</th>
						<th>Purpose and legal basis</th>
						<th>Kept</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td>Your email address</td>
						<td>
							To create your account, sign you in, and send you sign-in codes,
							billing messages and notices about the service. Basis: our
							contract with you.
						</td>
						<td>Until 30 days after your account is closed</td>
					</tr>
					<tr>
						<td>
							Sign-in codes and links, and dashboard sessions, stored as hashes
						</td>
						<td>To check that it is you. Basis: our contract with you.</td>
						<td>
							Codes and links work for 15 minutes and are replaced at the next
							sign-in. Sessions end after 30 days or when you sign out
						</td>
					</tr>
					<tr>
						<td>
							Your project: its identifier, secrets, plan, and usage counts
							(messages, storage, connections)
						</td>
						<td>
							To run the service, apply your plan's limits and bill usage.
							Basis: our contract with you.
						</td>
						<td>Until 30 days after your account is closed</td>
					</tr>
					<tr>
						<td>Billing</td>
						<td>
							Polar, the merchant of record, takes your payment. We send Polar
							your email address, your project identifier and your usage, and
							Polar tells us whether a subscription is active. We never see your
							card. Basis: our contract with you, and our accounting duties.
						</td>
						<td>Accounting records: 10 years, as French law requires</td>
					</tr>
					<tr>
						<td>
							Request logs of the service: time, address requested, result,
							errors, and what the network adds, such as the IP address, the
							country and the browser. The address of a sign-in link contains
							your email address
						</td>
						<td>
							To find faults and stop abuse. Basis: our legitimate interest in a
							reliable and secure service.
						</td>
						<td>At most 7 days</td>
					</tr>
					<tr>
						<td>Messages you send us</td>
						<td>
							To answer you. Basis: our contract with you, or our legitimate
							interest in answering.
						</td>
						<td>Up to 3 years after our last exchange</td>
					</tr>
				</tbody>
			</table>
			<p>
				You give us your email address yourself; an account cannot exist without
				it. We make no automated decision that has a legal effect on you, and we
				send no marketing email.
			</p>

			<h2>4. Cookies and browser storage</h2>
			<p>
				The website sets no cookie. Signing in to the dashboard sets one,{" "}
				<code>pulsify_session</code>, on <code>api.pulsify.cloud</code>: it
				keeps you signed in for 30 days and cannot be read by scripts. Your
				browser's local storage keeps two preferences: the light or dark theme,
				and whether to show the dashboard button. All three are needed for what
				you asked the site to do, so there is no consent banner. There is no
				analytics script, no advertising and no third-party tracker.
			</p>

			<h2>5. Who receives the data</h2>
			<ul>
				<li>
					<strong>Cloudflare, Inc.</strong> hosts the website and the service,
					delivers our emails and keeps the request logs, as our processor.
				</li>
				<li>
					<strong>Polar Software, Inc.</strong> sells subscriptions as merchant
					of record and handles payments, taxes and invoices, with its own
					payment providers. Polar is responsible for the payment data it
					collects; its privacy policy applies to it.
				</li>
				<li>
					<strong>The provider of our mailbox</strong>, for the messages you
					send us.
				</li>
				<li>
					<strong>Authorities</strong>, when the law requires it, and{" "}
					<strong>a successor</strong>, if another company takes over Pulsify
					Cloud. We would tell you before your data changes hands.
				</li>
			</ul>
			<p>
				We do not sell or rent personal data, and we share it with no one else.
			</p>

			<h2>6. Transfers outside the European Union</h2>
			<p>
				Cloudflare and Polar are United States companies, and Cloudflare serves
				requests from data centres around the world. These transfers rely on the
				European Commission's adequacy decision for the EU–US Data Privacy
				Framework where the recipient is certified, and otherwise on the
				Commission's standard contractual clauses. Ask us for a copy.
			</p>

			<h2>7. Your rights</h2>
			<p>
				You can ask us for a copy of your data, to correct it, to delete it, to
				restrict its use, or to hand it over in a portable format, and you can
				object to the uses based on our legitimate interest. Write to{" "}
				<Contact /> from the address concerned. We answer within one month. You
				can also delete everything yourself: "Delete project" in the dashboard
				erases the project, its documents and your account.
			</p>
			<p>
				If you think we handle your data wrongly, you can complain to the French
				data protection authority, the CNIL (<code>cnil.fr</code>), or to the
				authority of your country.
			</p>

			<h2>8. Security</h2>
			<p>
				Connections are encrypted, storage is encrypted at rest, sign-in secrets
				are stored as hashes, and each project has its own secrets and its own
				storage. The <a href="/legal/dpa">Data Processing Addendum</a> lists the
				measures. If a breach puts your data at risk, we tell you without delay.
			</p>

			<h2>9. Children</h2>
			<p>
				Pulsify Cloud is a professional tool. It is not meant for anyone under
				18, and we do not knowingly collect their data.
			</p>

			<h2>10. Changes</h2>
			<p>
				When we change this policy, we change the date at the top. If a change
				affects how we use data we already hold, we write to account holders
				before it takes effect.
			</p>
		</>
	);
}
