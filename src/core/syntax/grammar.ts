/**
 * Scribe — `grammar.ts`: **compilador** da gramática (DEC-PKG-8).
 *
 * Normaliza a definição parseada (`GrammarDefinition`) e a compila para a forma executável
 * (`SyntaxGrammar`), resolvendo:
 * - o contexto inicial `main` (**obrigatório**; falta = `GrammarParseError`);
 * - o contexto implícito `prototype` (anexado ao fim de todo contexto, exceto de si mesmo);
 * - `extends` (herança por nome lógico, via **resolvedor injetado**);
 * - `include` por **nome lógico** (local = contexto deste arquivo; com `/` ou `.sublime-syntax` =
 *   outra gramática, opcionalmente `#contexto`);
 * - `variables` (`{{nome}}` expandido em `match`/`scope`/`captures`/`include`/`push`/`set`).
 *
 * Escolhas nossas (a spec deixava em aberto):
 * - um `include` de outra gramática **funde** os contextos dela na tabela compilada (o contexto
 *   local vence em colisão de nome) — evita um segundo namespace de contextos;
 * - `include: "scope:…"` (selector de escopo) **não** é suportado → `GrammarIncludeError`;
 * - `push`/`set`/`include` que não resolvem → `GrammarIncludeError` (nunca silencioso);
 * - cada contexto guarda o **escopo da gramática que o definiu** (`contextScopes`): o trecho sem
 *   regra usa o escopo da gramática do contexto do topo, não o da gramática-raiz;
 * - `captures` que aponta para grupo inexistente no regex → **aviso único** (não é erro fatal);
 * - regexes são `RegExp` com as flags `d`+`y` (posições de grupo + casamento ancorado em `lastIndex`).
 */
import { GrammarIncludeError, GrammarParseError } from "../../shared";
import type {
  GrammarContext,
  GrammarDefinition,
  GrammarPattern,
  Scope,
  SyntaxGrammar,
} from "../../shared";
import { parseYamlSubset } from "./yaml";
import {
  tokenizeCompiledLine,
  type CompiledCapture,
  type CompiledGrammar,
  type CompiledPattern,
} from "./tokenizer";

const INITIAL_CONTEXT = "main";
const PROTOTYPE_CONTEXT = "prototype";

/**
 * Resolvedor mínimo de gramáticas por **nome lógico** (em produção o registro alimentado pelo
 * `PackageResolver`; em teste um stub). Síncrono: quem lê arquivo é o chamador.
 */
export interface GrammarDefinitionResolver {
  resolveDefinition(logicalName: string): GrammarDefinition | undefined;
}

/** Parseia + normaliza um documento de gramática. Atalho para o registro. */
export function normalizeGrammar(
  source: string,
  logicalName: string,
): GrammarDefinition {
  return normalizeGrammarDocument(parseYamlSubset(source, logicalName), logicalName);
}

/** Normaliza o valor parseado (YAML/JSON) na forma `GrammarDefinition`. */
export function normalizeGrammarDocument(raw: unknown, logicalName: string): GrammarDefinition {
  const record = asRecord(raw, logicalName, "documento");
  const name = requireString(record["name"], logicalName, "name") ?? logicalName;
  const scope = optionalString(record["scope"], logicalName, "scope") ?? "text.plain";
  const version = optionalVersion(record["version"], logicalName);
  const fileExtensions = normalizeExtensions(record["file_extensions"], logicalName);
  const contexts = normalizeContexts(record["contexts"], logicalName);
  const variables = normalizeVariables(record["variables"], logicalName);
  const extendsName = optionalString(record["extends"], logicalName, "extends");
  const hidden = optionalBoolean(record["hidden"], logicalName, "hidden") ?? false;

  return {
    logicalName,
    name,
    scope,
    ...(version !== undefined ? { version } : {}),
    fileExtensions,
    contexts,
    variables,
    ...(extendsName !== undefined ? { extends: extendsName } : {}),
    hidden,
  };
}

