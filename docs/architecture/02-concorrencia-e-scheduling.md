# 02 · Concorrência & scheduling — threads, pools e handoff ao main
> Fase 2 (P2.1) · síntese clean-room do alvo (sha256 8b105b18…43d92) · insumo: evidence-index.md · 2026-10-16

> **Entregável:** **P2.1** — a spec abstrata de **concorrência e scheduling** do editor-alvo
> (**Scribe**), escrita para ser implementada em **Electron + TypeScript**.
> Alvo da análise: o ELF64 x86-64 PIE **stripped** `target/sublime_text/sublime_text`
> (`sha256 8b105b1839d7809f60ec186b6c6dcb2d107e22ad23f42c5f8ba7dec67ab43d92`).
> **Clean-room:** só **nomes, assinaturas, contagens, tamanhos, endereços e papel arquitetural** —
> nenhum bloco de código, assembly ou pseudocódigo do alvo é transcrito; as interfaces de §4 são
> **nosso** código. Rótulos `[OBSERVADO]`/`[INFERIDO]`/`[DESCONHECIDO]`; escolhas nossas marcadas
> **"escolha nossa (não observada no alvo)"**.
> **Insumos:** [`../analysis/evidence-index.md`](../analysis/evidence-index.md) §3 (`CON-E*`/`CON-U*`),
> §7 (`REN-E26`), §10; contexto de padrão em [`../analysis/concurrency.md`](../analysis/concurrency.md).
> **Docs irmãos (Fase 2):** [`./01-buffer-e-edicao.md`](./01-buffer-e-edicao.md) ·
> [`./03-extensao-e-ipc.md`](./03-extensao-e-ipc.md) · [`./04-render-e-ui.md`](./04-render-e-ui.md) ·
> [`./05-empacotamento-e-recursos.md`](./05-empacotamento-e-recursos.md) ·
> [`./06-padroes-transversais.md`](./06-padroes-transversais.md).

---

## 1. 🎯 O padrão observado (o quê)

**Achado central (1–2 frases):** o alvo é um processo **GTK3/GLib single-main-thread** `[OBSERVADO]`
(o loop `gtk_main` roda sobre o *main context* do GLib e **também renderiza** — não há thread de
render) que delega trabalho a **threads POSIX próprias** `[OBSERVADO]`, criadas por **uma fábrica
central** (stack fixa de **2 MiB**, nome via `prctl(PR_SET_NAME, …)`) e organizadas em **pools** — um
**pool de I/O de N threads** (`io_worker`, N vindo do setting `io_workers`, default **2**) `[OBSERVADO]`
e um **pool de leitura de arquivo sob demanda limitado a 2** (`file_read_thread`) `[OBSERVADO]`. O
resultado volta ao main thread por **wakeup de fd + sources do GLib** e por um **scheduler de main
thread** (`px_main_thread_scheduler`) `[INFERIDO]`. O `plugin_host` **não é thread**: é **processo
separado** (`posix_spawn`/`execvp`) falando por shm POSIX + semáforos `[OBSERVADO]`.

Os cinco traços que queremos preservar (padrão, não implementação):

1. **Uma thread de UI/event-loop que não bloqueia.** Todas as operações lentas (I/O de disco, indexação,
   rede de licença/update) saem da main thread e voltam por **mensagem/agendamento** — nunca por espera
   ocupada. `[OBSERVADO]`: `gtk_main` + `g_source_add_unix_fd` + `g_idle_add` (`CON-E1`, `CON-E2`);
   render na main thread (`REN-E3`).
2. **Pools, não "uma thread por fila".** O núcleo usa **pool-de-N dimensionado por setting** e
   **pool-bounded-on-demand** (`CON-E9`, `CON-E10`).
3. **Trabalho = item com ciclo de vida próprio.** No alvo cada item carrega **vtable + refcount
   atômico** e é executado por chamada virtual (`CON-E11`).
4. **Modelo assíncrono por continuação.** `promise`/`future_core` + `assign_then_wrapper` +
   `io_scheduler`/`async_file_system`; a conclusão é **re-agendada** para o executor certo (inclusive o
   de main thread) (`CON-E14`, `CON-E15`).
