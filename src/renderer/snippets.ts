/**
 * Scribe — Snippets (P4#18): expansão de templates com Tab.
 *
 * Formato: { trigger, template }. A sintaxe dos templates é estilo TextMate/VS Code —
 * **implementação própria, clean-room** (nada transcrito de terceiros):
 *
 * - `$$` → `$` literal; `$N` / `${N}` / `${N:default}`; `$0` é a parada final.
 * - **Aninhamento**: `${1:aaa ${2:bbb} ccc}` com `}` balanceado (só `${` conta profundidade;
 *   `\}` escapa o fechamento) — nada de `indexOf("}")` ingênuo.
 * - **Escolhas**: `${1|a,b,c|}` → default = primeira escolha; a ocorrência carrega a **lista de
 *   opções** (`choices`) para o dropdown (ver `snippet-session.ts` / `snippet-choice.ts`). O `|`
 *   interno escapa: `${1|a\|b,c|}` ⇒ 2 opções (`a|b` e `c`).
 * - **Transformações**: `${1/regex/format/flags}` — o regex termina no 1º `/` não-escapado, os
 *   flags começam no **último** `/` não-escapado, o format é o resto. Regex inválida → degrada
 *   para ocorrência simples com **1** `console.warn`.
 * - **Variáveis TM**: `$TM_FILENAME`, `${TM_FILENAME}` e `${TM_FILENAME:default}` são resolvidas
 *   **na parse** (quando há contexto — `SnippetVariableContext`); variável desconhecida **ou sem
 *   contexto** ⇒ fica **literal**. O texto puro também é resolvível com
 *   `resolveSnippetVariables(text, ctx)`.
 * - **Identificador desconhecido** (`${FOO}` / `$FOO`) → texto **literal**.
 *
 * Espelhos: a **primeira ocorrência com default** de um índice é a **primária** (região editável);
 * se nenhuma tem default, a primária é a primeira ocorrência. As demais ocorrências do índice são
 * **espelhos** que renderizam o valor atual da primária **na expansão inicial** e aplicam o
 * `transform` da própria ocorrência quando houver.
 *
 * Módulo **puro** (sem DOM/IPC) — testado direto em `test/renderer-snippets.test.ts`.
 */

export interface Snippet {
  readonly trigger: string;
  readonly template: string;
  readonly description?: string;
}

/** Uma parada de tabulação: região do texto expandido associada a um índice `$N`. */
export interface TabStop {
  readonly index: number;
  readonly start: number;       // offset no texto expandido
  readonly end: number;         // offset no texto expandido
  readonly defaultValue: string; // conteúdo renderizado desta ocorrência
}

/** Transformação `${N/regex/format/flags}` aplicada a uma ocorrência (espelho). */
export interface SnippetTransform {
  /** Fonte do regex (já sem os escapes de delimitação `\/` `\\` `}` `$`). */
  readonly regex: string;
  /** Formato com referências `$1`, `${1}`, `$&`, `$$`. */
  readonly format: string;
  /** Flags do regex (`g`, `i`, `m`, ...), validadas na parse. */
  readonly flags: string;
}

/** Ocorrência de um índice no texto expandido — primária (editável) ou espelho (derivado). */
export interface SnippetOccurrence extends TabStop {
  /** Identificador estável da ocorrência (ordem de emissão) — usada para achar ancestrais. */
  readonly id: number;
  /** `id` da ocorrência que a contém no aninhamento, ou `-1` na raiz do template. */
  readonly parentId: number;
  /** `true` na ocorrência editável; `false` num espelho (renderiza o valor da primária). */
  readonly isPrimary: boolean;
  /** Transformação desta ocorrência, quando declarada no template. */
  readonly transform?: SnippetTransform;
  /** Lista de opções quando a ocorrência é uma **escolha** (`${1|a,b,c|}`). */
  readonly choices?: readonly string[];
  /** Índice da opção inicial (sempre `0` na parse — a 1ª é o default). */
  readonly choiceIndex?: number;
}

