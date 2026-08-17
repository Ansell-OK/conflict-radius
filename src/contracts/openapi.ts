import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

type JsonObject = Record<string, unknown>;

export interface ContractMemberSnapshot {
  memberKey: string;
  memberKind: "operation" | "schema";
  snapshot: string;
  digest: string;
}

export type ContractCompatibility = "unchanged" | "compatible" | "breaking" | "ambiguous";

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

function serialize(value: unknown): string {
  return JSON.stringify(stable(value));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolvePointer(root: JsonObject, reference: string): unknown {
  if (!reference.startsWith("#/")) return { $ref: reference };
  return reference.slice(2).split("/").reduce<unknown>((current, part) => object(current)[part.replaceAll("~1", "/").replaceAll("~0", "~")], root);
}

function resolveRefs(value: unknown, root: JsonObject, seen = new Set<string>()): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, root, seen));
  const item = object(value);
  if (typeof item.$ref === "string") {
    if (seen.has(item.$ref)) return { $ref: item.$ref };
    const nextSeen = new Set(seen).add(item.$ref);
    return resolveRefs(resolvePointer(root, item.$ref), root, nextSeen);
  }
  return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, resolveRefs(child, root, seen)]));
}

function operationSnapshot(method: string, route: string, operation: JsonObject, pathItem: JsonObject, root: JsonObject): JsonObject {
  return {
    method,
    path: route,
    operationId: operation.operationId,
    parameters: resolveRefs([...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])], root),
    requestBody: resolveRefs(operation.requestBody ?? null, root),
    responses: resolveRefs(operation.responses ?? {}, root),
    security: operation.security ?? null,
  };
}

export function extractOpenApiMembers(document: unknown): ContractMemberSnapshot[] {
  const root = object(document);
  const members: ContractMemberSnapshot[] = [];
  for (const [route, rawPathItem] of Object.entries(object(root.paths))) {
    const pathItem = object(rawPathItem);
    for (const method of ["get", "put", "post", "delete", "patch", "options", "head", "trace"]) {
      const operation = object(pathItem[method]);
      if (Object.keys(operation).length === 0) continue;
      if (typeof operation.operationId !== "string" || operation.operationId.length === 0) {
        throw new Error(`OpenAPI operation ${method.toUpperCase()} ${route} is missing operationId`);
      }
      const snapshot = serialize(operationSnapshot(method, route, operation, pathItem, root));
      members.push({ memberKey: `operation:${operation.operationId}`, memberKind: "operation", snapshot, digest: digest(snapshot) });
    }
  }
  for (const [name, schema] of Object.entries(object(object(root.components).schemas))) {
    const snapshot = serialize(resolveRefs(schema, root));
    members.push({ memberKey: `schema:${name}`, memberKind: "schema", snapshot, digest: digest(snapshot) });
  }
  return members;
}

export async function readOpenApiMembers(filePath: string): Promise<{ documentSnapshot: string; documentDigest: string; members: ContractMemberSnapshot[] }> {
  const document = parse(await readFile(filePath, "utf8")) as unknown;
  const documentSnapshot = serialize(document);
  return { documentSnapshot, documentDigest: digest(documentSnapshot), members: extractOpenApiMembers(document) };
}

function schemaType(schema: unknown): string | null {
  const value = object(schema);
  return typeof value.type === "string" ? value.type : typeof value.$ref === "string" ? value.$ref : null;
}

function requiredFields(schema: unknown): Set<string> {
  const value = object(schema);
  return new Set(Array.isArray(value.required) ? value.required.filter((item): item is string => typeof item === "string") : []);
}

function properties(schema: unknown): JsonObject {
  return object(object(schema).properties);
}

function schemaBreaking(before: unknown, after: unknown, responseDirection: boolean): boolean {
  const oldType = schemaType(before);
  const newType = schemaType(after);
  if (oldType && newType && oldType !== newType) return true;
  const oldProperties = properties(before);
  const newProperties = properties(after);
  const oldRequired = requiredFields(before);
  const newRequired = requiredFields(after);
  for (const [name, oldProperty] of Object.entries(oldProperties)) {
    if (!(name in newProperties) && (responseDirection || oldRequired.has(name))) return true;
    if (name in newProperties && schemaBreaking(oldProperty, newProperties[name], responseDirection)) return true;
  }
  if (!responseDirection) {
    for (const name of newRequired) if (!oldRequired.has(name)) return true;
  }
  return false;
}

function parameterIdentity(value: unknown): string {
  const parameter = object(value);
  return `${String(parameter.in ?? "")}:${String(parameter.name ?? "")}`;
}

function operationBreaking(before: JsonObject, after: JsonObject): boolean {
  if (before.method !== after.method || before.path !== after.path || before.operationId !== after.operationId) return true;
  const oldParameters = new Map((Array.isArray(before.parameters) ? before.parameters : []).map((item) => [parameterIdentity(item), object(item)]));
  const newParameters = new Map((Array.isArray(after.parameters) ? after.parameters : []).map((item) => [parameterIdentity(item), object(item)]));
  for (const [key, oldParameter] of oldParameters) {
    const next = newParameters.get(key);
    if (!next || schemaBreaking(oldParameter.schema, next.schema, false)) return true;
    if (oldParameter.required !== true && next.required === true) return true;
  }
  for (const [key, newParameter] of newParameters) if (!oldParameters.has(key) && newParameter.required === true) return true;
  const oldBody = object(before.requestBody);
  const newBody = object(after.requestBody);
  if (oldBody.required !== true && newBody.required === true) return true;
  if (schemaBreaking(object(object(object(oldBody.content)["application/json"]).schema), object(object(object(newBody.content)["application/json"]).schema), false)) return true;
  const oldResponses = object(before.responses);
  const newResponses = object(after.responses);
  for (const [status, response] of Object.entries(oldResponses)) {
    if (!(status in newResponses)) return true;
    const oldSchema = object(object(object(response).content)["application/json"]).schema;
    const newSchema = object(object(object(newResponses[status]).content)["application/json"]).schema;
    if (schemaBreaking(oldSchema, newSchema, true)) return true;
  }
  return false;
}

export function classifyContractChange(beforeSnapshot: string | null, afterSnapshot: string | null, memberKind: "operation" | "schema"): ContractCompatibility {
  if (beforeSnapshot === afterSnapshot) return "unchanged";
  if (!beforeSnapshot && afterSnapshot) return "compatible";
  if (beforeSnapshot && !afterSnapshot) return "breaking";
  if (!beforeSnapshot || !afterSnapshot) return "ambiguous";
  try {
    const before = JSON.parse(beforeSnapshot) as unknown;
    const after = JSON.parse(afterSnapshot) as unknown;
    const breaking = memberKind === "operation"
      ? operationBreaking(object(before), object(after))
      : schemaBreaking(before, after, true);
    return breaking ? "breaking" : "compatible";
  } catch {
    return "ambiguous";
  }
}
