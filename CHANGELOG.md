# Changelog — Scribe

Todas as mudanças notáveis neste projeto.

---

## [0.5.0] — 2026-10-21

### ✨ 5 features

- **🗃️ Undo por documento** — a pilha de undo era **global**: desfazer na aba B aplicava os deltas
  da aba A no buffer de B (texto corrompido). Agora cada documento tem a sua linha do tempo
  (`UndoTarget.scopeId()`, `undoDepthFor(scope)`); `canUndo`/`canRedo` são **por documento**.
- **🧩 DAP: logpoints + hitCondition** — o painel de depuração agora edita os **3** campos do
  breakpoint (`condition`, `hitCondition`, `logMessage`), com badge de "log"; o `logMessage` chega
  ao adaptador (logpoint) e o `hitCondition` limita a Nª ocorrência.
- **🖥️ Soft wrap em rows visuais** — caret, seleção, busca, gutter e diagnósticos passam a usar a
  **row visual** da linha quebrada (antes ficavam na row lógica ⇒ cursor fora do texto); o scroll
  também passa a contar rows (`VisualRowIndex` + mapper do viewport).
- **⌨️ Ctrl+D / Alt+Shift+↑↓ / Ctrl+Shift+L** — multi-cursor ao estilo VS Code: o Ctrl+D **acrescenta**
  a próxima ocorrência da palavra sob o cursor (respeitando limites de palavra), o Alt+Shift
  acrescenta cursor na linha vizinha e o Ctrl+Shift+L seleciona todas as ocorrências. As setas
  passam a mexer **só no cursor primário**, sem colapsar o conjunto.
- **📦 Snippets de pacote** — os arquivos **`.sublime-snippet`** dentro dos pacotes (`Packages/<Nome>/snippets/`)
  são lidos (`prefix`/`body`/`description`, com precedência `user > app > os`) e passam a expandir
  pelo mesmo pipeline dos embutidos (tab stops, escolhas, espelhos, transformações).

---

## [0.4.1] — 2026-10-21

### 🐛 Varredura de usabilidade (o app estava "inutilizável")

- **Soft wrap sobreposto** — a continuação de uma linha quebrada era desenhada **na mesma
  coordenada Y** da linha seguinte (texto ilegível) e as linhas que cabiam eram quebradas à toa
  (cópia do algoritmo de wrap sem o early-exit). Agora as rows visuais são **acumuladas** e o
  render usa a implementação canônica `wrapLine`.
- **Overlays no boot** — o painel de depuração, a barra de depuração e o popup de referências
  abriam **por cima do editor** (`display:flex` inline vencia o `[hidden]` do UA). Regra global
  `[hidden]{display:none!important}` + o atributo `hidden` voltou a ser a fonte da verdade.
- **Tipografia "frankenstein"** — botões/inputs caíam no **Arial 13.33px** do UA (sem
  `font: inherit`); token `--s-font` inexistente; escalas divergentes. Agora há **uma** família e
  **uma** escala para toda a casca (a escala do canvas é separada, por design).
- **Não dava para editar** — o teclado vive no `<canvas>` e o foco **não** voltava para ele ao
  abrir/trocar de documento ⇒ digitar não fazia nada. Agora o foco volta ao canvas (abrir,
  trocar de aba, fechar find bar/painel).
- **O app morria ao fechar o painel de depuração** — o botão "×" chamava `close()`, que no
  escopo do painel resolve para o **`window.close()` global** ⇒ a janela fechava e o app saía
  (exit 0). Agora são `openPanel()`/`closePanel()` locais.
- **Minimap em blocos cinzas** — a altura da linha escalava com o documento (`h/lineCount`) e a
  barra ocupava a largura toda. Agora: altura **fixa** (3px) e largura **proporcional** à linha.