export interface SnippetExpansion {
  /** Texto já com espelhos renderizados (e `$$`/escapes resolvidos). */
  readonly text: string;
  /** Primárias na **ordem de visita**: índices ascendentes, `$0` por último. */
  readonly tabStops: readonly TabStop[];
  /** Todas as ocorrências (primárias + espelhos) na ordem em que aparecem no texto. */
  readonly occurrences: readonly SnippetOccurrence[];
  /** Índices na ordem de visita (`tabStops[i].index`) — o que a sessão percorre com Tab. */
  readonly visitOrder: readonly number[];
}

/** Lista de snippets embutidos (simples, hardcoded por enquanto). */
const BUILTIN_SNIPPETS: Snippet[] = [
  { trigger: "for",    template: "for (let ${1:i} = 0; ${1} < ${2}; ${1}++) {\n  $0\n}" },
  { trigger: "forof",  template: "for (const ${1:item} of ${2:iterable}) {\n  $0\n}" },
  { trigger: "forin",  template: "for (const ${1:key} in ${2:obj}) {\n  $0\n}" },
  { trigger: "if",     template: "if (${1:condition}) {\n  $0\n}" },
  { trigger: "else",   template: "else {\n  $0\n}" },
  { trigger: "elif",   template: "else if (${1:condition}) {\n  $0\n}" },
  { trigger: "while",  template: "while (${1:condition}) {\n  $0\n}" },
  { trigger: "fun",    template: "function ${1:name}(${2:params}) {\n  $0\n}" },
  { trigger: "fn",     template: "(${1:params}) => ${2:void}" },
  { trigger: "log",    template: "console.log($1);$0" },
  { trigger: "try",    template: "try {\n  $0\n} catch (${1:error}) {\n  \n}" },
  { trigger: "class",  template: "class ${1:Name} {\n  constructor(${2:params}) {\n    $0\n  }\n}" },
  // Escolhas (`${1|a,b,c|}`) e variáveis TM — o dropdown de escolha e a resolução de
  // variáveis só são alcançáveis por um template que as use.
  { trigger: "const",  template: "const ${1|let,const,var|} ${2:name} = ${3:value};$0" },
  { trigger: "file",   template: "// ${TM_FILENAME}\n$0" },
];

/** Busca snippet pelo trigger (case-insensitive). */
export function findSnippet(word: string): Snippet | undefined {
  const lower = word.toLowerCase();
  return BUILTIN_SNIPPETS.find((s) => s.trigger === lower);
}

// ---- AST interno --------------------------------------------------------------------------------

/** Nó textual (mantido **bruto**; o unescape acontece na emissão). */
interface TextNode {
  readonly kind: "text";
  readonly raw: string;
  /** `true` quando o texto já vem **pronto** (ex.: valor de variável) — não sofre unescape. */
  readonly verbatim?: boolean;
}

/** Ocorrência `$N` / `${N:...}` durante a parse (offsets só existem após a emissão). */
interface StopNode {
  readonly kind: "stop";
  readonly index: number;
  /** `true` para `${N:default}`/`${N|escolhas|}` — define a primária do índice. */
  readonly hasDefault: boolean;
  readonly transform?: SnippetTransform;
  /** Opções de uma escolha (`${N|a,b,c|}`) — já sem escape de `|`. */
  readonly choices?: readonly string[];
  /** Conteúdo interno de `${N:...}` já parseado (permite aninhamento). */
  readonly children: readonly ParseNode[];
}

type ParseNode = TextNode | StopNode;

// ---- variáveis TM ---------------------------------------------------------------------------------

/**
 * Contexto de resolução das **variáveis TM** de um snippet.
 *
 * Todo campo é opcional: o que não for informado deixa a variável **literal** (nunca vira
 * string vazia). `filePath` serve de fonte para derivar `fileName`/`directory` quando eles não
 * vierem explicitamente.
 */
