# API Python de Plugins — o contrato da ponte C++ ↔ Python 🔌

> **Entregável:** P1.3 (lado Python) — como o núcleo nativo expõe a API de plugins, do ponto de
> vista de quem só tem o **artefato** (tarball) e **não** tem o fontes do núcleo.
> **Regime clean-room:** este doc lista **interface** (nome + assinatura + semântica em 1 linha).
> Nenhum bloco de implementação do alvo é transcrito — só assinaturas, contagens e o *papel*
> arquitetural de cada símbolo. Todas as afirmações trazem `arquivo:linha`.
> **Caminhos são relativos a `target/sublime_text/Lib/`** (ex.: `python314/sublime.py:1369`).
> Complemento: [`ipc-plugin-host.md`](ipc-plugin-host.md) (o *transporte* da ponte).

**Achado central (1 frase):** o lado Python é um **facade fino e quase stateless** sobre um
módulo nativo embutido chamado `sublime_api`; o estado real (buffers, views, settings, callbacks)
vive no C++, e o Python só manipula **handles opacos (int)** — a inteligência do lado Python está
em `sublime_plugin.py` (registro, dispatch de eventos, subclasse de `Sheet`, importação de pacotes).

---

## 1. 🔎 Escopo e fontes

| Arquivo (rel. a `target/sublime_text/Lib/`) | Linhas | Papel |
|---|---|---|
| `python314/sublime.py` | 4454 | **Facade da API pública** (3.14 / build 4215): 64 funções de módulo, 42 classes públicas (17 enums), 331 métodos |
| `python314/sublime_plugin.py` | 2445 | **Host de plugins**: classes-base, registro em tabelas globais, dispatch `on_*`, importação de `.sublime-package`, `sys.stdout` |
| `python314/sublime_types.py` | 10 | 8 aliases de tipo PEP 695 (`type X = ...`) reusados pela superfície tipada |
| `python314/imp.py` | 8 | Shim do módulo `imp` (removido do stdlib): reexporta `reload`, `cache_from_source`, `source_from_cache` (`python314/imp.py:5-8`) |
| `python33/sublime.py` | 2270 | **Baseline 3.3** (para o delta): 63 funções, 24 classes públicas (**0 enums**), 312 métodos, 106 constantes int soltas |
| `python33/sublime_plugin.py` | 1748 | Baseline 3.3: 14 classes, 86 funções |
| `target/sublime_text/plugin_host-3.14` (2,1 MB) / `plugin_host-3.3` (6,5 MB) | — | **Lado nativo**: ELF PIE x86-64 que **hospeda** o interpretador e **embute** o módulo `sublime_api`. Não é fonte; é onde o contrato nativo mora |
| `Lib/python3.14.zip` (4,6 MB) / `Lib/python3.3.zip` (2,6 MB) | — | stdlib empacotada dos dois runtimes |

O import da ponte é explícito nas duas pontas do lado Python:
`import sublime_api` em `python314/sublime.py:12` (`python33/sublime.py:6`) e em
`python314/sublime_plugin.py:16` (`python33/sublime_plugin.py:19`).
`sublime_api` **não tem stub, `.py` nem `.pyi`** em lugar nenhum do tarball — logo o módulo é
**embutido no `plugin_host-*`** e sua superfície só é observável pelos *call-sites*.

---

## 2. 📦 Inventário da API 3.14

### 2.1 Números do lado Python

| Métrica | `sublime.py` | `sublime_plugin.py` | Nota |
|---|---|---|---|
| Linhas | 4454 | 2445 | `wc -l` |
| Funções de módulo | 64 | 86 | inclui 1 privada `_buffers` (`sublime.py:3762`) e 54 `on_*` no plugin |
| Classes declaradas | 43 | 15 | 43 = 17 enums + 24 classes + 2 auxiliares (`_LogWriter:18`, `FileTooLargeError:42`); `grep -c '^class '` |
| Enums (`IntEnum`/`IntFlag`) | **17** | 0 | `IntEnum` = 9, `IntFlag` = 8 |
| Métodos (`def` indentado) | 331 | 69 (65 de classe + 4 closures) | |
| Símbolos `sublime_api.*` distintos | 276 | 14 | **284 no total** (interseção pequena) |
| Constantes soltas `^[A-Z_]+ =` | 100 | 0 | 89 são *reexports* de membros de enum |

### 2.2 Funções de módulo de `sublime.py` por categoria (64)

