<script lang="ts">
	import {
		createPulse,
		pulseRef,
		subscribePulseStatus,
		type Pulse,
		type TreeJSONNode,
	} from "pulsify-core";
	import { untrack } from "svelte";
	import { SveltePresence, SveltePulse } from "pulsify-svelte";
	import {
		Character,
		cloud,
		me,
		PlainDoc,
		RichDoc,
		setOnline,
		Viewer,
		type Workspace,
	} from "./pulsify";
	import RichEditor from "./RichEditor.svelte";
	import PlainEditor from "./PlainEditor.svelte";
	import CharacterEditor from "./CharacterEditor.svelte";

	let { workspace }: { workspace: Workspace } = $props();
	const ws = new SveltePulse(workspace);
	const files = $derived(ws.files.toJSON());
	let selectedId = $state<string>();
	// Tree nodes are not tracked: show the detached hierarchy, edit the nodes.
	const find = (nodes: TreeJSONNode<any>[]): TreeJSONNode<any> | undefined =>
		nodes.find((node) => node.id === selectedId) ??
		nodes.map((node) => find(node.children)).find(Boolean);
	const current = $derived(find(files));
	const file = $derived(
		current?.data.file as { type: string; ref: string } | undefined,
	);
	const node = () => ws.files.getNode(selectedId!)!;
	/** Load the selected file through its sub-pulse reference. */
	const load = () => untrack(() => node().data.file!.ref.load()).then(watch);

	// Synchronization status of every opened document, and our role on it.
	const statuses = $state<Record<string, string>>({});
	const roles = $state<Record<string, string | null>>({});
	const watched = new Set<string>();
	function watch<P extends Pulse<any>>(pulse: P): P {
		if (!watched.has(pulse.id)) {
			watched.add(pulse.id);
			subscribePulseStatus(pulse, (status) => (statuses[pulse.id] = status));
		}
		return pulse;
	}
	watch(workspace);

	// The sockets: one per root, with the server that answers.
	type Socket = {
		root: string;
		state: string;
		server: string;
		envelope?: number;
		documents: number;
		latencyMs?: number;
		error?: string;
	};
	let sockets = $state.raw<Socket[]>([]);
	const refresh = () =>
		(sockets = cloud.connections.map((c) => ({
			root: c.root,
			state: c.state,
			server: c.server
				? [c.server.backend, c.server.location, c.server.id.slice(0, 8)]
						.filter(Boolean)
						.join(" · ")
				: "",
			envelope: c.envelope,
			documents: c.documents.length,
			latencyMs: c.latencyMs,
			error: c.error?.message,
		})));
	cloud.onRole((docId, role) => {
		roles[docId] = role;
		refresh();
	});
	cloud.onConnection((connection) => {
		refresh();
		for (const event of ["state", "server", "pong", "timeout", "suspended"])
			connection.on(event as "state", refresh);
	});

	let online = $state(true);
	function toggleOnline() {
		online = !online;
		setOnline(online);
	}

	// Who is here, and which file each one has open.
	const viewers = new SveltePresence(workspace, Viewer);
	$effect(() => viewers.set({ name: me, file: selectedId ?? "" }));
	const viewersOf = (id: string) =>
		viewers.others
			.filter((other) => other.state.file === id)
			.map((other) => other.state.name);

	/** New items go into the selected folder, or next to the selected file. */
	function create(type: "folder" | "rich" | "plain" | "character") {
		const name = prompt("Nom :", type === "folder" ? "Dossier" : "Sans titre");
		if (!name) return;
		const selected = selectedId ? ws.files.getNode(selectedId) : undefined;
		const parent = selected?.data.file ? selected.parent() : selected;
		const options = { parent: workspace, connect: true };
		const file =
			type === "rich"
				? { type, ref: pulseRef(createPulse(RichDoc, { body: "" }, options)) }
				: type === "plain"
					? {
							type,
							ref: pulseRef(createPulse(PlainDoc, { body: "" }, options)),
						}
					: type === "character"
						? {
								type,
								ref: pulseRef(
									createPulse(
										Character,
										{
											name,
											age: 30,
											height: 1.75,
											alive: true,
											role: "Guerrier",
											position: [0, 0],
											createdAt: Date.now(),
											bio: "",
											tags: [],
											stats: {},
											inventory: [],
											links: [],
										},
										options,
									),
								),
							}
						: undefined;
		const node = ws.files.createNode(
			{ name, ...(file && { file }) } as never,
			parent,
		);
		selectedId = node.id;
	}
	function rename() {
		const name = prompt("Nouveau nom :", node().data.name);
		if (name) node().data.name = name;
	}
	function remove() {
		if (confirm(`Supprimer « ${node().data.name} » ?`)) node().delete();
	}

	// Drag and drop: the top half of a row drops before it, the bottom half
	// into a folder or after a file, the empty space below to the root.
	function drop(event: DragEvent, target?: TreeJSONNode<any>) {
		event.preventDefault();
		event.stopPropagation();
		const node = ws.files.getNode(event.dataTransfer!.getData("text/plain"));
		if (!node || node.id === target?.id) return;
		try {
			if (!target) return node.move();
			const other = ws.files.getNode(target.id)!;
			const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
			if (event.clientY < box.top + box.height / 2) node.moveBefore(other);
			else if (!target.data.file) node.move(other);
			else node.moveAfter(other);
		} catch (error) {
			alert((error as Error).message);
		}
	}
	const icon = { rich: "¶", plain: "≡", character: "☺" } as const;
	/** The name of a file in the tree, by the ID of its document. */
	function nameOf(docId: string, nodes = files): string | undefined {
		for (const node of nodes) {
			if (node.data.file?.ref === docId) return node.data.name;
			const name = nameOf(docId, node.children);
			if (name) return name;
		}
	}
	function select(docId: string, nodes = files): void {
		for (const node of nodes) {
			if (node.data.file?.ref === docId) selectedId = node.id;
			select(docId, node.children);
		}
	}
