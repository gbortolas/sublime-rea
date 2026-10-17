# Projeto de Pesquisa Acadêmica: Arquitetura de Editor de Texto de Alta Performance (Clean-Room Reverse Engineering & Reimplementação)

## 📌 Visão Geral do Projeto
Este projeto de estudo e pesquisa acadêmica visa investigar a arquitetura interna e as decisões de design de editores de texto nativos de altíssima performance (com foco no Sublime Text) utilizando engenharia reversa de sala limpa (*clean-room design*). O objetivo final é extrair padrões arquiteturais, estruturas de dados para gerenciamento de buffer de texto e modelos de concorrência/renderização para fundamentar a construção de um novo editor de texto moderno, extensível e eficiente construído sobre o ecossistema **Electron (TypeScript / Node.js)**.

---

## 🛠️ Ferramentas & Ecossistema de Análise

- **Ferramenta de RE / MCP Server:** REA (Reverse Engineering Agent)
  - **Repositório Oficial:** https://github.com/morluto/rea
  - **Função:** Atuar como camada de mediação (via Model Context Protocol - MCP) entre o agente de IA e os utilitários de análise/descompilação locais.
- **Motor de Descompilação Nativo:** Ghidra (NSA Software Reverse Engineering Tool) rodando em modo headless/integrado via REA.
- **Ambiente de Desenvolvimento Target:** PyCharm / IDE Local com integração a Agente de IA.
- **Alvo Principal de Estudo:** Executável nativo do Sublime Text (C/C++).

---

## 🎯 Objetivos de Pesquisa & Requisitos Técnicos

### 1. Investigação de Gerenciamento de Buffer na Memória
- Mapear a estrutura de dados primária do Sublime para manipular grandes volumes de texto (ex: *Piece Table*, *Gap Buffer*, ou *Rope*).
- Analisar como a aplicação lida com operações de inserção, remoção, *undo/redo* e indexação de linhas em tempo O(log N) ou O(1).

### 2. Arquitetura Multithread e Concorrência
- Inspecionar a separação de responsabilidades entre a thread principal (UI/Event Loop) e threads de background (indexação de arquivos, *syntax highlighting*, busca por regex e I/O de disco).
- Identificar padrões de sincronização e concorrência para evitar travamento da interface.

### 3. Sistema de Extensibilidade e Ponte IPC
- Analisar a arquitetura da ponte (*bridge*) de comunicação entre o núcleo nativo compilado (C++) e a API de plugins (Python).

### 4. Transição para Reimplementação em Electron
- Mapear gargalos conhecidos da runtime do Chromium/V8 no Electron ao lidar com editores de texto (DOM excessivo, mutabilidade de strings, garbage collection).
- Projetar a arquitetura equivalente em Electron utilizando:
  - **Worker Threads** (Node.js) para processamento isolado do buffer e algoritmos pesados.
  - **WebGPU / Canvas API** para renderização gráfica performática do texto, minimizando dependência do DOM tradicional.
  - Estrutura de dados imutável/eficiente escrita em TypeScript (ou módulo nativo Rust/C++ via Node-API, se necessário).

---

## 📋 Plano de Ação para o Agente

1. **Configuração de Ambiente & Handshake:**
   - Inicializar o ambiente local e verificar a disponibilidade das ferramentas do REA via MCP executando `rea readiness` ou as rotinas de verificação correspondentes.
   - Garantir a indexação inicial do executável do Sublime Text no Ghidra.

2. **Fase 1: Extração e Mapeamento do Binário:**
   - Navegar no grafo de chamadas (*call graph*) e extrair o pseudocódigo/estruturas das funções centrais de manipulação de arquivo e buffer.

3. **Fase 2: Síntese e Documentação Técnica:**
   - Documentar os padrões de design (Design Patterns) identificados no binário em arquivos Markdown explicativos dentro do repositório.

4. **Fase 3: Prototipagem da Arquitetura em Electron:**
   - Criar a estrutura inicial do projeto Electron com TypeScript.
   - Implementar a estrutura de dados do Buffer e o loop de renderização baseado nas evidências obtidas na Fase 2.

---

## ⚠️ Diretrizes Éticas e Legais
- **Escopo Exclusivamente Acadêmico:** O estudo destina-se apenas à compreensão de conceitos de engenharia de software e arquitetura de sistemas.
- **Princípio de Sala Limpa (Clean-Room):** Nenhum código do binário original deve ser copiado diretamente. Toda a implementação final no projeto Electron deve ser escrita do zero, baseando-se apenas nos conceitos e especificações técnicas abstratas documentadas.

---

## 📊 Status da execução (atualizado em 2026-10-17)

| Objetivo (ver “Objetivos de Pesquisa”) | Evidência entregue | Status |
|---|---|---|
| 1. Gerenciamento de buffer | [`analysis/buffer-structure.md`](analysis/buffer-structure.md) — ledger `E1–E14` | ✅ família piece-table/segmentado `[INFERIDO]`; sem Gap Buffer nem Rope nomeados |
| 2. Multithread / concorrência | [`analysis/concurrency.md`](analysis/concurrency.md) — ledger `E1–E21` | ✅ main thread **GTK3/GLib** + fábrica POSIX (2 MiB, `prctl`) + pools de I/O |
| 3. Extensibilidade / ponte IPC | [`analysis/api-python.md`](analysis/api-python.md) · [`analysis/ipc-plugin-host.md`](analysis/ipc-plugin-host.md) · [`analysis/ipc-protocol.md`](analysis/ipc-protocol.md) | ✅ lado Python + transporte (shm+sem) + **wire protocol** (framing/anéis/dispatch numérico U=281/V=71) |
| 4. Transição para Electron — **síntese (Fase 2)** | [`architecture/README.md`](architecture/README.md) — 6 docs + índice, **61 decisões `DEC-*`** | ✅ padrões abstratos e mapeamento p/ Electron prontos (**P2.1**) |
| 4. Transição para Electron — **implementação (Fase 3)** | [`scaffold/P2.2-scaffold.md`](scaffold/P2.2-scaffold.md) · `src/**` (Scribe) | ✅ scaffold completo e verde (**P2.2**, codinome **Scribe** P2.3) + **fatia vertical fechada** (**P2.4**: abrir · editar · undo/redo · cancelamento · realce · **busca/substituição** em lane de background; revisão do realce corrigida em P2.4b) — **próximo: P2.5** (salvar arquivo) |
| (extra) Empacotamento de recursos | [`analysis/packaging.md`](analysis/packaging.md) — ledger `E1–E22` | ✅ `.sublime-package` = ZIP sem manifesto; precedência `User` > `Default` |

> **Fila viva:** [`BACKLOG.md`](BACKLOG.md) · **Como retomar:** [`HANDOFF.md`](HANDOFF.md) · **Protocolo de sessão:** [`../AGENTS.md`](../AGENTS.md).