# NOTES — telemetry lineage PR prep

Branch: `feat/telemetry-lineage` (from `main` @ 6826b054). Not pushed; no PR opened.

## Phase 1 findings (read from source before writing anything)

### 1. How child pi processes are spawned

Children are **not** spawned as `pi` CLI processes. There are two host paths:

- **Foreground children**: a pi `AgentSession` created *inside the parent pi process*
  (SDK `createAgentSession`, wrapped by the default factory in
  `src/runs/shared/child-session.ts`). Launch built by
  `buildInProcessChildLaunch` (`src/runs/shared/child-launch.ts`) with
  `host: "parent"`. No `--no-extensions`/`-e`/`--append-system-prompt` CLI flags
  exist on this path; system prompt goes through the session launch
  (`systemPrompt` / `appendSystemPrompt`), model through `model` (with `:thinking`
  suffix), cwd through `cwd`.
- **Background (async) children**: same in-process session, but hosted inside a
  **detached runner process** spawned by `spawnRunner`
  (`src/runs/background/async-execution.ts` ~L656). One runner process per
  top-level async run. Spawn args:
  - Compiled/binary pi host: `pi --no-extensions --no-skills
    --no-prompt-templates --no-session --mode rpc --extension <binary-bootstrap.ts>`
  - npm/node host: `node [--import runner-peer-preload.mjs] <subagent-runner.ts>
    <cfg.json>` (jiti/strip-types variants).
  The runner env is the cleaned parent env plus `PI_CODING_AGENT_PACKAGE_ROOT`,
  `PI_PACKAGE_DIR`, `PI_SUBAGENT_RUNNER_CONFIG` (binary hosts),
  `PI_SUBAGENT_PARENT_SESSION`, and `PI_ASYNC_NATIVE_RUNNER`.

