/**
 * Scribe — `yaml.ts`: leitor do **subconjunto** de YAML que o formato `.sublime-syntax` usa
 * (`docs/architecture/05` §2.3). **Não** é um parser YAML geral — é deliberadamente pequeno.
 *
 * O que **suporta**:
 * - mapas por indentação (`chave: valor`) e listas de bloco (`- item`), inclusive o item de lista
 *   que abre um mapa na mesma linha (`- match: "..."` + continuação indentada);
 * - escalares: plano, aspas simples (`''` escapa `'`) e aspas duplas (escapes `\n \t \r \" \\ \/ \0`);
 * - sequências de fluxo de **escalares** (`file_extensions: [demo, txt]`);
 * - comentários `#` (quando precedidos de espaço ou no início, e fora de aspas);
 * - diretivas `%…` e marcadores de documento `---`/`...` (ignorados);
 * - **JSON**: se o texto começa por `{`, delega ao `JSON.parse` (a spec permite).
 *
 * O que **não** suporta (documentado de propósito — falha com `GrammarParseError`, nunca silêncio):
 * - mapas em fluxo (`{a: b}`) e fluxo aninhado; listas de fluxo de listas/mapas;
 * - escalares de bloco (`|`, `>`) — multi-linha;
 * - âncoras/aliases (`&`, `*`), tags (`!!`), chaves complexas (`?`);
 * - indentação com tab;
 * - fusão de chaves, diretivas de tipo.
 *
 * Escolha nossa: qualquer construção não suportada **lança** em vez de adivinhar — a falha é
 * visível (o registro de gramáticas loga a gramática ignorada).
 */
import { GrammarParseError } from "../../shared";

interface SourceLine {
  readonly indent: number;
  readonly text: string;
  readonly number: number;
}

/**
 * Parseia o texto como YAML (subconjunto) ou JSON. Lança `GrammarParseError` com a linha quando o
 * documento não é parseável. `logicalName` só entra na mensagem (não é lido do documento).
 */
export function parseYamlSubset(text: string, logicalName: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch (error) {
      throw new GrammarParseError(logicalName, `JSON inválido: ${messageOf(error)}`);
    }
  }
  const lines = tokenizeSourceLines(text, logicalName);
  if (lines.length === 0) return null;
  return new BlockParser(lines, logicalName).parse();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Divide em linhas úteis: sem comentários, sem brancos, com a indentação em espaços contada. */
function tokenizeSourceLines(text: string, logicalName: string): SourceLine[] {
  const out: SourceLine[] = [];
  const raw = text.split(/\r?\n/);
  for (let index = 0; index < raw.length; index++) {
    const stripped = stripComment(raw[index] ?? "").replace(/\s+$/, "");
    if (stripped.trim().length === 0) continue;
    const body = stripped.trimStart();
    const indentText = stripped.slice(0, stripped.length - body.length);
    if (indentText.includes("\t")) {
      throw new GrammarParseError(logicalName, "indentação com tab não é suportada", index + 1);
    }
    if (body.startsWith("%") || body === "---" || body === "...") continue;
    out.push({ indent: indentText.length, text: body, number: index + 1 });
  }
  return out;
}

/** Remove um comentário `#` que esteja fora de aspas e seja precedido por espaço (ou no início). */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index] ?? "";
    if (inSingle) {
      if (char === "'") {
        if (line[index + 1] === "'") {
          index += 1;
          continue;
        }
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === '"') inDouble = false;
      continue;
    }
    if (char === "'") {
      inSingle = true;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      continue;
    }
    if (char === "#") {
      const previous = index > 0 ? line[index - 1] : undefined;
      if (index === 0 || (previous !== undefined && /\s/.test(previous))) {
        return line.slice(0, index);
      }
    }
  }
  return line;
}

function isSequenceItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

