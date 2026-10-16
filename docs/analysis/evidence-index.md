# Índice consolidado de evidências — Fase 1 (P1.5) 🗂️

> **Entregável:** **P1.5** — o **ledger consolidado** dos 7 artefatos de análise da Fase 1, num único
> índice navegável por *namespace* de IDs. Alvo: o executável ELF64 x86-64 PIE **stripped**
> `target/sublime_text/sublime_text`
> (`sha256 8b105b1839d7809f60ec186b6c6dcb2d107e22ad23f42c5f8ba7dec67ab43d92`), com cross-check nos
> artefatos irmãos (`plugin_host-3.14`, `plugin_host-3.3`, `Packages/*`).
> Realizado em **2026-10-16**.
> **Método:** **extração mecânica** dos ledgers já publicados em
> [`buffer-structure.md`](buffer-structure.md) §7 · [`concurrency.md`](concurrency.md) §9 ·
> [`api-python.md`](api-python.md) §5–§6 · [`ipc-plugin-host.md`](ipc-plugin-host.md) §8–§9 ·
> [`ipc-protocol.md`](ipc-protocol.md) §7–§8 · [`render-pipeline.md`](render-pipeline.md) (ledger) ·
> [`packaging.md`](packaging.md) §9–§10. **Nenhuma análise nova foi feita**: as células de conclusão,
> tipo, evidência e limites foram transcritas (cortadas com `…` quando longas) e os **IDs originais
> foram preservados** no nome, apenas prefixados com um *namespace* por tema. Nenhum bloco de código,
> assembly ou pseudocódigo do alvo é reproduzido; rótulos `[OBSERVADO]`/`[INFERIDO]`/`[DESCONHECIDO]`
> seguem **exatamente** como constam nos docs-fonte.

**Achado central (1 frase):** os 7 ledgers da Fase 1 somam **179 linhas** de evidência (intervalos
`E1–E33`, `E1–E14`, `E1–E21`, `1–26`, `E1–E36`, `E1–E27`, `E1–E22`), sem lacuna de numeração em
nenhum deles, e convergem para uma arquitetura em **3 fronteiras**: o **núcleo C++** compartilhado
(`src/core`), a **ponte IPC por anel em shm + CPython embutido** (`plugin_host`) e o **render por
`px_render_context`** na GTK main thread.

**Docs irmãos (Fase 1):** [`buffer-structure.md`](buffer-structure.md) (P1.1) ·
[`concurrency.md`](concurrency.md) (P1.2) · [`ipc-protocol.md`](ipc-protocol.md) (P1.3) ·
[`render-pipeline.md`](render-pipeline.md) (P1.4) · [`ipc-plugin-host.md`](ipc-plugin-host.md)
(Track A) · [`api-python.md`](api-python.md) (API de plugins) · [`packaging.md`](packaging.md) (P1.6).

---

## 1. 🧭 Como ler

**Namespace de IDs.** Cada linha recebe `<PREFIXO>-<id original>`, onde o prefixo identifica o
tema/doc-fonte e o `id` é o **identificador da fonte** (preservado; nenhum item foi reordenado ou
renumerado):

| Prefixo | Tema | Doc-fonte | Faixa original |
|---|---|---|---|
| `BUF-` | Estrutura de buffer (P1.1) | [`buffer-structure.md`](buffer-structure.md) §7 | `E1–E14` |
| `CON-` | Concorrência (P1.2) | [`concurrency.md`](concurrency.md) §9 | `E1–E21` |
| `PY-` | API de plugins (IPC Python) | [`api-python.md`](api-python.md) §5 | `E1–E33` |
| `HOST-` | Ponte C++↔CPython (`plugin_host`) | [`ipc-plugin-host.md`](ipc-plugin-host.md) §9 | `1–26` (sem `E`) |
| `IPC-` | Wire protocol (P1.3) | [`ipc-protocol.md`](ipc-protocol.md) §8 | `E1–E36` |
| `REN-` | Pipeline de render (P1.4) | [`render-pipeline.md`](render-pipeline.md) ledger | `E1–E27` |
| `PKG-` | Empacotamento (P1.6) | [`packaging.md`](packaging.md) §9 | `E1–E22` |

Exemplos de leitura: `BUF-E7` = linha `E7` de `buffer-structure.md`; `PY-E33` = linha `E33` de
`api-python.md`; `HOST-E21` = linha `21` de `ipc-plugin-host.md` (**esta fonte não usa o marcador
`E`** — o `E` foi **normalizado** no índice para uniformizar as 7 tabelas; o número é o ID original).
`IPC-E22–E36` já chegam renumerados na própria fonte (opcodes `B1–B15` → `E22–E36`).

**Legenda de `Tipo de evidência`.** A coluna é a **célula original** de tipo/confiança do doc-fonte,
que **não é uniforme** entre temas: `A` = artefato/Python legível · `I` = inferência forte
(a partir do call-site) · `U` = incógnita · `A+I` = misto (`api-python.md`); `disassembly`, `strings`,
`symbols`/`símbolos`, `readelf -d`, `bytes`, `typeinfo`, `pseudocode`, `string (RTTI) + typeinfo`,
`binary_overview`, `inventário`, `zip-layout`, `yaml`, `manifest` (demais fontes); `[OBSERVADO]`/
`[INFERIDO]` (`render-pipeline.md`); `inferência` (`IPC-E19`).

**Legenda de `Limites`.** Quando o doc-fonte usa **confiança** em vez de limites
(`ipc-plugin-host.md`, `ipc-protocol.md`), a célula é transcrita como `confiança: <valor>`
(preservando o valor original: `alta`, `média`, `alta (média em …)`); `—` indica limite ausente ou
`—` na fonte.

---

## 2. 🧱 Buffer (P1.1)

Fonte: [`buffer-structure.md`](buffer-structure.md) §7 — `| E# | Conclusão | Tipo de evidência | Endereço / Evidence ID | Limites |`.

| Evidence ID | Conclusão | Tipo de evidência | Evidência (endereço/ID) | Limites |
|---|---|---|---|---|
| BUF-E1 | Buffer = classe `TextBuffer` (global), com `TextBufferView`/`TextBufferSelection` | string (RTTI) + typeinfo | `0x25c02b`, `0x25c119`, `0x25c0f5`; `ev_a746a9d6…85bb0`, `ev_30284ae9…de9e66` | nomes demangled; sem método associado |
| BUF-E2 | Nenhuma classe `Piece`/`Rope`/`GapBuffer`/`LineIndex` (negativo *bounded*) | string (busca) | `ev_02c12454…d5d39`, `ev_7934636f…4c5cf`, `ev_6b0369e2…101ebb`, `ev_e03f19ca…e4287`, `ev_a93ae5ea…4670` | cobre só strings definidas pelo Ghidra |
| BUF-E3 | `TextBuffer` tem 2 vptrs; `__vmi` com 2 bases (SpellingListener + virtual) | typeinfo/data xref | typeinfo `0xa5cbe0`; vtables refs `0xa5cb88`/`0xa5cbb0`; `ev_72c00e9d…23588`, `ev_33a4fb6f…34b7b` | base #1 não nomeada |
| BUF-E4 | Construtor `FUN_0048f29c` aloca core `0x108` B em `+0x250` e `TokenStorage` `0x328` B em `+0x2f0` | pseudocode | `0x48f29c`; `ev_a1eb709a…6fef8` | offsets via código, não struct |
| BUF-E5 | Destrutor libera buffers de heap + array de registros `0x20` B do core | pseudocode | `0x4cbde8` (dtor), `0x4cb9a2`, `0x4cbb76`; `ev_54a587d4…9eca77` | registro de `0x20` B não tipado |
| BUF-E6 | Core embute subobjeto `observer` (padrão observer) e `TokenStorage:LayoutTracker` | typeinfo + pseudocode | `observer` ti `0xa46c48`; `TokenStorage` ti `0x2c7cc4`; `ev_dff0fa23…ab1183` | observer ≠ storage |
| BUF-E7 | Reset zera **11 pares `{begin,end}`** (passo `0x18`) = múltiplos vetores de heap | pseudocode | `0x8f5c88`; `ev_c69a5af4…8ace9b` | objeto interno; sem semântica por vetor |
| BUF-E8 | Edição modelada por comandos (`text_command`→`insert/append/…delete`) com nome/descrição | string + vtable + pseudocode | nomes `0x25c2f0`,`0x25c310`,`0x25c33d`,`0x25c34b`; vtables `0xa5d898`,`0xa5e030`; `0x922d70`→`"insert"`; `ev_3b55a3f5…1c73a` | só papéis, sem corpo |
| BUF-E9 | Vocabulário de undo/redo (stacks, grupos, gluing, soft) | string | `0x1ebfbb`,`0x1f0fa9`,`0x1e4df4`,`0x1dc22c`,`0x1fcef1`,`0x1fb398`,`0x1f07dd`; `ev_0a1d83a4…ed6b82`, `ev_b52a9a93…af02e`, `ev_8c5d1044…9d1f9` | strings também servem de nome de comando |
| BUF-E10 | `clear_undo_stack` só limpa com `+0x4d0==0`, senão aborta; grupos em `+0x3e0/+0x400/+0x420` | pseudocode + xref | `0x46c5d8` (ref `0x46c687`); `ev_c272b26a…6c2fc`; xref `undo_stack` `ev_7afac4a1…7cd0` | offsets via código |
| BUF-E11 | Mudança = objeto `0x68` B com sub-array de registros `0xa8` B (delta-based) | pseudocode | `0x48ba70`, `0x48bad8`, `0x48ee28`; `ev_e2108e84…2f8f7` | conteúdo do `0xa8` desconhecido |
| BUF-E12 | Strings internas em **UTF-32 com SSO** (4 B/char) | pseudocode | `0x46ba2c`, `0x67273c`; `ev_c272b26a…6c2fc` | corpo do documento pode diferir |
| BUF-E13 | Região de type-descriptors RTTI em `.rodata` (classe/vtable por typeinfo) | read_bytes | `0x25bf00..`, `0x25c040..`; `ev_c29b1ba5…4236c` | desambiguação por xref manual |
| BUF-E14 | Cabeçalho de segmentos/contagens do alvo | binary_overview | image base `0x100000`, 33 segm., 26 455 procs, 9 683 strings; `ev_e406088b…502a9` | PIE; endereços relativos |

