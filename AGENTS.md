# Repository instructions

- Work and commit on `main` by default. Only create a branch when explicitly asked.
- Never prefix branch names with `codex/`. Use a prefix such as `feat/` or `fix/`.
- When committing, check previous commit names and follow the same style and conventions.
- Use a gitmoji and plain English for PR titles.
- Bump Pulsify's major version for every major change, especially changes to the transport, wire format, or synchronization semantics. Keep Pulsify package versions and peer dependency ranges aligned, and update the lockfile and relevant protocol documentation and fixtures.

## Formatting

- Bun is the formatter, configured by `[fmt]` in `bunfig.toml`. `bun run format:check` verifies the repository (CI runs it) and `bun run format:fix` formats it. To format only the files you changed, pass them: `bun fmt <files>`.
- Never run Prettier, Biome or another formatter, `bunx prettier` included: they have no configuration here and rewrite whole files.
- `.prettierignore` is the ignore list that `bun fmt` reads. Keep it; it does not mean Prettier is in use.

## Releasing

- Packages are published to npm as unscoped `pulsify-*` names and to JSR as `@pulsify/*`.
- To release, bump every package and publishable Rust crate to the same version, merge to `main`, then push the commit and its version tag: `git push origin main && git tag vX.Y.Z && git push origin vX.Y.Z`. The `Publish` workflow verifies that the tagged commit belongs to `main` and that the tag matches the package and Rust crate versions, then deploys the website and publishes every version not yet on npm or crates.io. A push to `main` without a version tag only runs checks.
- Website releases require the `CLOUDFLARE_API_TOKEN` GitHub Actions secret, scoped to the Pulsify account and the `pulsify.cloud` zone. npm and crates.io use trusted publishing (OIDC) and need no registry tokens in GitHub secrets.
- Rust crates publish in dependency order: `pulsify-protocol`, `pulsify-sqlite`, `tauri-plugin-pulsify`, then `pulsify-rocksdb` (which depends only on `pulsify-protocol`). Every publishable crate must trust the GitHub repository `Gin-Quin/pulsify`, workflow `publish.yml`, with no environment restriction on crates.io. Crates with `publish = false` are not released.
- Publish to JSR with `bun scripts/publish-jsr.ts`.
- A new package must be published once by hand (`npm publish --access public` in its directory), then trusted with `npx npm@latest trust github <name> --repo Gin-Quin/pulsify --file publish.yml --allow-publish`, and added to the directory lists in `.github/workflows/publish.yml` and `scripts/publish-jsr.ts`.
