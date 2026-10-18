# Análise via Rizin — Confirmações e novos achados (2026-10-18)

> **Contexto:** O Rizin v0.9.1 foi provisionado em P3.5 (commit `a0e1e05`) como provider nativo do REA. Esta
> sessão executa a **primeira análise real do binário via Rizin**, explorando 13.312 funções identificadas,
> 76.042 strings extraídas e confirmação independente de achados da Fase 1 (Ghidra).
>
> **Alvo:** `target/sublime_text/sublime_text` (ELF64 x86-64, PIE, stripped, SHA-256 `8b105b18…43d92`)
>
> **Provider:** REA + `rea execute-rizin-command` + Rizin v0.9.1 (estático)

---

## Achado Central

O Rizin **confirma e complementa** as análises da Fase 1 (Ghidra) sem re-analisar o binário. Em particular:

1. **Pipeline de render (P1.4):** os shaders GLSL foram extraídos **diretamente do .rodata** — são strings literais, não reconstrução. O vertex shader (959 B, `0xcf8a5`) usa `viewport`, `position`, `size`, condicionais `TEXTURED`/`ROUNDED`/`BORDERED`/`REPEAT` e calcula clip-space com `(view_position / viewport) * 2 - 1`. O fragment shader sólido (82 B, `0xcfc64`) é `frag_color = tint`.
2. **GTK runtime (P1.2):** o Rizin lista **todas** as funções GTK carregadas via `dlsym` — de `gtk_native_dialog_show` a `gdk_drag_context_get_source_window`.
3. **Skia estática (P1.4):** strings `SkComposeShader`/`ShaderB` no .rodata confirmam Skia linkada estaticamente.
4. **Alocador:** jemalloc (string `<jemalloc>: Error in munmap(): %s\n`).
5. **Empacotamento (P1.6):** `Packages/Theme - Default/common/`, `Packages/Color Scheme - Default/Mac Classic.tmTheme`, `Packages/JSON/JSON.sublime-syntax` confirmam a estrutura.

---

## Ledger de evidências

| ID | Conclusão | Tipo | Endereço | Limites / Notas |
|---|---|---|---|---|
| RZ-E1 | **Vertex shader GLSL** com suporte a `TEXTURED`, `ROUNDED`, `BORDERED`, `REPEAT`. Pipeline `(view_position / viewport) * 2 - 1` | [OBSERVADO] | `.rodata @ 0xcf8a5` (959 B) | 1 shader; outros shaders (glyph, rounded) existem em strings adjacentes |
| RZ-E2 | **Fragment shader sólido** simples: `frag_color = tint` | [OBSERVADO] | `.rodata @ 0xcfc64` (82 B) | Complementar ao vertex; backends texturizados devem ter FS próprio |
| RZ-E3 | **GTK runtime loading** via `dlsym` — funções: `gtk_native_dialog_show`, `gtk_widget_*`, `gtk_window_*`, `gtk_check_version`, `gtk_drag_get_data`, `gdk_drag_context_*`, `gdk_window_get_frame_extents`, `gdk_x11_get_xatom_by_name_for_display`, `g_settings_get_string` | [OBSERVADO] | `.rodata` | GTK3 carregado em runtime, não linkado diretamente (confirma P1.2) |
| RZ-E4 | **Skia estática** — strings `SkComposeShader`, `ShaderB`, `No Error` | [OBSERVADO] | `.rodata` | Skia linkada estaticamente no binário (confirma P1.4) |
| RZ-E5 | **jemalloc** — string de erro `jemalloc: Error in munmap()` | [OBSERVADO] | `.rodata` | Sublime usa jemalloc como alocador padrão |
| RZ-E6 | **Estrutura de packages** — `Packages/Theme - Default/common/`, `Packages/Color Scheme - Default/Mac Classic.tmTheme`, `Packages/JSON/JSON.sublime-syntax` | [OBSERVADO] | `.rodata` | Confirma P1.6 (namespace plano `Packages/<Nome>/`) |
| RZ-E7 | **Sistema de build** — string `"sublime_merge_file_history"` | [OBSERVADO] | `.rodata` | Histórico de merge do Sublime Merge integrado |
| RZ-E8 | **Config syntax detection** — `syntax_detection_size_limit` | [OBSERVADO] | `.rodata` | Setting que limita o tamanho para detecção automática de sintaxe |
| RZ-E9 | **GLib main loop** — todas as funções GLib confirmadas na PLT: `g_idle_add`, `g_source_*`, `g_timeout_add`, `g_signal_connect_data`, `g_object_*` | [OBSERVADO] | `.plt`, `.dynsym` | 433 imports totais, ~50 GLib (confirma P1.2) |
| RZ-E10 | **Semáforos POSIX + shm** — `sem_*`, `shm_*`, `mmap`, `ftruncate` todos na PLT | [OBSERVADO] | `.plt`, `.dynsym` | Confirma IPC via memória compartilhada POSIX (P1.3) |
| RZ-E11 | **Threads POSIX** — `pthread_create`, `pthread_setname_np`, `prctl`, `pthread_attr_setstacksize` (stack 2 MiB), `pthread_cond_*` | [OBSERVADO] | `.plt` | Confirma pool de threads POSIX (P1.2) |
| RZ-E12 | **fork/exec** — `posix_spawn`, `fork`, `execvp`, `dup2`, `pipe`, `waitpid` | [OBSERVADO] | `.plt` | Confirma `plugin_host` como processo filho (P1.2/P1.3) |
| RZ-E13 | **Libpng** — `libpng warning: %s`, `internal row width error` | [OBSERVADO] | `.rodata` | Suporte a PNG para ícones/gráficos |
| RZ-E14 | **OpenGL 4.1+** — `glDebugMessageCallbackARB`, `glDebugMessageControlARB`, dezenas de funções GL | [OBSERVADO] | `.plt` | 60+ imports GL (confirma P1.4 — OpenGL ≥ 4.1) |
| RZ-E15 | **SIGBUS handler** — `_ZTHN4sgit14sigbus_jmp_setE` / `_ZTHN4sgit14sigbus_jmp_bufE` | [OBSERVADO] | `.dynstr` | Tratamento de SIGBUS para acesso a arquivos mapeados (mmap) |
| RZ-E16 | **Licenciamento** — string `license.sublimehq.com` | [OBSERVADO] | `.rodata` | Validação de licença online |
| RZ-E17 | `main()` em `0x533b00` — inicializa 184 + 264 registros de tipo GObject, processa flag `--crawl` | [OBSERVADO] | `.text @ 0x533b00` | Entry point validado |