5. **Thread ≠ processo.** O único **processo** fora do núcleo é o host de plugins (+ o crash handler)
   (`CON-E19`, `CON-E7`).

---

## 2. 🧵 Topologia de threads/processos (com Evidence IDs)

```
                        ┌───────────────────────────────────────────────┐
   PROCESSO EDITOR      │  MAIN THREAD  (event loop; TAMBÉM renderiza)  │
   (target: sublime_text)│  loop GTK/GLib · sources de fd · idle callbacks│
   um só espaço de      │  owner do estado de UI, buffer views, comandos │
   endereço, .bss comum │  (CON-E1, CON-E2, REN-E3)                       │
                        └──────▲───────────────────────┬───────────────┘
                               │ px_main_thread_scheduler (CON-E15)
                    handoff de │ conclusão (INFERIDO)  │ despacho de task
                       volta   │                       ▼
                        ┌──────┴────────────┐  ┌──────────────────────────┐
                        │ POOL DE I/O       │  │ POOL FILE-READ           │
                        │ N × io_worker     │  │ ≤2 × file_read_thread    │
                        │ N = io_workers(2) │  │ on-demand / preguiçoso   │
                        │ (CON-E9, REN-E26) │  │ (CON-E10)                │
                        └───────────────────┘  └──────────────────────────┘
                        + index_builder · task_worker · crawler ·
                          license_* · process_status · fetch_update_info ·
                          shm_reader  (CON-E6, CON-E7)
   ───────────────────────────────────────────────────────────────────────────
   PROCESSO SEPARADO    plugin_host-3.14 / -3.3  (posix_spawn/execvp + shm/sem)
                        (CON-E19, HOST-E1, HOST-E2)  ·  crash_handler (processo)
```

| Elemento | Natureza | Evidência | Papel |
|---|---|---|---|
| **Main thread** | thread do processo editor | `CON-E1`, `CON-E2`, `REN-E3` | event loop GTK/GLib **e** render; dono do estado de UI |
| **Fábrica de threads** | código do núcleo | `CON-E8` | `pthread_create` + `setstacksize` de **`0x200000` (2 MiB)** |
| **Nome de thread** | TLS/`prctl` | `CON-E5`, `CON-E6` | `prctl(PR_SET_NAME)`; nomes `io_worker`, `file_read_thread`, … |
| **Identidade de thread** | TLS + afinidade | `CON-E3`, `CON-E4` | `pthread_key_create`/`getspecific`/`setspecific`, `.tdata`/`thread_local`; `sched_setaffinity` |
| **Pool de I/O** | N threads sobre 1 pool | `CON-E9` | mutex + condvar + tabela de ~10 buckets; shutdown flag |
| **Pool file-read** | ≤2, sob demanda | `CON-E10` | fila global + contador de ativos; workers se desligam |
| **Itens de trabalho** | objeto com vtable + refcount | `CON-E11` | executado por chamada virtual; refcount atômico |
| **Scheduler de main thread** | objeto do núcleo | `CON-E15`, `CON-U5` | veículo do retorno de continuações à main thread |
| **Wakeup** | pipe + source de fd | `CON-E16`, `CON-E2` | `pipe()` + `g_source_add_unix_fd`/`g_idle_add` |
| **Settings de sizing** | strings + bootstrap | `CON-E18`, `REN-E26` | `io_workers` (2), `index_workers` (0), `max_background_threads` |
| **`plugin_host`** | **processo** | `CON-E19`, `CON-E20` | spawn + shm/sem; core C++ **compartilhado** com o núcleo |
| **Sem thread de render** | busca negativa | `REN-E3`, `CON-E13` | render acontece na main thread; `async_thread_queue_runner` **não** existe no núcleo |

**O que é thread (mesmo processo, `.bss` compartilhado):** main thread, pool `io_worker` (N), pool
`file_read_thread` (≤2), `index_builder`, `task_worker`, `crawler`, `license_check`,
`license_notification`, `process_status`, `fetch_update_info`, `shm_reader` (`CON-E6`, `CON-E7`).
**O que é processo:** `plugin_host-3.14`/`plugin_host-3.3` (`CON-E19`) e o `crash_handler`.

