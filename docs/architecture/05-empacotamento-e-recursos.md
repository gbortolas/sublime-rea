# 05 · Empacotamento & recursos — namespace lógico e resolução em camadas

> Fase 2 (P2.1) · síntese clean-room do alvo (sha256 8b105b18…43d92) · insumo: evidence-index.md · 2026-10-16

**Resumo (1 frase).** No alvo, recursos (sintaxes, settings, keymaps, menus, snippets, temas e
pacotes de plugin) formam um **namespace lógico plano** — `Packages/<Nome>/<caminho>` — cujo "disco"
são **54 ZIPs sem manifesto**; o **tipo do arquivo** (extensão) define o *papel*, e a resolução é uma
**busca de caminho lógico com precedência do usuário sobre o embarcado**, sem índice nem *build step*.

**Componentes afetados (glossário do projeto).** `PackageResolver` (principal) · `PropertySystem` ·
`RenderPipeline` · `CommandBus` · `ExtensionHost` / `ExtensionBridge` · `TaskPool` · `Scheduler`.
Projeto: **Scribe**.

---

## 1. 🎯 O padrão observado (o quê)

- **Um só namespace de recursos.** Todo recurso do editor é endereçado por **nome lógico** no formato
  `Packages/<Nome>/<caminho interno>` — o mesmo usado para ler dados e para importar código de plugin
  (`PKG-E3`, `PKG-E17`, `PY-E19`). Não há caminho físico exposto; o nome lógico é a chave.
- **O pacote não declara nada.** Cada `.sublime-package` é um **ZIP comum, sem manifesto** (`PKG-E2`);
  o "índice" é o próprio diretório do ZIP, e o **nome do arquivo ZIP define o prefixo lógico**
  (`PKG-E3`). Layout majoritariamente **flat** (`PKG-E4`).
- **A extensão é o contrato.** Não há registro central de tipos no alvo: o núcleo **despacha por
  sufixo** (16 tipos mapeados, `PKG-E5`). `.sublime-syntax` → motor de gramática; `.sublime-settings`
  → configuração; `.sublime-keymap`/`.sublime-mousemap`/`.sublime-menu`/`.sublime-macro` → comandos;
  `.sublime-snippet`/`.sublime-completions` → expansão; `.sublime-build` → builds; `.sublime-theme`/
  `.sublime-color-scheme`/`.tmTheme` → aparência; `.py` → extensão de código.
- **Descoberta em runtime, não em build.** A leitura é **sob demanda e síncrona** (`load_resource`,
  `max_size` 16 MiB, erros tipados; `PKG-E19`/`PY-E19`) e a descoberta é por **glob de nome lógico**
  (`find_resources`). O núcleo mantém um **catálogo navegável de nomes** e lê o conteúdo quando pedido.
- **Precedência pelos nomes, não por metadados.** `User` sobrepõe o embarcado (`PKG-E21`), há **duas
  raízes** ("Packages" e "Installed Packages", `PKG-E20`), variantes de plataforma `(Linux)/(OSX)/
  (Windows)` no nome (`PKG-E8`) e marcação de oculto por prefixo `.hidden-`/`hidden: true`
  (`PKG-E9`, `PKG-E10`).
- **Plugin = recurso.** Os `.py` vivem no mesmo namespace, importados por **meta-path** com um **cache
  de bytecode externo** preferido ao ZIP (`PKG-E16`, `PKG-E17`, `PKG-E18`, `PY-E19`).

O que isso **não** é: não há sistema de dependências/versão (`PKG-U6`) nem schema próprio — é um
**VFS lógico** cujo esquema de nomes *é* o contrato.

---

## 2. 🧩 Namespace, formato e resolução (com Evidence IDs)

### 2.1 Namespace e formato de armazenamento

| Aspecto | Observado no alvo | Evidence |
|---|---|---|
| Nº de pacotes embarcados | **54** `.sublime-package` em `Packages/` | `PKG-E1` |
| Formato | **ZIP comum, sem manifesto** (nenhum `manifest.json` em 2321 entradas) | `PKG-E2` |
| Prefixo lógico | nome do ZIP → `Packages/<Nome>/…` (ex. `Packages/Default/Main.sublime-menu`) | `PKG-E3` |
| Layout interno | **flat**; 657/2321 entradas sem diretório | `PKG-E4` |
| Convenções de pasta | `Snippets/`, `Embeddings/`, `tests/`, subpacotes por variante (`Bash/`, `Shell/`, `Zsh/`) | `PKG-E6`, `PKG-E7` |
| Selagem em runtime | ZIP estático no disco; nada indica mutação | `PKG-U5` |

