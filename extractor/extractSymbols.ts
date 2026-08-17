import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";
import { HydraClient, hydraConfigFromEnv } from "../src/hydra/client.js";
import { stableId } from "../src/ids.js";
import { serializeSignature, signatureFromSource } from "../src/signatures.js";
import { repositoryKeyForRoot } from "../src/repository.js";

interface SymbolRow {
  id: number;
  name: string;
  kind: "function";
  filePath: string;
  language: "javascript" | "typescript";
  startIndex: number;
  endIndex: number;
  signatureSnapshot: string;
}

interface CallRow {
  caller: SymbolRow;
  calleeName: string;
}

interface LanguageConfig {
  language: Parameters<Parser["setLanguage"]>[0];
  name: SymbolRow["language"];
  queryPath: string;
}

const queriesRoot = fileURLToPath(new URL("./queries/", import.meta.url));

function languageConfig(file: string): LanguageConfig | null {
  const extension = path.extname(file);
  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    return { language: JavaScript as never, name: "javascript", queryPath: path.join(queriesRoot, "javascript.scm") };
  }
  if (extension === ".ts") {
    return { language: TypeScript.typescript as never, name: "typescript", queryPath: path.join(queriesRoot, "typescript.scm") };
  }
  if (extension === ".tsx") {
    return { language: TypeScript.tsx as never, name: "typescript", queryPath: path.join(queriesRoot, "typescript.scm") };
  }
  return null;
}

async function walkSourceFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const ignoredDirectories = new Set([".git", ".hydradb-local", ".worktrees", "dist", "node_modules"]);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) found.push(...(await walkSourceFiles(absolute)));
    else if (entry.isFile() && languageConfig(absolute)) found.push(absolute);
  }
  return found;
}

async function parseFile(repoRoot: string, repositoryKey: string, file: string) {
  const config = languageConfig(file);
  if (!config) throw new Error(`Unsupported source file: ${file}`);
  const parser = new Parser();
  parser.setLanguage(config.language);
  const query = new Parser.Query(config.language, await readFile(path.resolve(config.queryPath), "utf8"));
  const source = await readFile(file, "utf8");
  const tree = parser.parse(source);
  const relative = path.relative(repoRoot, file).replaceAll(path.sep, "/");
  const definitions: SymbolRow[] = [];
  const callNodes: Array<{ name: string; startIndex: number }> = [];

  for (const match of query.matches(tree.rootNode)) {
    const definition = match.captures.find((capture) => capture.name === "definition");
    const definitionName = match.captures.find((capture) => capture.name === "definition.name");
    if (definition && definitionName) {
      definitions.push({
        id: stableId("Symbol", `${repositoryKey}:${relative}::${definitionName.node.text}`),
        name: definitionName.node.text,
        kind: "function",
        filePath: relative,
        language: config.name,
        startIndex: definition.node.startIndex,
        endIndex: definition.node.endIndex,
        signatureSnapshot: serializeSignature(signatureFromSource(source, definitionName.node.text, config.name)),
      });
    }

    const call = match.captures.find((capture) => capture.name === "call");
    const callName = match.captures.find((capture) => capture.name === "call.name");
    if (call && callName) callNodes.push({ name: callName.node.text, startIndex: call.node.startIndex });
  }

  const calls: CallRow[] = [];
  for (const call of callNodes) {
    const caller = definitions
      .filter((definition) => definition.startIndex <= call.startIndex && call.startIndex <= definition.endIndex)
      .sort((a, b) => (a.endIndex - a.startIndex) - (b.endIndex - b.startIndex))[0];
    if (caller) calls.push({ caller, calleeName: call.name });
  }

  return { relative, definitions, calls };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repositoryKeyIndex = args.indexOf("--repository-key");
  const explicitRepositoryKey = repositoryKeyIndex >= 0 ? args[repositoryKeyIndex + 1] : undefined;
  const positional = repositoryKeyIndex >= 0
    ? args.filter((_, index) => index !== repositoryKeyIndex && index !== repositoryKeyIndex + 1)
    : args;
  const repoRoot = path.resolve(positional[0] ?? "demo-repo");
  const repositoryKey = await repositoryKeyForRoot(repoRoot, explicitRepositoryKey);
  const files = await walkSourceFiles(repoRoot);
  const parsed = await Promise.all(files.map((file) => parseFile(repoRoot, repositoryKey, file)));
  const symbols = parsed.flatMap((file) => file.definitions);
  const symbolsByName = new Map(symbols.map((symbol) => [symbol.name, symbol]));
  const client = new HydraClient(hydraConfigFromEnv());
  const repoId = stableId("Repo", repositoryKey);

  await client.query(
    "UNWIND $rows AS row MERGE (r {id: row.id}) SET r:Repo, r.name = row.name, r.path = row.localPath, r.local_path = row.localPath, r.repository_key = row.repositoryKey",
    { rows: [{ id: repoId, name: path.basename(repoRoot), localPath: repoRoot, repositoryKey }] },
  );

  for (const file of parsed) {
    const fileId = stableId("File", `${repositoryKey}:${file.relative}`);
    await client.query(
      "UNWIND $rows AS row MERGE (f {id: row.id}) SET f:File, f.path = row.path, f.repository_key = row.repositoryKey",
      { rows: [{ id: fileId, path: file.relative, repositoryKey }] },
    );
    await client.query(
      "UNWIND $rows AS row MATCH (f:File {id: row.source}), (r:Repo {id: row.target}) MERGE (f)-[edge:PART_OF {id: row.edgeId}]->(r)",
      { rows: [{ source: fileId, target: repoId, edgeId: stableId("Relationship", `PART_OF:${fileId}:${repoId}`) }] },
    );
  }

  for (const symbol of symbols) {
    const fileId = stableId("File", `${repositoryKey}:${symbol.filePath}`);
    await client.query(
      "UNWIND $rows AS row MERGE (s {id: row.id}) SET s:Symbol, s.name = row.name, s.kind = row.kind, s.file_path = row.filePath, s.language = row.language, s.signature_snapshot = row.signatureSnapshot, s.repository_key = row.repositoryKey",
      { rows: [{ id: symbol.id, name: symbol.name, kind: symbol.kind, filePath: symbol.filePath, language: symbol.language, signatureSnapshot: symbol.signatureSnapshot, repositoryKey }] },
    );
    await client.query(
      "UNWIND $rows AS row MATCH (s:Symbol {id: row.source}), (f:File {id: row.target}) MERGE (s)-[edge:DEFINED_IN {id: row.edgeId}]->(f)",
      { rows: [{ source: symbol.id, target: fileId, edgeId: stableId("Relationship", `DEFINED_IN:${symbol.id}:${fileId}`) }] },
    );
  }

  let callEdges = 0;
  for (const call of parsed.flatMap((file) => file.calls)) {
    const callee = symbolsByName.get(call.calleeName);
    if (!callee) continue;
    await client.query(
      "UNWIND $rows AS row MATCH (caller:Symbol {id: row.source}), (callee:Symbol {id: row.target}) MERGE (caller)-[edge:CALLS {id: row.edgeId}]->(callee)",
      { rows: [{ source: call.caller.id, target: callee.id, edgeId: stableId("Relationship", `CALLS:${call.caller.id}:${callee.id}`) }] },
    );
    callEdges += 1;
  }

  console.log(JSON.stringify({ repo: repoRoot, repositoryKey, files: files.length, symbols: symbols.length, callEdges }, null, 2));
  await client.close();
}

await main();
