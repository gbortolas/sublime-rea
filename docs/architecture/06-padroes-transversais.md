# 06 · Padrões transversais — o que reaparece em todo o Arcane

> Fase 2 (P2.1) · síntese clean-room do alvo (sha256 8b105b18…43d92) · insumo: evidence-index.md · 2026-10-16

**Achado central (1 frase):** por baixo das **3 fronteiras** mapeadas na Fase 1 (núcleo C++ compartilhado,
ponte IPC por anel em shm com o host CPython embutido, e render GTK/GL-Skia) repetem-se **9 padrões
estruturais** aplicados de forma consistente — e são exatamente os que **sobrevivem à troca de stack** (C++/GTK → Electron/TS), porque
descrevem **contratos e ciclos de vida**, não implementação.

**Escopo.** Isto é **catálogo transversal**: 1 seção por padrão, cada uma com *nome · forma no alvo (com
Evidence IDs) · como o Arcane implementa · armadilhas*. O detalhe de cada componente vive nos docs `01`–`05`
— aqui só se aponta para eles. Nenhum trecho, pseudocódigo ou assembly do alvo é reproduzido; snippets são
**do nosso código**.

**Componentes (glossário canônico, sem variação):** `Buffer` · `TextStore` · `DocumentRegistry` ·
`DocumentHandle` · `CommandBus` · `Scheduler` · `TaskPool` · `ExtensionHost` · `ExtensionBridge` ·
`ExtensionAPI` · `RenderPipeline` · `Viewport` · `PackageResolver` · `PropertySystem`. Codinome provisório:
**Arcane** (P2.3 no [`../BACKLOG.md`](../BACKLOG.md)).

**Rótulos:** `[OBSERVADO]` / `[INFERIDO]` / `[DESCONHECIDO]` descrevem o **alvo**; toda decisão nossa leva
**“escolha nossa (não observada no alvo)”**.

---

## 0. 🧭 Como este doc se liga aos demais (mapa para 01–05)

**Sem repetir conteúdo.** Os docs `01`–`05` são **donos** das decisões por componente — os IDs
(`DEC-BUF-1…10`, `DEC-CON-1…12`, `DEC-IPC-1…12`, `DEC-REN-1…8`, `DEC-PKG-1…12`) nascem **lá** e são apenas
**referenciados** aqui. As decisões que este doc cria são transversais: **`DEC-TR-1…7`** (§11).

| Doc irmão (dono) | Componentes | Seções do **06** que cobrem o padrão | O que **este** doc usa dele |
|---|---|---|---|
| [`./01-buffer-e-edicao.md`](./01-buffer-e-edicao.md) | `Buffer`, `TextStore`, `DocumentRegistry`, `DocumentHandle`, `CommandBus` | §1 handle · §2 observer · §3 comando/undo | id opaco, notificação de mudança, delta |
| [`./02-concorrencia-e-scheduling.md`](./02-concorrencia-e-scheduling.md) | `Scheduler`, `TaskPool` | §4 work item + lanes · §6 sizing | lanes, escrita única, backpressure |
| [`./03-extensao-e-ipc.md`](./03-extensao-e-ipc.md) | `ExtensionHost`, `ExtensionBridge`, `ExtensionAPI` | §5 canal/dispatch · §9 handshake · §2 hooks | tabela de opcodes, versionamento, `ready` |
| [`./04-render-e-ui.md`](./04-render-e-ui.md) | `RenderPipeline`, `Viewport` | §7 backends · §2 damage/observers · §6 props | superfície do backend, *dirty rects* |
| [`./05-empacotamento-e-recursos.md`](./05-empacotamento-e-recursos.md) | `PackageResolver`, `PropertySystem` | §8 namespace/precedência · §6 props por escopo | camadas de precedência, tipos de recurso |

**Regra de leitura:** quer *como* construir o buffer → leia `01`; quer *o que se repete* entre buffer,
viewport, props e recursos → leia aqui.

---

## 1. 🏛️ Façade + handle opaco

**Forma no alvo.**
- `TextBuffer` é uma **façade** RTTI que delega o texto a um núcleo **anônimo** (`0x108` B em `+0x250`) +
  `TokenStorage` (`0x328` B em `+0x2f0`) — `BUF-E1`, `BUF-E4`; o dtor libera buffers de heap e o array de
  registros de `0x20` B — `BUF-E5` `[OBSERVADO]` (typeinfo/pseudocódigo).
- Na API de plugins, **tudo** é handle opaco `int`, identidade **por id**, e a façade é **stateless** (o
  estado vive no C++) — `PY-E1`, `PY-E3`, `PY-E4` `[OBSERVADO]` (artefato). O id pode **codificar subtipo**
  em bits baixos (`sheet_id & 3`) — `PY-E6`.
