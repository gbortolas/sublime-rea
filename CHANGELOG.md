# Changelog — Scribe

Todas as mudanças notáveis neste projeto.

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