| Categoria | N | Símbolos (`linha`) |
|---|---|---|
| Info/ambiente | 10 | `version:724` `platform:731` `arch:738` `channel:745` `executable_path:752` `executable_hash:762` `packages_path:775` `installed_packages_path:785` `cache_path:795` `lib_path:805` |
| Diálogos e mensagens | 9 | `status_message:814` `error_message:819` `message_dialog:824` `ok_cancel_dialog:829` `yes_no_cancel_dialog:842` `open_dialog:854` `save_dialog:891` `select_folder_dialog:913` `choose_font_dialog:937` |
| Comandos (string) | 4 | `run_command:962` `format_command:969` `html_format_command:988` `command_url:997` |
| Clipboard | 3 | `get_clipboard_async:1006` `get_clipboard:1018` `set_clipboard:1030` |
| Flags de log (pares set/get) | 14 | `log_commands:1035`/`get_log_commands:1046` `log_input:1055`/`get_log_input:1067` `log_fps:1076`/`get_log_fps:1089` `log_result_regex:1098`/`get_log_result_regex:1110` `log_indexing:1119`/`get_log_indexing:1130` `log_build_systems:1139`/`get_log_build_systems:1150` `log_control_tree:1159`/`get_log_control_tree:1173` |
| Introspecção/score | 2 | `ui_info:1182` `score_selector:1192` |
| Recursos | 3 | `load_resource:1203` `load_binary_resource:1222` `find_resources:1241` |
| Serialização | 3 | `encode_value:1248` `decode_value:1264` `expand_variables:1279` |
| Settings (load/save) | 2 | `load_settings:1289` `save_settings:1302` |
| Timers | 2 | `set_timeout:1309` `set_timeout_async:1318` |
| Janelas globais | 2 | `active_window:1326` `windows:1333` |
| Histórico | 3 | `get_macro:1340` `project_history:1349` `folder_history:1360` |
| Sintaxe | 5 | `list_syntaxes:4247` `syntax_from_path:4255` `find_syntax_by_name:4263` `find_syntax_by_scope:4271` `find_syntax_for_file:4279` |
| Sheets | 1 | `make_sheet:2435` |
| Interno | 1 | `_buffers:3762` (usado por `sublime_plugin` em `:553` e `:744`) |

Três funções **não** chamam o nativo e são puro Python de conveniência:
`executable_hash` (md5 do binário via `hashlib`, `:762`), `format_command`/`html_format_command`/
`command_url` (`:969`/`:988`/`:997`), e `find_syntax_by_name`/`find_syntax_by_scope`
(filtram sobre `list_syntaxes`, `:4263`/`:4271`).

### 2.3 Enums (17) — todos com *reexport* de compatibilidade fora do enum

| Enum (`linha`) | Base | Membros | Semântica |
|---|---|---|---|
| `HoverZone:47` | IntEnum | 3 | zona do hover (`TEXT`/`GUTTER`/`MARGIN`) → `HOVER_*` (`:67-69`) |
| `NewFileFlags:72` | IntFlag | 9 | flags de `new_file`/`open_file`/`new_html_sheet` (sem prefixo: `ENCODED_POSITION:139` … `FORCE_CLONE:146`) |
| `FindFlags:149` | IntFlag | 6 | flags de `View.find`/`find_all` (`LITERAL:186` … `WRAP:190`) |
| `QuickPanelFlags:193` | IntFlag | 4 | flags de `show_quick_panel` (`:219-221`) |
| `PopupFlags:224` | IntFlag | 6 | flags de `View.show_popup` (`:265-268`) |
| `RegionFlags:271` | IntFlag | 12 | desenho de regions (`DRAW_*`) |
| `QueryOperator:321` | IntEnum | 6 | operador de contexto de keymap (`EQUAL`…`NOT_REGEX_CONTAINS`) |
| `PointClassification:355` | IntFlag | 10 | bio de caracteres para `find_by_class`/`expand_by_class` |
| `AutoCompleteFlags:398` | IntFlag | 5 | `INHIBIT_WORD_COMPLETIONS`, `DYNAMIC_COMPLETIONS`, `INHIBIT_REORDER`… |
| `CompletionItemFlags:440` | IntFlag | 2 | `NONE`, `KEEP_PREFIX` |
| `DialogResult:449` | IntEnum | 3 | `CANCEL=0`/`YES=1`/`NO=2` → `DIALOG_*` (`:463-465`) |
| `UIElement:471` | IntEnum | 6 | bitmask de 1/2/4/8/16/32 — marcado `:meta private:` (`:472`) |
| `PhantomLayout:481` | IntEnum | 3 | `INLINE`/`BELOW`/`BLOCK` → `LAYOUT_*` (`:506-508`) |
| `KindId:512` | IntEnum | 19 | ícone/classe de símbolo: 9 `KIND_*` semânticos + 10 `COLOR_*` → `KIND_ID_*` (`:562-580`) |
| `SymbolSource:620` | IntEnum | 3 | `ANY`/`INDEX`/`OPEN_FILES` |
| `SymbolType:654` | IntEnum | 3 | `ANY`/`DEFINITION`/`REFERENCE` |
| `CompletionFormat:687` | IntEnum | 3 | `TEXT`/`SNIPPET`/`COMMAND` |

Os `19` `KIND_ID_*` também existem como **tuplas** prontas `KIND_*: Kind = (KindId.X, "", "")`
(`:582-614`) — o nativo recebe a tupla, não o enum.

### 2.4 Classes de `sublime.py` (25 + 2 auxiliares)

`native` = nº de chamadas `sublime_api.*` no corpo da classe (mede o quão "fina" ela é).