**Contadores de "main thread ocupada"** (`g_is_main_thread_blocking`/`handling_message`,
`is_main_thread()`) só são observáveis **no host** — no núcleo stripped são **estáticos e sem nome**
(`CON-U1`, `CON-U2`). `[INFERIDO]`: núcleo e host compartilham o mesmo `src/core` (`CON-E20`), logo
ambos têm a mesma noção de "estou na main thread?".

---

## 3. 🖥️ Decisões de arquitetura para o editor-alvo

> **Mapeamento de base** (contexto-alvo fixo do projeto): **main process** (Node: ciclo de vida, menus,
> FS) · **renderer** (Chromium: apresentação, `RenderPipeline`) · **workers** (tokenização/diff/buffer).
> Onde o alvo tem **uma** main thread que faz UI + render, nós temos **duas** threads "de frente"
> (Node main e renderer) — o que **reforça** a regra "não bloquear".

**DEC-CON-1 — A thread de UI/event-loop é sagrada e nunca bloqueia.**
*Racional:* o alvo concentra event loop + render na main thread (`CON-E1`, `CON-E2`, `REN-E3`); qualquer
espera longa lá trava UI e render ao mesmo tempo. Em Electron, `RenderPipeline` vive no **renderer** e o
ciclo de vida/FS no **main** — ambos são "main threads" no sentido do alvo e **não podem** rodar I/O
síncrono, parsing ou contagem de linhas em volume. Todo trabalho pesado vai para `TaskPool`.
**"escolha nossa (não observada no alvo)":** o alvo é 1 processo/1 main thread; nós temos 2 mains (Node
+ renderer), com fronteira explícita por IPC. Evidence IDs: `CON-E1`, `CON-E2`, `REN-E3`.

**DEC-CON-2 — `TaskPool` = pool de `worker_threads` de tamanho **fixo N**, dimensionado por setting
(`io_workers`, default **2**).**
*Racional:* espelha o **pool-de-N** `io_worker` sobre um pool compartilhado (`CON-E9`) e o setting
`io_workers: 2` fechado por `REN-E26` (`CON-E18`). N é lido da configuração do usuário (`PropertySystem`),
não hard-coded; muda no boot (o alvo cria o pool uma vez, no bootstrap de settings).
Evidence IDs: `CON-E9`, `CON-E18`, `REN-E26`.

**DEC-CON-3 — Segundo pool, **bounded on-demand (≤2)**, dedicado a leitura de arquivo.**
*Racional:* o alvo tem um pool **preguiçoso** de no máximo 2 (`file_read_thread`), com workers que se
**desligam** quando a fila esvazia (`CON-E10`). Replicamos: `TaskPool` de "lane" `fileRead` com teto
baixo e worker reciclável, para não inflar o custo de thread em rajadas de I/O.
Evidence IDs: `CON-E10`.

**DEC-CON-4 — Work item = objeto de tarefa tipado com ciclo de vida explícito (cancelamento), **sem**
refcount manual.**
*Racional:* o alvo executa itens por vtable com refcount atômico (`CON-E11`), mas a composição interna do
item é **incógnita** (`CON-U3`). Em TS não precisamos de refcount manual — o **GC** cuida da memória;
o que **mantemos** é o *ciclo de vida lógico*: cada tarefa é **cancelável** (`AbortSignal`) e tem
**identidade/geração** para descartar resultados obsoletos (coalescing de indexação). Contadores
quentes (fila, ativos) usam `Atomics` sobre `SharedArrayBuffer` **só** quando atravessam threads.
**"escolha nossa (não observada no alvo)".** Evidence IDs: `CON-E11`, `CON-U3`.

