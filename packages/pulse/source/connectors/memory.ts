import type { Connector } from "../connection/Connector.js";
import { rowToPatch } from "../connection/PulsePatch.js";
import { PulseError } from "../protocol/errors.js";
import { PulseRelay } from "../protocol/PulseRelay.js";

export function createMemoryConnector(
	relay = new PulseRelay(rowToPatch),
	kind: Connector["kind"] = "local",
): Connector {
	return {
		kind,
		async open({ signal, onMessage, onClose }) {
			if (signal.aborted) throw new PulseError("CLOSED", "Connection aborted");
			let closed = false;
			const peer = relay.open((bytes) => {
				queueMicrotask(() => {
					if (!closed) onMessage(bytes);
				});
			});
			const close = () => {
				if (closed) return;
				closed = true;
				peer.close();
				signal.removeEventListener("abort", abort);
			};
			const abort = () => {
				close();
				onClose(new PulseError("CLOSED", "Connection aborted"));
			};
			signal.addEventListener("abort", abort, { once: true });
			return {
				close,
				async send(bytes) {
					if (closed) throw new PulseError("CLOSED", "Connection closed");
					peer.receive(bytes);
				},
			};
		},
	};
}
