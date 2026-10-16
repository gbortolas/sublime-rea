# Modelo de concorrência do núcleo nativo — P1.2 🧵

> **Entregável:** P1.2 — **como** o núcleo (`sublime_text`) organiza sua concorrência:
> thread principal + event loop da UI, threads de background, filas/pools de trabalho,
> primitivas de sincronização, handoff main↔background, e o que é **thread** vs. o que é
> **processo**. Alvo: o executável ELF64 x86-64 PIE **stripped** `target/sublime_text/sublime_text`
> (`sha256 8b105b1839d7809f60ec186b6c6dcb2d107e22ad23f42c5f8ba7dec67ab43d92`).
> **Regime clean-room:** só **nomes, assinaturas, contagens, tamanhos, endereços e papel
> arquitetural** — nenhum bloco de implementação do alvo é transcrito. Todo endereço é do espaço
> default do Ghidra (image base `0x100000`; `.text` `0x415120–0xa1e0c9`, `.rodata`
> `0x1ced80–0x2cb5bd`, `.data.rel.ro` `0xa21a00–0xa6c818`, `.bss` `0xa80180–0xc9cb10`,
> `.tdata` `0xa20ca0–0xa216e8`, `.plt` `0xa1e220–0xa1fca0`). Provider: `ghidra 12.1.4`
> (auto-análise completa).
> **Convenção:** cada afirmação é rotulada **[OBSERVADO]**, **[INFERIDO]** ou **[DESCONHECIDO]**.

**Achado central (1–2 frases):** o núcleo é um processo **GTK/GLib single-main-thread**
[OBSERVADO] (o loop `gtk_main` roda sobre o *main context* do GLib) que delega trabalho a **threads
POSIX próprias** [OBSERVADO] criadas por uma fábrica central (`pthread_create` + stack de **2 MiB**,
nomeadas via `prctl(PR_SET_NAME, …)`) — com **pools**, não "uma thread por fila": um **pool de I/O de
N threads** [OBSERVADO] (`io_worker`, N vindo do setting `io_workers` — **o tamanho N** é
[INFERIDO]) e um **pool de leitura de arquivo sob demanda, limitado a 2** [OBSERVADO]
(`file_read_thread`); o resultado volta ao main thread por **pipe + GLib sources
(`g_source_add_unix_fd`/`g_idle_add`) + um scheduler de main thread (`px_main_thread_scheduler`)**
[INFERIDO]. O `plugin_host` **não** é thread: é **processo separado** (`posix_spawn`/`execvp`)
falando por **shm POSIX + semáforos** (P0/IPC — §7) [OBSERVADO].

---

## 1. 🔎 Escopo e método

Coleta **summary-first** via MCP `rea` sobre o alvo (aberto **uma única vez**):

| Passo | Ferramenta | Saída usada |
|---|---|---|
| nomes de thread, filas, logs, source-paths | `search_strings` (literal/regex) | nomes passados a `prctl`, RTTI de filas, `*.cc` |
| classes/filas (RTTI) | `search_strings` + `xrefs` | typeinfos em `.rodata`/`.data.rel.ro` |
| fluxo | `analyze_function` (+ `xrefs`) | corpo de fábricas de thread, pools, pipes |
| imports/primitivas | `search_strings` (`.dynstr`) | `pthread_*`, `sem_*`, `sched_*`, `poll`, `posix_spawn` |
| segmentos/regiões | `binary_overview` | image base, `.tdata`, `.bss`, `.plt` |

**Docs irmãos (Fase 1):** [`buffer-structure.md`](buffer-structure.md) (P1.1 — estrutura de buffer) ·
[`ipc-plugin-host.md`](ipc-plugin-host.md) (Track A — ponte C++↔Python) e
[`api-python.md`](api-python.md) (API de plugins).

O binário é **stripped**: não há `.symtab` e **todos** os procedimentos do Ghidra são `FUN_<addr>`
(confirmado: `search_procedures "queue"/"thread"/"main"/"worker"` → só `undefined`). Os **nomes de
classe** sobrevivem só como **type descriptors de RTTI (Itanium ABI)** em `.rodata`; os **nomes de
thread** vivem como **literais** passados a `prctl(PR_SET_NAME)`. Não foi transcrito código do alvo.

---

## 2. 🧭 Thread principal (main thread) e event loop

