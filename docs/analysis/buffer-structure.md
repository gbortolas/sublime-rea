# Estrutura de buffer do núcleo nativo — P1.1 🧱

> **Entregável:** P1.1 — qual estrutura de dados o núcleo (C++) usa para o texto do buffer,
> e **como** ele faz insert/remove, indexação de linha e undo/redo. Alvo: o executável
> ELF64 x86-64 PIE **stripped** `target/sublime_text/sublime_text`
> (`sha256 8b105b1839d7809f60ec186b6c6dcb2d107e22ad23f42c5f8ba7dec67ab43d92`).
> **Regime clean-room:** só **nomes, assinaturas, contagens, tamanhos e papel arquitetural** —
> nenhum bloco de implementação do alvo é transcrito. Todo endereço é do espaço default do
> Ghidra (image base `0x100000`; `.text` `0x415120–0xa1e0c9`, `.rodata` `0x1ced80–0x2cb5bd`,
> `.data.rel.ro` `0xa21a00–0xa6c818`). Provider: `ghidra 12.1.4` (auto-análise completa).
> **Convenção:** cada afirmação é rotulada **[OBSERVADO]**, **[INFERIDO]** ou **[DESCONHECIDO]**.

**Achado central (1 frase):** o buffer é a classe C++ **`TextBuffer`** (namespace global; ~2,4 KB de
objeto) que atua como **facade** e delega o texto a um **objeto interno anônimo** (alocado no
construtor, `0x108` bytes) que guarda **buffers de heap crescentes + um índice de registros**;
as mutações são aplicadas por **comandos delta** (`insert_command`/`…_delete_command`) sob um
**modelo de undo por grupos** — ou seja, **não** há evidência de Gap Buffer contíguo nem de
Rope com nós; o padrão observado é compatível com a **família piece-table/segmentado
[INFERIDO]**.

---

## 1. 🔎 Escopo e método

Coleta **summary-first** via MCP `rea` sobre o alvo já analisado (aberto **uma única vez**):

| Passo | Ferramenta | Saída usada |
|---|---|---|
| strings RTTI/nomes | `search_strings` (literal/regex) | nomes de classe, comandos, settings |
| tipos/vtables | `read_bytes` + `xrefs` + `inspect_native_data_type` | typeinfo objects, vtables, layout |
| fluxo | `procedure_callers/callees`, `batch_decompile`, `procedure_pseudo_code` | papel de construtor/destrutor/undo |
| tipos internos | `inspect_native_data_type` | (ver §6 — não recuperados) |

O binário é **stripped** (sem `.symtab`); os nomes de classe sobrevivem apenas como **type
descriptors de RTTI (Itanium ABI)** em `.rodata`, no formato `<len><nome>` (ex.: `10TextBuffer`).
Ghidra **não** recuperou vftables nomeadas (`PTR_FUN_<addr>`, `FUN_<addr>`) — o pareamento
classe→vtable foi feito à mão via typeinfo (§3.1).

---

## 2. 🧩 Estrutura de dados

### 2.1 Classes observadas (RTTI, `.rodata`)

| Nome (RTTI) | Endereço | Papel arquitetural |
|---|---|---|
| `TextBuffer` | `0x25c02b` | **modelo do buffer** (o "Buffer" do núcleo) |
| `TextBufferSelection` | `0x25c0f5` | seleção/regiões associadas ao buffer |
| `TextBufferView` | `0x25c119` | **view** sobre um `TextBuffer` |
| `SyntaxLoader` / `SpellingListener` / `SpellChecker` | `0x25c001` / `0x25c038` / `0x25c054` | colaboradores (sintaxe/ortografia) |
| `TokenStorage : LayoutTracker` | `0x2c7cc4` / `0x2c7cd3` | armazenamento de **tokens de sintaxe** (não o texto) |

**[OBSERVADO]** — `TextBuffer` é classe **global** (sem namespace: o type-name mangled não tem
`N…E`) e tem **duas vptrs** em `+0x00` e `+0x08` → herança múltipla. O `__vmi_class_type_info`
do tipo (`0xa5cbe0`) declara `__base_count = 2`: base nº 0 = `SpellingListener`
(typeinfo `0xa5cbd0`, offset 0) e base nº 1 = base **virtual** (typeinfo `0xa6b368`, vtable-offset 8).

### 2.2 Busca negativa (limitada) por nomes de estrutura

Termos procurados como **type-name** e **strings** de `.rodata` (case-insensitive):

