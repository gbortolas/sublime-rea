# 01 · Buffer & edição — `TextStore` segmentado sob uma façade observável

> Fase 2 (P2.1) · síntese clean-room do alvo (sha256 8b105b18…43d92) · insumo: evidence-index.md · 2026-10-16

**Achado central (1 frase):** o alvo modela o texto como um **núcleo anônimo segmentado** (múltiplos
buffers de heap + array de registros) atrás de uma **façade observável** (`TextBuffer`), aplica
mutações por **comandos delta** e agrupa o undo por **grupos "colados" (glue)** — o que nos dá um
esqueleto claro de *storage* + *façade* + *comando* + *grupo de undo*, ainda que a topologia exata do
storage permaneça `[DESCONHECIDO]` (`BUF-U1`).

Este documento traduz a evidência da Fase 1 (P1.1 + o recorte de handles/comandos de P1 API de
plugins) em **decisões de arquitetura** para o editor-alvo **Scribe**, que roda em
**Electron + TypeScript** (main Node, renderer Chromium, `worker_threads`).
Nada aqui transcreve implementação do alvo: só **nomes, contagens, tamanhos, offsets e papel**.

---

## 1. 🎯 O padrão observado (o quê)

**O buffer é uma façade sobre um núcleo anônimo.** A classe **`TextBuffer`** (global, sem namespace)
é o modelo do buffer, acompanhada de `TextBufferView` (view) e `TextBufferSelection` (regiões)
`[OBSERVADO]` (`BUF-E1`). O construtor monta a façade e **aloca um objeto interno de `0x108` bytes**
que é o verdadeiro dono do texto `[OBSERVADO]` (`BUF-E4`).

**O núcleo é segmentado, não contíguo.** Uma rotina de *reset* zera **11 pares `{begin,end}`**
(passo `0x18`) — o núcleo contém **vários buffers/vetores de heap independentes** — e o destrutor
libera *buffers de heap* + um **array de registros de `0x20` bytes** `[OBSERVADO]` (`BUF-E7`,
`BUF-E5`). A combinação *(múltiplos buffers crescentes) + (array de registros) + (capacidade default
`0x1000`) + (ausência de nós/recursão)* aponta para a **família piece-table/segmentado** `[INFERIDO]`
— explicitamente **sem** Gap Buffer e **sem** Rope: nenhuma classe
`Piece`/`Rope`/`GapBuffer`/`LineIndex` existe no inventário de strings `[OBSERVADO]` (`BUF-E2`).

**Edição é delta por comando nomeado.** As mutações são **objetos-comando** derivados de
`text_command` — `insert_command`, `append_command`, `overwrite_command`, `left_delete_command`,
`right_delete_command`, `delete_word_command` — cada um com **nome** e **descrição** legíveis ao
usuário `[OBSERVADO]` (`BUF-E8`). Cada mudança aplicada é um objeto próprio (`0x68` B) com um
sub-array de registros de `0xa8` B `[OBSERVADO]` (`BUF-E11`).

**Undo é por grupos, com "glue" e variante "soft".** Vocabulário explícito: `undo_stack`,
`redo_stack`, `glue_marked_undo_groups`, `soft_undo`/`soft_redo` `[OBSERVADO]` (`BUF-E9`). O estado
vive em três containers de grupos (undo/redo/pending) + contador de **aninhamento**, e limpar a
pilha durante a execução de um comando é **bloqueado** `[OBSERVADO]` (`BUF-E10`).

**Linha por varredura com cache, não por índice.** Não há classe de índice de linhas; a
contagem/posição é obtida por **scan com cache**, marcado por **sentinelas `-1`** gravadas no
próprio buffer ("último ponto/linha calculados") `[OBSERVADO]` (observação de `buffer-structure.md`
§4 — o ledger da Fase 1 **não tem** `BUF-E` dedicada para este item; a incógnita de granularidade é
`BUF-U4`).

