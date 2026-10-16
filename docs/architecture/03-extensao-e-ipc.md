# 03 · Extensão & IPC — host de plugins como processo isolado 🔌

> Fase 2 (P2.1) · síntese clean-room do alvo (sha256 8b105b18…43d92) · insumo: evidence-index.md · 2026-10-16

> **Escopo:** traduzir o padrão *ponte núcleo ↔ host de plugins* observado na Fase 1 em **design
> patterns e contratos** para o **Arcane** (Electron + TypeScript). Nenhum bloco de implementação,
> assembly, pseudocódigo ou byte do alvo é reproduzido — só **nomes, contagens, tamanhos, offsets e
> papel arquitetural**, como manda o regime clean-room. Toda afirmação sobre o alvo traz o
> **Evidence ID** de [`evidence-index.md`](../analysis/evidence-index.md) (§4/§5/§6/§9/§10).
> **Docs irmãos (insumos):** [`api-python.md`](../analysis/api-python.md) ·
> [`ipc-plugin-host.md`](../analysis/ipc-plugin-host.md) · [`ipc-protocol.md`](../analysis/ipc-protocol.md).

**Achado central (1 frase):** o alvo isola plugins **num processo separado** (`plugin_host-*`) que o
núcleo cria e cujo **único** vínculo é uma **ponte de três canais nomeados** sobre **shm+semaforos**,
com **framing `[uint32 len][payload]` sem campo de tipo**, **opcode = 1º `uint32` do payload**,
**dispatch numérico denso** por dois enums opostos (**U** 281 ids / **V** 71 ids) e **API facade**
que só manipula **handles opacos**.

---

## 1. 🎯 O padrão observado (o quê)

O subsistema de extensão do alvo é uma **arquitetura de processo-servidor com RPC simétrico**:
o **núcleo** (C++, dono do estado do editor) conversa com um **host de plugins** (CPython embutido),
que por sua vez expõe aos plugins um **módulo nativo de facade**. Há três fronteiras claras:

1. **Processo:** `plugin_host` é um **processo à parte**, iniciado pelo núcleo via
   `posix_spawn`/`execvp` (`CON-E19`); existem duas builds (`plugin_host-3.3`, `plugin_host-3.14`)
   com **IPC idêntico** (`HOST-E14`) e runtimes CPython distintos (`HOST-E12`, `HOST-E13`).
2. **Transporte+protocolo:** três canais posix-shm nomeados com anéis circulares, semáforos e um
   opcode numérico por payload (`HOST-E1`, `HOST-E2`, `IPC-E1`).
3. **API:** um **facade fino e quase stateless** sobre o módulo nativo `sublime_api`, em que o
   estado vive no C++ e o Python só carrega **handles opacos** (`PY-E1`, `PY-E3`, `PY-E4`).

Números que amarram o padrão (todos `[OBSERVADO]`):

| Métrica | Valor | Evidence ID |
|---|---:|---|
| Canais por instância de host | 3 (`subl_send`/`subl_recv`/`subl_arecv`) | `HOST-E2` |
| Região shm por canal | `0x80000` B (512 KiB), anel de cap. total `0x7ff80` (útil `0x7ff7f`) | `IPC-E8`, `IPC-E9`, `HOST-E22` |
| Framing de mensagem | `[uint32 LE len][payload]` — **sem tipo/flags** | `IPC-E1`, `HOST-E21` |
| Enum **U** (host→núcleo) | 281 ids (`1..281`), `api_*` | `IPC-E26`, `IPC-E29`, `HOST-E26` |
| Enum **V** (núcleo→host) | 71 ids (`1..71`), handlers `plugin_*` | `IPC-E25`, `HOST-E26` |
| Tabela “blocking by opcode” | 68 ids (faixa 4..71) | `IPC-E35` |
| Eventos Python / símbolos nativos usados | 53 (19 `_async`) / 284 | `PY-E12`, `PY-E2` |

