/**
 * Scribe — contratos de fronteira: concorrência, scheduling e pools.
 *
 * Fonte: `docs/architecture/02-concorrencia-e-scheduling.md` (DEC-CON-1..12).
 *
 * Reconciliação: o doc escreve `Task<T>`; aqui o resultado é **derivado** do `kind`
 * (`Task<K>` + `TaskResultMap`), para que `TaskPool.run` devolva o tipo certo sem anotação.
 *
 * Invariantes que os tipos **não** conseguem expressar (mas o teste tem que provar):
 * - a UI/main thread nunca bloqueia (DEC-CON-1) — proibido `Atomics.wait` fora de worker;
 * - resultado de task é **serializável** e a task é **cancelável** (DEC-CON-4);
 * - `SharedArrayBuffer` só carrega contadores/flags — strings/objetos vão por
 *   `postMessage`/`Transferable` (DEC-CON-11);
 * - teto de pool = `min(setting, cpus − 1)` (DEC-CON-9).
 */
import type { DocumentHandle } from "./handles";
import type { IndexResult, LineScanResult } from "./buffer-contract";
import type { SearchQuery, SearchResult } from "./search-contract";
import type { DocumentHighlight } from "./syntax-contract";
import type { GrepResult, GrepTaskPayload } from "./grep-contract";

/**
 * Lanes de trabalho (DEC-CON-5): `io` = N fixo, `fileRead` ≤ 2 on-demand, `index` = cold-start.
 *
 * ⚠️ A lane `grep` é **nova** (2026-10-21): a busca em **todos os arquivos** da workspace é
 * CPU-bound (e a I/O dela é de leitura) — ela **não** pode competir com a busca **interativa**
 * do find bar (lane `index`, 1 worker): um grep longo **atrasaria** o find bar. Lane própria ⇒
 * o grep é isolado (e um worker travado por regex patológica só derruba o grep).
 */
export type PoolLane = "io" | "index" | "fileRead" | "grep";

/** Prioridade de marshalling ao main thread (DEC-CON-3). */
export type Priority = "input" | "edit" | "layout" | "background";

/** Os dois "mains" do Scribe: processo Node e renderer Chromium (DEC-CON-2). */
export type SchedulerTarget = "main" | "renderer";

/** Payloads por tipo de task — o tipo do resultado é derivado daqui. */
export interface TaskResultMap {
  readFile: string;
  writeFile: void;
  scanLines: LineScanResult;
  index: IndexResult;
  search: SearchResult;
  syntaxTokens: DocumentHighlight;
  /**
   * A busca em **todos os arquivos** da workspace (o "grep").
   *
   * ⚠️ O resultado **não** carrega `doc`/`generation` — o pool não consegue detectar
   * "geração vencida" por ele (a comparação é feita pelo chamador, como no `search`).
   */
  grep: GrepResult;
}

export type TaskKind = keyof TaskResultMap;

interface TaskSpecByKind {
  readFile: { readonly kind: "readFile"; readonly path: string; readonly range?: { readonly offset: number; readonly length: number } };
  writeFile: { readonly kind: "writeFile"; readonly path: string; readonly data: ArrayBuffer };
  scanLines: { readonly kind: "scanLines"; readonly doc: DocumentHandle; readonly generation: number; readonly upto: number };
  index: { readonly kind: "index"; readonly doc: DocumentHandle; readonly generation: number };
  search: { readonly kind: "search"; readonly doc: DocumentHandle; readonly generation: number; readonly query: SearchQuery };
  syntaxTokens: {
    readonly kind: "syntaxTokens";
    readonly doc: DocumentHandle;
    readonly generation: number;
    readonly first: number;
    readonly count: number;
    readonly text: string;
    readonly lineStarts: readonly number[];
    readonly states: readonly (string | null)[];  // estado serializado (string[] flattened)
    readonly grammar: SerializedGrammar;
  };
  /**
   * A busca na workspace (o "grep") — **tudo serializável**: o padrão, a lista de arquivos
   * (caminhos absolutos) e as opções.
   *
   * ⚠️ A **leitura** acontece dentro do worker (o port `node:fs` respeita o teto por
   * arquivo) ⇒ o processo principal nunca materializa o conteúdo de um arquivo de 2 GB.
   */
  grep: GrepTaskPayload;
}

