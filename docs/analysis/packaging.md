# Modelo de Empacotamento de Recursos — o "sistema de arquivos virtual" do editor 📦

> **Entregável:** P1.6 — como o build 4215 empacota, nomeia e resolve recursos (sintaxes,
> settings, keymaps, menus, snippets, plugins), do ponto de vista de quem só tem o **artefato
> extraído** (`target/sublime_text/`) e **não** tem os fontes do núcleo.
> **Regime clean-room:** este doc descreve **formato, campos, convenções e papel arquitetural**.
> Nenhuma gramática, snippet, menu ou arquivo de configuração de terceiros é transcrito por
> inteiro — só nomes de arquivos, contagens, chaves de topo e o *contrato* de cada tipo.
> Todas as afirmações trazem caminho real dentro de `target/sublime_text/`.
> Complemento: [`api-python.md`](api-python.md) (funções `load_resource`/`find_resources`/
> `list_packages` e o lado Python da resolução de pacotes).

**Achado central (1 frase):** recursos são um **namespace lógico plano** — cada pacote é um
**ZIP sem manifesto** (`<Nome>.sublime-package`) que o núcleo expõe como um diretório virtual sob
`Packages/<Nome>/…`; o **nome do arquivo ZIP define o prefixo lógico**, o **tipo do arquivo**
(extensão) define o *papel*, e a resolução é feita por **busca de caminho lógico com precedência
do usuário por cima do pacote embarcado** — não há índice nem build step, tudo é descoberto em
runtime por varredura de nomes.

---

## 1. 🔎 Escopo e fontes

Todos os caminhos são relativos a `target/sublime_text/`.

| Fonte | Conteúdo | Papel |
|---|---|---|
| `Packages/` | **54** arquivos `*.sublime-package` (ZIPs) | O "disco" de recursos embarcados — sintaxes, menus, keymaps, snippets, temas, plugins |
| `Packages/Default.sublime-package` | 107 entradas, 539 KB | Pacote **núcleo**: settings default, keymaps, menus, e os plugins Python do editor |
| `Packages/Text.sublime-package` | 3 entradas, 1,3 KB | Pacote mínimo: 1 syntax, 1 settings, 1 snippet |
| `Packages/Python.sublime-package` | 32 entradas, 609 KB | Pacote de **linguagem**: syntax grande + snippets + tmPreferences + embeddings |
| `Lib/` | `python314/`, `python33/`, `python3.14.zip`, `python3.3.zip`, `python3/certifi` | **Runtimes de plugin** (não são pacotes de recurso; hospedam a API e a stdlib) |
| `Lib/python314/sublime.py` | 4454 linhas | API pública: `load_resource:1203`, `load_binary_resource:1222`, `find_resources:1241`, `packages_path:775`, `installed_packages_path:785` |
| `Lib/python314/sublime_plugin.py` | 2445 linhas | `PackagePathFinder:2310` — o importador que resolve pacotes como módulos Python |

Métricas de inventário (`ls target/sublime_text/Packages/*.sublime-package | wc -l` → **54**;
`unzip -Z1` agregado → 2321 entradas, das quais **657** sem subdiretório).

---

## 2. 🗃️ Inventário: o que é "um pacote"

### 2.1 Lista de pacotes (54)

Categorias observáveis pelos nomes:

| Categoria | Exemplos (`Packages/*.sublime-package`) |
|---|---|
| Núcleo / utilitário | `Default`, `Text`, `Binary`, `Vintage` |
| Linguagens | `Python`, `JavaScript`, `PHP`, `C++`, `C#`, `Java`, `Ruby`, `Go`, `Rust`, `HTML`, `CSS`, `ShellScript`, `SQL`, `JSON`, `YAML`, … |
| Tema / aparência | `Theme - Default`, `Color Scheme - Default`, `Color Scheme - Legacy` |
| Localização / dados | `Language - English` (1,6 MB — o maior) |
| Formatos auxiliares | `Git Formats`, `Diff`, `Regular Expressions`, `Makefile`, `TOML` |

Tamanhos: de **496 B** (`Binary`) a **1,67 MB** (`Language - English`). O maior pacote é um
**banco de dados/recursos**, não uma linguagem.