---

## Metodologia

Comandos Rizin executados via `rea execute-rizin-command`:

| Comando | Propósito | Resultado |
|---|---|---|
| `iI` | Info binário | ELF64 x86-64, 9.9 MB, PIE, stripped, C++, RELRO partial |
| `iS` | Seções | 33 seções, `.text` 6.0 MB (`0x315120`, 6.3M), `.rodata` 1.0 MB |
| `ii` | Imports | 433 imports (GLib, GL, pthreads, X11, POSIX IPC, stdlib) |
| `izz` | Strings | 76.042 strings extraídas |
| `aac` | Análise de funções | 13.312 funções catalogadas (Rizin v0.9.1, stripped) |
| `pD N @ addr` | Disassembly | Entry point, main, área de shaders e funções GL |
| `/ <pat>` | Busca textual | Validação de strings específicas |

### Limitações

- O Rizin v0.9.1 **não identificou funções com nomes** no binário stripped — todas são `fcn.XXXXXXXX`.
- A análise `aaa`/`aac` é limitada para binários C++ com 6 MB de `.text` stripped; o Ghidra continua superior para reconstrução completa.
- Strings de `.rodata` foram extraídas mas muitas são parciais (Rizin pode quebrar strings longas em múltiplas entradas).
- O disassembly de funções individuais sem nomes de símbolos é pouco produtivo sem o contexto do Ghidra.

---

## Rastreabilidade Fase 1 → Rizin

| Doc Fase 1 | Evidência Rizin | Status |
|---|---|---|
| `render-pipeline.md` (P1.4) | RZ-E1, RZ-E2, RZ-E4, RZ-E14 | ✅ **Confirmado** — shaders reais extraídos |
| `concurrency.md` (P1.2) | RZ-E3, RZ-E9, RZ-E11, RZ-E12 | ✅ **Confirmado** — GTK+GLib + threads POSIX |
| `ipc-protocol.md` (P1.3) | RZ-E10, RZ-E12 | ✅ **Confirmado** — shm + semáforos + fork |
| `packaging.md` (P1.6) | RZ-E6 | ✅ **Confirmado** — estrutura de packages |
| `buffer-structure.md` (P1.1) | — | 🔲 Sem novos dados (Rizin não substitui Ghidra) |

---

## Perguntas em aberto

1. **Shaders de glifo e rounded** — os condicionais `ROUNDED`/`BORDERED`/`TEXTURED` sugerem que o mesmo vertex shader atende a multiple backends. Os fragment shaders correspondentes (glyph atlas, rounded rects) não foram localizados neste scan.
2. **Ordem de inicialização** — o `main` registra 184 + 264 tipos GObject. A identidade exata desses tipos (classes do Sublime) requer Ghidra.
3. **Configuração exata do jemalloc** — apenas a string de erro foi encontrada; a inicialização do jemalloc não foi observada.
4. **`--crawl`** — flag de linha de comando no `main`; provável função de migração de configuração da versão 2 para 3.