Inside the runner, child sessions load **ambient extensions by default**
(`ambientExtensions = host === "runner" && !toolPlan.disableAmbientExtensions`,
`src/runs/shared/child-launch.ts`), unlike foreground children which load only
the explicitly configured extension paths (loading ambient extensions twice in
one process would start second copies of the parent's extensions).

### 2. `PI_SUBAGENT_PARENT_SESSION`

- Const: `SUBAGENT_PARENT_SESSION_ENV` in `src/runs/shared/child-runtime-config.ts`.
- **Value: the bare parent session id** (not a file path): `ctx.parentSessionId ??
  ctx.currentSessionId` (`src/runs/background/async-execution.ts`, validated to be
  non-empty and trimmed before spawn). Set only in the detached runner's spawn env
  (`spawnRunner`); deleted when the launch has no parent session.
- Root hosts delete it at session start (`src/extension/index.ts` ~L974) because a
  root process can host multiple independent sessions; only dedicated child
  processes (`PI_SUBAGENT_CHILD=1`, set by `src/runs/background/subagent-runner.ts`
  ~L169) retain their launch-owned value.
- Consumer: pi-permission-system uses it to forward child `ask` requests to the
  right parent session. Surfaced by `subagent({ action: "doctor" })`
  (`src/extension/doctor.ts`).
- Documentation today: one paragraph in `docs/watchdog.md` (L185) only. The README
  documents nothing about it.

### 3. Per-invocation run/job id

Already exists. `randomUUID()` per tool invocation
(`src/runs/foreground/subagent-executor.ts` ~L7494; scheduled runs and workflow
children mint their own UUIDs). For async runs the same id is the async run
directory basename (`$TEMP_ROOT/async-subagent-runs/<runId>`). It appears in
parent-side tool results as `details.runId` (foreground/workflow) or
`details.asyncId` (async started receipts), and per-child as
`SingleResult.runId` for workflow children. No env var publishes it to child
processes today (checked: `PI_SUBAGENT_RUN_ID` appears nowhere in the repo).

### 4. Registered tools and result shape

- Tools: `subagent` (main tool; management actions are the same tool with
  `action`) and `subagents_enable` (loader, `src/extension/tool-activation.ts`).
  Also registers a child-side `bg_wait`-style wait tool surface and
  `subagent_command` in child sessions, plus in-process RPC methods
  (`src/extension/rpc.ts`).
- Results are **already structured**: `AgentToolResult<Details>` where `Details`
  (`src/shared/types.ts` ~L1440) carries `runId`, `asyncId`, `mode`, per-child
  `results: SingleResult[]` (agent, task, model, usage, sessionFile, exitCode,
  interrupted/timedOut/stopped, error, ...), `totalChildUsage`, `totalCost`,
  `progress`, budget snapshots, etc.
- Completion notifications (`src/runs/background/notify.ts`,
  `SubagentNotifyDetails`) already carry run id(s), agent, status, `durationMs`,
  child run ids/outputs. `WaitCompletion` carries run identity per child.
- Genuinely missing at the per-child level: `durationMs` on `SingleResult`
  (duration exists live in `AgentProgress.durationMs` and per-step in async
  `status.json`, and in notify details, but not on the final per-child tool-result
  entry). Stop reason is already expressed structurally
  (`interrupted`/`timedOut`/`stopped`/`error`/`exitCode`).

### 5. Repo conventions

- Tests: `node --test` with `--experimental-strip-types`; unit tests in
  `test/unit/*.test.ts` (`npm run test:unit`), integration in `test/integration`
  (`npm run test:integration`, uses `test/support/register-loader.mjs`), smoke in
  `test/smoke`. Tests run without a real model via an injectable/scripted
  `ChildSessionFactory` and mocked `spawn`.
- Typecheck: `npm run typecheck` (tsc --noEmit). Lint: oxlint config.
- Config surface: `ExtensionConfig` (`src/shared/types.ts`) validated in
  `src/extension/config.ts`; file at `~/.pi/agent/extensions/subagent/config.json`.
  Env-var options exist and are documented in `docs/configuration.md`
  (e.g. `PI_SUBAGENT_PI_BINARY`, `PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT`,
  `PI_SUBAGENT_MAX_DEPTH`, `PI_SUBAGENT_TOOL_TIMEOUT_MS`).
- README is a short overview linking `docs/*.md`; docs files carry the detail.
- CHANGELOG has an `## [Unreleased]` section with Added/Changed/Fixed.
- Code style: tabs, `omitUndefinedProperties`/`compactOptional` for optional
  fields, fail-closed validation with explicit error messages.

### Item-by-item gap analysis (what already exists)

| Task item | Already exists? | Delta needed |
|---|---|---|
| 1. run-id lineage env var | Run id exists everywhere; **no env var** | Add `PI_SUBAGENT_RUN_ID` (runner spawn env + runner-hosted child `processEnv`) + docs + tests |
| 2. document `PI_SUBAGENT_PARENT_SESSION` | Value is already a **bare session id** (no filesystem coupling) | Docs only (README + `docs/configuration.md`); no sibling var needed |
| 3. additive extension option for children | Per-agent `subagentOnlyExtensions` frontmatter is already additive; no **global** additive option | Add env option `PI_SUBAGENT_EXTRA_CHILD_EXTENSIONS` (append-only, both hosts) + docs + tests |
| 4. structured result details | `Details`/`SingleResult`/notify details already structured incl. run id, agent, model, usage, stop flags | Add missing per-child `durationMs` on `SingleResult` (foreground + runner finalization); stop reason documented as existing fields |
| 5. optional child session persistence | **Persistence is always on by default** (`docs/configuration.md`: "Sessions are always enabled"); location: `params.sessionDir` > `config.defaultSessionDir` > dir derived from parent session; per-child files `<root>/<runId>/run-<i>/session.jsonl` | Docs only (README section incl. disk-usage tradeoff); no code |

### Baseline test status on this machine (before any change)

`npm run test:unit`: 3800 tests, 3773 pass, **10 fail** — all environmental,
none caused by these changes (verified on clean `main`):

- `test/unit/herdr-connection.test.ts` (7): Unix-socket `listen EINVAL` on this
  sandboxed macOS temp path.
- `test/unit/herdr-native-placement.test.ts` (2): same socket restriction.
- `test/unit/extension-module-preload.test.ts` (1): wall-clock timing budget.
- `test/unit/fleet.test.ts` (1): terminal-width rendering assumption.

`npm run typecheck`: clean.

## Manual verification transcript

See `scripts/manual-verification.mjs` (added in a verification commit, not part
of the shipped package). Run with:

```bash
node --experimental-strip-types scripts/manual-verification.mjs
```

Transcript captured below after implementation (see "Verification runs").

### Verification runs

(Filled in after implementation — see bottom of this file.)