/** Posição do `:` separador de chave (fora de aspas e seguido de espaço ou fim). `-1` se não houver. */
function findKeyColon(text: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? "";
    if (inSingle) {
      if (char === "'") {
        if (text[index + 1] === "'") {
          index += 1;
          continue;
        }
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === '"') inDouble = false;
      continue;
    }
    if (char === "'") {
      inSingle = true;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      continue;
    }
    if (char === ":") {
      const next = text[index + 1];
      if (next === undefined || next === " ") return index;
    }
  }
  return -1;
}

class BlockParser {
  private position = 0;

  constructor(
    private readonly lines: readonly SourceLine[],
    private readonly logicalName: string,
  ) {}

  parse(): unknown {
    const first = this.lines[0];
    if (first === undefined) return null;
    const value = this.parseBlock(first.indent);
    const leftover = this.lines[this.position];
    if (leftover !== undefined) {
      this.fail(`conteúdo inesperado (indentação ${leftover.indent})`, leftover.number);
    }
    return value;
  }

  private fail(message: string, line?: number): never {
    throw new GrammarParseError(this.logicalName, message, line);
  }

  private parseBlock(indent: number): unknown {
    const line = this.lines[this.position];
    if (line === undefined || line.indent < indent) return null;
    return isSequenceItem(line.text) ? this.parseSequence(line.indent) : this.parseMapping(line.indent);
  }

  private parseSequence(indent: number): unknown[] {
    const out: unknown[] = [];
    while (true) {
      const line = this.lines[this.position];
      if (line === undefined || line.indent !== indent || !isSequenceItem(line.text)) break;
      this.position += 1;
      const rest = line.text.slice(1).trimStart();
      if (rest.length === 0) {
        const next = this.lines[this.position];
        out.push(next !== undefined && next.indent > indent ? this.parseBlock(next.indent) : null);
        continue;
      }
      if (findKeyColon(rest) >= 0) {
        const keyIndent = indent + (line.text.length - rest.length);
        out.push(this.parseInlineMapping(rest, keyIndent, indent, line.number));
        continue;
      }
      out.push(parseScalar(rest, this.logicalName, line.number));
    }
    return out;
  }

  private parseMapping(indent: number): Record<string, unknown> {
    const map: Record<string, unknown> = {};
    while (true) {
      const line = this.lines[this.position];
      if (line === undefined || line.indent !== indent || isSequenceItem(line.text)) break;
      this.position += 1;
      this.consumeEntry(map, line.text, indent, line.number);
    }
    return map;
  }

  /** Item de lista que abre um mapa na mesma linha: consome as continuações na mesma coluna da chave. */
  private parseInlineMapping(
    firstText: string,
    keyIndent: number,
    sequenceIndent: number,
    lineNumber: number,
  ): Record<string, unknown> {
    const map: Record<string, unknown> = {};
    this.consumeEntry(map, firstText, keyIndent, lineNumber);
    while (true) {
      const line = this.lines[this.position];
      if (line === undefined || line.indent !== keyIndent) break;
      if (line.indent <= sequenceIndent || isSequenceItem(line.text)) break;
      this.position += 1;
      this.consumeEntry(map, line.text, keyIndent, line.number);
    }
    return map;
  }

  private consumeEntry(map: Record<string, unknown>, text: string, indent: number, lineNumber: number): void {
    const colon = findKeyColon(text);
    if (colon < 0) this.fail(`esperava 'chave: valor': ${text}`, lineNumber);
    const key = unquoteKey(text.slice(0, colon).trim(), this.logicalName, lineNumber);
    if (key.length === 0) this.fail("chave vazia", lineNumber);
    const rest = text.slice(colon + 1).trim();
    if (rest.length === 0) {
      const next = this.lines[this.position];
      map[key] = next !== undefined && next.indent > indent ? this.parseBlock(next.indent) : null;
      return;
    }
    map[key] = parseScalar(rest, this.logicalName, lineNumber);
  }
}

