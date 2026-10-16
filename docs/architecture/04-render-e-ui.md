# 04 · Render & UI — contexto de render abstrato, batching e viewport virtualizado

> Fase 2 (P2.1) · síntese clean-room do alvo (sha256 8b105b18…43d92) · insumo: evidence-index.md · 2026-10-16

**Como ler este documento.** Cada afirmação sobre o **alvo** carrega o rótulo **[OBSERVADO]**,
**[INFERIDO]** ou **[DESCONHECIDO]** (§*Convenção* do projeto) e aponta para um **Evidence ID**
(`REN-E*`) do ledger consolidado em [`../analysis/evidence-index.md`](../analysis/evidence-index.md) §7.
Toda escolha da **nossa** arquitetura está marcada **“escolha nossa (não observada no alvo)”** — inclusive
quando ela replica um padrão: a *decisão* de adotar o padrão é nossa. Nenhum shader, bloco de assembly
ou pseudocódigo do original é transcrito; citamos apenas **nomes, contagens, tamanhos e papel
arquitetural**.

Notação de componentes (glossário do projeto, usada daqui em diante): `RenderPipeline` (base abstrata
do desenho) · `Canvas2DBackend` / `WebGPUBackend` (backends) · `Viewport` · `PropertySystem` ·
`DocumentRegistry` / `DocumentHandle` / `Buffer` / `TextStore` · `CommandBus` · `Scheduler` / `TaskPool` ·
`ExtensionHost` / `ExtensionBridge`. Codinome provisório do editor: **Arcane**.

---

## 1. 🎯 O padrão observado (o quê)

Em uma frase [OBSERVADO]: o alvo desenha a UI através de **uma única abstração de render**
(`px_render_context`, uma **base abstrata** com uma interface de **31 slots virtuais**) com **duas
implementações concretas** — uma **GPU (OpenGL ≥ 4.1)** e uma **CPU (Skia raster sobre Cairo)** — e o
**texto nunca é moldado na GPU**: Pango/FreeType/Cairo moldam e rasterizam na **CPU**, e o resultado
sobe como **atlas de glifos**. Todo o desenho, inclusive o texto, é **instanciado por *batch***.

Os quatro pilares do padrão [OBSERVADO]:

1. **Um contexto abstrato, dois backends reais.** `px_render_context` é base abstrata (não emite
   vtable); `gl_render_context` (GPU) e `skia_render_context` (CPU) expõem **a mesma interface de 31
   virtuais** (`REN-E4`, `REN-E5`). O contrato cobre retângulos (incl. decorados), linhas, glifos,
   clip/scissor e superfície.
2. **Escolha por configuração, não por heurística.** O setting **`hardware_acceleration`** seleciona o
   caminho; o **default de fábrica é `"none"` = CPU**, e o modo **`"opengl"` exige GL ≥ 4.1** —
   trocar exige reiniciar o app (`REN-E23`, `REN-E24`).
3. **Render na main thread.** Não há *thread* de render: o frame é disparado por um *tick* do toolkit
   e o desenho roda na thread principal (`REN-E3`).
4. **Retained-mode por cima do contexto.** Sobre o render context vive uma **biblioteca de controles
   com um sistema de propriedades** (RTTI `.rodata`, `REN-E27`) — a UI é uma *árvore de widgets*
   retida, que emite comandos ao contexto abstrato.

Toolkit e proprietário da janela [OBSERVADO]: **GTK3/GLib** (`NEEDED` traz `libglib`/`libgobject`,
`libGL`, `libX11`; o GTK em si entra por `dlsym`; **zero** referências a Qt — `REN-E1`, `REN-E2`).

---

## 2. 🧩 Arquitetura do pipeline (com Evidence IDs)

```
                       ┌─────────────────────────────────────────────┐
  tokens/layout  ──▶   │  RenderPipeline  (base abstrata, ~31 ops)    │  ◀── retained-mode widget tree
  (TextStore,          │  retângulo · retângulo decorado · linha ·    │      + PropertySystem   (REN-E27)
   TokenRenderer)      │  glifo · clip/scissor · superfície           │
                       └───────────────┬─────────────────────────────┘
                                       │ escolha por knob (REN-E23/E24)
                    ┌──────────────────┴───────────────────┐
                    ▼                                      ▼
        WebGPUBackend  (hardware)               Canvas2DBackend (default = software)
        · batching instanciado                  · desenho imediato no raster
        · atlas de glifos                       · mesmo atlas, blit CPU
        · damage/clip retangular                · damage/clip retangular
```

