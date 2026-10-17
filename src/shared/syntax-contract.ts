/**
 * Scribe — contratos de fronteira: realce de sintaxe (gramática → tokens → tema).
 *
 * Fonte: `docs/architecture/05-empacotamento-e-recursos.md` §2.3/§3 (DEC-PKG-8: gramática = máquina
 * de estados *data-driven*; DEC-PKG-9: merge por `scope`/`selector`) e
 * `docs/architecture/04-render-e-ui.md` (o `RenderPipeline` é o consumidor dos escopos).
 *
 * Clean-room: os **nomes de chave** do formato (`match`/`scope`/`captures`/`include`/`push`/`set`/
 * `pop`) vêm do contrato **observável** do formato (§2.3), não de conteúdo de gramática do alvo.
 * A gramática de brinquedo em `assets/grammars/scribe-demo.sublime-syntax` é **escolha nossa**
 * (não observada no alvo) e serve só para provar o caminho de ponta a ponta.
 *
 * Dois estágios: a forma **normalizada** (`GrammarDefinition`, resultado de parsear o YAML
 * subconjunto) e a forma **compilada/executável** (`SyntaxGrammar`, já com `include`/`extends`/
 * `variables` resolvidos e capaz de casar linha a linha).
 */
import type { RGBA } from "./render-contract";

/** Escopo de sintaxe textual, na convenção do formato (ex.: `"source.js"`, `"keyword.control"`). */
export type Scope = string;

/**
 * Faixa de destaque de **uma linha**. `start`/`end` são offsets em **code units UTF-16 dentro da
 * linha** (`end` exclusivo). Os spans emitidos pelo tokenizador são **não sobrepostos** e cobrem a
 * linha inteira (o trecho sem regra fica com o escopo-base da gramática).
 */
export interface HighlightSpan {
  readonly start: number;
  readonly end: number;
  readonly scope: Scope;
}

/**
 * Regra **normalizada** de um contexto. Exatamente uma de `match`/`include` é esperada; uma regra
 * sem nenhum dos dois (ex.: um `meta_scope` isolado) é **ignorada** pelo motor.
 */
export interface GrammarPattern {
  readonly match?: string;
  readonly include?: string;
  readonly scope?: Scope;
  /** Grupos de captura → escopo (`"1"`/`"0"` numérico, ou o nome de um grupo nomeado do regex). */
  readonly captures?: Readonly<Record<string, Scope>>;
  readonly push?: string;
  readonly set?: string;
  readonly pop?: boolean;
}

/** Contexto nomeado: uma lista **ordenada** de regras (DEC-PKG-8). */
export interface GrammarContext {
  readonly name: string;
  readonly patterns: readonly GrammarPattern[];
}

/**
 * Forma normalizada de uma gramática já parseada (sem `include`/`extends` resolvidos ainda).
 * Chaves de topo do formato (§2.3): `name`, `scope`, `version`, `file_extensions`, `contexts`,
 * `variables`, `extends`, `hidden`.
 */
export interface GrammarDefinition {
  /** Nome lógico no namespace de recursos (chave de `include`/`extends`). */
  readonly logicalName: string;
  readonly name: string;
  readonly scope: Scope;
  readonly version?: string;
  readonly fileExtensions: readonly string[];
  readonly contexts: readonly GrammarContext[];
  readonly variables: Readonly<Record<string, string>>;
  readonly extends?: string;
  readonly hidden: boolean;
}

/** Resultado de tokenizar uma linha: os spans + o estado opaco a passar para a próxima linha. */
export interface LineTokenization {
  readonly spans: readonly HighlightSpan[];
  readonly state: unknown;
}

/**
 * Gramática **compilada/executável** (DEC-PKG-8). `state` é **opaco** na fronteira: quem tokeniza
 * recebe de volta o que devolveu da linha anterior (pilha de contextos, na implementação atual).
 */
export interface SyntaxGrammar {
  readonly logicalName: string;
  readonly name: string;
  readonly scope: Scope;
  readonly fileExtensions: readonly string[];
  tokenizeLine(line: string, state: unknown): LineTokenization;
}

/**
 * Registro de gramáticas por extensão de arquivo (alimentado a partir dos recursos `kind:"syntax"`
 * do `PackageResolver` — quem lê o arquivo é o chamador, o registro é puro quanto ao I/O).
 */
export interface GrammarRegistry {
  /**
   * Registra uma gramática pelo texto-fonte (subconjunto YAML ou JSON) e devolve a definição
   * normalizada. Lança `GrammarParseError` se o texto não for parseável.
   */
  register(logicalName: string, source: string): GrammarDefinition;
  /**
   * Gramática compilada para a extensão (com ou sem o ponto, case-insensitive) — **compila sob
   * demanda** e pode lançar `GrammarIncludeError`. `undefined` quando não há gramática.
   */
  forExtension(extension: string): SyntaxGrammar | undefined;
  dispose(): void;
}

/** Destaque de uma linha do documento (índice absoluto de linha + spans). */
export interface HighlightLine {
  readonly line: number;
  readonly spans: readonly HighlightSpan[];
}

/**
 * Payload **serializável** do destaque de um range de linhas de um documento — atravessa o IPC
 * `syntax.highlight` (main → renderer). O renderer resolve escopo → cor com o seu `ThemeResolver`.
 */
export interface DocumentHighlight {
  readonly revision: number;
  readonly first: number;
  readonly lines: readonly HighlightLine[];
}

/** Estilo visual associado a um escopo (cor + traços). */
export interface ScopeStyle {
  readonly color: RGBA;
  readonly bold?: boolean;
  readonly italic?: boolean;
}

/**
 * Resolve o estilo de um escopo (DEC-PKG-9, lado da aparência). `undefined` = sem regra; o
 * consumidor cai na cor default do layout.
 */
export interface ThemeResolver {
  styleFor(scope: Scope): ScopeStyle | undefined;
}

/** Erro tipado: texto de gramática malformado (YAML subconjunto/JSON) ou estrutura inválida. */
export class GrammarParseError extends Error {
  readonly logicalName: string;
  readonly line: number | undefined;

  constructor(logicalName: string, message: string, line?: number) {
    super(`GrammarParseError[${logicalName}${line !== undefined ? `:${line}` : ""}]: ${message}`);
    this.name = "GrammarParseError";
    this.logicalName = logicalName;
    this.line = line;
  }
}

/** Erro tipado: `include`/`extends`/`push`/`set` que não resolve (ou `scope:` não suportado). */
export class GrammarIncludeError extends Error {
  readonly logicalName: string;
  readonly reference: string;

  constructor(logicalName: string, reference: string, message: string) {
    super(`GrammarIncludeError[${logicalName}]: "${reference}" — ${message}`);
    this.name = "GrammarIncludeError";
    this.logicalName = logicalName;
    this.reference = reference;
  }
}