**Leitura do padrão:** o alvo escolheu o caminho **"fronteira de processo explícita + protocolo
binário mínimo + opcodes numéricos densos"** — máximo desempenho e mínimo *overhead* por mensagem,
ao custo de **evolução difícil** (cada novo comando é um novo id numérico e uma nova entrada na
tabela de saltos). O nosso alvo inverte esse trade-off (§6).

---

## 2. 🧩 Modelo de processo e de handles (com Evidence IDs)

### 2.1 Processo e ciclo de vida

- `[OBSERVADO]` O host é **processo separado**, disparado pelo núcleo (`HOST-E3`, `CON-E19`); o host
  exige **≥ 8 argumentos de CLI** (`argc > 7`) e consome `argv[1..7]` (`HOST-E11`).
- `[OBSERVADO]` **O núcleo cria o canal; o host só abre** — nos dois hosts há **zero** chamadas a
  `create_shm_channel` e **três** `open_shm_channel` (`HOST-E3`); o lado criador tem a string de erro
  `]: failed to create shm channel for worker` (`HOST-E3`).
- `[OBSERVADO]` O nome de cada objeto embute **id da instância + versão do runtime**:
  `<id>:subl_<canal>-<versão>`, prefixado com `/` para o `shm_open` (`HOST-E4`); as versões literais
  são `"3.14"`/`"3.3"`, o que evita colisão entre os dois hosts (`HOST-E4`, `HOST-E14`).
- `[INFERIDO]` Handshake de prontidão: o lado Python espera `api_ready`/`api_plugin_host_ready()`
  antes de disparar plugins (`PY-E28`); no núcleo há uma **thread dedicada ao canal assíncrono**
  (`shm_reader`) (`CON-E7`, `HOST-E18`).

### 2.2 Os três canais e a ARMADILHA da direção

Os nomes são **relativos ao núcleo** — e é aqui que a evidência inverteu uma leitura inicial:

| Canal | Offset no bundle | Direção efetiva | Papel |
|---|---|---|---|
| `subl_send` | `+0x10` | **núcleo → host** (host **lê**) | **entrada do host** |
| `subl_recv` | `+0x8` | host → núcleo (host **escreve**) | requisição síncrona |
| `subl_arecv` | `+0x18` | host → núcleo (host **escreve**) | requisição assíncrona |

- `[OBSERVADO]` Os três nomes existem nos dois lados (`HOST-E2`, `HOST-E10`) e o bundle mapeia
  `+0x8`=recv, `+0x10`=send, `+0x18`=arecv (`HOST-E25`, `IPC-E16`).
- `[OBSERVADO]` A seleção de slot é **por papel de thread**: main→`+0x8`, non-main→`+0x18` (`IPC-E17`).
- `[INFERIDO, confiança média]` O host **escreve a requisição** em `+0x8` e **lê a resposta** de
  `+0x10` (`IPC-E18`, `IPC-E19`); o loop de `main` do host lê do canal `+0x10` (`subl_send`), o que
  sustenta a revisão (`ipc-protocol.md` F15).
- ⚠️ **`HOST-E20` está SUPERSADA.** A inferência antiga era “host → núcleo sai por `subl_send`”; a
  evidência nova **inverte a direção**: `subl_send` = **entrada do host**, `subl_recv`/`subl_arecv`
  = **saídas** (host → núcleo). O nome não mudou; o **sentido** mudou. Mantivemos o registro da
  inferência superada para preservar o histórico (`HOST-E20` → nota de revisão P1.3; `IPC-E18`/`IPC-E19`).

### 2.3 Handles e identidade

- `[OBSERVADO]` A API Python é **facade stateless**; o estado real (buffers, views, settings,
  callbacks) vive no C++ e o Python manipula **handles opacos `int`** com identidade por id (`PY-E3`,
  `PY-E4`); **sem cache global** de objetos — instâncias são recriadas (`PY-E5`), com memoização
  pontual por instância em `Settings` (`PY-E5`).
