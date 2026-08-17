#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HydraClient, hydraConfigFromEnv } from "./hydra/client.js";
import { stableId } from "./ids.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const token = "local-development-token-32-bytes";

function usage(): never {
  console.error(`Usage: conflict-radar <command> [path]\n\nCommands:\n  init [path]       Create local HydraDB and MCP configuration\n  up [path]         Start HydraDB with Docker Compose and verify it\n  down [path]       Stop the local HydraDB container\n  doctor            Round-trip a real write/read against HydraDB\n  extract [path]    Extract symbols and configured OpenAPI contracts\n  serve             Start the stdio MCP server\n  admission         Start the admission coordinator`);
  process.exit(1);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function composeSource(): string {
  return `services:
  hydradb:
    image: ghcr.io/hydra-db/hydradb:latest
    user: "\${CONFLICT_RADAR_DOCKER_UID:-10001}:\${CONFLICT_RADAR_DOCKER_GID:-10001}"
    ports:
      - "17687:7687"
      - "18443:8443"
      - "19090:9090"
    volumes:
      - ./hydradb-data:/data
    environment:
      CLOUD_PROVIDER: local
      LOCAL_PATH: /data/store
      GRAPH_NAMESPACE: default
      GRAPH_ID: default
      GRAPH_CELL_ID: cell-0
      GRAPH_CELLS: cell-0
      GRAPH_NODE_ID: node-0
      GRAPH_BOLT_NODE_ADDRESSES: node-0=127.0.0.1:7687
      GRAPH_ADVERTISED_BOLT_ADDR: 127.0.0.1:7687
      GRAPH_DATA_CACHE_DIR: /data/cache
      GRAPH_AUTH_TOKEN_FILE: /data/auth-token
      GRAPH_ALLOW_PLAINTEXT: "true"
      RUST_MIN_STACK: "33554432"
    restart: unless-stopped
`;
}

async function init(root: string): Promise<void> {
  const runtime = path.join(root, ".conflict-radar");
  const data = path.join(runtime, "hydradb-data");
  await mkdir(path.join(data, "store"), { recursive: true });
  await mkdir(path.join(data, "cache"), { recursive: true });
  await writeFile(path.join(data, "auth-token"), `${token}\n`, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await writeFile(path.join(runtime, "compose.yml"), composeSource(), { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const uid = typeof process.getuid === "function" ? process.getuid() : 10001;
  const gid = typeof process.getgid === "function" ? process.getgid() : 10001;
  await writeFile(path.join(runtime, ".env"), `CONFLICT_RADAR_DOCKER_UID=${uid}\nCONFLICT_RADAR_DOCKER_GID=${gid}\n`, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const mcp = {
    mcpServers: {
      "conflict-radar": {
        command: "npx",
        args: ["-y", "--package", "conflict-radar-mcp", "conflict-radar-mcp"],
        env: {
          HYDRADB_URI: "bolt://127.0.0.1:17687",
          HYDRADB_TOKEN: token,
          HYDRADB_GRAPH_ID: "default",
        },
      },
    },
  };
  await writeFile(path.join(runtime, "mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const ignore = path.join(root, ".gitignore");
  const ignoreSource = await readFile(ignore, "utf8").catch(() => "");
  if (!ignoreSource.split(/\r?\n/).includes(".conflict-radar/")) {
    await appendFile(ignore, `${ignoreSource && !ignoreSource.endsWith("\n") ? "\n" : ""}.conflict-radar/\n`);
  }
  console.log(`Conflict Radar initialized in ${runtime}`);
  console.log(`MCP configuration: ${path.join(runtime, "mcp.json")}`);
}

async function run(command: string, args: string[], cwd: string, env = process.env): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code ?? "unknown"}`)));
  });
}

async function compose(root: string, action: "up" | "down"): Promise<void> {
  const runtime = path.join(root, ".conflict-radar");
  if (!(await exists(path.join(runtime, "compose.yml")))) await init(root);
  const args = ["compose", "--env-file", ".env", "-f", "compose.yml", action];
  if (action === "up") args.push("-d");
  await run("docker", args, runtime);
  if (action === "up") {
    let lastError: unknown;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await doctor();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    throw lastError;
  }
}

async function doctor(): Promise<void> {
  const client = new HydraClient(hydraConfigFromEnv());
  const nonce = `${Date.now()}-${process.pid}`;
  const id = stableId("ConflictRadarDoctor", "local");
  try {
    await client.query(
      "UNWIND $rows AS row MERGE (probe {id: row.id}) SET probe:ConflictRadarDoctor, probe.nonce = row.nonce",
      { rows: [{ id, nonce }] },
      "strong",
    );
    const rows = await client.query(
      "MATCH (probe:ConflictRadarDoctor {id: $id}) RETURN probe.nonce AS nonce",
      { id },
      "strong",
    );
    if (rows[0]?.nonce !== nonce) throw new Error("HydraDB write/read round-trip returned the wrong value");
    console.log(`HydraDB round-trip succeeded at ${hydraConfigFromEnv().uri}`);
  } finally {
    await client.close();
  }
}

async function extract(root: string): Promise<void> {
  await run(process.execPath, [path.join(packageRoot, "dist/extractor/extractSymbols.js"), root], root);
  if (await exists(path.join(root, ".conflict-radar.yml"))) {
    await run(process.execPath, [path.join(packageRoot, "dist/extractor/ingestContracts.js"), root], root);
  }
}

const command = process.argv[2];
const root = path.resolve(process.argv[3] ?? ".");

switch (command) {
  case "init": await init(root); break;
  case "up": await compose(root, "up"); break;
  case "down": await compose(root, "down"); break;
  case "doctor": await doctor(); break;
  case "extract": await extract(root); break;
  case "serve": await import("./index.js"); break;
  case "admission": await import("./admissionServer.js"); break;
  default: usage();
}