**Identidade por handle opaco.** Do lado dos plugins, buffers/views são endereçados por **handles
opacos** (ids numéricos) com *liveness* delegada ao nativo `[OBSERVADO]` (`PY-E4`): o Python nunca vê
ponteiro nem objeto C++ — só um `int`.

---

## 2. 🧩 Estrutura & invariantes (com Evidence IDs)

**Invariante 1 — separação façade/núcleo.** O objeto observável (`TextBuffer`) é distinto do storage;
o storage é anônimo e acessado por offset (`BUF+0x250`) `[OBSERVADO]` (`BUF-E4`). Consequência: a
fronteira precisa ser **explícita no tipo**, não por offset. O núcleo **não** é exportado (DEC-BUF-2).

**Invariante 2 — multiplicidade de segmentos.** Não existe "o buffer de texto"; existem **≥2
buffers de heap** mais uma tabela de registros que os indexa `[OBSERVADO]`/`[INFERIDO]`
(`BUF-E7`, `BUF-E5`, `BUF-U1`). Consequência: qualquer operação de leitura é *random access por
mapeamento de span*, não *ponteiro + offset*.

**Invariante 3 — observabilidade acoplada ao modelo.** O núcleo embute um subobjeto `observer`
(vptr próprio) `[OBSERVADO]` (`BUF-E6`): quem muda o texto notifica listeners **do modelo**, não da
view. Consequência: `Buffer` é a fonte de eventos de mudança.

**Invariante 4 — mudança é um valor.** Cada edição materializa um objeto de mudança (`0x68` B) com
registros internos (`0xa8` B) `[OBSERVADO]` (`BUF-E11`). Consequência: a unidade transacional é um
**delta serializável**, reutilizável por undo, por IPC e por listeners.

**Invariante 5 — agrupamento com aninhamento.** Existe um contador de aninhamento (`+0x4d0`):
abrir/fechar grupos é **reentrante**, e o grupo só consolida quando o contador zera; limpar a pilha
com aninhamento ativo **aborta** `[OBSERVADO]` (`BUF-E10`). Consequência: undo é *seguro contra
limpeza* durante a execução de um comando — semântica que precisamos preservar.

**Invariante 6 — comandos são cidadãos de primeira classe.** Todo caminho de edição passa por um
comando com **nome estável + descrição** (`"insert"` / `"Insert Characters"`) `[OBSERVADO]`
(`BUF-E8`), e comandos de plugin trafegam como **tuplas `(instância, nome)`** `[OBSERVADO]`
(`PY-E16`). Consequência: o nome do comando é contrato (keybinding, palette, macro, undo label).

**Invariante 7 — strings internas UTF-32/SSO.** O tipo de string do núcleo é **UTF-32 com
short-string-optimization** (4 B/char) `[OBSERVADO]` (`BUF-E12`) — mas se o **corpo do documento**
usa o mesmo tipo ou bytes UTF-8 é `[DESCONHECIDO]` (`BUF-U2`). Consequência: **não** herdamos a
codificação; herdamos a ideia de que *strings internas e corpo do documento podem ter
representações distintas*.

> **Nota de ortografia.** O acoplamento do alvo a `SpellingListener` chega por **herança múltipla**
> (`__vmi`, 2 bases; `BUF-E3`) e a base #1 segue não nomeada (`BUF-U5`) — nós usamos composição (§5, D1).

---

## 3. 🖥️ Decisões de arquitetura para o editor-alvo

Componentes do Scribe referidos aqui: **`Buffer`** (façade pública), **`TextStore`** (estrutura
interna segmentada), **`DocumentRegistry`** (buffers abertos + handles opacos), **`DocumentHandle`**
(id numérico opaco), **`CommandBus`** (comandos nomeados + agrupamento de undo), **`Scheduler`**,
**`TaskPool`**, **`PropertySystem`**.

