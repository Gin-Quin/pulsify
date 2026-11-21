# Author verification against a hostile editor: notes

Notes from 2026-11-18, not a plan. Nothing here is implemented.

**Decision.** Pulsify Cloud attributes writes with the token of the
connection that sent them ([authors](CLOUD.md#authors)), which is enough
between honest clients. Hardening it against an editor who lies is built
only if a customer has strong security and verification requirements.

**Trust model kept for now: optimistic.** Everything below needs the
`editor` role in the root, which only an owner of the document or the
application's backend grants. A stranger cannot do any of it: the attacker
is someone the owner invited to write. The exception is a root granted to
`*` as editor, a public room: every signed-in user of the application is an
editor there, and authors of such a root should be read as indicative. None
of the options below is implemented, option 2 included.

## What an editor can do today

An actor is a number in a row, and rows are not signed. An attacker needs
the `editor` role somewhere in the root.

**Write under someone else's actor.** Mallory edits a document, so she
downloads Alice's rows and knows her actor and its next sequence number. With
a modified client she uploads a row `sid = Alice's actor, clock = next` that
holds her own operations. The server does not decode operations: the row is
valid, so it is stored and broadcast, and noted as received from `mallory`.
The actor stays bound to `alice`.

- `actorSubject(doc, actor)` answers `alice` for that write.
- `authors.of(version)` answers `{subject: "alice", receivedFrom:
  "mallory", verified: false}`.
- Alice's next real write has the same sequence number and other content:
  the server answers `CONFLICT`. Mallory can block Alice's actor in that
  document. This predates authors.

The server accepts the row because an honest relay looks the same: Bob
uploading what Alice wrote offline also sends rows of Alice's actor.

**Claim an actor nobody has claimed.** An actor is bound by the first
`actors` message that names it. It is free in a root as long as its owner
declared nothing there. Mallory can know of one when its rows were relayed by
someone else, when its client did not declare it (a page without an
`identity` that uploads what an earlier page wrote offline), or when she saw
it in another root: a leased actor keeps its number across roots. She sends
`{"type":"actors","docId":<a document she can write>,"actors":[actor]}`.
The server checks that she can write `docId`; the binding holds for the whole
root, so an editor of `r/public` who only reads `r/private` can take an actor
seen there.

- `actorSubject` answers `mallory` for every write of that actor, those
  already stored included. They are `verified: false` when someone else sent
  them, and `verified: true` when Mallory relayed them herself.
- Alice's later claim is refused; her client takes another actor, and her
  next writes are hers.

**What an editor cannot do.** Make a write `verified` for another account,
take an actor that is bound, or attribute a write to a third party: only take
credit, or cast doubt.

## Options

1. **Show an author only when `verified` is true.** Application side,
   available now.
2. **Refuse to bind an actor that the root already received rows of from
   another account.** One query in `claimActors`. It closes the claim of an
   actor that already wrote in the root, which is the only claim that
   misattributes stored writes. It does not stop the account that relayed the
   rows from claiming their actor, nor a claim made before the actor wrote
   anything (which attributes nothing: the owner is refused and takes
   another actor). Cost: an honest owner whose offline writes were relayed by
   another account can no longer claim that actor either, since the server
   cannot tell them from a squatter. The actor stays without a user, where
   today it gets its owner, and the client takes another actor.
3. **Refuse new rows of a bound actor from another account.** Closes forging
   without signatures. It breaks the relay of offline writes of a known
   actor: the relaying client's upload fails, and those writes reach the
   server only when their author reconnects.
4. **Sign every write.** Closes forging and the claim of an actor that has
   rows, and keeps relays working. See below.

## Signed writes: what it would take

A key pair per actor. The client signs each row; the public key is
registered with the actor when it is claimed; the server refuses a row of a
bound actor whose signature does not verify.

**What it gives.** A forged row is refused, so the `CONFLICT` attack goes
too. A relayed write carries its author's signature: it becomes verifiable,
where today it is unverified for good. An actor that has rows cannot be
claimed by someone who cannot sign for them. Authors survive an export and
an import into the same document ID.

**What it does not give.** A proof of the person: it still means "the
holder of the token when the actor was claimed, and of the key since". A
claim made before the actor wrote anything stays possible, and stays
harmless. A client that wants to verify by itself, without trusting the
server, also needs the bindings of keys to accounts signed by the
application's backend: a PKI.

**Wire format and storage.** The row envelope gets a signature (64 bytes
with Ed25519): a new protocol major, in TypeScript and in the Rust crates
(`pulsify-protocol`, `pulsify-sqlite`, `pulsify-rocksdb`), with new
fixtures, a column in every store and a new packed segment layout. `span` is
rewritten by stores when writes are replaced, so it must stay outside what
is signed.

**Size.** A keystroke is a row of ten to twenty bytes: 64 more bytes
multiply the storage and the bandwidth of a text several times over.

**Transport optimizations.** The grouped envelope, state deltas and compact
writes merge or condense many transactions, and signatures do not merge.
Either a signature covers a batch, which changes what one write proves, or
these envelopes stop applying to signed documents.

**CPU.** WebCrypto signs asynchronously and commits are synchronous, so
rows are signed before upload rather than when written. The server verifies
every uploaded row, which is billed CPU in a Durable Object. Clients either
trust the server or verify every row of a cold load, seconds for a long
history. The CRDT benchmarks would need a signed and an unsigned figure.

**Keys.** One non-extractable private key per actor, in IndexedDB, shared
by the pages that lease the actor. Clearing the storage loses the key: the
actor is abandoned and a new one is claimed. Ed25519 is in recent browsers
only; ECDSA P-256 is the fallback.

**Scope.** Opt-in per root or per document, so that others keep today's
sizes and speeds. Several weeks, across the protocol, three crates, every
store, the core and the cloud.