/**
 * Compila uma definição normalizada em gramática executável.
 *
 * Limites conhecidos (mitigação de custo em `tokenizer.ts`): gramática é **dado não confiável**
 * aplicado a texto do usuário, então o motor tem teto de linha e degradação explícita; capturas que
 * apontam para grupo inexistente geram **um aviso por gramática/regra** (ver `validateCaptures`).
 */
export function compileGrammar(
  definition: GrammarDefinition,
  resolver: GrammarDefinitionResolver,
): SyntaxGrammar {
  const compiled = compileGrammarInner(definition, resolver);
  return {
    logicalName: compiled.logicalName,
    name: compiled.name,
    scope: compiled.scope,
    fileExtensions: compiled.fileExtensions,
    tokenizeLine: (line: string, state: unknown) => tokenizeCompiledLine(compiled, line, state),
  };
}

/**
 * Compila e devolve a forma interna (`CompiledGrammar`), usada pelo `GrammarRegistry` para
 * serialização e cache da estrutura compilada.
 */
export function compileGrammarInner(
  definition: GrammarDefinition,
  resolver: GrammarDefinitionResolver,
): CompiledGrammar {
  const collected = new DefinitionCollector(definition, resolver).collect();
  const compiledContexts = compileContexts(definition, collected);
  return {
    logicalName: definition.logicalName,
    name: definition.name,
    scope: definition.scope,
    fileExtensions: definition.fileExtensions,
    contexts: compiledContexts,
    contextScopes: collected.contextScopes,
  };
}

// ---- coleta de definições (extends + include de outras gramáticas) ------------------------------

interface CollectedDefinitions {
  readonly contexts: ReadonlyMap<string, readonly GrammarPattern[]>;
  readonly variables: ReadonlyMap<string, string>;
  /** Escopo-base da gramática **dona** de cada contexto (o dono é quem primeiro o definiu). */
  readonly contextScopes: ReadonlyMap<string, Scope>;
}

class DefinitionCollector {
  private readonly contexts = new Map<string, readonly GrammarPattern[]>();
  private readonly variables = new Map<string, string>();
  private readonly contextScopes = new Map<string, Scope>();
  private readonly visited = new Set<string>();

  constructor(
    private readonly root: GrammarDefinition,
    private readonly resolver: GrammarDefinitionResolver,
  ) {}

  collect(): CollectedDefinitions {
    this.merge(this.root, true);
    // Ponto fixo: gramáticas referenciadas por `include` trazem seus próprios `include`s.
    let merged = true;
    while (merged) {
      merged = false;
      for (const reference of this.grammarReferences()) {
        if (this.visited.has(reference)) continue;
        const definition = this.resolver.resolveDefinition(reference);
        if (definition === undefined) {
          throw new GrammarIncludeError(this.root.logicalName, reference, "gramática não encontrada");
        }
        this.merge(definition, false);
        merged = true;
      }
    }
    if (!this.contexts.has(INITIAL_CONTEXT)) {
      throw new GrammarParseError(this.root.logicalName, `contexto inicial '${INITIAL_CONTEXT}' obrigatório`);
    }
    return { contexts: this.contexts, variables: this.variables, contextScopes: this.contextScopes };
  }

  private merge(definition: GrammarDefinition, overwrite: boolean): void {
    if (this.visited.has(definition.logicalName)) return;
    this.visited.add(definition.logicalName);
    if (definition.extends !== undefined) {
      const parent = this.resolver.resolveDefinition(definition.extends);
      if (parent === undefined) {
        throw new GrammarIncludeError(definition.logicalName, definition.extends, "gramática base não encontrada");
      }
      this.merge(parent, overwrite);
    }
    for (const context of definition.contexts) {
      if (overwrite || !this.contexts.has(context.name)) {
        this.contexts.set(context.name, context.patterns);
        this.contextScopes.set(context.name, definition.scope);
      }
    }
    for (const [key, value] of Object.entries(definition.variables)) {
      if (overwrite || !this.variables.has(key)) this.variables.set(key, value);
    }
  }