### DEC-BUF-1 — `TextStore` é uma piece-table/segmentada, e o layout do alvo **não** é espelhado
**Decisão.** Implementar `TextStore` como **piece-table** com dois buffers monotônicos (`original`
só-leitura + `add` append-only) e a **tabela de spans** como única fonte de verdade da ordem do
documento. **Escolha nossa (não observada no alvo):** o alvo tem **11 pares `{begin,end}`** e um
array de registros de `0x20` B — nós usamos **um** buffer `original`, **um** buffer `add` e **uma**
tabela de spans (podendo ser piece-tree depois, sem mudar a API).
**Racional.** O alvo é *segmentado* e não contíguo (`BUF-E7`, `BUF-E5`), mas a semântica de cada um
dos 11 vetores é `[DESCONHECIDO]` (`BUF-U1`): espelhar 11 vetores seria copiar topologia inventada.
A piece-table preserva as duas propriedades que a evidência sustenta — **insert/remove O(1)
amortizado em `add`** e **imutabilidade dos trechos antigos** (pré-requisito para deltas baratos e
undo sem snapshot). Gap Buffer/Rope estão descartados por evidência negativa (`BUF-E2`).
**Evidência.** `BUF-E2`, `BUF-E4`, `BUF-E5`, `BUF-E7`, `BUF-U1`.

### DEC-BUF-2 — `Buffer` (façade) + `TextStore` (núcleo anônimo) + evento de mudança no modelo
**Decisão.** `Buffer` é a **façade observável** (API pública, eventos, metadados, dirty flag); o
corpo do documento vive em `TextStore`, que **não** é exportado fora do módulo de buffer. Listeners
de mudança são registrados em `Buffer` e recebem **deltas**, não o texto inteiro.
**Racional.** O alvo separa objeto público (`TextBuffer`) de núcleo anônimo alocado no construtor
(`BUF-E4`) e acopla o padrão **observer ao núcleo**, não à view (`BUF-E6`). Em TS a separação é
ainda mais barata (módulo + tipo não exportado) e evita que plugins/view façam bypass do undo.
**Evidência.** `BUF-E1`, `BUF-E4`, `BUF-E6`.

### DEC-BUF-3 — Toda mutação é um **comando delta** com nome/descrição estáveis
**Decisão.** O `CommandBus` expõe comandos nomeados (`insert`, `append`, `overwrite`, `left_delete`,
`right_delete`, `delete_word`, `select_all`, `invert_selection`) e cada execução emite um
`TextDelta { from, removed, inserted }`. Comando e delta são **coisas distintas**: o comando é a
intenção (nome + args + política de agrupamento), o delta é o fato.
**Racional.** No alvo os comandos carregam **nome + descrição** legíveis e são a única via de
mutação (`BUF-E8`); a mudança aplicada é um objeto próprio `0x68`/`0xa8` (`BUF-E11`). Separar
intenção (comando) de efeito (`TextDelta`) é o que permite **undo por delta, macro, IPC de plugin e
preview de formatter** sem duplicar caminhos de escrita. **Escolha nossa:** `TextDelta` explícito
(o alvo só o expõe implicitamente, via o objeto de mudança).
**Evidência.** `BUF-E8`, `BUF-E11`.

### DEC-BUF-4 — Undo por **grupos com aninhamento**, "glue" e variantes *soft*
**Decisão.** O histórico é uma pilha de **grupos de deltas**; abrir/fechar grupo é **reentrante**
(contador de aninhamento) e só consolida em zero. Grupos consecutivos podem ser **"colados"
(glue)** num único passo; `soft_undo`/`soft_redo` operam **por delta**, não por grupo. Limpar a
pilha com aninhamento ativo **falha com erro tipado** (`UndoStackBusyError`) em vez de silenciar.
**Racional.** Todo o vocabulário do alvo é esse (`undo_stack`, `redo_stack`,
`mark/unmark/maybe_mark_undo_groups_for_gluing`, `glue_marked_undo_groups`, `soft_undo/soft_redo`)
`[OBSERVADO]` (`BUF-E9`), e o bloqueio da limpeza é explícito (`BUF-E10`). Aninhamento torna o
agrupamento **componível** quando um comando de plugin chama outros comandos: o grupo externo funde
tudo num único passo de undo.
**Evidência.** `BUF-E9`, `BUF-E10`, `BUF-E11`.