### 2.2 Papel por extensão (o "registro" é o sufixo)

`PKG-E5` mapeia **16 tipos**. Síntese do consumidor arquitetural (o mapa tipo→consumidor é
**observado por nome**, não por código do núcleo — limite declarado em `packaging.md`):

| Extensão | Papel | Consumidor (nosso) |
|---|---|---|
| `.sublime-syntax` / `.tmLanguage` | gramática de destaque (YAML v2 / plist legado) | `RenderPipeline` (tokenizer) + `PropertySystem` (escopos) |
| `.sublime-settings` / `.tmPreferences` | configuração / metadados por `scope` | `PropertySystem` |
| `.sublime-keymap` / `.sublime-mousemap` / `.sublime-menu` / `.sublime-macro` | bindings e comandos | `CommandBus` |
| `.sublime-snippet` / `.sublime-completions` | expansão e autocomplete | `CommandBus` (insert) |
| `.sublime-build` | templates de build por `selector` | `TaskPool` via `CommandBus` |
| `.sublime-theme` / `.sublime-color-scheme` / `.tmTheme` | aparência | `RenderPipeline` |
| `.png` | ícones/ativos (variantes `@2x`/`@3x`) | `RenderPipeline` |
| `.py` | **plugins** (código executável) | `ExtensionHost` / `ExtensionBridge` |

### 2.3 Gramática `.sublime-syntax` = máquina de estados data-driven

O formato é **YAML 1.2** com chaves de topo `name`, `scope`, `version`, `file_extensions`,
`hidden_file_extensions`, `first_line_match`, `contexts`, `variables`, `extends`, `hidden`
(`PKG-E11`). O modelo é uma **máquina de estados**: `contexts` → lista ordenada de `patterns` com o
vocabulário `match/push/set/pop/include/scope/captures` dominante (`PKG-E12`). `main` é o estado
inicial **obrigatório**; `prototype` é um contexto implícito reusado por todos (`PKG-E13`). Há
**herança por nome lógico** — local (`Markdown.sublime-syntax`) e cross-package
(`Packages/CSS/CSS.sublime-syntax`) (`PKG-E14`) — o que significa que o motor de gramática **depende
do mesmo resolvedor de nomes** dos recursos. O formato legado plist (`*.tmLanguage`, `.tmPreferences`)
**coexiste** (`PKG-E15`).

### 2.4 Resolução, precedência e merge

- **Leitura por nome lógico / glob.** `load_resource(name)` recebe o nome canônico e é resolvido no
  nativo; `find_resources(pattern)` casa por glob, logo há **catálogo de nomes** navegável
  (`PKG-E19`/`PY-E19`).
- **Duas raízes.** `packages_path()` → "Packages"; `installed_packages_path()` → "Installed Packages"
  (`PKG-E20`). A **ordem de colisão entre elas é incógnita** (`PKG-U3`).
- **Override declarado.** `Packages/User/*` **sobrepõe** `Packages/*` (`PKG-E21`); settings podem ser
  específicos por sintaxe. A **ordem exata da cadeia** (User ∧ sintaxe ∧ plataforma ∧ default) é
  **incógnita** (`PKG-U2`).
- **Variantes de plataforma.** `(Linux)/(OSX)/(Windows)` no nome (`PKG-E8`); a **regra de seleção
  exata** é incógnita (`PKG-U8`).
- **Ocultos.** `.hidden-` no nome e `hidden: true` (102 sintaxes internas) (`PKG-E9`, `PKG-E10`); a
  semântica completa é incógnita (`PKG-U4`).
- **Merge por escopo/selector.** `.tmPreferences` e settings/build casam por `scope`/`selector`
  (`PKG-E22`) — a aplicação é **filtrada pelo escopo ativo**, não global `[INFERIDO]`.
- **Formato do catálogo em memória** (hash? lista ordenada?) é **incógnita** (`PKG-U1`).

### 2.5 Plugins: o mesmo namespace serve código