- **Texto por baixo do minimap** — a largura útil do texto agora desconta a faixa do minimap.
- **Popups sobrepostos** — completion, hover, signature, references e symbols podem coexistir;
  agora **um popup de contexto por vez** (e o de code actions não fica órfão no DOM).
- **Plugin host nunca subia** — `utilityProcess.postMessage` **não clona** `MessagePortMain`
  (nem `MessagePort` do worker_threads) ⇒ "An object could not be cloned" em todo boot. O
  transporte passou a ser o **canal nativo** do `utilityProcess` (`process.parentPort`).
- **Janela** — 1024×768 → 1280×820 (com `minWidth`/`minHeight`).

### ✨ Novas features

- **Lupa de código no minimap** — preview **ampliado (×2.5)** e **colorido** do código sob o
  mouse, com a linha sob o cursor destacada e o marcador do caret; segue o arrasto. O minimap
  passou a ser **colorido** (janela = range visível ⇒ os spans de sintaxe existem).
- **Multi-cursor de verdade** — digitar/apagar com **N cursores** edita nos N lugares, os N
  cursores sobrevivem à edição e **um Ctrl+Z desfaz tudo e restaura o conjunto de cursores**
  (o `CommandBus` passou a gravar `selectionsBefore/After` no passo de undo).
- **Snippets: dropdown de escolhas + variáveis TM** — `${1|a,b,c|}` abre um popup de escolha
  (antes usava sempre a 1ª) e `$TM_FILENAME`, `$TM_SELECTED_TEXT`, `$TM_CURRENT_LINE`… são
  resolvidas na expansão.

---

## [0.4.0] — 2026-10-18

### 🚀 Performance

- **Tokenização em worker com deadline** — `TaskKind: "syntax"` no TaskPool: gramática serializada
  (`SerializedGrammar`), delega tokenização >50 linhas ao worker com deadline via `Atomics`.
  Mata o O(end) em deep scroll + keystroke. ✅
- **Batching de teclas (Fase B)** — keystrokes aplicados localmente (latência zero) e enviados
  como lote no próximo rAF — transação única, 1 revisão, 1 `document.changed`. ✅
- **Resultado rico do `document.insert`** — 1 IPC roundtrip em vez de 3 (redução de 66%).
- **Cache incremental de tokenização** — diff de linhas, trunca só da 1ª alterada.
- **Performance profiling** — startup 203ms, render 280 FPS, memória 15.4 MB, zero leaks.

### 🧩 LSP Client

- **P4#16 — LSP Client** — conexão a servidores TypeScript e Python com diagnóstico,
  completação e hover. `src/core/lsp/` (protocolo, transporte stdio, cliente JSON-RPC, manager).
- **P4#17 — Diagnósticos no gutter** — ícones de severidade (error/warning/info/hint) na faixa de linha.
- **P4#18 — Go-to-definition** — F12 ou Ctrl+click navega para definição.
- **P4#19 — Signature help** — popup de assinatura ao digitar `(`.
- **P4#20 — Document symbols** — Ctrl+Shift+O com popup de filtro incremental.
- **P5#21 — Code Actions** — Ctrl+. dispara popup com quick fixes e refactoring.
- **P5#22 — Find References** — Ctrl+Shift+F12 lista referências do símbolo.
- **P5#23 — Rename Symbol** — F2 renomeia símbolo via LSP.

### 🎨 UI/UX

- **Repaginação do design (VS Code-like)** — casca com activity bar, painel lateral, breadcrumbs,
  ícones SVG inline, rail só com o que existe.
- **Tema como fonte única** — `EditorTheme` espelhado em CSS custom properties `--s-*`;
  paletas Dark/Light Modern.
- **Minimap Avançado** — syntax colorida no canvas, marcadores de busca e diagnóstico.
- **Minimap Hover Preview** — tooltip com código real e syntax highlighting no minimap.
- **Seleção de texto** — estado de seleção (anchor + active), highlight visual, operações
  (delete/substituir), navegação, mouse click+drag.