</script>

<div class="app">
	<header>
		<strong>Pulsify example</strong>
		<button onclick={toggleOnline}
			>{online ? "Déconnexion" : "Connexion"}</button
		>
		<span>Espace : {statuses[workspace.id]}</span>
		{#each sockets as socket (socket.root)}
			<span>
				Socket « {socket.root} » : {socket.state}
				{#if socket.server}· {socket.server}{/if}
				{#if socket.envelope}· e{socket.envelope}{/if}
				· {socket.documents} doc(s)
				{#if socket.latencyMs !== undefined}· {Math.round(socket.latencyMs)} ms{/if}
				{#if socket.error}· {socket.error}{/if}
			</span>
		{:else}
			<span>Aucun socket</span>
		{/each}
		<span>
			Moi : {me}
			{#each viewers.others as other (other.peer)}
				· {other.state.name} <small>(pair {other.peer}, {other.subject})</small>
			{/each}
		</span>
	</header>

	<aside>
		<div class="toolbar">
			<button onclick={() => create("folder")}>+ Dossier</button>
			<button onclick={() => create("rich")}>+ Rich text</button>
			<button onclick={() => create("plain")}>+ Plain text</button>
			<button onclick={() => create("character")}>+ Personnage</button>
		</div>
		{#snippet branch(nodes: TreeJSONNode<any>[], depth: number)}
			{#each nodes as node (node.id)}
				{@const here = viewersOf(node.id)}
				<div
					class="row"
					class:selected={node.id === selectedId}
					style:padding-left="{8 + depth * 16}px"
					draggable="true"
					role="treeitem"
					aria-level={depth + 1}
					aria-selected={node.id === selectedId}
					tabindex="0"
					onclick={() => (selectedId = node.id)}
					onkeydown={(event) => event.key === "Enter" && (selectedId = node.id)}
					ondragstart={(event) =>
						event.dataTransfer!.setData("text/plain", node.id)}
					ondragover={(event) => event.preventDefault()}
					ondrop={(event) => drop(event, node)}
				>
					{node.data.file
						? icon[node.data.file.type as keyof typeof icon]
						: "▸"}
					{node.data.name}
					{#if here.length}<small>— {here.join(", ")}</small>{/if}
				</div>
				{@render branch(node.children, depth + 1)}
			{/each}
		{/snippet}
		<div role="tree">{@render branch(files, 0)}</div>
		<div
			class="drop-root"
			role="presentation"
			ondragover={(event) => event.preventDefault()}
			ondrop={(event) => drop(event)}
		></div>
	</aside>

	<main>
		{#if current}
			<p>
				<strong>{current.data.name}</strong>
				<button onclick={rename}>Renommer</button>
				<button onclick={remove}>Supprimer</button>
				{#if file}
					<br /><small>
						{file.ref} · {statuses[file.ref] ?? "chargement"} · rôle : {roles[
							file.ref
						] ??
							cloud.roleOf(file.ref) ??
							"?"}
					</small>
				{/if}
			</p>
			{#if file}
				{#key file.ref}
					{#await load()}
						<p>Chargement…</p>
					{:then doc}
						{#if file.type === "rich"}
							<RichEditor doc={doc as any} />
						{:else if file.type === "plain"}
							<PlainEditor doc={doc as any} />
						{:else}
							<CharacterEditor
								doc={doc as any}
								{files}
								{nameOf}
								open={select}
							/>
						{/if}
					{:catch error}
						<p>Erreur : {error.message}</p>
					{/await}
				{/key}
			{:else}
				<p>Dossier : {current.children.length} élément(s).</p>
			{/if}
		{:else}
			<p>
				Sélectionnez ou créez un fichier à gauche. Glissez-déposez pour
				déplacer.
			</p>
		{/if}
	</main>
</div>