**[OBSERVADO] — Event loop = GTK3 / GLib.** O núcleo é um app GTK: `.rodata` contém `gtk_main`
(`0x1d204c`), `gtk_main_quit` (`0x1dbda2`), `gtk_main_level` (`0x1d6988`), `gtk_init` (`0x1da422`).
GTK/GDK são carregados **dinamicamente** (`dlopen`/`dlsym` importados em `.dynstr` `0x1032ef`/`0x1032e9`
e literais `libgtk-3.so`, `libgdk-3.so` + mensagens *"Unable to load %s from libgtk-3.so"*); o **GLib**
é dependência direta (`libglib-2.0.so.0` em `.dynstr` `0x1047c4`), assim como `libX11`.
O loop é servido pelo GLib main context: o núcleo importa e usa
`g_source_new` (`0x1035a8`), `g_source_attach` (`0x103598`), **`g_source_add_unix_fd` (`0x103534`)**,
`g_source_set_name` (`0x10361c`), `g_source_remove/destroy/unref`, e **`g_idle_add` (`0x103602`)** /
`g_idle_add_full` (`0x1035dc`). `poll` também é importado (`0x1041c3`) para o bombeamento de fds.

**[OBSERVADO] — Identidade de thread via TLS.** Existe uma seção **`.tdata`**
(`0xa20ca0–0xa216e8`, `0x448` B) e um único **símbolo TLS** no `.dynstr`: `_ZTH12g_tls_worker`
(`0x104070`) → um **`thread_local g_tls_worker`** (contexto thread-local do "worker"). O núcleo
também importa `pthread_key_create`, `pthread_getspecific`, `pthread_setspecific` e `pthread_self`
(§5), e uma das threads de indexação faz `pthread_setspecific` (ver §3), ou seja há **TLS explícito**
além do inicializador `g_tls_worker`.

**[OBSERVADO] — Scheduler de main thread.** O RTTI contém o tipo **`px_main_thread_scheduler`**
(com classe aninhada `sched_work_item<…>`) em `.rodata` `0x2213e9`, `0x23c530`, `0x23c63a`,
`0x2c97bd`, `0x2c9949` — é o objeto que **despacha work items para a main thread** (ver §6).
**[INFERIDO]** é ele o "dono" da fila de callbacks que rodam no main thread.

**[OBSERVADO] — Contraste com o `plugin_host`.** O `plugin_host` expõe **por símbolo** (`.dynsym`)
`g_is_main_thread`, `g_is_main_thread_blocking`, `g_is_main_thread_handling_message`,
`g_main_thread_wait_count`, `is_main_thread()` — isto é, os **contadores de "main thread bloqueante /
tratando mensagem"** existem no **código compartilhado** (ver §7). No `sublime_text` (stripped) **não**
há esses nomes como string/símbolo (busca literal `"main thread"`, `"handling"`, `"is_main_thread"`,
`"g_main_thread"` → **0** hits relevantes).
**[INFERIDO]** o núcleo usa a **mesma biblioteca C++** (src/core) e portanto a mesma noção de
"estou na main thread?", mas lá ela é **estática e sem nome**. O mecanismo concreto de
identificação (comparar `pthread_self()` a um `pthread_t` guardado, ou um flag em `.tdata`) é
**[DESCONHECIDO]** neste binário.

**[DESCONHECIDO]** se há um contador explícito de "main thread blocking" no núcleo e onde ele mora
(provável `g_is_main_thread_blocking` *static*); a granularidade do "handling message".

---

## 3. 🧑🏭 Threads de background

**[OBSERVADO] — Elas existem, são nomeadas via `prctl`.** O núcleo tem um *setter* de nome de thread,
`FUN_004ce933` (`0x4ce933`), cujo corpo chama **`prctl(PR_SET_NAME /*0xf*/, nome)`** (e **não**
`pthread_setname_np`, embora este esteja importado). Ele é chamado com **literais** — logo, as
threads do núcleo têm **nomes próprios**:

| Nome de thread (literal) | Função-corpo (endereço) | Papel arquitetural [INFERIDO] |
|---|---|---|
| `io_worker` | `FUN_004ce940` (`0x4ce940`) | worker do **pool de I/O** (consome a fila de I/O) |
| `file_read_thread` | `FUN_008e3a08` (`0x8e3a08`) | worker do **pool de leitura de arquivo** (sob demanda) |
| `index_builder` | `FUN_006b472a` (`0x6b472a`) | construção de **índice / symbols** (usa `pthread_setspecific`) |
| `task_worker` | `FUN_00720204` (`0x720204`) | worker de **tarefas** genéricas |
| `process_status` | `FUN_0071f0b4` (`0x71f0b4`) | monitor de **status de processo** (watchdog do host/worker) |
| `license_check` | `FUN_0064c3da` (`0x64c3da`) | verificação de licença (rede) |
| `license_notification` | `FUN_0064a6d0` (`0x64a6d0`) | notificação de licença |
| `fetch_update_info` | `FUN_00a0bcb0` (`0xa0bcb0`) | checagem de update (rede) — casa com `src/update/fetch_update_info.cc` |
| `shm_reader` | — (string `0x1f56d4`) **[INFERIDO]** | leitor do canal **assíncrono** do `plugin_host` (ver IPC §5) |
| *(nome por parâmetro)* | `FUN_004cea41`, `FUN_00675b4f` | corpo **genérico** de worker (recebe o nome em runtime; ver §4) |

**[OBSERVADO] — Crawler/indexação.** Há literais de thread do crawler, amarrados a
`../../../src/sublime_text/index/crawler.cc`: `run_crawl_thread` (`0x1dcb19`, referenciado em
`FUN_006b9bd2`/`0x6b9da4…`) e `run_crawl_worker_thread` (`0x1d19d3`), com tags de execução
`sprintf("%u:crawl:%d")` (`0x1d0843`) e `%ucrawl%ds%d`/`%ucrawl%dr%d` (bancos de crawldb).
**[INFERIDO]** a indexação usa **threads de crawl próprias** (além de `index_builder`), rotuladas por
thread, não o `io_worker` pool.

**Como são criadas — fábrica central.**
**[OBSERVADO]** `FUN_004d1af4` (`0x4d1af4`) é a **fábrica de threads do núcleo**: faz
`pthread_attr_init` → **`pthread_attr_setstacksize(attr, 0x200000)` (stack de 2 MiB)** →
`pthread_create(thread, attr, start_routine, arg)` → `pthread_attr_destroy`, e devolve `pthread_t`
(o chamador então dá `pthread_detach`). Há também um invólucro fino `FUN_006b5cf0` (`0x6b5cf0`) que
chama `pthread_create` com `attr = NULL` (stack default). A fábrica `FUN_004d1af4` é citada em
**~8 sites de código** (`0x4d1abb`, `0x4d1ae9`, `0x63af12`, `0x64c1e2`, `0x64c3c8`, `0x675e3b`,
`0x6b3f8f`, `0x8e26f9`) — o conjunto de threads de background.

**[OBSERVADO]** erros de thread são tratados por helpers próprios com mensagens de `.rodata`:
`"thread constructor failed"` (`0x1d5fda`), `"thread::join failed"` (`0x1d6108`),
`"thread::detach failed"` (`0x1e299f`), `"__thread_specific_ptr construction failed"` (`0x1d3c63`).
Os invólucros `FUN_005a1160` (`0x5a1160`, `pthread_join`) e `FUN_006223a0` (`0x6223a0`,
`pthread_detach`) confirmam o par join/detach.

**Tamanho de pool / topologia.**
- **[OBSERVADO]** `FUN_007181de` (`0x7181de`) — parte do *bootstrap* de settings — lê o setting
  **`io_workers`** (`FUN_004bf0e0(…,"io_workers",…)`; string `0x1e8c5f`) e então **cria o pool de I/O
  em laço**, chamando `FUN_004d1acc` N vezes — o **tamanho N por setting** é **[INFERIDO]** (N
  derivado do setting e/ou do tamanho de um vetor).
  Há também os settings **`index_workers`** (`0x1ecee7`) e **`max_background_threads`** (`0x1d63b2`).
- **[OBSERVADO]** imports de topologia de CPU: `sysconf` (`0x103f34`), `sched_getaffinity`,
  `sched_setaffinity`, `sched_getcpu`, `__sched_cpucount` **[INFERIDO]** usados para dimensionar
  pools/afinidade (o jemalloc também usa esses — ver §7/§8).

> **Higiene:** **não** confundir com o **jemalloc**. Literais como `background_thread`,
> `max_background_threads (jemalloc)`, `opt.background_thread`, `stats.background_thread.*`,
> `narenas`, `arena 0 background thread creation` são **internos do alocador**, não threads do
> Sublime. [OBSERVADO] (mensagens `<jemalloc>: …`).

---

## 4. 🗂️ Filas de trabalho e pools

### 4.1 Classes de fila/runner (RTTI, `.rodata`/`.data.rel.ro`)