### 2.2 Estrutura de diretórios do artefato

```
target/sublime_text/
├── Packages/                 # 54 *.sublime-package (ZIPs) — recursos embarcados
├── Lib/                      # runtimes Python (não é pacote de recurso)
│   ├── python314/  python33/ #   shims da API (sublime.py, sublime_plugin.py)
│   ├── python3/              #   site-packages (certifi)
│   └── python3.14.zip  python3.3.zip
├── sublime_text  plugin_host-3.14  plugin_host-3.3   # binários nativos
└── Icon/  attribution.txt  changelog.txt  *.so
```

Observação: **não existe `Packages/User/` nem `Installed Packages/`** no tarball — só a árvore
embarcada. Os diretórios de usuário são criados em runtime na config do SO (ver §6 e as funções
`packages_path`/`installed_packages_path`).

---

## 3. 🧱 Formato de pacote (ZIP sem manifesto)

- Cada `.sublime-package` é um **arquivo ZIP comum** (`unzip -l` lista normalmente; cabeçalho
  `Archive:` reconhecido). Não há assinatura proprietária nem compressão especial visível.
- **Não existe arquivo de manifesto** (nenhum `manifest.json`/`package.json`/`*.sublime-manifest`
  aparece em nenhuma listagem). O "índice" do pacote é **o próprio diretório ZIP**: o nome do
  arquivo `<Nome>.sublime-package` → prefixo lógico `Packages/<Nome>/`.
- O ZIP tem **flat layout**: os recursos ficam nas raízes relativas do pacote, que na visão lógica
  viram `Packages/<Nome>/<caminho interno>`. Ex.: entrada `Context.sublime-menu` em
  `Default.sublime-package` é o recurso lógico `Packages/Default/Context.sublime-menu`.
- O docstring de `load_resource` (`sublime.py:1205`) confirma o formato canônico do **nome lógico**:
  `"Packages/Default/Main.sublime-menu"`.

### 3.1 O tipo do arquivo é o contrato (papel por extensão)

Contagem por extensão em todos os 54 pacotes (papel arquitetural à direita):

| Extensão | N | Papel |
|---|---|---|
| `.sublime-snippet` | 865 | Snippets (tags de expansão + escopo de aplicação) |
| `.png` | 395 | Ícones/ativos de UI (`@2x`/`@3x` são variantes de densidade) |
| `.tmPreferences` | 268 | Metadados de símbolos/ícones/indentação (plist legado) |
| `.sublime-syntax` | 203 | Gramática de destaque (YAML — ver §4) |
| `.py` | 63 | **Plugins** Python (código executável — ver §5) |
| `.sublime-completions` | 61 | Listas de autocomplete |
| `.sublime-settings` | 56 | Configuração (JSON com comentários — ver §6) |
| `.sublime-keymap` | 24 | Bindings de teclado (JSON array com `keys`/`command`) |
| `.tmTheme` | 21 | Tema de sintaxe legado |
| `.sublime-build` | 21 | Templates de build (JSON com variantes) |
| `.sublime-menu` | 18 | Menus (JSON array) |
| `.sublime-macro` | 10 | Macros (sequência de comandos) |
| `.sublime-mousemap` | 6 | Bindings de mouse |
| `.sublime-color-scheme` | 5 | Esquema de cores moderno (JSON) |
| `.sublime-theme` | 3 | Tema de UI (JSON) |
| `.tmLanguage` | 1 | Gramática legada (plist XML) — só `Text/Plain text.tmLanguage` |

Leitura: **a extensão define o subsistema consumidor**. Não há um registro central de tipos — o
núcleo despacha por sufixo.

---

## 4. 🧩 Layout interno e subdiretórios

O ZIP é majoritariamente plano (657 de 2321 entradas sem diretório), mas convenções de
subdiretório separam famílias de recursos:

| Subdiretório | Onde aparece | Papel |
|---|---|---|
| `Snippets/` | `Python`, `Shell`, `Zsh`, `Bash`, `PHP`, `Text` | Agrupa `.sublime-snippet` da linguagem |
| `Embeddings/` | `Python`, `PHP` | Gramáticas **parciais** que são embutidas noutra (ex.: `Embeddings/TOML (for Python).sublime-syntax`) |
| `tests/` | `Python`, `Shell`, `Bash`, `Zsh` | Arquivos `syntax_test_*.py` — testes de gramática (dados, não recursos de runtime) |
| `send2trash/` | `Default` | Pacote Python de **biblioteca** embarcada (usado pelos plugins do núcleo) |
| `Bash/`, `Shell/`, `Zsh/` | `ShellScript` | **Subpacotes** por variante de linguagem dentro de um único ZIP |

Convenções de nome de arquivo observáveis:

- **Variantes por plataforma:** `Default (Linux).sublime-keymap`, `... (OSX)`, `... (Windows)`;
  idem `.sublime-mousemap` e `Preferences (Linux).sublime-settings`. O parêntese codifica a
  plataforma — o núcleo carrega só a variante da plataforma corrente.
- **Recursos ocultos/marcados:** prefixo/sufixo `.hidden-` (ex.: `Find Results.hidden-tmLanguage`,
  `Widget - Default.hidden-color-scheme`) → recurso existe mas é ocultado de listagens de UI.
- **Arquivos de controle embarcados:** `.python-version` (6 pacotes) — metadado de tooling Python.
- **Sintaxes `hidden: true`:** 102 ocorrências — gramáticas internas (como `Binary.sublime-syntax`)
  que têm `scope` mas **não** aparecem no seletor de sintaxe do usuário.

---

## 5. 📐 Modelo de `.sublime-syntax` (gramática dirigida por contexts/patterns)

Um `.sublime-syntax` é **YAML 1.2** (abre com `%YAML 1.2` + `---`; `# http://www.sublimetext.com/docs/syntax.html`).
O modelo é uma **máquina de estados de destaque**: um conjunto de *contextos* (estados), cada um
com uma lista ordenada de *padrões* (regras) que casam regex e transicionam de estado.

### 5.1 Chaves de topo (contrato de descoberta)

| Chave | Função | Obrigatória |
|---|---|---|
| `name` | Nome humano da sintaxe (mostrado no seletor) | sim |
| `scope` | Escopo-raiz (ex.: `source.python`, `text.html.markdown`) — **identidade semântica** usada por tema/matching | sim |
| `version` | Versão do formato de gramática (observado: `2`) | recomendada |
| `file_extensions` | Lista de extensões que ativam a sintaxe (ex.: `py`, `pyi`, `pyx`) | para auto-detecção |
| `hidden_file_extensions` | Nomes de arquivo sem extensão (ex.: `SConstruct`, `Snakefile`) | opcional |
| `first_line_match` | Regex (multilinha) casada na 1ª linha — detecção por conteúdo (shebang/`-*-`) | opcional |
| `contexts` | Mapa **contexto → lista de padrões**; deve conter `main` | sim |
| `variables` | Snippets de regex reutilizáveis interpolados com `{{nome}}` | opcional |
| `extends` | **Herança** por caminho de recurso (ver §6.3) | opcional |
| `hidden` | `true` esconde a sintaxe do seletor | opcional |

### 5.2 Ações de padrão (o vocabulário da máquina de estados)

Contagem agregada nos 203 arquivos (o que a gramática faz, sem transcrever corpo):

| Ação | N | Semântica (1 linha) |
|---|---|---|
| `match` | 13865 | Regex de entrada da regra |
| `include` | 10966 | Inclui outro contexto (composição/reuso) |
| `scope` | 9214 | Atribui escopo semântico ao trecho casado |
| `pop` | 3461 | Sai do contexto atual |
| `push` | 3204 | Entra num contexto novo |
| `set` | 3027 | Substitui o contexto atual |
| `captures` | 2789 | Escopos por grupo de captura do regex |
| `meta_scope` / `meta_content_scope` | 2126 / 1092 | Escopo que cobre a extensão do contexto |
| `meta_include_prototype` | 1388 | Liga/desliga herança do contexto `prototype` |
| `embed`/`escape` | 378 / 384 | Embutir outra sintaxe (ex.: `Embeddings/`) com regra de saída |
| `fail` | 239 | Retorna sem consumir |
| `clear_scopes` | 168 | Limpa escopos herdados |
| `branch` / `branch_point` | 159 / 159 | Bifurcação de estado (retomada livre) |
| `meta_prepend` / `meta_append` | 346 / 46 | Adiciona padrões ao início/fim de um contexto herdado |
| `with_prototype` / `apply_prototype` | 22 / 36 | Anexa padrão prototípico ao `push` |
| `contexts` / `variables` | 196 / 125 | Definições internas do próprio arquivo |