| Classe (`linha`) | Métodos | native | Papel / handle | Semântica em 1 linha |
|---|---|---|---|---|
| `Window:1369` | 78 | 71 | `window_id` (`:1374`), sempre acompanhado de `(objeto) (…, window_id, …)` | janela: grupos, sheets/views, painéis, layout, projeto, settings, símbolos |
| `Edit:2071` | 2 | 0 | `__slots__=['edit_token']` (`:2080`) | token de uma sessão de edição; **não criável pelo usuário** (`:2075-2077`) |
| `Region:2089` | 17 | 0 | `__slots__=['a','b','xpos']` (`:2098`) | valor puro (ordenação/`xpos`); operações resolvidas **em Python** |
| `HistoricPosition:2244` | 2 | 0 | campos `pt/row/col/col_utf16/col_utf8` (`:2255`) | posição histórica para `TextChange` |
| `TextChange:2281` | 2 | 0 | `pa/pb/len_utf16/len_utf8/s` (`:2291`) | descrição de uma mudança de buffer |
| `Selection:2321` | 19 | 13 | `__slots__=['view_id']` (`:2329`) | conjunto ordenado de `Region`; **reusa o id da View** |
| `Sheet:2446` | 15 | 10 | `sheet_id` (`:2452`) | contêiner (aba) — `group`, `window`, `view`, `close(on_close)` |
| `TextSheet:2562` | 1 | 0 | — | subtipo de `Sheet` para texto |
| `ImageSheet:2573` | 1 | 0 | — | subtipo para imagem |
| `HtmlSheet:2584` | 2 | 1 | `set_contents` → `html_sheet_set_contents` (`:2597`) | subtipo para HTML |
| `ContextStackFrame:2599` | 2 | 0 | `context_name/source_file/source_location` (`:2609`) | frame de `context_backtrace` |
| `View:2626` | **133** | **133** | `view_id` (`:2635`) | **a maior superfície**: buffer, seleção, regions, phantoms, popups, folds, encoding, scroll, completions |
| `Buffer:3766` | 8 | 3 | `buffer_id` (`:3774`) | buffer compartilhável entre views (`:3768`); `id/file_name/views/primary_view` |
| `Settings:3819` | 15 | 16 | `settings_id` (`:3826`) | **dict-like** (mapping protocol) + `to_dict/setdefault/update` + `add_on_change` |
| `Phantom:3953` | 4 | 0 | `id` preenchido pelo nativo | conteúdo inline/below com `on_navigate` |
| `PhantomSet:4004` | 4 | 0 | `view`+`key` (`:4012`) | gerencia ciclo de vida dos phantoms; `__del__` apaga por id (`:4025-4028`) |
| `Html:4068` | 2 | 0 | `data` (`:4076`) | wrapper de HTML para preview/popup |
| `CompletionList:4083` | 3 | 1 | `target: MultiCompletionList \| None` (`:4098`) | lista possivelmente assíncrona; `set_completions` **thread-safe** (`:4105`) |
| `CompletionItem:4129` | 5 | 0 | — | item de autocomplete (`snippet_completion`/`command_completion`: `:4206`/`:4226`) |
| `Syntax:4296` | 4 | 0 | `path/name/hidden/scope` (`:4305`) | valor de sintaxe instalada |
| `QuickPanelItem:4326` | 2 | 0 | — | item do quick panel |
| `ListInputItem:4359` | 2 | 0 | — | item de `ListInputHandler` |
| `SymbolRegion:4396` | 2 | 0 | `name/region/syntax/type/kind` (`:4405`) | região de símbolo |
| `SymbolLocation:4423` | 3 | 0 | `path/display_name/row/col/syntax/type/kind` (`:4432`) | localização em índice; `path_encoded_position:4453` |
| `_LogWriter:18` | 3 | 1 | — | `sys.stdout`/`sys.stderr` → `sublime_api.log_message` (`:26`, `:38-39`) |
| `FileTooLargeError:42` | 0 | 0 | — | `FileNotFoundError` para recurso acima do limite |

**Classes 100% Python (native = 0):** `Edit`, `Region`, `HistoricPosition`, `TextChange`,
`Phantom`, `PhantomSet`, `Html`, `CompletionItem`, `QuickPanelItem`, `ListInputItem`,
`SymbolRegion`, `SymbolLocation`, `Syntax`, `ContextStackFrame`, `TextSheet`, `ImageSheet`.
Ou seja: **valores e agrupamentos são Python; só estado vivo é nativo.**

### 2.5 Classes-base de plugins (`sublime_plugin.py`)