### DEC-BUF-5 — Linha por **scan com cache**, sem índice persistente (por ora)
**Decisão.** `Buffer` calcula `lineCount`/`offsetAtLine`/`lineAt` por **varredura de spans com cache
do último ponto visitado** (sentinela `-1` → "não calculado"), invalidado ao primeiro delta que
cruzamos. **Sem** árvore de linhas persistente na v1.
**Racional.** O alvo **não tem** classe de índice de linhas (`BUF-E2`), e o cache é inferido por
sentinela `-1` no buffer — "último ponto/linha calculados" (observação `buffer-structure.md` §4).
A granularidade do cache e o custo assintótico são `[DESCONHECIDO]` (`BUF-U4`), então a v1 fica no
modelo mais simples observável e marca o índice persistente como **revisita por benchmark**.
**Evidência.** `BUF-E2`; observação de §4 do doc-fonte; `BUF-U4`.

### DEC-BUF-6 — `DocumentHandle` opaco + `DocumentRegistry` como único mapa id→`Buffer`
**Decisão.** Fora do processo de buffer, um documento é um **`DocumentHandle` numérico opaco**.
O `DocumentRegistry` (main) mantém `handle → Buffer` e responde `isValid(handle)`. Handles são
**monotônicos e nunca reciclados** na v1; encerrar um documento invalida o handle para sempre.
**Racional.** Do lado de plugins o alvo só expõe handles opacos com *liveness* delegada ao nativo
`[OBSERVADO]` (`PY-E4`), e ids ainda carregam bits de **subtipo** (`& 3` para despachar tipo)
`[OBSERVADO]` (`PY-E6`). Não reciclar id é **escolha nossa (não observada no alvo)**: elimina a
classe de bugs "use-after-free lógico" (handle velho apontando para buffer novo).
**Evidência.** `PY-E4`, `PY-E6`.

### DEC-BUF-7 — Comandos de plugin entram como **`(instance, name)`** no `CommandBus`
**Decisão.** O `CommandBus` aceita, além dos comandos nativos, comandos de extensão no formato
**tupla `(instância, nome)`**, resolvidos pelo `ExtensionHost` via `ExtensionBridge`. A ordem de
resolução é: comando de plugin (`on_text_command`) → comando nativo; e um comando de plugin pode
**vetar/substituir** o nativo.
**Racional.** É literalmente como o alvo trafega comandos entre host e Python `[OBSERVADO]`
(`PY-E16`), e o alvo dá a comandos um **nome estável** como contrato externo (`BUF-E8`). Mesmo
shape ⇒ keybinding, palette e macro não sabem se o comando é nativo ou de terceiro.
**Evidência.** `BUF-E8`, `PY-E16`.

### DEC-BUF-8 — Escopo de edição do host via **`EditScope`** (token aberto/fechado)
**Decisão.** O `CommandBus` abre um **`EditScope`** antes de invocar handlers de extensão e o fecha
ao final; um `EditScope` é **exatamente** o aninhamento de grupo de undo (DEC-BUF-4). O
`ExtensionBridge` só encaminha o token opaco; **o token não é texto nem permissão**.
**Racional.** O alvo abre/fecha um **edit token** no host (`run_(edit_token, args)`) e o Python o
devolve nas chamadas de edição `[OBSERVADO]` (`PY-E17`). Reaproveitar o **mesmo** mecanismo de
escopo para (a) agrupar undo e (b) autorizar edição remove uma dimensão de estado paralelo —
"edição de plugin" vira apenas "edição dentro de um escopo aberto".
**Evidência.** `PY-E17`, `BUF-E10`, `BUF-E9`.