| Classe (RTTI) | Nome @ | Typeinfo @ | Papel arquitetural [INFERIDO] |
|---|---|---|---|
| `work_queue_runner` | `0x2305e0` | `0xa4da88` | **runner** genérico de uma `work_queue` |
| `basic_queue_runner` | `0x2305f4` | `0xa3d908` | runner-base de fila |
| `thread_queue_runner` | `0x230609` | `0xa3d920` | runner que **roda em thread própria** (`basic_queue_runner` é adjacente → herança) |
| `pipe_work_queue_runner` | `0x23be32` | — (nome ofuscado; ref. em `0x7c0a26`) | runner cujo **wakeup é por pipe** |
| `lazy_work_queue` | `0x2212e2` | `0xa2b6a8` | fila **preguiçosa** (cria recurso sob demanda) |
| `work_queue_timer_scheduler` | `0x23bb3b` | `0xa4cdb8` | agenda execução **por timer** |
| `timer_scheduler` | `0x23bb58` | `0xa4cda8` | base do agendador por timer (`work_queue_timer_scheduler` adjacente → herança) |
| `io_scheduler` | *(mangled)* | — | agendador de **I/O assíncrono** (pool `io_worker`) |
| `px_main_thread_scheduler` | `0x2213e9`… | — | despacha work items para a **main thread** |
| `async_file_system` | `0x223caa` | `0xa3cfd0` | FS assíncrono sobre `io_scheduler` + main scheduler |
| `crawler` | `0x221acb` | `0xa306e0` | crawler de indexação |

**[OBSERVADO]** o subsistema assíncrono é expresso na linguagem de **`promise`/`future_core` +
`assign_then_wrapper`/`async_wrapper`/`async_helper`/`bound_io_request`/`default_file_system`**
(nomes em typeinfo mangled, ex. `0x223cbe`, `0x223d9e`): uma operação de I/O é *bound* a um
`io_scheduler`, devolve uma *promise*, e a continuação (`then`) é agendada noutro executor.
**[OBSERVADO]** o `plugin_host` tem **`async_thread_queue_runner`** (`0x1a9ec2` lá), mas **o núcleo
não** — busca literal `"async_thread_queue_runner"` → **0** hits. [INFERIDO] o núcleo usa
`thread_queue_runner`/`pipe_work_queue_runner`; a variante "async thread" é do lado do host.

### 4.2 Dois pools concretos (não "1 thread por fila")

**Pool de I/O — N threads, 1 objeto de pool compartilhado.**
**[OBSERVADO]** `io_worker` (`FUN_004ce940`) é um laço infinito: verifica um **flag de shutdown em
`pool+0xc8`**; `pthread_mutex_lock(pool+0x80)`; varre uma **tabela de ~9–10 buckets** (contador
interno iniciando em `9`), retira o **head** de um bucket não vazio; `unlock`; se achou item,
**invoca método virtual em `item->vtable+0x18`** e então faz um **decremento atômico** de um
**contador de referência em `item+8`** (`LOCK/UNLOCK`), chamando o **destrutor** (`item->vtable[0]`)
quando chega a 0; se não achou, **espera numa condvar em `pool+0xa8`**. Ou seja: **itens de trabalho
são objetos com vtable e refcount atômico**, e **N `io_worker` compartilham UM pool**
(mutex + condvar + tabela de buckets).
**[OBSERVADO]** `FUN_004d1acc` (`0x4d1acc`) cria **um** `io_worker` (aponta o `pthread_t` em
`pool+0x20`); `FUN_004d1b50` (`0x4d1b50`) chama isso **em laço** → **pool de N threads**.

**Pool de leitura de arquivo — sob demanda, no máximo 2.**
**[OBSERVADO]** `FUN_0063ae9e` (`0x63ae9e`) implementa um pool **limitado e preguiçoso**: guardado por
um flag "já iniciado" (`DAT_00c99da4`), com mutex global `DAT_00c99d60`; em laço **de no máximo 2**
(`iVar3 = 2`), enquanto houver trabalho pendente na **fila global** (head `DAT_00c99d88` / tail
`DAT_00c99d90`), **cria um `file_read_thread`** (`FUN_008e3a08`) e o destaca, incrementando um
**contador de ativos** (`_DAT_00c99da0`). A própria `file_read_thread` (`FUN_008e3a08`) roda um
laço que, após terminar um item, espera ("sleep"/condvar) e **reavalia o contador global** — isto é,
**workers sob demanda** que se desligam quando não há fila.