---

## 3. 🧵 Concorrência (P1.2)

Fonte: [`concurrency.md`](concurrency.md) §9 — `| # | Conclusão | Tipo de evidência | Endereço / Evidence ID | Limites |`.

| Evidence ID | Conclusão | Tipo de evidência | Evidência (endereço/ID) | Limites |
|---|---|---|---|---|
| CON-E1 | Event loop = GTK3/GLib (`gtk_main`); GTK via `dlopen`; GLib/X11 diretos | string + import | `gtk_main` `0x1d204c`; `dlopen` `0x1032ef`, `dlsym` `0x1032e9`; `libglib-2.0.so.0` `0x1047c4` | `gtk_main` é literal, não import |
| CON-E2 | Integração de fds no main loop via GLib sources | import | `g_source_add_unix_fd` `0x103534`, `g_source_attach` `0x103598`, `g_idle_add` `0x103602`; `poll` `0x1041c3` | papel por assinatura |
| CON-E3 | TLS: seção `.tdata` + `thread_local g_tls_worker` | segmento + string | `.tdata` `0xa20ca0–0xa216e8`; `_ZTH12g_tls_worker` `0x104070` | variável static (sem nome) |
| CON-E4 | Identidade de thread por TLS (`pthread_key_create`/`getspecific`/`setspecific`) e `sched_setaffinity` | import | imports em `.dynstr`; `pthread_setspecific` usado em `FUN_006b472a` | mecanismo de main-thread = DESCONHECIDO |
| CON-E5 | Setter de nome de thread = `prctl(PR_SET_NAME)` | pseudocode | `FUN_004ce933` `0x4ce933`; 12 call-sites | `pthread_setname_np` importado mas não usado aqui |
| CON-E6 | Nomes de thread (`io_worker`,`file_read_thread`,`index_builder`,`task_worker`,`process_status`,`license_check`,`license_notification`,`fetch_update_info`, genéricos) | pseudocode + string | corpos em `0x4ce940/0x8e3a08/0x6b472a/0x720204/0x71f0b4/0x64c3da/0x64a6d0/0xa0bcb0/0x4cea41` | papel por inferência |
| CON-E7 | `shm_reader` é thread do núcleo (canal async do host) | string + IPC | `0x1f56d4`; [`ipc-plugin-host.md`](ipc-plugin-host.md) §5 | leitor do canal, não mecanismo |
| CON-E8 | Fábrica central de threads: `pthread_create` + stack `0x200000` (2 MiB) | pseudocode | `FUN_004d1af4` `0x4d1af4`; invólucro `FUN_006b5cf0` `0x6b5cf0` | stack fixa 2 MiB |
| CON-E9 | Pool de I/O = N `io_worker` sobre 1 pool (mutex `+0x80`, cond `+0xa8`, tabela ~10 buckets, shutdown `+0xc8`) | pseudocode | `FUN_004ce940` `0x4ce940`; spawn `FUN_004d1acc`/`FUN_004d1b50` | buckets sem semântica |
| CON-E10 | Pool de file-read sob demanda, **máx 2**, fila global + contador de ativos | pseudocode | `FUN_0063ae9e` `0x63ae9e`; fila `DAT_00c99d88/90`, ativos `_DAT_00c99da0`, mutex `DAT_00c99d60`, flag `DAT_00c99da4` | "2" é literal |
| CON-E11 | Itens de trabalho = objetos com vtable + **refcount atômico**; executados por chamada virtual | pseudocode | `FUN_004ce940` (`item+8`, `LOCK/UNLOCK`, `item->vtable+0x18`) | campos internos do item = DESCONHECIDO |
| CON-E12 | Classes de fila/runner (RTTI) e hierarquias por adjacência | string/RTTI + xref | `work_queue_runner`@`0xa4da88`; `basic`@`0xa3d908`; `thread`@`0xa3d920`; `timer_scheduler`@`0xa4cda8`; `work_queue_timer_scheduler`@`0xa4cdb8`; `lazy_work_queue`@`0xa2b6a8` | vtables não xref-áveis |
| CON-E13 | Núcleo **não** tem `async_thread_queue_runner` | busca negativa (bounded) | literal → 0 hits | negativo limitado ao inventário de strings |
| CON-E14 | Modelo assíncrono: `promise`/`future_core`/`async_wrapper`/`io_scheduler`/`async_file_system` | typeinfo mangled | `0x223cbe`, `0x223caa`; `io_scheduler` (mangled) | sem corpo por operação |
| CON-E15 | Main-thread scheduler = `px_main_thread_scheduler` (`sched_work_item`) | typeinfo mangled | `0x2213e9`, `0x23c530`, `0x23c63a`, `0x2c97bd`, `0x2c9949` | veículo de retorno inferido |
| CON-E16 | Wakeup por pipe: `src/core/pipe.cc` + `pipe_work_queue_runner` | string + pseudocode | `pipe.cc` `0x1d635a`; `FUN_00531f98` (chama `pipe()`); RTTI `0x23be32` (ref `0x7c0a26`) | ligação pipe↔runner por nome |
| CON-E17 | `std::condition_variable` (libc++) + pthread cru coexistem | string | `0x1f85b1`, `0x1ebd87`, `0x1d98ca`, `0x1d286e` | — |
| CON-E18 | Settings de sizing: `io_workers`, `index_workers`, `max_background_threads` | string + pseudocode | `0x1e8c5f`, `0x1ecee7`, `0x1d63b2`; bootstrap `FUN_007181de` | default = DESCONHECIDO |
| CON-E19 | `plugin_host` = processo (`posix_spawn`/`execvp`) + shm/sem | import + string + IPC | `posix_spawn`/`execvp`; `spawn_worker_process` `0x1ebe78`; [`ipc-plugin-host.md`](ipc-plugin-host.md) | consolidado |
| CON-E20 | Core C++ compartilhado (`src/core/{ipc,pipe,process}.cc`) ⇒ mesmos símbolos no host, estáticos no núcleo | string | `0x1d7716`, `0x1d635a`, `0x1e576b` | explica `is_main_thread` do host |
| CON-E21 | Segmentos/contagens do alvo | binary_overview | image base `0x100000`, `.text`/`.rodata`/`.tdata`/`.bss`; `ev_e406088b…502a9` | PIE; endereços relativos |

---

## 4. 🐍 IPC Python — API de plugins (`api-python`)

Fonte: [`api-python.md`](api-python.md) §5 — `| # | Conclusão | Arquivo:linha | Tipo | Limite / incerteza |`.
`Tipo`: **A** = artefato/Python legível (fato), **I** = inferência forte, **U** = incógnita.