**DEC-CON-5 — Handoff de volta à thread de UI por **scheduler explícito**, nunca por espera ocupada.**
*Racional:* no alvo, a conclusão de uma I/O é re-agendada para o executor — inclusive o de main thread
(`px_main_thread_scheduler`, `sched_work_item`) — via wakeup de fd (`CON-E15`, `CON-E16`, `CON-E2`), e
o **conjunto exato** de callbacks/coalescing é incógnita (`CON-U5`). Em Node/Electron o análogo direto é
`MessagePort` (`postMessage` acorda o event loop) + um `Scheduler` de UI que enfileira callbacks:
`queueMicrotask`/`setImmediate` no Node, e no renderer `requestAnimationFrame`/`scheduler.postTask`.
Se algum caminho precisar **esperar** por um worker sem bloquear, usar `Atomics.waitAsync` (nunca
`Atomics.wait` na main thread). Evidence IDs: `CON-E15`, `CON-E16`, `CON-E2`, `CON-U5`.

**DEC-CON-6 — `ExtensionHost` é **processo separado** (não `worker_thread`).**
*Racional:* o `plugin_host` é lançado por `posix_spawn`/`execvp` e conversa por **shm POSIX + semáforos
nomeados** (`CON-E19`, `HOST-E1`, `HOST-E2`); a escolha "processo, não thread" isola crashes e memória.
Em Electron, o equivalente é **`utilityProcess`** (Node em processo próprio), com `ExtensionBridge`
sobre uma porta de IPC — **não** um `worker_thread` no main process.
**"escolha nossa":** trocamos o runtime do host (CPython) por JS/TS sandboxado, mantendo o
**isolamento por processo** e o **protocolo binário**. Evidence IDs: `CON-E19`, `CON-E20`, `HOST-E1`, `HOST-E2`.

**DEC-CON-7 — **Sem** worker/processo de render: `RenderPipeline` roda na thread de apresentação.**
*Racional:* o alvo **não** tem thread de render — a renderização acontece na main thread (`REN-E3`), e o
núcleo sequer tem `async_thread_queue_runner` (`CON-E13`). Mantemos o render no **renderer main thread**
(Canvas2D/WebGPU), com **damage/clip** para limitar o trabalho por frame; trabalho off-thread de render
(se houver) seria exceção justificada, não default. Evidence IDs: `REN-E3`, `CON-E13`.

**DEC-CON-8 — Wakeup por **mensagem de porta** (análogo do pipe + GLib source); **proibido** polling
busy-wait entre threads.**
*Racional:* o alvo acorda o main loop por `pipe()` cujo fd é vigiado por `g_source_add_unix_fd`, além de
`g_idle_add` para trabalho adiado (`CON-E16`, `CON-E2`). Nosso análogo é `MessagePort`/`MessageChannel`;
"idle" do GLib ≈ microtask/`setImmediate`. Workers **dormem** em espera de mensagem, não em *spin*.
Evidence IDs: `CON-E16`, `CON-E2`.

**DEC-CON-9 — Dimensionamento de pools por `PropertySystem`, com defaults do alvo e teto derivado de CPU.**
*Racional:* `io_workers: 2`, `index_workers: 0` estão fechados por `REN-E26`; `max_background_threads`
segue sendo **incógnita** (`CON-U6`). Adotamos os defaults observados; onde `index_workers = 0` sinaliza
"indexação desligada/leve", a lane `index` nasce **cold-start** e só sobe se habilitada. Adicional nosso:
teto = `min(setting, cpus − 1)` para não saturar a máquina (o alvo usa `sysconf`/`sched_*` para
afinidade/dimensionamento — `[INFERIDO]`). **"escolha nossa"** no teto por CPU.
Evidence IDs: `CON-E18`, `REN-E26`, `CON-E4`, `CON-U6`.

**DEC-CON-10 — Diagnóstico primeiro-classe: nomear workers e medir "UI ocupada?".**
*Racional:* o alvo nomeia threads (`prctl(PR_SET_NAME)`: `io_worker`, `file_read_thread`, …) e o host
expõe `g_is_main_thread_blocking`/`handling_message` (`CON-E5`, `CON-E6`, `CON-U1`, `CON-U2`). Nós damos
`name` a cada worker (`workerData`) e expomos uma métrica `MainThreadBusy` para caçar regressões de
bloqueio — exatamente o que o alvo faz do lado do host e não conseguimos ver no núcleo.
Evidence IDs: `CON-E5`, `CON-E6`, `CON-U1`, `CON-U2`.