| Classe (`linha`) | Métodos | Instanciação | Contrato |
|---|---|---|---|
| `Command:1397` | 15 | abstrata | `name()` derivado do nome da classe (`:1401-1410`); predicados `is_enabled_/is_visible_/is_checked_/description_` (`:1412/1436/1460/1485`) validam `bool` (`:1423-1424`); `filter_args` remove `event` se `want_event()` é `False` (`:1506-1512`) |
| `ApplicationCommand:1552` | 2 | **1 instância global** (`:1554`) | `run_(edit_token, args)` (`:1556`); se faltar argumento e `sublime_api.can_accept_input(...)` (`:1565`), reabre o Command Palette |
| `WindowCommand:1584` | 3 | 1 por window (`:1590`) | `self.window` (`:1594`); fallback via `sublime_api.window_can_accept_input`/`window_run_command` (`:1606-1607`) |
| `TextCommand:1626` | 3 | 1 por view (`:1632`) | `self.view` (`:1636`); `run_(edit_token, args)` **abre e fecha o edit token** (`:1639-1667`) |
| `CommandInputHandler:1146` | 15 | por `Command.input()` | `name/placeholder/initial_text/initial_selection/preview/validate/cancel/confirm/next_input` + pares `*_` para o nativo (`:1223-1244`) |
| `BackInputHandler:1260` | 1 | — | `name()` → `"_Back"` (`:1264`) — sentinela de "pop do stack" (`:1214-1220`) |
| `TextInputHandler:1268` | 3 | — | entrada textual; `description_` traduz valor→texto (`:1295`) |
| `ListInputHandler:1302` | 4 | — | lista de itens (`list_items:1312`, `description_:1390`) |
| `EventListener:1676` | **0** | 1 por módulo | **classe de contrato puro**: os hooks existem **só como docstring** `.. method::` — nada declarado no corpo (`:1676-1983`) |
| `ViewEventListener:1984` | 3 | 1 por view aplicável | `is_applicable(settings)` (`:2184`), `applies_to_primary_view_only()` (`:2191`), `__init__(view)` (`:2198`); hooks também só em docstring |
| `TextChangeListener:2204` | 5 | manual (`attach`) | `is_applicable(buffer)` (`:2248`), `attach`/`detach`/`is_attached` (`:2283`/`:2261`/`:2301`); hooks (`on_text_changed*`, `on_revert*`, `on_reload*`) só em docstring (`:2212-2244`) |
| `Summary:846` | 2 | interno | acumulador de profiling (`record:852`) |

`EventListener` e `ViewEventListener` (e `TextChangeListener`) são **duck-typed por desenho**: o
dispatcher usa `getattr(obj, name)`, e `vel_callbacks` filtra com `hasattr` (`:706-708`) —
logo um plugin pode implementar **qualquer subconjunto** de hooks.

### 2.6 Hooks de evento expostos ao nativo

`all_callbacks` (`:43-97`) é o **contrato nomeado** dos 53 eventos que o C++ pode disparar; cada
chave é uma lista de classes inscritas. 19 dessas chaves terminam em `_async` (`on_modified_async:67`
… `on_close_buffer_async:84`). Os **53 hooks** existem como funções de módulo `on_*` (a "boca" da
ponte) e mais `on_api_ready` (`:534`) — 54 `on_*` no total.

| Grupo | Exemplos (`linha` do hook) | Entrega |
|---|---|---|
| Ciclo de vida do plugin | `on_api_ready:534` `on_init:731` `on_exit:1093` | handshake C++ → Python (`api_ready` em `:27`, `deferred_plugin_loadeds:29`) |
| View | `on_new:782` `on_load:866` `on_revert:874` `on_reload:882` `on_pre_close:890` `on_close:894` `on_clone:838` `on_pre_move:914` `on_post_move:918` | `run_view_callbacks(name, view_id, *args)` (`:711`) |
| Buffer | `on_new_buffer:790` `on_associate_buffer:806` `on_close_buffer:822` | id de buffer → objeto `Buffer` (assinatura recebe `buffer_id: int`) |
| Edição | `on_modified:926` `on_selection_modified:934` `on_activated:942` `on_deactivated:950` | ida+volta por `view_id` |
| Save/projeto/janela | `on_pre_save:898` `on_post_save:906` `on_new_project:1049` `on_load_project:1057` `on_post_save_project:1069` `on_new_window:1081` `on_pre_close_window:1089` | `run_window_callbacks(name, window_id, *args)` (`:724`) |
| Consults síncronos (retorno ao nativo) | `on_query_context:958` `on_query_completions:979` `on_hover:1005` `on_text_command:1009` `on_window_command:1029` `on_post_text_command:1041` `on_post_window_command:1045` | valor de retorno consumido pelo C++ (ex.: `(cmd, args)` em `:1009-1027`) |

Dispatch central (`:711-728`): **toda** entrega nativa→Python passa por
`run_view_callbacks`/`run_window_callbacks`, que **convertem o int em objeto** no último instante
(`View(view_id)` em `:712`, `Window(window_id)` em `:725`) e iteram `el_callbacks`/`vel_callbacks`
(`:702`/`:706`). Detalhe de ordem: em `on_text_command` os **ViewEventListeners rodam antes** dos
EventListeners (`:1012-1024`) e o **primeiro retorno truthy vence**.

Eventos que **só** valem para `EventListener` estão em
`view_event_listener_excluded_callbacks` (25 nomes, `:106-132`); os 6 do `TextChangeListener`
estão em `text_change_listener_callbacks` (`:135-142`).

### 2.7 API assíncrona 🌗