export interface SnippetVariableContext {
  /** Nome do arquivo ("notes.md"). */
  readonly fileName?: string | undefined;
  /** Nome do arquivo sem extensão ("notes"). */
  readonly fileNameBase?: string | undefined;
  /** Caminho completo do arquivo ("/caminho/notas.md"). */
  readonly filePath?: string | undefined;
  /** Diretório do arquivo ("/caminho"). */
  readonly directory?: string | undefined;
  /** Texto selecionado no momento da expansão. */
  readonly selectedText?: string | undefined;
  /** Linha do caret. */
  readonly currentLine?: string | undefined;
  /** Palavra sob o caret. */
  readonly currentWord?: string | undefined;
  /** Índice da linha (0-based). */
  readonly lineIndex?: number | undefined;
}

/** Nomes de variáveis TM reconhecidos (o valor vem do contexto). */
const TM_VARIABLE_NAMES = [
  "TM_FILENAME",
  "TM_FILENAME_BASE",
  "TM_DIRECTORY",
  "TM_SELECTED_TEXT",
  "TM_CURRENT_LINE",
  "TM_CURRENT_WORD",
  "TM_LINE_INDEX",
] as const;

type TmVariableName = (typeof TM_VARIABLE_NAMES)[number];

/** `true` se `name` é uma variável TM reconhecida. */
function isTmVariable(name: string): name is TmVariableName {
  return (TM_VARIABLE_NAMES as readonly string[]).includes(name);
}

/** Último segmento de um caminho (`/a/b/c.md` → `c.md`; `""` → `undefined`). */
function basenameOf(path: string): string | undefined {
  if (path.length === 0) return undefined;
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/** Diretório de um caminho (`/a/b/c.md` → `/a/b`; `c.md` → sem diretório). */
function dirnameOf(path: string): string | undefined {
  const idx = path.lastIndexOf("/");
  if (idx === -1) return undefined;
  if (idx === 0) return "/";
  return path.slice(0, idx);
}

/** Nome do arquivo sem extensão (`notes.md` → `notes`; `.gitignore` → `.gitignore`). */
function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return name;
  return name.slice(0, dot);
}

/**
 * Valor da variável TM no contexto.
 *
 * `undefined` = **sem contexto** (a variável fica literal no texto). String vazia conta como
 * ausente (seleção/linha vazia) — assim a variável nunca vira texto vazio. `fileName`,
 * `fileNameBase` e `directory` podem ser **derivados** de `filePath` quando não vierem.
 */
function tmValue(name: TmVariableName, ctx: SnippetVariableContext): string | undefined {
  const nonEmpty = (value: string | undefined): string | undefined =>
    value !== undefined && value.length > 0 ? value : undefined;
  const fileName = nonEmpty(ctx.fileName) ?? nonEmpty(basenameOf(ctx.filePath ?? ""));
  switch (name) {
    case "TM_FILENAME":
      return fileName;
    case "TM_FILENAME_BASE":
      return nonEmpty(ctx.fileNameBase) ?? nonEmpty(stripExtension(fileName ?? ""));
    case "TM_DIRECTORY":
      return nonEmpty(ctx.directory) ?? nonEmpty(dirnameOf(ctx.filePath ?? ""));
    case "TM_SELECTED_TEXT":
      return nonEmpty(ctx.selectedText);
    case "TM_CURRENT_LINE":
      return nonEmpty(ctx.currentLine);
    case "TM_CURRENT_WORD":
      return nonEmpty(ctx.currentWord);
    case "TM_LINE_INDEX":
      return ctx.lineIndex === undefined ? undefined : String(ctx.lineIndex);
  }
}

/** Resultado da resolução de uma variável: texto bruto + se é emitido verbatim. */
interface ResolvedVariable {
  readonly raw: string;
  readonly verbatim: boolean;
}

