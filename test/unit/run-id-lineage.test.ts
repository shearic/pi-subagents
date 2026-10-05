import assert from "node:assert/strict";
import * as os from "node:os";
import { describe, it } from "node:test";
import { SUBAGENT_RUN_ID_ENV } from "../../src/runs/shared/child-runtime-config.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";

function childProcessEnv(runId: string | undefined, host: "parent" | "runner" = "runner"): Record<string, string | undefined> {
	const launch = buildInProcessChildLaunch({
		host,
		cwd: os.tmpdir(),
		childAgentName: "worker",
		childIndex: 0,
		sessionEnabled: false,
		inheritProjectContext: false,
		inheritGlobalContext: false,
		inheritSkills: false,
		...(runId === undefined ? {} : { runId }),
	});
	return launch.session.processEnv ?? {};
}

describe("run-id lineage", () => {
	it("publishes the child's run id for the runner host only", () => {
		const env = childProcessEnv("lineage-run-1");
		assert.equal(env[SUBAGENT_RUN_ID_ENV], "lineage-run-1");
	});

	it("removes the variable when the launch carries no run id", () => {
		const env = childProcessEnv(undefined);
		assert.equal(Object.hasOwn(env, SUBAGENT_RUN_ID_ENV), true, "an undefined value deletes the variable instead of leaving a stale one");
		assert.equal(env[SUBAGENT_RUN_ID_ENV], undefined);
	});

	it("never writes child environment values in the parent host", () => {
		assert.deepEqual(childProcessEnv("lineage-run-2", "parent"), {});
	});
});
