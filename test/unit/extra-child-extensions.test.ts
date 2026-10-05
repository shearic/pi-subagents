import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { EXTRA_CHILD_EXTENSIONS_ENV, extraChildExtensions, resolvePiLaunchToolPlan } from "../../src/runs/shared/child-tool-plan.ts";

const delimiter = path.delimiter;

function withEnv(value: string | undefined, run: () => void): void {
	const saved = process.env[EXTRA_CHILD_EXTENSIONS_ENV];
	if (value === undefined) delete process.env[EXTRA_CHILD_EXTENSIONS_ENV];
	else process.env[EXTRA_CHILD_EXTENSIONS_ENV] = value;
	try {
		run();
	} finally {
		if (saved === undefined) delete process.env[EXTRA_CHILD_EXTENSIONS_ENV];
		else process.env[EXTRA_CHILD_EXTENSIONS_ENV] = saved;
	}
}

describe("extra child extensions", () => {
	it("parses a PATH-style list, trimming and dropping empty entries", () => {
		withEnv(undefined, () => {
			assert.deepEqual(extraChildExtensions(), []);
		});
		withEnv(` ${delimiter}${delimiter}/a/tracing.ts${delimiter} ${delimiter}:/b/provider.ts `, () => {
			assert.deepEqual(extraChildExtensions(), ["/a/tracing.ts", "/b/provider.ts"]);
		});
	});

	it("appends the extras without disabling ambient extension discovery", () => {
		withEnv("/a/tracing.ts", () => {
			const plan = resolvePiLaunchToolPlan({ cwd: process.cwd() });
			assert.equal(plan.disableAmbientExtensions, false, "an omitted agent extensions list keeps ambient discovery");
			assert.ok(plan.extensionArgs.includes("/a/tracing.ts"));
		});
	});

	it("stays additive when the agent replaces its own extension set", () => {
		withEnv("/a/tracing.ts", () => {
			const plan = resolvePiLaunchToolPlan({ extensions: ["/b/agent-only.ts"], cwd: process.cwd() });
			assert.equal(plan.disableAmbientExtensions, true, "the agent's own replace semantics are unchanged");
			assert.ok(plan.extensionArgs.includes("/b/agent-only.ts"));
			assert.ok(plan.extensionArgs.includes("/a/tracing.ts"), "extras still load alongside the replaced set");
		});
	});

	it("keeps ambient discovery and appends the agent's own subagentOnlyExtensions list", () => {
		withEnv("/a/tracing.ts", () => {
			const plan = resolvePiLaunchToolPlan({ subagentOnlyExtensions: ["/b/agent-only.ts"], cwd: process.cwd() });
			assert.equal(plan.disableAmbientExtensions, false);
			assert.ok(plan.extensionArgs.includes("/b/agent-only.ts"));
			assert.ok(plan.extensionArgs.includes("/a/tracing.ts"));
		});
	});

	it("respects a capability ceiling that denies extensions", () => {
		withEnv("/a/tracing.ts", () => {
			const plan = resolvePiLaunchToolPlan({
				capabilityCeiling: { version: 1, allowedAgents: [], denyExtensions: true, sources: ["test"] },
				cwd: process.cwd(),
			});
			assert.equal(plan.extensionArgs.includes("/a/tracing.ts"), false, "a deny-extensions ceiling denies launcher extras too");
		});
	});

	it("changes nothing when unset", () => {
		withEnv(undefined, () => {
			const plan = resolvePiLaunchToolPlan({ cwd: process.cwd() });
			assert.equal(plan.extensionArgs.includes("/a/tracing.ts"), false);
		});
	});
});
