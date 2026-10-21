# AGENTS.md — sublime-rea (instruções do projeto)

> Carregado automaticamente por agentes que trabalham **neste** repositório.
> **Frase-gatilho:** se o usuário disser **“pode continuar os trabalhos!”** (ou algo equivalente),
> basta seguir o bootstrap abaixo — **não** peça contexto: ele está todo em `docs/`.
>
> **Trabalho multiagente:** as regras globais (papéis, fluxo, contrato de prompt e
> guardrails) ficam em `~/.config/opencode/AGENTS.md` e são carregadas automaticamente
> em todos os projetos. Este arquivo mantém só o que é **específico do sublime-rea**.

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

- Navegação barata por código: **`graft` › `serena` › `read` pontual**. Nunca leia arquivo grande
  “só pra conferir”.
- **Checkpoint:** ao passar de **~150–200k tokens**, atualize `docs/HANDOFF.md` + `docs/BACKLOG.md`,
  **commite** e peça `/new`.
- **Nunca misture nuvem com local** (subagentes herdam o modelo da sessão).

---

## 🧑‍🤝‍🧑 Delegação — específico deste repo

> Papéis, fluxo, contrato de prompt e guardrails estão no **global**
> (`~/.config/opencode/AGENTS.md`). Aqui ficam só as regras que mudam neste repo.

- **Clean-room vale para subagentes também:** se o briefing pedir para copiar
  código, assembly ou pseudocódigo do alvo, o subagente **recusa** e devolve o
  motivo.
- **Receita de janela grande (leia [`docs/PLAYBOOK.md`](docs/PLAYBOOK.md)):** o padrão
  que provou dar certo no release 0.7.0 (22 agentes em 1 sessão) foi —
  **implementadores em paralelo com partições disjuntas** → **integradores
  sequenciais nos "arquivos quentes"** (`main`/`preload`/`renderer/main`/`html`/`css`/
  `ipc-contract`) → **revisores + security + tester em paralelo** → **fixers em
  paralelo**. O orquestrador é **dono do contrato IPC**. Todo implementador entrega
  um bloco **WIRING SPEC** (nomes de método, pontos de fiação, ids de host, classes
  CSS, degradação) para o integrador só executar.
- **Digest curto:** o retorno é `file:line` + conclusão, nunca o arquivo.
  Limite prático: **≤ 40 linhas** (≤ 60 para o plano do `oracle`).
- **Parallelize o discovery, não a escrita:** 2+ frentes independentes → 2
  `context-retriever`/`explorer` em paralelo. `implementer`/`fixer` do mesmo
  arquivo nunca em paralelo.
- **Reviewer e Tester podem rodar em paralelo** depois do Implementer. O
  `fixer` só entra se algum falhar; depois da correção, o `reviewer` **volta**
  (precedente P2.4b: a 2ª revisão achou um bug alto que a 1ª não viu).
- **Background** só quando o orquestrador tiver outra frente independente para
  tocar; não fique bloqueado esperando.
- **O orquestrador fica com o contexto da sessão:** `docs/HANDOFF.md`,
  `docs/BACKLOG.md`, decisão de escopo e resposta ao usuário.

---

## 📦 Build local — AppImage (obrigatório depois de feature/bug)

> **Regra:** toda vez que **implementar uma feature nova** ou **corrigir um bug**, termine
> o trabalho com um **build local**, para o usuário ter um **AppImage prontinho para usar**.

```bash
set -a; . ./setup/env.sh; set +a     # o node do PATH padrão é v14 e não roda o npm do projeto
npm run dist                          # = build (tsc + esbuild + assets) + electron-builder
```

- **Saída:** `release/Scribe-<versão>-x86_64.AppImage` (`electron-builder.yml`: linux → AppImage).
  `release/` e `dist/` são **gitignored** — o AppImage **não** vai para o git.
- **Como usar:** `chmod +x release/*.AppImage && ./release/*.AppImage` (ou o `*.AppImage` direto
  do gerenciador de arquivos). Roda como AppImage (FUSE) ou extraído (`--appimage-extract`).
- **Quando rodar:** depois dos gates (`typecheck` + `test` + `lint`) e **antes** do commit —
  assim o commit sempre corresponde a um AppImage que existe e abre.
- **Se falhar:** `npm run dist` exige **rede** na 1ª vez (electron-builder baixa binários do
  electron); depois disso usa o cache em `~/.cache/electron-builder`. Falha de rede ≠ falha de
  código: reporte e siga com `npm run build` (gera o `dist/`, mas **não** o AppImage).
- **Verificação mínima do artefato:** o AppImage foi gerado **e** o `dist/` dentro dele é o
  novo (`ls -la release/*.AppImage` + `date` do arquivo). Rodar o AppImage é opcional
  (precisa de display; em máquina sem sessão use `xvfb-run -a ./release/*.AppImage --version`).
- **Não** faça `npm run dist` só para "ver se compila": `npm run build` já cobre isso e é 10×
  mais rápido. O `dist` é para entregar **executável**.

---

## 📤 Como FECHAR uma sessão (protocolo de handoff)

Esta é a parte que mantém a próxima sessão **limpa e barata**. Ao terminar um item:

1. **`docs/HANDOFF.md`** → atualize “Estado em uma linha”, a **“Próxima tarefa recomendada”** e
   registre os achados novos (com o que ficou `[DESCONHECIDO]`).
2. **`docs/BACKLOG.md`** → marque **`[x]`** o item entregue e ajuste o “próximo”.
3. **Evidência nova** → `docs/analysis/<tema>.md` no padrão dos existentes (header com sha256/ranges,
   “Achado central”, seções, e **ledger de evidências** `E<n>`).
4. **`git commit`** no padrão `feat(analysis): P<id> — <tema> + integração docs`.
5. **📦 Build local** — `npm run dist` (AppImage em `release/`) depois de feature/bug e **antes**
   do commit (ver §📦 Build local).
6. **Working tree limpo** — é isso que permite a próxima sessão começar sem arrastar contexto.

> Índice completo de documentos: seção **🗺️ Mapa de documentos** do [`README.md`](README.md).