| Termo | Ocorrências como classe/estrutura |
|---|---|
| `Piece` | **0** (nenhum) |
| `GapBuffer` / `gap buffer` | **0** |
| `Rope` / `RopeNode` | **0** (só `…property…`, substring irrelevante) |
| `LineIndex` | **0** |
| `text_storage` / `text_change` / `spans` | **0** |
| `Buffer` (como classe) | só `TextBuffer`, `TextBufferView`, `TextBufferSelection` (+ `BufferSource`, `Sk*Buffer` = Skia/libssh) |

> **[OBSERVADO] (negativo *bounded*):** *dentro do inventário de strings tipadas pelo Ghidra* não
> existe nenhuma classe chamada `*Piece*`, `*Rope*`, `*GapBuffer*` ou `*LineIndex*`. Isto **não
> prova** ausência do algoritmo — só que ele **não recebeu nome RTTI**. A representação de texto
> é, portanto, **anônima** (struct/impl interna ou embutida no `TextBuffer`).

### 2.3 O objeto interno do buffer (alocado no construtor)

**[OBSERVADO]** — o construtor `FUN_0048f29c` (`0x48f29c`, 1530 B) monta o `TextBuffer` e
**`new(0x108)`** um objeto interno guardado em `TextBuffer+0x250` (`param_1[0x4a]`). Esse objeto:

- embute um subobjeto **`observer`** (typeinfo `0xa46c48`, nome `8observer`) com vptr
  `0xa46c20` → **padrão observer** (o buffer notifica listeners);
- foi inicializado com **pares de campos `0x1000`** (4096) em duas regiões distintas;
- é destruído por `FUN_004cb9a2` (`reset`/`clear`, `0x4cb9a2`) → para os **vetores internos**,
  `FUN_004cbb76` → **array de registros de `0x20` bytes** (cada registro dono de um buffer de
  heap, `free`), `FUN_0049d8ee` → buffer de heap, e `free` direto de outro buffer de heap.

**[OBSERVADO]** — uma rotina de "reset" (`FUN_008f5c88`, `0x8f5c88`) zera, de uma só vez, **11
pares `{begin,end}` consecutivos** (passo `0x18`) de um objeto interno — ou seja, o objeto do
buffer contém **múltiplos buffers/vetores de heap independentes**, não um único bloco contíguo.

**[INFERIDO]** — a combinação *(a)* múltiplos buffers de heap crescentes, *(b)* um **array de
registros de tamanho fixo** (`0x20` B) que indexa dados, *(c)* capacidade default **`0x1000`
(4 KB)** e *(d)* ausência de estrutura de nós/recursão é o **padrão de uma tabela de peças
("piece table") ou buffer segmentado**: tipicamente um **buffer "original"** + um **buffer
"add"** (edições acumuladas) + uma **lista de spans** que aponta para trechos de um dos dois.
**Contra-indicação a Gap Buffer:** um Gap Buffer canônico é **um** buffer contíguo com lacuna —
aqui há **vários** buffers de heap. **Contra-indicação a Rope:** nenhuma classe/nó de rope e
nenhum `RopeNode` (negativo §2.2).

**[DESCONHECIDO]** — o nome canônico e a topologia exata (piece-table simples, piece-**tree**,
ou "chunk list"); o mapeamento semântico dos 11 vetores e dos registros de `0x20` B; se o texto
é mantido em **UTF-8** ou **UTF-32** na representação principal.

### 2.4 Strings internas

**[OBSERVADO]** — o tipo de string usado em várias partes do núcleo é **UTF-32** (4 bytes/code
point) com **SSO** (short-string-optimization para < 5 chars, senão heap): rotina `FUN_0046ba2c`
(`0x46ba2c`) copia `n*4` bytes e escreve 4 bytes `\0`; `FUN_0067273c` mede o comprimento varrendo
`int` até 0. É o tipo usado, p.ex., em `word_separators`.
**[DESCONHECIDO]** — se o **corpo do documento** compartilha esse tipo ou usa bytes UTF-8.

---

## 3. ✂️ Insert / Remove

### 3.1 Como os comandos de edição são modelados

**[OBSERVADO]** — as mutações são **objetos-comando** derivados de `text_command`
(`0x25c301`), com hierarquia RTTI explícita em `.data.rel.ro` (typeinfo dos `…_command`):

