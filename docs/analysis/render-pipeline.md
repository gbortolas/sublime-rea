# Pipeline de render do núcleo nativo — P1.4 🎨

> **Entregável:** P1.4 — **como** o núcleo (C++) desenha a UI: qual toolkit e contexto de GPU,
> quantos backends de render existem, como o texto/glifos viram pixels, e como o viewport é
> virtualizado. Alvo: o executável ELF64 x86-64 PIE **stripped** `target/sublime_text/sublime_text`
> (`sha256 8b105b1839d7809f60ec186b6c6dcb2d107e22ad23f42c5f8ba7dec67ab43d92`).
> **Regime clean-room:** só **nomes, assinaturas, contagens, tamanhos, endereços e papel
> arquitetural** — nenhum bloco de shader, código ou pseudocódigo do alvo é transcrito. Todo endereço
> é do espaço default do Ghidra (image base `0x100000`; `.text` `0x415120–0xa1e0c9`,
> `.rodata` `0x1ced80–0x2cb5bd`, `.data.rel.ro` `0xa21a00–0xa6c818`). Provider: `ghidra 12.1.4`
> (auto-análise completa) + recon offline (`readelf`/`objdump`/`strings`) + o pacote `Default`.
> **Convenção:** cada afirmação é rotulada **[OBSERVADO]**, **[INFERIDO]** ou **[DESCONHECIDO]**.

