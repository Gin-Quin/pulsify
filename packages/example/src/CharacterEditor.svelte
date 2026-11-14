<script lang="ts">
	import { arrayOperations, plainText, type TreeJSONNode } from "pulsify-core";
	import { SveltePulse } from "pulsify-svelte";
	import type { Character } from "./pulsify";

	let {
		doc,
		files,
		nameOf,
		open,
	}: {
		doc: Character;
		files: TreeJSONNode<any>[];
		nameOf: (docId: string) => string | undefined;
		open: (docId: string) => void;
	} = $props();
	const c = new SveltePulse(doc);

	/** A whole number from a number input, or nothing while it is not one. */
	const whole = (event: Event) => {
		const value = (event.currentTarget as HTMLInputElement).valueAsNumber;
		return Number.isSafeInteger(value) ? value : undefined;
	};
	let statName = $state("");
	let linkTo = $state("");
	// The rich and plain text files of the tree, which a character can link.
	const notes = $derived.by(() => {
		const all: { id: string; name: string; type: string }[] = [];
		const walk = (nodes: TreeJSONNode<any>[]) => {
			for (const node of nodes) {
				const file = node.data.file;
				if (file && file.type !== "character")
					all.push({ id: file.ref, name: node.data.name, type: file.type });
				walk(node.children);
			}
		};
		walk(files);
		return all;
	});
	function link() {
		const note = notes.find((note) => note.id === linkTo);
		// A sub() field accepts the ID; reads return a reference.
		if (note) c.links.push({ type: note.type, ref: note.id } as never);
		linkTo = "";
	}
</script>

<fieldset>
	<legend>Scalaires</legend>
	<label>Nom (string) <input bind:value={c.name} /></label>
	<label>
		Surnom (optional)
		<input
			type="checkbox"
			checked={c.nickname !== undefined}
			onchange={(event) =>
				(c.nickname = event.currentTarget.checked ? "" : undefined)}
		/>
		{#if c.nickname !== undefined}<input bind:value={c.nickname} />{/if}
	</label>
	<label>
		Âge (uint)
		<input
			type="number"
			min="0"
			value={c.age}
			oninput={(event) => {
				const age = whole(event);
				if (age !== undefined && age >= 0) c.age = age;
			}}
		/>
	</label>
	<label>
		Taille (float64)
		<input type="range" min="0.5" max="2.5" step="0.01" bind:value={c.height} />
		{c.height.toFixed(2)} m
	</label>
	<label
		>Vivant (boolean) <input type="checkbox" bind:checked={c.alive} /></label
	>
	<label>
		Rôle (string)
		<select bind:value={c.role}>
			{#each ["Guerrier", "Mage", "Voleur", "Barde"] as role (role)}
				<option>{role}</option>
			{/each}
		</select>
	</label>
	<label>
		Position (frozen tuple, remplacée en entier)
		{#each [0, 1] as axis (axis)}
			<input
				type="number"
				style="width: 6em"
				value={c.position[axis]}
				oninput={(event) => {
					const value = whole(event);
					if (value === undefined) return;
					const position: [number, number] = [c.position[0], c.position[1]];
					position[axis] = value;
					c.position = position;
				}}
			/>
		{/each}
	</label>
	<p>Créé le (constant) : {new Date(c.createdAt).toLocaleString("fr-FR")}</p>
</fieldset>

<fieldset>
	<legend>Biographie (plainText : les éditions concurrentes fusionnent)</legend>
	<textarea
		rows="5"
		style="width: 100%"
		value={c.bio.text}
		oninput={(event) => (c.bio = plainText(event.currentTarget.value))}
	></textarea>
</fieldset>

<fieldset>
	<legend>Tags (array de strings)</legend>
	{#each c.tags as tag, index (index)}
		<div>
			<input
				value={tag}
				oninput={(event) => (c.tags[index] = event.currentTarget.value)}
			/>
			<button
				disabled={index === 0}
				onclick={() => arrayOperations(c.tags).move(index, index - 1)}>↑</button
			>
			<button
				disabled={index === c.tags.length - 1}
				onclick={() => arrayOperations(c.tags).move(index, index + 1)}>↓</button
			>
			<button onclick={() => c.tags.splice(index, 1)}>✕</button>
		</div>
	{/each}
	<button onclick={() => c.tags.push("nouveau")}>+ Tag</button>
</fieldset>

<fieldset>
	<legend>Statistiques (map de int)</legend>
	<table>
		<tbody>
			{#each Object.keys(c.stats).sort() as key (key)}
				<tr>
					<td>{key}</td>
					<td>
						<input
							type="number"
							value={c.stats[key]}
							oninput={(event) => {
								const value = whole(event);
								if (value !== undefined) c.stats[key] = value;
							}}
						/>
					</td>
					<td><button onclick={() => delete c.stats[key]}>✕</button></td>
				</tr>
			{/each}
		</tbody>
	</table>
	<input placeholder="force, agilité…" bind:value={statName} />
	<button
		disabled={!statName || statName in c.stats}
		onclick={() => {
			c.stats[statName] = 10;
			statName = "";
		}}>+ Statistique</button
	>
</fieldset>

<fieldset>
	<legend>Inventaire (array d'objets)</legend>
	{#each c.inventory as entry, index (index)}
		<div>
			<input bind:value={entry.item} />
			×
			<input
				type="number"
				min="0"
				style="width: 5em"
				value={entry.quantity}
				oninput={(event) => {
					const quantity = whole(event);
					if (quantity !== undefined && quantity >= 0)
						entry.quantity = quantity;
				}}
			/>
			<button onclick={() => c.inventory.splice(index, 1)}>✕</button>
		</div>
	{/each}
	<button onclick={() => c.inventory.push({ item: "Objet", quantity: 1 })}
		>+ Objet</button
	>
</fieldset>

<fieldset>
	<legend>Liens vers d'autres fichiers (sub-pulses)</legend>
	{#each c.links as link, index (index)}
		<div>
			{link.type === "rich" ? "¶" : "≡"}
			{nameOf(link.ref.id) ?? "(supprimé de l'arbre)"}
			<small>{link.ref.id} · {link.ref.pulse ? "chargé" : "non chargé"}</small>
			<button onclick={() => open(link.ref.id)}>Ouvrir</button>
			<button onclick={() => c.links.splice(index, 1)}>✕</button>
		</div>
	{/each}
	<select bind:value={linkTo}>
		<option value="">Choisir un fichier…</option>
		{#each notes as note (note.id)}
			<option value={note.id}>{note.name}</option>
		{/each}
	</select>
	<button disabled={!linkTo} onclick={link}>+ Lien</button>
</fieldset>
