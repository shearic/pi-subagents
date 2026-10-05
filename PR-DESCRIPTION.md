# Make pi-subagents friendly to observability/tracing extensions (additive, no default behavior change)

## Motivation

pi-subagents already identifies every run internally: a unique run id per invocation, structured tool-result details, status artifacts, completion notifications. But a *separate* observability or tracing extension loaded into a child had no reliable way to attribute its records to the parent-side run. The pieces existed on the parent side only; the child side had no published identity, no supported way to load such an extension into every child, and no per-child timing on the terminal result entry.

This PR closes those gaps generically ("so observability/tracing extensions can attribute child activity to the parent"). Every change is additive; defaults are 100% backwards-compatible, verified by the unchanged full unit suite.

## Per-item summary

### 1. `PI_SUBAGENT_RUN_ID` — run-id lineage env var (new)

The detached background runner process now receives `PI_SUBAGENT_RUN_ID` with the id of the run it hosts, and each runner-hosted child session launch re-publishes the child's own run id in the `processEnv` window its extensions load and start in. The value is the **same id** the parent-side tool result reports (`details.runId`, or `details.asyncId` on async started receipts) and that `subagent({ action: "status", id })` accepts — so a child-side extension joins its records to the parent-side run with one variable:

```ts
// inside an extension loaded in a child session
const runId = process.env.PI_SUBAGENT_RUN_ID;      // "48e2…" (randomUUID; also the async dir basename)
const parentSession = process.env.PI_SUBAGENT_PARENT_SESSION;
```

Foreground children are sessions inside the parent Pi process, which can host independent runs and sessions, so no process-global run identity is published for them (this mirrors the existing `PI_SUBAGENT_PARENT_SESSION` design); their lineage travels in the tool result details. Root hosts also delete ambient inherited values at session start, so a stale value never misattributes a root session. Format: a run id is a `randomUUID()`-style id; for async runs it is also the async run directory basename.

### 2. `PI_SUBAGENT_PARENT_SESSION` documented (docs only)

The variable already existed but was documented only inside the watchdog notes, so consumers had to read the source. Now documented in `docs/configuration.md` (and README/observability): the value is the **bare parent session id** (never a session file path — no filesystem coupling, so no sibling variable was needed), derived from `ctx.parentSessionId ?? ctx.currentSessionId` of the launching session, set only in the detached runner's launch environment, and deleted by root hosts at session start. No behavior change.

### 3. `PI_SUBAGENT_EXTRA_CHILD_EXTENSIONS` — additive extension loading for children (new)

```bash
export PI_SUBAGENT_EXTRA_CHILD_EXTENSIONS=/path/to/tracing-extension/index.ts
```

PATH-style list of additional extension paths loaded into **every** child session (foreground and background). Semantics are strictly additive: ambient extension discovery in background children (including provider-registering extensions) and each agent's own `extensions`/`subagentOnlyExtensions` lists keep loading; the option only appends, never replaces. A `capabilityCeiling` with `denyExtensions: true` still denies these too. Unset (default) changes nothing.

**What already existed** (and is cross-referenced in the docs rather than duplicated): per-agent `subagentOnlyExtensions` frontmatter, and the settings-level `subagents.defaultSubagentOnlyExtensions` default. The settings default is suppressed by any agent that declares its own frontmatter list, so it could not guarantee that a tracing extension reaches every child — which is the gap this fills. The extras are merged at the single resolution point (`resolvePiLaunchToolPlan`), so the foreground plan, the serialized async step plan, preflight, and the detached runner (which inherits the variable) all resolve the same set.

### 4. `durationMs` on per-child terminal result entries (new)

Tool results were already fully structured (`details.runId`, per-child `details.results[]` with agent, model, usage, session file, and stop reason as `interrupted`/`timedOut`/`stopped`/`error`/`exitCode`, aggregate usage/cost) — nothing was plain text, so no new envelope was needed. The one genuinely missing field was per-child duration at the terminal: run-level duration already existed in `status.json`, completion notifications, and live progress. Each per-child entry in `details.results[]` now carries `durationMs` (wall-clock, launch → terminal result) on both the foreground and runner paths; children that fail before launching leave it undefined.

A normalized `stopReason` string was deliberately **not** added: stop reason is already expressed structurally on the same entry (`interrupted`, `timedOut`, `stopped`, `error`, `exitCode`), and a second string form could disagree with those flags. The documentation now names those fields as the stop-reason contract.

### 5. Child session persistence — already existed; documented (docs only)

Children already get stable session ids and session files **by default** (this is stronger than the requested "optional, default off"): every child, foreground and background, writes a session file under a per-run session directory — `params.sessionDir` > `config.defaultSessionDir` > a directory derived from the parent session, with `<root>/<runId>/run-<index>/session.jsonl`. No code change; the README now documents the contract and the disk-usage tradeoff, and `docs/configuration.md`'s `defaultSessionDir` section names it explicitly.

## What already existed (used, not duplicated)

- Per-invocation run ids (`randomUUID()`), already reported in tool-result details, status, artifacts, and notifications — reused as the lineage key.
- Structured `Details`/`SingleResult` tool results and structured completion notifications (`SubagentNotifyDetails`, `WaitCompletion`) — extended only with `durationMs`.
- `PI_SUBAGENT_PARENT_SESSION` (bare id), per-agent `subagentOnlyExtensions`, settings-level `subagents.defaultSubagentOnlyExtensions`, child session persistence — documented/cross-referenced instead of reimplemented.

## Tests

- New: `test/unit/run-id-lineage.test.ts` (runner-hosted child `processEnv` publish/remove/parent-host exclusion), extensions to `test/unit/binary-async-spawn.test.ts` (spawn env carries the run id on all three spawn shapes), `test/unit/extra-child-extensions.test.ts` (parse + additivity + ceiling + default), `test/unit/result-duration.test.ts` (foreground `runSync` and runner `runSingleStepInner` terminal results).
- Full unit suite: same pass/fail set as the pre-change baseline on this machine (the 10 pre-existing failures are environmental: sandboxed Unix sockets for the herdr tests, one timing budget, one terminal-width assumption). No regressions; typecheck clean.
- Manual end-to-end verification without a real model: `scripts/manual-verification.mjs` (dev-only, not shipped) spawns a real detached runner with a scripted child that records its launch environment, and runs a foreground child through the real SDK with a synthetic local provider. Transcript in `NOTES.md`.

## Checklist

- One commit per item; every default unchanged.
- README gained one section per item (`## Observability lineage` with per-item subsections); exact contracts in `docs/configuration.md` and `docs/observability.md`.
- No new runtime dependencies; no public API changes.
