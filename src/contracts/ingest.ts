import path from "node:path";
import { HydraClient } from "../hydra/client.js";
import { stableId } from "../ids.js";
import { ConflictRadarConfig } from "./config.js";
import { readOpenApiMembers } from "./openapi.js";

function bindingParts(binding: string): { filePath: string; symbolName: string } {
  const separator = binding.lastIndexOf("::");
  if (separator < 1) throw new Error(`Invalid symbol binding ${binding}; expected relative/path.ts::symbolName`);
  return { filePath: binding.slice(0, separator).replaceAll("\\", "/"), symbolName: binding.slice(separator + 2) };
}

export async function ingestContracts(client: HydraClient, repoRoot: string, config: ConflictRadarConfig, sourceSha = "working-tree"): Promise<{ contracts: number; members: number; bindings: number }> {
  const repoId = stableId("Repo", config.repository.key);
  let memberCount = 0;
  let bindingCount = 0;
  for (const contractConfig of config.contracts) {
    const contractId = stableId("Contract", contractConfig.coordinate);
    const parsed = await readOpenApiMembers(path.resolve(repoRoot, contractConfig.document));
    const revisionId = stableId("ContractRevision", `${contractConfig.coordinate}:${parsed.documentDigest}`);
    await client.query("UNWIND $rows AS row MERGE (c {id: row.id}) SET c:Contract, c.coordinate = row.coordinate, c.kind = row.kind", { rows: [{ id: contractId, coordinate: contractConfig.coordinate, kind: "openapi" }] });
    if (contractConfig.role === "provider") {
      await client.query("MATCH (c:Contract {id: $contractId}) SET c.provider_repository_key = $repositoryKey, c.provider_document_path = $documentPath", { contractId, repositoryKey: config.repository.key, documentPath: contractConfig.document.replaceAll("\\", "/") });
    }
    await client.query("UNWIND $rows AS row MERGE (revision {id: row.id}) SET revision:ContractRevision, revision.contract_coordinate = row.coordinate, revision.content_digest = row.digest, revision.document_snapshot = row.snapshot, revision.source_sha = row.sourceSha, revision.created_at = row.createdAt", { rows: [{ id: revisionId, coordinate: contractConfig.coordinate, digest: parsed.documentDigest, snapshot: parsed.documentSnapshot, sourceSha, createdAt: new Date().toISOString() }] });
    await client.query("MERGE (c:Contract {id: $contractId})-[edge:HAS_REVISION {id: $edgeId}]->(revision:ContractRevision {id: $revisionId})", { contractId, revisionId, edgeId: stableId("Relationship", `HAS_REVISION:${contractId}:${revisionId}`) });
    const role = contractConfig.role === "provider" ? "DECLARES" : "DEPENDS_ON";
    await client.query(`MERGE (r:Repo {id: $repoId})-[edge:${role} {id: $edgeId}]->(c:Contract {id: $contractId})`, { repoId, contractId, edgeId: stableId("Relationship", `${role}:${repoId}:${contractId}`) });

    const byKey = new Map(parsed.members.map((member) => [member.memberKey, member]));
    for (const member of parsed.members) {
      const memberId = stableId("ContractMember", `${contractConfig.coordinate}:${member.memberKey}`);
      if (contractConfig.role === "provider") {
        await client.query("UNWIND $rows AS row MERGE (m {id: row.id}) SET m:ContractMember, m.contract_coordinate = row.coordinate, m.member_key = row.memberKey, m.member_kind = row.memberKind, m.current_snapshot = row.snapshot, m.current_digest = row.digest", { rows: [{ id: memberId, coordinate: contractConfig.coordinate, memberKey: member.memberKey, memberKind: member.memberKind, snapshot: member.snapshot, digest: member.digest }] });
      } else {
        await client.query("UNWIND $rows AS row MERGE (m {id: row.id}) SET m:ContractMember, m.contract_coordinate = row.coordinate, m.member_key = row.memberKey, m.member_kind = row.memberKind", { rows: [{ id: memberId, coordinate: contractConfig.coordinate, memberKey: member.memberKey, memberKind: member.memberKind }] });
      }
      await client.query("MERGE (c:Contract {id: $contractId})-[edge:HAS_MEMBER {id: $edgeId}]->(m:ContractMember {id: $memberId})", { contractId, memberId, edgeId: stableId("Relationship", `HAS_MEMBER:${contractId}:${memberId}`) });
      memberCount += 1;
    }

    for (const binding of contractConfig.bindings) {
      const member = byKey.get(binding.member);
      if (!member) throw new Error(`Configured member ${binding.member} is absent from ${contractConfig.document}`);
      const { filePath, symbolName } = bindingParts(binding.symbol);
      const symbolId = stableId("Symbol", `${config.repository.key}:${filePath}::${symbolName}`);
      const memberId = stableId("ContractMember", `${contractConfig.coordinate}:${binding.member}`);
      const edgeType = contractConfig.role === "provider" ? "PUBLISHES" : "CONSUMES";
      const edgeId = stableId("Relationship", `${edgeType}:${symbolId}:${memberId}`);
      await client.query(`MERGE (s:Symbol {id: $symbolId})-[edge:${edgeType} {id: $edgeId}]->(m:ContractMember {id: $memberId})`, { symbolId, memberId, edgeId });
      if (contractConfig.role === "consumer") {
        await client.query("MATCH (s:Symbol {id: $symbolId})-[edge:CONSUMES {id: $edgeId}]->(m:ContractMember {id: $memberId}) SET edge.expected_snapshot = $snapshot, edge.expected_digest = $digest", { symbolId, memberId, edgeId, snapshot: member.snapshot, digest: member.digest });
      }
      bindingCount += 1;
    }
  }
  return { contracts: config.contracts.length, members: memberCount, bindings: bindingCount };
}