| Comando (RTTI) | Endereço | Papel |
|---|---|---|
| `text_command` | `0x25c301` | base dos comandos de edição de texto |
| `bound_text_command` | `0x25c4e1` | comando ligado a um `TextBufferView` |
| `insert_command` | `0x25c2f0` | inserir texto |
| `append_command` | `0x25c310` | acrescentar texto |
| `overwrite_command` | `0x25c32b` | sobrescrever (overwrite mode) |
| `left_delete_command` | `0x25c33d` | backspace |
| `right_delete_command` | `0x25c34b` | delete |
| `delete_word_command` | `0x25c362` | apagar por palavra |
| `select_all_command` / `invert_selection_command` | `0x25c375` / `0x25c38b` | seleção |

**[OBSERVADO]** — vtables dos comandos (typeinfo-slot → vptr):
`insert_command` slot `0xa5d890` (vptr `0xa5d898`), `undo_command` slot `0xa5e028` (vptr
`0xa5e030`), `text_command` slot `0xa5d938`. Métodos relevantes recuperados de forma anônima:
`0x922d70` → devolve `"insert"` (nome do comando); `0x922d78` → `"Insert Characters"`
(descrição); `0x922a0a` → `"append"`; `0x922a12` → `"Append Characters"`.

**[OBSERVADO]** — o `run` de `append_command` lê os settings do comando
`"characters"`, `"force"`, `"scroll_to_end"`, `"disable_tab_translation"` e então chama um
método do **view** (call via campo `+0x268`). O `run` de `insert_command` (`FUN_00912462`) obtém
o `TextBuffer` a partir do view (`*(view + 0x128)`), registra a mudança no **change-recorder do
buffer** (`*(buffer + 0x6a0)`) e aplica o trecho.

**[INFERIDO]** — o fluxo de edição é **delta-based**: o comando não substitui o conteúdo inteiro;
ele produz uma **mudança** descrita por posição + texto removido/inserido, aplicada ao buffer e
registrada no undo (coerente com o modelo de undo da §5).

### 3.2 Registro de mudança

**[OBSERVADO]** — o buffer possui um objeto de **registro de mudanças** (acessado em
`buffer+0x6a0`) e um contador de **aninhamento** em `buffer+0x4d0`. `FUN_0046dc28` (`0x46dc28`)
**incrementa** `+0x4d0` e acumula mudanças em listas; `FUN_0046cfd0` (`0x46cfd0`, ~10,5 KB)
**decrementa** e, quando o contador zera, **consolida** o grupo de mudanças.
**[OBSERVADO]** — cada mudança é um objeto de **`0x68` bytes** (criado via `new(0x68)`), com um
sub-array de registros de **`0xa8` bytes**; construtor `FUN_0048ba70` (`0x48ba70`).
**[DESCONHECIDO]** — a composição interna exata do registro de `0xa8` B.

---

## 4. 📏 Indexação / contagem de linha

**[OBSERVADO]** — **não** existe classe nomeada de índice de linhas (`LineIndex` = 0, §2.2).
Há, porém, **estado de cache no próprio `TextBuffer`**: o construtor grava **sentinela `-1`**
em `buffer+0x4e8` (`param_1[0x9d] = 0xffffffffffffffff`) e `buffer+0x4f0` (`0xffffffff`), além de
um parâmetro `0x100` em `buffer+0x29c`.
**[OBSERVADO]** — há um grande repertório de operações **por linha** exposto como nomes de comando
(só strings, sem classe): `line_begin`, `line_end`, `line_without_eol`, `line_boundaries`,
`swap_line_up`/`swap_line_down`, `relative_line_numbers`, `line_numbers`, `show_line_endings`,
`line_ending`/`set_line_ending`, `ensure_newline_at_eof`.
**[INFERIDO]** — a contagem/posição de linha é obtida por **varredura (scan) com cache** — o par
de sentinelas `-1` no buffer funciona como "último ponto/linha calculados", evitando recomputar
do início a cada consulta. Não há evidência de árvore/índice persistente de linhas.
**[DESCONHECIDO]** — a granularidade do cache e o custo assintótico em buffers muito grandes.

---

## 5. ↩️ Undo / Redo

**[OBSERVADO]** — o modelo é de **stacks de grupos de comandos**, com vocabulário explícito em
`.rodata`:

| String (`.rodata`) | Endereço | Significado arquitetural |
|---|---|---|
| `undo_stack` | `0x1ebfbb` | pilha de undo |
| `redo_stack` | `0x1f0fa9` | pilha de redo |
| `remember_undo_history` | `0x1fb398` | persistir histórico de undo |
| `mark_undo_groups_for_gluing` | `0x1e4df4` | marcar grupos para "colar" |
| `unmark_undo_groups_for_gluing` | `0x1dc22c` | desmarcar |
| `maybe_mark_undo_groups_for_gluing` | `0x1e3d2a` | variante condicional |
| `glue_marked_undo_groups` | `0x1fcef1` | **fundir** grupos marcados num só |
| `soft_undo` / `soft_redo` | `0x1f07dd` / `0x1ec8fd` | undo/redo "suave" (por mudança, não por grupo) |
| `redo_or_repeat` | `0x1d027c` | repetir/refazer |
| `Warning: Can't clear undo stack from text command` | `0x1f072a` | guarda de reentrância |