| Evidence ID | Conclusão | Tipo de evidência | Evidência (endereço/ID) | Limites |
|---|---|---|---|---|
| PY-E1 | Ponte é o módulo nativo `sublime_api` | A | `python314/sublime.py:12`, `python314/sublime_plugin.py:16` | Nome do módulo é tudo que se vê; ABI/assinatura nativas não estão no tarball |
| PY-E2 | 284 símbolos nativos distintos usados | A | contagem em `python314/*.py` (276 em `sublime.py`, 14 em `sublime_plugin.py`) | Pode existir símbolo nativo **não usado** pelo Python (invisível aqui) |
| PY-E3 | Facade stateless; estado no C++ | A+I | `python314/sublime.py` sem globais mutáveis; `:38-39` | `sublime_plugin.py` **tem** registries globais (`:31-143`) |
| PY-E4 | Handles opacos + identidade por id | A | `sublime.py:3774`, `:3826`, `:2080`, `:2098`, `:2635`, `:1374`, `:2452`, `:2329` | Semântica de colisão/reciclagem de ids no C++ é desconhecida |
| PY-E5 | Sem cache global de objetos; instâncias recriadas | A | `sublime.py:1337`, `:3763` | Há **memoização por instância** de `Settings` (`:1375-1377`, `:2637-2639`) |
| PY-E6 | `sheet_id` codifica o subtipo (`& 3`) | A | `sublime.py:2436-2443` | Semântica dos 2 bits além do dispatch é inferida |
| PY-E7 | `make_sheet` inválido agora levanta `ValueError` (3.3 devolvia `None`) | A | `python314/sublime.py:2443` vs `python33/sublime.py:1157` | Mudança observável de contrato; pode quebrar plugin que testava `None` |
| PY-E8 | Validação de liveness via nativo | A | `sublime.py:1396`; `sublime_plugin.py:477`, `:485` | Regra exata de invalidação (por thread?) é do C++ |
| PY-E9 | Callbacks Python retidos no C++ | A | `sublime.py:1315`, `:1323`, `:888`, `:910`, `:934`, `:959`, `:1015`, `:2559`, `:3498`, `:3469-3483`, `:3943` | Tempo de vida/thread de execução do callback é inferência |
| PY-E10 | Objeto Python inteiro retido (`TextChangeListener`) | A | `sublime_plugin.py:2299` (add) / `:2273` (clear) | Ciclo de vida referenciado pelo C++ → risco de leak se não desanexar |
| PY-E11 | Dispatch nativo→`on_*` converte id→objeto no fim | I | `sublime_plugin.py:711-728` | Forte: 53 hooks recebem `*_id: int`; o C++ não está no tarball |
| PY-E12 | 53 eventos, 19 `_async` | A | `sublime_plugin.py:43-97`; contagem `_async:67-96` | Nomes listados são o contrato; ordem de disparo do C++ é desconhecida |
| PY-E13 | `EventListener`/`ViewEventListener` são duck-typed (hooks só em docstring) | A | `python314/sublime_plugin.py:1676-1983`, `:1984-2203`; filtro `hasattr` em `:706-708` | `el_callbacks` (`:702`) **não** filtra por `hasattr` → hook ausente em `EventListener` = `AttributeError` |
| PY-E14 | Ordem: VEL antes de EL em `on_text_command` | A | `sublime_plugin.py:1012-1027` | Vale para esse hook; ordem em outros é a do loop |
| PY-E15 | Exclusões EL-only (25 nomes) e hooks de TCL (6) | A | `python314/sublime_plugin.py:106-132`, `:135-142` | — |
| PY-E16 | Comandos trafegam como tuplas `(instância, nome)` | A | `sublime_plugin.py:495-531` | Formato exato consumido pelo C++ não é verificável aqui |
| PY-E17 | Edit token aberto/fechado pelo host | A | `sublime_plugin.py:1639-1653`; `sublime.py:2851`, `:2855`, `:2859` | `edit_token` vem do nativo (`run_(edit_token, args)`) — origem U |
| PY-E18 | Fallback de Command Palette via `*_can_accept_input` | A | `sublime_plugin.py:1565`, `:1606`, `:1656` | Heurística é `TypeError` por argumento faltante (`:1564`, `:1605`, `:1655`) |
| PY-E19 | Pacotes `.sublime-package` resolvidos por meta-path + recursos nativos | A | `sublime_plugin.py:2310-2434`, `:2405` | Formato do zip e cache `.pyc` (`__pycache__`, `:2396-2403`) |
| PY-E20 | `decode_value` devolve `(value, err)` do nativo | A | `sublime.py:1271-1274` | Erros viram `ValueError` |
| PY-E21 | `print()` de plugin vira log do host | A | `sublime.py:18-39` | Sem timestamp/formatação conhecida — o nativo formata |
| PY-E22 | `lib_path` gateia `site`/SSL e tolera mock | A | `sublime_plugin.py:2439-2445` | Comentário no próprio código (`:2437-2438`) confirma o caso de mock |
| PY-E23 | 5 símbolos nativos novos em 3.14 | A | `sublime.py:811`, `:3531`, `:3875`; `sublime_plugin.py:2346`, `:2349` | Comparação 279→284 por diff de call-sites |
| PY-E24 | Superfície de módulo 3.3→3.14: só `+lib_path` | A | 63 vs 64 função de módulo; `python314/sublime.py:805` | Comparação por nome de função |
| PY-E25 | `sublime_plugin`: `set_override_path` saiu, `split_identifier` entrou | A | `python33/sublime_plugin.py:1746` vs `python314/sublime_plugin.py:1110` | — |
| PY-E26 | `el_callbacks`/`vel_callbacks` perderam `listener_only` | A | `python33/sublime_plugin.py:691-699` vs `python314/sublime_plugin.py:702-708` | — |
| PY-E27 | Async: main thread vs worker e `MultiCompletionList` acumulador | A | `sublime.py:1309`, `:1318`, `:4105-4126`; `sublime_plugin.py:982`, `:997-1002` | Garantia de thread-safety é **do nativo** (`MultiCompletionList_append` citado em `sublime.py:4120`) |
| PY-E28 | Handshake `api_ready` + `deferred_plugin_loadeds` + re-síntese de `on_activated_async` | A | `sublime_plugin.py:27-29`, `:456-487`, `:534-543` | Motivo do atraso (ordem do C++) é inferência |
| PY-E29 | `Settings` dict-like com `to_dict`/`setdefault`/`update` | A | `sublime.py:3829-3914`; `to_dict` usa `settings_to_dict` (`:3875`) | `3.3` só tinha a forma antiga (`python33/sublime.py:1898-1921`) |
| PY-E30 | `sublime_types.py` = 8 aliases PEP 695 (não 9) | A | `python314/sublime_types.py:3-10` | Correção da estimativa do esqueleto |
| PY-E31 | `imp.py` = shim de 3 nomes | A | `python314/imp.py:5-8` | — |
| PY-E32 | `View` concentra a superfície (133 métodos, 133 chamadas nativas) | A | `python314/sublime.py:2626-3761` | Classe inequivocamente central — alvo nº 1 do shim TS |
| PY-E33 | Classes puramente Python (native = 0) | A | `sublime.py:2071-2320`, `:3953-4082`, `:4129-4246`, `:4296-4455` | Não precisam do nativo → portáveis direto para TS |

---

## 5. 🧷 IPC host — ponte C++↔CPython (`plugin_host`)

Fonte: [`ipc-plugin-host.md`](ipc-plugin-host.md) §9 —
`| # | Conclusão | Evidência | Tipo | Confiança |`. A coluna **Confiança** foi transcrita na coluna
`Limites` como `confiança: <valor>`. Os IDs `1–26` da fonte **não** usam `E`; no índice foram
normalizados para `HOST-E<n>`.