  /** Nomes lógicos de gramática referenciados por `include` (ignora includes locais e `scope:`). */
  private grammarReferences(): string[] {
    const references = new Set<string>();
    for (const patterns of this.contexts.values()) {
      for (const pattern of patterns) {
        const include = pattern.include;
        if (include === undefined) continue;
        const target = grammarReferenceOf(include);
        if (target !== undefined) references.add(target);
      }
    }
    return [...references];
  }
}

/** Devolve o nome lógico da gramática se o `include` for de outra gramática; senão `undefined`. */
function grammarReferenceOf(reference: string): string | undefined {
  const { grammar } = splitInclude(reference);
  return grammar ?? undefined;
}

interface SplitInclude {
  readonly grammar: string | null;
  readonly context: string;
}

/**
 * `include` de contexto local (`"foo"`, `"main"`) ou de outra gramática
 * (`"Packages/X/X.sublime-syntax"`, `"Packages/X/X.sublime-syntax#ctx"`).
 */
function splitInclude(reference: string): SplitInclude {
  const hash = reference.indexOf("#");
  const before = hash >= 0 ? reference.slice(0, hash) : reference;
  const after = hash >= 0 ? reference.slice(hash + 1) : "";
  const isGrammar = before.includes("/") || before.toLowerCase().endsWith(".sublime-syntax");
  if (isGrammar) return { grammar: before, context: after.length > 0 ? after : INITIAL_CONTEXT };
  return { grammar: null, context: before };
}

// ---- compilação dos contextos --------------------------------------------------------------------

function compileContexts(
  definition: GrammarDefinition,
  collected: CollectedDefinitions,
): ReadonlyMap<string, readonly CompiledPattern[]> {
  const compiler = new PatternCompiler(definition, collected);
  const compiled = new Map<string, readonly CompiledPattern[]>();
  for (const name of collected.contexts.keys()) {
    compiled.set(name, compiler.compileContext(name));
  }
  return compiled;
}

class PatternCompiler {
  /** Chaves já avisadas nesta compilação — o aviso é **único** por gramática/contexto/regra. */
  private readonly warnedCaptures = new Set<string>();

  constructor(
    private readonly definition: GrammarDefinition,
    private readonly collected: CollectedDefinitions,
  ) {}

  compileContext(name: string): readonly CompiledPattern[] {
    const patterns = this.collected.contexts.get(name);
    if (patterns === undefined) {
      throw new GrammarIncludeError(this.definition.logicalName, name, "contexto não existe");
    }
    const compiled = patterns.map((pattern, index) => this.compilePattern(pattern, name, index));
    if (name !== PROTOTYPE_CONTEXT && this.collected.contexts.has(PROTOTYPE_CONTEXT)) {
      compiled.push(includeRule(PROTOTYPE_CONTEXT));
    }
    return compiled;
  }

  private compilePattern(pattern: GrammarPattern, contextName: string, index: number): CompiledPattern {
    const scope = pattern.scope !== undefined ? this.expand(pattern.scope) : null;
    const captures = this.compileCaptures(pattern.captures);
    if (pattern.include !== undefined) {
      const reference = this.expand(pattern.include);
      if (reference.startsWith("scope:")) {
        throw new GrammarIncludeError(this.definition.logicalName, reference, "include por selector de escopo não é suportado");
      }
      const { context } = splitInclude(reference);
      this.requireContext(context, reference);
      return includeRule(context, scope, captures);
    }
    const source = pattern.match !== undefined ? this.expand(pattern.match) : null;
    if (source === null) {
      // Regra sem `match`/`include` (ex.: `meta_scope` isolado) — ignorada.
      return { matcher: null, scope, captures, include: null, push: null, set: null, pop: false };
    }
    const matcher = this.compileRegex(source);
    this.validateCaptures(captures, source, contextName, index);
    const push = pattern.push !== undefined ? this.expand(pattern.push) : null;
    const set = pattern.set !== undefined ? this.expand(pattern.set) : null;
    if (push !== null) this.requireContext(push, push);
    if (set !== null) this.requireContext(set, set);
    return { matcher, scope, captures, include: null, push, set, pop: pattern.pop ?? false };
  }