### DEC-BUF-9 — Offsets em **code units UTF-16** e storage em chunks JS, com ponte de codificação
**Decisão.** O storage de `TextStore` guarda trechos como **strings TS (`string`, UTF-16 nativo)** e
os offsets públicos são **code units UTF-16** (`TextDelta.from`). Encoding de arquivo (UTF-8 etc.)
é resolvido na **borda de I/O**; conversão para pontos de código fica em helpers explícitos
(`utf16ToCodePoints`, `codePointsToUtf16`). **Escolha nossa (não observada no alvo).**
**Racional.** O alvo usa **UTF-32 com SSO** nas strings internas `[OBSERVADO]` (`BUF-E12`), mas se
o **corpo do documento** segue o mesmo tipo é `[DESCONHECIDO]` (`BUF-U2`) — logo não há ganho em
imitar UTF-32 "por fidelidade". Em Electron o texto chega e sai como `string` (UTF-16) em todo
lugar (DOM, IPC do renderer, `TextEncoder`). O custo aceito: código fora do BMP ocupa 2 code units.
**Evidência.** `BUF-E12`, `BUF-U2`.

### DEC-BUF-10 — Mutação do documento é **serializada por documento**; scan vai ao `TaskPool`
**Decisão.** Toda mutação de um `Buffer` é executada no **`Scheduler`** (fila por documento, FCFS),
garantindo ordem total de deltas e um único escritor por buffer. Cálculos **read-only** caros
(contagem de linha em arquivo grande, dobra/agrupamento de undo histórico) vão ao **`TaskPool`**
(`worker_threads`) com um **snapshot do `TextStore` relevante + o revision number**, e o resultado
só é aplicado em `Buffer` se a revisão não mudou.
**Racional.** O alvo tem **contador de revisão** por buffer (incrementado ao abrir grupo)
`[INFERIDO]` (`buffer-structure.md` §5) e undo reentrante — o núcleo assume **ordem** nas mutações.
"Single writer por documento" é a forma mais barata de não ter corrida em undo. A parte de
paralelismo é **escolha nossa**: restringimos paralelismo a **leitura** (`TaskPool`).
**Evidência.** `BUF-E10`, `BUF-E11`; contexto de concorrência em `concurrency.md`.

---

## 4. 📐 Contratos TypeScript (interfaces/assinaturas do NOSSO código)

```ts
/** Ponto de entrada público: o "Buffer" do Scribe. */
export interface Buffer {
  readonly handle: DocumentHandle;
  readonly revision: number;            // DEC-BUF-10 — validade de resultado assíncrono
  text(): string;                       // materializa o documento a partir dos spans
  lineCount(): number;                  // DEC-BUF-5 — scan com cache
  offsetAtLine(line: number): number;
  lineAt(offset: number): number;
  apply(delta: TextDelta, origin: EditOrigin): void;
  onDidChange(cb: (e: TextDeltaEvent) => void): Disposable;
}
```

```ts
/** Id opaco; nunca um ponteiro, nunca reciclado na v1 (DEC-BUF-6). */
export type DocumentHandle = number & { readonly __opaque: unique symbol };

/** Unidade transacional da edição: fato, não intenção (DEC-BUF-3). */
export interface TextDelta {
  readonly from: number;                // code units UTF-16 (DEC-BUF-9)
  readonly removed: string;
  readonly inserted: string;
}
export interface TextDeltaEvent { readonly delta: TextDelta; readonly revision: number; }
export type EditOrigin = "user" | "plugin" | "external" | "undo";
```

```ts
/** Comandos nomeados + agrupamento de undo (DEC-BUF-3, DEC-BUF-4, DEC-BUF-8).
 *  **Canônico**: os demais docs referenciam este contrato (não o redefinem). */
export interface CommandBus {
  register(name: string, description: string, run: CommandHandler): Disposable;
  /** Executa por nome (keymap/menu/macro/plugin); `group` = unidade de undo. */
  run(name: string, args?: unknown, opts?: { group?: string; origin?: EditOrigin }): Promise<CommandResult>;
  /** Comandos de extensão: tupla (instância, nome) — DEC-BUF-7. */
  dispatch(ref: NativeCommand | ExtensionCommandRef, args?: unknown): Promise<void>;
  subscribe<T extends EditorEvent>(type: T["type"], cb: (e: T) => void): Disposable;
  openEditScope(reason: string): EditScope;   // contador de aninhamento
  glueMarkedGroups(): void;
  softUndo(): void; softRedo(): void;
}
export interface ExtensionCommandRef { readonly instance: unknown; readonly name: string; }
export interface EditScope extends Disposable { readonly id: number; }
```