| Evidence ID | Conclusão | Tipo de evidência | Evidência (endereço/ID) | Limites |
|---|---|---|---|---|
| HOST-E1 | IPC = memória compartilhada POSIX nomeada + semáforos nomeados | disassembly (`objdump -d` PLT calls) | `create_shared_memory` chama `shm_open`/`ftruncate`/`mmap`/`close`; `create_shm_channel` chama `sem_open` ×2; `destroy` faz `sem_unlink` ×2; `close` faz `munmap`+`sem_close` ×2 | confiança: **alta** |
| HOST-E2 | Três canais: `subl_send`, `subl_recv`, `subl_arecv` | disassembly + strings | 3× `sprintf("%s:subl_%s%s")` + 3× `open_shm_channel` em `main`; strings nos dois lados | confiança: **alta** |
| HOST-E3 | Núcleo cria; host só abre | disassembly + string | host-3.14/3.3: zero chamadas a `create_shm_channel`; 3× chamada a `open_shm_channel`; núcleo tem `]: failed to create shm channel for worker ` | confiança: **alta** |
| HOST-E4 | Nome = `<id>:subl_<canal>-<versão>`, prefixado com `/` | disassembly + `.data` | literais `%u:subl_*%s` (núcleo) e `%s:subl_*%s` (host); `-%s` @`0x75cb5` + literal `"3.14"` (`0x20fc31`) / `"3.3"` (`0x636680`); prefixo `/` (constante `0x2f`) prependido antes de `shm_open` | confiança: **alta** (média em `argv[1]`=PID) |
| HOST-E5 | Mutex por canal + 2 semáforos (leitura/escrita) | disassembly | `write_message`: `pthread_mutex_lock`→`write_bytes`→`unlock`→`signal_reader`; `signal_*`: desvia para `sem_post` | confiança: **alta** |
| HOST-E6 | Espera com timeout no `read`, bloqueante no `write` | disassembly | `wait_read_signal`: `sem_wait`+`clock_gettime`+`sem_timedwait`; `wait_write_signal`: desvia para `sem_wait` | confiança: **alta** |
| HOST-E7 | Mensagem tem prefixo de comprimento | disassembly | `read_message`: `read_bytes`→`string_buffer::resize`→`read_bytes` | confiança: **alta** |
| HOST-E8 | Dispatch por `handle_protocol_message(unsigned long, string_buffer const&)` | símbolo + disassembly | símbolo `_Z23handle_protocol_messagemRK13string_buffer` @`0x17677e`, chamado no loop de `main` | confiança: **alta** |
| HOST-E9 | Enum de protocolo textual `api_*` (281/282 comandos) | strings | `strings \| grep '^api_…$'` = 281 (3.14), 282 (3.3) | confiança: **média** (contagem alta; o *mapeamento* para opcode é incógnita §8.3) |
| HOST-E10 | Bundle com índice de canais | símbolos + disassembly | `shm_bundle::config/init/size/fetch`, `g_shm_bundles`, `send_channel(shm_bundle*)`; store `bundle->chan[i]` | confiança: **alta** |
| HOST-E11 | Host exige ≥8 argumentos | disassembly | `main`: compara a contagem de argumentos com `0x7` (prossegue se maior), senão `dprintf`+`return 1`; `init_paths_from_args(3,&argv[5])` | confiança: **alta** |
| HOST-E12 | `plugin_host-3.3` embute CPython 3.3.7 | dynsym + strings | 1582 `Py_*`/`_Py_*` definidos (`readelf -sW`), `3.3.7`@`0xf1b54`, `python3.3.zip`@`0xe963f`, `Py_Initialize`@`0x3dd22c` | confiança: **alta** |
| HOST-E13 | `plugin_host-3.14` liga `libpython3.14.so.1.0` | `readelf -d` + dynsym | `NEEDED` + `RUNPATH=$ORIGIN`; 0 `Py_*` definidos, ~80 importados (`Py_InitializeFromConfig`, `PyConfig_*`) | confiança: **alta** |
| HOST-E14 | IPC idêntico entre 3.3 e 3.14 | símbolos + disassembly | mesmos símbolos de canal e mesmos 3 nomes nos dois hosts; mesma sequência em `main` | confiança: **alta** |
| HOST-E15 | Canais **não** são `multiprocessing` do CPython | `grep` + símbolos | `libpython3.14.so.1.0` sem `subl_send/subl_recv/subl_arecv`; canal é C++ próprio (`shm_channel`) | confiança: **alta** |
| HOST-E16 | `crash_handler` não participa do IPC de plugins | strings + imports | Crashpad (`handler_main.cc`, `crash_report_upload_thread.cc`); sem `shm_open`/`mmap`/`sem_open`; sem `subl_*`; só `sem_init` anônimo | confiança: **alta** |
| HOST-E17 | Núcleo e hosts importam o mesmo par shm/sem | imports | `nm -D -u`: `shm_open, shm_unlink, mmap, munmap, ftruncate, sem_open, sem_post, sem_wait, sem_timedwait, sem_unlink, sem_close` | confiança: **alta** |
| HOST-E18 | Thread dedicada ao canal assíncrono no núcleo | strings (adjacência) | literal `shm_reader` @`0xf56d4` imediatamente após `%u:subl_arecv%s` @`0xf56c4` | confiança: **média** (adjacência é forte, mas nome de thread) |
| HOST-E19 | Modelo multi-thread com filas de trabalho | símbolos | `g_async_work_queue(_runner)`, `work_queue`, RTTI `*_queue_runner`, `is_main_thread()`, `start_process_monitor_thread` | confiança: **alta** |
| HOST-E20 | Mensagens do host → núcleo saem por `subl_send` | símbolos | `send_channel(shm_bundle*)` @`0x175dc1` + 3 nomes | confiança: **média** (direção inferida; não segui o buffer até o índice) — ⚠️ **revisado em P1.3**: a evidência nova inverte a direção (`subl_send` = **entrada do host**); ver §1 nota de revisão e [`ipc-protocol.md`](ipc-protocol.md) `E18`/`E19` |
| HOST-E21 | Framing = `[uint32 LE len][payload len bytes]`, sem tipo/opcode/flags; corpo sem terminador NUL | disassembly | store de 4 bytes do comprimento @`0xe012b`; `resize` `0xd7a2c`; `malloc(len)` sem `+1` @`0xe5e60` | confiança: **alta** ([`ipc-protocol.md`](ipc-protocol.md) `E1–E7`) |
| HOST-E22 | Anel shm `0x80000`: índices `u64` @`0x0`/`0x40`, dados @`0x80`, capacidade **constante** `0x7ff80` (útil `0x7ff7f`) | disassembly | constante `0x80000` como 2º argumento `0xf82ae`; divisão pelo divisor `0x7ff80` | confiança: **alta** ([`ipc-protocol.md`](ipc-protocol.md) `E8–E10`) |
| HOST-E23 | `shm_channel` = `0x58`: sem @`0x0`/`0x8`, mutex @`0x10`, ring @`0x38`, base @`0x40`, size @`0x48`, creator @`0x50`, poison @`0x51` | disassembly | ctor `0xf84fc`, dtor `0xf84a4`, mark-dead `0xfa3f0` | confiança: **alta** ([`ipc-protocol.md`](ipc-protocol.md) `E11`) |
| HOST-E24 | Semáforos nomeados `<canal>:r` (val 0) e `<canal>:w` (val 1); `open` = *unlink-after-open* | disassembly + bytes | literais `%s:r` `0x7aafe` / `%s:w` `0x7a26f`; `sem_open` `0xf8317`/`0xf8344`; `sem_unlink` `0xf8592`/`0xf85d1` | confiança: **alta** ([`ipc-protocol.md`](ipc-protocol.md) `E12–E14`) |
| HOST-E25 | Bundle = 1 elemento de `0x78`; canais em `+0x8` `subl_recv`, `+0x10` `subl_send`, `+0x18` `subl_arecv`; *slot* por papel de thread | disassembly | `config(1)` `0x1a2de4`; literais `0x78b1f`/`0x7b132`/`0x751fb`; `send_channel` `0x175dd1` | confiança: **alta** ([`ipc-protocol.md`](ipc-protocol.md) `E15–E17`) |
| HOST-E26 | Dispatch **numérico**: opcode = 1º `uint32` do payload; `unsigned long` = índice do bundle; enum **U** = 281 ids (`1..281`, `.rodata 0x104a70`) e enum **V** = 71 ids (`1..71`, `.rodata 0x81e28`); tabelas de saltos densas | disassembly + readelf | `handle_protocol_message` @`0x17677e`; dispatcher gêmeo do núcleo @`0x54d999`; `main` @`0x1a2f99`–`0x1a2fc7` | confiança: **alta** ([`ipc-protocol.md`](ipc-protocol.md) `E22–E30`, Anexo A) |

---

## 6. 📡 IPC protocolo — wire protocol (P1.3)

Fonte: [`ipc-protocol.md`](ipc-protocol.md) §8 —
`| # | Conclusão | Evidência (endereço/ref) | Tipo | Confiança |`. Coluna **Confiança** → `Limites` como
`confiança: <valor>`. (A fonte consolidou framing `E1–E21` + opcodes `B1–B15` renumerados para
`E22–E36`.)