| Mecanismo | Evidência | Contrato |
|---|---|---|
| `set_timeout` (main thread) vs `set_timeout_async` (worker) | `sublime.py:1309` / `:1318`; nativo `:1315` / `:1323` | callback é **retido no C++**; doc explicita main thread vs "alternate thread" |
| Hooks `*_async` | 19 chaves em `all_callbacks:67-96`; `trap_exceptions` escolhido pelo sufixo `_async` (`:243-246`) | eventos async **não** fazem profiling e **não** bloqueiam a UI |
| `get_clipboard_async` vs `get_clipboard` | `sublime.py:1006` / `:1018` | variante com callback (não bloqueia) e limite de 16 MiB |
| Diálogos com callback | `open_dialog:854` `save_dialog:891` `select_folder_dialog:913` `choose_font_dialog:937` | resultado volta por callback passado **ao nativo** (`:888`, `:910`, `:934`, `:959`) |
| `CompletionList.set_completions` | `sublime.py:4105-4126` (doc "thread-safe", `since 4184`) | uma única chamada (`assert self.completions is None`, `:4116`); ordem de escrita comentada (`:4119-4120`) |
| `MultiCompletionList` (nativo) | `sublime_plugin.py:982` (criação), `:1002` (`ready()`) | **acumula** completions vindas de N listeners (`append` em `:997`/`:1000`) e o objeto devolve por `completions_ready` (`sublime.py:4126`) |
| `synthesize_on_activated_async` | `sublime_plugin.py:456-487` + `threading.Lock` (`:99`) + fila (`:101-104`) | `on_activated_async` disparado **antes** de `api_ready` é re-sintetizado depois |

---

## 3. 🔀 Delta 3.3 → 3.14 (o que endureceu, não o que rompeu)

| # | Mudança | Evidência 3.3 → 3.14 |
|---|---|---|
| 1 | **Enums tipados** substituem constantes int soltas | `python33/sublime.py:36-38` (`HOVER_TEXT = 1`) vs `python314/sublime.py:47-69` (`HoverZone` + reexport); 0 → **17 enums**; 106 → 100 constantes, **89 delas reexports** |
| 2 | **Delta da superfície de módulo é 1 função** | 63 (`python33/sublime.py`) → 64 (`python314/sublime.py`); a única adição é **`lib_path`** (`:805`) |
| 3 | `lib_path()` novo e **gateia** `site`/SSL | `python314/sublime.py:805`; uso em `sublime_plugin.py:2441` (`site.addsitedir`) e `:2443-2445` (`SSL_CERT_FILE`) |
| 4 | **`sublime_types.py` novo** (PEP 695) | `python314/sublime_types.py:3-10` — 8 aliases; `python33/` não tem o arquivo |
| 5 | **`imp.py` novo** (shim) | `python314/imp.py:5-8`; ausente em `python33/` |
| 6 | **`Settings` virou dict-like** | 3.3 só tinha `get/has/set/erase/add_on_change` (`python33/sublime.py:1898-1921`); 3.14 tem mapping protocol `__getitem__/__setitem__/__delitem__/__contains__` (`:3829/3840/3848/3858`) + `to_dict:3869` + `setdefault:3877` + `update:3890` |
| 7 | **Colisão perdida → erro** | `make_sheet` inválido: 3.3 devolvia `None` (`python33/sublime.py:1157`) → 3.14 **levanta** `ValueError` (`:2443`) |
| 8 | `DialogResult` tipando o retorno | `yes_no_cancel_dialog` devolve `DialogResult(...)` (`:842-853`) vs `bool` cru em 3.3 |
| 9 | `KindId` / ícones como contrato | `KindId:512` + tuplas `KIND_*:582-614`; 3.3 só aceitava `icon` string com checagem manual (`python33/sublime.py:1673-1674`) |
| 10 | Loaders `importlib` substituem importadores próprios | `MultizipImporter`/`ZipLoader` (`python33/sublime_plugin.py:1569`/`:1588`) → `PackagePathFinder:2310` (com `find_spec:2326`) + `PackageSourceFileLoader:2379` + `PackageSourcelessFileLoader:2412`, instalados em `sys.meta_path` (`:2430`) |
| 11 | `set_override_path` **removido** | `python33/sublime_plugin.py:1746`; inexistente em 3.14; em troca entrou `split_identifier:1110` |
| 12 | `el_callbacks`/`vel_callbacks` perderam `listener_only` | `python33/sublime_plugin.py:691-699` vs `python314/sublime_plugin.py:702-708` |
| 13 | `set_clipboard` deixou de retornar valor | `python33/sublime.py:365-366` fazia `return sublime_api.set_clipboard(...)`; `python314/sublime.py:1030-1032` ignora o retorno |
| 14 | **5 símbolos nativos novos** | `sublime_api`: 279 → **284** distintos; entram `lib_path`, `settings_to_dict`, `stat_resource_dir`, `stat_resource_file`, `view_syntax` (call-sites: `sublime.py:811`, `:3875`, `sublime_plugin.py:2346`, `:2349`, `sublime.py:3531`); **nenhum** símbolo foi removido |
| 15 | Tipagem estática extensiva | 3.14 abre com `from __future__ import annotations` (`sublime_plugin.py:2`) e usa `Literal`/`TYPE_CHECKING` (`sublime.py:9-15`) |