**Componentes e evidência:**

| Camada | Alvo | Evidence IDs | Rótulo |
|---|---|---|---|
| Interface de desenho | `px_render_context` — base abstrata, **31 virtuais** | `REN-E4`, `REN-E5` | [OBSERVADO] |
| Backend hardware | `gl_render_context` (OpenGL ≥ 4.1; `#version 410`; **17 programas** nomeados) | `REN-E4`, `REN-E6`, `REN-E8`, `REN-E9` | [OBSERVADO] |
| Backend software | `skia_render_context` (Skia **raster** sobre `cairo_image_surface`) | `REN-E21`, `REN-E22` | [OBSERVADO] |
| Seleção do backend | setting `hardware_acceleration`; bit de estado interno | `REN-E23`, `REN-E24` | [OBSERVADO] |
| Modelo de desenho | *batch* instanciado; instâncias num texture buffer `RGBA32F`; tetos 8192 / 128 | `REN-E10`, `REN-E11`, `REN-E12`, `REN-E7` | [OBSERVADO] (flush = [INFERIDO]) |
| Texto | moldagem/rasterização **na CPU**; atlas `RGBA8` 1024/4096 | `REN-E15`, `REN-E16`, `REN-E17` | [OBSERVADO] |
| Viewport | `scroll_data_source` + *subscribers* + alvo animado | `REN-E19` | [OBSERVADO] |
| Virtualização | clip por região danificada (`glScissor`) | `REN-E18` | [OBSERVADO] |
| Threading | frame em *tick* do toolkit; **sem thread de render** | `REN-E3` | [OBSERVADO]/[INFERIDO] |
| Erro de GL | **diálogo modal**; não há *fallback* silencioso | `REN-E25` | [OBSERVADO] |

**Fluxo de frame (nosso, §4):** `Scheduler` (main thread) → `Viewport` publica o retângulo danificado →
`RenderPipeline` acumula *instâncias* por família → *flush* no teto (ou fim de camada) → backend desenha
com *clip* retangular. O pipeline **não conhece a árvore de widgets**; ela é quem traduz estado retido
em comandos.

---

## 3. 🔤 Texto: shaping, atlas de glifos e batching

**No alvo** [OBSERVADO]: o texto é **moldado e rasterizado na CPU** (`FT_Load_Glyph` e a família
`cairo_ft_scaled_font_*` / `pango_*` entram por `dlsym` — `REN-E16`), e o **bitmap** sobe para a GPU
como **atlas 2D `RGBA8`, 1 mip, filtro `NEAREST`, wrap `CLAMP_TO_EDGE`, lado 1024 ou 4096**, com
upload em ordem **BGRA/UBYTE** e origem Y invertida (`REN-E15`). O texto é emitido **por token** (não
por caractere) e o *gutter* é um renderer separado (`REN-E20`). O empacotamento dos glifos visíveis é
uma interface abstrata (`gl_glyph_cache_batch`) com dois implementadores de 3 slots (`REN-E17`), e o
batch tem teto `MAX_GLYPH_INSTANCES = 8192` (`REN-E7`).

**Padrões que replicamos (a implementação é nossa):**

- **Shaping/raster na CPU, composição na “GPU”** — o atlas é a fronteira: a camada tipográfica entrega
  **bitmaps + métricas**, o backend só compõe.
- **Cache de glifos indexado por (fonte, tamanho, glifo/subpixel)** — o atlas é *padded* e *shelf/quad*
  empacotado, com *eviction* por geração. Um glifo nunca é rasterizado duas vezes no mesmo frame.
- **Batching por família de primitiva** — glifos, retângulos, retângulos decorados, linhas. Cada
  família tem um *stride* de instância próprio (o alvo usa 2–5 texels por instância — `REN-E11`);
  o *flush* dispara no teto do batch.
- **Duas saídas por glifo** (cor + alpha) para composição/subpixel (o alvo usa MRT — `REN-E14`); na
  prática, decidimos **subpixel como two-pass horizontal opcional** por causa da portabilidade WebGPU.