**DEC-CON-11 — Troca de dados entre threads por **transferência**, não por memória compartilhada de
objetos.**
*Racional:* `SharedArrayBuffer` **não** compartilha strings nem objetos JS; strings são copiadas. Então
a fronteira de worker move **`ArrayBuffer` transferível** (zero-copy, via `postMessage`/`Transferable`)
e trata strings/texto como **cópias**; `SAB` fica reservado a **contadores e flags** (`Atomics`) e a
*buffers* binários que queremos mutar em lugar. **"escolha nossa (não observada no alvo)"** — o alvo
compartilha o mesmo espaço de endereço, nós não podemos.
Evidence IDs: `CON-E11` (contadores atômicos no alvo), `CON-E20`.

**DEC-CON-12 — Índice/contagem de linha é **cache incremental** de propriedade do documento, calculado
fora da UI em buffers grandes.**
*Racional:* o alvo **não** tem classe de índice (`LineIndex` inexistente) — usa **scan com cache** por
sentinela `-1` no próprio buffer; a granularidade/custo é **incógnita** (`BUF-U4`, e ver
`buffer-structure.md` §4). Como nosso `TextStore` é editável e grande, mantemos uma **camada de cache de
linhas** que pode ser **reconstruída/estendida em worker** (`Scheduler`/`TaskPool`) e invalidada por
`generation` a cada edição, evitando re-scan de O(n) na UI. Índice persistente/árvore fica como
**hipótese aberta** (a decisão de estrutura de texto é do doc
[`./01-buffer-e-edicao.md`](./01-buffer-e-edicao.md)).
Evidence IDs: `BUF-U4` (limite); `CON-E9`/`CON-E10` (pool p/ o scan).

---

## 4. 📐 Contratos TypeScript (interfaces/assinaturas do NOSSO código)

> Código nosso; nada aqui vem do binário. Os nomes de componente seguem o glossário do projeto.