Padrões de projeto que emergem (sem citar conteúdo):

- **`prototype` é um contexto implícito** reusado por todos: `meta_include_prototype: true`
  injeta um conjunto comum de regras (tipicamente comentários/whitespace) em cada contexto.
- **`main` é o estado inicial** — obrigatório no mapa `contexts`.
- **Reuso cross-package:** via `extends:` ou `include:` referenciando `Packages/<Pacote>/<Arquivo>`.
- **Gramática embutida:** `embed`/`escape` chamam uma sintaxe externa (o padrão "Embeddings/…") e
  definem como voltar.

### 5.3 Formato legado coexistente

`Text.sublime-package` traz `Plain text.tmLanguage` — **plist XML** com chaves `fileTypes`
(array), `name`, `patterns` (array), `scopeName`. É a versão pré-YAML da mesma ideia; o núcleo
aparentemente **aceita ambos** (nomes `*.tmLanguage`/`hidden-tmLanguage` e `*.sublime-syntax`).
`.tmPreferences` segue o mesmo formato plist e casa por `scope` (ex.: `source.python entity.name.class`)
para definir metadados como `showInSymbolList`.

---

## 6. 🔀 Precedência, overrides e "recursos soltos"

### 6.1 Não há arquivos soltos fora de pacotes no tarball

Todos os recursos vivem **dentro** de um `.sublime-package`. O único "solto" é `Lib/` (runtimes) —
que **não** é recurso de editor. Não há `.sublime-syntax` ou `.sublime-settings` avulso em
`target/sublime_text/`.

### 6.2 Precedência usuário > pacote — declarada pelo próprio artefato

O cabeçalho de `Packages/Default/Preferences.sublime-settings` documenta o contrato de override
(paráfrase — comentário do artefato):

> configurações em `Packages/User/Preferences.sublime-settings` **sobrescrevem** as de
> `Packages/Default`; settings também podem ser específicos por sintaxe
> (ex.: `Packages/User/Python.sublime-settings`).

Regra observável derivada:

- **`Packages/User/*` vence `Packages/*`**: o diretório `User` (na config do SO) é a camada
  editável; os pacotes embarcados são *defaults*.
- **Settings por sintaxe sobrepõem settings gerais** (ex.: `Python.sublime-settings` casa por
  escopo/`scope`).
- **Variantes de plataforma** (`Preferences (Linux).sublime-settings`) sobrepõem a base.

Contudo, a **ordem exata de merge em cadeia** (User ∧ syntax ∧ platform ∧ default) e o algoritmo
de combinação de chaves **não** são observáveis no artefato — ver U2.

### 6.3 Herança de sintaxe (`extends`)

`extends:` usa **caminho lógico de recurso**, em duas formas observáveis:

- **Local ao pacote:** `extends: Markdown.sublime-syntax` (relativo ao próprio pacote, ex.: dentro
  de `Markdown.sublime-package`).
- **Cross-package:** `extends: Packages/CSS/CSS.sublime-syntax`,
  `Packages/Batch File/Batch File.sublime-syntax` — referência por `Packages/<Pacote>/<Arquivo>`.

Isso permite **reutilizar uma gramática-base** e apenas ajustar (via `contexts` com
`meta_prepend`/`meta_append`, como no exemplo `Embeddings/TOML (for Python)`). A herança é
**por nome lógico**, não por caminho físico — logo a resolução precisa do mesmo mapa de recursos.

---

## 7. ⚙️ Como o núcleo aparenta resolver/merge (dos artefatos + API)

O que os **artefatos** provam:

1. **Nome lógico → recurso.** `load_resource(name)` (`sublime.py:1203`) recebe nome no formato
   `Packages/Default/Main.sublime-menu` e é resolvido por `sublime_api.load_resource` (nativo). O
   Python só repassa e converte erro (`:1216-1219`).
2. **Descoberta por padrão glob.** `find_resources(pattern)` (`sublime.py:1241`) → nativo
   `find_resources`. Ou seja: o núcleo mantém um **catálogo navegável** de nomes de recurso e
   casa por glob (não exige saber o pacote de antemão).
3. **Erros tipados por categoria.** `load_resource` pode levantar `FileNotFoundError`,
   `FileTooLargeError` (com `max_size`, default 16 MiB = `1 << 24`) e `IsADirectoryError`
   (`sublime.py:1212-1214`) — logo o núcleo **distingue arquivo de diretório** mesmo no ZIP, e
   é **tolerante a diretório** (ressalva de "loading large resources … stutter", `:1207-1208`,
   indica leitura síncrona sob demanda).
4. **Caminhos de pasta expostos.** `packages_path()` (`:775`) e `installed_packages_path()`
   (`:785`) devolvem, respectivamente, as pastas **"Packages"** e **"Installed Packages"**
   (`:780`, `:790`). Isso é a evidência mais forte de **duas raízes distintas**: a de recursos
   *embarcados/editáveis* (`Packages/`) e a de pacotes *instalados* (`.sublime-package` baixados).
5. **Importação de pacotes como módulos Python.** `PackagePathFinder` (`sublime_plugin.py:2310`)
   registra-se em `sys.meta_path` (`:2430`). Ao importar `foo.bar` ele mapeia o 1º segmento para o
   pacote registrado (`:2326-2332`), procura `Packages/foo/bar/{__init__.pyc,__init__.py,.pyc,.py}`
   via `sublime_api.stat_resource_file` (`:2346`) e, se for diretório, `stat_resource_dir`
   (`:2349`); os bytes vêm de `load_binary_resource` (`:2405`). **O mesmo namespace lógico
   `Packages/…` serve para import de código e para leitura de dados.**
6. **Cache de bytecode fora do ZIP.** O código comenta que `.pyc` "can end up outside our packages
   path if they're contained in `__pycache__`" (`:2396-2397`) e tenta o filesystem antes do ZIP —
   indício de que o editor **escreve bytecode compilado** num cache externo e o prefere (lazy
   compile). `update_compressed_packages(pkgs)` (`:2433`) é o ponto onde o nativo **empurra para
   o Python** a lista de pacotes a registrar (`PackagePathFinder.update_packages:2320`).

Inferências (marcadas):

- **INFERIDO — precedência de resolução `User` > pacote embarcado > (Installed Packages?)**: a
  existência de duas raízes (`packages_path` vs `installed_packages_path`) mais o comentário de
  override em `Preferences.sublime-settings` sustentam que a busca de um nome lógico consulta
  primeiro a árvore do usuário. A **ordem exata** entre "Installed Packages" e "Packages" não é
  observável aqui.
- **INFERIDO — lazy load**: `load_resource` é **síncrono e só quando chamado** (`:1206-1208`);
  não há sinal de que todos os 2321 recursos sejam pré-carregados. A descoberta (`find_resources`)
  sugere um **catálogo de nomes** mantido, com leitura de conteúdo sob demanda.
- **INFERIDO — merge por escopo**: `.tmPreferences` e settings específicos por sintaxe casam por
  `scope`/`selector` (campos `scope:` e `selector:` observados em `Symbol List.tmPreferences` e
  `Python.sublime-build`), logo a aplicação é **filtrada pelo escopo da sintaxe ativa**, não
  global.
- **DESCONHECIDO — formato do catálogo em memória** (tabela hash? lista ordenada?), **regra de
  "último/local vence"** em chaves conflitantes de settings, **ordem de overlay** entre
  plataforma/sintaxe/User, e se `.sublime-package` é reaberto/re-selado em runtime. Nada disso é
  visível nos artefatos; exigiria o nativo (fora do escopo barato deste item).

---

## 8. 🧭 Implicações para a reimplementação (Electron/TS)