- Validade é checada por chamada nativa (`is_valid`) — `PY-E8`; **como** ids são invalidados/reciclados é
  `[DESCONHECIDO]` — `PY-U6`.
- **Sem cache global** de objetos (instâncias recriadas); só memoização **por instância** em `Settings` —
  `PY-E5`. A superfície concentra-se numa façade grande: `View` = 133 métodos nativos — `PY-E32`.

**Como o Arcane implementa.** `Buffer` é a façade pública; `TextStore` é privado. Toda referência cruza a
fronteira como `DocumentHandle` **opaco com geração** — o `DocumentRegistry` **recusa** handle velho em vez
de resolvê-lo para o documento errado.

```ts
export type DocumentHandle = number & { readonly __brand: 'DocumentHandle' }; // escolha nossa
// bits altos = slot · bits baixos = geração (reciclagem explícita)
registry.resolve(h): Buffer | undefined   // undefined = handle morto, nunca "o doc novo do mesmo slot"
```

Store/delta/undo: `DEC-BUF-*` (`01`). Contrato de handle e reciclagem: **`DEC-TR-1`**.

**Armadilhas.**
- Handle **sem geração** = ABA clássico (slot reciclado → plugin escreve no doc errado). O alvo só expõe
  `is_valid` (`PY-E8`) e a regra é `[DESCONHECIDO]` (`PY-U6`) — não há semântica para "copiar": nós a definimos.
- O handle **não** é credencial única: na fronteira do `ExtensionBridge` ele é revalidado.
- `DocumentRegistry` é a **autoridade única** de vivacidade — nada de memoizar faça de fora dele (`PY-E5`).

---

## 2. 👁️ Observer / listener (com ciclo de vida explícito)

**Forma no alvo.**
- O core do buffer **embute** um subobjeto `observer` e um `TokenStorage:LayoutTracker` — `BUF-E6`
  `[OBSERVADO]` → mudança de texto **notifica**, e *layout* é ele próprio um observador.
- O viewport é **data source + observers + alvo animado** — `REN-E19` `[OBSERVADO]`; a região danificada
  (*damage*) é o sinal que vira clip — `REN-E18`.
- 53 eventos (19 `_async`) — `PY-E12`; o dispatch nativo→`on_*` **converte id→objeto no fim da cadeia** —
  `PY-E11` `[INFERIDO]` (o C++ não está no tarball — `PY-U2`); a ordem é **por hook** (VEL antes de EL em
  `on_text_command`) — `PY-E14`.
- Listeners são **duck-typed** (hooks só na docstring), filtrados por `hasattr` — `PY-E13`; **exceção
  perigosa:** `el_callbacks` **não** filtra → hook ausente = `AttributeError` — `PY-E13`.
- **Retenção:** callbacks Python e **objetos inteiros** de listener ficam retidos no C++ — `PY-E9`, `PY-E10`.

**Como o Arcane implementa.** `Signal<T>` tipado com **token de descarte obrigatório** — o inverso do alvo,
onde o desanexo é opcional e o objeto inteiro fica preso (`PY-E10`). Observador de vida longa
(`DocumentRegistry`) usa referência fraca; só observador curto (frame) é forte.

```ts
const t = buffer.on('changed', e => viewport.invalidate(e.dirty)); // escolha nossa: token é a regra
t.dispose();                                  // sem dispose não há unsubscribe
```

Vocabulário de eventos e *dirty*: `DEC-BUF-*`/`DEC-REN-*`. Hooks e retenção na fronteira: `DEC-IPC-*`.
Desanexo/weak ref: **`DEC-TR-2`**.

**Armadilhas.**
- **Reentrância síncrona:** listener que edita o buffer durante o emit (o alvo notifica inline — `BUF-E6`).
  Fila por *lane* (§4) em vez de notificação inline.
- **Hook opcional que explode:** copiar `el_callbacks` (`PY-E13`) é copiar um crash — interface tipada com
  no-op explícito.
- **Ordem implícita:** `PY-E14` documenta **um** hook; o resto é "ordem do loop" `[DESCONHECIDO]`. Em
  Arcane a ordem é **declarada** por prioridade.
- Retenção forte no host (`PY-E9`/`PY-E10`) → `ExtensionHost` guarda **ids**, nunca o objeto do plugin.

---

## 3. 🧾 Comando + agrupamento de undo (delta / command-sourcing)

**Forma no alvo.**
- Edição modelada por **comandos** (`text_command` → `insert`/`append`/…`delete`) com **nome e descrição** —
  `BUF-E8` `[OBSERVADO]` (strings + vtable); o corpo de cada comando não foi lido `[DESCONHECIDO]`.
