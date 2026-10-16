# BACKLOG — sublime-rea

> Backlog vivo do projeto. Estado atual: [`PROGRESS.md`](PROGRESS.md).
> Contexto: clean-room RE do Sublime Text via REA → reimplementação em Electron/TS.

Legenda de prioridade: **P0** = destrava a fase atual · **P1** = próximo · **P2** = depois · **P3** = housekeeping.

---

## 🆕 P0 — Destravar o Ghidra (RESOLVIDO o diagnóstico)

O "bloqueio" era **falso**: o deadline do Ghidra **é configurável**
(`REA_GHIDRA_STARTUP_TIMEOUT_MS`, máx 2^31−1). Correções de fatos descobertas no `dist/` do
`rea-agents@6.5.0` — detalhes e evidências em [PROGRESS.md](PROGRESS.md):

- **`REA_GHIDRA_STARTUP_TIMEOUT_MS`** existe (`config/providerStartupTimeout.js:3`). **É o fix.**
- **`REA_GHIDRA_SEED_FILE`** ≠ análise pré-existente: é um TSV de assertivas
  (`address<TAB>kind[<TAB>name]`, `kind ∈ function|code|label`). O REA **não** consome projeto/DB
  do Ghidra — ele sempre re-analisa (`-import -readOnly -deleteProject`).
- **`REA_GHIDRA_DISABLED_ANALYZERS`** aceita **nomes exatos** de analyzers do Ghidra
  (case-sensitive, sem glob), `,`-separados, ≤32; nome inválido = erro fatal.

- [x] **P0.0 — Validado ponta a ponta** ✅ — `REA_GHIDRA_STARTUP_TIMEOUT_MS=900000` +
  `rea analyze --provider ghidra` no alvo: **`EXIT=0` em 5m54,8 s** (antes: `provider_timeout` a
  330 s). **Já cabeado no `setup/`**: default `900000` (15 min) validado contra o schema do REA,
  propagado para `setup/env.sh` e para o `environment` do MCP `rea` (repositório MCP: reiniciar o
  opencode para o servidor relançar com a var nova).
- [x] **P0.1 — `REA_GHIDRA_DISABLED_ANALYZERS`** — semântica **esclarecida** (nomes exatos de
  classes do Ghidra, `setAnalysisOption(nome,"false")`). Não é mais necessário como *plano A*;
  fica como knob de tuning se o tempo incomodar.
- [~] **P0.2 — Pré-análise headless** — **feito o que importa**: `bin/ghidra-preanalyze.sh` +
  projeto persistente (`$REA_TOOLS_DIR/ghidra-projects/sublime-rea`), rodando em background.
  Serve para **medir o tempo** e para reprocessar sem re-analisar. Alimentar o REA via seed
  deixou de ser o caminho (ver acima) — o seed só serve para injetar nomes.
- [x] **P0.3 — Rotas do REA que NÃO usam Ghidra** — **é a estratégia Track A**, em curso:
  `docs/analysis/api-python.md` + `docs/analysis/ipc-plugin-host.md`.
- [ ] **P0.4 — Pivotar para Rizin/Cutter** — **não bloqueia, mas o caminho é maior do que
  parecia**: o REA **não empacota** o binário `rizin` (só wrappers JS; faz `spawn("rizin")` do
  PATH) e não há `rizin` instalado. Só rende se provisionar (ver P3.5). Adiado.
- [x] **P0.5 — Estratégia escolhida e registrada**: **Track A agora + Track B em background**
  (decisão do usuário, 2026-10-16) — registrado em PROGRESS.md.

---

## 📐 P1 — Fase 1 (conteúdo da análise) — **em curso**

Dividir por pergunta (o skill recomenda decompor em escopos independentes, com ledger de
Evidence IDs). Cada item vira uma seção da spec técnica abstrata.

- [ ] **P1.1 — Estrutura de buffer**: Piece Table / Gap Buffer / Rope? Como faz insert/remove,
      undo/redo e indexação de linha. Evidências: strings, alocadores, contadores.
- [ ] **P1.2 — Modelo de concorrência**: thread principal (UI/event loop) vs threads de
      background (I/O, indexação, syntax highlighting, busca regex). Evidências: `pthread_*`,
      pools, filas.
- [~] **P1.3 — Ponte IPC C++ ↔ Python**: como o núcleo nativo expõe a API de plugins.
      **Lado Python: ✅ feito** → `docs/analysis/api-python.md` (superfície 3.14 + delta vs 3.3).
      **Lado IPC: ✅ feito** → `docs/analysis/ipc-plugin-host.md` (**memória compartilhada POSIX
      nomeada + semáforos nomeados**; canais `subl_send`/`subl_recv`/`subl_arecv`; classes
      `shm_channel`/`shm_bundle`). **Falta:** mapear os opcodes de `handle_protocol_message` e o
      framing de `read_message`/`write_message` (precisa do núcleo/Ghidra → P0.0).
- [ ] **P1.4 — Pipeline de render**: indícios de GPU/OpenGL/Skia; virtualização de viewport.
      *Nota:* o alvo linka `libssl`/`libsqlite3`/`libpython`, **não** Qt — confirmar/derrubar a
      hipótese "Qt" deste doc antes de assumir vtables de Qt.
- [ ] **P1.5 — Ledger de evidências**: tabela `conclusão → Evidence ID → tipo → limites`.
- [ ] **P1.6 — Modelo de empacotamento**: 50+ `.sublime-package` (zips) + `.sublime-syntax`;
      como o núcleo resolve recursos/sintaxes (ver `load_resource`/`find_resources` em
      `api-python.md`). Barato: `unzip -l` + ler um `.sublime-syntax`.

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

- [~] **P3.1 — `bin/` versionado (42 MB)**: o `bin/*.deb` (redundante com o tarball) já está
      **staged para remoção** (deletado no index, **não commitado**) — só falta commitar. Falta
      decidir o `.tar.xz` (22 MB, é a fonte do alvo): `git rm --cached` + download sob demanda com
      SHA pinado no `setup.py`, ou Git LFS.
- [ ] **P3.2 — Documentar em destaque** (README) que o `rea` CLI exige `source setup/env.sh`
      em shells não-interativos.
- [ ] **P3.3 — `setup/setup.sh` (bash) legacy**: decidir entre remover ou congelar; hoje está
      com 9 etapas (desatualizado em relação ao `setup.py` de 10). Risco de divergência.
- [ ] **P3.4 — `main.py`**: boilerplate do PyCharm na raiz; remover ou repurpor.
- [ ] **P3.5 — Provisionar Rizin** (só se P0.4 voltar à mesa): o REA **não** empacota o binário
      `rizin` — faz `spawn("rizin")` do PATH e não há nenhum instalado. Adicionar etapa no `setup.py`.
- [ ] **P3.6 — Snapshot de análise do REA**: baixa prioridade. O `snapshot_path=<*.json>` só faz
      *replay* de ferramentas em cache e **exige análise completa**; o projeto Ghidra persistente
      (`bin/ghidra-preanalyze.sh`) cobre melhor o caso.
- [ ] **P3.7 — `~/sr-tools` (symlink)**: o Ghidra recusa path com componente iniciado por `.`,
      então `bin/ghidra-preanalyze.sh` assume o symlink `~/sr-tools → $REA_TOOLS_DIR`. Formalizar
      (criar no `setup.py` ou idempotentemente no próprio script) e documentar.