- **Um VFS lógico basta.** Modelar recursos como um mapa `nome lógico (Packages/<pkg>/<path>) →
  bytes`, alimentado por (a) ZIPs do build, (b) diretórios do usuário, (c) pacotes instalados.
  Não é preciso "manifesto" — o índice é o cruzamento de nomes.
- **Despacho por sufixo.** Um registry `extensão → consumidor` (syntax/settings/keymap/menu/
  snippet/plugin/theme) reproduz o comportamento observado, sem tabela central no artefato.
- **Gramática = máquina de estados data-driven.** Um interpretador genérico de `contexts`/
  `patterns` com `match/push/set/pop/include/embed` + `prototype` cobre o formato v2; `extends`
  precisa de resolução por nome lógico (mesma do VFS).
- **Precedência em camadas.** `default(pacote) → plataforma → sintaxe → User`, com `find_resources`
  devolvendo nomes e `load_resource` lendo sob demanda + `max_size` (16 MiB) e erros tipados.
- **Plugins Python:** reusar o conceito `Packages/… → módulo Python` (meta-path/loader) se/quando
  houver hospedagem de plugins; para o núcleo TS, `Lib/` é irrelevante.

---

## 9. 📋 Ledger de evidências

`tipo`: **inventário** = contagem/listagem | **zip-layout** = estrutura interna de ZIP |
**yaml** = campos/estrutura de gramática | **manifest** = ausência/declaração de metadados.

| # | Conclusão | Caminho / comando | Tipo | Limite / incerteza |
|---|---|---|---|---|
| E1 | 54 pacotes `.sublime-package` em `Packages/` | `ls target/sublime_text/Packages/*.sublime-package \| wc -l` = 54 | inventário | — |
| E2 | Cada pacote é um ZIP comum, sem manifesto | `unzip -l Packages/Default.sublime-package`; nenhum `manifest.json` em 2321 entradas | manifest | Não prova ausência de campo de comentário ZIP — só de arquivo-manifesto |
| E3 | Nome do arquivo ZIP = prefixo lógico `Packages/<Nome>/` | docstring `Lib/python314/sublime.py:1205` (`"Packages/Default/Main.sublime-menu"`) | manifest | Mapeamento `<Nome>`↔nome lógico é convenção; não há tabela explícita |
| E4 | ZIP é flat; 657/2321 entradas sem diretório | `unzip -Z1` agregado dos 54 pacotes | zip-layout | — |
| E5 | Papel do recurso = extensão (16 tipos mapeados) | contagem por sufixo (§3.1) | inventário | Mapa tipo→consumidor é observado por nome, não por código do núcleo |
| E6 | Subdiretórios convencionais `Snippets/`, `Embeddings/`, `tests/` | `unzip -l Packages/Python.sublime-package` | zip-layout | `tests/` são dados de teste, não recursos de runtime |
| E7 | Subpacotes por variante dentro de 1 ZIP (`Bash/`, `Shell/`, `Zsh/`) | `unzip -l Packages/ShellScript.sublime-package` | zip-layout | — |
| E8 | Variante de plataforma no nome `(Linux)/(OSX)/(Windows)` | `Default (Linux).sublime-keymap`, `Preferences (OSX).sublime-settings` | inventário | Regra de seleção exata = desconhecida |
| E9 | Recursos ocultos via `.hidden-` no nome | `Find Results.hidden-tmLanguage` (Default); `.hidden-color-scheme` (Theme - Default) | inventário | Efeito exato só no núcleo |
| E10 | Sintaxes internas marcadas `hidden: true` (102) | `grep -c '^hidden: true'` agregado | yaml | — |
| E11 | `.sublime-syntax` = YAML v2 com `name/scope/file_extensions/first_line_match/contexts/variables/extends` | `unzip -p Packages/Python.sublime-package Python.sublime-syntax` (chaves de topo, `:1-4320`) | yaml | Estrutura observada; semântica de execução do motor é do C++ |
| E12 | Gramática dirigida por estados: `match/push/set/pop/include/scope/captures` dominam | contagem agregada (§5.2) | yaml | Números = frequência de regras, não contrato formal |
| E13 | `prototype` é contexto comum; `main` obrigatório | `meta_include_prototype` (1388×); `contexts: main: []` em `Binary.sublime-syntax` | yaml | — |
| E14 | Herança por nome lógico: local e `Packages/<Pkg>/<File>` | `extends:` agregados (ex.: `Packages/CSS/CSS.sublime-syntax`) | yaml | Resolução de alvo usa o mesmo VFS |
| E15 | Formato legado plist coexiste | `Packages/Text.sublime-package/Plain text.tmLanguage`; `Python/Symbol List.tmPreferences` | manifest | Aceitação dos dois formatos é inferida da presença, não testada |
| E16 | Plugins Python embarcados em 6 pacotes (63 `.py`) | `Default` 47, `CSS` 5, `Python` 5, `Vintage` 3, `HTML` 2, `Diff` 1 | inventário | — |
| E17 | Pacotes importáveis como módulos por meta-path | `Lib/python314/sublime_plugin.py:2310`, `:2326-2355`, `:2430`, `:2433` | manifest | Formato do `pkgs` empurrado pelo nativo é inferido |
| E18 | Cache de bytecode externo (`__pycache__`) preferido ao ZIP | `sublime_plugin.py:2396-2403` (comentário no artefato) | manifest | Local exato do cache = desconhecido (usa `cache_path`) |
| E19 | `load_resource`/`find_resources` resolvem nome lógico/glob no nativo | `Lib/python314/sublime.py:1203`, `:1241`; erros tipados `:1212-1214`; `max_size` 16 MiB `:1203` | manifest | Algoritmo de busca/merge não está no artefato |
| E20 | Duas raízes de pacote: "Packages" e "Installed Packages" | `sublime.py:775-792` (`packages_path`, `installed_packages_path`) | manifest | Ordem de precedência entre elas = U |
| E21 | Override `User` > `Default` (declarado no artefato) | comentário de `Packages/Default.sublime-package/Preferences.sublime-settings` (cabeçalho) | inventário | Regra de merge em cadeia = U |
| E22 | Settings/build/wp casam por `scope`/`selector` | `Python/Symbol List.tmPreferences` (`scope`), `Python/Python.sublime-build` (`selector`) | manifest | Aplicação filtrada por escopo é inferida |

