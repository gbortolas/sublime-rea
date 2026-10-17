# Scaffold `src/` — convenções e costuras (Fase 3 / P2.2)

> **Entregável:** a **estrutura de código** do editor **Scribe** (Electron + TypeScript), derivada da
> spec abstrata da Fase 2 ([`../architecture/`](../architecture/) — 61 decisões `DEC-*`).
> **Não** é análise: aqui só existe **código nosso**. Nada de código do alvo.
> Atualizado em **2026-10-16** (P2.2).

**Regra clean-room (vale para todo arquivo de `src/`):** é **proibido** abrir `docs/analysis/**`,
`target/**` ou qualquer artefato do alvo para escrever código. O único insumo é
[`docs/architecture/`](../architecture/) (padrões + decisões, sem código do alvo). Ao citar um padrão
observado, use `[OBSERVADO]`/`[INFERIDO]`/`[DESCONHECIDO]`; ao marcar algo nosso, use
**"escolha nossa (não observada no alvo)"**.

---

## 1. 🗂️ Layout e donos

```
src/
  shared/        ← COSTURAS (congeladas). Únicos arquivos importáveis entre módulos.
  core/
    buffer/      ← doc 01: PieceTable, delta, índice de linhas, Buffer, DocumentRegistry, TextStore
    command/     ← doc 01: CommandBus, EditScope, undo/redo (delta inverso + grupos/glue)
    concurrency/ ← doc 02: Scheduler, TaskPool (worker_threads), contadores compartilhados
    render/      ← doc 04: RenderPipeline + Canvas2DBackend/WebGPUBackend, Viewport, atlas
    packages/    ← doc 05: PackageResolver (camadas, índice em memória, glob)
    properties/  ← doc 04/05/06: PropertySystem, defineProperty, merge por camada
    extension/   ← doc 03: ExtensionHost (utilityProcess), ExtensionBridge, OPS, ExtensionAPI
  main/          ← processo Node do Electron (app lifecycle, IPC, host de plugins)
  preload/       ← ponte tipada `contextBridge` (nada de `nodeIntegration`)
  renderer/      ← página + boot do render (Canvas2D/WebGPU), sem nó DOM por linha
test/            ← testes de integração (depois da costura entre módulos)
```

**Dependências permitidas:** um módulo importa **apenas** `src/shared/**` e o seu próprio diretório.
Import cruzado entre módulos de `src/core/**` é **proibido** durante a construção paralela — a
costura final é feita depois, explicitamente.

---

## 2. ⚙️ Regras de código

| Item | Regra |
|---|---|
| Linguagem | TypeScript **strict**; `exactOptionalPropertyTypes` e `noUncheckedIndexedAccess` **ligados** |
| Módulo | `commonjs` + `target ES2022` (Electron main/preload sem ESM) |
| Libs | `DOM` + `ES2022` + `@types/node` (o mesmo código roda em main, renderer e worker) |
| `any` | **proibido** (`unknown` + narrowing; `never` para exaustividade) |
| Erros | **tipados** e altos; nada de `catch {}` silencioso (DEC-TR-5) |
| Tempo/aleatório | injeção de dependência (`now()`, `random()` como parâmetro) — teste determinístico |
| Bloqueio | proibido busy-wait/`Atomics.wait` fora de worker; espera só via `Promise` (DEC-CON-1/7) |
| Descarte | toda subscrição devolve `Disposable` (ou `() => void` quando o doc manda) |
| Handles | validados no `DocumentRegistry` **antes** de usar (DEC-TR-1) |
| Deps | **não** adicione dependência nova sem necessidade — a stack é `electron`, `typescript`, `vitest`, `eslint` |
| Testes | vitest, colocalizados como `<nome>.test.ts`; sem rede, sem timing real longo |

---

## 3. 🧩 Reconciliações de contrato (decisões do orquestrador)

O digest da Fase 2 achou shapes conflitantes entre docs. **Canônico = `src/shared/**`**:

| Símbolo | Conflito | Decisão |
|---|---|---|
| `DocumentHandle` | `{__opaque}` (01) · `{__brand:"DocumentHandle"}` (02/06) · `Handle<T>` (03) | `Handle<T>` brandado; slot (20 bits) + geração (11 bits) — `shared/handles.ts` |
| `Disposable` | redefinido em 02 e 03 | um só em `shared/disposable.ts` |
| `TextStore` | síncrono (01) × assíncrono (02) | fronteira = **assíncrono** (02); o núcleo síncrono é a **`PieceTable`** (01), interna ao módulo |
| `DocumentRegistry` | síncrono (01) × assíncrono (02) | **união**: ciclo de vida async + lookup quente sync (`resolve`/`isValid`) |
| `Buffer.on('changed')` | 06:97 | `onDidChange(cb): Disposable` (01) |
| `RenderPipeline` | subset (02) × completo (04) | **04** + `invalidate`/`measure` do 02; `RenderBackend` (06) = alias |
| `ExtensionBridge` | `port/request/subscribe` (02) × `request/notify/on/close` (03) | **03** + `port`; eventos por `on()` (não `subscribe`) |
| `port: MessagePort` | DOM × `worker_threads` × `Electron.MessagePortMain` | **`BridgePort`** estrutural (satisfeito pelos três) |
| `ExtensionEvents` | **tuplas** de args (03) | **mapa de handlers** (`ready(): void`); o wire continua array de args |
| `Task<T>` | genérico solto (02) | `Task<K extends TaskKind>` com resultado derivado de `TaskResultMap` |
| Camadas de recurso | `platform/installed/packages/user` (06) × `os/app/user` (05) | **`os`/`app`/`user`** (05 é o doc dono); precedência `user > app > os` |
| Nome × opcode | `buffer_insert` (06) × `"buffer.insert"` (03) | superfície **`"buffer.insert"`**; `OPS` mapeia nome → número denso (a ordem é o wire) |

---

## 4. 🔗 Costuras prontas (`src/shared/**`)

| Arquivo | Contém |
|---|---|
| `handles.ts` | `Handle<T>`, `DocumentHandle`/`ViewHandle`/`WindowHandle`/`HostHandle`, empacotamento slot+geração |
| `disposable.ts` | `Disposable`, `DisposableStore`, `MutableDisposable`, `toDisposable`, `disposeAll` |
| `events.ts` | `Event<T>`, `Emitter<T>` |
| `async.ts` | `Lifetime`, `CancellationError`, `Deferred<T>`, `delay`, `isAbortError`, `toError` |
| `buffer-contract.ts` | `Buffer`, `TextStore`, `TextDelta`, `Edit`, `EditOrigin`, `DocumentRegistry`, `CommandBus`, `EditScope`, `UndoStackBusyError`, `LineScanResult`, `IndexResult` |
| `concurrency-contract.ts` | `Priority`, `PoolLane`, `Task`/`TaskKind`/`TaskResultMap`, `TaskHandle`, `Scheduler`, `TaskPool`, `MainThreadBusy`, `WorkerRequest`/`WorkerResponse` |
| `render-contract.ts` | `Rect`, `DamageRects`, `RGBA`, `GlyphInstance`, `RectInstance`, `LineInstance`, `GlyphMetrics`, `TextStyle`, `RenderPipeline`, `Viewport`, `ViewportObserver`, tetos |
| `packages-contract.ts` | `ResourceUri`/`Layer`/`Kind`/`Entry`, `PackageResolver`, erros tipados, `packagesUri`/`parseResourceUri` |
| `properties-contract.ts` | `PropertyScope`, `PropertyDefinition<T>`, `Property<T>`, `Control`, `PropertySystem`, `PropertyChange` |
| `extension-contract.ts` | `HostToCore`/`CoreToHost`, `BridgePort`, `ExtensionMethods`/`ExtensionEvents`, `OPS`/`OpsTable`, `ExtensionBridge`, `ExtensionHost`/`HostSession`, `ExtensionAPI`, `ProtocolError` |

---

## 5. ▶️ Como rodar

```bash
npm install          # uma vez
npm run typecheck    # tsc --noEmit (strict)
npm test             # vitest run
npm run lint         # eslint (flat config)
npm run build        # tsc -> dist/
npm start            # electron . (precisa de display; use xvfb-run se headless)
```

> **Ambiente sem display:** `xvfb-run -a npm start`. O boot do renderer **não** pode exigir GPU —
> o default de fábrica é o backend **CPU/Canvas2D** (DEC-REN-2).
