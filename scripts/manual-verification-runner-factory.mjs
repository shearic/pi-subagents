/**
 * Manual-verification ChildSessionFactory for the detached async runner.
 *
 * Records the launch environment and storage contract to the file named by
 * MANUAL_VERIFY_RECORD, then completes one scripted assistant turn. Dev-only;
 * not part of the shipped package.
 */
import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

export default function createRecordingFactory() {
	return {
		async create(launch) {
			const recordPath = process.env.MANUAL_VERIFY_RECORD;
			if (recordPath) {
				fs.mkdirSync(path.dirname(recordPath), { recursive: true });
				fs.writeFileSync(recordPath, JSON.stringify({
					env: {
						PI_SUBAGENT_RUN_ID: process.env.PI_SUBAGENT_RUN_ID ?? null,
						PI_SUBAGENT_PARENT_SESSION: process.env.PI_SUBAGENT_PARENT_SESSION ?? null,
						PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD ?? null,
					},
					childRunId: launch.runtime.runId ?? null,
					agent: launch.runtime.agent ?? null,
					storage: launch.storage,
				}, null, 2));
			}
			let listener = () => {};
			const messages = [];
			return {
				subscribe(next) { listener = next; return () => {}; },
				async prompt() {
					const message = fauxAssistantMessage("Done");
					messages.push(message);
					listener({ type: "message_end", message });
					listener({ type: "agent_end", messages: [...messages], willRetry: false });
					listener({ type: "agent_settled" });
				},
				async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
				messages, sessionId: "manual-verify-child", modelId: "mock/model",
			};
		},
		async dispose() {},
	};
}
