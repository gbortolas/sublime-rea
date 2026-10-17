/**
 * Scribe — modelo puro do **find bar** (busca/substituição no renderer).
 *
 * Sem DOM de propósito: a lógica (debounce, navegação com *wrap*, descarte de resposta obsoleta,
 * contagem, replace-all) vive aqui e é testada por vitest; `src/renderer/main.ts` só reflete o
 * estado no DOM e move caret/scroll ao selecionar uma ocorrência.
 *
 * **Escolha nossa:** as dependências são **injetadas** (`find`/`replaceAll` da ponte, agenda de
 * debounce e relógio) — nada de `setTimeout` cru no corpo da classe, o que mantém o teste
 * determinístico. Mesmo idioma do `HighlightStore` para descartar resposta velha: identidade do
 * documento + revisão, e um `seq` de requisição que só deixa a **última** resposta valer.
 */
import type {
  ReplaceAllResult,
  SearchDocumentResult,
  SearchMatch,
  SearchQuery,
} from "../shared";

/** Superfície da ponte consumida pelo find bar (satisfeita por `window.scribe`). */
export interface FindBarApi {
  find(query: SearchQuery): Promise<SearchDocumentResult>;
  replaceAll(query: SearchQuery, replacement: string): Promise<ReplaceAllResult>;
}

/** Estado observável do find bar — o DOM só reflete isto. */
export interface FindBarState {
  readonly open: boolean;
  readonly pattern: string;
  readonly replacement: string;
  /** Total de ocorrências da última busca aplicada. */
  readonly total: number;
  /** Ocorrência atual, **1-based** (`0` quando não há ocorrências). */
  readonly current: number;
  /** A busca foi truncada (há mais ocorrências além do teto). */
  readonly truncated: boolean;
  /** Mensagem de status (nº de substituições ou erro). */
  readonly status: string | undefined;
  /** Carimbo de tempo (ms) da última busca aplicada — `now` injetável. */
  readonly searchedAt: number;
  readonly caseSensitive: boolean;
  readonly regex: boolean;
  readonly wholeWord: boolean;
}

/** Agenda de debounce injetável; devolve o cancelador. */
export type DebounceScheduler = (cb: () => void, ms: number) => () => void;

export interface FindBarOptions {
  readonly api: FindBarApi;
  readonly schedule: DebounceScheduler;
  readonly now?: () => number;
  readonly debounceMs?: number;
  /** Notificado a cada mudança de estado (o renderer redesenha o DOM). */
  readonly onChange?: (state: FindBarState) => void;
  /** Notificado quando a ocorrência atual muda (navegação ou nova busca) — move caret/scroll. */
  readonly onSelect?: (match: SearchMatch) => void;
}

/** Debounce default do find bar (ms). */
export const FIND_DEBOUNCE_MS = 150;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Agenda de debounce de produção (o **único** lugar com `setTimeout`). Injetada no modelo.
 */
export function createDebounceScheduler(): DebounceScheduler {
  return (cb: () => void, ms: number): (() => void) => {
    const handle = setTimeout(cb, ms);
    return () => clearTimeout(handle);
  };
}

export class FindBarModel {
  private openFlag = false;
  private patternValue = "";
  private replacementValue = "";
  private matches: readonly SearchMatch[] = [];
  private currentIndex = 0;
  private truncatedFlag = false;
  private statusValue: string | undefined;
  private docKey = "";
  private revision = -1;
  private requestSeq = 0;
  private searchedAt = 0;
  private cancelDebounce: (() => void) | undefined;
  private caseSensitiveValue = false;
  private regexValue = false;
  private wholeWordValue = false;

  constructor(private readonly options: FindBarOptions) {}

  get isOpen(): boolean {
    return this.openFlag;
  }

  get pattern(): string {
    return this.patternValue;
  }

  get caseSensitive(): boolean {
    return this.caseSensitiveValue;
  }

  get regex(): boolean {
    return this.regexValue;
  }

  get wholeWord(): boolean {
    return this.wholeWordValue;
  }

  state(): FindBarState {
    return {
      open: this.openFlag,
      pattern: this.patternValue,
      replacement: this.replacementValue,
      total: this.matches.length,
      current: this.matches.length === 0 ? 0 : this.currentIndex + 1,
      truncated: this.truncatedFlag,
      status: this.statusValue,
      searchedAt: this.searchedAt,
      caseSensitive: this.caseSensitiveValue,
      regex: this.regexValue,
      wholeWord: this.wholeWordValue,
    };
  }

  /** A ocorrência atual (para o renderer rolar até ela), ou `undefined`. */
  currentMatch(): SearchMatch | undefined {
    return this.matches[this.currentIndex];
  }

  /** Todas as ocorrências da última busca (para o renderer pintar no canvas). */
  get allMatches(): readonly SearchMatch[] {
    return this.matches;
  }

  /** Índice (`0`-based) da ocorrência atual em `allMatches`, ou `-1` se não houver. */
  get currentMatchIndex(): number {
    return this.matches.length === 0 ? -1 : this.currentIndex;
  }

  /** Abre o find bar (Ctrl/Cmd+F) e dispara a busca se já houver padrão. */
  open(): void {
    if (this.openFlag) return;
    this.openFlag = true;
    this.emit();
    if (this.patternValue.length > 0) this.scheduleSearch();
  }

  /** Fecha o find bar; `true` quando estava aberto (o `Esc` do renderer consome só nesse caso). */
  close(): boolean {
    if (!this.openFlag) return false;
    this.openFlag = false;
    this.caseSensitiveValue = false;
    this.regexValue = false;
    this.wholeWordValue = false;
    this.cancelPending();
    this.emit();
    return true;
  }