```ts
// ---- Identidade, tarefas e lanes -------------------------------------------
export type PoolLane = "io" | "index" | "fileRead";                       // lanes do TaskPool (DEC-CON-2/3/9)
export type Priority = "input" | "edit" | "layout" | "background";        // lanes do Scheduler (canônico, igual a 06)
/** Handle opaco = id + geração empacotados; nunca um objeto (canônico: igual a 01/03/06). */
export type DocumentHandle = number & { readonly __brand: "DocumentHandle" };

/** Item de trabalho tipado (DEC-CON-4): imutável, serializável, cancelável. */
export type Task<T> =
  | { kind: "readFile";  path: string; range?: { offset: number; length: number } }
  | { kind: "writeFile"; path: string; data: ArrayBuffer }                 // transferível (DEC-CON-11)
  | { kind: "scanLines"; doc: DocumentHandle; generation: number; upto: number }
  | { kind: "index";     doc: DocumentHandle; generation: number };

export interface TaskHandle<T> { readonly done: Promise<T>; cancel(reason?: string): void; }

// ---- Scheduler: o "px_main_thread_scheduler" do nosso lado (DEC-CON-1/5/8) --
export interface Scheduler {
  /** true na thread de UI (Node main ou renderer main). */
  readonly isUIThread: boolean;
  /** Roda `cb` na thread de UI assim que possível; NUNCA bloqueia quem chamou. */
  post<T>(priority: Priority, cb: () => T | Promise<T>, opts?: { handle?: DocumentHandle }): Promise<T>;
  /** Microtask para o alvo (WebWorker/renderer); resolve já se estivermos no alvo. */
  postTo(target: SchedulerTarget, cb: () => void): void;
  /** Espera assíncrona coordenada por Atomics (nunca Atomics.wait na UI). */
  waitOn(cell: Int32Array, expected: number, timeoutMs?: number): Promise<"ok" | "timedout">;
}

// ---- TaskPool: pools de trabalho (DEC-CON-2/3/4/9) --------------------------
export interface TaskPool {
  /** Executa uma tarefa; `lane` escolhe o pool (io = N fixo; fileRead = ≤2 on-demand). */
  run<T>(task: Task<T>, opts?: { lane?: PoolLane; priority?: Priority; signal?: AbortSignal }): TaskHandle<T>;
  /** Tamanho efetivo da lane (após teto por CPU e setting). */
  size(lane: PoolLane): number;
  /** Reconstrói o pool quando o usuário muda `io_workers`/`index_workers`. */
  resize(lane: PoolLane, n: number): Promise<void>;
  shutdown(): Promise<void>;
}

// ---- Buffer/TextStore: fachada de leitura na UI, mutação mediada (DEC-CON-12) --
export interface TextStore {
  readonly doc: DocumentHandle;
  /** Leitura barata SÓ na thread de UI; para volumes grandes, use o worker. */
  slice(range: { start: number; end: number }): string;
  /** Aplica um delta e invalida o cache de linhas por `generation`. */
  apply(edits: readonly Edit[], origin: EditOrigin): Promise<void>;   // EditOrigin: tipo canônico do 01
  lineCountUpTo(offset: number): Promise<number>;   // pode delegar ao TaskPool (scanLines)
}

/** Estado vivo do documento; o **estado mora no registry**, chaveado pelo handle opaco (01). */
export interface DocumentState {
  readonly handle: DocumentHandle;
  readonly generation: number;      // descarta resultados obsoletos (DEC-CON-4)
  readonly store: TextStore;
  readonly dirty: boolean;
}

export interface DocumentRegistry {
  open(path: string): Promise<DocumentHandle>;
  get(h: DocumentHandle): DocumentState | undefined;
  close(h: DocumentHandle): Promise<void>;
  readonly onDidChange: (cb: (h: DocumentHandle) => void) => Disposable;
}

// ---- Comandos e eventos: o contrato canônico é o do doc 01 (`CommandBus`) -----
// A concorrência só exige: `run()` serializado na lane de edição e entrega de
// eventos na UI thread. Não redefinimos a interface aqui.

// ---- Extensão: processo separado (DEC-CON-6) --------------------------------
export interface ExtensionHost {
  /** Sobe um utilityProcess (NÃO worker_thread) e devolve a porta. */
  spawn(opts: { name: string; entry: string; env?: Record<string, string> }): Promise<HostHandle>;
}
export interface ExtensionBridge {
  readonly port: MessagePort;
  request<A, R>(command: string, args: A, transfer?: Transferable[]): Promise<R>;
  subscribe(topic: string, cb: (payload: ArrayBuffer) => void): Disposable;
}

// ---- Render: só na thread de apresentação (DEC-CON-7) -----------------------
export interface RenderPipeline {
  /** Registra regiões danificadas; o frame roda na UI thread. */
  invalidate(damage: readonly DamageRegion[]): void;
  measure(text: string, style: TextStyleKey): GlyphMetrics;
}

// ---- Diagnóstico (DEC-CON-10) ----------------------------------------------
export interface MainThreadBusy {
  readonly busyMs: number;               // tempo bloqueado na UI, por janela
  readonly pendingCallbacks: number;     // profundidade do Scheduler.post
  readonly lanes: Record<PoolLane, number>;  // workers ativos por lane
}
export interface Disposable { dispose(): void; }
```

---

## 5. 🔀 Divergências deliberadas (onde NÃO seguimos o alvo, e por quê)

