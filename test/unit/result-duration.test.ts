import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { runSingleStepInner } from "../../src/runs/background/subagent-runner.ts";
import { makeAgentConfigs } from "../support/helpers.ts";
import type { ChildSession, ChildSessionFactory } from "../../src/runs/shared/child-session.ts";

/** A scripted child that completes one assistant turn and settles. */
function completingChildSession(): ChildSession {
	let listener: Parameters<ChildSession["subscribe"]>[0] = () => {};
	const messages: unknown[] = [];
	return {
		subscribe(next) { listener = next; return () => {}; },
		async prompt() {
			const message = fauxAssistantMessage("Done");
			messages.push(message);
			listener({ type: "message_end", message });
			listener({ type: "agent_end", messages });
			listener({ type: "agent_settled" });
		},
		async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
		messages: messages as never[], sessionId: "duration-session", modelId: "mock/model",
	};
}

function completingFactory(): ChildSessionFactory {
	let created = 0;
	return {
		async create() { created++; return completingChildSession(); },
		async dispose() {},
		get createdCount() { return created; },
	};
}

it("reports durationMs on a completed foreground child result", async () => {
	const factory = completingFactory();
	const result = await runSync(process.cwd(), makeAgentConfigs(["worker"]), "worker", "Finish", { childSessionFactory: factory });
	assert.equal(result.exitCode, 0, result.error);
	assert.equal(factory.createdCount, 1);
	assert.equal(typeof result.durationMs, "number", "the terminal foreground result carries a duration");
	assert.ok(result.durationMs! >= 0);
});

it("reports durationMs on a completed runner child result", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "result-duration-"));
	const factory = completingFactory();
	const [agent] = makeAgentConfigs(["worker"]);
	const result = await runSingleStepInner(
		{ ...agent, agent: agent.name, task: "Finish", context: "fresh", waitToolEnabled: false },
		{
			cwd,
			id: "duration-run",
			flatIndex: 0,
			flatStepCount: 1,
			previousOutput: "",
			placeholder: "{previous}",
			outputFile: join(cwd, "output.log"),
			sessionEnabled: false,
			childSessions: factory,
		},
	);
	assert.equal(result.exitCode, 0, result.error);
	assert.equal(factory.createdCount, 1);
	assert.equal(typeof result.durationMs, "number", "the terminal runner result carries a duration");
	assert.ok(result.durationMs! >= 0);
});