**[INFERIDO]** portanto o padrão do núcleo é **pool-de-N** (I/O, dimensionado por setting) **e**
**pool-bounded-on-demand** (file-read, ≤2) — **não** "uma thread por fila".

**[DESCONHECIDO]** a composição exata do *work item* (campos além de vtable e refcount); a
semântica das ~10 buckets (hash por chave? faixas?); o número default de `io_workers`/`index_workers`.

---

## 5. 🔒 Primitivas de sincronização observadas

**[OBSERVADO]** imports em `.dynstr` (nomes exatos) e uso em código:

| Família | Primitivas importadas | Onde é usado |
|---|---|---|
| **pthread mutex** | `pthread_mutex_lock/unlock/trylock`, `_init/_destroy`, `_mutexattr_init/settype/destroy` | pool de I/O (`pool+0x80`), fila global de file-read (`DAT_00c99d60`) |
| **pthread cond** | `pthread_cond_init/wait/timedwait/signal/broadcast/destroy` | espera dos workers (`pool+0xa8`; `DAT_00c99d98`) |
| **pthread thread** | `pthread_create/join/detach/self`, `attr_init/setstacksize/destroy`, `sigmask` | fábrica `FUN_004d1af4`/`FUN_006b5cf0`; join `FUN_005a1160`; detach `FUN_006223a0` |
| **TLS pthread** | `pthread_key_create`, `getspecific`, `setspecific` | `index_builder` (set em `FUN_006b472a`); TLS genérico |
| **semáforos** | `sem_open/unlink/close`, `sem_init`, `sem_wait/post/trywait/timedwait` | **IPC do `plugin_host`** (canais shm) — não no pool interno |
| **atômicos** | (sem símbolo) representados no código por `LOCK()/UNLOCK()` | **refcount** de work item (`item+8`), **contador** do worker (`obj+0x30`), flag de estado |
| **std::condition_variable** | strings `"condition_variable::wait: mutex not locked"` (`0x1f85b1`), `"condition_variable timed_wait failed"` (`0x1ebd87`), `"condition_variable wait failed"` (`0x1d98ca`), `"condition_variable::timed wait: mutex not locked"` (`0x1d286e`) | **o núcleo usa `std::condition_variable` (libc++)** além dos pthread crus |
| **scheduler/CPU** | `sched_yield`, `sched_getaffinity/setaffinity`, `sched_getcpu`, `__sched_cpucount`, `sysconf` | afinidade/dimensionamento de pool [INFERIDO] |
| **fd/poll** | `poll`, `pipe`, `read`, `write`, `close` | wakeup e "error pipe" (ver §6) |
| **processo** | `posix_spawn`, `execvp` | spawn de processos filhos (§7) |

**[OBSERVADO]** o corpo genérico de worker `FUN_004cea41` faz: **flag atômica** (`LOCK/UNLOCK` em
`obj+0x30`), leitura de um **flag de controle** (`obj+0x34`), e um **`timed wait`** de condvar
(`FUN_005a86ca(obj+0x10, ms)`) — ou seja, um worker **com espera temporizada** (polling por
intervalo), típico de checagens periódicas (licença/update).

**[DESCONHECIDO]** se há barreiras (`pthread_barrier`), `rwlock` ou `std::atomic` explícito além do
que o Ghidra sintetiza como `LOCK/UNLOCK`.

---

## 6. 🔁 Handoff main ↔ background

**[OBSERVADO] — Wakeup por pipe + main loop GLib.** O núcleo tem uma **abstração de pipe própria**
(`../../../src/core/pipe.cc` @`0x1d635a`; construtor `FUN_00531f98` chama `pipe()` e erra com
`"Unable to call pipe"` `0x1fc4e5`) e a classe **`pipe_work_queue_runner`** (RTTI `0x23be32`).
Aliado a **`g_source_add_unix_fd`** + **`g_idle_add`**, o padrão é: **background escreve num fd de
pipe → o main loop GLib acorda → a callback roda no main thread**.

**[INFERIDO] — Resultado entregue por scheduler de main thread.** O tipo
**`px_main_thread_scheduler`** (`.rodata` `0x2213e9`, `0x23c530`, `0x23c63a`) com `sched_work_item<…>`
recebe itens de trabalho; nos nomes mangled ele é o alvo das continuações de `assign_then_wrapper`
para operações de `async_file_system` (ex. `read_file`, `stat_file`, `resolve_path` sobre
`io_scheduler`). Ou seja, **a conclusão de uma I/O no pool é re-agendada para o main thread**.