- `[OBSERVADO]` `sheet_id` codifica o **subtipo nos 2 bits baixos** (`& 3`) (`PY-E6`).
- `[OBSERVADO]` **Callbacks Python são retidos no C++** (`PY-E9`) — inclusive o **objeto Python
  inteiro** (`TextChangeListener`) (`PY-E10`), o que é um vetor de *leak* se não houver desanexação
  explícita.
- `[INFERIDO, forte]` O dispatch nativo→`on_*` converte **id→objeto no fim do caminho**
  (`PY-E11`): o C++ não conhece o tipo Python, só o id.

---

## 3. 📡 Protocolo: framing, canais e dispatch (com Evidence IDs)

### 3.1 Framing e anel

- `[OBSERVADO]` **Framing = `[uint32 LE len][payload len bytes]`**, sem campo de tipo, opcode, flags
  ou terminador NUL (`IPC-E1`, `IPC-E7`, `HOST-E21`, `IPC-E5`). `write_message` faz **duas** escritas
  (header + corpo) sob mutex e termina com `sem_post` do leitor (`IPC-E2`, `IPC-E4`); `read_message`
  faz **duas** leituras (header 4 B → `resize` → corpo) e sinaliza o escritor (`IPC-E3`).
- `[OBSERVADO]` **Opcode é o 1º `uint32` do próprio payload** (`IPC-E5`, `IPC-E22`) — o framing é
  puramente um delimitador de comprimento.
- `[OBSERVADO]` Anel de `0x80000` B: header de `0x80` B com índices `u64` de leitura/escrita e dados a
  partir de `+0x80`; capacidade **constante** `0x7ff80` (`IPC-E8`, `IPC-E9`, `HOST-E22`).
- `[OBSERVADO]` Um **mutex + 2 semáforos nomeados** por canal (`<canal>:r` val 0, `<canal>:w` val 1),
  com `open` fazendo *unlink-after-open* (`HOST-E5`, `HOST-E6`, `IPC-E12`, `IPC-E13`, `IPC-E14`).
  Semáforos são **nomeados** (nunca `sem_init` anônimo no shm) (`IPC-E14`).

### 3.2 Dois enums opostos e dispatch denso

- `[OBSERVADO]` **Enum U** = host→núcleo, **281 ids** contíguos (`1..281`), reconstruído por dois
  caminhos independentes que concordam 1:1: o imediato `uint32` gravado em cada `api_*()` e a ordem
  da `PyMethodDef[]` do módulo `sublime_api` (`IPC-E26`, `IPC-E27`, `IPC-E29`, `HOST-E26`). O núcleo
  tem o **dispatcher gêmeo com 281 casos** (`IPC-E29`).
- `[OBSERVADO]` **Enum V** = núcleo→host, **71 ids** (`1..71`), handlers `plugin_*` (`IPC-E25`).
- `[OBSERVADO]` O **dispatch é numérico por tabela de saltos densa** (`IPC-E23`, `IPC-E30`,
  `HOST-E26`) — **zero comparações de string**; opcode inválido/curto = **silêncio** (desvio ao
  epílogo, nenhum literal de erro) (`IPC-E24`); payload é **serialização binária tipada** (`IPC-E32`).
- `[OBSERVADO]` 6 comandos têm o `fn` **remapeado no boot** (`view_insert/erase/replace`,
  `view_run_command`, `window_run_command`, `run_command`) (`IPC-E36`), e a superfície tem **13
  métodos locais** (sem protocolo) ao fim da tabela (`IPC-E28`).

### 3.3 Síncrono vs assíncrono: o *escape* `data[0] == 0`

- `[OBSERVADO]` O loop de `main` do host diferencia dois casos pelo **1º `uint32`**:
  `data[0] != 0` → `handle_protocol_message` (enum **V**); `data[0] == 0` → **entrega de resposta
  assíncrona**, que varre o **vetor de requisições pendentes**, casa `req->id == data[4]` e completa
  a entrada (`IPC-E34`) — ou seja, **opcode e id de correlação compartilham o mesmo campo** e `0` é
  o **escape** para o motor de requisições pendentes.
