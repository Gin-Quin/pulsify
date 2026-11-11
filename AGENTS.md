# Repository instructions

- Never prefix branch names with `codex/`. Use a prefix such as `feat/` or `fix/`.
- When committing, check previous commit names and follow the same style and conventions.
- Use a gitmoji and plain English for PR titles.
- Bump Pulsify's major version for every major change, especially changes to the transport, wire format, or synchronization semantics. Keep Pulsify package versions and peer dependency ranges aligned, and update the lockfile and relevant protocol documentation and fixtures.

## Releasing

- Packages are published to npm as unscoped `pulsify-*` names and to JSR as `@pulsify/*`.
- To release, bump every package to the same version, merge to `main`, then tag that commit with the version: `git tag vX.Y.Z && git push --tags`. The `Publish` workflow builds and publishes every version not yet on npm through trusted publishing; no npm token is needed.
- Publish to JSR with `bun scripts/publish-jsr.ts`.
- A new package must be published once by hand (`npm publish --access public` in its directory), then trusted with `npx npm@latest trust github <name> --repo Gin-Quin/pulsify --file publish.yml --allow-publish`, and added to the directory lists in `.github/workflows/publish.yml` and `scripts/publish-jsr.ts`.