**[OBSERVADO] — Despacho pelo lado do trabalho.** O worker de I/O executa o item por
**chamada virtual** (`item->vtable+0x18`) e devolve o resultado via `promise`/`future_core`; a
continuidade é *"then"* num executor (`io_scheduler` ou `px_main_thread_scheduler`). Não foi
observado o uso de barreiras nem de spinlock como mecanismo de retorno.

**[OBSERVADO] — "Error pipe" para processos.** `FUN_0071f2c8` (`0x71f2c8`) cria um `pipe()` e o lê
com `poll()` + `read/write`, com a mensagem `"Failed to create error pipe"` (`0x1f105e`) e
`getrlimit` — **[INFERIDO]** é o caminho de **spawn de processo filho** (reporta erro do filho pelo
pipe antes do `exec`).

**[DESCONHECIDO]** o conjunto exato de callbacks postados à main thread; se há coalescing/batching;
o formato dos `sched_work_item`.

> **Nota de contrato com o `plugin_host`.** O host tem `g_main_thread_wait_count`,
> `g_is_main_thread_blocking/handling_message` (P0 §5) — o núcleo **compartilha** esse "core";
> porém no `sublime_text` esses nomes não são observáveis (stripped). As mensagens do host voltam ao
> núcleo pelo canal shm `subl_send` e são despachadas no main thread (ler
> [`ipc-plugin-host.md`](ipc-plugin-host.md)).

---

## 7. 🧬 Threads **dentro** do processo vs. **processos** separados

**[OBSERVADO] — Dentro do núcleo é tudo thread (mesmo espaço de endereço).**
Todos os itens das §2–§6 (main thread + pools + workers + crawler) são **threads POSIX** do
**mesmo processo** `sublime_text` (compartilham `.bss` globais como `DAT_00c99d60`, a fila
`DAT_00c99d88…` e o contador `_DAT_00c99da0`).

**[OBSERVADO] — O `plugin_host` é processo separado.** O núcleo **lança** o host com
`posix_spawn`/`execvp` (imports; `spawn_worker_process` string `0x1ebe78`; erros
`"unable to launch plugin_host"` `0x1d4e32`, `"]: unable to spawn worker "` `0x1d4e6a`,
`"]: failed to create shm channel for worker "` `0x1ebe8d`) e **comunica por memória compartilhada
POSIX + semáforos nomeados** (3 canais `subl_send`/`subl_recv`/`subl_arecv`) — detalhado em
[`ipc-plugin-host.md`](ipc-plugin-host.md). O `shm_reader` (`0x1f56d4`) é a thread **dentro do
núcleo** que lê o canal assíncrono (o canal é IPC; a leitura é thread).

**[OBSERVADO] — Biblioteca C++ compartilhada.** Há diretórios de fonte **comuns** citados no binário:
`src/core/ipc.cc`, `src/core/pipe.cc`, `src/core/process.cc` (+ `src/sublime_text/…`, `src/sgit/…`,
`src/update/…`). **[INFERIDO]** é por isso que o `plugin_host` exporta símbolos
(`work_queue_runner`, `is_main_thread`, `shm_channel`) que o `sublime_text` tem **estáticos e sem
nome** — **mesmo código, papéis diferentes**: no núcleo o core roda *in-process*; no host, ele é o
lado IPC.

**[OBSERVADO]** `crash_handler` é **outro processo** (servidor Crashpad; socketpair/sendmsg, sem
shm) — fora do modelo de threads do núcleo (IPC §7).

**Resumo:** **thread** = main thread (GTK/GLib), pool `io_worker` (N), pool `file_read_thread` (≤2),
`index_builder`, `task_worker`, crawler, `license_*`, `process_status`, `fetch_update_info`,
`shm_reader`. **Processo** = `plugin_host-3.14`/`plugin_host-3.3` (fork/exec + shm/sem) e
`crash_handler`.

---

## 8. 🧾 Evidências e limites

**Sólido (OBSERVADO, autoridade `shipped-artifact`):**
- Nomes de thread (`prctl`) e a fábrica de thread (`pthread_create` + `setstacksize 0x200000`).
- Classe/papel dos runners/pools (RTTI) e os dois pools concretos (I/O N — **tamanho N [INFERIDO]**;
  file-read ≤2 on-demand).