| # | Alvo | Nós | Por quê |
|---|---|---|---|
| D1 | **1 processo**, `.bss` compartilhado entre threads | **3 fronteiras**: Node main · renderer · utilityProcess | modelo do Electron; isolamento de crash/segurança. Estado compartilhado só via IPC (DEC-CON-1/6) |
| D2 | item de trabalho com **refcount atômico manual** (`CON-E11`) | **GC** + `AbortSignal` + `generation` | TS não precisa de refcount manual; mantemos o **ciclo de vida lógico** (cancelar/descartar), não a contagem (DEC-CON-4) |
| D3 | `pthread_mutex`/`condvar` + `std::condition_variable` (`CON-E17`) | `MessagePort` + `Atomics`; **sem** lock sobre objeto JS | objetos JS **não** são compartilhados entre threads (struct-clone copia); locks de objeto não existem do outro lado (DEC-CON-11) |
| D4 | fábrica própria com **stack de 2 MiB** (`CON-E8`) | **V8 default** de worker (+`resourceLimits` se preciso) | stack configurável por `worker_threads`; 2 MiB é detalhe do alvo, não requisito (DEC-CON-2) |
| D5 | wakeup por `pipe()` + `g_source_add_unix_fd`/`g_idle_add` (`CON-E16`, `CON-E2`) | `MessagePort` + `queueMicrotask`/`setImmediate` | mesmo efeito (acordar o loop; adiar trabalho), API nativa do runtime (DEC-CON-5/8) |
| D6 | `plugin_host` = **CPython embutido** em processo (`HOST-E12`, `HOST-E13`) | `utilityProcess` com **JS/TS sandboxado** | manter **processo separado** e protocolo binário, trocando o runtime; decisão de linguagem de extensão (DEC-CON-6) |
| D7 | render **GL 4.1 instanciado** ou **Skia raster** na main thread (`REN-E*`) | **Canvas2D/WebGPU** no renderer | WebGPU/Canvas já é a pipeline de apresentação do Chromium; mantemos "render na UI thread" e *damage clip* (DEC-CON-7) |
| D8 | **sem** índice de linha persistente; scan + cache por sentinela (`BUF-U4`) | cache de linhas **reconstruível em worker**, índice persistente como **hipótese aberta** | buffer editável grande + UI não pode pagar O(n) por consulta (DEC-CON-12) |

> **Não divergimos** em: pools dimensionados por setting (vs. thread-por-fila), handoff por
> scheduler explícito, existência de um **processo** de extensões separado, e render **na thread de UI**
> sem worker dedicado de render. Esses quatro são **padrão preservado**.

---

## 6. 🧾 Rastreabilidade (Conclusão (Evidence IDs) → DEC → Status)

| Conclusão (Evidence IDs) | DEC | Status |
|---|---|---|
| Event loop GTK/GLib; GTK via `dlopen`; fds via sources GLib | `CON-E1`, `CON-E2` | `DEC-CON-1`, `DEC-CON-5`, `DEC-CON-8` | ✅ adotado |
| Render ocorre na **main thread**; **sem** thread de render; núcleo **sem** `async_thread_queue_runner` | `REN-E3`, `CON-E13` | `DEC-CON-7` | ✅ adotado |
| Pool de I/O = **N** threads (`io_worker`) sobre 1 pool (mutex/condvar/buckets) | `CON-E9` | `DEC-CON-2`, `DEC-CON-3` | ✅ adotado |
| Setting `io_workers` lido no boot; `index_workers`, `max_background_threads` existem | `CON-E18` | `DEC-CON-2`, `DEC-CON-9` | 🟡 parcial (default de `max_background_threads` = U) |
| Defaults **`io_workers: 2`**, **`index_workers: 0`** | `REN-E26` | `DEC-CON-2`, `DEC-CON-9` | ✅ adotado |
| Pool file-read **sob demanda, máx 2**, fila global + contador de ativos | `CON-E10` | `DEC-CON-3`, `DEC-CON-12` | ✅ adotado |
| Itens = objetos com vtable + **refcount atômico**, execução virtual | `CON-E11` | `DEC-CON-4`, `DEC-CON-11` | 🟡 reinterpretado (GC + cancelamento) |
| Modelo `promise`/`future_core`/`io_scheduler`/`async_file_system` | `CON-E14` | `DEC-CON-5` | ✅ adotado (promise + continuação) |
| Main-thread scheduler `px_main_thread_scheduler` (`sched_work_item`) é o veículo do retorno | `CON-E15` | `DEC-CON-5` | 🟡 inferido (veículo) |
| Wakeup por `pipe.cc` + `pipe_work_queue_runner` | `CON-E16` | `DEC-CON-8` | ✅ adotado (via MessagePort) |
| `pthread mutex/cond` + `std::condition_variable` coexistem | `CON-E17` | `DEC-CON-11` | 🔀 divergente (D3) |
| `plugin_host` = **processo** (`posix_spawn`/`execvp`) + shm/sem | `CON-E19`, `HOST-E1`, `HOST-E2` | `DEC-CON-6` | ✅ adotado (utilityProcess) |
| Core C++ compartilhado núcleo↔host (`src/core/{ipc,pipe,process}.cc`) | `CON-E20` | `DEC-CON-6`, `DEC-CON-11` | ✅ adotado |
| `shm_reader` = thread do núcleo (canal async do host) | `CON-E7` | `DEC-CON-6` | ✅ adotado (ponte IPC) |
| Nomes de thread via `prctl(PR_SET_NAME)`; repertório de nomes | `CON-E5`, `CON-E6` | `DEC-CON-10` | ✅ adotado (nomear workers) |
| Identidade de thread via **TLS** (`.tdata`/`pthread_key_*`) e `sched_setaffinity` | `CON-E3`, `CON-E4` | `DEC-CON-9`, `DEC-CON-10` | 🔀 divergente (runtime gerencia; sem afinidade explícita) |
| Fábrica de threads com stack fixa de **2 MiB** | `CON-E8` | `DEC-CON-2` | 🔀 divergente (D4) |
| Cache de linha por **scan + sentinela `-1`**; granularidade desconhecida | `BUF-U4` | `DEC-CON-12` | 🟡 parcial (cache próprio) |

