/**
 * Manual verification for the observability lineage work. Dev-only; not part
 * of the shipped package. Run from the repository root:
 *
 *   node --experimental-strip-types scripts/manual-verification.mjs
 *
 * No real model is contacted: the background child is a scripted session
 * factory that records its launch environment, and the foreground child uses
 * the real SDK with a synthetic local provider.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "manual-verify-"));
process.env.PI_SUBAGENTS_TEMP_ROOT = tempRoot;
process.env.PI_SUBAGENTS_TEST_ENV = "1";
const recordPath = path.join(tempRoot, "child-record.json");
process.env.MANUAL_VERIFY_RECORD = recordPath;
process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, "agent");

// Imports resolve after the environment above is in place.
const { setChildSessionFactoryModule, createDefaultChildSessionFactory } = await import("../src/runs/shared/child-session.ts");
const { executeAsyncSingle } = await import("../src/runs/background/async-execution.ts");
const { resolvePiLaunchToolPlan } = await import("../src/runs/shared/child-tool-plan.ts");
const { runSync } = await import("../src/runs/foreground/execution.ts");

const artifactConfig = { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 };

function step(name) {
	console.log(`\n=== ${name} ===`);
}

// --- Part A: a spawned background child sees the lineage env vars, and the
// --- parent-side tool result reports the same run id.
step("A. background child lineage env vars");
setChildSessionFactoryModule(path.join(import.meta.dirname, "manual-verification-runner-factory.mjs"));
const runId = "manual-verify-run";
const asyncResult = await executeAsyncSingle(runId, {
	agent: "worker",
	task: "Record the launch environment",
	agentConfig: { name: "worker", description: "Worker", systemPrompt: "", systemPromptMode: "replace", inheritGlobalContext: false, inheritProjectContext: false, inheritSkills: false },
	ctx: { pi: { events: { emit() {} } }, cwd: tempRoot, currentSessionId: "manual-verify-parent-session" },
	artifactConfig,
	shareEnabled: false,
	sessionRoot: path.join(tempRoot, "sessions"),
	maxSubagentDepth: 1,
	acceptance: false,
});
const statusPath = path.join(tempRoot, "async-subagent-runs", runId, "status.json");
const deadline = Date.now() + 60_000;
let status;
for (;;) {
	await new Promise((resolve) => setTimeout(resolve, 200));
	status = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, "utf-8")) : undefined;
	if (status && status.state !== "running" && status.state !== "queued") break;
	assert.ok(Date.now() < deadline, "timed out waiting for the async run to finish");
}
const record = JSON.parse(fs.readFileSync(recordPath, "utf-8"));
console.log("child record:", JSON.stringify(record, null, 2));
console.log("run status:", status.state, "exit:", status.steps?.[0]?.exitCode ?? "?");
console.log("parent-side result details:", JSON.stringify(asyncResult.details, null, 2));
assert.equal(record.env.PI_SUBAGENT_RUN_ID, runId, "child process sees PI_SUBAGENT_RUN_ID");
assert.equal(record.env.PI_SUBAGENT_PARENT_SESSION, "manual-verify-parent-session", "child process sees PI_SUBAGENT_PARENT_SESSION");
assert.equal(record.env.PI_SUBAGENT_CHILD, "1", "child process is marked as a dedicated child host");
assert.equal(record.childRunId, runId, "the child session's runtime run id matches");
assert.equal(asyncResult.details.asyncId, runId, "the parent-side tool result reports the same run id");
assert.ok(record.storage.kind === "file" || record.storage.kind === "dir", "the background child gets a persisted session storage target");
console.log("A: OK — lineage env vars present in the child; join key matches the parent-side result.");

// --- Part B: the additive extension option keeps auto-discovered extensions
// --- and appends the named extra.
step("B. additive child extension option");
const extraPath = path.join(tempRoot, "tracing-extension.ts");
process.env.PI_SUBAGENT_EXTRA_CHILD_EXTENSIONS = `${path.delimiter}${extraPath} `;
const planDefault = resolvePiLaunchToolPlan({ cwd: tempRoot });
console.log("no agent extensions -> disableAmbientExtensions:", planDefault.disableAmbientExtensions);
console.log("extensionArgs:", planDefault.extensionArgs);
assert.equal(planDefault.disableAmbientExtensions, false, "ambient discovery (auto-discovered extensions) stays enabled");
assert.ok(planDefault.extensionArgs.includes(extraPath), "the named extra is appended");
const planReplace = resolvePiLaunchToolPlan({ extensions: ["/agent/own.ts"], cwd: tempRoot });
console.log("agent extensions: [/agent/own.ts] -> disableAmbientExtensions:", planReplace.disableAmbientExtensions);
console.log("extensionArgs:", planReplace.extensionArgs);
assert.equal(planReplace.disableAmbientExtensions, true, "the agent's own replace semantics are unchanged");
assert.ok(planReplace.extensionArgs.includes("/agent/own.ts") && planReplace.extensionArgs.includes(extraPath), "the extra still loads alongside the replaced set");
delete process.env.PI_SUBAGENT_EXTRA_CHILD_EXTENSIONS;
const planUnset = resolvePiLaunchToolPlan({ cwd: tempRoot });
assert.equal(planUnset.extensionArgs.includes(extraPath), false, "unset changes nothing");
console.log("B: OK — additive only; auto-discovered extensions kept; default unchanged when unset.");

// --- Part C: a real session file is written when persistence is on
// --- (foreground child through the real SDK with a synthetic local provider).
step("C. child session persistence writes a session file");
const agentDir = process.env.PI_CODING_AGENT_DIR;
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } }));
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { manualverify: { baseUrl: "https://synthetic.invalid/v1", apiKey: "fixture-key", models: [{ id: "verify", name: "verify", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
	assert.equal(String(input), "https://synthetic.invalid/v1/chat/completions");
	const body = JSON.parse(String(init?.body ?? "{}"));
	const chunk = {
		id: "synthetic",
		object: "chat.completion.chunk",
		created: 1,
		model: "verify",
		choices: [{ index: 0, delta: { content: body.messages?.length ? "Done." : "" }, finish_reason: "stop" }],
		usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
};
const sessionDir = path.join(tempRoot, "foreground-sessions");
const foregroundResult = await runSync(tempRoot, [{
	name: "worker",
	description: "Worker",
	systemPrompt: "",
	systemPromptMode: "replace",
	inheritGlobalContext: false,
	inheritProjectContext: false,
	inheritSkills: false,
	model: "manualverify/verify",
}], "worker", "Say Done.", { sessionDir, childSessionFactory: createDefaultChildSessionFactory() });
globalThis.fetch = originalFetch;
const sessionFiles = fs.existsSync(sessionDir) ? fs.readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl")) : [];
console.log("foreground child exitCode:", foregroundResult.exitCode, "error:", foregroundResult.error ?? "(none)");
console.log("session files written:", sessionFiles.map((name) => path.join(sessionDir, name)));
console.log("foreground child durationMs:", foregroundResult.durationMs);
assert.equal(foregroundResult.exitCode, 0, `foreground child failed: ${foregroundResult.error}`);
assert.ok(sessionFiles.length >= 1, "a real session file was written under the session dir");
assert.equal(typeof foregroundResult.durationMs, "number", "the foreground result carries durationMs");
console.log("A sample of the session file:", fs.readFileSync(path.join(sessionDir, sessionFiles[0]), "utf-8").split("\n").slice(0, 1).join(""));
console.log("C: OK — persistence on by default; a real session file was written.");

console.log("\nAll manual verification checks passed.");