**[OBSERVADO]** — tipos de comando de undo (RTTI em `.data.rel.ro`):
`undo_command` `0x25c3f7`, `redo_command` `0x25c406`, `soft_undo_command` `0x25c415`,
`soft_redo_command` `0x25c429`, `redo_or_repeat_command` `0x25c43d`.

**[OBSERVADO]** — implementação no `TextBuffer` (`FUN_0046c5d8` + `FUN_0046dc28` +
`FUN_0046cfd0`):
- três containers de grupos em `buffer+0x3e0`, `buffer+0x400`, `buffer+0x420`
  (undo / redo / "pending"/glue), limpos por `FUN_0046c6c2`;
- ponteiro para o **grupo ativo** em `buffer+0x4c8`, contador de **aninhamento** em `buffer+0x4d0`;
- `FUN_0046c5d8` = `clear_undo_stack`: só permite limpar quando `+0x4d0 == 0`, senão **aborta** com
  a mensagem acima → undo é **seguro contra limpeza durante a execução de um text command**.
- `FUN_0046dc28` **abre** um grupo (incrementa `+0x4d0`); `FUN_0046cfd0` **fecha/consolida** ao
  zerar (monta um snapshot de mudanças a partir de `buffer+0x388`, vetor de registros de `0xa8` B).

**[INFERIDO]** — undo é **delta-based e agrupado por comandos**: cada edição vira um objeto-comando
registrado num grupo; edições consecutivas podem ser **"coladas"** (glue) num único passo de undo;
`soft_undo`/`soft_redo` operam por mudança. Não há indício de snapshots de texto completo.
O contador `+0x3a4` (incrementado em `FUN_0046dc28`) numera as revisões do buffer.

---

## 6. 🧾 Evidências e limites

**Sólido (OBSERVADO, autoridade `shipped-artifact`):** nomes de classe/comando (RTTI), strings de
undo, layout de objeto (offsets/tamanhos de alocação), existência de vtable/typeinfo e do
encadeamento construtor→alocações→destrutor.

**Médio (INFERIDO):** família da estrutura de texto (piece-table/segmentado) e o caráter
delta-based do undo e da edição — apoiados em *múltiplos buffers de heap + array de registros +
ausência de nós/continuidade*, mas sem um nome de tipo ou função que "carimbe" o algoritmo.

**Limites técnicos:**
1. Binário **stripped**; `search_procedures "text_buffer"` e `"undo"` = **0** (métodos sem nome) —
   todo mapeamento função→papel foi por endereço/typeinfo, não por símbolo.
2. `inspect_native_data_type("TextBuffer")` → **`unavailable`**: Ghidra **não** recuperou a struct
   da classe (sem DWARF, sem `.symtab`); por isso o layout é descrito por offsets observados em
   código, não por um tipo nomeado.
3. `list_names` excedeu o orçamento de resposta (≈10,5 MB) — não foi usada para enumerar classes.
4. Positivo de estrutura de texto é **inferido**; a **falsificação** seria encontrar um único
   buffer contíguo com lacuna (Gap) ou uma árvore de nós (Rope) — nenhum dos dois apareceu.

**Não copiado:** nenhuma rotina do alvo foi transcrita; a §3.1/§3.2/§5 descreve apenas **papéis**
e **assinaturas/contagens**.

---

## 7. 🧮 LEDGER de evidências