`PackagePathFinder` registra-se em `sys.meta_path` e resolve o 1º segmento do módulo para o pacote
lógico correspondente (`PKG-E17`, `PY-E19`); os bytes vêm de `load_binary_resource`. Um **cache de
bytecode externo** (`__pycache__`) é **preferido ao ZIP** — o código comenta que `.pyc` "can end up
outside our packages path" (`PKG-E18`); o **local exato** é incógnita (`PKG-U9`). `lib_path` gateia
`site`/SSL do host Python (`PY-E22`). São **63 `.py`** distribuídos em 6 pacotes (`PKG-E16`).

---

## 3. 🖥️ Decisões de arquitetura para o editor-alvo

> Notação: decisões marcadas **“escolha nossa (não observada no alvo)”** são contrapropostas
> idiomáticas — o alvo **não** as implementa assim; nós escolhemos conscientemente por serem mais
> limpas em Electron/TS, preservando o **padrão** observado.

**DEC-PKG-1 — Um único namespace lógico é a chave de endereçamento.**
Todo recurso é endereçado por URI canônica `packages://<Pkg>/<path>`, resolvida pelo `PackageResolver`;
nada acessa caminho físico. *Racional:* reproduz o VFS lógico do alvo e mantém uma só superfície de
acesso para leitura de dados e carregamento de módulos. *Evidence:* `PKG-E3`, `PKG-E17`, `PY-E19`.

**DEC-PKG-2 — Despacho por extensão via registry explícito.**
Um mapa `extensão → ResourceKind → consumidor` (`PackageResolver` → `RenderPipeline` / `PropertySystem`
/ `CommandBus` / `ExtensionHost`) reproduz o "a extensão é o contrato" (`PKG-E5`) **sem** duplicar o
valor *mágico* do sufixo espalhado pelo núcleo. *Racional:* no alvo o registro é implícito no sufixo;
explicitá-lo é mais testável e não muda semântica. *Evidence:* `PKG-E5`.

**DEC-PKG-3 — Resolução em camadas: `os → app → user`.**
Substituímos o par `User > Default` + raízes "Packages/Installed Packages" por uma **pilha ordenada de
camadas** declaradas no `PackageResolver`; o usuário é sempre a camada de maior prioridade.
*Racional:* o alvo declara o override mas **não expõe a ordem de merge** (`PKG-U2`, `PKG-U3`); uma
pilha ordenada explícita torna precedência determinística e testável. *Marcação:* **escolha nossa
(não observada no alvo)** para o mecanismo; a **intenção** (usuário vence) é do alvo (`PKG-E20`,
`PKG-E21`).

**DEC-PKG-4 — Índice de recursos em memória, derivado de varredura.**
O `PackageResolver` constrói, no startup, um índice `nome lógico → {layer, size, kind, hidden}` varrendo
as camadas (e delegando a varredura ao `TaskPool`); o conteúdo é lido sob demanda. *Racional:* o alvo
tem um catálogo de nomes navegável (`find_resources`) mas o formato é incógnito (`PKG-U1`); um índice
em memória o materializa. *Evidence:* `PKG-E19`/`PY-E19`, `PKG-U1`.

**DEC-PKG-5 — Armazenamento = `asar` (ou pasta plana em dev) no lugar do ZIP.**
Mantemos a *ideia* de "pacote autocontido endereçado por nome", mas usamos `asar` do Electron (ou
diretório solto em desenvolvimento) como análogo do `.sublime-package`. *Racional:* o alvo é **ZIP
sem manifesto e estático** (`PKG-E2`, `PKG-E4`); `asar` preserva o padrão (pacote que é um arquivo,
montado como árvore) sem reimplementar um leitor de ZIP nem inventar manifesto. *Marcação:* **escolha
nossa (não observada no alvo)** para o container; reaproveitamos a **ausência de manifesto**
(`PKG-E2`) e tratamos selagem como read-only (`PKG-U5`).

**DEC-PKG-6 — Variantes de plataforma resolvidas por sufixo tipado.**
Sufixos `(linux)`/`(osx)`/`(windows)` são parseados no índice e casados contra `process.platform`; a
variante da plataforma corrente vence a base, e apenas ela é carregada. *Racional:* o alvo codifica a
plataforma no **nome** (`PKG-E8`) mas a regra de escolha é incógnita (`PKG-U8`); fixamos a regra
explicitamente. *Evidence:* `PKG-E8`, `PKG-U8`.

