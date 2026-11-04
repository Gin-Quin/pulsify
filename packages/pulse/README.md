# @pulsify/core

A TypeScript API for collaborative object documents. Built ESM runs in Bun, Node 22+, Deno 2 and browsers. Build from the workspace with `bun run build`; package exports and TypeScript declarations are in `dist/`. The emitted ESM declarations support strict NodeNext consumers. Keep the shared JavaScript chunks together with the entry files when copying a build.

## Define, create and observe

```ts
import {
  createPulse, definePulse, subscribePulse, snapshotPulse,
  destroyPulse, type PulseProperties,
} from "@pulsify/core";

type Note = PulseProperties<"Note"> & {
  title: string;
  author: { name: string };
  tags: string[];
};
const Note = definePulse<Note>("Note").materialize();
const note = createPulse(Note, {
  title: "Draft", author: { name: "Ada" }, tags: ["work"],
});
const unsubscribe = subscribePulse(note, value => console.log(value.title));
note.title = "Ready";
note.author.name = "Grace";
note.tags.push("review");
const detached = snapshotPulse(note);
unsubscribe();
destroyPulse(note);
```

Subscriptions run immediately, then synchronously after committed changes. Local creation and edits retain native patches without portable conversion or binary encoding. Sending or exporting history encodes each patch once and caches its bytes. `{ connect: true }` starts synchronization after creation; otherwise encoding waits until an explicit connection or export. The root proxy and identity registry are always initialized. Codec handles the wire schema without a separate schema-validation pass in Pulsify. Subscriber exceptions are reported through `onError`; they do not interrupt synchronization. `snapshotPulse` returns detached enumerable public values, including materialized fields. Without a custom materializer, it copies the engine view directly rather than traversing the proxies.

Row-count and metadata capacity limits are checked before local commits. Binary patch and encoded-history size limits are checked when bytes are requested. An oversized local patch can therefore remain usable locally while its export fails with `LIMIT_EXCEEDED`; connection failures are reported through synchronization promises and `onError`.

`id`, `kind`, `version` and `generation` are managed by Pulsify. `id` can be supplied only at creation. The v1 generation is zero. Values support finite numbers, well-formed Unicode strings, booleans, null, undefined, dense arrays and plain objects. Reserved prototype properties (`__proto__`, `constructor`, `prototype`), cyclic values and non-JSON classes are rejected.

Nested views retain identity while their CRDT node exists, including across remote edits. References to replaced or removed nodes become invalid; read the replacement from its parent. Array removal methods return detached values. Array holes, extending `length` and deleting an array index are rejected; use `splice`. Reordering/replacing a collection rebuilds its elements and can invalidate previous element references.

## Connect and load

```ts
import {
  connectPulse, createWebSocketConnector, loadPulse, disconnectPulse,
} from "@pulsify/core";

const connector = createWebSocketConnector("ws://localhost:3000/sync");
const remoteNote = await loadPulse(Note, "document-id", {
  connectors: [connector],
  waitFor: "all",
  timeoutMs: 10_000,
});
disconnectPulse(remoteNote);  // Keep editing locally.
remoteNote.tags.push("offline");
await connectPulse(remoteNote).synced;
```

Creation starts disconnected by default. Pass `{ connectors: [connector], connect: true }` to start automatically, or call `connectPulse(note)`. Its promises resolve to the same public pulse:

| Promise | Meaning |
| --- | --- |
| `ready` | Usable document data is available. Configured local connectors are tried before remote connectors. |
| `connected` | All configured connectors have completed their initial download. |
| `synced` | Initial synchronization is complete and all configured connectors have acknowledged the local history. |

`loadPulse` waits for `ready` by default. `waitFor` accepts `"connected"`, `"synced"`, `"all"` (alias of `"synced"`) or an array of configured connectors. Required connector failures reject `connected`/`synced`; an earlier `ready` may already have succeeded. Missing documents, aborts and timeouts settle with a `PulseError`. Pass `signal` to cancel initial loading. With no connectors, a created document resolves immediately and loading an unknown ID rejects with `NOT_FOUND`.

These promises describe initial synchronization; future edits continue flowing through the sessions. Use `getPulseMeta(pulse)` for diagnostic status and the last connection error. Its engine/journal fields are internal state: do not mutate them directly. After an established transport closes, call `disconnectPulse` and `connectPulse` to reconnect; retries are application-controlled.

## Client scopes and in-memory synchronization

One scope contains one public instance per document ID and definition. Reusing an ID returns the existing materialized instance. Use separate scopes for different clients, tests, requests or tenants.

```ts
import {
  createMemoryConnector, createPulseScope, PulseRelay,
} from "@pulsify/core";

const relay = new PulseRelay();
const connector = createMemoryConnector(relay);
const first = createPulse(Note, {
  id: "shared", title: "Draft", author: { name: "Ada" }, tags: [],
}, { scope: createPulseScope(), connectors: [connector] });
await connectPulse(first).synced;
const second = await loadPulse(Note, "shared", {
  scope: createPulseScope(), connectors: [connector], waitFor: "all",
});
first.author.name = "Grace"; // Automatically reaches second.
```

`createMemoryConnector()` creates a private relay when none is supplied. For a shared relay that validates inner CRDT operations too, use the default connector relay or supply an operation validator to `PulseRelay`; the generic protocol relay otherwise treats operation bytes as opaque.

`destroyPulse` closes sessions, cancels unfinished initialization, removes subscriptions and releases the identity-map entry. Writes to destroyed instances fail. Destroying a client does not delete the relay's stored history.

## Migrations and materialization

```ts
type UserV1 = PulseProperties<"User"> & { name: string; email: string };
type UserV2 = PulseProperties<"User"> & { name: string; emailV2: string };
type User = UserV1;

const User = definePulse<UserV1>("User")
  .migrate<UserV2>("v2", before => ({ emailV2: before.email }))
  .materialize<User>(({ bind }) => ({ email: bind("emailV2") }));

const user = createPulse(User, { name: "Ada", emailV2: "ada@example.com" });
user.email = "grace@example.com";
```

Creation accepts the latest stored shape. Loading applies migrations in order, once per stored version, and synchronizes the resulting patch. A current document does not copy or traverse its view to check for migrations. Migration functions receive a detached copy only when they run, return partial updates, and must be deterministic and free of external side effects; unchanged stored fields remain. They cannot write managed properties. Future migration versions or another document kind are rejected.

`bind("field")` creates a typed two-way alias. Consumed storage aliases are omitted from enumeration of the public view. Custom derived bindings implement `get(data)` and `set(data, value)`; they do not consume stored fields automatically. Definitions and materializers are local TypeScript functions and are never transmitted to a relay.

## Options and custom transports

`setDefaultPulseOptions` changes defaults; individual calls can override `createId`, `connect`, `connectors`, `scope`, `timeoutMs`, `onError` and an optional numeric `sessionId`. Usually leave session IDs random; explicit IDs must be safe integers >= 65536 and unique among writers of a document.

A `Connector` supplies `kind: "local" | "remote"` and `open({ docId, signal, onMessage, onClose })`, returning a session with asynchronous `send(Uint8Array)` and idempotent `close()`. Deliver complete binary frames, honor cancellation and report transport closure. A WebSocket factory can be supplied to `createWebSocketConnector` for custom runtime/authentication integration. See the [protocol specification](../../docs/PROTOCOL.md).

The codecs compile trusted, fixed schemas with generated JavaScript functions. Browser deployments need a Content Security Policy that permits that code generation; received frames never supply executable schemas.