function unquoteKey(raw: string, logicalName: string, line: number): string {
  if (raw.startsWith("'")) return parseSingleQuoted(raw, logicalName, line);
  if (raw.startsWith('"')) return parseDoubleQuoted(raw, logicalName, line);
  return raw;
}

function parseScalar(raw: string, logicalName: string, line: number): unknown {
  const text = raw.trim();
  if (text.startsWith("'")) return parseSingleQuoted(text, logicalName, line);
  if (text.startsWith('"')) return parseDoubleQuoted(text, logicalName, line);
  if (text.startsWith("[")) return parseFlowSequence(text, logicalName, line);
  if (/^[|>&*!]/.test(text)) {
    throw new GrammarParseError(logicalName, `estilo YAML não suportado: ${text}`, line);
  }
  if (text.startsWith("{") && !text.startsWith("{{")) {
    throw new GrammarParseError(logicalName, `mapa em fluxo não suportado: ${text}`, line);
  }
  if (text.length === 0 || text === "~" || /^null$/i.test(text)) return null;
  if (/^true$/i.test(text)) return true;
  if (/^false$/i.test(text)) return false;
  if (/^[+-]?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(text)) return Number.parseFloat(text);
  return text;
}

function parseSingleQuoted(text: string, logicalName: string, line: number): string {
  let out = "";
  for (let index = 1; index < text.length; index++) {
    const char = text[index] ?? "";
    if (char !== "'") {
      out += char;
      continue;
    }
    if (text[index + 1] === "'") {
      out += "'";
      index += 1;
      continue;
    }
    if (index !== text.length - 1) {
      throw new GrammarParseError(logicalName, `conteúdo após aspas simples: ${text}`, line);
    }
    return out;
  }
  throw new GrammarParseError(logicalName, "string com aspas simples não fechada", line);
}

function parseDoubleQuoted(text: string, logicalName: string, line: number): string {
  let out = "";
  for (let index = 1; index < text.length; index++) {
    const char = text[index] ?? "";
    if (char === "\\") {
      const next = text[index + 1];
      const escaped = unescape(next);
      if (escaped === undefined) {
        throw new GrammarParseError(logicalName, `escape não suportado: \\${next ?? ""}`, line);
      }
      out += escaped;
      index += 1;
      continue;
    }
    if (char !== '"') {
      out += char;
      continue;
    }
    if (index !== text.length - 1) {
      throw new GrammarParseError(logicalName, `conteúdo após aspas duplas: ${text}`, line);
    }
    return out;
  }
  throw new GrammarParseError(logicalName, "string com aspas duplas não fechada", line);
}

function unescape(char: string | undefined): string | undefined {
  switch (char) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case '"':
      return '"';
    case "\\":
      return "\\";
    case "/":
      return "/";
    case "0":
      return "\0";
    default:
      return undefined;
  }
}

function parseFlowSequence(text: string, logicalName: string, line: number): unknown[] {
  if (!text.endsWith("]")) {
    throw new GrammarParseError(logicalName, `lista de fluxo não fechada: ${text}`, line);
  }
  const inner = text.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return splitFlow(inner, logicalName, line).map((item) => parseScalar(item, logicalName, line));
}

/** Divide o interior de uma lista de fluxo por vírgulas de topo (respeitando aspas). */
function splitFlow(inner: string, logicalName: string, line: number): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index] ?? "";
    if (inSingle) {
      current += char;
      if (char === "'") {
        if (inner[index + 1] === "'") {
          current += "'";
          index += 1;
          continue;
        }
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      current += char;
      if (char === "\\") {
        current += inner[index + 1] ?? "";
        index += 1;
        continue;
      }
      if (char === '"') inDouble = false;
      continue;
    }
    if (char === "'") {
      inSingle = true;
      current += char;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      current += char;
      continue;
    }
    if (char === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (inSingle || inDouble) {
    throw new GrammarParseError(logicalName, "string não fechada numa lista de fluxo", line);
  }
  parts.push(current);
  return parts;
}