| Evidence ID | Conclusão | Tipo de evidência | Evidência (endereço/ID) | Limites |
|---|---|---|---|---|
| IPC-E1 | Prefixo de comprimento = 4 bytes, `uint32` LE nativo | disassembly | store de 4 bytes do comprimento (truncado a 32 bits) `0xe012b` (write); leitura dword em `0xe02d2` (read) | confiança: **alta** |
| IPC-E2 | `write_message` = 2 escritas (header 4 B + corpo), mutex lock/unlock em volta | disassembly | `write_bytes` em `0xe0144` e `0xe0152`; lock `0xe0136`; unlock `0xe015a` | confiança: **alta** |
| IPC-E3 | `read_message` = 2 leituras (header 4 B → resize → corpo) | disassembly | `read_bytes` em `0xe02c9` e `0xe02f1`; `resize` `0xd7a2c` via `0xe02dd` | confiança: **alta** |
| IPC-E4 | Ordem write = lock→header→corpo→unlock→sem_post(reader) | disassembly | `0xe0136`→`0xe0144`→`0xe0152`→`0xe015a`→`0xe0162` | confiança: **alta** |
| IPC-E5 | Sem campos além do comprimento no framing; opcode = 1º dword do payload | disassembly | send serializa `unsigned` antes (`0x175e43`); comparação do 1º dword do payload com 0 (`0x176551`) | confiança: **alta** |
| IPC-E6 | `string_buffer` = `{len@0x0, cap@0x8, data@0x10, SSO@0x18}` | disassembly | `resize` `0xd7a2c`; `reserve_exact` `0xe5e3e`/`0xe5e60`; `copy_to` `0xd7a74` | confiança: **alta** |
| IPC-E7 | Comprimento **não** inclui NUL; sem terminador garantido; corpo p/ heap só se > SSO | disassembly | `malloc(len)` sem `+1` (`0xe5e60`); `memmove(len)` (`0xd7af5`) | confiança: **alta** |
| IPC-E8 | shm = `0x80000` (512 KiB), literal | disassembly | constante `0x80000` como 2º argumento `0xf82ae` (create), `0xf8532` (open) | confiança: **alta** |
| IPC-E9 | Anel: header `0x80` (write@`0x0`, read@`0x40`), dados@`0x80`; cap = `0x7ff80` constante | disassembly | índices em `[+0x0]`, `[+0x40]`, dados em `[+0x80]`; divisão pelo divisor `0x7ff80` | confiança: **alta** |
| IPC-E10 | Capacidade útil = `0x7ff7f` (cap−1, 1 byte reservado) | disassembly | soma da constante `0x7ff7f` `0xe01c9` | confiança: **alta** |
| IPC-E11 | `shm_channel` = `0x58`; sem0@0, sem1@8, mutex@`0x10`, ring@`0x38`, base@`0x40`, size@`0x48`, creator@`0x50`, poison@`0x51` | disassembly | ctor `0xf84fc`, dtor `0xf84a4`, create `0xf82e0`–`0xf82fc`, mark-dead `0xfa3f0` | confiança: **alta** |
| IPC-E12 | Nomes de semáforo = `<canal>:r` (val 0) e `<canal>:w` (val 1) | disassembly + bytes | literais `0x7aafe`/`0x7a26f`; `sem_open` `0xf8317`/`0xf8344` | confiança: **alta** |
| IPC-E13 | `open` faz `sem_unlink` imediato após cada `sem_open` (*unlink-after-open*) | disassembly | `sem_unlink` em `0xf8592` e `0xf85d1` | confiança: **alta** |
| IPC-E14 | Semáforos **nomeados** (nunca `sem_init` anônimo no shm) | disassembly + imports | `sem_open` ×2 create/open; shm contém só o anel | confiança: **alta** |
| IPC-E15 | `shm_bundle` = N elementos de `0x78`; sentinela `-1`; mutex@`0x48` | disassembly | multiplicação pelo stride `0x78` `0x173db6`; escrita da sentinela `-1` `0x173def` | confiança: **alta** |
| IPC-E16 | `main` usa 1 bundle; canais em `+0x8` recv, `+0x10` send, `+0x18` arecv | disassembly | `config(1)` `0x1a2de4`; stores `0x1a2e68`/`0x1a2e96`; literais `0x78b1f`/`0x7b132`/`0x751fb` | confiança: **alta** |
| IPC-E17 | Seleção de canal por thread: main→`+0x8`, non-main→`+0x18` | disassembly | `send_channel` `0x175dd1`–`0x175de6` | confiança: **alta** |
| IPC-E18 | Host escreve requisição em `+0x8` e lê resposta de `+0x10` | disassembly | `write_message` `0x1761c1`; `read_message` `0x176520` | confiança: **média** |
| IPC-E19 | Direção: núcleo→host = `subl_send`; host→núcleo = `subl_recv`/`subl_arecv` (nomes core-relativos) | inferência | E16+E17+E18 | confiança: **média** |
| IPC-E20 | Framing/layout idênticos em 3.3 | disassembly | `write_message` `0x2abd90`, `read_message` `0x2abf2a`, create `0x2c3f13` | confiança: **alta** |
| IPC-E21 | Nomes de semáforo presentes também no núcleo | bytes | `%s:r` `0xeae6b`, `%s:w` `0xe8cf2` em `sublime_text` | confiança: **alta** |
| IPC-E22 | Opcode = `uint32` LE nos 4 primeiros bytes do payload; `unsigned long` = índice de bundle | disassembly | `handle_protocol_message` lê o 1º `uint32` do payload, decrementa e compara com `0x46`; multiplica pelo stride `0x78` + `g_shm_bundles`; `main` passa o 1º campo do bundle | confiança: **alta** |
| IPC-E23 | Dispatch por **tabela de saltos densa**, não por texto | disassembly | `.rodata 0x81e28`, 71×4 B, índice estendido + soma da base + salto indireto; 0 comparações de string | confiança: **alta** |
| IPC-E24 | Opcode inválido/curto = **silêncio** (sem literal de erro) | disassembly + strings | desvios diretos p/ epílogo `0x177df3`/`0x177e97`/`0x55e562`; grep de literais = 0 | confiança: **alta** |
| IPC-E25 | Enum V = 71 ids → handlers `plugin_*` | disassembly | primeiras chamadas de cada caso da tabela `0x81e28` | confiança: **alta** |
| IPC-E26 | Enum U = **281 ids (`1..281`)**, imediato `uint32` gravado no 1º campo em cada `api_*()` | disassembly | 235+ sites de store de imediato (por pilha ou direto no campo); todos os 281 nomes casam | confiança: **alta** |
| IPC-E27 | `PyMethodDef[]` `sublime_api` = 294×32 B @`.data.rel.ro 0x20fc50`; **ordem = ids 1..281** | readelf + disassembly | relocs `R_X86_64_RELATIVE`; `init_sublime_api` @`0x1a0a29`; `PyModuleDef.m_name` = `sublime_api` | confiança: **alta** |
| IPC-E28 | 13 métodos **locais** (sem protocolo) no fim da tabela | readelf | entradas 281..293 (3.14) | confiança: **alta** |
| IPC-E29 | Núcleo tem o **dispatcher gêmeo com 281 casos** @`0x54d999`, tabela `.rodata 0x104a70` | disassembly (reverificado) | comparação com o bound `0x118` @`0x54d9db`; referência à tabela @`0x104a70` (`0x54d9ea`); 281 alvos em `.text` (`0x54da16..0x55727f`) | confiança: **alta** |
| IPC-E30 | 3.3 tem o **mesmo** enum U (281 ids iguais) e o mesmo enum V (71) | disassembly + readelf | extração id por id + tabela `M′`@`0x636700` com os mesmos 281 nomes na mesma ordem | confiança: **alta** |
| IPC-E31 | O “extra” de 3.3 = string `api_version`, **não** comando | disassembly + readelf | 3.3 `api_version()` retorna `"4215"` local; sem id; sem reloc; item `M′` = `version` | confiança: **alta** |
| IPC-E32 | Payload = serialização binária tipada; `find_arg_value` fora do protocolo | disassembly | `operator<<`/`>>` de `binary_(in\|out)put_stream` no dispatch; 0 chamadas a `find_arg_value` | confiança: **alta** |
| IPC-E33 | Nomes `api_*` de `.rodata` apontam p/ `M` como `<literal>+4` (nome sem prefixo) | readelf + disassembly (seção `AMS`) | 281 relocs de `M` → `vaddr(api_X)+4`; 0 relocs nem referências RIP-relativas ao início | confiança: **alta** (o *porquê* = **média**) |
| IPC-E34 | Loop de `main` distingue `data[0]!=0` (enum V) de `data[0]==0` (resposta p/ requisição pendente) | disassembly | `main`@`0x1a2f99..0x1a2fc7`; handler `0x1766e6` casa `req->id` e completa o vetor | confiança: **alta** |
| IPC-E35 | Tabela auxiliar “blocking by opcode” (68 entradas, ids 4..71) | disassembly | `is_app_blocking_while_sending` @`0x1784f5`, `.rodata 0x81f44` | confiança: **alta** |
| IPC-E36 | 6 comandos têm `fn` remapeado no boot (`view_insert/erase/replace`, `view_run_command`, `window_run_command`, `run_command`) | disassembly | `init_sublime_api` @`0x1a0a29` (`strcmp` + patch `+8`) | confiança: **alta** |

---

## 7. 🎨 Render (P1.4)

Fonte: [`render-pipeline.md`](render-pipeline.md) (ledger) —
`| ID | Fonte (endereço/artefato) | Tipo | O que prova | Limite |`. A **4ª coluna** ("O que prova") é a
conclusão; a **2ª** ("Fonte") é a evidência.