- **Gutter com números de linha** — faixa à esquerda, linha atual destacada, largura dinâmica.
- **Scrollbar proporcional** — thumb proporcional ao documento, click no track navega.
- **Find & Replace UI visual** — regex/case/whole word toggles na find bar.
- **Ocorrências da busca no canvas** — rects amarelos + match atual em magenta.
- **Abas/múltiplos documentos** — tabs, troca, fechar (click + middle-click), dirty state.
- **Temas configuráveis** — troca Dark/Light por clique ou Ctrl+Shift+T, persistido.
- **Command Palette** — Ctrl+Shift+P com busca fuzzy.
- **Go to line** — Ctrl+G → prompt → navega para linha.
- **Auto-pair** — `()`, `[]`, `{}`, `""`, `''`, `` ` ``, skip de fechamento, backspace inteligente.
- **Bracket matching** — highlight do par correspondente.
- **Soft wrap** — quebra visual de linha + indentation guides.
- **Plugin host** — `utilityProcess` com handshake/FSM, bridge `emit` core→host.
- **Snippets** — expansão de snippet com tabstops.

### 🐛 Correções de bugs

- **Canvas2DBackend nunca tingia glifos** — coloração de sintaxe invisível no backend default
  (tema claro = texto invisível). Correção: `GlyphTinter` injetado.
- **Realce pedia revisão errada do boot** — `requestHighlight` lia `source.revision` (0) em vez
  da sessão ativa (1) → loop infinito de retry.
- **`packageRoots` apontava para `assets/grammars`** — gramática de brinde nunca registrada.
- **Performance dos menus falsa** — Cut/Copy/Paste eram no-ops. Implementados via clipboard API.
- **LSP TypeScript** — `initializationOptions.tsserver.path` injetado no boot.
- **Plugin host** — `UnhandledPromiseRejection` no `postMessage`.

### 🔬 Análise (clean-room RE)

- **P3.5 — Rizin provisionado** — v0.9.1 estático, integrado como provider nativo do REA.
- **P3.5b — Análise via Rizin** — 13.312 funções catalogadas, 76.042 strings extraídas,
  shaders GLSL reais extraídos do .rodata, 17 evidências RZ-E1–E17.
- **P3.6 — Snapshot de análise REA** — 8.87 MB com 3 evidence records.

### 🛠️ Infraestrutura

- **GitHub repo + CI/Release** — workflows CI (typecheck+test+build) e Release (Linux AppImage +
  Windows nsis); electron-builder configurado.
- **PyCharm run configurations** — 6 Node.js run configs.
- **Welcome screen** — logo Scribe, atalhos, hint de drag & drop.
- **Menu bar nativa** — File/Edit/Find/View com ações via IPC.
- **Branding** — ícone SVG+PNG (logo "S" azul).

---

## [0.3.1] — 2026-10-17

### 🚀 Features

- **Scaffold inicial do Scribe** (Fase 3 / P2.2) — 6 módulos core, costuras congeladas em `src/shared/`.
- **PieceTable segmentada** — `original` + `add` + spans; linha por índice incremental.
- **Undo/redo** — delta inverso, grupos/glue/soft.
- **Render Canvas2D** (default) e **WebGPU** (opt-in), atlas de glifos RGBA8.
- **Realce de sintaxe** — gramática YAML → tokenizer → `ThemeResolver`.
- **Busca/substituição** em lane `background` (TaskPool, regex opt-in).
- **Salvar arquivo** com escrita atômica (tmp + rename).
- **Cancelamento e2e** — signalId → AbortController.
- **Worker de TaskPool bundleado** — sem duplicata de código.
- **Setup reproduzível** — Python, Ghidra, REA, pwntools.

### 🐛 Corrigido

- Demo text pouco convidativo → welcome screen.
- Menu bar ausente → menu nativo do Electron.
- Aparência "Sublime" genérica → ícone e título "Scribe".