**DEC-PKG-7 — "Oculto" é metadado do índice, não prefixo mágico.**
`.hidden-` / `hidden: true` viram a flag `hidden` no índice (oculto de *pickers*, mas resolvível por
nome). *Racional:* o alvo usa duas convenções de nome/YAML (`PKG-E9`, `PKG-E10`) cuja semântica plena é
incógnita (`PKG-U4`); normalizamos numa flag única. *Evidence:* `PKG-E9`, `PKG-E10`, `PKG-U4`.

**DEC-PKG-8 — Gramática = interpretador genérico de `contexts`/`patterns`.**
O `RenderPipeline` usa um motor data-driven com `match/push/set/pop/include/embed` + contexto
`prototype` e estado `main` obrigatório; `extends` é resolvido pelo **mesmo `PackageResolver`** do
namespace lógico. *Racional:* o alvo é uma máquina de estados declarativa com herança por nome lógico
(`PKG-E11`–`PKG-E14`); reusar o resolvedor evita um segundo sistema de nomes. *Limite:* a montagem
final em conflito de contexto é incógnita (`PKG-U7`). *Evidence:* `PKG-E11`, `PKG-E12`, `PKG-E13`,
`PKG-E14`.

**DEC-PKG-9 — Merge por escopo/selector delegado ao `PropertySystem`.**
`PackageResolver` entrega recursos por `ResourceKind`; o `PropertySystem` aplica o **merge por
`scope`/`selector`** (settings, `.tmPreferences`, builds) sobre o escopo ativo. *Racional:* separa
*resolver nomes* de *mesclar propriedades*, o que o alvo faz de forma acoplada (`PKG-E22`).
*Evidence:* `PKG-E22`.

**DEC-PKG-10 — Carga lazy e tipada; `max_size` explícito.**
A leitura de conteúdo é sob demanda via `PackageResolver.load()`, com `max_size` configurável (análogo
dos 16 MiB do alvo) e **erros tipados** (`NotFound` / `TooLarge` / `IsDirectory`). *Racional:* o alvo
é síncrono, lazy e distingue esses três casos (`PKG-E19`/`PY-E19`). *Evidence:* `PKG-E19`/`PY-E19`.

**DEC-PKG-11 — Plugins pelo namespace, servidos ao `ExtensionHost`.**
Módulos de extensão são resolvidos pelo **mesmo namespace lógico** e entregues ao `ExtensionHost` via
`ExtensionBridge`; o cache de compilação vive **fora** do pacote (análogo do `__pycache__`).
*Racional:* reproduz "pacote = módulo importável" + cache externo (`PKG-E17`, `PKG-E18`, `PY-E19`)
sem reintroduzir um interpretador Python. *Evidence:* `PKG-E16`, `PKG-E17`, `PKG-E18`, `PY-E19`,
`PY-E22`, `PKG-U9`.

**DEC-PKG-12 — Adapter para o formato legado plist.**
`.tmLanguage` / `.tmPreferences` / `.tmTheme` são aceitos por um adapter que os normaliza para os
modelos internos. *Racional:* o alvo mantém os dois formatos em paralelo (`PKG-E15`); aceitar o legado
evita perder cobertura sem adotar plist como formato nativo. *Evidence:* `PKG-E15`.

---

## 4. 📐 Contratos TypeScript (interfaces/assinaturas do NOSSO código)

Esboço de contrato para a Fase 3 — nomes do glossário e o padrão das decisões §3. Sem código do alvo.

```ts
// Namespace lógico: a chave única de qualquer recurso.
type ResourceUri = `packages://${string}`;            // ex.: "packages://Default/Main.sublime-menu"

// Camadas de resolução (DEC-PKG-3): menor índice = menor prioridade.
type ResourceLayer = "os" | "app" | "user";

// Papel derivado da extensão (DEC-PKG-2).
type ResourceKind =
  | "syntax" | "settings" | "keymap" | "mousemap" | "menu" | "macro"
  | "snippet" | "completions" | "build" | "theme" | "color-scheme"
  | "image" | "extension";

interface ResourceEntry {
  uri: ResourceUri;
  layer: ResourceLayer;
  kind: ResourceKind;
  size: number;
  hidden: boolean;              // .hidden- / hidden:true normalizados (DEC-PKG-7)
  platform?: "linux" | "osx" | "windows";  // sufixo (Linux)/(OSX)/(Windows) (DEC-PKG-6)
}

// Erros tipados, no espírito do alvo (DEC-PKG-10).
class ResourceNotFoundError extends Error {}   // ~ FileNotFoundError
class ResourceTooLargeError extends Error {}    // ~ FileTooLargeError (max_size)
class ResourceIsDirectoryError extends Error {} // ~ IsADirectoryError