  /**
   * Captura que aponta para grupo que não existe no regex **não** é silenciosa: avisamos (uma vez)
   * nomeando gramática, contexto, índice da regra e chave. Escolha nossa (a spec deixava em aberto):
   * **aviso, não erro de compilação** — é o caminho mais barato e não derruba a gramática inteira
   * por um `captures` errado; o efeito no motor é nenhum (a captura não casa nenhum range).
   */
  private validateCaptures(
    captures: readonly CompiledCapture[],
    source: string,
    contextName: string,
    index: number,
  ): void {
    if (captures.length === 0) return;
    const info = captureGroupInfo(source);
    for (const capture of captures) {
      const key = capture.name ?? String(capture.group);
      const exists =
        capture.name !== null
          ? info.names.has(capture.name)
          : capture.group >= 0 && capture.group <= info.count;
      if (exists) continue;
      const warning = `${contextName}#${index}:${key}`;
      if (this.warnedCaptures.has(warning)) continue;
      this.warnedCaptures.add(warning);
      console.warn(
        `Scribe: capture "${key}" de "${this.definition.logicalName}" (contexto "${contextName}", regra #${index}) ` +
          `aponta para grupo inexistente em /${source}/ — captura ignorada no motor`,
      );
    }
  }

  private compileCaptures(captures: Readonly<Record<string, Scope>> | undefined): CompiledCapture[] {
    if (captures === undefined) return [];
    const out: CompiledCapture[] = [];
    for (const [key, rawScope] of Object.entries(captures)) {
      const scope = this.expand(rawScope);
      if (/^\d+$/.test(key)) {
        out.push({ group: Number.parseInt(key, 10), name: null, scope });
      } else {
        out.push({ group: -1, name: key, scope });
      }
    }
    return out;
  }