- A **mudança** é um objeto com **sub-array de registros** — i.e. **delta-based** — `BUF-E11` `[OBSERVADO]`;
  o conteúdo do registro é `[DESCONHECIDO]` — `BUF-U3`.
- Vocabulário de undo: *stacks*, **grupos**, *gluing*, *soft undo/redo* — `BUF-E9` (strings que **também**
  servem de nome de comando — limite declarado); `clear_undo_stack` só limpa sob uma flag, e os grupos moram
  em **três** offsets — `BUF-E10`.
- Na extensão, comandos trafegam como tuplas `(instância, nome)` — `PY-E16`; o **edit token** é
  aberto/fechado **pelo host** — `PY-E17`; a Command Palette usa heurística de `TypeError` — `PY-E18`; há
  separação main-thread × worker — `PY-E27`.

**Como o Arcane implementa.** `CommandBus` é o **ponto único** de mutação: todo comando devolve os `Edit`
aplicados e o undo guarda os **inversos** (delta), não snapshots. O agrupamento é uma **transação** explícita,
substituindo o par implícito *glue/soft*.

```ts
type Edit = { at: number; remove: string; insert: string };        // escolha nossa
interface Command { name: string; apply(s: TextStore, t: EditToken): Edit[] }
bus.run('buffer.insert', { text }, { group: 'typing.42' });         // group = unidade de undo
```

`TextStore`/delta/complexidade: `DEC-BUF-*` (`01`). Token de edição e contrato do `CommandBus`: **`DEC-TR-3`**.