- `[OBSERVADO]` Alguns ids **bloqueiam** enquanto enviam — tabela auxiliar de 68 entradas
  (`is_app_blocking_while_sending`, faixa 4..71) (`IPC-E35`).
- `[DESCONHECIDO]` **Quais** ids são síncronos vs assíncronos, e como o `req_id` é gerado
  (`IPC-U4`); e se `data[0]==0` também abriga um *namespace* de controle além de `req_id` (`IPC-U6`).

---

## 4. 🖥️ Decisões de arquitetura para o editor-alvo

> Cada decisão traz o **racional** e o **Evidence ID** do padrão observado que a motivou. As escolhas
> marcadas **"escolha nossa (não observada no alvo)"** são divergências deliberadas (§6).

### DEC-IPC-1 — O `ExtensionHost` é um **processo separado** (`utilityProcess`)
**Decisão:** os plugins rodam no processo `ExtensionHost`, nunca dentro do núcleo; comunicação só
pela `ExtensionBridge`. Usaremos **Electron `utilityProcess`** (fallback: `child_process`).
**Racional:** é o mesmo padrão de isolamento do alvo (processo à parte, `CON-E19`, `HOST-E3`) —
um plugin que trava não derruba o núcleo, e o runtime de extensão evolui sozinho.
**Evidence:** `CON-E19`, `HOST-E3`, `HOST-E11`, `HOST-E14`.

### DEC-IPC-2 — O **núcleo cria o canal; o host só conecta**
**Decisão:** no bootstrap, o núcleo **cria** o `MessageChannel` e transfere **um** `MessagePort` ao
`ExtensionHost` no `postMessage` inicial; o host **nunca** cria ou nomeia canais próprios.
**Racional:** espelha 1:1 a assimetria observada (núcleo `create`, host `open`); o nome/endereço do
canal é responsabilidade do dono, não do hospedado.
**Evidence:** `HOST-E3` (3× `open`, 0× `create` no host), `HOST-E1`, `HOST-E10`.

### DEC-IPC-3 — Transporte = **`MessagePort`** (structured clone), não shm+semáforos
**Decisão:** substituímos `shm_open`+`mmap`+`sem_open` (transporte do alvo) por `MessageChannel`/
`MessagePort`, com **serialização tipada binária** por padrão; `SharedArrayBuffer`+`Atomics` fica
reservado a caminhos de *hot buffer* de alto throughput, se e quando medirmos necessidade.
**Racional:** `MessagePort` é o análogo idiomático em Node/Electron — delimitação de mensagem,
ordenação e *backpressure* vêm de graça; replicar anel+semáforos manuais em TS é complexidade sem
retorno. **Escolha nossa (não observada no alvo).**
**Evidence:** `HOST-E1`, `HOST-E17`, `HOST-E15` (o canal do alvo é C++ próprio, não `multiprocessing`).

### DEC-IPC-4 — Protocolo **request/response com IDs explícitos**; sem framing manual
**Decisão:** o framing `[uint32 LE len][payload]` do alvo é **dispensado** (o `MessagePort` já
delimita). Cada chamada é uma requisição com `id` de correlação e `Promise` correspondente; notificações
*sem* resposta são um envelope separado.
**Racional:** o framing por comprimento é um artefato do anel de bytes; no nosso transporte ele é
redundante. **Escolha nossa (não observada no alvo).**
**Evidence:** `IPC-E1`, `IPC-E2`, `IPC-E3`, `IPC-E7`, `HOST-E21`.

### DEC-IPC-5 — Dispatch **por nome tipado**, não por opcode numérico denso
**Decisão:** cada operação é um **método nomeado e tipado** no `ExtensionAPI` (tabela gerada de
handlers), não um id numérico com salto denso. **Versão do protocolo negociada no handshake.**
**Racional:** o opcode denso (`IPC-E23`, `IPC-E30`) é micro-otimização de C++ que **congela** o
protocolo; para nós, nomes + tipagem dão *autocomplete*, mensagens de erro úteis e evolução sem
renumerar 281 ids. O alvo já sinaliza esse custo ao **remapear** 6 comandos no boot (`IPC-E36`).
**Evidence:** `IPC-E23`, `IPC-E25`, `IPC-E26`, `IPC-E30`, `IPC-E36`, `HOST-E26`.

