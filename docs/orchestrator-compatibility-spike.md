# Orchestrator compatibility spike

Feature D is feasible as a thin adapter, but neither examined orchestrator is a drop-in match for Conflict Radar's current MCP surface. This spike deliberately stops before production implementation.

## Swarm Protocol

Swarm Protocol exposes intent-centric, file-level tools:

| Swarm field | Conflict Radar mapping | Gap |
|---|---|---|
| `intent_id` | task metadata | Conflict Radar has no intent entity |
| `claimed_by` | `agentId` | Direct mapping |
| `agent_session` | `agentId` or adapter session metadata | Conflict Radar currently uses one stable agent/session identifier |
| `files_touching` | `files` | Direct coarse-grained mapping; no symbols are supplied |
| `branch` | adapter metadata | Not represented in the claim graph |
| returned `claim_id` | adapter-owned claim/session map | Conflict Radar release is agent-based, while Swarm lifecycle calls are claim-based |

`check_conflicts` accepts only `files`, whereas Conflict Radar checks the active claim identified by `agentId`. A compatibility adapter would therefore need to persist the Swarm `claim_id` to Conflict Radar agent/session mapping and translate lifecycle calls (`heartbeat`, `release_claim`, and `complete_claim`). It could preserve Swarm's file-level contract while gaining graph reachability only when the files have already been extracted into symbols.

Recommendation: **go for a separate compatibility package**, conditional on a real Swarm Protocol adopter. Do not add aliases to the core MCP server because the lifecycle and identity semantics differ.

## Vibe Kanban

Vibe Kanban's Rust MCP server exposes `start_workspace` in global mode and `run_session_prompt` in orchestrator mode. Those are the practical interception points before an agent receives work.

A minimal integration would:

1. Infer candidate files and symbols from the issue/card title, description, repository, and workspace context.
2. Resolve the downstream session to a stable Conflict Radar `agentId`.
3. Call `claim_task`, then `check_conflicts`, before `start_workspace` or `run_session_prompt` dispatches work.
4. Return a block or warning decision to Vibe Kanban while leaving scheduling and queue ownership with Vibe Kanban.

The unresolved part is symbol inference: Vibe Kanban does not expose a structured symbol set in these tool inputs. Text-only inference would need an explicit confidence policy and must not silently turn uncertain matches into hard scheduling blocks.

Recommendation: **go for a small pre-dispatch integration spike inside Vibe Kanban**, starting advisory-only. Do not move orchestration, queue serialization, or task ownership into Conflict Radar.

## Decision

Both integrations are technically feasible, but neither warrants core-server code without a design partner. The distribution benefit is real; the schemas are not close enough to justify claiming drop-in compatibility. Feature D is complete at feasibility level, with production adapters deferred to separately scoped work.
