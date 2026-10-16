# Fase 2 — Arquitetura do editor-alvo 🏛️

> **Entregável:** **P2.1** — a **spec abstrata** do editor que vamos construir, derivada da Fase 1
> **sem repetir a análise** e **sem copiar código do alvo** (princípio *clean-room*). Alvo: o ELF64
> PIE **stripped** `target/sublime_text/sublime_text`
> (`sha256 8b105b1839d7809f60ec186b6c6dcb2d107e22ad23f42c5f8ba7dec67ab43d92`).
> Realizado em **2026-10-16**.
> **Insumo único:** [`../analysis/evidence-index.md`](../analysis/evidence-index.md) — 179 evidências
> (`BUF`/`CON`/`PY`/`HOST`/`IPC`/`REN`/`PKG`) + 48 incógnitas consolidadas.

**O que este diretório é.** A Fase 1 respondeu *"o que o alvo faz"* (com evidência rastreável). A
Fase 2 responde *"o que nós vamos construir"*: traduz cada padrão observado numa **decisão de
arquitetura** (`DEC-*`) para a reimplementação em **Electron + TypeScript**, e diz **onde
deliberadamente nos afastamos** do alvo. Cada afirmação sobre o alvo cita **Evidence IDs**; cada
escolha nossa é marcada **"escolha nossa (não observada no alvo)"**.

**Nome:** o editor-alvo chama-se **Scribe** (decidido em **P2.3**).

---

## 1. 🗺️ Os documentos

| Doc | Tema | Decisões | Insumo primário (Fase 1) |
|---|---|---|---|
| [`01-buffer-e-edicao.md`](01-buffer-e-edicao.md) | Buffer & edição (`TextStore` segmentado sob façade observável) | `DEC-BUF-1…10` | `buffer-structure.md` (`BUF-E1–E14`) |
| [`02-concorrencia-e-scheduling.md`](02-concorrencia-e-scheduling.md) | Concorrência & scheduling (threads, pools, handoff ao main) | `DEC-CON-1…12` | `concurrency.md` (`CON-E1–E21`), `REN-E26` |
| [`03-extensao-e-ipc.md`](03-extensao-e-ipc.md) | Extensão & IPC (host de plugins como processo isolado) | `DEC-IPC-1…12` | `api-python.md` + `ipc-plugin-host.md` + `ipc-protocol.md` (`PY-`/`HOST-`/`IPC-`) |
| [`04-render-e-ui.md`](04-render-e-ui.md) | Render & UI (contexto abstrato, batching, viewport virtualizado) | `DEC-REN-1…8` | `render-pipeline.md` (`REN-E1–E27`) |
| [`05-empacotamento-e-recursos.md`](05-empacotamento-e-recursos.md) | Empacotamento & recursos (namespace lógico, resolução em camadas) | `DEC-PKG-1…12` | `packaging.md` (`PKG-E1–E22`), `PY-E19`/`PY-E22` |
| [`06-padroes-transversais.md`](06-padroes-transversais.md) | Padrões transversais (o que reaparece em todo o Scribe) | `DEC-TR-1…7` | o índice inteiro (visão cruzada) |

> **Ordem de leitura sugerida:** `01` → `02` → `03` → `04` → `05` (componentes) e, por último,
> `06` (o catálogo que amarra todos). Para reconstruir o *porquê* de qualquer decisão, vá do `DEC-*`
> ao Evidence ID e daí ao doc-fonte da Fase 1.

---

## 2. 🔭 Arquitetura em um olhar

### 2.1 As 3 fronteiras do alvo `[OBSERVADO]`/`[INFERIDO]`

A Fase 1 converge para uma arquitetura em **3 fronteiras**:

```
                    ┌────────────────────────────┐
                    │  NÚCLEO C++ compartilhado   │   GTK3/GLib, main thread única
                    │  (buffer, threads, render)  │   (gtk_main + g_idle_add)
                    └──────────┬─────────────────┘
                               │  ponte IPC: anel em shm + semáforos,
                               │  framing [uint32 len] + dispatch numérico (281/71 ids)
                    ┌──────────▼─────────────────┐
                    │  host CPython (processo)    │   plugin_host-3.14/3.3 (posix_spawn)
                    └────────────────────────────┘
    render: px_render_context (31 virtuais) → gl_render_context (GL≥4.1) | skia_render_context (CPU, default)
```