**Leitura do delta:** a superfície de **módulo** é praticamente idêntica (63 → 64). Quem mudou foi o
**contrato**: tipos (enums, `DialogResult`, `KindId`, dict-like `Settings`) e mecanismos
(importlib, `stat_resource_*`, `lib_path`). Para a reimplementação, isso significa que
**um shim 3.14-compatível em TS/Node pode servir a maioria dos plugins 3.3** se reimplementar
enums, `Settings` mapping e os loaders.

---

## 4. 🧩 Padrões arquiteturais inferidos (12)

1. **Facade fino sobre `sublime_api`, Python stateless.** 284 símbolos nativos distintos; 276
   usados de `sublime.py`, onde 64 funções de módulo quase sempre terminam em uma única chamada
   `sublime_api.*` (ex.: `version:724-730`, `active_window:1326-1330`, `save_settings:1302-1306`).
   `sublime.py` **não tem estado mutável de módulo** — só o redirecionamento de `sys.stdout`/
   `sys.stderr` (`:38-39`). *Limite:* "stateless" é do facade; o plugin host tem registries
   (§4.6).
2. **Handles opacos (int) com identidade por id.** `Buffer.buffer_id:3774` (+`__hash__:3776`,
   `__eq__:3779`), `Settings.settings_id:3826`, `Edit.edit_token:2080` (`__slots__`),
   `Region.__slots__=['a','b','xpos']:2098`, `Window.window_id:1374`, `View.view_id:2635`,
   `Sheet.sheet_id:2452`, `Selection.__slots__=['view_id']:2329`, `Phantom.id` (usado em
   `PhantomSet.__del__:4025-4028`). Objetos são **reconstruídos a cada chamada**
   (`windows():1337`, `_buffers():3763`) — **sem cache global**.
3. **Fábrica de subtipo de `Sheet` por 2 bits do id.** `make_sheet(sheet_id)` (`:2435-2443`)
   despacha `id & 3` → `TextSheet`/`ImageSheet`/`HtmlSheet`, **`3` = `ValueError`**. O id opaco
   **codifica o tipo** — o Python não tem vtable nem `isinstance` nativo para isso.
4. **Validação delegada ao nativo (`is_valid()`).** `Window.is_valid:1396` chama
   `sublime_api.window_is_valid`; consumido no host: `if not view.is_valid(): return`
   (`sublime_plugin.py:477`, `:485`). O Python nunca sabe sozinho se um handle morreu.
5. **Callbacks Python retidos no C++.** O nativo guarda *a referência Python* e chama depois:
   `set_timeout:1315`, `set_timeout_async:1323`, `open_dialog:888`, `save_dialog:910`,
   `select_folder_dialog:934`, `choose_font_dialog:959`, `get_clipboard_async:1015`,
   `Sheet.close(on_close):2559`, `View.add_phantom(..., on_navigate):3498`,
   `View.add_regions(..., on_navigate, on_close):3469-3483`,
   `Settings.add_on_change:3943`, e o caso extremo
   `sublime_api.buffer_add_text_listener(buffer_id, self)` (`sublime_plugin.py:2299`), que retém
   **o objeto Python inteiro**, com `buffer_clear_text_listener(...)` (`:2273`) para desregistrar.
6. **Registro + dispatch de eventos.** `all_callbacks` (`:43-97`, 53 chaves),
   `application_command_classes`/`window_command_classes`/`text_command_classes` (`:31-41`),
   `view_event_listener_classes`/`view_event_listeners` (`:35-36`),
   `text_change_listener_classes`/`text_change_listeners` (`:134`,`:143`). Os hooks nativos
   **recebem ints** (`on_new(view_id: int):782`) e convertem para objeto só no dispatch
   (`run_view_callbacks:711-721`).
7. **Comandos como tuplas `(instância, nome)`.** `notify_application_commands` (`:495`) envia
   `create_application_commands()` (`:499`) ao nativo; `create_window_commands:510` e
   `create_text_commands:522` fazem o mesmo por window/view. Falha de instanciação é
   **reportada e engolida** (`_instantiation_error:489`, `:505`).
8. **Protocolo de edit token.** `TextCommand.run_` abre o edit antes de `run` e fecha no
   `finally` (`:1639-1653`); `View.begin_edit(edit_token, cmd, args) -> Edit:2851` e
   `View.end_edit:2855` são o par; `View.is_in_edit:2859` e `change_id:2902` /
   `transform_region_from:2912` completam o contrato de undo/coordenadas.
9. **Pacotes como recursos nativos.** `.sublime-package` (zips) são lidos **de dentro do núcleo**:
   `PackagePathFinder.find_spec` resolve `Packages/<mod>` (`:2326-2341`) via
   `sublime_api.stat_resource_file`/`stat_resource_dir` (`:2346`,`:2349`) e
   `load_binary_resource:2405`; `get_data` só aceita `.py`/`.pyc` (`:2393-2394`). Registro em
   `sys.meta_path` (`:2430`) e atualização por `update_compressed_packages:2433`.
10. **Serialização delegada.** `encode_value:1248` e `decode_value:1264` só repassam
    (`:1261`, `:1271`) — e `decode_value` **devolve `(value, err)`** do nativo, convertido em
    `ValueError` no Python (`:1273-1274`). `expand_variables:1279` idem (`:1286`).
