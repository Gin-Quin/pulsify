import type { Pulse } from "pulsify-core";
import {
	createResource,
	createSignal,
	For,
	Match,
	onCleanup,
	Show,
	Switch,
	type JSX,
} from "solid-js";
import { renderSVG } from "uqr";
import { Icon, type IconName } from "~/components/Icon";
import {
	createStatus,
	me,
	online,
	ownRoom,
	RoomExpired,
	setOnline,
	type OpenRoom,
} from "./room";
import styles from "./Shell.module.css";

type Someone = { name: string; color: string };

/**
 * A demo window, with its room once open. It owns the room: leaving the page
 * closes its socket and pulses, or stops the opening.
 */
export function Room<P>(props: {
	open: (signal: AbortSignal) => Promise<OpenRoom<P>>;
	children: (room: P) => JSX.Element;
}) {
	const owned = ownRoom(props.open);
	onCleanup(owned.dispose);
	const [room] = createResource(() => owned.pulse);
	return (
		<div class={styles.app}>
			<Switch
				fallback={<p class={styles.screen}>Opening a room on Pulsify Cloud…</p>}
			>
				<Match when={room.state === "errored"}>
					<p class={styles.screen}>
						{room.error instanceof RoomExpired
							? room.error.message
							: `Could not open the room: ${String(room.error?.message ?? room.error)}`}
						<br />
						<a href={location.pathname}>Open a new room</a>
					</p>
				</Match>
				<Match when={room.state === "ready" && room()}>
					{(value) => props.children(value())}
				</Match>
			</Switch>
		</div>
	);
}

/**
 * The header of a demo: who is here, the online switch when `pulse` is given,
 * and the invitation.
 */
export function Shell(props: {
	title: string;
	icon: IconName;
	people: readonly Someone[];
	pulse?: Pulse<any>;
	children: JSX.Element;
}) {
	return (
		<>
			<header class={styles.bar}>
				<a class={styles.brand} href="/demos">
					<img src="/logo-84.png" alt="" width="28" height="28" />
					<span>Pulsify</span>
				</a>
				<span class={styles.title}>
					<Icon name={props.icon} size="1.1em" />
					{props.title}
				</span>
				<div class={styles.end}>
					<div class={styles.people}>
						<Avatar person={me} you />
						<For each={props.people.slice(0, 5)}>
							{(person) => <Avatar person={person} />}
						</For>
						<Show when={props.people.length > 5}>
							<span class={styles.more}>+{props.people.length - 5}</span>
						</Show>
					</div>
					<Show when={props.pulse}>
						{(pulse) => <OnlineSwitch pulse={pulse()} />}
					</Show>
					<button class={styles.invite} type="button" popovertarget="invite">
						<Icon name="userPlus" size="1.1em" />
						<span>Invite</span>
					</button>
					<div id="invite" class={styles.popover} popover>
						<InviteCard />
					</div>
				</div>
			</header>
			<main class={styles.main}>{props.children}</main>
		</>
	);
}

export function Avatar(props: { person: Someone; you?: boolean }) {
	return (
		<span
			class={styles.avatar}
			style={{ "background-color": props.person.color }}
			title={props.you ? `${props.person.name} (you)` : props.person.name}
			data-you={props.you ? "" : undefined}
		>
			{props.person.name
				.split(" ")
				.map((word) => word[0])
				.join("")}
		</span>
	);
}

function OnlineSwitch(props: { pulse: Pulse<any> }) {
	const status = createStatus(props.pulse);
	const label = () =>
		!online()
			? "Edits kept locally"
			: status() === "synced" || status() === "ready"
				? "Synced"
				: status() === "error"
					? "Sync error"
					: status() === "offline"
						? "Reconnecting…"
						: "Syncing…";
	return (
		<div class={styles.online}>
			<span class={styles.status} data-status={online() ? status() : "off"}>
				{label()}
			</span>
			<button
				class={styles.switch}
				type="button"
				role="switch"
				aria-checked={online()}
				title="Go offline to edit on your own, then online again to merge"
				onClick={() => setOnline(!online())}
			>
				<span class={styles.track}>
					<span class={styles.knob} />
				</span>
				<span>{online() ? "Online" : "Offline"}</span>
			</button>
		</div>
	);
}

/** The room's link and its QR code. */
export function InviteCard(props: { text?: string }) {
	const link = location.href;
	const [copied, setCopied] = createSignal(false);
	const copy = async () => {
		await navigator.clipboard.writeText(link);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};
	return (
		<div class={styles.card}>
			<div
				class={styles.qr}
				innerHTML={renderSVG(link, { border: 2, ecc: "M" })}
			/>
			<p>
				{props.text ??
					"Scan the code or send the link: whoever opens it joins this room."}
			</p>
			<div class={styles.link}>
				<input
					readOnly
					value={link}
					aria-label="Invitation link"
					onFocus={(event) => event.currentTarget.select()}
				/>
				<button type="button" onClick={copy}>
					<Icon name={copied() ? "check" : "copy"} size="1em" />
					{copied() ? "Copied" : "Copy"}
				</button>
			</div>
		</div>
	);
}