  setPattern(value: string): void {
    if (this.patternValue === value) return;
    this.patternValue = value;
    this.statusValue = undefined;
    if (value.length === 0) {
      // Padrão vazio: nada a buscar. Limpa a contagem em vez de disparar `search.emptyPattern`
      // (e invalida qualquer resposta em voo, para ela não repintar a contagem antiga).
      this.cancelPending();
      this.requestSeq += 1;
      this.matches = [];
      this.currentIndex = 0;
      this.truncatedFlag = false;
      this.emit();
      return;
    }
    if (this.openFlag) this.scheduleSearch();
    else this.emit();
  }

  setReplacement(value: string): void {
    if (this.replacementValue === value) return;
    this.replacementValue = value;
    this.emit();
  }

  /**
   * Atualiza a identidade/revisão do documento ativo. Trocar de documento **descarta** tudo e
   * invalida respostas em voo; uma revisão mais nova dispara nova busca (se aberto).
   */
  setDocument(docKey: string, revision: number): void {
    if (this.docKey !== docKey) {
      this.docKey = docKey;
      this.revision = revision;
      this.matches = [];
      this.currentIndex = 0;
      this.truncatedFlag = false;
      this.statusValue = undefined;
      this.cancelPending();
      this.requestSeq += 1; // in-flight do documento anterior nunca aplica
      this.emit();
      return;
    }
    if (revision > this.revision) {
      this.revision = revision;
      if (this.openFlag && this.patternValue.length > 0) this.scheduleSearch();
    }
  }

  /** Próxima ocorrência, com *wrap*. */
  next(): void {
    this.move(1);
  }

  /** Ocorrência anterior, com *wrap*. */
  previous(): void {
    this.move(-1);
  }

  /** Substitui todas as ocorrências do padrão atual pelo texto de substituição. */
  async replaceAll(): Promise<void> {
    if (!this.openFlag) return;
    try {
      const result = await this.options.api.replaceAll(this.query(), this.replacementValue);
      this.statusValue = `${result.replaced} substituição(ões)`;
      this.emit();
      // Contagem fresca (o texto já mudou): nova busca, mesmo caminho do debounce.
      if (this.patternValue.length > 0) this.scheduleSearch();
    } catch (error) {
      this.statusValue = describeError(error);
      this.emit();
    }
  }

  toggleCaseSensitive(): void {
    this.caseSensitiveValue = !this.caseSensitiveValue;
    if (this.openFlag && this.patternValue.length > 0) this.scheduleSearch();
    this.emit();
  }

  toggleRegex(): void {
    this.regexValue = !this.regexValue;
    if (this.openFlag && this.patternValue.length > 0) this.scheduleSearch();
    this.emit();
  }

  toggleWholeWord(): void {
    this.wholeWordValue = !this.wholeWordValue;
    if (this.openFlag && this.patternValue.length > 0) this.scheduleSearch();
    this.emit();
  }

  setToggles(caseSensitive: boolean, regex: boolean, wholeWord: boolean): void {
    this.caseSensitiveValue = caseSensitive;
    this.regexValue = regex;
    this.wholeWordValue = wholeWord;
    if (this.openFlag && this.patternValue.length > 0) this.scheduleSearch();
    this.emit();
  }

  dispose(): void {
    this.cancelPending();
  }

  // ---- interno -------------------------------------------------------------------------------

  private query(): SearchQuery {
    return {
      pattern: this.patternValue,
      ...(this.caseSensitiveValue ? { caseSensitive: true } : {}),
      ...(this.regexValue ? { regex: true } : {}),
      ...(this.wholeWordValue ? { wholeWord: true } : {}),
    };
  }

  private move(step: number): void {
    const count = this.matches.length;
    if (count === 0) return;
    this.currentIndex = (this.currentIndex + step + count) % count;
    this.selectCurrent();
    this.emit();
  }

  private selectCurrent(): void {
    const match = this.matches[this.currentIndex];
    if (match !== undefined) this.options.onSelect?.(match);
  }

  private cancelPending(): void {
    if (this.cancelDebounce !== undefined) {
      this.cancelDebounce();
      this.cancelDebounce = undefined;
    }
  }

  private scheduleSearch(): void {
    this.cancelPending();
    const seq = ++this.requestSeq;
    const query = this.query();
    this.cancelDebounce = this.options.schedule(() => {
      this.cancelDebounce = undefined;
      void this.runSearch(seq, query);
    }, this.options.debounceMs ?? FIND_DEBOUNCE_MS);
  }

  private async runSearch(seq: number, query: SearchQuery): Promise<void> {
    const docKey = this.docKey;
    const revision = this.revision;
    try {
      const response = await this.options.api.find(query);
      // Descarte de resposta velha (mesmo idioma do `HighlightStore`): só a requisição mais
      // recente, do mesmo documento e de revisão não superada, vira estado.
      if (seq !== this.requestSeq) return;
      if (docKey !== this.docKey) return;
      if (revision !== -1 && response.revision < revision) return;
      this.matches = response.result.matches;
      this.truncatedFlag = response.result.truncated;
      this.currentIndex = 0;
      this.searchedAt = this.options.now?.() ?? 0;
      this.emit();
      this.selectCurrent();
    } catch (error) {
      // Mesmo descarte do caminho de sucesso: erro de requisição **velha** (seq superado, documento
      // trocado ou revisão avançada desde o pedido) não pinta status na barra.
      if (seq !== this.requestSeq) return;
      if (docKey !== this.docKey) return;
      if (revision !== -1 && revision !== this.revision) return;
      this.matches = [];
      this.currentIndex = 0;
      this.truncatedFlag = false;
      this.statusValue = describeError(error);
      this.emit();
    }
  }

  private emit(): void {
    this.options.onChange?.(this.state());
  }
}
