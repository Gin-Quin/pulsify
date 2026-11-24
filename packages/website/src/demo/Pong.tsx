import {
	createPulse,
	definePresence,
	definePulse,
	object,
	optional,
	tuple,
	type ModelFromDefinition,
	type Pulse,
} from "pulsify-core";
import { createMutablePulse, createPulsePresence } from "pulsify-solid";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { me, openRoom } from "./room";
import { InviteCard, Room, Shell } from "./Shell";
import styles from "./Pong.module.css";

/** Who sits where, and the score: the only stored state of a game. */
const Table = definePulse(
	"PongTable",
	object({
		left: "string",
		right: optional("string"),
		leftScore: "uint",
		rightScore: "uint",
	}),
).materialize();
type Table = Pulse<ModelFromDefinition<typeof Table>>;

/**
 * Everything that moves goes through presence, at up to 60 updates a second:
 * never stored, and not counted by Pulsify Cloud. The left player, who opened
 * the table, runs the ball and shares it.
 */
const Player = definePresence(
	"pong-player",
	object({
		id: "string",
		name: "string",
		color: "string",
		y: "float64",
		ball: optional(tuple("float64", "float64", "float64", "float64")),
	}),
	{ throttleMs: 16 },
);

type Vector = [number, number, number, number];
const W = 800;
const H = 500;
const PADDLE_H = 90;
const PADDLE_W = 12;
const PADDLE_X = 28;
const R = 8;
const SPEED = 420;
const MAX_SPEED = 1100;
const KEY_SPEED = 520;
const LEFT = "#3df5e0";
const RIGHT = "#e879f9";

export default function Pong() {
	return (
		<Room
			open={(signal) =>
				openRoom(
					Table,
					(id, options) =>
						createPulse(
							Table,
							{ id, left: me.id, leftScore: 0, rightScore: 0 },
							{ ...options, connect: true },
						),
					signal,
				)
			}
		>
			{(pulse: Table) => <Game pulse={pulse} />}
		</Room>
	);
}