| Evidence ID | Conclusão | Tipo de evidência | Evidência (endereço/ID) | Limites |
|---|---|---|---|---|
| REN-E1 | toolkit = GTK3/GLib (`NEEDED`: `libglib/gobject`, `libGL`, `libX11`); GTK por dlsym | [OBSERVADO] | `readelf -d`/`--dyn-syms` do alvo | GTK em runtime |
| REN-E2 | GDK/GTK por `dlsym` (contexto GL, blit GL→cairo, invalidate) | [OBSERVADO] | `_INIT_73` `0x647295`; strs `0x1ec42f`/`0x1ea3cf`/`0x1e4847` | call-sites indiretos |
| REN-E3 | frame em tick da GTK; render na **main thread** | [OBSERVADO]/[INFERIDO] | `gtk_widget_add_tick_callback` `0x1d202f`; P1.2 (sem thread de render) | — |
| REN-E4 | base abstrata `px_render_context` + `gl_`/`skia_render_context` | [OBSERVADO] | typeinfo `0xa4e080`/`0xa4e090`/`0xa4dd50` | sem vtable da base |
| REN-E5 | interface de **31 virtuais** idêntica nas duas | [OBSERVADO] | vtables `0xa4df78`/`0xa4dc48`, slots `0xa4df88–0xa4e078`/`0xa4dc58–0xa4dd48` | contagem por varredura |
| REN-E6 | monta `#version 410` + `#define`s e compila shader; cache | [OBSERVADO] | `FUN_007ce084` `0x7ce084` | — |
| REN-E7 | tetos **8192** e **128** | [OBSERVADO] | defines `MAX_GLYPH_INSTANCES` `0x1d8de1`, `MAX_STENCIL_QUAD_INSTANCES` `0x1f5dad` | valores por imediato |
| REN-E8 | link de programas `.vert`(`0x8b31`)+frag(`0x8b30`) | [OBSERVADO] | `FUN_007bd303` `0x7bd303` | nº por tabela não totalmente enumerado |
| REN-E9 | **17 programas** (`filled_rect*`, `glyph_*`, `bezier_line*`, `rect_*`) | [OBSERVADO] | nomes `0x1d0f74…0x1fa2ef` | via strings |
| REN-E10 | instâncias num **texture buffer `RGBA32F`** (`glTexBuffer`, `GL_DYNAMIC_DRAW`) | [OBSERVADO] | `FUN_007cde73` `0x7cde73` | — |
| REN-E11 | **stride N∈{2,3,4,5}** texels `RGBA32F`; elem0 = cor | [OBSERVADO] | shaders `0x1f46b3`(2/3), `0x1eebf8`(3), `0x1db721`(3/4), `0x1f5ddf`(4/5) | layout exato por família |
| REN-E12 | desenho **instanciado** por batch | [OBSERVADO] | `glDrawArraysInstanced` (`0x7ce638`/`0x7d4858` + 5) | política de flush [INFERIDO] |
| REN-E13 | AA por feather (0.5) e rounded por **8× supersample** | [OBSERVADO] | strs `ANTIALIAS_FEATHER` `0x1f5f51`/`0x1f7855`, `SUPERSAMPLE` `0x1f3d82`, `render_rect_decoration` | — |
| REN-E14 | saída dupla (cor + alpha) p/ composição/subpixel | [OBSERVADO] | shaders de glifo: `frag_color`/`frag_alpha` (MRT) | — |
| REN-E15 | atlas de glifo `RGBA8` 2D, `NEAREST`/`CLAMP_TO_EDGE`, upload BGRA/UBYTE, lado 1024/4096 | [OBSERVADO] | `0x7cfdfe` / `0x7cfc44` / `0x7cfd2c` | lado ambíguo |
| REN-E16 | moldagem/rasterização **CPU-side** (Pango/FT/Cairo) | [OBSERVADO] | `FT_Load_Glyph` `0x1eb24e`, `cairo_ft_scaled_font_lock_face` `0x1d44b4`, `_INIT_69/70` `0x646854`/`0x646f8a` | shaper próprio [DESCONHECIDO] |
| REN-E17 | `gl_glyph_cache_batch` abstrata + 2 `batch` (3 slots) | [OBSERVADO] | typeinfo `0xa4df50`/`0xa4df10`/`0xa4df60` | — |
| REN-E18 | clip por região danificada (damage) | [OBSERVADO] | `glScissor` `0x7d0b9e` ← `0x7befed`/`0x7d2772`/`0x7d2d80` | critério de visibilidade [DESCONHECIDO] |
| REN-E19 | viewport = **data source + observers + alvo animado** | [OBSERVADO] | RTTI `viewport_control` `0xa47b00`, `scroll_area_control` `0x23a4cc`, `scroll_data_source`(+`subscriber`), `scroll_*_animation` | — |
| REN-E20 | texto renderizado **por token**, *gutter* separado | [OBSERVADO] | `TokenRenderer` `0x25c134`, `gutter_renderer` `0x25c15e` | — |
| REN-E21 | backend software = `skia_render_context` sobre `cairo_image_surface` | [OBSERVADO] | `FUN_007bc762` `0x7bc762`, `FUN_007c6ed2` `0x7c6ed2` | — |
| REN-E22 | **Skia estático, raster (CPU)**; sem Ganesh/GL | [OBSERVADO] | RTTI Skia (`SkCanvas`/`SkSurface_Base`/`SkImage_Raster`/`SkBitmapDevice`), path `third_party/skia/...` | — |
| REN-E23 | backend escolhido pelo setting; bit de estado `0x20000` | [OBSERVADO] | `FUN_00638250` `0x638250`; str `hardware_acceleration` `0x1e7876` | — |
| REN-E24 | `hardware_acceleration: "none"`; modo `"opengl"` ≥ 4.1; `font_options`/`theme_font_options` | [OBSERVADO] | `Default.sublime-package` → `Preferences.sublime-settings` | artefato de produto, não binário |
| REN-E25 | falha de GL = **diálogo modal**, não fallback silencioso | [OBSERVADO] | `FUN_007c1555` `0x7c1555` → `FUN_007c1600`; str `0x1ec39f` | queda automática [DESCONHECIDO] |
| REN-E26 | **fecha** P1.2/E18: defaults `io_workers: 2`, `index_workers: 0` | [OBSERVADO] | `Default.sublime-package` → `Preferences.sublime-settings` | — |
| REN-E27 | biblioteca de **controles + sistema de propriedades** sobre o render context | [OBSERVADO] | catálogo RTTI `.rodata` (`~1184` simples + `386` mangled) | enumeração por strings |

---

## 8. 📦 Empacotamento (P1.6)

Fonte: [`packaging.md`](packaging.md) §9 — `| # | Conclusão | Caminho / comando | Tipo | Limite / incerteza |`.
`tipo`: **inventário** = contagem/listagem · **zip-layout** = estrutura interna de ZIP · **yaml** =
campos/estrutura de gramática · **manifest** = ausência/declaração de metadados.

| Evidence ID | Conclusão | Tipo de evidência | Evidência (endereço/ID) | Limites |
|---|---|---|---|---|
| PKG-E1 | 54 pacotes `.sublime-package` em `Packages/` | inventário | `ls target/sublime_text/Packages/*.sublime-package \| wc -l` = 54 | — |
| PKG-E2 | Cada pacote é um ZIP comum, sem manifesto | manifest | `unzip -l Packages/Default.sublime-package`; nenhum `manifest.json` em 2321 entradas | Não prova ausência de campo de comentário ZIP — só de arquivo-manifesto |
| PKG-E3 | Nome do arquivo ZIP = prefixo lógico `Packages/<Nome>/` | manifest | docstring `Lib/python314/sublime.py:1205` (`"Packages/Default/Main.sublime-menu"`) | Mapeamento `<Nome>`↔nome lógico é convenção; não há tabela explícita |
| PKG-E4 | ZIP é flat; 657/2321 entradas sem diretório | zip-layout | `unzip -Z1` agregado dos 54 pacotes | — |
| PKG-E5 | Papel do recurso = extensão (16 tipos mapeados) | inventário | contagem por sufixo (§3.1) | Mapa tipo→consumidor é observado por nome, não por código do núcleo |
| PKG-E6 | Subdiretórios convencionais `Snippets/`, `Embeddings/`, `tests/` | zip-layout | `unzip -l Packages/Python.sublime-package` | `tests/` são dados de teste, não recursos de runtime |
| PKG-E7 | Subpacotes por variante dentro de 1 ZIP (`Bash/`, `Shell/`, `Zsh/`) | zip-layout | `unzip -l Packages/ShellScript.sublime-package` | — |
| PKG-E8 | Variante de plataforma no nome `(Linux)/(OSX)/(Windows)` | inventário | `Default (Linux).sublime-keymap`, `Preferences (OSX).sublime-settings` | Regra de seleção exata = desconhecida |
| PKG-E9 | Recursos ocultos via `.hidden-` no nome | inventário | `Find Results.hidden-tmLanguage` (Default); `.hidden-color-scheme` (Theme - Default) | Efeito exato só no núcleo |
| PKG-E10 | Sintaxes internas marcadas `hidden: true` (102) | yaml | `grep -c '^hidden: true'` agregado | — |
| PKG-E11 | `.sublime-syntax` = YAML v2 com `name/scope/file_extensions/first_line_match/contexts/variables/extends` | yaml | `unzip -p Packages/Python.sublime-package Python.sublime-syntax` (chaves de topo, `:1-4320`) | Estrutura observada; semântica de execução do motor é do C++ |
| PKG-E12 | Gramática dirigida por estados: `match/push/set/pop/include/scope/captures` dominam | yaml | contagem agregada (§5.2) | Números = frequência de regras, não contrato formal |
| PKG-E13 | `prototype` é contexto comum; `main` obrigatório | yaml | `meta_include_prototype` (1388×); `contexts: main: []` em `Binary.sublime-syntax` | — |
| PKG-E14 | Herança por nome lógico: local e `Packages/<Pkg>/<File>` | yaml | `extends:` agregados (ex.: `Packages/CSS/CSS.sublime-syntax`) | Resolução de alvo usa o mesmo VFS |
| PKG-E15 | Formato legado plist coexiste | manifest | `Packages/Text.sublime-package/Plain text.tmLanguage`; `Python/Symbol List.tmPreferences` | Aceitação dos dois formatos é inferida da presença, não testada |
| PKG-E16 | Plugins Python embarcados em 6 pacotes (63 `.py`) | inventário | `Default` 47, `CSS` 5, `Python` 5, `Vintage` 3, `HTML` 2, `Diff` 1 | — |
| PKG-E17 | Pacotes importáveis como módulos por meta-path | manifest | `Lib/python314/sublime_plugin.py:2310`, `:2326-2355`, `:2430`, `:2433` | Formato do `pkgs` empurrado pelo nativo é inferido |
| PKG-E18 | Cache de bytecode externo (`__pycache__`) preferido ao ZIP | manifest | `sublime_plugin.py:2396-2403` (comentário no artefato) | Local exato do cache = desconhecido (usa `cache_path`) |
| PKG-E19 | `load_resource`/`find_resources` resolvem nome lógico/glob no nativo | manifest | `Lib/python314/sublime.py:1203`, `:1241`; erros tipados `:1212-1214`; `max_size` 16 MiB `:1203` | Algoritmo de busca/merge não está no artefato |
| PKG-E20 | Duas raízes de pacote: "Packages" e "Installed Packages" | manifest | `sublime.py:775-792` (`packages_path`, `installed_packages_path`) | Ordem de precedência entre elas = U |
| PKG-E21 | Override `User` > `Default` (declarado no artefato) | inventário | comentário de `Packages/Default.sublime-package/Preferences.sublime-settings` (cabeçalho) | Regra de merge em cadeia = U |
| PKG-E22 | Settings/build/wp casam por `scope`/`selector` | manifest | `Python/Symbol List.tmPreferences` (`scope`), `Python/Python.sublime-build` (`selector`) | Aplicação filtrada por escopo é inferida |

