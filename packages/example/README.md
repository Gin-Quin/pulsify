# Pulsify example

A minimal Notion-like app in Svelte 5 that exercises Pulsify and Pulsify Cloud:
a movable file tree (`tree()`), rich text (ProseMirror), plain text
(CodeMirror) and character sheets (every value type, `sub()` links), with the
cursors and presence of the other tabs. One public user, subject `public`.

```sh
bun run dev:service      # the local Pulsify Cloud on :8787 (bun run dev:website starts it too)
bun run dev:example      # setup (a local project, its grant, .env.development.local), then http://localhost:5173
```

"Déconnexion" closes the sockets as a lost network would and pauses
reconnection; "Connexion" resumes it. Open two windows to see edits merge.

## Deploy to example.pulsify.cloud

```sh
PULSIFY_URL=https://api.pulsify.cloud/<project> PULSIFY_API_KEY=… PULSIFY_TOKEN_SECRET=… \
  bun run setup --production   # writes .env.production.local
bun run deploy:example         # from the repository root
```

The token baked into the build is valid ten years, for the subject `public`
only: as public as the app. Run setup again after rotating the token secret.