/**
 * Resolve `${NOME}` / `${NOME:default}` contra o contexto.
 *
 * `undefined` = variável desconhecida **ou** sem valor e sem default → o placeholder fica
 * **literal** (comportamento antigo, preservado).
 */
function resolveVariable(inner: string, ctx: SnippetVariableContext): ResolvedVariable | undefined {
  const colon = inner.indexOf(":");
  const name = colon === -1 ? inner : inner.slice(0, colon);
  if (!isTmVariable(name)) return undefined;
  const value = tmValue(name, ctx);
  if (value !== undefined) return { raw: value, verbatim: true };
  if (colon === -1) return undefined;
  // Sem valor: usa o default (texto puro, ainda escapado — o unescape acontece na emissão).
  return { raw: inner.slice(colon + 1), verbatim: false };
}

/**
 * Substitui as **variáveis TM** de um texto puro.
 *
 * Formas reconhecidas: `$TM_FILENAME`, `${TM_FILENAME}` e `${TM_FILENAME:default}`. Variável
 * desconhecida (ou sem valor no contexto e sem default) fica **literal**; `$$` protege o `$`
 * seguinte. use `parseSnippet(template, ctx)` para resolver variáveis **e** manter os offsets
 * das tab stops coerentes — esta função não conhece offsets.
 */
export function resolveSnippetVariables(text: string, ctx: SnippetVariableContext): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\") {                                  // escape: o próximo char é literal
      out += c;
      if (i + 1 < text.length) out += text[i + 1]!;
      i += 2;
      continue;
    }
    if (c !== "$") { out += c; i++; continue; }
    const next = text[i + 1];
    if (next === undefined) { out += c; i++; continue; }
    if (next === "$") { out += "$$"; i += 2; continue; }  // "$$" literal — não é variável
    if (next === "{") {
      const close = findClosingBrace(text, i + 1);
      if (close === -1) { out += c; i++; continue; }
      const inner = text.slice(i + 2, close);
      const resolved = resolveVariable(inner, ctx);
      if (resolved === undefined) { out += text.slice(i, close + 1); i = close + 1; continue; }
      out += resolved.verbatim ? resolved.raw : unescape(resolved.raw);
      i = close + 1;
      continue;
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i + 1));
    if (ident !== null) {
      const name = ident[0] ?? "";
      if (isTmVariable(name)) {
        const value = tmValue(name, ctx);
        if (value !== undefined) { out += value; i += 1 + name.length; continue; }
      }
    }
    out += c; i++;
  }
  return out;
}


// ---- utilidades de sintaxe -----------------------------------------------------------------------

/** `true` para dígito ASCII. */
function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

/**
 * Localiza o `}` que fecha um `${` aberto em `open` (índice da chave).
 *
 * Regras: `\X` escapa o caractere seguinte (logo `\}` **não** fecha); **toda** chave `{`
 * aumenta a profundidade e toda `}` a diminui — assim conteúdo de chaves **balanceado**
 * dentro do default (ex.: `if { x }`) fecha no lugar certo. Conteúdo com chave órfã exige
 * escape (`\}`), que a regra de escape já trata.
 */