**Shaper** [DESCONHECIDO]: as strings do alvo não revelam nenhum HarfBuzz (`hb_*`) nem shaper nomeado
(`REN-U4`). **Não** assumimos que exista um shaper interno — §4 resolve isso com escolha explícita.

---

## 4. 🖥️ Decisões de arquitetura para o editor-alvo

> Todas as decisões abaixo são **escolha nossa (não observada no alvo)** enquanto *decisões de projeto*;
> o padrão que as inspira é observado e está referenciado.

- **`DEC-REN-1` — Um `RenderPipeline` abstrato + dois backends reais, com default **CPU**.**
  Espelha o padrão do alvo: uma interface abstrata de desenho com backends hardware e software, ambos
  *primeira classe* — e o **default é o software** (`Canvas2DBackend`), igual ao alvo
  (`hardware_acceleration: "none"`). Knob de configuração semeado como **`hardwareAcceleration`**
  (`"none"` | `"webgpu"`), aplicado no *boot*.
  *Racional:* o alvo mantém **os dois caminhos** de verdade; o caminho CPU é o que garante o app rodar
  em máquinas sem GPU utilizável. Manter os dois evita "modo de emergência podre".
  *Evidence:* `REN-E4`, `REN-E5`, `REN-E21`, `REN-E23`, `REN-E24`.