### DEC-IPC-6 — **Handles opacos** no núcleo; `ExtensionAPI` é **facade fino**
**Decisão:** o estado vive no núcleo; o host manipula **ids opacos** (`DocumentHandle`, `ViewHandle`,
`WindowHandle`), com identidade estável e **geração** embutida para evitar reciclagem ABA. A
`ExtensionAPI` não guarda estado de documento — só encaminha.
**Racional:** é exatamente o padrão observado (`PY-E3`, `PY-E4`, `PY-E5`); espelha `make_sheet`/
`sheet_id` (`PY-E6`) e evita manter dois donos do estado. A geração é **escolha nossa** (o alvo
declara a semântica de reciclagem como incógnita — `PY-U6`).
**Evidence:** `PY-E1`, `PY-E3`, `PY-E4`, `PY-E5`, `PY-E6`, `PY-U6`.

### DEC-IPC-7 — Eventos **tipados e registrados por nome** (nada de `hasattr`)
**Decisão:** mantemos o **vocabulário de hooks** do alvo como contrato de nomes, mas com
**interfaces estáticas** e um `Disposable` por inscrição — sem duck-typing em runtime.
**Racional:** o alvo tem 53 eventos (19 `_async`, `PY-E12`) e os descobre por `hasattr` no dispatch
(`PY-E13`), o que faz um hook ausente virar `AttributeError`; tipagem elimina essa classe de erro.
Mantemos a **dupla camada** `EventListener`/`ViewEventListener` e a ordem observada (VEL antes de EL,
`PY-E14`). **Escolha nossa (não observada no alvo).**
**Evidence:** `PY-E12`, `PY-E13`, `PY-E14`, `PY-E11`.

### DEC-IPC-8 — **Callbacks retidos com ciclo de vida explícito** (`Disposable`)
**Decisão:** todo callback que o núcleo retém (listeners de mudança, timers, handlers de evento)
devolve um `Disposable`; a `ExtensionBridge` derruba tudo que o host registrou quando o host morre
ou o plugin é descarregado.
**Racional:** o alvo retém o **objeto Python inteiro** no C++ (`PY-E10`) e não tem registro lado
Python (`PY-U2`) — é um vetor de *leak* e de ciclo de vida obscuro. Nós tornamos a desanexação
obrigatória. **Escolha nossa (não observada no alvo).**
**Evidence:** `PY-E9`, `PY-E10`, `PY-E11`, `PY-U2`.

### DEC-IPC-9 — Correção assíncrona via **`Promise` + `AbortSignal`**, sem *escape* no opcode
**Decisão:** requisições longas são **sempre** assíncronas e retornam `Promise`; cancelamento é um
`AbortSignal` explícito. Não reservamos um valor de opcode (`0`) como *escape* para o motor de
requisições pendentes.
**Racional:** o *escape* `data[0]==0` (`IPC-E34`, `IPC-U6`) sobrecarrega o mesmo campo com dois
significados e torna o protocolo opaco; um `id` de requisição dedicado + `AbortSignal` dá o mesmo
resultado com semântica clara. **Escolha nossa (não observada no alvo).**
**Evidence:** `IPC-E34`, `IPC-U4`, `IPC-U6`.

### DEC-IPC-10 — **Nunca bloquear** a main thread; *backpressure* explícito
**Decisão:** a `ExtensionBridge` é **assíncrona por padrão** (nada de espera bloqueante na main do
núcleo); respeitamos a *backpressure* do `MessagePort` e usamos timeouts + *heartbeat* de saúde do
host. Não replicamos uma tabela “bloqueia-ao-enviar”.
**Racional:** o alvo tem chamadas que **bloqueiam enquanto enviam** (68 ids, `IPC-E35`) e espera com
semáforo (`HOST-E5`, `HOST-E6`); no nosso caso bloquear a main é justamente o que o modelo
Electron/worker evita. **Escolha nossa (não observada no alvo).**
**Evidence:** `IPC-E35`, `HOST-E5`, `HOST-E6`, `IPC-U5`.