function findClosingBrace(src: string, open: number): number {
  let depth = 1;
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") { i++; continue; }            // escape: consome o próximo char
    if (c === "$" && src[i + 1] === "$") { i++; continue; } // $$ literal não abre chave
    if (c === "{") { depth++; continue; }
    if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Remove escapes do conteúdo: `\}` → `}`, `\$` → `$`, `\\` → `\`; qualquer outra sequência
 * (`\d`, `\n`, `\p`) é mantida **intacta** para não destruir regex/caminhos nos templates.
 * `emCampo` inclui o escape de delimitação `\/` → `/`, usado só em `regex`/`format`.
 */
function unescape(raw: string, emCampo = false): string {
  if (!raw.includes("\\")) return raw;
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c !== "\\" || i + 1 >= raw.length) { out += c; continue; }
    const next = raw[i + 1]!;
    if (next === "}" || next === "$" || next === "\\" || (emCampo && next === "/")) {
      out += next;
      i++;
    } else out += c; // sequência desconhecida: preserva a barra
  }
  return out;
}

/** Remove os escapes de **delimitação** usados dentro de `regex`/`format` da transformação. */
function unescapeField(raw: string): string {
  return unescape(raw, true);
}

/**
 * Divide `${N/regex/format/flags}` nos 3 campos: o regex termina no **primeiro** `/`
 * não-escapado e os flags começam no **último** `/` não-escapado (o format fica no meio e
 * pode conter `/` escapado). `null` = corpo malformado (menos de 2 delimitadores).
 */
function splitTransform(body: string): SnippetTransform | null {
  let first = -1;
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "\\") { i++; continue; } // \/ não delimita
    if (c === "/") {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1 || first === last) return null;
  return {
    regex: unescapeField(body.slice(0, first)),
    format: unescapeField(body.slice(first + 1, last)),
    flags: body.slice(last + 1),
  };
}

/**
 * Divide o corpo de `${N|a,b,c|}` nas opções.
 *
 * O `,` separates as opções; `\|` (e `\,`) escapam o delimitador — `${1|a\|b,c|}` ⇒
 * `["a|b", "c"]`. O `|` que **fecha** o placeholder é o último da linha de template (o corpo
 * nunca contém `|` cru de propósito: use `\|`).
 */
function splitChoices(body: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "\\" && i + 1 < body.length) { current += c + body[i + 1]!; i++; continue; }
    if (c === ",") { parts.push(current); current = ""; continue; }
    current += c;
  }
  parts.push(current);
  return parts.map(unescapeChoice);
}

/** Remove os escapes de delimitador de uma opção: `\|` → `|`, `\,` → `,`, `\\` → `\`. */
function unescapeChoice(raw: string): string {
  if (!raw.includes("\\")) return raw;
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c !== "\\" || i + 1 >= raw.length) { out += c; continue; }
    const next = raw[i + 1]!;
    if (next === "|" || next === "," || next === "\\" || next === "$" || next === "}") {
      out += next;
      i++;
    } else out += c;  // sequência desconhecida: preserva a barra
  }
  return out;
}

// ---- parse ----------------------------------------------------------------------------------------

/** Parseia uma região do template (o template inteiro ou o interior de um `${N:...}`). */
function parseRegion(src: string, ctx: SnippetVariableContext): ParseNode[] {
  const nodes: ParseNode[] = [];
  let textStart = 0;
  let i = 0;

  const flush = (end: number): void => {
    if (end > textStart) nodes.push({ kind: "text", raw: src.slice(textStart, end) });
  };

  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") { i += 2; continue; }      // escape: os 2 chars são texto literal
    if (c !== "$") { i++; continue; }

    const next = src[i + 1];
    if (next === undefined) { i++; break; }    // "$" solto no fim → literal

    if (next === "$") {                        // $$ → $
      flush(i);
      nodes.push({ kind: "text", raw: "$" });
      i += 2;
      textStart = i;
      continue;
    }

    if (next === "{") {
      const close = findClosingBrace(src, i + 1);
      if (close === -1) { i++; continue; }     // sem fechamento → "$" literal
      const inner = src.slice(i + 2, close);
      const node = parsePlaceholder(inner, ctx);
      flush(i);
      nodes.push(node ?? { kind: "text", raw: "${" + inner + "}" });
      i = close + 1;
      textStart = i;
      continue;
    }

    if (isDigit(next)) {
      const match = /^\d+/.exec(src.slice(i + 1));
      const digits = match?.[0];
      if (digits !== undefined) {
        flush(i);
        nodes.push({ kind: "stop", index: parseInt(digits, 10), hasDefault: false, children: [] });
        i += 1 + digits.length;
        textStart = i;
        continue;
      }
    }

    // $NOME — variável TM (só as reconhecidas; as demais e as sem valor ficam literais).
    const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i + 1));
    if (ident !== null) {
      const name = ident[0] ?? "";
      if (isTmVariable(name)) {
        const value = tmValue(name, ctx);
        if (value !== undefined) {
          flush(i);
          nodes.push({ kind: "text", raw: value, verbatim: true });
          i += 1 + name.length;
          textStart = i;
          continue;
        }
      }
    }

    i++; // $ seguido de identificador desconhecido ($FOO) ou char especial → literal
  }
  flush(src.length);
  return nodes;
}

/**
 * Parseia o interior de um `${...}`.
 *
 * `null` = não é placeholder válido → literal. Devolve um `StopNode` para tab stops e um
 * `TextNode` (verbatim) para **variáveis TM** resolvidas.
 */
function parsePlaceholder(inner: string, ctx: SnippetVariableContext): ParseNode | null {
  const match = /^\d+/.exec(inner);
  const digits = match?.[0];
  if (digits === undefined) {
    // ${NOME} / ${NOME:default} — variável TM (desconhecida ou sem valor → literal).
    const resolved = resolveVariable(inner, ctx);
    if (resolved === undefined) return null;
    return {
      kind: "text",
      raw: resolved.raw,
      ...(resolved.verbatim ? { verbatim: true } : {}),
    };
  }
  const index = parseInt(digits, 10);
  const rest = inner.slice(digits.length);

  if (rest.length === 0) return { kind: "stop", index, hasDefault: false, children: [] };

  if (rest.startsWith(":")) {                      // ${N:default}
    return { kind: "stop", index, hasDefault: true, children: parseRegion(rest.slice(1), ctx) };
  }

  if (rest.startsWith("|")) {                      // ${N|a,b,c|} → default = 1ª escolha
    if (rest.length < 2 || !rest.endsWith("|")) return null;
    const choices = splitChoices(rest.slice(1, rest.length - 1));
    return { kind: "stop", index, hasDefault: true, choices, children: [] };
  }

  if (rest.startsWith("/")) {                      // ${N/regex/format/flags}
    const transform = splitTransform(rest.slice(1));
    if (transform === null) {
      console.warn(`Scribe: transformação de snippet malformada em \${${inner}} — ignorada`);
      return { kind: "stop", index, hasDefault: false, children: [] };
    }
    try {
      new RegExp(transform.regex, transform.flags);
    } catch (error) {
      // Regex inválida → degrada para ocorrência simples (sem transform), com 1 warning.
      console.warn(`Scribe: regex inválida em transformação de snippet \${${inner}}`, error);
      return { kind: "stop", index, hasDefault: false, children: [] };
    }
    return { kind: "stop", index, hasDefault: false, transform, children: [] };
  }

  return null;                                     // sintaxe desconhecida → literal
}

// ---- transformação -------------------------------------------------------------------------------

/**
 * Aplica `${N/regex/format/flags}` a `content`.
 *
 * O `format` aceita `$&` (match inteiro), `$0`..`$99` e `${N}` (grupos; inexistente → `""`)
 * e `$$` (`$` literal). Regex inválida → devolve `content` **bruto** com 1 `console.warn`
 * (não deve acontecer: a parse já valida, mas a função é pública e testada isoladamente).
 */
export function renderTransform(content: string, regex: string, format: string, flags: string): string {
  let re: RegExp;
  try {
    re = new RegExp(regex, flags);
  } catch (error) {
    console.warn("Scribe: regex inválida em transformação de snippet — conteúdo bruto mantido", error);
    return content;
  }
  return content.replace(re, (...args: unknown[]): string => {
    const match = String(args[0] ?? "");
    const rest = args.slice(1);
    // Assinatura do replacer: (match, p1..pn, offset, string, groupsNomeadas?)
    const last = rest[rest.length - 1];
    if (typeof last === "object" && last !== null) rest.pop(); // grupos nomeados (objeto)
    rest.pop(); // string completo
    rest.pop(); // offset
    const groups = rest.map((g) => (g === undefined || g === null ? "" : String(g)));
    return expandFormat(format, match, groups);
  });
}

/** Expande o `format` de uma transformação contra o match e os grupos capturados. */
function expandFormat(format: string, match: string, groups: readonly string[]): string {
  const groupAt = (n: number): string => (n === 0 ? match : groups[n - 1] ?? "");
  let out = "";
  let i = 0;
  while (i < format.length) {
    const c = format[i]!;
    if (c !== "$") { out += c; i++; continue; }
    const n1 = format[i + 1];
    if (n1 === undefined) { out += c; i++; continue; }
    if (n1 === "$") { out += "$"; i += 2; continue; }
    if (n1 === "&") { out += match; i += 2; continue; }
    if (n1 === "{") {
      const m = /^\$\{(\d+)\}/.exec(format.slice(i));
      if (m !== null) { out += groupAt(parseInt(m[1]!, 10)); i += m[0].length; continue; }
      out += c; i++; continue;
    }
    if (isDigit(n1)) {
      const m = /^\$(\d{1,2})/.exec(format.slice(i));
      if (m !== null) { out += groupAt(parseInt(m[1]!, 10)); i += m[0].length; continue; }
    }
    out += c; i++;
  }
  return out;
}

// ---- expansão --------------------------------------------------------------------------------------

/** Estado da expansão: primárias por índice, valores memoizados e acumulador de emissão. */
interface EmitState {
  readonly primaries: Map<number, StopNode>;
  readonly values: Map<number, string>;
  readonly visiting: Set<number>;
  readonly occurrences: SnippetOccurrence[];
  /** Contador de `id` — **reservado antes** de emitir os filhos (senão pai e filho colidem). */
  nextId: number;
  text: string;
}

/** Caminho em ordem do documento, marcando a primária de cada índice. */
function markPrimaries(nodes: readonly ParseNode[], primaries: Map<number, StopNode>): void {
  for (const node of nodes) {
    if (node.kind !== "stop") continue;
    const current = primaries.get(node.index);
    // Regra: primeira ocorrência COM default; na ausência de default, a primeira ocorrência.
    if (current === undefined || (!current.hasDefault && node.hasDefault)) {
      primaries.set(node.index, node);
    }
    if (node.children.length > 0) markPrimaries(node.children, primaries);
  }
}

/** Valor atual da primária de `index` (memoizado; ciclos — auto-referência — degradam para ""). */
function valueOf(state: EmitState, index: number): string {
  const cached = state.values.get(index);
  if (cached !== undefined) return cached;
  const primary = state.primaries.get(index);
  if (primary === undefined) return "";
  if (state.visiting.has(index)) return ""; // ciclo: `${1:a $1 b}`
  state.visiting.add(index);
  let value: string;
  if (primary.choices !== undefined) value = primary.choices[0] ?? ""; // escolha: default = 1ª
  else if (primary.hasDefault) value = nodesToString(state, primary.children);
  else if (primary.transform !== undefined) {
    const t = primary.transform;
    value = renderTransform("", t.regex, t.format, t.flags);
  } else value = "";
  state.visiting.delete(index);
  state.values.set(index, value);
  return value;
}

/** Renderiza nós para uma string (usado no cálculo de valores; sem ranges). */
function nodesToString(state: EmitState, nodes: readonly ParseNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      out += node.verbatim === true ? node.raw : unescape(node.raw);
      continue;
    }
    const value = valueOf(state, node.index);
    const isPrimary = state.primaries.get(node.index) === node;
    if (!isPrimary) {
      out += node.transform !== undefined
        ? renderTransform(value, node.transform.regex, node.transform.format, node.transform.flags)
        : value;
    } else if (node.choices !== undefined) {
      out += node.choices[0] ?? "";
    } else if (node.hasDefault) {
      out += nodesToString(state, node.children);
    } else if (node.transform !== undefined) {
      const t = node.transform;
      out += renderTransform("", t.regex, t.format, t.flags);
    }
  }
  return out;
}

/**
 * Passo final: emite o texto e registra as ocorrências com ranges. Espelhos saem **renderizados**
 * com o valor da primária (aplicando o `transform` da própria ocorrência quando houver).
 * `parentId` é o `id` da ocorrência que está sendo emitida ao redor (aninhamento).
 */
function emit(state: EmitState, nodes: readonly ParseNode[], parentId: number): void {
  for (const node of nodes) {
    if (node.kind === "text") {
      state.text += node.verbatim === true ? node.raw : unescape(node.raw);
      continue;
    }
    const isPrimary = state.primaries.get(node.index) === node;
    const start = state.text.length;
    // Reserva o id ANTES de emitir os filhos: as ocorrências filhas são pushadas primeiro
    // (o range delas fecha antes do da contenedora), e o `parentId` delas aponta para cá.
    const id = state.nextId++;
    if (isPrimary) {
      if (node.choices !== undefined) state.text += node.choices[0] ?? ""; // default = 1ª opção
      else if (node.hasDefault) emit(state, node.children, id);
      else if (node.transform !== undefined) {
        const t = node.transform;
        state.text += renderTransform("", t.regex, t.format, t.flags);
      }
    } else {
      const value = valueOf(state, node.index);
      state.text += node.transform !== undefined
        ? renderTransform(value, node.transform.regex, node.transform.format, node.transform.flags)
        : value;
    }
    state.occurrences.push({
      id,
      parentId,
      index: node.index,
      start,
      end: state.text.length,
      defaultValue: state.text.slice(start),
      isPrimary,
      ...(node.transform !== undefined ? { transform: node.transform } : {}),
      ...(node.choices !== undefined ? { choices: node.choices, choiceIndex: 0 } : {}),
    });
  }
}

/**
 * Parseia um template de snippet e retorna o texto expandido + metadados dos tabstops.
 *
 * `text` já traz espelhos renderizados; `tabStops` são só as **primárias**, na ordem de visita
 * (índices ascendentes, `$0` por último); `occurrences` traz tudo (inclusive espelhos, com
 * ranges) e `visitOrder` dá a sequência de índices que a sessão percorre.
 *
 * `ctx` (opcional) resolve as **variáveis TM** durante a parse — assim os offsets das tab stops
 * continuam coerentes com o texto final. Sem `ctx`, toda variável TM fica **literal**.
 */
export function parseSnippet(template: string, ctx?: SnippetVariableContext): SnippetExpansion {
  const context: SnippetVariableContext = ctx ?? {};
  const root = parseRegion(template, context);
  const primaries = new Map<number, StopNode>();
  markPrimaries(root, primaries);

  const state: EmitState = {
    primaries,
    values: new Map<number, string>(),
    visiting: new Set<number>(),
    occurrences: [],
    nextId: 0,
    text: "",
  };
  emit(state, root, -1);

  // Ordem de visita: índices ascendentes, $0 por último; só o que tem primária emitida.
  const seen = new Set<number>();
  for (const occ of state.occurrences) {
    if (occ.isPrimary) seen.add(occ.index);
  }
  const visitOrder = [...seen].sort((a, b) => {
    if (a === 0) return 1;
    if (b === 0) return -1;
    return a - b;
  });

  const tabStops: TabStop[] = [];
  for (const index of visitOrder) {
    const primary = state.occurrences.find((o) => o.index === index && o.isPrimary);
    if (primary !== undefined) tabStops.push(primary);
  }

  return { text: state.text, tabStops, occurrences: state.occurrences, visitOrder };
}