  private compileRegex(source: string): RegExp {
    try {
      // `d`: posições de grupo (`match.indices`); `y`: casamento ancorado em `lastIndex`.
      return new RegExp(source, "dy");
    } catch (error) {
      throw new GrammarParseError(
        this.definition.logicalName,
        `regex inválida (${source}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private requireContext(name: string, reference: string): void {
    if (!this.collected.contexts.has(name)) {
      throw new GrammarIncludeError(this.definition.logicalName, reference, `contexto "${name}" não existe`);
    }
  }

  private expand(value: string): string {
    return value.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (whole: string, name: string): string =>
      this.collected.variables.get(name) ?? whole,
    );
  }
}

function includeRule(
  context: string,
  scope: Scope | null = null,
  captures: readonly CompiledCapture[] = [],
): CompiledPattern {
  return { matcher: null, scope, captures, include: context, push: null, set: null, pop: false };
}

/**
 * Conta grupos **capturantes** e nomes de grupo de um regex-fonte, sem o motor: varredura linear que
 * respeita `\` de escape e classes `[...]`. Suficiente para saber se um `captures` aponta para grupo
 * existente (grupo `0` = casamento inteiro; numéricos válidos: `1..count`).
 */
function captureGroupInfo(source: string): { readonly count: number; readonly names: ReadonlySet<string> } {
  let count = 0;
  const names = new Set<string>();
  let inClass = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") {
      inClass = true;
      continue;
    }
    if (char !== "(") continue;
    if (source[index + 1] === "?") {
      const named = /^\(\?<([A-Za-z_$][A-Za-z0-9_$]*)>/.exec(source.slice(index));
      if (named === null) continue; // grupo não-capturante (`(?:`, lookaround, etc.)
      count += 1;
      names.add(named[1] as string);
      continue;
    }
    count += 1;
  }
  return { count, names };
}

// ---- normalização dos campos do documento ---------------------------------------------------------

function asRecord(value: unknown, logicalName: string, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GrammarParseError(logicalName, `${what} deve ser um mapa`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, logicalName: string, key: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new GrammarParseError(logicalName, `"${key}" deve ser string`);
  }
  return value;
}

function optionalString(value: unknown, logicalName: string, key: string): string | undefined {
  return requireString(value, logicalName, key);
}

function optionalVersion(value: unknown, logicalName: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  throw new GrammarParseError(logicalName, `"version" deve ser string ou número`);
}

function optionalBoolean(value: unknown, logicalName: string, key: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  throw new GrammarParseError(logicalName, `"${key}" deve ser booleano`);
}

function normalizeExtensions(value: unknown, logicalName: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new GrammarParseError(logicalName, `"file_extensions" deve ser uma lista`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new GrammarParseError(logicalName, `"file_extensions[${index}]" deve ser string`);
    }
    return item;
  });
}

function normalizeVariables(value: unknown, logicalName: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  const record = asRecord(value, logicalName, `"variables"`);
  const out: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(record)) {
    if (typeof rawValue === "string") {
      out[key] = rawValue;
      continue;
    }
    if (typeof rawValue === "number" || typeof rawValue === "boolean") {
      out[key] = String(rawValue);
      continue;
    }
    throw new GrammarParseError(logicalName, `variável "${key}" deve ser escalar`);
  }
  return out;
}

function normalizeContexts(value: unknown, logicalName: string): GrammarContext[] {
  if (value === undefined || value === null) return [];
  const record = asRecord(value, logicalName, `"contexts"`);
  const out: GrammarContext[] = [];
  for (const [name, rawPatterns] of Object.entries(record)) {
    if (rawPatterns === undefined || rawPatterns === null) {
      out.push({ name, patterns: [] });
      continue;
    }
    if (!Array.isArray(rawPatterns)) {
      throw new GrammarParseError(logicalName, `contexto "${name}" deve ser uma lista de patterns`);
    }
    out.push({
      name,
      patterns: rawPatterns.map((raw, index) => normalizePattern(raw, logicalName, name, index)),
    });
  }
  return out;
}

function normalizePattern(
  raw: unknown,
  logicalName: string,
  contextName: string,
  index: number,
): GrammarPattern {
  const record = asRecord(raw, logicalName, `pattern #${index} de "${contextName}"`);
  const match = optionalString(record["match"], logicalName, "match");
  const include = optionalString(record["include"], logicalName, "include");
  const scope = optionalString(record["scope"], logicalName, "scope");
  const push = optionalString(record["push"], logicalName, "push");
  const set = optionalString(record["set"], logicalName, "set");
  const pop = optionalBoolean(record["pop"], logicalName, "pop");
  const captures = normalizeCaptures(record["captures"], logicalName, contextName, index);
  return {
    ...(match !== undefined ? { match } : {}),
    ...(include !== undefined ? { include } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(captures !== undefined ? { captures } : {}),
    ...(push !== undefined ? { push } : {}),
    ...(set !== undefined ? { set } : {}),
    ...(pop !== undefined ? { pop } : {}),
  };
}

function normalizeCaptures(
  value: unknown,
  logicalName: string,
  contextName: string,
  index: number,
): Readonly<Record<string, Scope>> | undefined {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value, logicalName, `captures do pattern #${index} de "${contextName}"`);
  const out: Record<string, Scope> = {};
  for (const [key, rawScope] of Object.entries(record)) {
    if (typeof rawScope !== "string") {
      throw new GrammarParseError(logicalName, `capture "${key}" deve ser string`);
    }
    out[key] = rawScope;
  }
  return out;
}