### DEC-IPC-11 — **Handshake com negociação de capacidades**
**Decisão:** o bootstrap do `ExtensionHost` inclui um `ready` com versão do host **e** versão da API;
o núcleo ajusta o conjunto de métodos/eventos disponíveis antes de carregar qualquer plugin.
**Racional:** o alvo embute a **versão no nome do canal** (`-3.14`/`-3.3`) e espera `api_ready`
(`HOST-E4`, `PY-E28`); nós trocamos “dois binários incompatíveis” por **uma superfície negociada**.
**Evidence:** `HOST-E4`, `HOST-E14`, `PY-E28`.

### DEC-IPC-12 — **Carregamento de extensões via `PackageResolver`**, isolado no host
**Decisão:** a descoberta/instalação de pacotes fica no núcleo (`PackageResolver`); o
`ExtensionHost` carrega módulos já resolvidos sob demanda e recebe um `ExtensionAPI` versionado.
**Racional:** espelha a separação observada entre resolução de `.sublime-package` (meta-path) e o
runtime que hospeda o plugin (`PY-E19`, `PY-E22`).
**Evidence:** `PY-E19`, `PY-E22`, `PY-E28`.

---

## 5. 📐 Contratos TypeScript (interfaces/assinaturas do NOSSO código)

```ts
// ── Identidade opaca (espelha PY-E4: handles int; o estado mora no núcleo) ─────────────
export type Handle<T extends string> = number & { readonly __brand: T };
export type DocumentHandle = Handle<"DocumentHandle">;
export type ViewHandle     = Handle<"ViewHandle">;
// ── Envelopes da ExtensionBridge (escolha nossa — substitui o framing do alvo) ──
export type ExtensionBridgeVersion = `${number}.${number}`;
export interface RpcError { code: string; message: string; data?: unknown }

export type HostToCore =
  | { kind: "ready";  hostVersion: string; apiVersion: ExtensionBridgeVersion }
  | { kind: "call";   id: number; method: string; args: readonly unknown[] }  // espera result/error
  | { kind: "notify"; method: string; args: readonly unknown[] }              // fire-and-forget
  | { kind: "emit";   event: string; payload: unknown };                      // host → núcleo (hook)

export type CoreToHost =
  | { kind: "result"; id: number; ok: true;  value: unknown }
  | { kind: "error";  id: number; ok: false; error: RpcError }
  | { kind: "call";   id: number; method: string; args: readonly unknown[] }  // núcleo → host (hook)
  | { kind: "cancel"; id: number };                                          // corta uma requisição

// ── O transporte: núcleo cria, host só conecta (HOST-E3) ──
export interface ExtensionBridge {
  request<M extends keyof ExtensionMethods>(
    method: M, args: Parameters<ExtensionMethods[M]>, opts?: { signal?: AbortSignal },
  ): Promise<Awaited<ReturnType<ExtensionMethods[M]>>>;   // nunca bloqueia a main (DEC-IPC-10)
  notify(method: string, args: readonly unknown[]): void;
  on<E extends keyof ExtensionEvents>(event: E, handler: (...a: ExtensionEvents[E]) => void): Disposable;
  close(): Promise<void>;
}
export interface Disposable { dispose(): void }

// ── A API que o plugin vê: facade fino sobre o núcleo (PY-E1/PY-E3) ──
export interface ExtensionAPI {
  readonly version: ExtensionBridgeVersion;   // negociada no handshake (DEC-IPC-11)
  readonly documents: DocumentRegistry;       // por DocumentHandle opaco
  readonly commands:  CommandBus;             // dispatch por nome (DEC-IPC-5)
  readonly packages:  PackageResolver;        // resolução fora do host (DEC-IPC-12)
  on<E extends keyof ExtensionEvents>(event: E, handler: (...a: ExtensionEvents[E]) => void): Disposable;
}
```

