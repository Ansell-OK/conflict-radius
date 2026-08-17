# Conflict Radar

Conflict Radar detects semantic desynchronization between coding agents working in parallel. It catches graph-reachable collisions even when agents touch different files and Git reports a clean merge.

[Install `conflict-radar-mcp` from npm](https://www.npmjs.com/package/conflict-radar-mcp).

## What it does

1. An agent claims the symbols or files it expects to touch.
2. Conflict Radar checks active claims against the repository call graph in HydraDB.
3. The same query runs in strong mode at CI and blocks a desynchronized merge.

Example path:

```text
getUser -> createOrder -> submitOrder
```

## Quick start

```bash
npm install --save-dev conflict-radar-mcp
npx conflict-radar init
npx conflict-radar up
npx conflict-radar extract .
```

`init` creates an ignored `.conflict-radar/` directory containing:

- `compose.yml` for the official HydraDB container.
- `hydradb-data/` for the local store, cache, and authentication token.
- `mcp.json`, a portable MCP server configuration snippet.

`up` starts HydraDB and does not report success until a real write/read round-trip passes. It requires Docker with Compose v2. Run `npx conflict-radar doctor` at any time to repeat that check.

Point every agent at the same stdio MCP server using the generated configuration. Agents should use `claim_task` before editing, `check_conflicts` during work, and `release_task` when finished.

The installed package exposes these commands:

```text
conflict-radar             setup, Docker lifecycle, doctor, and extraction CLI
conflict-radar-mcp         stdio MCP server
conflict-radar-ci          strong CI gate
conflict-radar-admission   single-writer cross-repository admission service
```

Stop the local database with:

```bash
npx conflict-radar down
```

For cross-repository OpenAPI contracts, add `.conflict-radar.yml` to each provider/consumer repository, extract each repository with its stable repository key, then ingest its bindings:

```bash
npx conflict-radar extract .
npx conflict-radar-admission
```

The admission coordinator owns only cross-repository change-set ordering. Mergify or Graphite still owns the merge. Configure CI with `CONFLICT_RADAR_ADMISSION_URL` and a `CONFLICT_RADAR_CHANGE_SET` JSON payload to enable the cross-repository gate.

## Verification

```bash
npm run typecheck
npm run verify:typescript
npm run verify:verification
npm run verify:cross-repo
npm run verify:admission
npm run verify:admission-http
npm run verify:conflicts
npm run verify:mcp
npm run conflict-radar-ci
```

## Building from source

```bash
git clone https://github.com/Ansell-OK/conflict-radius.git
cd conflict-radius
npm install
npm run build
node dist/src/cli.js init
node dist/src/cli.js up
```

The source workflow uses the same generated Compose configuration and doctor probe as the installed package.

The verification harness checks both a real indirect collision and a genuinely isolated claim. The CI command exits nonzero when a reachable conflict is found.

The extractor currently supports JavaScript, TypeScript, and TSX through language-specific tree-sitter queries. `verify:typescript` round-trips typed function declarations, arrow functions, signature snapshots, and a cross-file call edge through a real HydraDB node.

Claims can include a `worktreePath` when parallel agents use Git worktrees. Conflict Radar captures the signature from that checkout at claim time and reparses the same checkout during verification.

## Reachability verification

Reachability narrows the candidate set, then Conflict Radar reparses the relevant file and compares its live signature with the snapshot captured by `claim_task`. Findings are reported as:

- `reachable-unverified`: reachable, but no signature change was verified; advisory only.
- `verified-compatible`: a changed signature was classified as compatible; advisory only.
- `verified-breaking`: a changed signature was classified as breaking; this is the only tier that blocks CI.

Common changes are handled by deterministic parameter and return-type heuristics. Ambiguous changes can use an optional OpenAI Responses API fallback when `OPENAI_API_KEY` and `CONFLICT_RADAR_LLM_MODEL` are configured.

Run the deliberate three-tier verification fixture with:

```bash
npm run verify:verification
```

## Merge queues

The `semantic-desync` CI check is registered with the repository's active Mergify merge queue. Live PR tests confirmed that the queue admits a PR only after the check passes and then merges it successfully. Graphite remains an untested configuration path. See [merge queue integration](./docs/merge-queue-integration.md).

Conflict Radar deliberately does not implement its own merge queue. Mergify provides serialization and queue ownership; Conflict Radar supplies the semantic CI signal.

## Orchestrator compatibility

A timeboxed feasibility spike found that Swarm Protocol and Vibe Kanban can integrate through thin adapters, but neither is schema-compatible enough to add aliases to the core server. See [orchestrator compatibility spike](./docs/orchestrator-compatibility-spike.md) for the exact mappings and recommended interception points.

## HydraDB compatibility note

Conflict Radar currently depends on HydraDB's Bolt endpoint. During real extraction and CI stress tests, HydraDB intermittently surfaced a `RangeError [ERR_OUT_OF_RANGE]` from the Neo4j JavaScript driver while decoding otherwise valid query results. Retrying the same request often succeeds, but the transport failure can still interrupt graph extraction or CI cleanup. See [HydraDB issue #98](https://github.com/hydra-db/hydradb/issues/98) for the reproduction and status.

The client retries known transient decoder failures, but retries are mitigation rather than atomicity. HydraDB does not currently expose a public atomic transaction or compare-and-set primitive, so deploy exactly one admission-coordinator process for a shared environment. Mergify or Graphite still owns the actual merge.

## Stress-tested scenarios

The implementation has been checked against parallel Git worktrees and separate provider/consumer repositories, not only the bundled demo. The latest stress environment detected a breaking path across different source files (`plan -> admit -> evaluate`), detected an OpenAPI break across repositories (`admit -> operation:admitJob -> submitJob`), and admitted exactly one side in all 10 concurrent admission rounds.

The published `0.1.0` package was also installed from the public npm registry into a fresh warehouse-fulfillment repository. Its generated Compose environment extracted `4` symbols and `3` call edges. Two worktrees edited only `src/routing.ts` and `src/fulfillment.ts`; Git merged them without a structural conflict, while Conflict Radar reported `buildPickRoute -> planFulfillment` as `verified-breaking`. The merged TypeScript build then confirmed the stale two-argument call against the new three-argument signature.

Run that admission race after creating the sibling stress repositories with:

```bash
npm run build
npm run stress:os-automations
```

## Public pages

- [Landing page](https://conflict-radius.vercel.app/)
- [Documentation](https://conflict-radius.vercel.app/docs.html)
- [npm package](https://www.npmjs.com/package/conflict-radar-mcp)
- [GitHub repository](https://github.com/Ansell-OK/conflict-radius)

## Scope

The extractor uses a tree-sitter driver with JavaScript, TypeScript, and TSX query files. Conflict verification reparses the relevant live file, but the graph itself is not continuously re-extracted. Cross-repository detection currently covers shared OpenAPI operations and schemas. Cross-language calls, non-OpenAPI contract formats, multi-process admission without an external transactional store, and automatic conflict resolution remain out of scope.

## License

The package is published as `UNLICENSED`; an open-source license has not yet been selected.