/** Task imutável, serializável e cancelável (DEC-CON-4). */
export type Task<K extends TaskKind = TaskKind> = TaskSpecByKind[K];

export interface TaskHandle<T> {
  readonly id: number;
  readonly kind: TaskKind;
  readonly done: Promise<T>;
  cancel(reason?: string): void;
}

/**
 * Marshalling ao main thread — **sem polling, sem busy-wait**: o resultado volta por
 * `MessagePort`/`postMessage` (DEC-CON-7/8).
 */
export interface Scheduler {
  /** `true` só na thread de UI (main ou renderer) — nunca deduzido de `Atomics` (CON-U1). */
  readonly isUIThread: boolean;
  post<T>(priority: Priority, cb: () => T | Promise<T>, opts?: { readonly handle?: DocumentHandle }): Promise<T>;
  postTo(target: SchedulerTarget, cb: () => void): void;
  /** Bridge para contador compartilhado: `Atomics.waitAsync`, nunca `Atomics.wait` na UI (DEC-CON-7). */
  waitOn(cell: Int32Array, expected: number, timeoutMs?: number): Promise<"ok" | "timedout">;
  /** Observabilidade (escolha nossa: `02:299` promete `MainThreadBusy`, o alvo não o expunha). */
  snapshot(): MainThreadBusy;
}

export interface TaskPool {
  run<K extends TaskKind>(
    task: Task<K>,
    opts?: {
      readonly lane?: PoolLane;
      readonly priority?: Priority;
      readonly signal?: AbortSignal;
      /**
       * Teto de execução (ms) — o pool **mata** o worker que estourou e rejeita a task com
       * {@link TaskTimeoutError}.
       *
       * O relógio cobre a task **inteira**: a espera na **fila** conta e a execução conta.
       * Sem isso, uma task poderia ficar na fila **para sempre** (a lane `io` é residente e
       * segura o teto global do pool) — e o teto do `RegExp` patológico nunca dispararia.
       *
       * ⚠️ É o **único** jeito de parar um `RegExp` patológico: o motor do JS **não** é
       * interrompível (nem por `AbortSignal`), então a única saída é matar o worker.
       */
      readonly timeoutMs?: number;
      /**
       * A task é **de fundo** e pode ser **morta** para servir uma task de primeiro plano.
       *
       * Escolha nossa (achado da revisão): a lane `grep` (a busca em todos os arquivos) é
       * **de fundo** — ela não pode segurar o único slot do pool (o **realce de sintaxe** e o
       * **salvar** esperam nele, e o realce está no caminho da digitação). Com `preemptible`,
       * uma task de primeiro plano que encontra a lane de fundo ocupada **mata** o worker
       * dela: a task de fundo é rejeitada com {@link TaskPreemptedError} (e o chamador
       * devolve um resultado parcial) e o slot é liberado na hora.
       *
       * ⚠️ Default `false`: **só** a task de fundo marca isto (o default é "não mate nada").
       */
      readonly preemptible?: boolean;
    },
  ): TaskHandle<TaskResultMap[K]>;
  size(lane: PoolLane): number;
  resize(lane: PoolLane, n: number): Promise<void>;
  shutdown(): Promise<void>;
  /** Observabilidade do pool (DEC-TR-7: medido, não hardcoded). */
  readonly busy: Readonly<Record<PoolLane, number>>;
}

/** Observabilidade do main thread — `aux` para o gate de "UI nunca bloqueia". */
export interface MainThreadBusy {
  readonly busyMs: number;
  readonly pendingCallbacks: number;
  readonly lanes: Readonly<Record<PoolLane, number>>;
}