**Armadilhas.**
- **Coalescing de digitação** é explícito (*group*), não mágico: herdar *glue*/*soft* sem a regra (`BUF-E9`)
  deixa o undo imprevisível.
- **Nome de comando ≠ rótulo de undo:** no alvo são a mesma string (`BUF-E9`); mantenha `CommandId`
  (contrato de API) separado de `undoLabel` (UI/i18n).
- **Token cruzando `await`** → delta aplicado em estado já mudado; o token é escopado à transação (`PY-E17`).
- Command Palette por exceção (`PY-E18`) é frágil: declare `canAcceptInput()` tipado.

---

## 4. 🧵 Work item + scheduler (marshalling à main thread)

**Forma no alvo.**
- **Item de trabalho** = objeto com **vtable + refcount atômico**, executado por chamada **virtual** —
  `CON-E11` `[OBSERVADO]`; campos internos `[DESCONHECIDO]` — `CON-U3`.
- O retorno ao main thread passa pelo **`px_main_thread_scheduler`** (`sched_work_item`) — `CON-E15`
  `[INFERIDO]`; **quais** callbacks são postados e se há *coalescing* é `[DESCONHECIDO]` — `CON-U5`.
- Filas/runners nomeados: `work_queue_runner`, `lazy_work_queue`, `timer_scheduler` — `CON-E12`; wakeup por
  *pipe* — `CON-E16`; fds integrados ao loop GLib — `CON-E2`.
- Threads: fábrica central (stack **2 MiB**, nome via `prctl`) — `CON-E8`, `CON-E5`, `CON-E6`; **pool de I/O**
  de N threads (`io_worker`, N = setting) — `CON-E9`; pool **on-demand limitado a 2** — `CON-E10`; modelo
  assíncrono declarado (`promise`/`future_core`/`io_scheduler`/`async_file_system`) — `CON-E14`.

**Como o Arcane implementa.** `Scheduler` com **lanes** de prioridade (`input` > `edit` > `layout` >
`background`) + `TaskPool` sobre `worker_threads`; **escrita única**: só a lane de edição muta
`TextStore`/`Viewport`, e o resultado volta por `MessagePort`.

```ts
type Priority = 'input' | 'edit' | 'layout' | 'background';        // escolha nossa (canônico: 02)
scheduler.post('edit', () => store.apply(cmd), { handle })           // Promise<Edit[]>
         .then(edits => viewport.invalidate(dirtyOf(edits)));
```

Lanes/limites de pool: `DEC-CON-*` (`02`). Escrita única + posse de handle em item assíncrono: **`DEC-TR-4`**.

**Armadilhas.**
- **Análogo de use-after-free:** item em voo segurando `DocumentHandle` de documento fechado. O alvo usa
  refcount atômico (`CON-E11`); em TS a solução é **escopo de vida** (`Lifetime`/`AbortSignal`), não contagem.
- **Fila sem backpressure:** o alvo limita por setting (`io_workers`, `CON-E18`) e por teto 2 (`CON-E10`) —
  copiar a ideia, com limites explícitos e métricas.
- **Coalescing a esmo:** o *coalescing* do alvo é `[DESCONHECIDO]` (`CON-U5`); o que vale copiar é o **tick
  de frame** (`REN-E3`) — agrega *dirty rects* num único passo por frame.
- Não replique `item+8`/`vtable+0x18` (`CON-E11`, `CON-U3`): o padrão é "item virtual + refcount"; a
  geometria de memória é irrelevante em TS.

---

## 5. 🔌 Bundle + canal + dispatch numérico (o contrato binário estável)

**Forma no alvo.**
- Transporte: **anel em shm** `0x80000` + framing `[uint32 LE len][payload]` + semáforos `<canal>:r`/`:w`
  — `IPC-E1`–`IPC-E14` (duplicado em `HOST-E21`–`HOST-E24`).
- **Sem campo de tipo:** o **opcode é o 1º `uint32` do payload** e o `unsigned long` é o **índice do
  bundle** — `IPC-E5`, `IPC-E22`; dispatch por **tabela de saltos densa** — `IPC-E23`; opcode inválido =
  **silêncio** — `IPC-E24`; payload = **binário tipado** — `IPC-E32`.
- Dois enums, **idênticos** em 3.3/3.14: **U** = **281 ids** host→núcleo (twin dispatcher com 281 casos) —
  `IPC-E26`, `IPC-E29`, `IPC-E30`; **V** = **71 ids** núcleo→host → `plugin_*` — `IPC-E25`.
- **A ordem é o contrato:** `PyMethodDef[]` (294 × 32 B) com **ordem = ids `1..281`** + 13 métodos locais no
  fim — `IPC-E27`, `IPC-E28`.
- Bundle = 1 elemento de `0x78`; canais `+0x8`/`+0x10`/`+0x18` = **slot por papel de thread** — `HOST-E25`,
  `IPC-E15`–`IPC-E17`; `data[0]==0` = ***escape*** do motor de requisições pendentes — `IPC-E34`; tabela
  "blocking by opcode" (**68**) — `IPC-E35`; **6** `fn` remapeadas no boot — `IPC-E36`.

**Como o Arcane implementa.** `ExtensionBridge` com **tabela de opcodes gerada** a partir da interface
`ExtensionAPI` — a numeração é **derivada**, preservando a propriedade que o alvo obtém do `PyMethodDef[]`
(`IPC-E27`): *id e superfície não podem divergir*. Payload = CBOR (escolha nossa) e um `MessagePort` por
**papel** (main/async), espelhando o *slot* por thread (`HOST-E25`).

```ts
// GERADO de ExtensionAPI — a ORDEM é o contrato (cf. IPC-E27). Nunca editar à mão.
export const OPS = defineOps<ExtensionAPI>({
  buffer_insert: 1, buffer_erase: 2, view_scroll: 3, /* … */   // escolha nossa
});
```

Protocolo/canais/versionamento: `DEC-IPC-*` (`03`). Opcode desconhecido e chamadas síncronas: **`DEC-TR-5`**.

**Armadilhas.**
- **Id posicional imutável:** em `IPC-E27`/`IPC-E33`, remover/reordenar um opcode renumera o contrato
  inteiro. Numere por **faixas de namespace** e reserve buracos para remoção.
- **Silêncio em opcode inválido** (`IPC-E24`) é ótimo para o alvo e péssimo para nós: dev = erro alto com
  telemetria; prod = ignora, mas registra.
- **Chamada síncrona cruzando a fronteira:** a tabela de 68 entradas (`IPC-E35`) existe porque alguns ids
  **bloqueiam** o app. Toda chamada cross-boundary é **async por default**; as síncronas são marcadas e
  testadas contra deadlock.
- **Deriva de versão:** os enums são idênticos entre hosts (`IPC-E30`) e não há negociação — nós
  **hasheamos a tabela** no handshake e falhamos cedo (§9).

---

## 6. ⚙️ Sistema de propriedades (settings/properties observáveis)

**Forma no alvo.**
- Há uma **biblioteca de controles + sistema de propriedades** sobre o render context — `REN-E27`
  `[OBSERVADO]` (catálogo RTTI em `.rodata`).
- `Settings` é **dict-like** (`to_dict`/`setdefault`/`update`) — `PY-E29`, com **memoização por instância** —
  `PY-E5`.
- Sizing vem de settings: `io_workers`, `index_workers`, `max_background_threads` — `CON-E18`; defaults
  parcialmente fechados: `io_workers: 2`, `index_workers: 0` — `REN-E26` (resta `CON-U6`).
- O **backend de render é escolhido por setting** (`hardware_acceleration`; bit de estado) — `REN-E23`;
  valores `"none"`/`"opengl"`, mais `font_options`/`theme_font_options` — `REN-E24`.
- Props filtradas por **escopo/seletor** — `PKG-E22`; override `User` > `Default` declarado — `PKG-E21`;
  ordem de merge `[DESCONHECIDO]` — `PKG-U2`.

**Como o Arcane implementa.** `PropertySystem` com **schema declarado**: cada propriedade é um objeto tipado
(`defineProperty`) com default, escopo e evento de mudança (liga-se ao §2). O valor é **resolvido em
camadas** e o resultado é cacheado por escopo, invalidado por evento — nada de leitura em hot path.

```ts
const ioWorkers = defineProperty<number>('editor.ioWorkers', 2, { scope: 'global' }); // escolha nossa
const gpuBackend = defineProperty<'auto'|'canvas2d'|'webgpu'>('render.backend', 'auto', { scope: 'global' });
ps.value(ioWorkers)              // resolve camadas; emite PropertyChanged
```

Props por escopo/seletor: `DEC-REN-*` (`04`) e `DEC-PKG-*` (`05`). Precedência explícita: **`DEC-TR-6`**.
Sizing de pools: `DEC-CON-*` (`02`).

**Armadilhas.**
- **Superfície stringly/dict-like** (`PY-E29`): typo vira default silencioso; com `defineProperty` vira erro
  de compilação.
- **Ler settings no hot path** (por token renderizado): resolva **uma vez por frame** num *snapshot*.
- **Prop que troca backend em runtime** (`REN-E23`) exige *dispose* + rebuild do contexto — declare o ciclo.
- **Precedência implícita** entre camadas é `[DESCONHECIDO]` (`PKG-U2`, `PKG-U3`): nós **declaramos** a ordem
  e testamos; não herdamos a ambiguidade.

---

## 7. 🎛️ Pipeline abstrato + backends plugáveis (Strategy)

**Forma no alvo.**
- Base **abstrata `px_render_context`** com duas implementações (`gl_render_context`, `skia_render_context`)
  e **interface de 31 virtuais idêntica** — `REN-E4`, `REN-E5` `[OBSERVADO]` (vtables).
- GL: desenho **instanciado** com tetos **8192**/**128** — `REN-E9`–`REN-E12`, `REN-E7`; software: **Skia
  raster estático** sobre Cairo, **sem** Ganesh/GL — `REN-E21`, `REN-E22`; escolha por setting — `REN-E23`;
  falha do GL = **diálogo modal**, não fallback silencioso — `REN-E25` (queda automática `[DESCONHECIDO]` —
  `REN-U3`).
- O mesmo Strategy reaparece na **cache de glifos** — `REN-E17` — e nas **variantes do mesmo runner/queue** de
  I/O (`io_worker` × `file_read_thread`) — `CON-E9`, `CON-E10`, `CON-E12`, `CON-E14`.
- Render na **main/GTK thread** por tick de frame — `REN-E3`; texto moldado na **CPU** → atlas `RGBA8` —
  `REN-E15`, `REN-E16`.

**Como o Arcane implementa.** `RenderPipeline` **grava operações** (draw list) e os backends as executam — é
o que torna o backend realmente plugável. `Canvas2D` e `WebGPU` implementam a **mesma** interface pequena, e
o texto é moldado numa camada **única** compartilhada.

```ts
interface RenderBackend {                       // escolha nossa
  beginFrame(vp: Viewport): void;
  rect(r: Rect, style: RectStyle): void;
  glyphRun(run: GlyphRun): void;
  endFrame(): void;
}
```

Backends/superfície/damage: `DEC-REN-*` (`04`). Estratégia de pool (mesmo padrão em I/O): `DEC-CON-*` (`02`).
Fallback: **`DEC-TR-7`** — **escolha nossa (não observada no alvo)**: fallback **declarado e logado**, nunca
silencioso.

**Armadilhas.**
- **Vazar tipo específico de backend** para o pipeline: é o que a fronteira de 31 virtuais idênticos
  (`REN-E5`) impede. Mantenha a superfície pobre.
- **Shaping por backend:** o alvo molda na CPU **antes** do backend (`REN-E16`); duplicar shaping por backend
  multiplica bugs de métrica.
- **Copiar constantes de tuning** (`8192`, `128`, supersample 8×, feather 0.5 — `REN-E7`, `REN-E13`) como
  dogma: são parâmetros do alvo; viram **props medidas**, não constantes.

---

## 8. 🗂️ Namespace lógico + precedência (layering / Chain of Responsibility)

**Forma no alvo.**
- **54** pacotes, cada um um **ZIP comum sem manifesto** — `PKG-E1`, `PKG-E2` — cujo **nome é o prefixo
  lógico** `Packages/<Nome>/` — `PKG-E3`; layout **flat**, **papel pela extensão** (16 tipos) — `PKG-E4`,
  `PKG-E5`; subpastas/subpacotes convencionais — `PKG-E6`, `PKG-E7`.
- Convenções por **nome de arquivo**: plataforma (`(Linux)`) — `PKG-E8`; ocultação (`.hidden-`/`hidden:`,
  **102**) — `PKG-E9`, `PKG-E10`; **herança por nome lógico** (`extends`) — `PKG-E14`.
- **Importáveis como módulos** por meta-path — `PKG-E17`/`PKG-E18`; **duas raízes** (`Packages`, `Installed
  Packages`) — `PKG-E20`; override **`User` > `Default`** declarado — `PKG-E21`; carregar é nativo (glob +
  teto 16 MiB) — `PKG-E19`.
- `[DESCONHECIDO]`: ordem de merge (`PKG-U2`), precedência entre raízes (`PKG-U3`), algoritmo de `extends`
  (`PKG-U7`), regra da variante de plataforma (`PKG-U8`), semântica de hidden (`PKG-U4`).

**Como o Arcane implementa.** `PackageResolver` com **lista ordenada de camadas** e resolução
**determinística por índice** (menor vence) — o que o alvo deixa implícito, nós **declaramos e testamos**.
Nome lógico = `<pkg>/<path>`; o tipo de recurso vem de uma **tabela gerada**; `extends` é resolvido
**eagerly**, com detecção de ciclo.

```ts
// ordem NOSSA — escolha nossa (não observada no alvo): o alvo não a documenta (PKG-U2/U3)
const LAYERS = ['platform', 'installed', 'packages', 'user'] as const;  // menor índice vence
```

Camadas/tipos/merge: `DEC-PKG-*` (`05`). Props por escopo: §6 / **`DEC-TR-6`**.

**Armadilhas.**
- **Contratos por nome de arquivo** (`.hidden-`, `(Linux)`) são invisíveis: viram **tabela explícita** com
  teste (`PKG-U4`, `PKG-U8`).
- **Precedência ambígua** é a origem do bug "funciona na minha máquina" (`PKG-U3`): uma ordem declarada, um
  teste por camada.
- **ZIP sem manifesto** (`PKG-E2`) + ausência de versão/dependências (`PKG-U6`): não repetir — o pacote do
  Arcane tem metadado mínimo (nome, versão, engines).
- Não depender de ordem de entradas do ZIP (`PKG-E4`).

---

## 9. 🤝 Handshake e estado de ciclo de vida

**Forma no alvo.**
- Handshake explícito: flag `api_ready` + fila de *deferred plugin loads* + **re-síntese** de
  `on_activated_async` — `PY-E28` `[OBSERVADO]` (artefato legível); o *motivo* do atraso é `[INFERIDO]`.
- O núcleo **cria** os canais e faz spawn do host, que só os **abre** — `HOST-E3`, `HOST-E4`; o host exige
  **≥ 8 argumentos** de CLI — `HOST-E11` (contrato completo `[DESCONHECIDO]` — `HOST-U3`).
- Pacotes viram módulos por meta-path empurrado pelo nativo — `PY-E19`/`PKG-E17`; `lib_path` *gateia*
  `site`/SSL e tolera **modo mock** — `PY-E22`.
- **6 opcodes têm a `fn` remapeada no boot** — `IPC-E36`: o contrato é *ajustado* na inicialização. A versão
  vai no **nome do canal** (`-3.14`/`-3.3`) — `HOST-E4` —, mas os enums são **idênticos** entre versões —
  `IPC-E30`.

**Como o Arcane implementa.** Máquina de estados explícita por `ExtensionHost`, com **fila de eventos
pré-`ready`** (o análogo do *deferred load* de `PY-E28`) e replay **ordenado** — determinístico, ao contrário
da re-síntese observada. O handshake carrega API version + hash da tabela (§5).

```ts
type HostState = 'spawned' | 'handshaking' | 'ready' | 'draining' | 'dead';   // escolha nossa
host.handshake({ api: 1, opsHash: hashOf(OPS), caps: ['webgpu'] });          // falha ⇒ kill imediato
```

Ciclo de vida, auto-load e mock mode: `DEC-IPC-*` (`03`). Tabela de opcodes: §5 / `DEC-TR-5`.

**Armadilhas.**
- **Replay fora de ordem** de eventos pré-`ready`: o alvo *re-sintetiza* o hook (`PY-E28`) em vez de
  reproduzir; nós enfileiramos, reproduzimos na ordem e **testamos isso**.
- **Host que nunca fica `ready`** → timeout + *kill*; não herdar "pendura para sempre".
- **Mismatch de versão** deve falhar **cedo e alto** (hash no handshake), não virar crash misterioso no
  dispatcher.
- **Contrato posicional de argv** (`HOST-E11`, `HOST-U3`) é frágil: Arcane passa configuração **estruturada**
  (JSON/env), não 8 posições anônimas — escolha nossa.
- **Mock mode** (`PY-E22`) é capacidade real: *feature* de primeira classe nos testes do `ExtensionBridge`.

---

## 10. 🖥️ Síntese: quais padrões adotamos no editor-alvo

| # | Padrão | Componente Arcane | Verbo da adoção |
|---|---|---|---|
| 1 | Façade + handle opaco | `Buffer` / `DocumentHandle` / `DocumentRegistry` | **integral**, + geração no id |
| 2 | Observer/listener | `Buffer`→`Viewport`→`RenderPipeline` + hooks | **adoção**, com descarte obrigatório |
| 3 | Comando + undo agrupado | `CommandBus` / `TextStore` | **adoção**, delta inverso + transação |
| 4 | Work item + scheduler | `Scheduler` / `TaskPool` | **shape** (lane + item), sem refcount manual |
| 5 | Canal + dispatch numérico | `ExtensionBridge` / `ExtensionHost` | **adoção**, tabela **gerada** + CBOR |
| 6 | Sistema de propriedades | `PropertySystem` | **adoção**, schema tipado e camadas declaradas |
| 7 | Pipeline + backends plugáveis | `RenderPipeline` (`Canvas2D`/`WebGPU`) | **integral** (draw list) |
| 8 | Namespace + precedência | `PackageResolver` | **adoção**, precedência explícita |
| 9 | Handshake / ciclo de vida | `ExtensionHost` | **adoção**, FSM + replay ordenado |

**Leitura de conjunto:** os 9 padrões são **um só tema com 9 ângulos** — *"toda travessia de fronteira
precisa de identidade opaca, notificação e ciclo de vida declarado"*, i.e. **nada cruza fronteira sem
handle + evento + estado**.

---

## 11. 🧾 Rastreabilidade

**Decisões deste doc (`DEC-TR-*`):** `DEC-TR-1` handle opaco com geração · `DEC-TR-2` descarte/weak refs em
observers · `DEC-TR-3` undo por delta inverso + transação · `DEC-TR-4` escrita única + `Lifetime` em item
assíncrono · `DEC-TR-5` tabela de opcodes gerada + opcode desconhecido nunca silencioso + async por default ·
`DEC-TR-6` precedência de propriedades em camadas explícitas · `DEC-TR-7` fallback de backend declarado e
logado. As demais decisões pertencem a `01`–`05`.

| Padrão | Evidence IDs (alvo) | Incógnitas que **não** fecha | DEC | Docs |
|---|---|---|---|---|
| 1. Façade + handle opaco | `BUF-E1`,`BUF-E4`,`BUF-E5`; `PY-E1`,`PY-E3`,`PY-E4`,`PY-E5`,`PY-E6`,`PY-E8`,`PY-E32` | `PY-U6`, `BUF-U1` | `DEC-TR-1`, `DEC-BUF-*` | `01`, `03` |
| 2. Observer/listener | `BUF-E6`; `REN-E18`,`REN-E19`; `PY-E9`–`PY-E14` | `PY-U2`, `PY-U3` | `DEC-TR-2`, `DEC-IPC-*`, `DEC-REN-*` | `01`, `03`, `04` |
| 3. Comando + undo | `BUF-E8`–`BUF-E11`; `PY-E16`,`PY-E17`,`PY-E18`,`PY-E27` | `BUF-U3` | `DEC-TR-3`, `DEC-BUF-*` | `01` |
| 4. Work item + scheduler | `CON-E2`,`CON-E5`,`CON-E6`,`CON-E8`–`CON-E16` | `CON-U3`, `CON-U5` | `DEC-TR-4`, `DEC-CON-*` | `02` |
| 5. Canal + dispatch numérico | `IPC-E1`–`E14`, `IPC-E22`–`E36`; `HOST-E21`–`HOST-E26` | `IPC-U1`,`IPC-U4`,`IPC-U5`,`IPC-U6` | `DEC-TR-5`, `DEC-IPC-*` | `03` |
| 6. Sistema de propriedades | `REN-E23`,`REN-E24`,`REN-E26`,`REN-E27`; `CON-E18`; `PKG-E21`,`PKG-E22`; `PY-E5`,`PY-E29` | `CON-U6`, `PKG-U2` | `DEC-TR-6`, `DEC-REN-*`, `DEC-PKG-*` | `02`, `04`, `05` |
| 7. Pipeline + backends | `REN-E3`–`E5`, `REN-E7`, `REN-E9`–`E12`, `REN-E15`–`E17`, `REN-E21`–`E23`, `REN-E25`; `CON-E9`,`CON-E10` | `REN-U1`–`REN-U3`, `REN-U6` | `DEC-TR-7`, `DEC-REN-*`, `DEC-CON-*` | `04`, `02` |
| 8. Namespace + precedência | `PKG-E1`–`E5`, `PKG-E8`–`E10`, `PKG-E14`, `PKG-E17`–`E21` | `PKG-U2`,`PKG-U3`,`PKG-U4`,`PKG-U6`–`PKG-U8` | `DEC-PKG-*`, `DEC-TR-6` | `05` |
| 9. Handshake / ciclo de vida | `PY-E19`,`PY-E22`,`PY-E28`; `HOST-E3`,`HOST-E4`,`HOST-E11`; `IPC-E30`,`IPC-E36` | `HOST-U3` | `DEC-IPC-*`, `DEC-TR-5` | `03` |

> Nota clean-room: a coluna "Evidence IDs" é o **único** vínculo com o alvo; toda célula de decisão
> (`DEC-*`) é **nossa** e vive no doc dono (`01`–`05`), não no binário.

---

## 12. ⚠️ Padrões que **NÃO** adotamos (e por quê)

| Padrão no alvo | Evidence | Por que **não** copiamos |
|---|---|---|
| Item de trabalho com **refcount atômico manual** | `CON-E11` | Em TS/V8 não há `free` determinístico: **escopo de vida** (`Lifetime`/`AbortSignal`) é mais seguro que emular contagem (`CON-U3`). |
| **Composição de memória** de item/handle (`item+8`, `vtable+0x18`, `id & 3`) | `CON-E11`, `PY-E6`, `PY-U6` | É geometria de ABI. Em TS o id é opaco e o subtipo é **campo tipado**, não bits. |
| **Silêncio total** em opcode inválido/curto | `IPC-E24` | Esconde bug de protocolo. Mantemos *ignore* em prod, mas **erro alto em dev** + contador. |
| **Ids posicionais imutáveis** (reordenar ⇒ renumera o contrato) | `IPC-E27`, `IPC-E33` | Frágil para evoluir: geramos a tabela (como o alvo), mas com **faixas de namespace** e buracos reservados. |
| **Serialização binária artesanal** por operadores de stream | `IPC-E32` | CBOR/msgpack resolve, é inspecionável e não exige manter um par leitor/escritor por tipo. |
| Retenção de **objetos inteiros de listener** no núcleo | `PY-E9`, `PY-E10` | Fonte direta de leak e de "zumbi falando com documento morto": guardamos **ids** + descarte explícito (§2). |
| Listeners **duck-typed** onde hook ausente = exceção | `PY-E13` | `AttributeError` em produção por hook opcional é inaceitável: interface tipada com no-op. |
| **Command Palette por heurística de exceção** | `PY-E18` | Substituído por contrato tipado (`canAcceptInput()`), sem `try/catch` como fluxo de controle. |
| **Modal sem fallback** quando o GL falha | `REN-E25`, `REN-U3` | Preferimos **fallback declarado + aviso** (§7, `DEC-TR-7`): degradar é melhor que bloquear. |
| **Constantes de tuning hardcoded** (8192/128, supersample 8×, feather, `0x7ff80`) | `REN-E7`, `REN-E13`, `IPC-E9` | São medições do alvo. Viram **props medidas** por plataforma, com benchmark. |
| **Contrato posicional de 8 argumentos** de CLI do host | `HOST-E11`, `HOST-U3` | Config estruturada (JSON/env) é auto-documentada e versionável; 8 posições anônimas não. |
| **ZIP sem manifesto** de pacote | `PKG-E2`, `PKG-U6` | Mantemos ZIP (compatível com o ecossistema), mas com **manifesto mínimo** (nome/versão/engines). |
| **Precedência implícita** entre raízes e camadas | `PKG-U2`, `PKG-U3` | Indocumentável e não testável: declaramos a ordem (§8) e cobrimos com teste por camada. |
| **Deteção de tipo de recurso por sufixo espalhado** no código | `PKG-E5` | Tabela **gerada** de extensão → tipo de recurso, num único ponto. |
| **Cache de bytecode em ZIP / `__pycache__` externo** | `PKG-E18` | Sem análogo útil em JS/TS (o V8 já cacheia); replicar só adicionaria uma camada de invalidação. |
| Representação **UTF-32 com SSO** do texto | `BUF-E12`, `BUF-U2` | Detalhe de implementação do `TextStore` do alvo; a escolha do nosso é de `01` (`DEC-BUF-*`). |