interface PackageResolver {
  /** Varre as camadas e materializa o índice (DEC-PKG-4); roda no TaskPool. */
  build(roots: Partial<Record<ResourceLayer, string[]>>): Promise<void>;

  /** Busca melhores entradas por nome lógico, respeitando a precedência de camadas. */
  resolve(uri: ResourceUri): ResourceEntry | undefined;

  /** Descoberta por glob de nome lógico (~ find_resources, PKG-E19/PY-E19). */
  find(pattern: string): ResourceEntry[];

  /** Leitura sob demanda com teto de tamanho e erros tipados (DEC-PKG-10). */
  load(uri: ResourceUri, opts?: { maxSize?: number }): Promise<Uint8Array>;

  /** Filtra por papel (o "registro" é o sufixo — DEC-PKG-2). */
  byKind(kind: ResourceKind): ResourceEntry[];

  /** Todas as camadas que definem a uri, da maior para a menor prioridade (base do merge). */
  layersFor(uri: ResourceUri): ResourceEntry[];
}

// Consumo por componente (tabela §2.2): RenderPipeline (sintaxe/tema), PropertySystem (por escopo),
// CommandBus (keymap/menu), ExtensionHost (módulo, via ExtensionBridge — DEC-PKG-11).
```

Notas de contrato: `resolve` devolve **uma** entrada (a vencedora) e `layersFor` devolve a **cadeia
completa** — é essa cadeia que alimenta o `PropertySystem` (DEC-PKG-3, DEC-PKG-9); a herança de
gramática (`extends`) usa `resolve` sobre o **mesmo** namespace (DEC-PKG-8).

---

## 5. 🔀 Divergências deliberadas (onde NÃO seguimos o alvo, e por quê)

| # | Alvo (`PKG-*`) | Nossa escolha (Scribe) | Por quê |
|---|---|---|---|
| D1 | **ZIP** sem manifesto (`PKG-E2`, `PKG-E4`) | **`asar`** ou pasta plana em dev (DEC-PKG-5) | `asar` já é pacote-montado do Electron; evita reimplementar ZIP |
| D2 | Namespace por nome lógico **e** duas raízes implícitas (`PKG-E20`) | **Camadas explícitas** `os → app → user` (DEC-PKG-3) | precedência determinística e testável; `PKG-U2`/`PKG-U3` ficam fechadas por decisão |
| D3 | Catálogo de nomes **incógnito** (`PKG-U1`) | **Índice em memória** com `kind`/`hidden`/`platform` (DEC-PKG-4) | descobre por glob sem varrer o disco a cada chamada |
| D4 | Oculto por **duas convenções de nome** (`PKG-E9`, `PKG-E10`) | **Flag `hidden`** normalizada (DEC-PKG-7) | uma só semântica; `PKG-U4` deixa de importar |
| D5 | Seleção de plataforma **incógnita** (`PKG-E8`, `PKG-U8`) | **Regra fixa** por `process.platform` (DEC-PKG-6) | previsibilidade entre alvos |
| D6 | Plugins em **Python** via meta-path + `__pycache__` (`PKG-E17`, `PKG-E18`) | **`ExtensionHost`/`ExtensionBridge`** no mesmo namespace + cache externo (DEC-PKG-11) | preserva o padrão "módulo = recurso"; sem carregar um interpretador Python |
| D7 | **Sem versão/dependências** no pacote (`PKG-U6`) | Fora de escopo no MVP; se necessário, metadado de índice (**escolha nossa**) | o alvo não resolve dependências; não inventamos política agora |
| D8 | Selagem do pacote **incógnita** (`PKG-U5`) | Pacotes tratados como **read-only** | simplicidade; mutação é sempre na camada `user` |
| D9 | `.sublime-settings` com **comentários** (formato não-JSON estrito) | Ler como **JSON5/JSONC** | tolerante como o alvo, e já idiomático no ecossistema TS |

Clean-room: nenhuma gramática, snippet, menu ou settings de terceiros é copiado. As chaves de topo
citadas (§2.3) são **contrato observável do formato**, não conteúdo de gramática.

---

## 6. 🧾 Rastreabilidade (Conclusão (Evidence IDs) → DEC → Status)

| Conclusão (Evidence IDs) | DEC | Status |
|---|---|---|
| Nome lógico = chave única; mesmo namespace p/ dados e código (`PKG-E3`, `PKG-E17`, `PY-E19`) | DEC-PKG-1 | ✅ decidido |
| Papel = extensão, 16 tipos (`PKG-E5`) | DEC-PKG-2 | ✅ decidido |
| `User > Default` declarado; duas raízes; ordem de merge incógnita (`PKG-E20`, `PKG-E21`, `PKG-U2`, `PKG-U3`) | DEC-PKG-3 | ✅ decidido (camadas) |
| Catálogo de nomes navegável, formato incógnito (`PKG-E19`/`PY-E19`, `PKG-U1`) | DEC-PKG-4 | ✅ decidido |
| ZIP sem manifesto, flat, estático (`PKG-E2`, `PKG-E4`, `PKG-U5`) | DEC-PKG-5 | ✅ decidido |
| Variante de plataforma no nome; regra incógnita (`PKG-E8`, `PKG-U8`) | DEC-PKG-6 | ✅ decidido |
| `.hidden-` + `hidden: true`; semântica incógnita (`PKG-E9`, `PKG-E10`, `PKG-U4`) | DEC-PKG-7 | ✅ decidido |
| Gramática = máquina de estados YAML; `main` obrigatório; `prototype`; `extends` por nome lógico (`PKG-E11`–`PKG-E14`, `PKG-U7`) | DEC-PKG-8 | ✅ decidido (montagem em conflito = aberta) |
| Merge por `scope`/`selector` (`PKG-E22`) | DEC-PKG-9 | ✅ decidido |
| Leitura lazy, `max_size` 16 MiB, erros tipados (`PKG-E19`/`PY-E19`) | DEC-PKG-10 | ✅ decidido |
| Plugins = recursos importáveis; cache `.pyc` externo (`PKG-E16`, `PKG-E17`, `PKG-E18`, `PKG-U9`, `PY-E22`) | DEC-PKG-11 | ✅ decidido (contrato); runtime = Fase 3 |
| Formato legado plist coexiste (`PKG-E15`) | DEC-PKG-12 | ✅ decidido (adapter) |

---

## 7. ⚠️ Incógnitas que afetam este módulo (refs PKG-U*)

| ID | Impacto neste módulo | Como a decisão contorna |
|---|---|---|
| `PKG-U1` | Formato do catálogo de nomes em memória do alvo | DEC-PKG-4 fixa um índice próprio; o do alvo vira só referência |
| `PKG-U2` | Ordem exata de merge (User ∧ sintaxe ∧ plataforma ∧ default) | DEC-PKG-3 define pilha ordenada `os→app→user` + filtro por escopo no `PropertySystem` |
| `PKG-U3` | Precedência "Installed Packages" vs "Packages" | DEC-PKG-3 trata tudo como **camadas da mesma pilha** (sem raiz privilegiada) |
| `PKG-U4` | Semântica de `.hidden-`/`hidden: true` além de "esconder" | DEC-PKG-7 normaliza para uma flag `hidden` única |
| `PKG-U5` | Se o pacote é selado/reaberto em runtime | DEC-PKG-5 trata pacotes como **read-only**; escrita só na camada `user` |
| `PKG-U6` | Versão/dependências de pacote (Package Control) | Adiado: fora do MVP (D7); sem política inventada |
| `PKG-U7` | Algoritmo de `extends`/`embed` (conflito de contexto) | DEC-PKG-8 resolve `extends` pelo namespace, mas **montagem final = aberta** (Fase 3) |
| `PKG-U8` | Regra de seleção de variante `(Linux)/(OSX)/(Windows)` | DEC-PKG-6 fixa a regra por `process.platform` |
| `PKG-U9` | Local exato do cache `__pycache__` preferido ao ZIP | DEC-PKG-11 usa cache externo próprio do `ExtensionHost` (local sob nosso controle) |

> **Nota de método (clean-room).** Documento de **síntese**: nenhuma linha de código, assembly,
> pseudocódigo, gramática, snippet, menu ou settings do alvo foi transcrita. Tudo se apoia no ledger
> de [`evidence-index.md`](../analysis/evidence-index.md) §8 (Empacotamento) e §10 (`PKG-U*`), com o
> contexto de padrão de [`packaging.md`](../analysis/packaging.md). Chaves de topo de formato
> (§2.3) aparecem como **contrato observável**, não como conteúdo de gramática.