```ts
/** Registry de documentos abertos — o único mapa handle→Buffer (DEC-BUF-6). */
export interface DocumentRegistry {
  create(uri: string, text?: string): Buffer;
  resolve(handle: DocumentHandle): Buffer | undefined;
  isValid(handle: DocumentHandle): boolean;
  dispose(handle: DocumentHandle): void;
}
```

```ts
/** Núcleo anônimo: piece-table com dois buffers + tabela de spans (DEC-BUF-1). Não exportado. */
interface TextStore {
  readonly length: number;
  slice(from: number, to: number): string;
  replace(from: number, to: number, inserted: string): void;
  flushChunk(): void;                   // consolida o buffer `add` (política nossa)
}
```

---

## 5. 🔀 Divergências deliberadas (onde NÃO seguimos o alvo, e por quê)

| # | Alvo `[OBSERVADO]` | Scribe | Por quê |
|---|---|---|---|
| D1 | Herança múltipla: **2 vptrs**, `__vmi` com `SpellingListener` + base virtual (`BUF-E3`) | **Composição**: `SpellingService` e colaboradores injetados no `Buffer` | Sem vtable em TS; base #1 do alvo é `BUF-U5`. Herança não traz benefício arquitetural — só acoplamento. |
| D2 | **11 pares `{begin,end}`** + array de registros `0x20` B (`BUF-E7`, `BUF-E5`) | **1** buffer `original` + **1** `add` + **1** tabela de spans | Semântica dos 11 vetores é `[DESCONHECIDO]` (`BUF-U1`); espelhar topologia inventada violaria o clean-room. |
| D3 | Strings internas **UTF-32 + SSO** (`BUF-E12`) | `string` JS (UTF-16) com ponte de codificação na borda (`BUF-U2`) | Zero conversão em DOM/IPC do renderer; ver DEC-BUF-9. |
| D4 | `clear_undo_stack` durante comando: **aborta com mensagem** (`BUF-E10`) | **erro tipado** `UndoStackBusyError`, testável | Mensagem de erro não é contrato; tipo de erro é. |
| D5 | Mudança é objeto **opaco** de `0x68` B com registros `0xa8` B (`BUF-E11`) | **`TextDelta`** com campos nomeados e serializáveis | Seriais para undo-macro e IPC; conteúdo do `0xa8` é `[DESCONHECIDO]` (`BUF-U3`). |
| D6 | Handles com **reciclagem/colisão** (§ `[DESCONHECIDO]` em `PY-E4`) | handles **monotônicos, nunca reciclados** | Elimina *use-after-free* lógico de handle velho. Puramente nossa (DEC-BUF-6). |
| D7 | Núcleo embute `TokenStorage`/`LayoutTracker` no mesmo objeto (`BUF-E4`, `BUF-E6`) | **`TextStore` não conhece tokens**; highlight é consumidor via `RenderPipeline`/`TaskPool` | Storage de texto e cache de sintaxe têm ciclos de vida e threads diferentes. |
| D8 | Tudo no processo nativo, mutação no main thread GTK | Mutação no **`Scheduler`** (main); scan no **`TaskPool`** | Electron não tem GTK main loop; ver DEC-BUF-10. |

---

## 6. 🧾 Rastreabilidade (Conclusão ← Evidence IDs → DEC → Status)

