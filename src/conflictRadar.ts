import { randomUUID } from "node:crypto";
import { HydraClient, ConsistencyMode } from "./hydra/client.js";
import { stableId } from "./ids.js";

export interface ClaimInput {
  agentId: string;
  taskDescription: string;
  symbols?: string[];
  files?: string[];
}

export interface Conflict {
  severity: "direct" | "indirect";
  conflictingAgent: string;
  theirTask: string;
  path: string[];
  explanation: string;
}

interface ActiveSymbol {
  agentId: string;
  task: string;
  symbolId: number;
  symbolName: string;
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
      "MATCH (c:Claim {id: $claimNodeId}) SET c.claimed_at = $now, c.active = true, c.task_description = $description",
      { claimNodeId, now, description: input.taskDescription },
    );

    const resolved: Array<{ id: number; name: string }> = [];
    const unresolved: string[] = [];
    for (const symbolName of input.symbols ?? []) {
      const matches = await this.client.query(
        "MATCH (s:Symbol {name: $name}) RETURN s.id AS id, s.name AS name",
        { name: symbolName },
      );
      if (matches.length === 0) unresolved.push(symbolName);
      else for (const match of matches) resolved.push({ id: numberValue(match.id, "symbol id"), name: stringValue(match.name, "symbol name") });
    }

    for (const symbol of resolved) {
      await this.client.query(
        "MERGE (c:Claim {id: $claimNodeId})-[:TOUCHES]->(s:Symbol {id: $symbolId})",
        { claimNodeId, symbolId: symbol.id },
      );
    }

    return { claimedSymbols: resolved.map((symbol) => symbol.name), unresolvedSymbols: unresolved };
  }

  async checkConflicts(agentId: string, mode: ConsistencyMode = "causal"): Promise<{ conflicts: Conflict[]; checkedAt: string }> {
    const directRows = await this.client.query(
      "MATCH (me:Agent {agent_id: $agentId})-[:HOLDS]->(mc:Claim {active: true})-[:TOUCHES]->(s:Symbol) MATCH (other:Agent)-[:HOLDS]->(oc:Claim {active: true})-[:TOUCHES]->(s) WHERE other.agent_id <> $agentId RETURN other.agent_id AS conflictingAgent, oc.task_description AS theirTask, s.name AS sharedSymbol",
      { agentId },
      mode,
    );
    const conflicts: Conflict[] = directRows.map((row) => {
      const symbol = stringValue(row.sharedSymbol, "shared symbol");
      return {
        severity: "direct",
        conflictingAgent: stringValue(row.conflictingAgent, "conflicting agent"),
        theirTask: stringValue(row.theirTask, "task"),
        path: [symbol],
        explanation: `Both agents currently claim ${symbol}.`,
      };
    });

    const activeRows = await this.client.query(
      "MATCH (a:Agent)-[:HOLDS]->(c:Claim {active: true})-[:TOUCHES]->(s:Symbol) RETURN a.agent_id AS agentId, c.task_description AS task, s.id AS symbolId, s.name AS symbolName",
      {},
      mode,
    );
    const active: ActiveSymbol[] = activeRows.map((row) => ({
      agentId: stringValue(row.agentId, "agent id"),
      task: stringValue(row.task, "task"),
      symbolId: numberValue(row.symbolId, "symbol id"),
      symbolName: stringValue(row.symbolName, "symbol name"),
    }));
    const mine = active.filter((row) => row.agentId === agentId);
    const others = active.filter((row) => row.agentId !== agentId);

    for (const otherAgent of new Set(others.map((row) => row.agentId))) {
      if (conflicts.some((conflict) => conflict.conflictingAgent === otherAgent)) continue;
      const theirSymbols = others.filter((row) => row.agentId === otherAgent);
      const sourceValues = `[${mine.map((row) => cypherString(row.symbolName)).join(", ")}]`;
      const targetValues = `[${theirSymbols.map((row) => cypherString(row.symbolName)).join(", ")}]`;
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
      conflicts.push({
        severity: "indirect",
        conflictingAgent: otherAgent,
        theirTask: theirSymbols[0]?.task ?? "",
        path: displayPath,
        explanation: `${displayPath.join(" -> ")} is connected through the call graph within two hops.`,
      });
    }

    return { conflicts, checkedAt: new Date().toISOString() };
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