- Primitivas: lista de imports `pthread_*`/`sem_*`/`sched_*`/`poll`/`posix_spawn`/`g_source_*` e a
  presença de `std::condition_variable` e de atômicos (`LOCK/UNLOCK`) em refcount/contador.
- Event loop GTK/GLib (`gtk_main`, `g_source_add_unix_fd`, `g_idle_add`), GTK via `dlopen`.
- `plugin_host` = processo (posix_spawn/execvp) + shm/sem; `crash_handler` = processo separado.

**Médio (INFERIDO):** que `px_main_thread_scheduler` é o veículo do retorno de callbacks ao main
thread; que `sched_*`/`sysconf` dimensionam pools; a topologia de herança
(`thread_queue_runner: basic_queue_runner`, `work_queue_timer_scheduler: timer_scheduler`).

**Limites técnicos:**
1. Binário **stripped** ⇒ zero nomes de função; todo mapeamento função→papel é por **endereço +
   literais de `prctl`/RTTI**, não por símbolo.
2. `list_names` excede o orçamento de resposta (herdado de P1.1) — não uso para enumerar classes.
3. Os **vtables** não são xref-áveis de forma confiável (xrefs aos typeinfo retornam vazio), então a
   associação classe→métodos foi por adjacência de typeinfo + leitura de corpo.
4. Contadores de "main thread blocking/handling message" **não** foram confirmados no núcleo.

**Não copiado:** nenhuma rotina do alvo foi transcrita; as §§3–6 descrevem apenas **papéis,
assinaturas, contagens e endereços**.

---

## 9. 🧮 LEDGER de evidências