---

## 10. ⚠️ Limites e incógnitas

| # | Incógnita | Por quê | O que fecharia |
|---|---|---|---|
| U1 | **Formato do catálogo de recursos em memória** do núcleo | `find_resources` é nativo; só se vê o resultado (glob) | Ghidra no `sublime_text` (fora do escopo barato) |
| U2 | **Ordem exata de merge** User ∧ sintaxe ∧ plataforma ∧ default | só o comentário de override é observável; a cadeia não | teste empírico / strings do nativo |
| U3 | **Precedência "Installed Packages" vs "Packages"** | duas raízes existem, mas a colisão de nomes não é exercida no tarball | instalar pacote homônimo e observar |
| U4 | **Semântica de `.hidden-`/`hidden: true`** além de "esconder" | nome marcado, mas o efeito é do núcleo | mapear no nativo |
| U5 | **Se `.sublime-package` é selado/reaberto em runtime** | ZIP estático no disco; nada no artefato indica mutação | traçar I/O do núcleo |
| U6 | **Campo de versão do pacote / dependências (Package Control)** | ausente nos ZIPs embarcados; política de 3º é do Plugin externo | analisar pacote instalado por Package Control |
| U7 | **Algoritmo de `extends`/`embed` (resolução de conflito de contexto)** | vê-se a declaração, não a montagem final da gramática | spec oficial + teste com `syntax_test_*` |

### Nota de método (clean-room)

Nenhuma gramática, snippet, menu, keymap ou settings de terceiros foi **transcrito**: este doc
registra **nomes de arquivo, contagens, chaves de topo e frequência de ações**, mais o *papel*
arquitetural inferido. Trechos como `name: Python` / `scope: source.python` aparecem por serem
**contrato observável do formato** (chaves de topo de um schema), não por reproduzirem conteúdo de
gramática. Caminhos e linhas citados são do próprio artefato ou do shim Python embarcado
(`Lib/python314/`), este último já tratado como interface em [`api-python.md`](api-python.md).
