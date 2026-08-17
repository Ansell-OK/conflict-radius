import { readFile } from "node:fs/promises";
import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";

export interface SignatureParameter {
  name: string;
  optional: boolean;
  rest: boolean;
}

export interface SignatureSnapshot {
  name: string;
  parameters: SignatureParameter[];
  returnType: string | null;
}

export type SignatureVerdict = "breaking" | "compatible" | "ambiguous";

export type SourceLanguage = "javascript" | "typescript";

function parser(language: SourceLanguage = "javascript", tsx = false): Parser {
  const instance = new Parser();
  instance.setLanguage(language === "typescript"
    ? (tsx ? TypeScript.tsx : TypeScript.typescript) as never
    : JavaScript as never);
  return instance;
}

function languageForFile(filePath: string): { language: SourceLanguage; tsx: boolean } {
  const extension = filePath.toLowerCase().split(".").pop();
  return extension === "ts" || extension === "tsx"
    ? { language: "typescript", tsx: extension === "tsx" }
    : { language: "javascript", tsx: false };
}

function walk(node: Parser.SyntaxNode, visit: (node: Parser.SyntaxNode) => boolean): Parser.SyntaxNode | undefined {
  if (visit(node)) return node;
  for (const child of node.namedChildren) {
    const found = walk(child, visit);
    if (found) return found;
  }
  return undefined;
}

function definitionFor(root: Parser.SyntaxNode, symbolName: string): Parser.SyntaxNode | undefined {
  return walk(root, (node) => {
    if (node.type === "function_declaration") return node.childForFieldName("name")?.text === symbolName;
    if (node.type === "method_definition") return node.childForFieldName("name")?.text === symbolName;
    if (node.type !== "variable_declarator") return false;
    const value = node.childForFieldName("value");
    return node.childForFieldName("name")?.text === symbolName
      && (value?.type === "arrow_function" || value?.type === "function_expression");
  });
}

function functionNode(definition: Parser.SyntaxNode): Parser.SyntaxNode {
  return definition.type === "variable_declarator"
    ? definition.childForFieldName("value") ?? definition
    : definition;
}

function parameterSnapshot(node: Parser.SyntaxNode): SignatureParameter {
  if (node.type === "required_parameter" || node.type === "optional_parameter") {
    const pattern = node.childForFieldName("pattern") ?? node.childForFieldName("name") ?? node.namedChildren[0];
    const assignment = pattern?.type === "assignment_pattern" ? pattern : undefined;
    const parameterName = assignment?.childForFieldName("left") ?? pattern;
    const defaultValue = node.childForFieldName("value");
    return {
      name: parameterName?.text ?? node.text.split(/[?:]/, 1)[0] ?? node.text,
      optional: node.type === "optional_parameter" || Boolean(assignment) || Boolean(defaultValue),
      rest: pattern?.type === "rest_pattern" || node.text.trimStart().startsWith("..."),
    };
  }
  if (node.type === "assignment_pattern") {
    const left = node.childForFieldName("left") ?? node.namedChildren[0];
    return { name: left?.text ?? node.text.split("=")[0]?.trim() ?? node.text, optional: true, rest: false };
  }
  if (node.type === "rest_pattern") {
    const argument = node.childForFieldName("argument") ?? node.namedChildren[0];
    return { name: argument?.text ?? node.text.replace(/^\.\.\./, ""), optional: true, rest: true };
  }
  return { name: node.text.replace(/\?$/, ""), optional: node.text.endsWith("?"), rest: false };
}

export function signatureFromSource(source: string, symbolName: string, language: SourceLanguage = "javascript", tsx = false): SignatureSnapshot | null {
  const tree = parser(language, tsx).parse(source);
  const definition = definitionFor(tree.rootNode, symbolName);
  if (!definition) return null;
  const callable = functionNode(definition);
  const parameters = callable.childForFieldName("parameters")?.namedChildren.map(parameterSnapshot) ?? [];
  const returnType = callable.childForFieldName("return_type")?.text ?? null;
  return { name: symbolName, parameters, returnType };
}

export async function signatureFromFile(filePath: string, symbolName: string): Promise<SignatureSnapshot | null> {
  const config = languageForFile(filePath);
  return signatureFromSource(await readFile(filePath, "utf8"), symbolName, config.language, config.tsx);
}

export function serializeSignature(signature: SignatureSnapshot | null): string {
  return signature ? JSON.stringify(signature) : "";
}

export function parseSignature(snapshot: string | null | undefined): SignatureSnapshot | null {
  if (!snapshot) return null;
  try {
    return JSON.parse(snapshot) as SignatureSnapshot;
  } catch {
    return null;
  }
}

export function classifySignatureChange(before: SignatureSnapshot, after: SignatureSnapshot): SignatureVerdict {
  if (before.returnType !== after.returnType && before.returnType !== null && after.returnType !== null) return "breaking";

  if (after.parameters.length < before.parameters.length) return "breaking";
  if (after.parameters.length > before.parameters.length) {
    return after.parameters.slice(before.parameters.length).every((parameter) => parameter.optional)
      ? "compatible"
      : "breaking";
  }

  let changed = before.returnType !== after.returnType;
  for (let index = 0; index < before.parameters.length; index += 1) {
    const previous = before.parameters[index]!;
    const current = after.parameters[index]!;
    if (previous.optional && !current.optional) return "breaking";
    if (!previous.optional && current.optional) changed = true;
    if (previous.name !== current.name || previous.rest !== current.rest) changed = true;
  }
  return changed ? "compatible" : "ambiguous";
}

export function callSiteFromSource(source: string, calleeName: string, language: SourceLanguage = "javascript", tsx = false): string | null {
  const tree = parser(language, tsx).parse(source);
  const call = walk(tree.rootNode, (node) => {
    if (node.type !== "call_expression") return false;
    const target = node.childForFieldName("function");
    if (target?.type === "identifier") return target.text === calleeName;
    if (target?.type === "member_expression") return target.childForFieldName("property")?.text === calleeName;
    return false;
  });
  return call?.text ?? null;
}

export async function callSiteFromFile(filePath: string, calleeName: string): Promise<string | null> {
  const config = languageForFile(filePath);
  return callSiteFromSource(await readFile(filePath, "utf8"), calleeName, config.language, config.tsx);
}
