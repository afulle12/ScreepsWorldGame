# Shortened Deployment Build

The root-level JavaScript files directly under `default/` are the canonical
runtime modules loaded by Screeps. Only those root modules are included in the
deployment payload.

`src/` is temporary scratch storage only. It is not a parallel source tree, is
not loaded by Screeps, and must not be used as the source of a runtime change.
Edit the root module directly. The source-to-root tooling described below is a
legacy migration utility and must not overwrite root modules during normal work.

The build preserves header comment lines referencing `docs/codex.js` in root output.
These compact blocks document role dispatch and public console globals without
shipping every implementation comment.

Build tooling lives in `tools/` and is not part of the production module set.

## Project Guide

`docs/codex.js` is the concise, authoritative guide for module ownership,
runtime constraints, scheduler rules, storage behavior, and code conventions.
`docs/codex-full.js` contains the longer rationale. Neither file is required by
the runtime, and neither is included in the root deployment payload.

Runtime files refer to `docs/codex.js` in their headers. Do not add a runtime
`require()` for either documentation file.

Readable JavaScript uses one blank line after a top-level function declaration;
adjacent variable declarations stay contiguous. The generated root output keeps
the same function-only separator.

## Legacy Migration Commands

The commands in this section operate on `src/` and may write root runtime
modules. Do not use them for routine runtime edits. They are only for an
explicitly requested source migration.

Install its pinned dependencies from `tools/`:

```text
npm install
```

Validate a staged build without changing root modules:

```text
npm run build:check
```

Check readable-file formatting without changing files:

```text
npm run format:check
```

Format readable files in place:

```text
npm run format
```

Generate and write validated output into the root deployment directory:

```text
npm run build
```

To keep an intentional manual change in one root module while regenerating the
others, name it explicitly:

```text
npm run build -- --preserve-root=repairManager.js
```

The preserved module receives only whitespace-only function spacing updates.

Verify source/output contracts and measure the deployment payload:

```text
npm run verify
npm run payload
```

Run a local mock harness from the repository root:

```text
NODE_PATH=. node test/<name>_harness.js
```

The initial build protects `taskScheduler.js` because it executes persisted
commands with direct `eval()`. `screeps-profiler.js` is also protected during
the initial rollout because it inspects function names and wraps prototypes.

The build refuses output at or above 5,000,000 serialized UTF-8 bytes and
creates a rollback snapshot before writing root modules. Use
`node build-shortened.js --restore` from `tools/` to restore the latest
snapshot, or `node build-shortened.js --restore-source` to restore readable
source output.