| # | Conclusão | Tipo de evidência | Endereço / Evidence ID | Limites |
|---|---|---|---|---|
| E1 | Event loop = GTK3/GLib (`gtk_main`); GTK via `dlopen`; GLib/X11 diretos | string + import | `gtk_main` `0x1d204c`; `dlopen` `0x1032ef`, `dlsym` `0x1032e9`; `libglib-2.0.so.0` `0x1047c4` | `gtk_main` é literal, não import |
| E2 | Integração de fds no main loop via GLib sources | import | `g_source_add_unix_fd` `0x103534`, `g_source_attach` `0x103598`, `g_idle_add` `0x103602`; `poll` `0x1041c3` | papel por assinatura |
| E3 | TLS: seção `.tdata` + `thread_local g_tls_worker` | segmento + string | `.tdata` `0xa20ca0–0xa216e8`; `_ZTH12g_tls_worker` `0x104070` | variável static (sem nome) |
| E4 | Identidade de thread por TLS (`pthread_key_create`/`getspecific`/`setspecific`) e `sched_setaffinity` | import | imports em `.dynstr`; `pthread_setspecific` usado em `FUN_006b472a` | mecanismo de main-thread = DESCONHECIDO |
| E5 | Setter de nome de thread = `prctl(PR_SET_NAME)` | pseudocode | `FUN_004ce933` `0x4ce933`; 12 call-sites | `pthread_setname_np` importado mas não usado aqui |
| E6 | Nomes de thread (`io_worker`,`file_read_thread`,`index_builder`,`task_worker`,`process_status`,`license_check`,`license_notification`,`fetch_update_info`, genéricos) | pseudocode + string | corpos em `0x4ce940/0x8e3a08/0x6b472a/0x720204/0x71f0b4/0x64c3da/0x64a6d0/0xa0bcb0/0x4cea41` | papel por inferência |
| E7 | `shm_reader` é thread do núcleo (canal async do host) | string + IPC | `0x1f56d4`; [`ipc-plugin-host.md`](ipc-plugin-host.md) §5 | leitor do canal, não mecanismo |
| E8 | Fábrica central de threads: `pthread_create` + stack `0x200000` (2 MiB) | pseudocode | `FUN_004d1af4` `0x4d1af4`; invólucro `FUN_006b5cf0` `0x6b5cf0` | stack fixa 2 MiB |
| E9 | Pool de I/O = N `io_worker` sobre 1 pool (mutex `+0x80`, cond `+0xa8`, tabela ~10 buckets, shutdown `+0xc8`) | pseudocode | `FUN_004ce940` `0x4ce940`; spawn `FUN_004d1acc`/`FUN_004d1b50` | buckets sem semântica |
| E10 | Pool de file-read sob demanda, **máx 2**, fila global + contador de ativos | pseudocode | `FUN_0063ae9e` `0x63ae9e`; fila `DAT_00c99d88/90`, ativos `_DAT_00c99da0`, mutex `DAT_00c99d60`, flag `DAT_00c99da4` | "2" é literal |
| E11 | Itens de trabalho = objetos com vtable + **refcount atômico**; executados por chamada virtual | pseudocode | `FUN_004ce940` (`item+8`, `LOCK/UNLOCK`, `item->vtable+0x18`) | campos internos do item = DESCONHECIDO |
| E12 | Classes de fila/runner (RTTI) e hierarquias por adjacência | string/RTTI + xref | `work_queue_runner`@`0xa4da88`; `basic`@`0xa3d908`; `thread`@`0xa3d920`; `timer_scheduler`@`0xa4cda8`; `work_queue_timer_scheduler`@`0xa4cdb8`; `lazy_work_queue`@`0xa2b6a8` | vtables não xref-áveis |
| E13 | Núcleo **não** tem `async_thread_queue_runner` | busca negativa (bounded) | literal → 0 hits | negativo limitado ao inventário de strings |
| E14 | Modelo assíncrono: `promise`/`future_core`/`async_wrapper`/`io_scheduler`/`async_file_system` | typeinfo mangled | `0x223cbe`, `0x223caa`; `io_scheduler` (mangled) | sem corpo por operação |
| E15 | Main-thread scheduler = `px_main_thread_scheduler` (`sched_work_item`) | typeinfo mangled | `0x2213e9`, `0x23c530`, `0x23c63a`, `0x2c97bd`, `0x2c9949` | veículo de retorno inferido |
| E16 | Wakeup por pipe: `src/core/pipe.cc` + `pipe_work_queue_runner` | string + pseudocode | `pipe.cc` `0x1d635a`; `FUN_00531f98` (chama `pipe()`); RTTI `0x23be32` (ref `0x7c0a26`) | ligação pipe↔runner por nome |
| E17 | `std::condition_variable` (libc++) + pthread cru coexistem | string | `0x1f85b1`, `0x1ebd87`, `0x1d98ca`, `0x1d286e` | — |
| E18 | Settings de sizing: `io_workers`, `index_workers`, `max_background_threads` | string + pseudocode | `0x1e8c5f`, `0x1ecee7`, `0x1d63b2`; bootstrap `FUN_007181de` | default = DESCONHECIDO |
| E19 | `plugin_host` = processo (`posix_spawn`/`execvp`) + shm/sem | import + string + IPC | `posix_spawn`/`execvp`; `spawn_worker_process` `0x1ebe78`; [`ipc-plugin-host.md`](ipc-plugin-host.md) | consolidado |
| E20 | Core C++ compartilhado (`src/core/{ipc,pipe,process}.cc`) ⇒ mesmos símbolos no host, estáticos no núcleo | string | `0x1d7716`, `0x1d635a`, `0x1e576b` | explica `is_main_thread` do host |
| E21 | Segmentos/contagens do alvo | binary_overview | image base `0x100000`, `.text`/`.rodata`/`.tdata`/`.bss`; `ev_e406088b…502a9` | PIE; endereços relativos |

---

### TL;DR para a Fase 3 (Electron/TS)

- **Main thread = UI thread**; rode o loop de eventos (Electron: o processo *main* + `BrowserWindow`
  no *renderer*) e mantenha um **scheduler de main thread** explícito para callbacks.
- **Não bloqueie o main thread**: replique o padrão **pool-de-N** (I/O, dimensionado por setting) e
  **pool-bounded-on-demand** (leitura de arquivo, ≤2) com **itens de trabalho refcountados**.
- **Wakeup por pipe + fonte de evento**: no Electron/Node, `worker_threads` + `MessageChannel`/
  `BroadcastChannel` cumprem o papel do *pipe + GLib source*; resultados voltam por **mensagem** e a
  continuação roda no main thread.
- **Sincronização**: prefira `std`-like (`Atomics`, `Mutex`/`SharedArrayBuffer`) ou primitivas de
  alto nível dos workers; o alvo usa `pthread mutex/cond` + `std::condition_variable` + atômicos.
- **Separe processo de thread**: `plugin_host` é **outro processo** (spawn + IPC) — no Electron, um
  **utility/child process** com IPC, e **não** uma thread.
- **Ferramentas de diagnóstico**: nomeie threads/workers (o alvo usa `prctl(PR_SET_NAME)`) e exponha
  "main thread ocupada?" como métrica (o host tem `g_is_main_thread_blocking/handling_message`).