1. **Núcleo** — buffer segmentado, fábrica de threads POSIX, `px_render_context`; **tudo na main
   thread** (`CON-E1`, `REN-E3`).
2. **Ponte** — canal de shm nomeado + semáforos; opcode = 1º `uint32` do payload; dois enums
   (U=281 host→núcleo, V=71 núcleo→host) (`IPC-E1`, `IPC-E30`).
3. **Host de plugins** — processo separado (não thread) que embute CPython (`HOST-E3`, `CON-E19`).

### 2.2 O mapeamento para o Scribe (Electron/TS) `[escolha nossa]`

| Fronteira do alvo | No Scribe | Componentes |
|---|---|---|
| Núcleo na **main thread** | **main process** (Node) + **renderer** (Chromium); trabalho pesado vai a **`worker_threads`** | `Buffer`, `TextStore`, `DocumentRegistry`, `CommandBus`, `Scheduler`, `TaskPool` |
| Ponte IPC binária em shm | **`MessagePort`** sobre `utilityProcess`, com **serialização tipada** e request/response por id | `ExtensionHost`, `ExtensionBridge`, `ExtensionAPI` |
| Ponte por **dispatch numérico** (281/71 ids) | **registro tipado por nome** (tabela gerada a partir de contrato versionado) | `ExtensionBridge` |
| Render GTK/GL/Skia na main thread | **Canvas 2D / WebGPU** no renderer, com scroll virtualizado e *damage rects* | `RenderPipeline` + `Canvas2DBackend`/`WebGPUBackend`, `Viewport` |
| `.sublime-package` (ZIP sem manifesto) | **camadas de recursos** (`os` → `app` → `user`) com índice em memória | `PackageResolver`, `PropertySystem` |

> **Regra de ouro do mapeamento:** preservamos **contratos e ciclos de vida** (façade + handle
> opaco, observer, comando/delta, work item + scheduler, pipeline + backends, namespace + precedência)
> e **trocamos a implementação** por primitivas idiomáticas do ecossistema Node/Chromium. Nada de
> Web Workers com strings compartilhadas: `SharedArrayBuffer` **não** compartilha strings — dados
> cruzando threads vão por `postMessage`/`Transferable` (`DEC-CON-11`).

---

## 3. 🧩 Glossário de componentes (canônico)

| Componente | Papel | Dono |
|---|---|---|
| `Buffer` | façade pública observável (espelha `TextBuffer`) | `01` |
| `TextStore` | estrutura interna segmentada (piece-table-like) | `01` |
| `DocumentHandle` | **handle opaco** (número brandado, com geração); nunca um objeto | `01`/`02`/`03` |
| `DocumentRegistry` | mapa único `handle → estado do documento` | `01`/`02` |
| `CommandBus` | comandos nomeados + agrupamento de undo; **contrato canônico no `01`** | `01` |
| `Scheduler` | marshalling ao main thread; lanes `Priority = input/edit/layout/background` | `02` |
| `TaskPool` | pools de trabalho; lanes `PoolLane = io/index/fileRead` | `02` |
| `ExtensionHost` | processo isolado de plugins (`utilityProcess`) | `03` |
| `ExtensionBridge` | transporte + protocolo núcleo↔host | `03` |
| `ExtensionAPI` | API tipada exposta aos plugins | `03` |
| `RenderPipeline` | base abstrata do desenho (`+Canvas2DBackend`/`WebGPUBackend`) | `04` |
| `Viewport` | janela virtualizada, damage/observers, alvo animado | `04` |
| `PackageResolver` | namespace lógico de recursos + precedência em camadas | `05` |
| `PropertySystem` | propriedades/settings observáveis por escopo | `04`/`05` |

> **`DocumentHandle` é canônico em todos os docs:** número brandado (id + geração empacotados). O
> *estado* (store, dirty, geração explícita) mora no registry, **não** no handle.

---

## 4. 📐 Registro de decisões (`DEC-*`)

