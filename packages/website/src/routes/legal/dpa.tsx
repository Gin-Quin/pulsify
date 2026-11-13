import { Title } from "@solidjs/meta";
import { Contact, EFFECTIVE_DATE, OPERATOR } from "~/components/legal";

export default function Dpa() {
	return (
		<>
			<Title>Data Processing Addendum · Pulsify Cloud</Title>
			<h1>Data Processing Addendum</h1>
			<p>Effective {EFFECTIVE_DATE}.</p>
			<p>
				This addendum is part of the{" "}
				<a href="/legal/terms">Pulsify Cloud Terms of Service</a>. It applies
				whenever Customer Data contains personal data, and is the contract that
				article 28 of the General Data Protection Regulation (GDPR) requires
				between you and us. You accept it with the terms; nothing has to be
				signed. Words defined in the terms mean the same here.
			</p>

			<h2>1. Roles</h2>
			<p>
				For the personal data in Customer Data, you are the controller, or a
				processor acting for your own customers, and we, {OPERATOR.name}, are
				your processor. For the data about your account, we are a controller:
				the <a href="/legal/privacy">Privacy Policy</a> covers it, not this
				addendum.
			</p>

			<h2>2. The processing</h2>
			<table>
				<tbody>
					<tr>
						<th scope="row">Subject and purpose</th>
						<td>
							Providing Pulsify Cloud: storing the documents of your
							application, relaying their changes between its users, and
							applying the access rules you set.
						</td>
					</tr>
					<tr>
						<th scope="row">Nature</th>
						<td>
							Hosting, storage, transmission, compaction and deletion. We do not
							read, analyse or enrich the content of documents.
						</td>
					</tr>
					<tr>
						<th scope="row">Duration</th>
						<td>
							For as long as you have an account, then until deletion as section
							9 describes.
						</td>
					</tr>
					<tr>
						<th scope="row">People concerned</th>
						<td>
							The users of your application, and anyone your documents mention.
						</td>
					</tr>
					<tr>
						<th scope="row">Data</th>
						<td>
							Whatever your application writes: document content and its edit
							history, document and root names, the user identifiers you put in
							tokens and grants, and presence such as cursors, which is relayed
							and never stored. You choose the data; we do not need to know what
							it is.
						</td>
					</tr>
				</tbody>
			</table>

			<h2>3. Your instructions</h2>
			<p>
				We process Customer Data only on your documented instructions: the
				terms, this addendum, and what you and your application ask of the
				service through its API and dashboard. We do nothing else with it,
				unless European Union or French law requires us to, in which case we
				tell you first when the law allows. If we believe an instruction breaks
				data protection law, we tell you.
			</p>

			<h2>4. Confidentiality</h2>
			<p>
				Everyone we allow to access Customer Data is bound by a duty of
				confidentiality, and accesses it only when needed to run, secure or
				support the service.
			</p>

			<h2>5. Security</h2>
			<p>
				We apply the measures of annex 1, and may replace them with others that
				protect the data at least as well. You are responsible for what is in
				your hands: keeping your secrets on your servers, signing tokens only
				for the right users, and granting roles carefully.
			</p>

			<h2 id="sub-processors">6. Sub-processors</h2>
			<p>
				You authorise us to use the sub-processors of annex 2. We bind each of
				them by contract to data protection duties equivalent to ours here, and
				we answer to you for what they do.
			</p>
			<p>
				Before adding or replacing a sub-processor, we write to your account's
				address at least 30 days ahead. If you object on reasonable data
				protection grounds and we cannot meet the objection, you may close your
				account before the change, and we refund the part of your fees that
				covers the time after the closing.
			</p>

			<h2>7. Helping you</h2>
			<ul>
				<li>
					<strong>Requests from people.</strong> Your application can read,
					correct and erase its documents itself. If someone writes to us about
					data in your project, we pass the request to you and do not answer it
					ourselves. Where you cannot act alone, we help you within reason.
				</li>
				<li>
					<strong>Your own duties.</strong> We give you the information you
					reasonably need for your impact assessments, your consultations with
					an authority, and your security duties, given what we know of the
					processing.
				</li>
			</ul>

			<h2>8. Personal data breaches</h2>
			<p>
				If we become aware of a breach of security that leads to the loss,
				alteration, disclosure of or access to Customer Data, we write to your
				account's address without undue delay, and within 72 hours where we can.
				We tell you what happened, what data and how many people are concerned
				as far as we know, and what we did about it, and we add to this as we
				learn more.
			</p>

			<h2>9. Deletion and return</h2>
			<p>
				Until your account ends, your application can read all of its documents
				and so retrieve them. Deleting the project from the dashboard erases
				Customer Data within minutes; in every case we delete it within 30 days
				of the end of the account. Copies in backups expire within 30 more days.
				We keep only what European Union or French law requires us to keep, for
				as long as it does.
			</p>

			<h2>10. Showing compliance</h2>
			<p>
				On request, we give you the information needed to show that we meet this
				addendum. If that is not enough, you may audit us, yourself or through
				an auditor bound to confidentiality: once a year, or after a breach,
				with 30 days' notice, during working hours, without access to other
				customers' data, and at your cost. The server's source code is public,
				so anyone can inspect what it does with data.
			</p>

			<h2>11. Transfers outside the European Union</h2>
			<p>
				We are established in France. Cloudflare, our sub-processor, is a United
				States company and stores and serves data from data centres around the
				world: a root is stored near the first client that opens it. You
				authorise these transfers. They rely on the European Commission's
				adequacy decision for the EU–US Data Privacy Framework, under which
				Cloudflare is certified, and on the Commission's standard contractual
				clauses in our contract with Cloudflare.
			</p>
			<p>
				If you are established outside the European Economic Area and the law
				requires a transfer mechanism between us, the Commission's standard
				contractual clauses of 4 June 2021, module four (processor to
				controller), apply between us, with French law and the French courts,
				and this addendum provides the details their annexes ask for.
			</p>

			<h2>12. Your part</h2>
			<p>
				You make sure that you may lawfully give us the data: that you have a
				legal basis for it, that the people concerned were informed, and that
				your instructions are lawful. Do not store special categories of
				personal data, such as health data, unless the law allows you to and the
				service's security fits them.
			</p>

			<h2>13. Liability and precedence</h2>
			<p>
				The liability section of the terms applies to this addendum. On the
				protection of personal data, this addendum prevails over the rest of the
				terms.
			</p>

			<h2 id="security-measures">Annex 1: Security measures</h2>
			<ul>
				<li>
					<strong>Encryption.</strong> Every connection to the service uses TLS.
					Stored data is encrypted at rest by Cloudflare.
				</li>
				<li>
					<strong>Isolation.</strong> Each root is its own actor with its own
					database, named after its project. Actors are reachable only through
					the service's gateway, which authenticates every request.
				</li>
				<li>
					<strong>Access control.</strong> A request needs a token signed with
					the project's secret, or the project's API key, which is compared in
					constant time. Tokens carry no rights: each root keeps its own table
					of readers, editors and owners, and applies a change to open
					connections at once.
				</li>
				<li>
					<strong>Secrets.</strong> You can rotate either secret from the
					dashboard at any time; the old one stops working within a minute.
				</li>
				<li>
					<strong>Dashboard.</strong> Sign-in uses a code or link sent by email,
					valid for 15 minutes, with at most one email a minute and 20 wrong
					codes a day per address. Codes, links and sessions are stored as
					hashes. The session cookie cannot be read by scripts, travels only
					over TLS, and requests from other websites are refused.
				</li>
				<li>
					<strong>Minimisation.</strong> Presence is relayed and never stored.
					The service does not decode the content of documents. Request logs are
					kept for at most 7 days.
				</li>
				<li>
					<strong>Availability.</strong> Cloudflare replicates stored data
					across several data centres.
				</li>
				<li>
					<strong>People.</strong> Access to production is limited to those who
					operate the service.
				</li>
				<li>
					<strong>Transparency.</strong> The server's source code is public, and
					vulnerabilities can be reported to <Contact />.
				</li>
			</ul>

			<h2 id="annex-sub-processors">Annex 2: Sub-processors</h2>
			<table>
				<thead>
					<tr>
						<th>Sub-processor</th>
						<th>What it does</th>
						<th>Where</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td>Cloudflare, Inc., United States</td>
						<td>
							Runs the service: network, compute, storage of Customer Data, and
							request logs
						</td>
						<td>
							Worldwide; a root is stored near the first client that opens it
						</td>
					</tr>
				</tbody>
			</table>
			<p>
				Polar Software, Inc., which sells subscriptions, never receives Customer
				Data: it handles account and payment data, as the{" "}
				<a href="/legal/privacy">Privacy Policy</a> describes.
			</p>
		</>
	);
}