/** Entrada serializável entregue ao worker (nunca uma closure — DEC-CON-4/11). */
export interface WorkerRequest {
  readonly id: number;
  readonly kind: TaskKind;
  readonly payload: Task;
  /** Contadores compartilhados opcionais (`SharedArrayBuffer` só para flags/números). */
  readonly counters: Int32Array | undefined;
}

export interface WorkerResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: {
    readonly message: string;
    readonly stack: string | undefined;
    /** `name` da classe do erro no worker (ex.: `SearchInputError`) — preservado na travessia. */
    readonly name?: string;
    /** `code` estável do erro tipado (ex.: `search.emptyPattern`) — a classe não cruza o port. */
    readonly code?: string;
  };
}

/**
 * Erro de uma task que **falhou no worker**: `message` da falha + `name`/`code` preservados
 * quando o worker os enviou. Necessário porque o `structured-clone` não transporta classes de
 * erro — o pool reidrata um erro tipado a partir do `code` do wire (DEC-TR-5).
 */
export class TaskError extends Error {
  readonly code: string | undefined;

  constructor(message: string, name?: string, code?: string) {
    super(message);
    this.name = name ?? "TaskError";
    this.code = code;
  }
}

/**
 * Erro de uma task que **estourou o tempo** (`TaskPool.run(..., { timeoutMs })`).
 *
 * O pool **matou** o worker que executava a task (o `RegExp` do JS não é interrompível) ⇒ o
 * resultado parcial se perde, mas a **thread principal nunca travou** e a lane **se recupera**
 * (o próximo task sobe um worker novo).
 *
 * ⚠️ Também cobre a **espera na fila**: uma task que nunca é atribuída a um worker (o teto
 * global do pool está tomado por outra lane) também estoura — senão ela ficaria na fila para
 * sempre.
 */
export class TaskTimeoutError extends Error {
  /** Código estável (para o IPC e para o `catch` tipado). */
  readonly code = "task.timeout";
  /** O teto que foi estourado (ms). */
  readonly timeoutMs: number;

  constructor(timeoutMs: number, message?: string) {
    super(message ?? `task excedeu o teto de ${timeoutMs} ms (o worker foi encerrado)`);
    this.name = "TaskTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Erro de uma task **de fundo** que foi **preemptada** (morta) para servir uma task de
 * primeiro plano (`TaskPool.run(..., { preemptible: true })`).
 *
 * É o "irmão" do {@link TaskTimeoutError}: o resultado se perde, mas o slot do pool é
 * liberado **na hora** (a task de primeiro plano não espera).
 */
export class TaskPreemptedError extends Error {
  /** Código estável (para o IPC e para o `catch` tipado). */
  readonly code = "task.preempted";

  constructor(message?: string) {
    super(message ?? "a task de fundo foi preemptada por uma task de primeiro plano");
    this.name = "TaskPreemptedError";
  }
}

// ── Forma serializável de uma gramática compilada (DEC-PKG-8) ─────────────────────────────────

/**
 * Pattern serializável: `RegExp` vira `match` (source) + `matchFlags` (flags).
 * `captures` mapeia chave numérica (grupo) ou nome → escopo.
 */
export interface SerializedPattern {
  readonly match?: string;      // regex source
  readonly matchFlags?: string; // regex flags
  readonly scope?: string;
  readonly captures?: Record<string, { readonly scope?: string }>;
  readonly push?: readonly string[];
  readonly pop?: boolean;
  readonly set?: string;
  readonly include?: string;
}

/** Contexto serializável: patterns ordenados + escopo-base (opcional). */
export interface SerializedContext {
  readonly patterns: readonly SerializedPattern[];
  readonly metaScope?: string;
}

/** Gramática na forma plana que cruza o IPC para o worker. */
export interface SerializedGrammar {
  readonly contexts: Record<string, SerializedContext>;
  readonly contextScopes: Record<string, string>;
  readonly scope: string;
  readonly logicalName: string;
  readonly extensions: readonly string[];
}