function Game(props: { pulse: Table }) {
	const table = createMutablePulse(props.pulse);
	const players = createPulsePresence(props.pulse, Player);
	const side = () =>
		table.left === me.id ? "left" : table.right === me.id ? "right" : null;
	const here = (id: string | undefined) =>
		id === me.id || players.others.some((other) => other.state.id === id);
	const ready = () => here(table.left) && here(table.right);
	const nameOf = (id: string | undefined) =>
		id === me.id
			? "You"
			: players.others.find((other) => other.state.id === id)?.state.name;

	// ponytail: the left player opened the table and runs the ball; nobody takes over when they leave for good. Hand the ball to the right player if that matters.
	// The seat on the right goes to the first visitor while it is free or its
	// player has left, once the others' presence had time to arrive.
	const [settled, setSettled] = createSignal(false);
	const timer = setTimeout(() => setSettled(true), 1500);
	onCleanup(() => clearTimeout(timer));
	createEffect(() => {
		if (!settled() || side() || here(table.right)) return;
		table.right = me.id;
		table.leftScore = 0;
		table.rightScore = 0;
	});

	let canvas!: HTMLCanvasElement;
	let myY = H / 2;
	let leftY = H / 2;
	let rightY = H / 2;
	const keys = { up: false, down: false };
	const ball = { x: W / 2, y: H / 2, vx: 0, vy: 0 };
	let serveAt = 0;
	let serveTo = 1;
	let lastHost: unknown;

	const clampPaddle = (y: number) =>
		Math.min(H - PADDLE_H / 2, Math.max(PADDLE_H / 2, y));
	const point = (event: PointerEvent) => {
		const box = canvas.getBoundingClientRect();
		myY = clampPaddle(((event.clientY - box.top) / box.height) * H);
	};
	const key = (down: boolean) => (event: KeyboardEvent) => {
		if (["ArrowUp", "w", "z"].includes(event.key)) keys.up = down;
		else if (["ArrowDown", "s"].includes(event.key)) keys.down = down;
		else return;
		event.preventDefault();
	};

	/** The left player's ball: walls, paddles and points. */
	function step(dt: number, now: number) {
		if (!ready()) {
			Object.assign(ball, { x: W / 2, y: H / 2, vx: 0, vy: 0 });
			serveAt = now + 1000;
			return;
		}
		if (now < serveAt) return;
		if (!ball.vx) {
			const angle = (Math.random() - 0.5) * (Math.PI / 3);
			ball.vx = Math.cos(angle) * SPEED * serveTo;
			ball.vy = Math.sin(angle) * SPEED;
		}
		const before = ball.x;
		bounce(ball, dt);
		const hit = (paddleY: number, face: number, direction: number) => {
			// Crossed the paddle's face this frame, within its height.
			const crossed =
				direction < 0
					? before - R >= face && ball.x - R <= face
					: before + R <= face && ball.x + R >= face;
			if (!crossed || Math.abs(ball.y - paddleY) > PADDLE_H / 2 + R) return;
			const speed = Math.min(Math.hypot(ball.vx, ball.vy) * 1.06, MAX_SPEED);
			const angle = ((ball.y - paddleY) / (PADDLE_H / 2)) * (Math.PI / 3.2);
			ball.vx = -direction * Math.cos(angle) * speed;
			ball.vy = Math.sin(angle) * speed;
			ball.x = face - direction * R;
		};
		if (ball.vx < 0) hit(leftY, PADDLE_X + PADDLE_W, -1);
		else hit(rightY, W - PADDLE_X - PADDLE_W, 1);
		if (ball.x < -R || ball.x > W + R) {
			if (ball.x < 0) table.rightScore += 1;
			else table.leftScore += 1;
			// The one who lost the point receives the next serve.
			serveTo = ball.x < 0 ? -1 : 1;
			Object.assign(ball, { x: W / 2, y: H / 2, vx: 0, vy: 0 });
			serveAt = now + 900;
		}
	}

	function draw(context: CanvasRenderingContext2D) {
		context.clearRect(0, 0, W, H);
		context.save();
		context.setLineDash([10, 14]);
		context.strokeStyle = "rgb(255 255 255 / 0.14)";
		context.lineWidth = 3;
		context.beginPath();
		context.moveTo(W / 2, 16);
		context.lineTo(W / 2, H - 16);
		context.stroke();
		context.restore();

		context.textAlign = "center";
		context.fillStyle = "rgb(232 246 248 / 0.22)";
		context.font = "700 72px Inter, system-ui, sans-serif";
		context.fillText(String(table.leftScore), W / 4, 96);
		context.fillText(String(table.rightScore), (W * 3) / 4, 96);
		context.font = "500 16px Inter, system-ui, sans-serif";
		context.fillStyle = LEFT;
		context.fillText(nameOf(table.left) ?? "", W / 4, 126);
		context.fillStyle = RIGHT;
		context.fillText(nameOf(table.right) ?? "", (W * 3) / 4, 126);

		const glow = (color: string, blur: number, paint: () => void) => {
			context.shadowColor = color;
			context.shadowBlur = blur;
			context.fillStyle = color;
			paint();
			context.shadowBlur = 0;
		};
		const paddle = (x: number, y: number, color: string) =>
			glow(color, 24, () => {
				context.beginPath();
				context.roundRect(x, y - PADDLE_H / 2, PADDLE_W, PADDLE_H, 6);
				context.fill();
			});
		paddle(PADDLE_X, leftY, LEFT);
		paddle(W - PADDLE_X - PADDLE_W, rightY, RIGHT);
		if (ready())
			glow("#ffffff", 22, () => {
				context.beginPath();
				context.arc(ball.x, ball.y, R, 0, Math.PI * 2);
				context.fill();
			});
	}

	onMount(() => {
		const context = canvas.getContext("2d")!;
		const scale = Math.min(window.devicePixelRatio || 1, 2);
		canvas.width = W * scale;
		canvas.height = H * scale;
		context.scale(scale, scale);
		const down = key(true);
		const up = key(false);
		window.addEventListener("keydown", down);
		window.addEventListener("keyup", up);
		let last = performance.now();
		let frame = requestAnimationFrame(function loop(now) {
			const dt = Math.min((now - last) / 1000, 0.05);
			last = now;
			if (keys.up !== keys.down)
				myY = clampPaddle(myY + (keys.up ? -1 : 1) * KEY_SPEED * dt);
			const others = players.others;
			const host = others.find((other) => other.state.id === table.left);
			const guest = others.find((other) => other.state.id === table.right);
			// Another player's paddle eases toward what they last shared.
			const ease = (from: number, to: number | undefined) =>
				to === undefined ? from : from + (to - from) * Math.min(1, dt * 25);
			leftY = side() === "left" ? myY : ease(leftY, host?.state.y);
			rightY = side() === "right" ? myY : ease(rightY, guest?.state.y);
			if (side() === "left") step(dt, now);
			else if (host?.state.ball && host !== lastHost) {
				// The host's ball, then carried on until its next update.
				lastHost = host;
				const [x, y, vx, vy] = host.state.ball;
				Object.assign(ball, { x, y, vx, vy });
			} else bounce(ball, dt);
			players.set({
				id: me.id,
				name: me.name,
				color: me.color,
				y: myY,
				...(side() === "left" && {
					ball: [ball.x, ball.y, ball.vx, ball.vy] as Vector,
				}),
			});
			draw(context);
			frame = requestAnimationFrame(loop);
		});
		onCleanup(() => {
			cancelAnimationFrame(frame);
			window.removeEventListener("keydown", down);
			window.removeEventListener("keyup", up);
		});
	});

	return (
		<Shell
			title="Pong"
			icon="paddle"
			people={players.others.map((other) => other.state)}
		>
			<div class={styles.stage}>
				<canvas
					ref={canvas}
					class={styles.table}
					onPointerMove={point}
					onPointerDown={point}
				/>
				<p class={styles.hint}>
					{side()
						? `You play ${side()}, in ${side() === "left" ? "cyan" : "pink"}. Move with the mouse, a finger, or ↑ ↓.`
						: "You are watching: the table is full."}
				</p>
			</div>
			<Show when={!ready()}>
				<div class={styles.overlay}>
					<Show
						when={side() === "left"}
						fallback={
							<p class={styles.waiting}>
								{side() === "right"
									? "Waiting for the other player to come back…"
									: "Waiting for the players…"}
							</p>
						}
					>
						<h1>Invite a second player</h1>
						<InviteCard text="Scan the code or send the link: the game starts as soon as someone opens it." />
					</Show>
				</div>
			</Show>
		</Shell>
	);
}

/** Move a ball for `dt` seconds, off the top and bottom walls. */
function bounce(
	ball: { x: number; y: number; vx: number; vy: number },
	dt: number,
) {
	ball.x += ball.vx * dt;
	ball.y += ball.vy * dt;
	if (ball.y < R) {
		ball.y = R;
		ball.vy = Math.abs(ball.vy);
	} else if (ball.y > H - R) {
		ball.y = H - R;
		ball.vy = -Math.abs(ball.vy);
	}
}
