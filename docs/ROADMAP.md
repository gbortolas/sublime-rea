# Roadmap — Scribe

> **Documento de planejamento** das próximas features do editor Scribe.
> Organizado por prioridade de entrega, não por fase de RE.
> Data: 2026-10-17

## ✅ Já entregue (o core)

O que o Scribe já tem funcionando:
- Buffer PieceTable com índice de linhas incremental
- Undo/redo com grupos, glue e soft
- Render Canvas2D (default) e WebGPU (opt-in), viewport virtualizado, atlas de glifos
- Realce de sintaxe com gramática custom (YAML → tokenizer → ThemeResolver)
- Busca/substituição em lane background (TaskPool, regex opt-in, resultados truncados)
- Ocorrências da busca pintadas no canvas (overlay de rects, match atual destacado)
- Salvar arquivo com escrita atômica (tmp + rename)
- Cancelamento e2e (signalId → AbortController)
- Find bar com debounce, wrap, contador
- Worker do TaskPool bundleado (sem duplicata de código)
- Setup reproduzível (Python, Ghidra, REA, pwntools, symlink)

## 🥇 P1 — Pré-requisitos de usabilidade (o que falta pro editor "não envergonhar")

Features que qualquer editor de texto minimamente decente tem que ter.
Dependência: o core já existe, estas camadas são puramente de UI/UX no renderer.

| # | Feature | Esforço | Depende de | Descrição | Status |
|---|---------|---------|------------|-----------|--------|
| 1 | **Seleção de texto** (Shift+seta, click+drag) | M | caret existente | Estado de seleção (âncora + ativo), highlight visual das faixas selecionadas no canvas, operações com seleção (delete, substituir) | ✅ |
| 2 | **Gutter com números de linha** | P | layout existente | Faixa à esquerda do canvas com número das linhas, highlight da linha atual, fundo do gutter separado | ⬜ |
| 3 | **Scrollbar proporcional** | P | viewport existente | Barra de rolagem à direita com thumb proporcional ao documento, drag do thumb | ⬜ |
| 4 | **Find & Replace UI visual** (regex/case/whole word toggle) | P | find bar existe | Botões de toggle na find bar (Aa, .*, \b), visual state, atalhos de teclado pra alternar | ⬜ |

## 🥈 P2 — Produtividade (o que faz o editor ser "usável no dia a dia")

Features que transformam um brinquedo em ferramenta de trabalho.

| # | Feature | Esforço | Depende de | Descrição |
|---|---------|---------|------------|-----------|
| 5 | **Seleção com múltiplos cursores** | G | P1#1 (seleção) | Ctrl+D pra selecionar próxima ocorrência, Ctrl+click pra cursor extra, operações simultâneas |
| 6 | **Múltiplos documentos / abas** | G | buffer registry existe | Tabs no topo, troca de documento ativo, fechar/reordenar, estado dirty por tab |
| 7 | **Drag & drop de arquivo** | P | IPC de abertura | Arrastar arquivo do SO pro canvas abre ele |
| 8 | **Temas (cores configuráveis)** | P | ThemeResolver existe | Trocar tema por JSON/JSONC, pal clara/escura, reload sem restart |
| 9 | **Minimap** | G | viewport existe | Mapa reduzido do documento à direita, click navega, render em Canvas separado | ✅ |

## 🥉 P3 — Pós-MVP (features que expandem o escopo)

Funcionalidades de editor "profissional" — muitas dependem de arquitetura já existente mas não testada.

| # | Feature | Esforço | Depende de | Descrição |
|---|---------|---------|------------|-----------|
| 10 | **Plugin host** (extensão isolada) | G | ExtensionHost existe | O `utilityProcess` + handshake + OPS bridge existem mas nunca rodaram com uma extensão real |
| 11 | **Command palette** (Ctrl+Shift+P) | M | CommandBus existe | Busca fuzzy em lista de comandos registrados, execução pelo bus | ✅ |
| 12 | **Go to line** (Ctrl+G) | P | caret existe | Diálogo minimalista, navega pra linha digitada |
| 13 | **Auto-pair** (aspas/chaves/colchetes) | P | inserção existe | Fechamento automático, pular fechamento existente, backspace inteligente |
| 14 | **Bracket matching** | P | buffer scanning | Highlight do par correspondente quando cursor está em bracket |
| 15 | **Wrap de linha (soft wrap)** | G | render pipeline | Quebra visual sem quebrar o texto, métrica do viewport adaptada. **Indentation guides ✅** |

## 🟤 P4 — Sonhos (se sobrar tempo)

Features legais mas não essenciais, ou que dependem de componentes ainda não projetados.

| # | Feature | Esforço | Descrição |
|---|---------|---------|-----------|
| 16 | **LSP client** | G | Conectar a servidores LSP (tipo pyright/tsserver) pra diagnóstico, completação, go-to-definition |
| 17 | **Git integration** (gutter blame/diff) | G | Mostrar diff na gutter, blame inline, stage/unstage |
| 18 | **Snippets** | M | Expansão de snippet com tabstops, espelha o formato .sublime-snippet |
| 19 | **Paleta de cores / temas customizáveis na UI** | M | Editor visual de tema, preview em tempo real |
| 20 | **Modo vim (ex-mode)** | G | Plugável via extensão, emulação de modal editing |

## 📐 Notas técnicas transversais

- **Testes**: toda feature nova no renderer (gutter, seleção, scrollbar) precisa de teste de cena (`scene.test.ts`) que verifica as `RectInstance`/`GlyphInstance` geradas — o `buildInstances` é puro e determinístico.
- **Worker e performance**: features de scanning (bracket matching, word highlight) devem rodar no `TaskPool`, nunca na main thread.
- **IPC versionado**: qualquer nova feature que toque main↔renderer precisa de entrada no `ipc-contract.ts` com o `IPC_VERSION` atualizado.
- **Clean-room**: continua valendo — zero código do Sublime. Features são implementações nossas, abstraídas dos padrões observados na Fase 1/2.

---

> **Próximos passos recomendados:** comece pelo **P1 — Seleção de texto**. É a feature mais sentida (sem seleção não dá nem pra copiar/recortar/deletar um bloco) e mexe só no renderer/caret, sem tocar em IPC. Depois gutter, scrollbar e find bar visual — cada um independente, pode paralelizar.