---

## 9. 🔁 Duplicatas e supersessões (apenas citações explícitas)

Nada aqui é juízo de duplicação feito neste índice: cada item é uma **citação textual** de uma linha
de ledger a outra linha/§ de outro doc.

| Linha (nos dois sentidos) | Relação declarada na fonte |
|---|---|
| `HOST-E21` → `IPC-E1–E7` | HOST declara "confiança: alta ([`ipc-protocol.md`](ipc-protocol.md) `E1–E7`)" — mesmo achado de framing |
| `HOST-E22` → `IPC-E8–E10` | HOST cita `E8–E10` para o anel shm/`0x7ff80` |
| `HOST-E23` → `IPC-E11` | HOST cita `E11` para o layout de `shm_channel` (`0x58`) |
| `HOST-E24` → `IPC-E12–E14` | HOST cita `E12–E14` para semáforos `<canal>:r`/`:w` e *unlink-after-open* |
| `HOST-E25` → `IPC-E15–E17` | HOST cita `E15–E17` para `shm_bundle` `0x78` e ordem dos canais |
| `HOST-E26` → `IPC-E22–E30` + Anexo A | HOST cita o dispatch numérico/dois enums e o mapa `id → api_*` |
| `HOST-E20` — **revisada/superada** (direção) | ⚠️ marcada na fonte como "**revisado em P1.3**: a evidência nova inverte a direção (`subl_send` = **entrada do host**)" e remete a `IPC-E18`/`IPC-E19`; a **nota de revisão P1.3** de `ipc-plugin-host.md` mantém a linha 20 como registro da inferência antiga |
| `HOST-E9` — **revisada** (enum textual) | nota de revisão P1.3 (a): o enum **não** é textual; o mapeamento **foi** estabelecido e é **numérico** (`id 1..281` ↔ `api_*`, Anexo A de `ipc-protocol.md`) |
| `IPC-E19` → `E16+E17+E18` | a própria célula de evidência é "E16+E17+E18" (mesma tabela) |
| `REN-E26` → `P1.2/E18` (`CON-E18`) | REN declara "**fecha** P1.2/E18: defaults `io_workers: 2`, `index_workers: 0`" |
| `CON-E7`, `CON-E19` → `ipc-plugin-host.md` (§5 / consolidado) | citam o **doc/seção** (não uma linha de ledger de HOST) |
| `PY-E19` ↔ `PKG-E17`/`PKG-E18` | fontes mutuamente referenciadas (`packaging.md` fecha com "já tratado como interface em [`api-python.md`](api-python.md)"; PY-E19 trata do meta-path e do cache `.pyc`) |

---

## 10. 🕳️ Incógnitas consolidadas

Reúne as `U1–U10` de [`api-python.md`](api-python.md) §6 e os itens `[DESCONHECIDO]` (ou "= U",
"= desconhecida") das **seções de limites/§** dos demais docs. O `ID` marca a origem: `PY-U*`,
`BUF-U*`, `CON-U*`, `HOST-U*`, `IPC-U*`, `REN-U*`, `PKG-U*`. Itens que só existem como **limite de
uma linha E** referenciam o Evidence ID correspondente.

