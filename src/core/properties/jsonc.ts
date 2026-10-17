/**
 * Scribe — parser mínimo de JSON5/JSONC (dependency-free).
 *
 * Fonte: `docs/architecture/05-empacotamento-e-recursos.md` (D9): `.sublime-settings` tem
 * comentários e vírgula final — o alvo lê um formato não-JSON estrito. Aqui normalizamos para
 * JSON estrito e delegamos ao `JSON.parse`, sem dependência nova.
 *
 * Escopo (escolha nossa): comentários `//` e `/* *\/`, **vírgula final** em objetos/arrays e
 * strings com escapes. Fatia de `JSON5` **não** suportada (chaves sem aspas, `'...'`, `+`/hex):
 * isso exigiria reimplementar o lexer inteiro — documentado como limite.
 */
export class JsonParseError extends Error {
  readonly line: number;
  readonly column: number;
  readonly position: number;

  constructor(message: string, line: number, column: number, position: number) {
    super(`JsonParseError: ${message} (linha ${line}, coluna ${column})`);
    this.name = "JsonParseError";
    this.line = line;
    this.column = column;
    this.position = position;
  }
}

/** Troca comentários por espaços (preserva offsets para o cálculo de linha/coluna). */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let inLine = false;
  let inBlock = false;
  while (i < text.length) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      } else {
        out += " ";
      }
      i += 1;
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        out += "  ";
        i += 2;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      out += "  ";
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      out += "  ";
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Remove vírgulas imediatamente antes de `}`/`]`, respeitando strings. */
function removeTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text.charAt(i + 1);
        i += 1;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text.charAt(j))) j += 1;
      const after = text.charAt(j);
      if (after === "}" || after === "]") {
        out += " ";
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function positionToLineColumn(text: string, position: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  const limit = Math.min(position, text.length);
  for (let i = 0; i < limit; i++) {
    if (text.charAt(i) === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

/**
 * Parseia JSONC/JSON5-mínimo. Lança `JsonParseError` (com linha/coluna aproximadas) em JSON inválido.
 */
export function parseJsonc<T = unknown>(text: string): T {
  const normalized = removeTrailingCommas(stripComments(text));
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch (err) {
    const message = err instanceof Error ? err.message : "JSON inválido";
    const positionMatch = /position (\d+)/.exec(message);
    const position = positionMatch?.[1] !== undefined ? Number.parseInt(positionMatch[1], 10) : 0;
    const lineColumnMatch = /line (\d+) column (\d+)/.exec(message);
    const { line, column } =
      lineColumnMatch?.[1] !== undefined && lineColumnMatch[2] !== undefined
        ? { line: Number.parseInt(lineColumnMatch[1], 10), column: Number.parseInt(lineColumnMatch[2], 10) }
        : positionToLineColumn(text, position);
    throw new JsonParseError(message, line, column, position);
  }
  return parsed as T;
}