> **Nota:** `ExtensionMethods`/`ExtensionEvents` são **mapas de tipos gerados** (nomes + assinaturas),
> não opcodes — é a materialização do DEC-IPC-5. Os nomes de evento seguem o vocabulário de 53 hooks
> observado (`PY-E12`); o conteúdo dos payloads é **nosso contrato**, não um espelho do alvo.

---

## 6. 🔀 Divergências deliberadas (onde NÃO seguimos o alvo, e por quê)

| # | Alvo (observado) | Arcane (nosso) | Por quê |
|---|---|---|---|
| D1 | shm POSIX + 2 semáforos nomeados por canal (`HOST-E1`, `IPC-E12`) | `MessageChannel`/`MessagePort` | idiomático em Electron/Node; sem syscalls manuais nem `sem_unlink` |
| D2 | Framing `[uint32 len][payload]` (`IPC-E1`) | sem framing — structured clone delimita | o comprimento é redundante no transporte novo |
| D3 | Dispatch numérico denso, 281/71 ids (`IPC-E23`, `IPC-E30`) | métodos/eventos nomeados e tipados | evolução e DX; evita renumerar ids |
| D4 | 3 canais separando sync/async (`HOST-E2`, `IPC-E16`) | **1 port multiplexado** (+ canal de controle opcional) | uma `id` de correlação cobre os dois modos |
| D5 | `data[0]==0` como *escape* (`IPC-E34`) | `id` de requisição dedicado + `AbortSignal` | não sobrecarregar o campo de opcode |
| D6 | Chamadas que bloqueiam ao enviar (68 ids, `IPC-E35`) | tudo assíncrono + *backpressure* | bloquear a main é o que o modelo worker evita |
| D7 | Descoberta de hook por `hasattr` (`PY-E13`) | interfaces estáticas + registro | mata o `AttributeError` de hook ausente |
| D8 | Objeto Python retido no C++, sem registro (`PY-E10`, `PY-U2`) | `Disposable` obrigatório, derrubado com o host | evita *leak* e ciclo de vida obscuro |
| D9 | Versão embutida no nome do canal (`HOST-E4`) | negociação de capacidades no handshake | um host, N versões negociadas |
| D10 | Handles reciclados (semântica desconhecida, `PY-U6`) | id com **geração** (anti-ABA) | tolerar reuso sem referência pendente inválida |

> **O que mantemos:** isolamento em processo (`DEC-IPC-1`), criação do canal pelo núcleo
> (`DEC-IPC-2`), handles opacos com estado no núcleo (`DEC-IPC-6`), a separação semântica
> síncrono/assíncrono (como prioridade, não como objeto) e o **vocabulário de hooks** — porque é ele
> que define a superfície que um plugin precisa aprender.

---

## 7. 🧾 Rastreabilidade (Conclusão → DEC → Status)