| Prefixo | Doc dono | Faixa | Foco |
|---|---|---|---|
| `DEC-BUF-*` | `01` | 1–10 | estrutura de texto, delta, undo agrupado, handles, UTF-16/codificação |
| `DEC-CON-*` | `02` | 1–12 | UI sagrada, pools, lanes, handoff, sizing, transferência |
| `DEC-IPC-*` | `03` | 1–12 | processo separado, transporte, request/response, eventos, handshake |
| `DEC-REN-*` | `04` | 1–8 | pipeline abstrato + backends, batching, atlas, viewport, AA |
| `DEC-PKG-*` | `05` | 1–12 | namespace, camadas, índice, variantes, gramática, lazy loading |
| `DEC-TR-*` | `06` | 1–7 | padrões transversais (cross-doc) |

**Total: 61 decisões.** As decisões de cada doc têm racional + Evidence IDs na seção
*"Decisões de arquitetura"* e aparecem compiladas na tabela de *Rastreabilidade* do próprio doc.

---

## 5. 🔗 Rastreabilidade global (Fase 1 → Fase 2)

| Tema | Evidência (Fase 1) | Síntese (Fase 2) | Decisões |
|---|---|---|---|
| Buffer / edição | `BUF-E1–E14` (+`PY-E4/E6/E16/E17`) | `01` | `DEC-BUF-*` |
| Concorrência | `CON-E1–E21` (+`REN-E26`) | `02` | `DEC-CON-*` |
| Extensão / IPC | `PY-E1–E33`, `HOST-E1–E26`, `IPC-E1–E36` | `03` | `DEC-IPC-*` |
| Render / UI | `REN-E1–E27` | `04` | `DEC-REN-*` |
| Empacotamento | `PKG-E1–E22` (+`PY-E19/E22`) | `05` | `DEC-PKG-*` |
| Transversais | todo o índice (visão cruzada) | `06` | `DEC-TR-*` |

> **Como auditar:** a seção *Rastreabilidade* de cada doc mapeia `Conclusão (Evidence IDs) → DEC →
> Status`. O índice consolidado ([`../analysis/evidence-index.md`](../analysis/evidence-index.md))
> preserva os IDs originais e a §9 registra **supersessões** — em `03`, a direção dos canais
> (`HOST-E20`) e o enum textual (`HOST-E9`) aparecem marcados como **revisados**.

---

## 6. ⚖️ Convenções e limites

- **Clean-room:** nenhum bloco de código, assembly, GLSL ou pseudocódigo do alvo é reproduzido. Só
  **nomes, assinaturas, contagens, tamanhos, offsets, endereços e papel arquitetural**. Os únicos
  trechos de código aqui são **TypeScript do nosso projeto** (contratos/ilustrações).
- **Rótulos:** toda afirmação sobre o alvo usa `[OBSERVADO]` / `[INFERIDO]` / `[DESCONHECIDO]`;
  escolhas nossas usam **"escolha nossa (não observada no alvo)"**.
- **Hipótese ≠ fato:** onde a Fase 1 deixou `[DESCONHECIDO]`, a Fase 2 **decide mesmo assim** e
  registra a incógnita na §"Incógnitas que afetam este módulo" do doc dono (referenciando `U*`).
- **Pendências que afetam esta fase:**
  - **P2.3 — nome:** ✅ decidido (**Scribe**).
  - **Incógnitas com maior impacto** (ver [`../analysis/evidence-index.md`](../analysis/evidence-index.md) §10):
    `BUF-U1`/`BUF-U4` (topologia do store e cache de linha), `CON-U1`/`CON-U5` (identidade da main
    thread e coalescing do scheduler), `IPC-U5`/`IPC-U6` (quais ids bloqueiam; subcódigos de `data[0]`),
    `REN-U1`/`REN-U2` (critério de visibilidade; política de flush).

---

## 7. ▶️ Próximo passo — Fase 3 (P2.2)

Com a Fase 2 fechada, a **Fase 3** cria o scaffold `src/` (Electron + TypeScript) seguindo estas
decisões: `TextStore` zero-copy, `worker_threads` para buffer/parsing, render por Canvas/WebGPU com
scroll virtualizado, e API de extensão tipada + protocolo IPC. Detalhes e ordem no
[`../BACKLOG.md`](../BACKLOG.md) (§P2).

> **Fontes vivas:** [`../HANDOFF.md`](../HANDOFF.md) (como retomar) ·
> [`../BACKLOG.md`](../BACKLOG.md) (placar) · [`../analysis/evidence-index.md`](../analysis/evidence-index.md)
> (evidência). Este README é o índice da Fase 2.
