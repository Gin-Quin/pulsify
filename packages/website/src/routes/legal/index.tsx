import { Seo } from "~/components/Seo";
import { Show } from "solid-js";
import {
	CLOUD_LICENSE_URL,
	Contact,
	LICENSE_URL,
	OPERATOR,
} from "~/components/legal";

export default function Legal() {
	return (
		<>
			<Seo
				title="Legal · Pulsify"
				description="The licenses of the open-source Pulsify software and the documents that govern Pulsify Cloud."
			/>
			<h1>Legal</h1>
			<p>
				Pulsify is two things with two sets of rules: open-source software,
				which its licenses govern, and Pulsify Cloud, a hosted service, which
				the documents below govern.
			</p>

			<h2>Pulsify Cloud</h2>
			<ul>
				<li>
					<a href="/legal/terms">Terms of Service</a>: the contract between you
					and us when you use the hosted service.
				</li>
				<li>
					<a href="/legal/privacy">Privacy Policy</a>: the personal data we
					handle about visitors and account holders.
				</li>
				<li>
					<a href="/legal/dpa">Data Processing Addendum</a>: how we handle the
					personal data your application stores in Pulsify Cloud, with our
					security measures and sub-processors.
				</li>
			</ul>

			<h2>Software licenses</h2>
			<ul>
				<li>
					The CRDT engine, the relay, the stores, the framework and editor
					bindings and the cloud client (<code>pulsify-cloud</code>) are under
					the <a href={LICENSE_URL}>Apache License 2.0</a>.
				</li>
				<li>
					The cloud server (<code>pulsify-cloud-server</code>) and the hosted
					service built on it are under the{" "}
					<a href={CLOUD_LICENSE_URL}>Functional Source License</a> (
					<code>FSL-1.1-ALv2</code>): any use except offering a competing
					service, and Apache 2.0 two years after each release.
				</li>
			</ul>
			<p>
				These licenses cover the code. They give no right to the Pulsify name
				and logo beyond saying where the software comes from.
			</p>

			<h2>Legal notice</h2>
			<p>
				This website and Pulsify Cloud are published and operated by{" "}
				<strong>{OPERATOR.name}</strong>, {OPERATOR.form}, {OPERATOR.address},
				registered under {OPERATOR.registration}
				<Show when={OPERATOR.vat}>, VAT number {OPERATOR.vat}</Show>.
				Publication director: {OPERATOR.director}. Website:{" "}
				<a href={OPERATOR.website}>{OPERATOR.website.slice(8)}</a>. Contact:{" "}
				<Contact />.
			</p>
			<p>
				Hosting: Cloudflare, Inc., 101 Townsend Street, San Francisco, CA 94107,
				United States, +1 650 319 8930.
			</p>
			<p>
				Payments: Polar Software, Inc. sells Pulsify Cloud subscriptions as
				merchant of record.
			</p>

			<h2>Report a problem</h2>
			<p>
				To report content hosted on Pulsify Cloud that you believe is illegal, a
				security vulnerability, or an abuse of the service, write to <Contact />
				. Say what the content is, where it is (the project URL or the
				application that shows it) and why you believe it is illegal. We answer
				every report and tell you what we did.
			</p>
		</>
	);
}