**Legenda:** ✅ adotado · 🟡 adotado com ressalva/inferência · 🔀 divergência deliberada (ver §5).

---

## 7. ⚠️ Incógnitas que afetam este módulo (refs CON-U*)

| ID | Incógnita | Impacto no nosso módulo | Contorno / como fechar |
|---|---|---|---|
| `CON-U1` | Mecanismo concreto de identificação da **main thread** (comparar `pthread_self()` a um `pthread_t` guardado, ou flag em `.tdata`) | Como `Scheduler.isUIThread` é decidido — mas em Node/Electron isso é **direto** (`isMainThread`, runtime do renderer) | Fechar do lado do alvo é baixo valor para nós; registrar como "não portável/irrelevante" |
| `CON-U2` | Se há contador explícito de "main thread blocking" no núcleo e sua granularidade; nomes só existem no **host** | Escopo de `MainThreadBusy` (DEC-CON-10): o alvo tem a métrica, mas só a vemos no host | Expor nossa métrica mesmo assim (mais rica que a do alvo) |
| `CON-U3` | Composição exata do *work item* (campos além de vtable e refcount) | Formato do `Task` (DEC-CON-4) | Nós definimos o `Task` do zero; a incógnita **não bloqueia** — só impede "espelhar o alvo" |
| `CON-U4` | Se há barreiras/`rwlock`/`std::atomic` explícito além do `LOCK/UNLOCK` sintetizado | Necessidade de primitivas extra (`Atomics`, barreiras) | Assumir que **não** há contrato observável; usar `Atomics` mínimo (DEC-CON-11) |
| `CON-U5` | Conjunto exato de callbacks postados à main thread; **coalescing/batching**; formato do `sched_work_item` | Política de coalescing do `Scheduler.post` (DEC-CON-5) e agrupamento de eventos | Começar sem coalescing; medir e introduzir batching sob `generation` (descarte de obsoletos) |
| `CON-U6` | Default de `max_background_threads` (parcialmente fechado: `io_workers: 2`, `index_workers: 0` por `REN-E26`) | Teto de workers de `index`/`task` (DEC-CON-9) | Adotar teto por CPU (`min(setting, cpus−1)`); reabrir se o default aparecer |
| `BUF-U4` | Granularidade do cache de linha e custo assintótico em buffers muito grandes | Estratégia do cache de linhas e quando mandar o scan ao worker (DEC-CON-12) | Benchmarks próprios na Fase 3; índice persistente como hipótese aberta (D8) |

> **Resumo de risco:** nenhuma incógnita **bloqueia** o desenho — todas são "o alvo fez X de um jeito que
> não dá para ver por completo". Onde a incógnita importa (`CON-U5`, `CON-U6`, `BUF-U4`), escolhemos um
> default conservador e **instrumentamos** (DEC-CON-10) para decidir com dado, não com fé. 🙃