| E# | Conclusão | Tipo de evidência | Endereço / Evidence ID | Limites |
|---|---|---|---|---|
| E1 | Buffer = classe `TextBuffer` (global), com `TextBufferView`/`TextBufferSelection` | string (RTTI) + typeinfo | `0x25c02b`, `0x25c119`, `0x25c0f5`; `ev_a746a9d6…85bb0`, `ev_30284ae9…de9e66` | nomes demangled; sem método associado |
| E2 | Nenhuma classe `Piece`/`Rope`/`GapBuffer`/`LineIndex` (negativo *bounded*) | string (busca) | `ev_02c12454…d5d39`, `ev_7934636f…4c5cf`, `ev_6b0369e2…101ebb`, `ev_e03f19ca…e4287`, `ev_a93ae5ea…4670` | cobre só strings definidas pelo Ghidra |
| E3 | `TextBuffer` tem 2 vptrs; `__vmi` com 2 bases (SpellingListener + virtual) | typeinfo/data xref | typeinfo `0xa5cbe0`; vtables refs `0xa5cb88`/`0xa5cbb0`; `ev_72c00e9d…23588`, `ev_33a4fb6f…34b7b` | base #1 não nomeada |
| E4 | Construtor `FUN_0048f29c` aloca core `0x108` B em `+0x250` e `TokenStorage` `0x328` B em `+0x2f0` | pseudocode | `0x48f29c`; `ev_a1eb709a…6fef8` | offsets via código, não struct |
| E5 | Destrutor libera buffers de heap + array de registros `0x20` B do core | pseudocode | `0x4cbde8` (dtor), `0x4cb9a2`, `0x4cbb76`; `ev_54a587d4…9eca77` | registro de `0x20` B não tipado |
| E6 | Core embute subobjeto `observer` (padrão observer) e `TokenStorage:LayoutTracker` | typeinfo + pseudocode | `observer` ti `0xa46c48`; `TokenStorage` ti `0x2c7cc4`; `ev_dff0fa23…ab1183` | observer ≠ storage |
| E7 | Reset zera **11 pares `{begin,end}`** (passo `0x18`) = múltiplos vetores de heap | pseudocode | `0x8f5c88`; `ev_c69a5af4…8ace9b` | objeto interno; sem semântica por vetor |
| E8 | Edição modelada por comandos (`text_command`→`insert/append/…delete`) com nome/descrição | string + vtable + pseudocode | nomes `0x25c2f0`,`0x25c310`,`0x25c33d`,`0x25c34b`; vtables `0xa5d898`,`0xa5e030`; `0x922d70`→`"insert"`; `ev_3b55a3f5…1c73a` | só papéis, sem corpo |
| E9 | Vocabulário de undo/redo (stacks, grupos, gluing, soft) | string | `0x1ebfbb`,`0x1f0fa9`,`0x1e4df4`,`0x1dc22c`,`0x1fcef1`,`0x1fb398`,`0x1f07dd`; `ev_0a1d83a4…ed6b82`, `ev_b52a9a93…af02e`, `ev_8c5d1044…9d1f9` | strings também servem de nome de comando |
| E10 | `clear_undo_stack` só limpa com `+0x4d0==0`, senão aborta; grupos em `+0x3e0/+0x400/+0x420` | pseudocode + xref | `0x46c5d8` (ref `0x46c687`); `ev_c272b26a…6c2fc`; xref `undo_stack` `ev_7afac4a1…7cd0` | offsets via código |
| E11 | Mudança = objeto `0x68` B com sub-array de registros `0xa8` B (delta-based) | pseudocode | `0x48ba70`, `0x48bad8`, `0x48ee28`; `ev_e2108e84…2f8f7` | conteúdo do `0xa8` desconhecido |
| E12 | Strings internas em **UTF-32 com SSO** (4 B/char) | pseudocode | `0x46ba2c`, `0x67273c`; `ev_c272b26a…6c2fc` | corpo do documento pode diferir |
| E13 | Região de type-descriptors RTTI em `.rodata` (classe/vtable por typeinfo) | read_bytes | `0x25bf00..`, `0x25c040..`; `ev_c29b1ba5…4236c` | desambiguação por xref manual |
| E14 | Cabeçalho de segmentos/contagens do alvo | binary_overview | image base `0x100000`, 33 segm., 26 455 procs, 9 683 strings; `ev_e406088b…502a9` | PIE; endereços relativos |

---

### TL;DR para a Fase 3 (Electron/TS)

- Modelar **`Buffer`** (texto) e **`View`** (apresentação/edição/seleção) como objetos separados;
  o buffer é observável por **listeners** (padrão observer).
- Representar o texto como **estrutura segmentada com dois buffers de heap crescentes** (original +
  edições) e um **índice de spans** [INFERIDO] — não como string única; validar com benchmark de
  insert no meio de arquivo grande.
- Fazer a edição passar por **comandos delta** (`insert`, `append`, `overwrite`, `delete_*`) que
  (a) abrem/fecham um **grupo de mudança** e (b) entram no **undo stack**; suportar **glue** de
  grupos e **soft undo/redo**; bloquear `clear_undo_stack` durante execução de comando.
- Expor contagem/posição de linha via **scan com cache** (sentinela "último ponto"), não via índice
  persistente — revisitável se o desempenho exigir.
