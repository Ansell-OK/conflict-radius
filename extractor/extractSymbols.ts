import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import { HydraClient, hydraConfigFromEnv } from "../src/hydra/client.js";
import { stableId } from "../src/ids.js";

interface SymbolRow {
  id: number;
  name: string;
  kind: "function";
  filePath: string;
  language: "javascript";
  startIndex: number;
  endIndex: number;
}

interface CallRow {
  caller: SymbolRow;
  calleeName: string;
}

async function walkJavaScriptFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await walkJavaScriptFiles(absolute)));
    else if (entry.isFile() && [".js", ".mjs", ".cjs"].includes(path.extname(entry.name))) found.push(absolute);
  }
  return found;
}

async function parseFile(parser: Parser, query: Parser.Query, repoRoot: string, file: string) {
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
        id: stableId("Symbol", `${relative}::${definitionName.node.text}`),
        name: definitionName.node.text,
        kind: "function",
        filePath: relative,
        language: "javascript",
        startIndex: definition.node.startIndex,
        endIndex: definition.node.endIndex,
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
  const repoRoot = path.resolve(process.argv[2] ?? "demo-repo");
  const parser = new Parser();
  parser.setLanguage(JavaScript as never);
  const queryPath = path.resolve("extractor/queries/javascript.scm");
  const querySource = await readFile(queryPath, "utf8");
  const query = new Parser.Query(JavaScript as never, querySource);
  const files = await walkJavaScriptFiles(repoRoot);
  const parsed = await Promise.all(files.map((file) => parseFile(parser, query, repoRoot, file)));
  const symbols = parsed.flatMap((file) => file.definitions);
  const symbolsByName = new Map(symbols.map((symbol) => [symbol.name, symbol]));
  const client = new HydraClient(hydraConfigFromEnv());
  const repoId = stableId("Repo", repoRoot);

  await client.query(
    "UNWIND $rows AS row MERGE (r {id: row.id}) SET r:Repo, r.name = row.name, r.path = row.path",
    { rows: [{ id: repoId, name: path.basename(repoRoot), path: repoRoot }] },
  );

  for (const file of parsed) {
    const fileId = stableId("File", file.relative);
    await client.query(
      "UNWIND $rows AS row MERGE (f {id: row.id}) SET f:File, f.path = row.path",
      { rows: [{ id: fileId, path: file.relative }] },
    );
    await client.query(
      "UNWIND $rows AS row MATCH (f:File {id: row.source}), (r:Repo {id: row.target}) MERGE (f)-[edge:PART_OF {id: row.edgeId}]->(r)",
      { rows: [{ source: fileId, target: repoId, edgeId: stableId("Relationship", `PART_OF:${fileId}:${repoId}`) }] },
    );
  }

  for (const symbol of symbols) {
    const fileId = stableId("File", symbol.filePath);
    await client.query(
      "UNWIND $rows AS row MERGE (s {id: row.id}) SET s:Symbol, s.name = row.name, s.kind = row.kind, s.file_path = row.filePath, s.language = row.language",
      { rows: [{ id: symbol.id, name: symbol.name, kind: symbol.kind, filePath: symbol.filePath, language: symbol.language }] },
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

  console.log(JSON.stringify({ repo: repoRoot, files: files.length, symbols: symbols.length, callEdges }, null, 2));
  await client.close();
}

await main();
