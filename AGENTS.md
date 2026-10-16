# AGENTS.md — sublime-rea (instruções do projeto)

> Carregado automaticamente por agentes que trabalham **neste** repositório.
> **Frase-gatilho:** se o usuário disser **“pode continuar os trabalhos!”** (ou algo equivalente),
> basta seguir o bootstrap abaixo — **não** peça contexto: ele está todo em `docs/`.

---

## 🚀 Bootstrap de sessão (faça isto PRIMEIRO)

1. **Leia [`docs/HANDOFF.md`](docs/HANDOFF.md) por inteiro** — é o ponto de entrada (estado atual,
   como retomar, pegadinhas operacionais, fatos observados do alvo).
2. Pegue o **próximo item aberto** em [`docs/BACKLOG.md`](docs/BACKLOG.md) — a seção **📐 P1** é a fila
   atual. Se o HANDOFF trouxer “**Próxima tarefa recomendada**”, **ela vence** o backlog.
3. Garanta o **ambiente** antes de atacar o binário:

   ```bash
   set -a; . ./setup/env.sh; set +a                              # OBRIGATÓRIO em shell não-interativo
   rea doctor --client opencode --provider ghidra --format json  # espera "healthy": true
   ```

4. Anuncie o plano em **1 linha** e siga. **Não** peça confirmação para o item já recomendado.
5. Ao terminar: **feche a sessão pelo protocolo** (ver o fim deste arquivo) — a próxima sessão
   depende disso para começar barata.

---

## 🎯 O projeto (1 parágrafo)

**Clean-room reverse engineering** do Sublime Text (build 4215) via **REA + Ghidra**, para extrair
**padrões arquiteturais abstratos** (buffer, concorrência, ponte IPC, render, empacotamento) e então
**reimplementar do zero** um editor equivalente em **Electron / TypeScript**. Escopo **acadêmico**.

---

## ⚖️ Regras invioláveis

- **Clean-room:** **nunca** copie/transcreva código, assembly ou pseudocódigo do alvo. Só **nomes,
  assinaturas, contagens, tamanhos, endereços e papel arquitetural**. Evidência vive em `docs/analysis/`.
- **Rótule toda afirmação:** `[OBSERVADO]` / `[INFERIDO]` / `[DESCONHECIDO]`. Hipótese ≠ fato.
- **Alvo:** `target/sublime_text/sublime_text` (ELF64 x86-64, PIE, **stripped**,
  sha256 `8b105b18…43d92`). O diretório `target/` é **gerado e descartável** (gitignored).
- **Não** versione artefatos gerados (`target/`, projetos Ghidra, venvs, caches de LSP).

---

## 🔧 Operação — pegadinhas que já custaram caro

- O CLI **`rea` exige** `set -a; . ./setup/env.sh; set +a` (shell não-interativo). Um restart do
  opencode **não** propaga variáveis novas — quem propaga é `python3 setup/setup.py` (idempotente).
- O MCP `rea` já traz **`REA_GHIDRA_STARTUP_TIMEOUT_MS=900000`**; a auto-análise do alvo leva
  **~355 s** (o default de 330 s estourava por 4 s e descartava tudo).
- **`REA_GHIDRA_SEED_FILE` ≠ análise prévia**: é um TSV de assertivas. O REA **sempre re-analisa**
  (`-import -readOnly -deleteProject`); não aceita projeto/DB do Ghidra.
- **`bin/ghidra-preanalyze.sh`** gera um **projeto Ghidra persistente** (171 MB) — serve para
  *reprocessar sem reanalisar* e para medir tempo.
- `rea doctor` exige `JAVA_HOME` de um **JDK ≥ 21**.

---

## 🧭 Como trabalhar (economia de contexto + delegação)

- **O orquestrador cloud decide; o trabalho verboso vai para subagente** (contexto isolado,
  devolve **digest curto** com `file:line`). Ler/varrer/rodar/editar em volume → **delegue**.
- Navegação barata por código: **`graft` › `serena` › `read` pontual**. Nunca leia arquivo grande
  “só pra conferir”.
- **Checkpoint:** ao passar de **~150–200k tokens**, atualize `docs/HANDOFF.md` + `docs/BACKLOG.md`,
  **commite** e peça `/new`.
- **Nunca misture nuvem com local** (subagentes herdam o modelo da sessão).

---

## 📤 Como FECHAR uma sessão (protocolo de handoff)

Esta é a parte que mantém a próxima sessão **limpa e barata**. Ao terminar um item:

1. **`docs/HANDOFF.md`** → atualize “Estado em uma linha”, a **“Próxima tarefa recomendada”** e
   registre os achados novos (com o que ficou `[DESCONHECIDO]`).
2. **`docs/BACKLOG.md`** → marque **`[x]`** o item entregue e ajuste o “próximo”.
3. **Evidência nova** → `docs/analysis/<tema>.md` no padrão dos existentes (header com sha256/ranges,
   “Achado central”, seções, e **ledger de evidências** `E<n>`).
4. **`git commit`** no padrão `feat(analysis): P<id> — <tema> + integração docs`.
5. **Working tree limpo** — é isso que permite a próxima sessão começar sem arrastar contexto.

> Índice completo de documentos: seção **🗺️ Mapa de documentos** do [`README.md`](README.md).
