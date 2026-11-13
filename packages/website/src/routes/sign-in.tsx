import { Title } from "@solidjs/meta";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { createSignal, onMount, Show } from "solid-js";
import { api, type Account, messageOf } from "~/components/account";
import { Button } from "~/components/Button";
import { Card } from "~/components/Card";
import { setSignedIn } from "~/components/Header";
import { Sky } from "~/components/Sky";
import cloud from "~/components/Cloud.module.css";
import styles from "~/components/Dashboard.module.css";

export default function SignIn() {
	const [params, setParams] = useSearchParams();
	const navigate = useNavigate();
	const [expired, setExpired] = createSignal(false);
	const [signedInAs, setSignedInAs] = createSignal<string>();

	onMount(() => {
		setExpired(params.login === "expired");
		if (params.login) setParams({ login: undefined }, { replace: true });
		// The form shows at once; a session found meanwhile adds a way back in.
		api<Account>("").then(
			(account) => {
				setSignedInAs(account.email);
				setSignedIn(true);
			},
			() => setSignedIn(false),
		);
	});

	return (
		<Sky class={styles.fullHeight}>
			<main class={`${styles.page} ${styles.signIn}`}>
				<Title>Sign in · Pulsify Cloud</Title>
				<SignInCard
					expired={expired()}
					onSignIn={() => navigate("/dashboard")}
				/>
				<Show when={signedInAs()}>
					{(email) => (
						<Card class={styles.panel}>
							<p class={cloud.text}>You are already signed in.</p>
							<div class={styles.actions}>
								<Button href="/dashboard" variant="outline" icon="arrow">
									{email()}
								</Button>
							</div>
						</Card>
					)}
				</Show>
			</main>
		</Sky>
	);
}

export function SignInCard(props: { expired: boolean; onSignIn: () => void }) {
	const [email, setEmail] = createSignal("");
	const [sentTo, setSentTo] = createSignal<string>();
	const [code, setCode] = createSignal("");
	const [error, setError] = createSignal<string>();
	const [sending, setSending] = createSignal(false);

	async function verify(event: SubmitEvent) {
		event.preventDefault();
		setSending(true);
		setError(undefined);
		try {
			await api("code", { email: sentTo(), code: code() });
			props.onSignIn();
		} catch (cause) {
			setError(messageOf(cause));
		} finally {
			setSending(false);
		}
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		setSending(true);
		setError(undefined);
		try {
			await api("login", { email: email().trim() });
			setCode("");
			setSentTo(email().trim());
		} catch (cause) {
			setError(messageOf(cause));
		} finally {
			setSending(false);
		}
	}

	return (
		<Card class={styles.panel}>
			<Show
				when={sentTo()}
				fallback={
					<>
						<Show when={props.expired}>
							<p class={styles.notice} role="alert">
								That sign-in link is invalid or expired. Ask for a new one
								below.
							</p>
						</Show>
						<h2 class={styles.panelTitle}>Sign in to Pulsify Cloud</h2>
						<p class={cloud.text}>
							Open your Pulsify Cloud dashboard: your project's URL, secrets,
							usage and plan. We email you a sign-in code, no password. A new
							address gets a free project.
						</p>
						<form class={styles.form} onSubmit={submit}>
							<label class={styles.label} for="dashboard-email">
								Email
							</label>
							<div class={styles.row}>
								<input
									id="dashboard-email"
									class={styles.input}
									type="email"
									name="email"
									autocomplete="email"
									placeholder="you@example.com"
									required
									value={email()}
									onInput={(event) => setEmail(event.currentTarget.value)}
								/>
								<Button type="submit" icon="arrow" disabled={sending()}>
									{sending() ? "Sending…" : "Email me a code"}
								</Button>
							</div>
						</form>
						<p class={cloud.footnote}>
							By signing in, you accept the{" "}
							<a href="/legal/terms">Terms of Service</a>. The{" "}
							<a href="/legal/privacy">Privacy Policy</a> explains how we handle
							your data.
						</p>
					</>
				}
			>
				<h2 class={styles.panelTitle}>Check your inbox</h2>
				<p class={cloud.text} role="status">
					If <strong>{sentTo()}</strong> is a valid address, a sign-in code is
					on its way. Type it below, or open the link in the same email. Both
					work for 15 minutes. Nothing after a minute? Check your spam folder,
					then ask for a new code: we send at most one per minute.
				</p>
				<form class={styles.form} onSubmit={verify}>
					<label class={styles.label} for="dashboard-code">
						Code
					</label>
					<div class={styles.row}>
						<input
							id="dashboard-code"
							class={styles.input}
							type="text"
							name="code"
							inputmode="numeric"
							autocomplete="one-time-code"
							pattern="[0-9]{6}"
							maxlength="6"
							placeholder="123456"
							required
							value={code()}
							onInput={(event) => setCode(event.currentTarget.value.trim())}
						/>
						<Button type="submit" icon="arrow" disabled={sending()}>
							{sending() ? "Signing in…" : "Sign in"}
						</Button>
					</div>
				</form>
				<div class={styles.actions}>
					<Button
						variant="outline"
						onClick={() => {
							setError(undefined);
							setSentTo(undefined);
						}}
					>
						Send another code
					</Button>
				</div>
			</Show>
			<Show when={error()}>
				<p class={styles.error} role="alert">
					{error()}
				</p>
			</Show>
		</Card>
	);
}