**Achado central (1 frase):** o render é uma **abstração única `px_render_context`** (interface de
**31 virtuais**, sem vtable própria ⇒ base abstrata) com **duas implementações concretas** —
**`gl_render_context`** (GPU via **OpenGL 4.1**/**GLSL 4.10**, desenho **instanciado** por
*batches* de retângulos/glifos/linhas guardados num **texture buffer `RGBA32F`**) e
**`skia_render_context`** (CPU: **Skia raster sobre `cairo_image_surface`**) — escolhidas pelo
setting **`hardware_acceleration`** (default **`"none"`** ⇒ software); o **texto é moldado e
rasterizado na CPU** (Pango/FreeType/Cairo) e enviado à GPU como um **atlas de glifos `RGBA8`**;
e o **viewport é virtualizado por scissor por região danificada** (`glScissor`), tudo na
**main/GTK thread** (não há thread de render).

**Docs irmãos (Fase 1):** [`concurrency.md`](concurrency.md) (P1.2 — concorrência) ·
[`buffer-structure.md`](buffer-structure.md) (P1.1 — buffer) ·
[`ipc-protocol.md`](ipc-protocol.md) (P1.3 — wire protocol) ·
[`ipc-plugin-host.md`](ipc-plugin-host.md) (Track A — ponte C++↔Python) ·
[`api-python.md`](api-python.md) (API de plugins) · [`packaging.md`](packaging.md) (P1.6 — empacotamento).

---

## 1. 🔎 Escopo e método

Coleta **summary-first**: recon offline barato primeiro (libs/símbolos/strings), depois o MCP `rea`
sobre o alvo analisado uma única vez para **xrefs, vtables e call-sites**.

| Passo | Ferramenta | Saída usada |
|---|---|---|
| libs do toolkit | `readelf -d` / `--dyn-syms` | `NEEDED`, imports de `libGL`/GDK/GLib |
| nomes de classe | `strings` + RTTI Itanium `<len><nome>` | catálogo de classes (§8, Anexo A) |
| shaders embutidos | `strings -t x` | GLSL `#version 410`, defines, uniformes |
| vtables/typeinfo | `rea` · `xrefs` / `read_bytes` | hierarquia de `*_render_context`, tamanho de vtable |
| fluxo | `rea` · `analyze_function` / `batch_decompile` | compilação de shader, atlas, scissor |
| defaults de produto | `Default.sublime-package` | `hardware_acceleration`, `font_options` |

O binário é **stripped** (sem `.symtab`); os nomes de classe sobrevivem só como **type descriptors
de RTTI (Itanium ABI)** em `.rodata`/`.data.rel.ro`, no formato `<len><nome>` (ex.: `17gl_render_context`).
Os símbolos de **GTK/GDK/GLib, Cairo, FreeType e GL** são resolvidos por **`dlsym`** em funções de
inicialização (`_INIT_*`), logo os *call-sites* são **indiretos** e não ligáveis estaticamente.

---

## 2. 🪟 Toolkit, janela e contexto de GPU

- **Toolkit = GTK3/GLib** [OBSERVADO]: `NEEDED` lista `libgobject-2.0`, `libglib-2.0`, `libGL.so.1`,
  `libX11.so.6`; o **GTK** em si é resolvido em runtime (não está em `NEEDED`) e suas funções vêm por
  **`dlsym`** no inicializador `_INIT_73` (`0x647295`): entre outras, `gtk_main`, `gtk_widget_add_tick_callback`,
  `gdk_window_invalidate_rect` (`0x1e4847`), `gdk_cairo_draw_from_gl` (`0x1ec42f`),
  `gdk_window_create_gl_context` (`0x1ea3cf`). **Zero referências a Qt** — reforça a refutação do P1.2.
- **Contexto de GPU vem da GTK** (`GdkGLContext`) [OBSERVADO]: `gdk_window_create_gl_context` +
  `gdk_gl_context_realize/make_current/clear_current/set_required_version`. O `gl_render_context`
  pede **OpenGL ≥ 4.1** (coerente com `GLSL 4.10`) e registra **debug callback**
  (`glDebugMessageCallbackARB`, strings `OpenGL: Registered debug callback`,
  `OpenGL Context Information:`, `0x1fa27f`).
- **Composição do frame** [INFERIDO, confiança média]: a GTK desenha com Cairo; o conteúdo renderizado
  em GL (FBO) é **blitado para o `cairo_t`** por `gdk_cairo_draw_from_gl`. O *call-site* é indireto
  (dlsym), daí o rótulo inferido.
- **Quem chama o desenho** [OBSERVADO]: há `gtk_widget_add_tick_callback` (frame/tick da GTK) e
  `gdk_window_invalidate_rect` (invalidação de retângulo). **Não** existe thread de render: as únicas
  threads nomeadas do núcleo são `io_worker` e `file_read_thread` (ver P1.2) ⇒ **o render roda na
  main/GTK thread** [INFERIDO forte].

---

## 3. 🧩 A abstração: `px_render_context` e as duas implementações

| Tipo (RTTI) | typeinfo | `_ZTV` (vtable) | Papel |
|---|---|---|---|
| `px_render_context` | `0xa4e080` (nome `0x23bdf0`) | **ausente** | **base abstrata** (interface de render) |
| `gl_render_context` | `0xa4e090` (base `0xa4e080`) | `0xa4df78` | backend **GPU / OpenGL** |
| `skia_render_context` | `0xa4dd50` (base `0xa4e080`) | `0xa4dc48` | backend **CPU / Skia raster** |

- **A interface tem exatamente 31 slots virtuais** nas duas implementações
  (`gl`: `0xa4df88–0xa4e078`; `skia`: `0xa4dc58–0xa4dd48`) [OBSERVADO] — ou seja, o contrato do
  `px_render_context` cobre **31 operações de desenho/estado** (retângulos, texto/glifos, linhas,
  clip/scissor, superfície, etc.).
- A base **não emite vtable** ⇒ é abstrata (nunca instanciada diretamente) [OBSERVADO].
- **Decisão do backend** [OBSERVADO]: `FUN_00638250` lê o setting `hardware_acceleration`
  (`0x1e7876`); se habilitado com `opengl`, liga um **bit de estado `0x20000`** que seleciona o
  caminho GL. Caso contrário vale o backend software (ver §7).
- `gl_render_data_loader` deriva de **`texture_loader::subscriber`** (typeinfo `0xa4ded0`,
  base `0xa4dec0`): a **carga de texturas é assíncrona e notificada por *subscriber*** [OBSERVADO].

---

## 4. 🖥️ Pipeline OpenGL

### 4.1 Compilação de shaders e defines

`FUN_007ce084` (`0x7ce084`) **monta o shader em tempo de execução**: prefixa `#version 410`, injeta
os `#define` de configuração do programa e os limites do renderer, e então chama
`glCreateShader`/`glShaderSource`/`glCompileShader`/`glGetShaderiv`/`glGetShaderInfoLog` — com
**cache de shaders compilados** (estrutura de árvore). Os **defines globais** [OBSERVADO]:

| Define | Valor | Papel |
|---|---|---|
| `MAX_GLYPH_INSTANCES` | **8192** (`0x2000`) | teto de instâncias por batch de glifos |
| `MAX_STENCIL_QUAD_INSTANCES` | **128** (`0x80`) | teto de quads de stencil (clip) |
| `ANTIALIAS_FEATHER` | **0.5** | largura da "pena" de antialiasing no shader |
| `SUPERSAMPLE` | (flag) | antialiasing de cantos/bordas por **8× (grade de 16 com metade)** |

**Flags de programa** (ligadas/desligadas por `#define` por variante) [OBSERVADO]:
`TEXTURED`, `REPEAT`, `ROUNDED`, `BORDERED`, `CLIPPED`, `FADED`, `SUBPIXEL_INTERP`, `STIPPLED`,
`SQUIGGLE`, `ANTIALIAS`, `NO_THREE_CHANNEL_ALPHA`.

O *link* é feito por `FUN_007bd303` (`0x7bd303`, **construtor do contexto GL**): percorre uma
**tabela de programas**, compila `.vert` (tipo `0x8b31`) + fragmento (tipo `0x8b30`) e chama
`glCreateProgram`/`glAttachShader`/`glLinkProgram`/`glGetProgramiv`.

### 4.2 Tabela de programas (17) [OBSERVADO]

Os nomes dos programas vivem em `.rodata` (`0x1d0f74…0x1fa2ef`):

| Família | Programas | O que desenha |
|---|---|---|
| retângulos | `filled_rect`, `filled_rect_textured`, `filled_rect_textured_repeated` | fundos, imagens (com/sem repetição) |
| retângulos decorados | `rect_bordered`, `rect_rounded`, `rect_rounded_bordered` | bordas e cantos arredondados |
| linhas | `bezier_line`, `bezier_line_stippled`, `bezier_line_antialiased`, `bezier_line_antialiased_stippled` | sublinhados, squiggles, réguas, **com stipple e AA** |
| glifos | `glyph_colored`, `glyph_subpixel`, `glyph_clipped`, `glyph_clipped_colored`, `glyph_clipped_subpixel`, `glyph_faded`, `glyph_faded_colored` | texto (ver §5) |

Total: **17 programas nomeados**. `filled_rect`= `0x1da076`, `bezier_line_antialiased` = `0x1d0f74`,
`rect_rounded` = `0x1ec404`, `glyph_clipped` = `0x1d2f80` (amostras de endereço).

### 4.3 Modelo de instância — *batches* num **texture buffer**

O coração do backend GL é **desenho instanciado**: em vez de uma chamada por primitiva, o núcleo
acumula *instâncias* numa estrutura linear e faz **um** `glDrawArraysInstanced` por batch.

- **Buffer de instâncias** (`FUN_007cde73`, `0x7cde73`) [OBSERVADO]: `glGenBuffers`/`glGenTextures`,
  `glBufferData(…, GL_DYNAMIC_DRAW)` e **`glTexBuffer(GL_TEXTURE_BUFFER, GL_RGBA32F, …)`** — o array de
  instâncias é exposto ao vertex shader como um **`samplerBuffer`** (`uniform samplerBuffer instances`),
  lido por `texelFetch(instances, gl_InstanceID * N + k)`.
- **Cada instância = N texels `RGBA32F`** (4× `float32` = **16 B por texel**) com **stride
  N ∈ {2, 3, 4, 5}** conforme a família de programa [OBSERVADO nos shaders: `0x1f46b3` (2/3),
  `0x1eebf8` (3), `0x1db721` (3/4), `0x1f5ddf` (4/5)]. O **primeiro texel é sempre a cor/tinta**
  (vec4); os seguintes codificam, tipicamente, **posição+tamanho** (vec4), **origem+tamanho na textura**
  (vec4) e, para linhas/retângulos, **duas linhas de matriz** `mat0`/`mat1` (2×vec4) + **stipple** — o
  que dá o stride 4/5.
- **Desenho** [OBSERVADO]: `glDrawArraysInstanced` a partir de `0x7ce638`/`0x7d4858` (e mais 5 sites).
- **Capacidade do batch**: os limites `MAX_GLYPH_INSTANCES` (8192) e `MAX_STENCIL_QUAD_INSTANCES` (128)
  sugerem **flush do batch ao atingir o teto** [INFERIDO].

### 4.4 Antialiasing, arredondamento e clip

- **AA por "pena" (feather)**: o fragment shader mistura por distância à borda (`smoothstep` com
  `ANTIALIAS_FEATHER 0.5`) [OBSERVADO via strings de shader].
- **Cantos/bordas arredondadas**: decoração de retângulo por soma de amostras — o shader soma
  `render_rect_decoration(...)` em **offsets em grade** (razão da **flag `SUPERSAMPLE`**, "8×/16× em
  grade") [OBSERVADO]. `max`/`squiggle_width` e afins aparecem como parâmetros de tema.
- **Clip por stencil**: há um *programa/pass* de **quads de stencil** com teto de 128 instâncias
  (`MAX_STENCIL_QUAD_INSTANCES`) [OBSERVADO].
- **Clip por região**: `glScissor` é chamado do *init* (`0x7befed`) e de **dois métodos da vtable do
  `gl_render_context`** (`0x7d2772`, `0x7d2d80`) [OBSERVADO] ⇒ **scissor por retângulo danificado**.
- **Saída MRT** [OBSERVADO]: os shaders de glifo declaram **duas saídas** (`frag_color` em
  `location=0` e `frag_alpha` em `location=0,index=1`) — a segunda carrega o **alpha** para compor
  (necessário no modo subpixel/GL de três canais).

---

## 5. 🔤 Texto e glifos (moldagem na CPU, atlas na GPU)

- **Moldagem/rasterização ficam na CPU** [OBSERVADO]: `FT_Load_Glyph` (`0x1eb24e`) e
  `cairo_ft_scaled_font_lock_face` (`0x1d44b4`) são resolvidos por dlsym (`_INIT_69`/`_INIT_70`,
  `0x646854`/`0x646f8a`); há também `pango_font*` e `cairo_*` (show_glyphs). Ou seja: **o texto é
  moldado/rasterizado por Pango/FreeType/Cairo na CPU** e só o **bitmap do glifo** vai pra GPU.
  **Shaper próprio (HarfBuzz) não foi encontrado** — nenhuma string `hb_*`/`harfbuzz` [DESCONHECIDO
  se há um shaper interno não nomeado].
- **Atlas de glifos** [OBSERVADO]: textura 2D quadrada **`RGBA8`, 1 mip**, filtro `GL_NEAREST`,
  wrap `GL_CLAMP_TO_EDGE` (`FUN_007cfdfe`, `0x7cfdfe`); lado **1024 (`0x400`) ou 4096 (`0x1000`)**;
  **upload por `glTexSubImage2D` com `GL_BGRA`/`GL_UNSIGNED_BYTE`** (`FUN_007cfc44`) — entrada em
  ordem BGRA, com **origem Y invertida** no posicionamento do atlas. Driver: `FUN_007cfd2c` ←
  `0x7cebb6`/`0x7d0336`.
- **Batch de glifos** [OBSERVADO]: `gl_glyph_cache_batch` é **interface abstrata** (typeinfo
  `0xa4df50`, sem vtable) com **dois implementadores anônimos `batch`** (vtables `0xa4dee8`/`0xa4df28`,
  **3 slots cada**) — permite empacotar os glifos visíveis e emitir **poucas** chamadas instanciadas.
- **Subpixel** [OBSERVADO]: há programa `glyph_subpixel` e a flag `SUBPIXEL_INTERP`; o shader de glifo
  carrega `subpixel_x`, `left_edge_x`/`right_edge_x` (limites do glifo para o blend horizontal) e
  `fade_start`/`fade_end`, `clip_start`/`clip_end` (fade e corte por coluna). O setting de produto
  `font_options` documenta `no_antialias` / `gray_antialias` / `subpixel_antialias` (`0x1e7876`-vizinho).
- **Cache**: a família `FontFactory`/`UnicodeFont`/`px_font_face` (RTTI) + `LayoutTracker`/
  `TokenStorage`/`SyntaxLoader` (Anexo A) cobre **fonte → layout → tokens**; o batch de glifos
  (~28 B por registro, hash-stride `0x60010` [OBSERVADO]) é o índice de cache de glifos [INFERIDO].
  `MAX_GLYPH_INSTANCES = 8192` limita o batch por flush.

---

## 6. 📐 Viewport virtualizado e *damage*

- **Modelo de viewport** [OBSERVADO por RTTI]: família de controles
  `viewport_control` (`0xa47b00`), `scroll_area_control` (`0x23a4cc`), `scroll_bar_control`,
  `scroll_corner_control`, `scroll_track_control`, `scroll_data_source` (+ `subscriber`),
  `scroll_target`, `scroller`, e **comandos/animações** (`scroll_lines_command`,
  `scroll_animation`, `scroll_adjust_animation`, `scroll_target_size_animation`,
  `scroll_target_size_animation`) + variantes `console_/output_/skyline_scroll_area_control`.
  Ou seja: o deslocamento é um **alvo animado** com **fonte de dados (data source) que notifica
  subscribers** — o mesmo padrão *observer* do loader de texturas.
- **Virtualização + damage** [OBSERVADO]: a invalidação vem de `gdk_window_invalidate_rect` e o clip de
  desenho é feito por **`glScissor` por região** (`0x7d0b9e`, chamado do init e de dois métodos da
  vtable de `gl_render_context`). ⇒ **só a região danificada é redesenhada**; o resto do buffer é
  descartado/exposto por *scroll*, não re-renderizado [INFERIDO].
- **Renderização de conteúdo de texto**: `TokenRenderer` (`0x25c134`), `gutter_renderer` /
  `default_gutter_renderer` (`0x25c15e`/`0x25c144`) — o texto é renderizado **por tokens** (não por
  caractere), com *gutter* separado. **A função exata que calcula o range de linhas visíveis** não foi
  pinada [DESCONHECIDO] — o mecanismo de *damage* (scissor) é observado, mas o **critério** de
  "o que entra no batch" é inferido do padrão damage/scroll.

---

## 7. 🐌 Fallback software e erro de GL

- **Caminho software = `skia_render_context` sobre Cairo** [OBSERVADO]: `FUN_007bc762` (`0x7bc762`)
  cria uma **superfície Cairo de imagem** (`cairo_image_surface`) e `FUN_007c6ed2` constrói o
  `skia_render_context`; o desenho usa a ponte `cairo_*` (scale/set_source_surface/rectangle/fill…),
  resolvida por dlsym. **Skia está embutido estaticamente** (RTTI `SkCanvas`, `SkSurface_Base`,
  `SkBitmapDevice`, `SkImage_Raster`, `SkARGB32_Blitter`, `SkSwizzler`, `SkLinearBitmapPipeline`;
  caminho de build `.../third_party/skia/src/core/...`) — **backend Skia raster (CPU)**, sem Ganesh/GL
  aparente (nenhum `GrGL*`/`GrContext` encontrado).
- **`hardware_acceleration`** [OBSERVADO no pacote `Default`]: default **`"none"` (CPU)**;
  modo **`"opengl"`** exige **GL ≥ 4.1**; trocar exige **reiniciar o app**. `font_options` documenta
  `no_antialias`/`gray_antialias`/`subpixel_antialias` (e `theme_font_options`).
- **Falha ao iniciar GL**: `FUN_007c1555` (`0x7c1555`, string `Failed to initialize OpenGL rendering:`
  `0x1ec39f`) → `FUN_007c1600` monta um **diálogo GTK modal** (`gtk_message_dialog`/`gtk-ok`) — é
  **erro visível**, **não** fallback silencioso [OBSERVADO]. Se, depois de falhar, o app cai
  automaticamente para `skia_render_context`: **[DESCONHECIDO]**.

---

## 8. 🧱 UI construída em controles (bônus de escopo)

O render não é um monólito: sobre `px_render_context` há uma **biblioteca de controles** com um
**sistema de propriedades** (`property_impl<Controle, Tipo>` / `compound_property_impl` /
`property_alias_impl`) e RTTI visível (Anexo A). Exemplos: `label_control`, `text_line_control`,
`html_control`/`html_line_control`, `themed_control`, `texture_box`, `tab_control`, `tree_control`,
`table_control`, `button_control`, `icon_button_panel`, `grid_layout_control`,
`manual_layout_container_control`, `skyline_text_control`, `phantom_text_control`,
`plugin_text_widget_control`, `history_text_control`, `sheet_tab_control`, `side_bar_vcs_row`.
Isso confirma o padrão **retained-mode widget tree sobre um render context abstrato** — o mesmo que
um framework de UI moderno adota.

---

## 9. 🧭 Síntese para a Fase 3 (Electron/TS)

Padrões a **replicar** (não o código):

1. **Um único `RenderContext` abstrato + backends**: defina uma interface TS (`RenderContext`) com
   ~30 operações (retângulo, retângulo decorado, linha, glifo, clip/scissor, superfície) e implemente
   **`WebGPU/WebGL2`** (hardware) e **`Canvas2D`** (software), escolhidos por um knob estilo
   `hardware_acceleration`. Mantenha os **dois caminhos** de verdade (o alvo mantém, e o software é o default).
2. **Batching instanciado**: acumule primitivas num *array* tipado e emita **poucas** chamadas de
   desenho; no alvo o array vai num **texture buffer `RGBA32F`** lido por `texelFetch`. Em WebGPU,
   use **storage buffer** (`array<Instance>`); em WebGL2 (sem texture buffer / sem `texelFetch`),
   caia para **batching + `instanceID`-por-atributo** ou desenho não-instanciado. **Flush por teto**
   (o alvo usa 8192 glifos) evita buffers gigantes.
3. **Texto: moldar/rasterizar na CPU, compor na GPU**: rasterize glifos (OffscreenCanvas / uma lib de
   shaping) e suba um **atlas `RGBA8` 1024/4096 com `GL_NEAREST`/`CLAMP_TO_EDGE`**, indexado por um
   **cache de glifos**; suporte a **subpixel** (two-pass horizontal) e **fade por linha** opcionais.
4. **Virtualização por damage**: calcule o retângulo danificado e faça **scissor nele**; re-renderize
   só a região afetada e trate o resto por *scroll*. Mantenha o modelo **`scroll_data_source` +
   subscribers + alvo animado** para o viewport.
5. **Threading**: o alvo **renderiza na main/GTK thread** (sem thread de render). No Electron, faça o
   mesmo no `renderer` (canvas) **ou** isole o raster em `OffscreenCanvas`/Worker — mas **não** invente
   uma thread de render compartilhando estado sem necessidade.
6. **Erro explícito**: se o backend de hardware falhar ao inicializar, **mostre erro** (como o alvo);
   não degrade em silêncio — e exponha o modo efetivo (o alvo loga `OpenGL Context Information:`).

---

## 10. 🕳️ [DESCONHECIDO] e limites desta análise

- **Critério de visibilidade**: a função que enumera "linhas visíveis" não foi pinada; sabe-se que o
  clip é por `glScissor` de região danificada, mas não o algoritmo de cálculo.
- **Flush do batch**: o teto de instâncias é observado (8192/128), mas a política exata de *flush*
  (teto vs fim de camada vs teste de textura) é inferida.
- **Fallback após falha de GL**: se há queda automática silenciosa para `skia_render_context` é
  desconhecido (o caminho observado é um diálogo de erro).
- **Shaper**: nenhum HarfBuzz/`hb_*`; não se sabe se há shaping próprio não nomeado.
- **Escolha de formato de pixel / sRGB**: o atlas é `RGBA8`/entrada BGRA; a gestão de color space
  (sRGB vs linear) não foi analisada.
- **Nº exato de programas**: 17 nomes são observados; a tabela de programas pode conter entradas não
  nomeadas ou variantes por flag [limite: enumeração por strings, não por varredura da tabela].

---

## 📎 Anexo A — catálogo de classes relevante (RTTI, `[OBSERVADO]`)

Total de **~1.184** strings de typeinfo simples (além de 386 mangled) em `.rodata`; as relevantes ao
render/UI:

- **Buffer/índice:** `TextBuffer`, `TokenStorage`, `BufferSource`, `FileBufferSource`, `LayoutTracker`,
  `FoldData`, `SyntaxLoader`, `SelectorStyler`, `Styler`.
- **Fonte/texto:** `FontFactory`, `UnicodeFont`, `MockFontFactory`, `MockUnicodeFont`, `NullFont`,
  `px_font_face`, `pango_font`, `fx_font`, `font_descriptor`, `font_size_t`,
  `compound_property_impl<…, font_descriptor>`.
- **Render/GPU:** `px_render_context`, `gl_render_context`, `skia_render_context`,
  `gl_render_data_loader`, `gl_glyph_cache_batch`, `TokenRenderer`, `gutter_renderer`,
  `default_gutter_renderer`, `texture_loader`(+`subscriber`), `Sprite_F16`, `Sprite_sRGB`, `Canvas`.
- **Viewport/scroll:** `viewport_control`, `scroll_area_control` (+`console_`/`output_`/`skyline_`),
  `scroll_bar_control`, `scroll_corner_control`, `scroll_track_control`, `scroll_data_source`,
  `scroll_target`, `scroller`, `scroll_*_command`, `scroll_*_animation`.
- **Controles/UI:** `label_control`, `text_line_control`, `html_control`, `html_line_control`,
  `themed_control`, `texture_box`, `tab_control`, `tabset_control`, `tree_control`, `table_control`,
  `button_control`, `checkbox_control`, `icon_button_panel`, `grid_layout_control`,
  `manual_layout_container_control`, `history_text_control`, `sheet_tab_control`, `side_bar_vcs_row`,
  `skyline_text_control`, `phantom_text_control`, `plugin_text_widget_control`.
- **HTML embutido (`minihtml`):** `minihtml::render_node`, `minihtml::text_node`,
  `minihtml::font_face`, `minihtml::font_factory`.

---

## 🧾 Ledger de evidências (P1.4)

| ID | Fonte (endereço/artefato) | Tipo | O que prova | Limite |
|---|---|---|---|---|
| E1 | `readelf -d`/`--dyn-syms` do alvo | [OBSERVADO] | toolkit = GTK3/GLib (`NEEDED`: `libglib/gobject`, `libGL`, `libX11`); GTK por dlsym | GTK em runtime |
| E2 | `_INIT_73` `0x647295`; strs `0x1ec42f`/`0x1ea3cf`/`0x1e4847` | [OBSERVADO] | GDK/GTK por `dlsym` (contexto GL, blit GL→cairo, invalidate) | call-sites indiretos |
| E3 | `gtk_widget_add_tick_callback` `0x1d202f`; P1.2 (sem thread de render) | [OBSERVADO]/[INFERIDO] | frame em tick da GTK; render na **main thread** | — |
| E4 | typeinfo `0xa4e080`/`0xa4e090`/`0xa4dd50` | [OBSERVADO] | base abstrata `px_render_context` + `gl_`/`skia_render_context` | sem vtable da base |
| E5 | vtables `0xa4df78`/`0xa4dc48`, slots `0xa4df88–0xa4e078`/`0xa4dc58–0xa4dd48` | [OBSERVADO] | interface de **31 virtuais** idêntica nas duas | contagem por varredura |
| E6 | `FUN_007ce084` `0x7ce084` | [OBSERVADO] | monta `#version 410` + `#define`s e compila shader; cache | — |
| E7 | defines `MAX_GLYPH_INSTANCES` `0x1d8de1`, `MAX_STENCIL_QUAD_INSTANCES` `0x1f5dad` | [OBSERVADO] | tetos **8192** e **128** | valores por imediato |
| E8 | `FUN_007bd303` `0x7bd303` | [OBSERVADO] | link de programas `.vert`(`0x8b31`)+frag(`0x8b30`) | nº por tabela não totalmente enumerado |
| E9 | nomes `0x1d0f74…0x1fa2ef` | [OBSERVADO] | **17 programas** (`filled_rect*`, `glyph_*`, `bezier_line*`, `rect_*`) | via strings |
| E10 | `FUN_007cde73` `0x7cde73` | [OBSERVADO] | instâncias num **texture buffer `RGBA32F`** (`glTexBuffer`, `GL_DYNAMIC_DRAW`) | — |
| E11 | shaders `0x1f46b3`(2/3), `0x1eebf8`(3), `0x1db721`(3/4), `0x1f5ddf`(4/5) | [OBSERVADO] | **stride N∈{2,3,4,5}** texels `RGBA32F`; elem0 = cor | layout exato por família |
| E12 | `glDrawArraysInstanced` (`0x7ce638`/`0x7d4858` + 5) | [OBSERVADO] | desenho **instanciado** por batch | política de flush [INFERIDO] |
| E13 | strs `ANTIALIAS_FEATHER` `0x1f5f51`/`0x1f7855`, `SUPERSAMPLE` `0x1f3d82`, `render_rect_decoration` | [OBSERVADO] | AA por feather (0.5) e rounded por **8× supersample** | — |
| E14 | shaders de glifo: `frag_color`/`frag_alpha` (MRT) | [OBSERVADO] | saída dupla (cor + alpha) p/ composição/subpixel | — |
| E15 | `0x7cfdfe` / `0x7cfc44` / `0x7cfd2c` | [OBSERVADO] | atlas de glifo `RGBA8` 2D, `NEAREST`/`CLAMP_TO_EDGE`, upload BGRA/UBYTE, lado 1024/4096 | lado ambíguo |
| E16 | `FT_Load_Glyph` `0x1eb24e`, `cairo_ft_scaled_font_lock_face` `0x1d44b4`, `_INIT_69/70` `0x646854`/`0x646f8a` | [OBSERVADO] | moldagem/rasterização **CPU-side** (Pango/FT/Cairo) | shaper próprio [DESCONHECIDO] |
| E17 | typeinfo `0xa4df50`/`0xa4df10`/`0xa4df60` | [OBSERVADO] | `gl_glyph_cache_batch` abstrata + 2 `batch` (3 slots) | — |
| E18 | `glScissor` `0x7d0b9e` ← `0x7befed`/`0x7d2772`/`0x7d2d80` | [OBSERVADO] | clip por região danificada (damage) | critério de visibilidade [DESCONHECIDO] |
| E19 | RTTI `viewport_control` `0xa47b00`, `scroll_area_control` `0x23a4cc`, `scroll_data_source`(+`subscriber`), `scroll_*_animation` | [OBSERVADO] | viewport = **data source + observers + alvo animado** | — |
| E20 | `TokenRenderer` `0x25c134`, `gutter_renderer` `0x25c15e` | [OBSERVADO] | texto renderizado **por token**, *gutter* separado | — |
| E21 | `FUN_007bc762` `0x7bc762`, `FUN_007c6ed2` `0x7c6ed2` | [OBSERVADO] | backend software = `skia_render_context` sobre `cairo_image_surface` | — |
| E22 | RTTI Skia (`SkCanvas`/`SkSurface_Base`/`SkImage_Raster`/`SkBitmapDevice`), path `third_party/skia/...` | [OBSERVADO] | **Skia estático, raster (CPU)**; sem Ganesh/GL | — |
| E23 | `FUN_00638250` `0x638250`; str `hardware_acceleration` `0x1e7876` | [OBSERVADO] | backend escolhido pelo setting; bit de estado `0x20000` | — |
| E24 | `Default.sublime-package` → `Preferences.sublime-settings` | [OBSERVADO] | `hardware_acceleration: "none"`; modo `"opengl"` ≥ 4.1; `font_options`/`theme_font_options` | artefato de produto, não binário |
| E25 | `FUN_007c1555` `0x7c1555` → `FUN_007c1600`; str `0x1ec39f` | [OBSERVADO] | falha de GL = **diálogo modal**, não fallback silencioso | queda automática [DESCONHECIDO] |
| E26 | `Default.sublime-package` → `Preferences.sublime-settings` | [OBSERVADO] | **fecha** P1.2/E18: defaults `io_workers: 2`, `index_workers: 0` | — |
| E27 | catálogo RTTI `.rodata` (`~1184` simples + `386` mangled) | [OBSERVADO] | biblioteca de **controles + sistema de propriedades** sobre o render context | enumeração por strings |

---

**TL;DR:** **GTK3** dá a janela e o **`GdkGLContext`**; o desenho é uma **interface de 31 virtuais**
(`px_render_context`) com backend **OpenGL 4.1 instanciado** (17 programas nomeados em `.rodata`,
instâncias em **texture buffer `RGBA32F`**, atlas de glifos `RGBA8` de até 4096², clip por
**`glScissor`** de região danificada) e backend **CPU** (**Skia raster sobre Cairo**, o default de
fábrica); o **texto é moldado/rasterizado na CPU**; o render roda na **main thread**. Para a Fase 3:
uma interface de render + 2 backends, batching instanciado, atlas de glifos e virtualização por damage.
