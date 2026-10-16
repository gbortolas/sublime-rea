# BACKLOG — sublime-rea

> Backlog vivo do projeto. Estado atual: [`PROGRESS.md`](PROGRESS.md).
> Contexto: clean-room RE do Sublime Text via REA → reimplementação em Electron/TS.

Legenda de prioridade: **P0** = destrava a fase atual · **P1** = próximo · **P2** = depois · **P3** = housekeeping.

---

## 🚧 P0 — Destravar a Fase 1 (análise do binário)

A auto-análise do Ghidra estoura o **timeout fixo de 330 s** do REA (ver PROGRESS.md).

- [ ] **P0.1 — Testar `REA_GHIDRA_DISABLED_ANALYZERS`**
  Desligar analyzers caros (candidatos: `Decompiler Parameter ID`, `Apply Data Archives`,
  `Aggressive Instruction Finder`, `Function Start Search`) e ver se a análise cabe em 330 s.
  *Prós:* caminho nativo do REA, barato de testar. *Contras:* menos qualidade de análise;
  trade-off a medir. **Validar também se o conjunto de nomes aceitos é o de classes do Ghidra.**
- [ ] **P0.2 — Pré-analisar com Ghidra próprio (`analyzeHeadless`)**
  Rodar a análise completa **sem timeout** (10–40 min, em background) num projeto persistente
  e então tentar alimentar o REA via `REA_GHIDRA_SEED_FILE` (ou por "analysis database path"
  aceito por `rea analyze`/`open_binary`).
  *Prós:* análise completa e reaproveitável. *Contras:* incerto se o REA consome o projeto;
  precisa investigar o formato do seed.
- [ ] **P0.3 — Rotas do REA que NÃO usam Ghidra (híbrido)**
  `inspect-binary-layout` (já funciona) + busca de strings/símbolos + **superfície da API
  Python de plugins** (`sublime.py` / `.sublime-package` dentro do tarball).
  *Prós:* funciona hoje; cobre boa parte do entregável acadêmico (a spec **abstrata**).
  *Contras:* não rende pseudocódigo/estruturas de memória do núcleo nativo.
- [ ] **P0.4 — Pivotar para Rizin/Cutter**
  O REA expõe comandos Rizin (`execute-rizin-command`, `debug-with-rizin`), que costumam ser
  muito mais rápidos que o Ghidra em binários grandes. *Contras:* requer provisionar Rizin.

- [ ] **P0.5 — Decidir e registrar a estratégia escolhida** neste backlog + PROGRESS.md.

---

## 📐 P1 — Fase 1 (conteúdo da análise), quando desbloqueada

Dividir por pergunta (o skill recomenda decompor em escopos independentes, com ledger de
Evidence IDs). Cada item vira uma seção da spec técnica abstrata.

- [ ] **P1.1 — Estrutura de buffer**: Piece Table / Gap Buffer / Rope? Como faz insert/remove,
      undo/redo e indexação de linha. Evidências: strings, alocadores, contadores.
- [ ] **P1.2 — Modelo de concorrência**: thread principal (UI/event loop) vs threads de
      background (I/O, indexação, syntax highlighting, busca regex). Evidências: `pthread_*`,
      pools, filas.
- [ ] **P1.3 — Ponte IPC C++ ↔ Python**: como o núcleo nativo expõe a API de plugins.
      Lado Python: `sublime.py` / pacotes `*.sublime-package` do tarball (**este lado é
      analisável sem Ghidra** — começar por aqui).
- [ ] **P1.4 — Pipeline de render**: indícios de GPU/OpenGL/Skia; virtualização de viewport.
- [ ] **P1.5 — Ledger de evidências**: tabela `conclusão → Evidence ID → tipo → limites`.

---

## 📄 P2 — Fases 2 e 3 do projeto

- [ ] **P2.1 — Fase 2:** escrever `docs/architecture/*.md` sintetizando os padrões
      (design patterns) achados, **sem** copiar código do binário (princípio clean-room).
- [ ] **P2.2 — Fase 3:** scaffold `src/` Electron + TypeScript:
      - [ ] `PieceTable`/`Rope` em TS (zero-copy/minimal-copy)
      - [ ] Worker Threads para operações de buffer e parsing pesado
      - [ ] Renderização por Canvas 2D / WebGPU com scroll virtualizado
      - [ ] API de extensão tipada + protocolo IPC
- [ ] **P2.3 — Alinhar o nome do projeto:** `TECHNICAL_SPECIFICATION.md:4` chama de
      **"Arcane"**; a outra spec não nomeia. Decidir o nome antes de virar código.

---

## 🧹 P3 — Housekeeping / dívidas

- [ ] **P3.1 — `bin/` versionado (42 MB)**: avaliar `git rm --cached` + download sob demanda
      no `setup.py` (mantendo o SHA pinado), ou adotar Git LFS.
- [ ] **P3.2 — Documentar em destaque** (README) que o `rea` CLI exige `source setup/env.sh`
      em shells não-interativos.
- [ ] **P3.3 — `setup/setup.sh` (bash) legacy**: decidir entre remover ou congelar; hoje está
      com 9 etapas (desatualizado em relação ao `setup.py` de 10). Risco de divergência.
- [ ] **P3.4 — `main.py`**: boilerplate do PyCharm na raiz; remover ou repurpor.
- [ ] **P3.5 — Provisionar Rizin** (se P0.4 for escolhido) e adicionar etapa no `setup.py`.
- [ ] **P3.6 — Snapshot de análise**: se P0.2 vingar, tornar o build do snapshot um passo
      documentado do fluxo (não do setup, que é por-máquina).