11. **I/O redirecionado.** `_LogWriter` (`:18-35`) substitui `sys.stdout`/`sys.stderr`
    (`:38-39`) e despeja linhas em `sublime_api.log_message` (`:26`) — `print()` de plugin vira log
    do host, **não** vai ao terminal.
12. **`lib_path` gateia `site` e SSL (e tolera mocks).** `if sublime_api.lib_path:` (`:2439`) com
    comentário explícito sobre *import mocks* na geração de docs (`:2437-2438`);
    `site.addsitedir(...lib_path()/python314)` (`:2441`) e, sem `SSL_CERT_FILE`, injeta o
    `certifi.where()` (`:2443-2445`).

---

## 5. 📋 Ledger de evidências

`tipo`: **A** = artefato/Python legível (fato), **I** = inferência forte (a partir do call-site),
**U** = incógnita.

| # | Conclusão | Arquivo:linha | Tipo | Limite / incerteza |
|---|---|---|---|---|
| E1 | Ponte é o módulo nativo `sublime_api` | `python314/sublime.py:12`, `python314/sublime_plugin.py:16` | A | Nome do módulo é tudo que se vê; ABI/assinatura nativas não estão no tarball |
| E2 | 284 símbolos nativos distintos usados | contagem em `python314/*.py` (276 em `sublime.py`, 14 em `sublime_plugin.py`) | A | Pode existir símbolo nativo **não usado** pelo Python (invisível aqui) |
| E3 | Facade stateless; estado no C++ | `python314/sublime.py` sem globais mutáveis; `:38-39` | A+I | `sublime_plugin.py` **tem** registries globais (`:31-143`) |
| E4 | Handles opacos + identidade por id | `sublime.py:3774`, `:3826`, `:2080`, `:2098`, `:2635`, `:1374`, `:2452`, `:2329` | A | Semântica de colisão/reciclagem de ids no C++ é desconhecida |
| E5 | Sem cache global de objetos; instâncias recriadas | `sublime.py:1337`, `:3763` | A | Há **memoização por instância** de `Settings` (`:1375-1377`, `:2637-2639`) |
| E6 | `sheet_id` codifica o subtipo (`& 3`) | `sublime.py:2436-2443` | A | Semântica dos 2 bits além do dispatch é inferida |
| E7 | `make_sheet` inválido agora levanta `ValueError` (3.3 devolvia `None`) | `python314/sublime.py:2443` vs `python33/sublime.py:1157` | A | Mudança observável de contrato; pode quebrar plugin que testava `None` |
| E8 | Validação de liveness via nativo | `sublime.py:1396`; `sublime_plugin.py:477`, `:485` | A | Regra exata de invalidação (por thread?) é do C++ |
| E9 | Callbacks Python retidos no C++ | `sublime.py:1315`, `:1323`, `:888`, `:910`, `:934`, `:959`, `:1015`, `:2559`, `:3498`, `:3469-3483`, `:3943` | A | Tempo de vida/thread de execução do callback é inferência |
| E10 | Objeto Python inteiro retido (`TextChangeListener`) | `sublime_plugin.py:2299` (add) / `:2273` (clear) | A | Ciclo de vida referenciado pelo C++ → risco de leak se não desanexar |
| E11 | Dispatch nativo→`on_*` converte id→objeto no fim | `sublime_plugin.py:711-728` | I | Forte: 53 hooks recebem `*_id: int`; o C++ não está no tarball |
| E12 | 53 eventos, 19 `_async` | `sublime_plugin.py:43-97`; contagem `_async:67-96` | A | Nomes listados são o contrato; ordem de disparo do C++ é desconhecida |
| E13 | `EventListener`/`ViewEventListener` são duck-typed (hooks só em docstring) | `python314/sublime_plugin.py:1676-1983`, `:1984-2203`; filtro `hasattr` em `:706-708` | A | `el_callbacks` (`:702`) **não** filtra por `hasattr` → hook ausente em `EventListener` = `AttributeError` |
| E14 | Ordem: VEL antes de EL em `on_text_command` | `sublime_plugin.py:1012-1027` | A | Vale para esse hook; ordem em outros é a do loop |
| E15 | Exclusões EL-only (25 nomes) e hooks de TCL (6) | `python314/sublime_plugin.py:106-132`, `:135-142` | A | — |
| E16 | Comandos trafegam como tuplas `(instância, nome)` | `sublime_plugin.py:495-531` | A | Formato exato consumido pelo C++ não é verificável aqui |
| E17 | Edit token aberto/fechado pelo host | `sublime_plugin.py:1639-1653`; `sublime.py:2851`, `:2855`, `:2859` | A | `edit_token` vem do nativo (`run_(edit_token, args)`) — origem U |
| E18 | Fallback de Command Palette via `*_can_accept_input` | `sublime_plugin.py:1565`, `:1606`, `:1656` | A | Heurística é `TypeError` por argumento faltante (`:1564`, `:1605`, `:1655`) |
| E19 | Pacotes `.sublime-package` resolvidos por meta-path + recursos nativos | `sublime_plugin.py:2310-2434`, `:2405` | A | Formato do zip e cache `.pyc` (`__pycache__`, `:2396-2403`) |
| E20 | `decode_value` devolve `(value, err)` do nativo | `sublime.py:1271-1274` | A | Erros viram `ValueError` |
| E21 | `print()` de plugin vira log do host | `sublime.py:18-39` | A | Sem timestamp/formatação conhecida — o nativo formata |
| E22 | `lib_path` gateia `site`/SSL e tolera mock | `sublime_plugin.py:2439-2445` | A | Comentário no próprio código (`:2437-2438`) confirma o caso de mock |
| E23 | 5 símbolos nativos novos em 3.14 | `sublime.py:811`, `:3531`, `:3875`; `sublime_plugin.py:2346`, `:2349` | A | Comparação 279→284 por diff de call-sites |
| E24 | Superfície de módulo 3.3→3.14: só `+lib_path` | 63 vs 64 função de módulo; `python314/sublime.py:805` | A | Comparação por nome de função |
| E25 | `sublime_plugin`: `set_override_path` saiu, `split_identifier` entrou | `python33/sublime_plugin.py:1746` vs `python314/sublime_plugin.py:1110` | A | — |
| E26 | `el_callbacks`/`vel_callbacks` perderam `listener_only` | `python33/sublime_plugin.py:691-699` vs `python314/sublime_plugin.py:702-708` | A | — |
| E27 | Async: main thread vs worker e `MultiCompletionList` acumulador | `sublime.py:1309`, `:1318`, `:4105-4126`; `sublime_plugin.py:982`, `:997-1002` | A | Garantia de thread-safety é **do nativo** (`MultiCompletionList_append` citado em `sublime.py:4120`) |
| E28 | Handshake `api_ready` + `deferred_plugin_loadeds` + re-síntese de `on_activated_async` | `sublime_plugin.py:27-29`, `:456-487`, `:534-543` | A | Motivo do atraso (ordem do C++) é inferência |
| E29 | `Settings` dict-like com `to_dict`/`setdefault`/`update` | `sublime.py:3829-3914`; `to_dict` usa `settings_to_dict` (`:3875`) | A | `3.3` só tinha a forma antiga (`python33/sublime.py:1898-1921`) |
| E30 | `sublime_types.py` = 8 aliases PEP 695 (não 9) | `python314/sublime_types.py:3-10` | A | Correção da estimativa do esqueleto |
| E31 | `imp.py` = shim de 3 nomes | `python314/imp.py:5-8` | A | — |
| E32 | `View` concentra a superfície (133 métodos, 133 chamadas nativas) | `python314/sublime.py:2626-3761` | A | Classe inequivocamente central — alvo nº 1 do shim TS |
| E33 | Classes puramente Python (native = 0) | `sublime.py:2071-2320`, `:3953-4082`, `:4129-4246`, `:4296-4455` | A | Não precisam do nativo → portáveis direto para TS |

