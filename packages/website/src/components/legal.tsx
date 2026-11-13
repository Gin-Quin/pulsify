import { GITHUB_URL } from "./links";

/**
 * Who operates Pulsify Cloud, as every legal page names them. French law
 * (LCEN, article 6) requires all of these on the website.
 */
export const OPERATOR = {
	/** The trade name, as registered. */
	name: "Digital Loukoum",
	form: "the trade name of Matthieu Gindre, entrepreneur individuel (EI)",
	director: "Matthieu Gindre",
	website: "https://loukoum.digital",
	address: "8 rue Didienne, 44000 Nantes, France",
	registration: "SIREN 845 187 442",
	/** Intra-community VAT number, or "" under the VAT franchise. */
	vat: "FR89845187442",
	email: "legal@pulsify.cloud",
	/** Where disputes are heard. */
	courts: "Nantes, France",
};

/** The day the current terms, privacy policy and DPA took effect. */
export const EFFECTIVE_DATE = "13 November 2026";

export const LICENSE_URL = `${GITHUB_URL}/blob/main/LICENSE`;
export const CLOUD_LICENSE_URL = `${GITHUB_URL}/blob/main/packages/cloud-server/LICENSE.md`;

/** The one address for legal, privacy, security and abuse notices. */
export function Contact() {
	return <a href={`mailto:${OPERATOR.email}`}>{OPERATOR.email}</a>;
}
