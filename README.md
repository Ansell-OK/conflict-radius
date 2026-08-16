# Conflict Radar

Conflict Radar detects semantic desynchronization between coding agents working in parallel. It catches graph-reachable collisions even when agents touch different files and Git reports a clean merge.

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
npm install
npm run build
node dist/extractor/extractSymbols.js ./demo-repo
node dist/src/index.js
```

Run the extractor once before agent sessions. Point every agent at the same stdio MCP server and use `claim_task` before editing, `check_conflicts` during work, and `release_task` when finished.

## Verification

```bash
npm run typecheck
npm run verify:conflicts
npm run verify:mcp
npm run conflict-radar-ci
```

The verification harness checks both a real indirect collision and a genuinely isolated claim. The CI command exits nonzero when a reachable conflict is found.

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

## HydraDB compatibility note

Conflict Radar currently depends on HydraDB's Bolt endpoint. During real extraction and CI stress tests, HydraDB intermittently surfaced a `RangeError [ERR_OUT_OF_RANGE]` from the Neo4j JavaScript driver while decoding otherwise valid query results. Retrying the same request often succeeds, but the transport failure can still interrupt graph extraction or CI cleanup. See [HydraDB issue #98](https://github.com/hydra-db/hydradb/issues/98) for the reproduction and status.

## Public pages

- [Landing page](https://conflict-radius.vercel.app/)
- [Documentation](https://conflict-radius.vercel.app/docs.html)
- [GitHub repository](https://github.com/Ansell-OK/conflict-radius)

## Scope

The v1 extractor uses a tree-sitter driver with language-specific query files. It does not resolve cross-language calls, reparse a changing graph live, or automatically resolve whose change wins.

## License

Private project repository. Licensing has not yet been selected.
