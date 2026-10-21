# PLAYBOOK — como tocar uma janela grande de mudanças com multiagente

> Receita **provada** na sessão de 2026-10-21 (release **0.7.0**): 9 features/itens entregues,
> 3 revisores + 1 security + 2 testers, 7+2 fixers, **1585 testes**, zero regressão.
> Leia isto **antes** de abrir a próxima janela grande.

---

## 🎯 A regra que importa

**O gargalo não é o paralelismo — são os "arquivos quentes".**

`src/main/index.ts`, `src/preload/index.ts`, `src/renderer/main.ts`, `src/renderer/index.html`,
`src/renderer/index.css` e `src/shared/ipc-contract.ts` são escritos por **todo mundo**. Se dois
agentes editarem o mesmo arquivo, o resultado é conflito silencioso.

**A solução que funcionou:** o orquestrador vira **dono do contrato** (`ipc-contract.ts`) e
**serializa os arquivos quentes em ondas**, enquanto todo o resto (módulos novos, parsers, modelos
puros, testes) vai **paralelo**.

---

## 🌊 As ondas (o padrão que deu certo)

| Onda | Quem | Quantos | Regra de propriedade |
|---|---|---|---|
| **0 — discovery** | `context-retriever` | 1 por frente | só lê; devolve `arquivo:linha` |
| **1 — implementação** | `implementer` | **N em paralelo** | **partições disjuntas**, um escritor por arquivo |
| **2 — integração** | `implementer` (integrador) | 1–2, **sequencial** entre si | só os "arquivos quentes" |
| **3 — revisão** | `reviewer` + `security` + `tester` | **em paralelo** (leem tudo) | não editam |
| **4 — correção** | `fixer` | 1 por achado, **em paralelo** | partições disjuntas |
| **5 — fechamento** | orquestrador | 1 | gates · AppImage · docs · commit |

**Ordem das ondas 1 e 2 (o erro a não repetir):** *nenhum* integrador pode começar antes de a onda 1
terminar, senão ele integra contra uma API que ainda vai mudar.

---

## 📋 Contrato de prompt (obrigatório em toda chamada)

Todo subagente recebe, **no próprio prompt**:

1. **Objetivo mensurável** + o papel que ele exerce.
2. **Contexto** (repo, feature, decisões já tomadas) — com `arquivo:linha` prontos, para ele não
   re-explorar.
3. **Escopo**: o que pode **ler** e o que pode **editar** (a partição, caminho por caminho).
4. **Proibições**: não commitar, não fazer push, não criar tag/release, não rodar `npm run dist`,
   não rodar a suíte completa, **não editar fora da partição**.
5. **Ambiente**: `set -a; . ./setup/env.sh; set +a` (o `node` do PATH padrão é **v14** e não roda o
   npm do projeto).
6. **Critério de aceite** + **formato de retorno** (≤ 40 linhas, digest com `arquivo:linha`).

### O bloco **WIRING SPEC** (o que destrava a integração)

Todo implementador de uma parte **pura** entrega no relatório:

- assinatura exata das funções/contratos novos;
- os **nomes exatos** dos métodos IPC que o integrador deve criar (payload + resultado);
- o **ponto exato** no arquivo quente onde fiar (com `arquivo:linha`);
- os **ids de host** que o `index.html` precisa ter;
- as **classes CSS** que o `index.css` precisa estilizar;
- o comportamento de **degradação** (preload velho ⇒ o que acontece).

Sem isso o integrador vira arqueólogo. Com isso, ele só executa.

---

## 🔥 Regras de ouro (aprendidas na marra)

1. **Um escritor por arquivo, por rodada.** Se duas fatias precisam do mesmo arquivo quente,
   elas entram em **ondas diferentes** — não em paralelo.
2. **O orquestrador é dono do contrato.** Ele escreve `src/shared/ipc-contract.ts` **antes** de
   qualquer integrador ⇒ os dois lados (main e renderer) implementam o **mesmo** nome de método.