| # | Conclusão de origem (Evidence IDs) | DEC | Status |
|---|---|---|---|
| 1 | `TextBuffer` façade + núcleo anônimo `0x108` (`BUF-E4`) | DEC-BUF-2 | ✅ definida |
| 2 | `observer` embutido no núcleo; notificação no modelo (`BUF-E6`) | DEC-BUF-2 | ✅ definida |
| 3 | Múltiplos buffers de heap + array `0x20`; 11 pares `{begin,end}` (`BUF-E7`, `BUF-E5`) | DEC-BUF-1 | ✅ definida (topologia própria) |
| 4 | Sem `Piece`/`Rope`/`GapBuffer` nomeados (`BUF-E2`) | DEC-BUF-1, DEC-BUF-5 | ✅ definida |
| 5 | Comandos `insert/append/overwrite/delete_*` com nome+descrição (`BUF-E8`) | DEC-BUF-3, DEC-BUF-7 | ✅ definida |
| 6 | Mudança `0x68` B + registros `0xa8` B (`BUF-E11`) | DEC-BUF-3 | ✅ definida (campos próprios) |
| 7 | Undo/redo/grupos/glue/soft (`BUF-E9`) | DEC-BUF-4 | ✅ definida |
| 8 | Aninhamento `+0x4d0`; limpeza proibida durante comando (`BUF-E10`) | DEC-BUF-4, DEC-BUF-8 | ✅ definida |
| 9 | Linha por scan com cache (sentinela `-1`; §4 do doc-fonte) | DEC-BUF-5 | 🟡 provisória (revisitar por benchmark — `BUF-U4`) |
| 10 | Strings internas UTF-32/SSO (`BUF-E12`) | DEC-BUF-9, D3 | ✅ definida (representação diverge) |
| 11 | Handles opacos + id `& 3` por subtipo (`PY-E4`, `PY-E6`) | DEC-BUF-6 | ✅ definida (sem reciclagem) |
| 12 | Comandos como tuplas `(instância, nome)` (`PY-E16`) | DEC-BUF-7 | ✅ definida |
| 13 | Edit token aberto/fechado pelo host (`PY-E17`) | DEC-BUF-8 | ✅ definida |
| 14 | Ordem/reentrância nas mutações (contexto `buffer-structure.md` §5) | DEC-BUF-10 | ✅ definida |

Legenda: ✅ definida · 🟡 provisória (depende de incógnita/benchmark).

---

## 7. ⚠️ Incógnitas que afetam este módulo (refs `BUF-U*`)

| ID | Incógnita | Impacto no Scribe | O que fecharia |
|---|---|---|---|
| `BUF-U1` | Nome canônico/topologia da estrutura de texto; semântica dos 11 vetores e dos registros `0x20` B; UTF-8 vs UTF-32 no corpo | **Médio** — não afeta a API (`Buffer`/`TextDelta`), afeta o desempenho do `TextStore` | Struct do alvo (DWARF/símbolos) + benchmark de insert no meio de arquivo grande |
| `BUF-U2` | Se o corpo do documento usa UTF-32/SSO ou UTF-8 | **Baixo** — DEC-BUF-9 já assume UTF-16 com ponte | Medir tipo no corpo (retorna a `BUF-E12`) |
| `BUF-U3` | Composição do registro `0xa8` B da mudança | **Baixo** — só interessa se quiséssemos serializar deltas como o alvo | Tipo/struct do registro |
| `BUF-U4` | Granularidade do cache de linha e custo assintótico em buffers grandes | **Alto** — decide se DEC-BUF-5 vira índice persistente | Benchmark de scan/contagem sobre arquivos grandes |
| `BUF-U5` | Base #1 (virtual) do `__vmi` de `TextBuffer` não nomeada | **Nulo** — D1 já evita herança múltipla | RTTI/xref adicional no alvo |

**Impacto `BUF-U4` — plano.** Instrumentar `lineCount()`/`lineAt()` com harness de benchmark
(10 MB single-line, 10 MB multi-line, 1 M linhas) e só então decidir entre *cache de sentinela* e
**índice de linhas incremental**. O contrato público (`Buffer`) não muda em nenhum dos casos.

**Nota de estado.** No alvo os handles carregam **2 bits de subtipo** (`PY-E6`); no Scribe, a
classificação (buffer/view/sheet) fica no `DocumentRegistry` + `PropertySystem`, **não** no id.