| ID | Incógnita | Por quê | O que fecharia |
|---|---|---|---|
| PY-U1 | **Assinaturas de `sublime_api.*`** | o módulo é embutido no `plugin_host-*`; só se infere dos call-sites (`arquivo:linha` no ledger) | Ghidra no `plugin_host-3.14` (P0.0) ou dumps de símbolos |
| PY-U2 | **Como o C++ descobre e chama `sublime_plugin.on_*`** | não há registro lado Python; a chamada é *por nome* | símbolos/strings do `plugin_host` (ver [`ipc-plugin-host.md`](ipc-plugin-host.md)) |
| PY-U3 | **Thread de cada callback** | `*_async` sugere worker; o doc só afirma "a separate thread" (`sublime.py:1319-1322`) | ids de thread no host / evidência do protótipo |
| PY-U4 | **Formato dos bytes da IPC** | fora do escopo deste doc (tratado em [`ipc-plugin-host.md`](ipc-plugin-host.md)) | framing/opcodes (P0.0) |
| PY-U5 | **`MultiCompletionList_append` e outras extensões nativas embutidas** | métodos de um objeto nativo, invisíveis no tarball (`sublime.py:4120`, `:4126`) | tabela de métodos do tipo nativo |
| PY-U6 | **Regras de invalidação de handles** | só se observa `is_valid()` (`sublime.py:1396`) | comportamento do host (reciclagem de ids) |
| PY-U7 | **`UIElement` marcado `:meta private:`** | `sublime.py:471-480`, sem uso nos dois arquivos lidos | verificar APIs internas do host |
| PY-U8 | **`sublime_api` pode virar mock** | o próprio código testa a existência do atributo (`sublime_plugin.py:2439`) | modo de geração de docs do projeto — não auditado aqui |
| PY-U9 | **Cobertura do lado 3.3** | só existem `sublime.py`/`sublime_plugin.py` em `python33/` | — |
| PY-U10 | **Deprecações silenciosas 3.3→3.14** | o delta foi medido por nome/linha; semânticas com o mesmo nome podem ter mudado | comparar corpos método a método (custoso) |
| BUF-U1 | Nome canônico e topologia exata da estrutura de texto (piece-table simples, piece-**tree**, "chunk list"); mapeamento semântico dos 11 vetores e dos registros de `0x20` B; UTF-8 vs UTF-32 na representação principal | `inspect_native_data_type("TextBuffer")` = `unavailable`; binário stripped | struct nomeada (DWARF/símbolos) + benchmark de insert no meio de arquivo grande |
| BUF-U2 | Se o **corpo do documento** compartilha o tipo UTF-32/SSO ou usa bytes UTF-8 (ref. `BUF-E12`) | só a rotina de string interna foi observada | medir o tipo no corpo do buffer |
| BUF-U3 | Composição interna exata do registro de `0xa8` B da mudança (ref. `BUF-E11`) | o pseudocode dá o tamanho, não os campos | tipo/struct do registro |
| BUF-U4 | Granularidade do cache de linha e custo assintótico em buffers muito grandes | cache só observado por sentinelas `-1` | benchmark de scan/contagem de linha |
| BUF-U5 | Base #1 do `__vmi` de `TextBuffer` não nomeada (limite de `BUF-E3`) | typeinfo mostra 2 bases, só `SpellingListener` é nomeada | RTTI/xref adicional |
| CON-U1 | Mecanismo concreto de identificação da main thread (comparar `pthread_self()` a um `pthread_t` guardado, ou flag em `.tdata`) | núcleo stripped; busca literal por `is_main_thread`/`g_main_thread` = 0 hits | símbolos do host (não-stripped) / disassembly dirigido |
| CON-U2 | Se há contador explícito de "main thread blocking" no núcleo e onde ele mora; granularidade do "handling message" | nomes só existem no host (`g_is_main_thread_blocking`/`handling_message`) | P0 §5 + símbolos do host |
| CON-U3 | Composição exata do *work item* (campos além de vtable e refcount; ref. `CON-E11`) | item acessado por offsets (`item+8`, `vtable+0x18`) | tipo/struct do item |
| CON-U4 | Se há barreiras (`pthread_barrier`), `rwlock` ou `std::atomic` explícito além do `LOCK/UNLOCK` sintetizado | imports/strings não conclusivos | inventário de imports + leitura de corpo |
| CON-U5 | Conjunto exato de callbacks postados à main thread; se há coalescing/batching; formato dos `sched_work_item` | continuidade só inferida (`px_main_thread_scheduler`) | disassembly dirigido ao scheduler |
| CON-U6 | Default de `io_workers`/`index_workers`/`max_background_threads` (limite de `CON-E18`) | setting lido, default não observado | **parcialmente fechado por `REN-E26`** (`io_workers: 2`, `index_workers: 0`); falta `max_background_threads` |
| HOST-U1 | Barra inicial / normalização do nome do shm (`/` prependido; se o núcleo faz o mesmo; `resolve_path` por usuário/sessão; candidato `sublime.XXXXXX` via `mkstemp` **não confirmado**) | os literais não trazem `/` | confirmar no núcleo + caminho de `resolve_path` |
| HOST-U2 | Significado exato de `argv[1]` (id do nome; núcleo formata com `%u`) — **não** confirmado que seja o PID, nem de quem | id usado no nome, sem prova de origem | dump do `argv` real na execução do host |
| HOST-U3 | Os **8 argumentos** de CLI: contrato completo de `argv[5..7]` e a flag `argv[4]=="true"` | `main` exige `argc > 7` e consome `argv[1..7]` | reconstruir o parse completo de `main` |
| HOST-U4 | Uso exato de `socketpair`/`sendmsg`/`recvmsg` no núcleo e nos hosts (**não** é o transporte de plugin) | presença confirmada, finalidade não (suspeito: cliente Crashpad; cita `--shared-client-connection`) | rastrear os call-sites dos três syscalls |
| HOST-U5 | Lado `sublime_text` é "cego" para símbolos (só 12 dynsyms família `malloc`; caracterizado por strings+imports) | núcleo stripped; `shm_channel` lá é código estático | projeto Ghidra persistente (P0.0/P1) |
| HOST-U6 | Detalhe do bit em `.data 0x20fc30` (teste do bit `0x1`; variante dinâmica `[g_alive+0x18]`, nula estaticamente) | leitura exata não explicada | disassembly dirigido ao consumidor do bit |
| IPC-U1 | **Bytes de padding do header do anel** (`0x8..0x40`, `0x48..0x80`) — versão/flags futuras ou alinhamento de cache line | não referenciados por `write_bytes`/`read_bytes` | leitura de quem inicializa o header |
| IPC-U2 | **Semântica exata dos tipos de canal do bundle**: por que request/response **lê** de `subl_send` e **escreve** em `subl_recv`; **quando** `subl_arecv` (`+0x18`) é usado por thread **não-main** | o fluxo assíncrono não foi seguido até o consumidor | rastrear o consumidor de `subl_arecv` |
| IPC-U3 | **`shm_channel+0x50` vs `+0x51`**: `+0x50` (=1 em *create*) parece "fui eu que criei", mas uso além de *set* não localizado; relação com o bit de `HOST-U6` | só o *set* foi observado | xrefs de `+0x50`/`+0x51` |
| IPC-U4 | **Contrato síncrono vs assíncrono**: quais ids fazem `read_message`+`handle_protocol_message` sozinhos e quais dependem do loop de `main`; como o `req_id` é gerado/atribuído (ref. `IPC-E34`) | não mapeado por id | varrer os 281 handlers por modo |
| IPC-U5 | **Semântica de `is_app_blocking_while_sending`**: quais dos 68 ids retornam `true` e por quê (ref. `IPC-E35`, tabela `.rodata 0x81f44`) | tabela existe, critério arquitetural não | dump das 68 entradas + leitura do critério |
| IPC-U6 | **`data[0] == 0`**: além de resposta assíncrona, pode ser *namespace* de controle (ex.: `api_channel`); outros subcódigos além do `req_id` | não confirmado | rastrear os produtores de `data[0]==0` |
| REN-U1 | **Critério de visibilidade** — algoritmo que enumera "linhas visíveis" (o clip por `glScissor`/damage é observado; ref. `REN-E18`) | função não pinada | disassembly da rotina de damage |
| REN-U2 | **Política de flush do batch** (teto vs fim de camada vs teste de textura) | teto de instâncias observado (8192/128); política inferida (ref. `REN-E12`) | disassembly do loop de desenho |
| REN-U3 | **Fallback após falha de GL**: se há queda automática silenciosa para `skia_render_context` | caminho observado é diálogo de erro (ref. `REN-E25`) | teste/observação em runtime |
| REN-U4 | **Shaper**: nenhum HarfBuzz/`hb_*`; não se sabe se há shaping próprio não nomeado (ref. `REN-E16`) | ausência de strings não prova ausência de shaper | catálogo de classes/funções de texto |
| REN-U5 | **Escolha de formato de pixel / sRGB**: atlas `RGBA8`/entrada BGRA; gestão de color space (sRGB vs linear) (ref. `REN-E15`) | não analisada | leitura dos call-sites de textura/`glTexBuffer` |
| REN-U6 | **Nº exato de programas**: 17 nomes observados; a tabela pode ter entradas não nomeadas ou variantes por flag (ref. `REN-E9`) | enumeração por strings, não por varredura da tabela | varrer a tabela de programas |
| PKG-U1 | **Formato do catálogo de recursos em memória** do núcleo (tabela hash? lista ordenada?) | `find_resources` é nativo; só se vê o resultado (glob) | Ghidra no `sublime_text` (fora do escopo barato) |
| PKG-U2 | **Ordem exata de merge** User ∧ sintaxe ∧ plataforma ∧ default (ref. `PKG-E21`) | só o comentário de override é observável | teste empírico / strings do nativo |
| PKG-U3 | **Precedência "Installed Packages" vs "Packages"** (ref. `PKG-E20`) | duas raízes existem, mas a colisão de nomes não é exercida no tarball | instalar pacote homônimo e observar |
| PKG-U4 | **Semântica de `.hidden-`/`hidden: true`** além de "esconder" (refs. `PKG-E9`, `PKG-E10`) | nome marcado, mas o efeito é do núcleo | mapear no nativo |
| PKG-U5 | Se `.sublime-package` é **selado/reaberto em runtime** | ZIP estático no disco; nada no artefato indica mutação | traçar I/O do núcleo |
| PKG-U6 | **Campo de versão do pacote / dependências (Package Control)** | ausente nos ZIPs embarcados; política de 3º é do Plugin externo | analisar pacote instalado por Package Control |
| PKG-U7 | **Algoritmo de `extends`/`embed`** (resolução de conflito de contexto) | vê-se a declaração, não a montagem final da gramática | spec oficial + teste com `syntax_test_*` |
| PKG-U8 | **Regra de seleção exata da variante de plataforma** `(Linux)/(OSX)/(Windows)` (limite de `PKG-E8`) | a variante é observada no nome, não a regra de escolha | teste com artefatos homônimos por plataforma |
| PKG-U9 | **Local exato do cache `__pycache__`** preferido ao ZIP (limite de `PKG-E18`) | a fonte diz que usa `cache_path`, mas não o local | rastrear `cache_path` no host |

---

## 11. 📈 Cobertura

| Tema | Arquivo fonte | Nº de linhas no ledger | Evidence IDs |
|---|---|---:|---|
| Buffer (P1.1) | [`buffer-structure.md`](buffer-structure.md) §7 | 14 | `BUF-E1–E14` |
| Concorrência (P1.2) | [`concurrency.md`](concurrency.md) §9 | 21 | `CON-E1–E21` |
| IPC Python — API de plugins | [`api-python.md`](api-python.md) §5 | 33 | `PY-E1–E33` |
| IPC host — ponte C++↔CPython | [`ipc-plugin-host.md`](ipc-plugin-host.md) §9 | 26 | `HOST-E1–E26` |
| IPC protocolo (P1.3) | [`ipc-protocol.md`](ipc-protocol.md) §8 | 36 | `IPC-E1–E36` |
| Render (P1.4) | [`render-pipeline.md`](render-pipeline.md) (ledger) | 27 | `REN-E1–E27` |
| Empacotamento (P1.6) | [`packaging.md`](packaging.md) §9 | 22 | `PKG-E1–E22` |
| **Total** | — | **179** | — |

**Incógnitas consolidadas (§10):** **48** itens — `PY-U1–U10` (10) · `BUF-U1–U5` (5) · `CON-U1–U6` (6) ·
`HOST-U1–U6` (6) · `IPC-U1–U6` (6) · `REN-U1–U6` (6) · `PKG-U1–U9` (9).

> **Nota de método (clean-room).** Este índice **não** acrescenta análise: cada célula é uma transcrição
> (condensada com `…`) do ledger-fonte correspondente, com os IDs originais preservados. Nenhuma linha
> de código, assembly, pseudocódigo, gramática, snippet ou settings do alvo é reproduzida — só **nomes,
> assinaturas, contagens, tamanhos, offsets, endereços e papel arquitetural**. Endereços estão no espaço
> default do Ghidra (image base `0x100000`; PIE, portanto relativos).