3. **Módulos novos são o default.** Um painel/serviço novo = 1 arquivo novo em `src/renderer/` +
   1 pure-model + 1 `mount*` que degrada sem DOM. Integração = 1 linha no `main.ts`.
4. **vitest roda em `environment: "node"`, sem jsdom.** Teste de UI = **lógica pura**; o DOM vira
   "DOM falso" compartilhado (`test/helpers/fake-dom.ts` — já existe, com `classList`, `dataset`,
   `innerHTML`, eventos com bubbling e `MutationObserver`).
5. **O `graft` não tem grafo neste repo** (`no wiring graph`) — use `grep`/`read`.
6. **Typecheck é global ⇒ é um barulho coletivo.** Diga ao subagente: "erro fora dos seus
   arquivos é de outro agente — ignore". O `tsc` quebrado **dentro** da partição dele é o sinal.
7. **Fixe um revisor por fatia**, não um revisor do diff inteiro: 9 fatias ⇒ 3 revisores, cada um
   na sua área. `security` roda **em paralelo** e olha a **superfície nova** (o que a janela
   passou a expor).
8. **Peça E2E de verdade, não só unidade.** O `tester` roda o app (`xvfb-run` + CDP) e mede
   (pixels, rows, ms). Foi o E2E que achou o `pyright` travado, o `Enter` morto e o Outline vazio
   no boot — **nenhum** teste unitário pegou isso.
9. **Depois do fixer, o revisor volta.** O bug de altíssima severidade costuma aparecer na 2ª
   passada.
10. **Encerramento pelo orquestrador:** gates → `npm run dist` → AppImage testado com **env limpo**
    → `docs/HANDOFF.md` + `docs/BACKLOG.md` + `CHANGELOG.md` → commit → `git status` limpo.

---

## 🧪 O que a E2E provou (leia antes de confiar no verde)

- `typecheck` + 1585 testes verdes **não** implicam app funcionando: o `pyright` travava
  (LSP sem responder a request servidor→cliente) e o `Enter` não inseria nada.
- O AppImage **só é confiável com `env` limpo**:
  `env -i PATH=/usr/bin:/bin HOME=$HOME xvfb-run -a ./release/Scribe-*.AppImage --no-sandbox`
  (no shell do dev, o `PATH` do nvm esconde bugs de boot).
- **Acentos/emoji** quebram framing de protocolo (o `Content-Length` do LSP é em **bytes**).
- **Folding × soft wrap** só se mede em pixel: 11,00 rows de deslocamento constante e 0
  divergências/19 amostras foi o que travou a regressão.

---

## 📚 Exemplo de partição que funcionou (release 0.7.0)

```
onda 1 (paralelo, 9 implementadores)
  A  src/core/dap/**                     → gancho beforeLaunch
  B  src/core/workspace/grep*  src/renderer/search-panel.ts
  C  src/core/workspace/file-index.ts  src/renderer/quick-open.ts
  D  src/core/render/soft-wrap.ts  src/core/render/scene.ts
  E  src/renderer/problems-panel.ts (novo)
  F  src/renderer/outline-view.ts  (novo)
  G  src/core/workspace/file-tree.ts  src/renderer/explorer-tree.ts (novos)
  H  src/core/git/git-status.ts  src/renderer/source-control.ts (novos)
  I  src/core/git/git-diff.ts  src/renderer/diff-view.ts (novos)

onda 2 (paralelo, 2 integradores — arquivos quentes disjuntos)
  A  src/main/index.ts  src/preload/index.ts
  B  src/renderer/main.ts  src/renderer/index.html

onda 3 (paralelo)  reviewer(core) ‖ reviewer(workspace) ‖ reviewer(features)
                   ‖ security ‖ tester
onda 4 (paralelo)  5 fixers, partições disjuntas
onda 5 (paralelo)  2 fixers (lacunas de integração entre as ondas)
fechamento         orquestrador: gates → dist → docs → commit
```

**Números:** 9 implementadores + 3 revisores + 1 security + 2 testers + 7 fixers
= **22 agentes**, 1 sessão, **+409 testes**, 0 regressão, 4 correções de segurança e
3 bugs que só a E2E achou.
