// The deployed Pulsify Cloud service: bun run deploy:service
import { handleServiceRequest, type ServiceEnv } from "./source/worker.js";

export { PulsifyAccount } from "./source/Account.js";
export { PulsifyProject } from "./source/Project.js";
export { PulsifyRoot } from "./source/Root.js";

export default {
	fetch: (request: Request, env: ServiceEnv) =>
		handleServiceRequest(request, env),
};