---

## 6. ⚠️ Limites e incógnitas

| # | Incógnita | Por quê | O que fecharia |
|---|---|---|---|
| U1 | **Assinaturas de `sublime_api.*`** | o módulo é embutido no `plugin_host-*`; só se infere dos call-sites (`arquivo:linha` no ledger) | Ghidra no `plugin_host-3.14` (P0.0) ou dumps de símbolos |
| U2 | **Como o C++ descobre e chama `sublime_plugin.on_*`** | não há registro lado Python; a chamada é *por nome* | símbolos/strings do `plugin_host` (ver `ipc-plugin-host.md`) |
| U3 | **Thread de cada callback** | `*_async` sugere worker; o doc só afirma "a separate thread" (`sublime.py:1319-1322`) | ids de thread no host / evidência do protótipo |
| U4 | **Formato dos bytes da IPC** | fora do escopo deste doc (tratado em `ipc-plugin-host.md`) | framing/opcodes (P0.0) |
| U5 | **`MultiCompletionList_append` e outras extensões nativas embutidas** | métodos de um objeto nativo, invisíveis no tarball (`sublime.py:4120`, `:4126`) | tabela de métodos do tipo nativo |
| U6 | **Regras de invalidação de handles** | só se observa `is_valid()` (`sublime.py:1396`) | comportamento do host (reciclagem de ids) |
| U7 | **`UIElement` marcado `:meta private:`** | `sublime.py:471-480`, sem uso nos dois arquivos lidos | verificar APIs internas do host |
| U8 | **`sublime_api` pode virar mock** | o próprio código testa a existência do atributo (`sublime_plugin.py:2439`) | modo de geração de docs do projeto — não auditado aqui |
| U9 | **Cobertura do lado 3.3** | só existem `sublime.py`/`sublime_plugin.py` em `python33/` | — |
| U10 | **Deprecações silenciosas 3.3→3.14** | o delta foi medido por nome/linha; semânticas com o mesmo nome podem ter mudado | comparar corpos método a método (custoso) |

### Nota de método (clean-room)

Nenhuma linha de implementação do alvo foi copiada: as tabelas acima listam **nomes, assinaturas,
contagens e o papel arquitetural** extraídos por leitura do artefato. Expressões como
"`x & 3`" aparecem por serem **contrato observável** (o id codifica o subtipo), não por serem
código a reutilizar.