- **`DEC-REN-2` — Desenho instanciado com *batching* e **flush por teto**.**
  Acumulamos instâncias em buffers tipados por família de primitiva e emitimos **poucas** chamadas de
  desenho. No `WebGPUBackend`, instâncias vão num **storage buffer** (`array<Instance>`) lido pelo
  vertex shader por `instance_index`; o teto de *flush* é herdado do alvo (**8192 glifos**; quads de
  *stencil*/*clip* em lote pequeno de **128**).
  *Racional:* o alvo troca "uma chamada por primitiva" por um *batch* lido de buffer instanciado
  (`REN-E10`, `REN-E12`); em WebGPU o equivalente idiomático é *storage buffer* + instancing, que a
  WebGL2 não tem — daí o alvo usar *texture buffer* e nós usarmos *storage buffer*.
  *Evidence:* `REN-E7`, `REN-E10`, `REN-E11`, `REN-E12`. *(Política de flush exata do alvo é
  `REN-U2`; adotamos teto como heurística.)*

- **`DEC-REN-3` — Texto: shaping/raster **fora da main thread**, atlas compartilhado.**
  Um **worker de shaping** (`TaskPool`) molda e rasteriza glifos em **`OffscreenCanvas`** e publica os
  bitmaps num **atlas `RGBA8` de 1024/4096**, `NEAREST`/`CLAMP_TO_EDGE` (mesmos parâmetros do alvo),
  transferido ao backend como textura; a main thread só **posiciona quads**. Como o alvo não revela
  shaper (`REN-U4`), a camada de shaping usa um módulo próprio (variação de `TextStore`) e mantém o
  atlas como **fronteira de contrato**.
  *Racional:* reproduz o padrão "molda na CPU, compõe no backend" (`REN-E16`, `REN-E15`) sem herdar a
  serialização na main thread; o atlas isola a diferença de *engine* de texto.
  *Evidence:* `REN-E15`, `REN-E16`, `REN-E17`, `REN-E20`.
  *Divergência deliberada quanto à thread:* ver §6.

- **`DEC-REN-4` — `Viewport` virtualizado: *damage* retangular + modelo data-source/observers/target animado.**
  O `Viewport` mantém o range visível de linhas (`K..K+N`), publica **retângulos danificados** e o
  backend aplica ***clip*/scissor retangular** a cada região — o resto é reutilizado por *scroll*.
  O deslocamento é um **alvo animado** com *data source* que notifica *subscribers*, padrão do alvo.
  Frames são agendados por **`requestAnimationFrame`** (o `Scheduler` coalesce *damage* e agenda um
  frame por vez), equivalente ao *tick* do toolkit.
  *Racional:* o alvo virtualiza por `glScissor` de região danificada (`REN-E18`) e modela o viewport
  como fonte de dados + observers + alvo animado (`REN-E19`); o *tick* do toolkit (`REN-E3`) mapeia
  para `rAF`. O **critério de visibilidade** do alvo não foi pinado (`REN-U1`), então definimos o
  nosso explicitamente (range por *índice de linha* + *fold*).
  *Evidence:* `REN-E3`, `REN-E18`, `REN-E19`.

- **`DEC-REN-5` — Falha do backend hardware = **erro explícito**, nunca *fallback* silencioso.**
  Se o `WebGPUBackend` não inicializar, mostramos erro ao usuário (diálogo) e expomos o **modo efetivo**
  na UI/log — o usuário sabe em que caminho está. Não trocamos de backend pelas costas.
  *Racional:* o alvo exibe **diálogo modal** ao falhar o GL (`REN-E25`) e **loga** o contexto; o
  *fallback* automático é desconhecido no alvo (`REN-U3`) e nós optamos por **não** inventá-lo.
  *Evidence:* `REN-E23`, `REN-E25`.

- **`DEC-REN-6` — AA por distância à borda + cantos arredondados por *supersample*** (no shader do
  backend hardware), com parâmetros de tema. Reproduzimos a estratégia observada (AA por *feather* e
  arredondamento por soma de amostras em grade) no nosso shader — **escrito do zero** a partir do
  *comportamento*, não do original.
  *Racional:* `REN-E13` observa *feather* e *supersample*; `REN-E14` observa saída dupla para
  composição. Sem isso, bordas e cantos ficam serrilhados.
  *Evidence:* `REN-E13`, `REN-E14`.
  *Escolha nossa:* subpixel opcional em **two-pass horizontal** (mais simples de portar que MRT).

- **`DEC-REN-7` — `PropertySystem` + árvore retida de controles sobre o `RenderPipeline`.**
  A UI é uma **árvore de controles retida** com **propriedades tipadas** (com validação/observação),
  nunca um monólito que chama o backend direto. Os controles traduzem estado em comandos de desenho.
  *Racional:* o alvo tem biblioteca de controles + sistema de propriedades sobre o render context
  (`REN-E27`); isso é exatamente o que um framework de UI moderno faz em TS.
  *Evidence:* `REN-E27`.

- **`DEC-REN-8` — **Proibido** um nó DOM por linha ou por caractere.**
  O texto é desenhado em **Canvas 2D** ou **WebGPU** dentro do *renderer* (Chromium); o DOM serve só
  para a *casca* (menus, diálogos, painéis), nunca para o corpo do editor. Scroll é virtualizado
  (`DEC-REN-4`).
  *Racional:* requisito do alvo-Arcane — 1 nó por linha/caractere causa *layout thrashing* e pressão
  de GC insustentáveis em buffers grandes. O alvo desenha em canvas/GL por natureza (`REN-E18`,
  `REN-E20`); é a mesma conclusão por outro caminho.
  *Evidence:* `REN-E18`, `REN-E20` (padrão de virtualização); restante = decisão de projeto.

---

## 5. 📐 Contratos TypeScript (interfaces/assinaturas do NOSSO código)

> Esboço de **contrato próprio** (nomes/assinaturas nossos). Não é derivado do código do alvo.

```ts
// ---- Geometria e dano -------------------------------------------------
export interface Rect { x: number; y: number; w: number; h: number; }
export type DamageRects = readonly Rect[];

// ---- Instâncias (batching) -------------------------------------------
export interface GlyphInstance {
  readonly atlasX: number; readonly atlasY: number;   // origem no atlas
  readonly atlasW: number; readonly atlasH: number;
  readonly x: number; readonly y: number;             // destino em px lógicos
  readonly color: RGBA;                               // tinta (1º campo, como no alvo)
  readonly subpixel?: SubpixelOffsets;                // two-pass opcional
}
export interface RectInstance { readonly rect: Rect; readonly color: RGBA; readonly radius?: number; }

// ---- Base abstrata do desenho (~31 operações, como REN-E5) -----------
export interface RenderPipeline {
  readonly kind: "webgpu" | "canvas2d";
  beginFrame(viewport: Rect): void;
  setClip(region: Rect | null): void;                  // scissor por região danificada
  pushRects(batch: readonly RectInstance[]): void;     // retângulos (incl. decorado/arredondado)
  pushLines(batch: readonly LineInstance[]): void;     // réguas, sublinhados, squiggles
  pushGlyphs(batch: readonly GlyphInstance[]): void;   // texto (por token)
  flush(): void;                                       // também automático no teto do batch
  present(damage: DamageRects): void;
  dispose(): void;
}

export class WebGPUBackend  implements RenderPipeline { /* storage buffer + instancing */ }
export class Canvas2DBackend implements RenderPipeline { /* drawImage/fillRect no raster   */ }

// ---- Viewport: data source + observers + alvo animado (REN-E19) ------
export interface ViewportObserver { onDamage(rects: DamageRects): void; }
export interface Viewport {
  visibleLineRange(): { first: number; count: number };  // critério nosso (REN-U1)
  subscribe(o: ViewportObserver): () => void;
  scrollTo(line: number, opts?: { animate?: boolean }): void;  // alvo animado
}

// ---- Propriedades/controles retidos (REN-E27) ------------------------
export interface Property<T> { get(): T; set(v: T): void; watch(cb: (v: T) => void): () => void; }
export interface Control { readonly properties: ReadonlyMap<string, Property<unknown>>; paint(p: RenderPipeline): void; }
```

**Invariantes do contrato:**
1. Nenhum backend conhece a árvore de controles; a árvore só emite instâncias.
2. `flush()` é **idempotente** e dispara no teto (8192 glifos) ou no fim de camada.
3. Todo desenho fora de `beginFrame`/`present` é **erro de programação** (asserção em dev).
4. O atlas é a **única** troca de textura do frame de texto (`NEAREST`/`CLAMP_TO_EDGE`).

---

## 6. 🔀 Divergências deliberadas (onde NÃO seguimos o alvo, e por quê)

| # | Alvo | Arcane (nós) | Por quê |
|---|---|---|---|
| D1 | Render na **main thread** da GTK (`REN-E3`) | Shaping/raster de glifos em **worker** com `OffscreenCanvas`; **composição** na main thread | Exceção explícita do enunciado: evita bloquear o frame com shaping pesado, sem introduzir uma “thread de render” compartilhando estado |
| D2 | Backend hardware = **OpenGL 4.1** com *texture buffer* `RGBA32F` + `texelFetch` (`REN-E10`) | **WebGPU** com *storage buffer* + instancing | API idiomática do Chromium; `texelFetch`/texture buffer são exclusivos de GL. Mesmo *padrão* (batch instanciado), outro mecanismo |
| D3 | 17 programas GLSL nomeados, variantes por `#define` (`REN-E9`, `REN-E6`) | **Pipeline único parametrizado** por flags em *bind groups* | Menos superfície de manutenção; a explosão combinatória do alvo vem de otimização de driver que não temos |
| D4 | Fallback de GL: **desconhecido**; caminho observado = diálogo (`REN-E25`, `REN-U3`) | Erro explícito **sem** *fallback* silencioso (`DEC-REN-5`) | Não inventamos comportamento que a evidência não fecha; o usuário escolhe o backend |
| D5 | Skia **estático** embutido + Cairo (`REN-E22`) | `Canvas2DBackend` nativo do Chromium | Zero peso de binário; o Chromium já entrega raster de qualidade |
| D6 | Escolha de backend exige reiniciar o app (`REN-E24`) | Mesmo comportamento no MVP; recriação dinâmica fica para depois | Coerência com o alvo e menor risco; mudança a quente é item futuro |

---

## 7. 🧾 Rastreabilidade

| Conclusão (Evidence IDs) | DEC | Status |
|---|---|---|
| Base abstrata + 2 backends “de verdade”; default CPU (`REN-E4`, `REN-E5`, `REN-E21`, `REN-E23`, `REN-E24`) | `DEC-REN-1` | ✅ adotado |
| Desenho instanciado; tetos 8192/128; buffer de instâncias (`REN-E7`, `REN-E10`, `REN-E11`, `REN-E12`) | `DEC-REN-2` | ✅ adotado (flush = heurística) |
| Texto moldado/rasterizado na CPU; atlas `RGBA8` 1024/4096 (`REN-E15`, `REN-E16`, `REN-E17`, `REN-E20`) | `DEC-REN-3` | ✅ adotado (thread: ver §6/D1) |
| Texto por **token**; gutter separado (`REN-E20`) | `DEC-REN-3`, `DEC-REN-8` | ✅ adotado |
| Viewport = data source + observers + alvo animado (`REN-E19`); frame por *tick* (`REN-E3`) | `DEC-REN-4` | ✅ adotado (`rAF`) |
| Clip por região danificada (`REN-E18`) | `DEC-REN-4` | ✅ adotado (*clip* retangular) |
| Falha de GL = erro visível, não silencioso (`REN-E25`) | `DEC-REN-5` | ✅ adotado |
| Backend por setting + modo efetivo exposto (`REN-E23`, `REN-E24`) | `DEC-REN-1`, `DEC-REN-5` | ✅ adotado |
| AA por *feather* / arredondado por *supersample*; saída dupla (`REN-E13`, `REN-E14`) | `DEC-REN-6` | ✅ adotado (subpixel = two-pass) |
| Biblioteca de controles + sistema de propriedades (`REN-E27`) | `DEC-REN-7` | ✅ adotado |
| Virtualização/sem DOM por linha (`REN-E18`, `REN-E20`) | `DEC-REN-8` | ✅ adotado (requisito) |
| Toolkit GTK3/GLib (`REN-E1`, `REN-E2`) | — | ⛔ **não replicado** (troca de *host*: Chromium) |
| `skia_render_context` sobre Cairo (`REN-E21`, `REN-E22`) | `DEC-REN-1` | 🔁 substituído por `Canvas2DBackend` |
| OpenGL 4.1 / 17 programas (`REN-E6`, `REN-E9`) | `DEC-REN-2`, `DEC-REN-3` | 🔁 substituído por WebGPU |

---

## 8. ⚠️ Incógnitas que afetam este módulo (refs `REN-U*`)

| ID | Incógnita | Impacto no Arcane |
|---|---|---|
| `REN-U1` | **Critério de visibilidade** — algoritmo que enumera as linhas visíveis (o clip por *damage* é observado; a função não) | `DEC-REN-4` define critério **próprio** por índice de linha + *fold*; reavaliar se o alvo for reanalisado |
| `REN-U2` | **Política de flush do batch** (teto vs fim de camada vs teste de textura) | Adotamos **teto** (8192/128) como heurística; pode gerar mais *flushes* que o alvo |
| `REN-U5` | **Formato de pixel / sRGB** — atlas `RGBA8`/BGRA; color space não analisado | Backend assume *framebuffer* **sRGB** e atlas *unorm*; risco de blending errado em tema claro — validar visualmente |
| `REN-U3` | **Fallback** após falha de GL | `DEC-REN-5` opta por **erro explícito**; se o alvo tiver queda automática, reavaliar |
| `REN-U4` | **Shaper** — nenhum `hb_*`; possível shaper interno não nomeado | `DEC-REN-3` usa shaper **próprio**; comportamento de *kerning*/ligaduras é hipótese |
| `REN-U6` | **Nº exato de programas** (17 nomes; tabela pode ter variantes) | Não bloqueia: `DEC-REN-2` parametriza por flags em vez de enumerar programas |

> **Limite limpo:** nada acima autoriza ler o código do alvo. Toda incógnita em aberto é resolvida
> no Arcane por **decisão de projeto documentada** (marcada como escolha nossa) — não por tentativa de
> copiar o original.

---

**Docs irmãos (Fase 2):** [`./01-buffer-e-edicao.md`](./01-buffer-e-edicao.md) ·
[`./02-concorrencia-e-scheduling.md`](./02-concorrencia-e-scheduling.md) ·
[`./03-extensao-e-ipc.md`](./03-extensao-e-ipc.md) ·
[`./05-empacotamento-e-recursos.md`](./05-empacotamento-e-recursos.md) ·
[`./06-padroes-transversais.md`](./06-padroes-transversais.md).
**Insumos (Fase 1):** [`../analysis/render-pipeline.md`](../analysis/render-pipeline.md) ·
[`../analysis/evidence-index.md`](../analysis/evidence-index.md) §7 · [`../analysis/concurrency.md`](../analysis/concurrency.md).