| Conclusão (Evidence IDs) | DEC | Status |
|---|---|---|
| Host é processo à parte; núcleo cria canal, host só abre (`CON-E19`, `HOST-E3`, `HOST-E10`, `HOST-E11`) | `DEC-IPC-1`, `DEC-IPC-2` | ✅ decidido |
| Transporte = shm+semaforos (`HOST-E1`, `HOST-E17`) | `DEC-IPC-3` | ✅ decidido (substituído por `MessagePort`) |
| Framing `[uint32 len][payload]` (`IPC-E1`, `IPC-E2`, `IPC-E7`, `HOST-E21`) | `DEC-IPC-4` | ✅ decidido (dispensado) |
| Opcode = 1º `uint32`; dispatch denso; enums U/V (`IPC-E22`, `IPC-E23`, `IPC-E25`, `IPC-E26`, `IPC-E30`) | `DEC-IPC-5` | ✅ decidido (nome tipado) |
| Facade finito; handles opacos int (`PY-E1`, `PY-E3`, `PY-E4`, `PY-E6`) | `DEC-IPC-6` | ✅ decidido |
| 53 eventos / 19 `_async`; duck-typing por `hasattr` (`PY-E12`, `PY-E13`) | `DEC-IPC-7` | ✅ decidido |
| Callbacks e objeto Python retidos no C++ (`PY-E9`, `PY-E10`, `PY-U2`, `PY-U6`) | `DEC-IPC-8` | ✅ decidido (contrato cobre a lacuna) |
| Sintaxe `data[0]==0` para resposta pendente (`IPC-E34`) | `DEC-IPC-9` | ✅ decidido (id dedicado) |
| 68 ids bloqueiam ao enviar (`IPC-E35`); versão no nome do canal / `api_ready` (`HOST-E4`, `PY-E28`) | `DEC-IPC-10`, `DEC-IPC-11` | ✅ decidido (assíncrono + API versionada) |
| Carregamento por meta-path / `lib_path` (`PY-E19`, `PY-E22`) | `DEC-IPC-12` | ✅ decidido |

---

## 8. ⚠️ Incógnitas que afetam este módulo (refs PY-U*/HOST-U*/IPC-U*)

| ID | Incógnita | Efeito no nosso módulo |
|---|---|---|
| `PY-U1` | Assinaturas de `sublime_api.*` (só inferidas dos call-sites) | limita o espelho de nomes de método; usamos contrato **nosso** |
| `PY-U2` | Como o C++ descobre e chama `sublime_plugin.on_*` | informa `DEC-IPC-7`/`DEC-IPC-8` (registro vs descoberta) |
| `PY-U3` | Thread de execução de cada callback | define onde o `ExtensionHost` serializa eventos vs paraleliza |
| `PY-U5` | `MultiCompletionList_append` e outras extensões nativas | tipos opacos do núcleo a modelar na `ExtensionAPI` |
| `PY-U6` | Regras de invalidação/reciclagem de handles | motiva a **geração** anti-ABA em `DEC-IPC-6` |
| `PY-U8` | `sublime_api` pode virar mock | nos permite ter uma `ExtensionBridge` **in-process** para testes |
| `PY-U10` | Deprecações silenciosas 3.3→3.14 | justifica versionar a API no handshake (`DEC-IPC-11`) |
| `HOST-U2` | Significado de `argv[1]` (não confirmado ser o PID) | mapeia para o **id da extensão/host** no bootstrap |
| `HOST-U3` | Contrato completo dos 8 argumentos de CLI | informa o que passamos no `postMessage` inicial do host |
| `HOST-U6` | Detalhe do bit em `.data 0x20fc30` (variante dinâmica nula) | não modelado; possível flag de *liveness* do host |
| `IPC-U2` | Semântica exata dos canais do bundle; quando `subl_arecv` é usado por thread não-main | deixou a direção `HOST-E20` como **superada**; seguimos `IPC-E18/E19` |
| `IPC-U3` | `shm_channel+0x50`/`+0x51` (creator/poison) | mapeia conceitualmente ao estado de saúde do host (`heartbeat`) |
| `IPC-U4` | Quais ids são síncronos vs assíncronos; geração do `req_id` | motiva `DEC-IPC-9` (uniformizar em Promise+id) |
| `IPC-U5` | Critério de `is_app_blocking_while_sending` (68 ids) | motiva `DEC-IPC-10` (não bloquear nunca) |
| `IPC-U6` | `data[0]==0` pode ser *namespace* de controle além do `req_id` | reforça tratar correlação como campo próprio |

> **Como usar este documento:** ele é a **receita** do subsistema de extensão para a Fase 3
> (`src/`). Antes de codar a `ExtensionBridge`, confirme as incógnitas que mudam contrato
> (`PY-U6`, `IPC-U4`) ou aceite explicitamente as escolhas nossas marcadas em §6.
