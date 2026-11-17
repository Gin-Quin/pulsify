// The Worker entry of `bun run test:cloud --backend cloudflare`, as README.md shows it for self-hosting.
export { PulsifyCloudRoot, cloudWorker as default } from "./source/index.js";
