import { randomUUID } from "node:crypto";
import { HydraClient, ConsistencyMode } from "./hydra/client.js";
import { stableId } from "./ids.js";
import path from "node:path";
import { callSiteFromFile, classifySignatureChange, parseSignature, serializeSignature, signatureFromFile, SignatureSnapshot } from "./signatures.js";
import { classifyContractChange, readOpenApiMembers } from "./contracts/openapi.js";

export interface ClaimInput {
  agentId: string;
  taskDescription: string;
  repositoryKey?: string;
  worktreePath?: string;
  symbols?: string[];
  files?: string[];
  captureSnapshot?: boolean;
}

export interface Conflict {
  severity: "reachable-unverified" | "verified-breaking" | "verified-compatible";
  reachability: "direct" | "indirect";
  conflictingAgent: string;
  theirTask: string;
  path: string[];
  explanation: string;
  scope?: "same-repo" | "cross-repo";
  conflictingRepository?: string;
  contract?: string;
  member?: string;
}

interface ActiveSymbol {
  agentId: string;
  task: string;
  symbolId: number;
  symbolName: string;
  signatureSnapshot: string | null;
  filePath: string;
  repoPath: string;
  repositoryKey: string;
}

function numberValue(value: unknown, field: string): number {
  if (typeof value !== "number") throw new Error(`Expected numeric ${field}, received ${String(value)}`);
  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Expected string ${field}, received ${String(value)}`);
  return value;
}

function cypherString(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

export class ConflictRadar {
  constructor(private readonly client: HydraClient) {}

  async claimTask(input: ClaimInput): Promise<{ claimedSymbols: string[]; unresolvedSymbols: string[] }> {
    const now = new Date().toISOString();
    const agentNodeId = stableId("Agent", input.agentId);
    const claimNodeId = stableId("Claim", `${input.agentId}:${now}:${randomUUID()}`);

    await this.client.query(
      "UNWIND $rows AS row MERGE (a {id: row.id}) SET a:Agent, a.agent_id = row.agentId, a.session_id = row.sessionId, a.started_at = row.startedAt",
      { rows: [{ id: agentNodeId, agentId: input.agentId, sessionId: input.agentId, startedAt: now }] },
    );
    await this.client.query(
      "MERGE (a:Agent {id: $agentNodeId})-[:HOLDS]->(c:Claim {id: $claimNodeId})",
      { agentNodeId, claimNodeId },
    );
    await this.client.query(
      "MATCH (c:Claim {id: $claimNodeId}) SET c.claimed_at = $now, c.active = true, c.task_description = $description, c.worktree_path = $worktreePath",
      { claimNodeId, now, description: input.taskDescription, worktreePath: input.worktreePath ?? "" },
    );

    const resolved: Array<{ id: number; name: string; filePath: string; repoPath: string; repositoryKey: string; signatureSnapshot: string | null }> = [];
    const unresolved: string[] = [];
    for (const symbolName of input.symbols ?? []) {
      const matches = await this.client.query(
        input.repositoryKey
          ? "MATCH (s:Symbol {name: $name, repository_key: $repositoryKey}) MATCH (s)-[:DEFINED_IN]->(f:File)-[:PART_OF]->(r:Repo) RETURN s.id AS id, s.name AS name, f.path AS filePath, r.path AS repoPath, r.repository_key AS repositoryKey, s.signature_snapshot AS signatureSnapshot"
          : "MATCH (s:Symbol {name: $name}) MATCH (s)-[:DEFINED_IN]->(f:File)-[:PART_OF]->(r:Repo) RETURN s.id AS id, s.name AS name, f.path AS filePath, r.path AS repoPath, r.repository_key AS repositoryKey, s.signature_snapshot AS signatureSnapshot",
        { name: symbolName, repositoryKey: input.repositoryKey },
      );
      const keyed = matches.filter((match) => typeof match.repositoryKey === "string");
      const candidates = input.repositoryKey || keyed.length === 0 ? matches : keyed;
      const repositoryKeys = new Set(candidates.map((match) => typeof match.repositoryKey === "string" ? match.repositoryKey : `legacy:${String(match.repoPath)}`));
      if (!input.repositoryKey && repositoryKeys.size > 1) {
        throw new Error(`Symbol ${symbolName} exists in multiple repositories; claim_task requires repositoryKey`);
      }
      if (candidates.length === 0) unresolved.push(symbolName);
        else for (const match of candidates) {
          const repoPath = stringValue(match.repoPath, "repo path");
          resolved.push({ id: numberValue(match.id, "symbol id"), name: stringValue(match.name, "symbol name"), filePath: stringValue(match.filePath, "file path"), repoPath, repositoryKey: typeof match.repositoryKey === "string" ? match.repositoryKey : `legacy:${repoPath}`, signatureSnapshot: typeof match.signatureSnapshot === "string" ? match.signatureSnapshot : null });
        }
    }

    for (const symbol of resolved) {
      if (input.captureSnapshot !== false) {
        const liveSignature = await signatureFromFile(path.join(input.worktreePath ?? symbol.repoPath, symbol.filePath), symbol.name);
        await this.client.query(
          "MATCH (s:Symbol {id: $symbolId}) SET s.signature_snapshot = $snapshot",
          { symbolId: symbol.id, snapshot: serializeSignature(liveSignature) },
        );
      }
      await this.client.query(
        "MERGE (c:Claim {id: $claimNodeId})-[:TOUCHES]->(s:Symbol {id: $symbolId})",
        { claimNodeId, symbolId: symbol.id },
      );
    }

    return { claimedSymbols: resolved.map((symbol) => symbol.name), unresolvedSymbols: unresolved };
  }

  async checkConflicts(agentId: string, mode: ConsistencyMode = "causal"): Promise<{ conflicts: Conflict[]; checkedAt: string }> {
    const conflicts: Conflict[] = [];

    const activeRows = await this.client.query(
      "MATCH (a:Agent)-[:HOLDS]->(c:Claim {active: true})-[:TOUCHES]->(s:Symbol)-[:DEFINED_IN]->(f:File)-[:PART_OF]->(r:Repo) RETURN a.agent_id AS agentId, c.task_description AS task, c.worktree_path AS worktreePath, s.id AS symbolId, s.name AS symbolName, s.signature_snapshot AS signatureSnapshot, f.path AS filePath, r.path AS repoPath, r.repository_key AS repositoryKey",
      {},
      mode,
    );
    const active: ActiveSymbol[] = activeRows.map((row) => ({
      agentId: stringValue(row.agentId, "agent id"),
      task: stringValue(row.task, "task"),
      symbolId: numberValue(row.symbolId, "symbol id"),
      symbolName: stringValue(row.symbolName, "symbol name"),
      signatureSnapshot: typeof row.signatureSnapshot === "string" ? row.signatureSnapshot : null,
      filePath: stringValue(row.filePath, "file path"),
      repoPath: typeof row.worktreePath === "string" && row.worktreePath ? row.worktreePath : stringValue(row.repoPath, "repo path"),
      repositoryKey: typeof row.repositoryKey === "string" ? row.repositoryKey : `legacy:${String(row.repoPath)}`,
    }));
    const mine = active.filter((row) => row.agentId === agentId);
    const others = active.filter((row) => row.agentId !== agentId);

    for (const otherAgent of new Set(others.map((row) => row.agentId))) {
      const theirSymbols = others.filter((row) => row.agentId === otherAgent);
      const crossesRepository = mine.some((mySymbol) => theirSymbols.some((theirSymbol) => mySymbol.repositoryKey !== theirSymbol.repositoryKey));
      if (crossesRepository) {
        conflicts.push(...await this.crossRepositoryConflicts(agentId, otherAgent, mode));
        continue;
      }
      const theirIds = new Set(theirSymbols.map((row) => row.symbolId));
      const shared = mine.find((row) => theirIds.has(row.symbolId));
      if (shared) {
        const verification = await this.verifyCandidate(mine.filter((row) => row.symbolId === shared.symbolId), theirSymbols.filter((row) => row.symbolId === shared.symbolId));
        conflicts.push({
          severity: verification.severity,
          reachability: "direct",
          conflictingAgent: otherAgent,
          theirTask: theirSymbols[0]?.task ?? "",
          path: [shared.symbolName],
          explanation: `Both agents currently claim ${shared.symbolName}. ${verification.explanation}`,
          scope: "same-repo",
        });
        continue;
      }
      const sourceValues = `[${mine.map((row) => cypherString(row.symbolName)).join(", ")}]`;
      const targetValues = `[${theirSymbols.map((row) => cypherString(row.symbolName)).join(", ")}]`;
      // The deployed HydraDB MSpaths procedure requires string sourceValues;
      // numeric Symbol ids are accepted syntactically but return no paths.
      const paths = await this.client.query(
        `CALL algo.MSpaths({sourceLabel: 'Symbol', sourceProperty: 'name', sourceValues: ${sourceValues}, targetLabel: 'Symbol', targetProperty: 'name', targetValues: ${targetValues}, pairwise: false, relTypes: ['CALLS'], relDirection: 'both', maxLen: 2, pathCount: 20, resultLimit: 200}) YIELD path RETURN path`,
        {},
        mode,
      );
      if (paths.length === 0) continue;

      const rawPath = paths[0]?.path;
      void rawPath;
      const edgeRows = await this.client.query("MATCH (from:Symbol)-[:CALLS]->(to:Symbol) RETURN from.name AS from, to.name AS to", {}, mode);
      const edges = edgeRows.flatMap((row) => typeof row.from === "string" && typeof row.to === "string" ? [{ from: row.from, to: row.to }] : []);
      const targets = new Set(theirSymbols.map((row) => row.symbolName));
      const queue = mine.map((row) => ({ name: row.symbolName, path: [row.symbolName] }));
      const visited = new Set(queue.map((item) => item.name));
      let pathNames: string[] = [];
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (targets.has(current.name)) { pathNames = current.path; break; }
        for (const edge of edges) {
          if (edge.from !== current.name && edge.to !== current.name) continue;
          const next = edge.from === current.name ? edge.to : edge.from;
          if (visited.has(next) || current.path.length >= 3) continue;
          visited.add(next);
          queue.push({ name: next, path: [...current.path, next] });
        }
      }
      const fallback = [mine[0]?.symbolName, theirSymbols[0]?.symbolName].filter((name): name is string => Boolean(name));
      const displayPath = pathNames.length >= 2 ? pathNames : fallback;
      const verification = await this.verifyCandidate(mine, theirSymbols);
      conflicts.push({
        severity: verification.severity,
        reachability: "indirect",
        conflictingAgent: otherAgent,
        theirTask: theirSymbols[0]?.task ?? "",
        path: displayPath,
        explanation: `${displayPath.join(" -> ")} is connected through the call graph within two hops. ${verification.explanation}`,
        scope: "same-repo",
      });
    }

    return { conflicts, checkedAt: new Date().toISOString() };
  }

  private async crossRepositoryConflicts(agentId: string, otherAgent: string, mode: ConsistencyMode): Promise<Conflict[]> {
    const forward = await this.client.query(
      "MATCH (me:Agent {agent_id: $agentId})-[:HOLDS]->(mc:Claim {active: true})-[:TOUCHES]->(provider:Symbol)-[:PUBLISHES]->(member:ContractMember) MATCH (other:Agent {agent_id: $otherAgent})-[:HOLDS]->(oc:Claim {active: true})-[:TOUCHES]->(consumer:Symbol)-[use:CONSUMES]->(member) MATCH (provider)-[:DEFINED_IN]->(pf:File)-[:PART_OF]->(pr:Repo) MATCH (consumer)-[:DEFINED_IN]->(cf:File)-[:PART_OF]->(cr:Repo) MATCH (contract:Contract)-[:HAS_MEMBER]->(member) RETURN oc.task_description AS theirTask, provider.name AS providerSymbol, consumer.name AS consumerSymbol, cr.repository_key AS conflictingRepository, pr.path AS providerRepoPath, mc.worktree_path AS providerWorktreePath, contract.provider_document_path AS documentPath, contract.coordinate AS contractCoordinate, member.member_key AS memberKey, member.member_kind AS memberKind, use.expected_snapshot AS consumerSnapshot",
      { agentId, otherAgent },
      mode,
    );
    const inverse = await this.client.query(
      "MATCH (me:Agent {agent_id: $agentId})-[:HOLDS]->(mc:Claim {active: true})-[:TOUCHES]->(consumer:Symbol)-[use:CONSUMES]->(member:ContractMember) MATCH (other:Agent {agent_id: $otherAgent})-[:HOLDS]->(oc:Claim {active: true})-[:TOUCHES]->(provider:Symbol)-[:PUBLISHES]->(member) MATCH (provider)-[:DEFINED_IN]->(pf:File)-[:PART_OF]->(pr:Repo) MATCH (consumer)-[:DEFINED_IN]->(cf:File)-[:PART_OF]->(cr:Repo) MATCH (contract:Contract)-[:HAS_MEMBER]->(member) RETURN oc.task_description AS theirTask, provider.name AS providerSymbol, consumer.name AS consumerSymbol, pr.repository_key AS conflictingRepository, pr.path AS providerRepoPath, oc.worktree_path AS providerWorktreePath, contract.provider_document_path AS documentPath, contract.coordinate AS contractCoordinate, member.member_key AS memberKey, member.member_kind AS memberKind, use.expected_snapshot AS consumerSnapshot",
      { agentId, otherAgent },
      mode,
    );
    const findings: Conflict[] = [];
    for (const row of [...forward, ...inverse]) {
      const memberKey = stringValue(row.memberKey, "contract member key");
      const memberKind = stringValue(row.memberKind, "contract member kind") as "operation" | "schema";
      const providerRoot = typeof row.providerWorktreePath === "string" && row.providerWorktreePath ? row.providerWorktreePath : stringValue(row.providerRepoPath, "provider repo path");
      const members = await readOpenApiMembers(path.join(providerRoot, stringValue(row.documentPath, "provider document path")));
      const live = members.members.find((member) => member.memberKey === memberKey)?.snapshot ?? null;
      const expected = typeof row.consumerSnapshot === "string" ? row.consumerSnapshot : null;
      const verdict = classifyContractChange(expected, live, memberKind);
      const severity: Conflict["severity"] = verdict === "breaking"
        ? "verified-breaking"
        : verdict === "compatible"
          ? "verified-compatible"
          : "reachable-unverified";
      const providerSymbol = stringValue(row.providerSymbol, "provider symbol");
      const consumerSymbol = stringValue(row.consumerSymbol, "consumer symbol");
      findings.push({
        severity,
        reachability: "indirect",
        conflictingAgent: otherAgent,
        theirTask: stringValue(row.theirTask, "task"),
        path: [providerSymbol, memberKey, consumerSymbol],
        explanation: verdict === "breaking"
          ? `${memberKey} changed incompatibly with the consumer's pinned OpenAPI snapshot.`
          : verdict === "compatible"
            ? `${memberKey} changed compatibly with the consumer's pinned OpenAPI snapshot.`
            : `${memberKey} is shared across repositories, but its live provider snapshot is unchanged or could not be verified.`,
        scope: "cross-repo",
        conflictingRepository: stringValue(row.conflictingRepository, "conflicting repository"),
        contract: stringValue(row.contractCoordinate, "contract coordinate"),
        member: memberKey,
      });
    }
    return findings;
  }

  private async verifyCandidate(mine: ActiveSymbol[], theirs: ActiveSymbol[]): Promise<{ severity: Conflict["severity"]; explanation: string }> {
    const changed: Array<{ before: SignatureSnapshot; after: SignatureSnapshot; symbol: ActiveSymbol }> = [];
    for (const symbol of [...mine, ...theirs]) {
      const before = parseSignature(symbol.signatureSnapshot);
      if (!before) continue;
      const after = await signatureFromFile(path.join(symbol.repoPath, symbol.filePath), symbol.symbolName);
      if (after && serializeSignature(after) !== serializeSignature(before)) changed.push({ before, after, symbol });
    }
    if (changed.length === 0) return { severity: "reachable-unverified", explanation: "No claimed signature changed; this remains advisory." };

    const verdicts = changed.map(({ before, after }) => classifySignatureChange(before, after));
    if (verdicts.includes("breaking")) return { severity: "verified-breaking", explanation: "A required parameter, parameter contract, or return type changed." };
    if (verdicts.every((verdict) => verdict === "compatible")) return { severity: "verified-compatible", explanation: "The signature change is compatible under the deterministic heuristic." };

    const ambiguous = changed[0]!;
    const callSite = await callSiteFromFile(path.join(theirs[0]!.repoPath, theirs[0]!.filePath), mine[0]!.symbolName);
    const llmVerdict = await this.llmFallback(ambiguous.before, ambiguous.after, callSite);
    if (llmVerdict === "breaking") return { severity: "verified-breaking", explanation: "The configured verification model classified the ambiguous signature change as breaking." };
    if (llmVerdict === "compatible") return { severity: "verified-compatible", explanation: "The configured verification model classified the ambiguous signature change as compatible." };
    return { severity: "reachable-unverified", explanation: "The signature changed, but no deterministic or configured model verification was available." };
  }

  private async llmFallback(before: SignatureSnapshot, after: SignatureSnapshot, callSite: string | null): Promise<"breaking" | "compatible" | null> {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.CONFLICT_RADAR_LLM_MODEL;
    if (!apiKey || !model) return null;
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        input: `Classify whether this signature change breaks the shown call site. Reply with exactly BREAKING or COMPATIBLE.\nBefore: ${JSON.stringify(before)}\nAfter: ${JSON.stringify(after)}\nCall site: ${callSite ?? "unavailable"}`,
      }),
    });
    if (!response.ok) return null;
    const payload = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    const text = (payload.output_text ?? payload.output?.flatMap((item) => item.content ?? []).map((item) => item.text ?? "").join(" ") ?? "").toUpperCase();
    if (text.includes("BREAKING")) return "breaking";
    if (text.includes("COMPATIBLE")) return "compatible";
    return null;
  }

  async releaseTask(agentId: string): Promise<{ released: number }> {
    const active = await this.client.query(
      "MATCH (a:Agent {agent_id: $agentId})-[:HOLDS]->(c:Claim {active: true}) RETURN c.id AS claimId",
      { agentId },
    );
    await this.client.query(
      "MATCH (a:Agent {agent_id: $agentId})-[:HOLDS]->(c:Claim {active: true}) SET c.active = false, c.released_at = $now",
      { agentId, now: new Date().toISOString() },
    );
    return { released: active.length };
  }
}
