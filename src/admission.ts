import { HydraClient } from "./hydra/client.js";
import { stableId } from "./ids.js";
import { classifyContractChange } from "./contracts/openapi.js";

export interface ChangeImpact {
  coordinate: string;
  memberKey: string;
  memberKind: "operation" | "schema";
  role: "provider" | "consumer";
  impactKind: "contract-delta" | "symbol-use";
  beforeSnapshot: string | null;
  afterSnapshot: string | null;
}

export interface ChangeSetInput {
  provider: string;
  repositoryKey: string;
  externalChangeId: string;
  headSha: string;
  baseSha: string;
  providerCreatedAt: string;
  impacts: ChangeImpact[];
}

export interface AdmissionResult {
  changeSetId: number;
  status: "admitted" | "blocked";
  blockers: Array<{ repositoryKey: string; externalChangeId: string; memberKey: string }>;
}

interface StoredImpact extends ChangeImpact {
  repositoryKey: string;
  externalChangeId: string;
  changeSetId: number;
  status: string;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Expected string ${field}, received ${String(value)}`);
  return value;
}

function numberValue(value: unknown, field: string): number {
  if (typeof value !== "number") throw new Error(`Expected number ${field}, received ${String(value)}`);
  return value;
}

function impactsConflict(candidate: ChangeImpact, other: StoredImpact): boolean {
  if (candidate.coordinate !== other.coordinate || candidate.memberKey !== other.memberKey) return false;
  if (candidate.role === "consumer" && other.role === "consumer") return false;
  if (candidate.role === "provider" && other.role === "provider") return candidate.afterSnapshot !== other.afterSnapshot;
  const provider = candidate.role === "provider" ? candidate : other;
  const consumer = candidate.role === "consumer" ? candidate : other;
  return classifyContractChange(consumer.afterSnapshot, provider.afterSnapshot, candidate.memberKind) === "breaking";
}

export class AdmissionCoordinator {
  private readonly lanes = new Map<string, Promise<void>>();

  constructor(private readonly client: HydraClient) {}

  async admit(input: ChangeSetInput): Promise<AdmissionResult> {
    if (input.impacts.length === 0) throw new Error("At least one contract impact is required");
    return this.serialized("global", () => this.admitSerialized(input));
  }

  async finalize(provider: string, repositoryKey: string, externalChangeId: string, status: "merged" | "closed"): Promise<void> {
    const changeSetId = stableId("ChangeSet", `${provider}:${repositoryKey}:${externalChangeId}`);
    await this.client.query("MATCH (cs:ChangeSet {id: $changeSetId}) SET cs.status = $status, cs.updated_at = $updatedAt", { changeSetId, status, updatedAt: new Date().toISOString() });
  }

  private async serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.lanes.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.lanes.get(key) === tail) this.lanes.delete(key);
    }
  }

  private async admitSerialized(input: ChangeSetInput): Promise<AdmissionResult> {
    const changeSetId = stableId("ChangeSet", `${input.provider}:${input.repositoryKey}:${input.externalChangeId}`);
    const now = new Date().toISOString();
    const admissionKey = `${input.providerCreatedAt}:${input.repositoryKey}:${input.externalChangeId}`;
    await this.client.query(
      "UNWIND $rows AS row MERGE (cs {id: row.id}) SET cs:ChangeSet, cs.provider = row.provider, cs.repository_key = row.repositoryKey, cs.external_change_id = row.externalChangeId, cs.head_sha = row.headSha, cs.base_sha = row.baseSha, cs.status = row.status, cs.admission_key = row.admissionKey, cs.provider_created_at = row.providerCreatedAt, cs.updated_at = row.updatedAt",
      { rows: [{ id: changeSetId, provider: input.provider, repositoryKey: input.repositoryKey, externalChangeId: input.externalChangeId, headSha: input.headSha, baseSha: input.baseSha, status: "pending", admissionKey, providerCreatedAt: input.providerCreatedAt, updatedAt: now }] },
    );

    for (const impact of input.impacts) {
      const memberId = stableId("ContractMember", `${impact.coordinate}:${impact.memberKey}`);
      const changeMemberId = stableId("ChangeMember", `${changeSetId}:${memberId}`);
      const compatibility = classifyContractChange(impact.beforeSnapshot, impact.afterSnapshot, impact.memberKind);
      await this.client.query(
        "UNWIND $rows AS row MERGE (cm {id: row.id}) SET cm:ChangeMember, cm.role = row.role, cm.impact_kind = row.impactKind, cm.member_kind = row.memberKind, cm.contract_coordinate = row.coordinate, cm.member_key = row.memberKey, cm.before_snapshot = row.beforeSnapshot, cm.after_snapshot = row.afterSnapshot, cm.compatibility = row.compatibility",
        { rows: [{ id: changeMemberId, role: impact.role, impactKind: impact.impactKind, memberKind: impact.memberKind, coordinate: impact.coordinate, memberKey: impact.memberKey, beforeSnapshot: impact.beforeSnapshot ?? "", afterSnapshot: impact.afterSnapshot ?? "", compatibility }] },
      );
      await this.client.query("MERGE (cs:ChangeSet {id: $changeSetId})-[edge:PROPOSES {id: $edgeId}]->(cm:ChangeMember {id: $changeMemberId})", { changeSetId, changeMemberId, edgeId: stableId("Relationship", `PROPOSES:${changeSetId}:${changeMemberId}`) });
      await this.client.query("MERGE (cm:ChangeMember {id: $changeMemberId})-[edge:CHANGES {id: $edgeId}]->(member:ContractMember {id: $memberId})", { changeMemberId, memberId, edgeId: stableId("Relationship", `CHANGES:${changeMemberId}:${memberId}`) });
    }

    const others: StoredImpact[] = [];
    for (const impact of input.impacts) {
      const memberId = stableId("ContractMember", `${impact.coordinate}:${impact.memberKey}`);
      for (const status of ["pending", "admitted"] as const) {
        const rows = await this.client.query(
          "MATCH (other:ChangeSet {status: $status})-[:PROPOSES]->(change:ChangeMember)-[:CHANGES]->(member:ContractMember {id: $memberId}) WHERE other.id <> $changeSetId RETURN other.id AS changeSetId, other.repository_key AS repositoryKey, other.external_change_id AS externalChangeId, other.status AS status, change.role AS role, change.impact_kind AS impactKind, change.member_kind AS memberKind, change.contract_coordinate AS coordinate, change.member_key AS memberKey, change.before_snapshot AS beforeSnapshot, change.after_snapshot AS afterSnapshot",
          { status, memberId, changeSetId },
          "strong",
        );
        for (const row of rows) {
          others.push({
            changeSetId: numberValue(row.changeSetId, "change set id"),
            repositoryKey: stringValue(row.repositoryKey, "repository key"),
            externalChangeId: stringValue(row.externalChangeId, "external change id"),
            status: stringValue(row.status, "status"),
            role: stringValue(row.role, "role") as ChangeImpact["role"],
            impactKind: stringValue(row.impactKind, "impact kind") as ChangeImpact["impactKind"],
            memberKind: stringValue(row.memberKind, "member kind") as ChangeImpact["memberKind"],
            coordinate: stringValue(row.coordinate, "coordinate"),
            memberKey: stringValue(row.memberKey, "member key"),
            beforeSnapshot: typeof row.beforeSnapshot === "string" && row.beforeSnapshot ? row.beforeSnapshot : null,
            afterSnapshot: typeof row.afterSnapshot === "string" && row.afterSnapshot ? row.afterSnapshot : null,
          });
        }
      }
    }

    const blockers = others.flatMap((other) => input.impacts.some((impact) => impactsConflict(impact, other))
      ? [{ repositoryKey: other.repositoryKey, externalChangeId: other.externalChangeId, memberKey: other.memberKey }]
      : []);
    const status: AdmissionResult["status"] = blockers.length > 0 ? "blocked" : "admitted";
    await this.client.query("MATCH (cs:ChangeSet {id: $changeSetId}) SET cs.status = $status, cs.updated_at = $updatedAt", { changeSetId, status, updatedAt: new Date().toISOString() });
    return { changeSetId, status, blockers };
  }
}
