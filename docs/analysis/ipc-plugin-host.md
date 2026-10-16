# Ponte IPC entre `sublime_text` e `plugin_host` — análise por engenharia reversa

> Análise *clean-room*: os binários não são desmontados para cópia de código, e sim para
> recuperar **contratos observáveis** (mecanismo, nomes, layout de mensagens) a fim de
> reimplementar o comportamento em Electron/TypeScript.
>
> **Escopo:** canal de comunicação entre o núcleo nativo `sublime_text` e o processo
> `plugin_host-3.14` / `plugin_host-3.3`. `crash_handler` é tratado como *fora do escopo*
> (seção 7), apenas para descartá-lo como participante.

**Docs irmãos (Fase 1):** [`ipc-protocol.md`](ipc-protocol.md) (**P1.3 — framing, anel, semáforos e
enum de opcodes** deste mesmo IPC) · [`buffer-structure.md`](buffer-structure.md) (P1.1 — estrutura de
buffer) · [`concurrency.md`](concurrency.md) (P1.2 — modelo de concorrência) ·
[`api-python.md`](api-python.md) (API de plugins) · [`packaging.md`](packaging.md) (P1.6 — empacotamento).

---

## 1. Resumo e veredito do mecanismo

**Veredito (confiança alta):** a comunicação núcleo ↔ `plugin_host` é feita por
**memória compartilhada POSIX nomeada** (`shm_open` + `ftruncate` + `mmap`, objeto em
`/dev/shm`) com **semáforos POSIX nomeados** (`sem_open`) para o sinal de tráfego.
Não é socket, não é `stdio`/pipe e não é o `multiprocessing` do CPython.

O canal é implementado por código **próprio do Sublime** (`shm_channel`, `shm_bundle`),
com **três canais** por instância de host:

| Canal | Uso inferido |
|---|---|
| `subl_send`   | outbound: host → núcleo |
| `subl_recv`   | inbound síncrono: núcleo → host |
| `subl_arecv`  | inbound assíncrono ("async recv"): núcleo → host |

> ⚠️ **Revisão P1.3 — direção dos canais [INFERIDO], confiança média.** A tabela acima supõe
> **host → núcleo** por `subl_send`. A evidência nova ([`ipc-protocol.md`](ipc-protocol.md) §5,
> ledger `E16–E19`) aponta o **contrário**: o host **lê** o canal de entrada em `bundle+0x10` =
> `subl_send` e **escreve** a requisição em `bundle+0x8`/`+0x18` = `subl_recv`/`subl_arecv` → com
> nomes **relativos ao núcleo**, `subl_send` é o canal de **entrada do host** (núcleo → host) e
> `subl_recv`/`subl_arecv` são as **saídas** (host → núcleo, síncrona/assíncrona). Ou seja: os três
> nomes **não mudam** (seguem como em §3.1), mas o **sentido** lido de cada um é o inverso do que
> esta tabela afirma. A afirmação antiga fica **registrada como superada — não foi apagada**;
> confiança **média** (padrão request/response + offsets do bundle em `main`). Ressalva viva: o uso
> do `subl_arecv` por threads não-main **não** foi seguido até o consumidor
> ([`ipc-protocol.md`](ipc-protocol.md) §7.2).

O núcleo **cria** os objetos e **faz spawn** do host; o host **só abre** (nunca cria —
ver §4). O nome de cada objeto embute o id da instância e a **versão do Python/host**
(`-3.14` / `-3.3`), o que evita colisão entre os dois hosts.

Dentro de cada `shm_channel` há um **buffer circular delimitado** com:
- 1 `mutex` (pthread) por canal, para serializar escrita,
- **2 semáforos nomeados** por canal (sinal "há dado para ler" e "há espaço para escrever"),
- framing de mensagem com **comprimento** (leitura em duas etapas: header + corpo).

As mensagens são despachadas por `handle_protocol_message(opcode, payload)`, com um
**enum de ~281 comandos** (`api_*`) — seção 3.3. *(Correção P1.3: o enum é **numérico**, não
textual — `uint32 id ∈ [1,281]`; ver [`ipc-protocol.md`](ipc-protocol.md) §6.4.)*

---

## 2. Alvos e métodos

### 2.1 Artefatos (SHA-256 aferido por `sha256sum` e pelo MCP `rea.inspect_binary_layout`)

| Artefato | Tam. | SHA-256 | Tipo |
|---|---:|---|---|
| `sublime_text` | 9,95 MB | `8b105b1839d7809f60ec186b6c6dcb2d107e22ad23f42c5f8ba7dec67ab43d92` | ELF PIE x86-64 stripped (só 12 dynsyms exportados: `malloc`/`free`/…) |
| `plugin_host-3.14` | 2,16 MB | `194bfb8f6ecdb31cd3719efe681095f30920cddfa9e63e957b524fe67b70b0ce` | ELF PIE stripped, **4420 dynsyms definidos** |
| `plugin_host-3.3` | 6,52 MB | `fda8e3ea00a59f4666e92649ef4afcd3b9e23ce3f574c1d5fc52f70d1f81a52c` | ELF PIE stripped, **6338 dynsyms definidos** |
| `crash_handler` | 1,20 MB | `19d246d5e38ce771bdab0dad38bf473e887d6bbe58f25ce24e3520277bdbd233` | ELF PIE x86-64 (handler Crashpad) |
| `libpython3.14.so.1.0` | 11,42 MB | `f946209741b2f8c0d34a233c67a52199ba10355d09a3ed59f7f1eb7d32235082` | shared lib (CPython 3.14) |

Evidência estruturada equivalente: `rea.inspect_binary_layout` retornou `format=elf`,
`architecture=x86_64`, provider `rea-analysis-view 1` para todos os cinco artefatos
(`evidence_id`: `ev_5ce5698f…` host-3.14, `ev_b60f11ba…` host-3.3, `ev_553718f7…`
`sublime_text`, `ev_b546add9…` `crash_handler`, `ev_3b401918…` libpython).

> **Convenção de offsets:** todos os offsets de string citados são simultaneamente
> **offset de arquivo e endereço virtual**, porque em todos esses binários a seção
> `.rodata` tem `vaddr == p_offset` (`sublime_text`: `0xced80`; `plugin_host-3.14`:
> `0x75000`; `plugin_host-3.3`: `0xe4a00`). Símbolos são endereços virtuais (PIE,
> base somada em runtime).

### 2.2 Métodos

- `strings -a` + `grep -abo` para offsets exatos.
- `nm -D --defined-only` / `readelf -sW` para a tabela dinâmica (binários "stripped"
  preservam `.dynsym`, o que aqui equivale a uma lista de símbolos internos C++ mangled).
- `objdump -d --start-address … --stop-address …` com filtros para **as chamadas PLT**
  de funções-chave → prova direta do mecanismo (não apenas nome de símbolo).
- `readelf -d` para `NEEDED`/`RUNPATH`; `objdump -T` para imports.
- MCP `rea.inspect_binary_layout` (provider offline pwntools) — **Ghidra não foi usado**
  (dá timeout neste ambiente).
- Leituras pontuais do `.data` para decodificar literais de versão embutidos.

---

## 3. Evidências

### 3.1 Strings de canal (templates de nome)

| Binário | String | Offset | Observação |
|---|---|---|---|
| `sublime_text` | `%u:subl_send%s`  | `0xdca94` | template do núcleo: id vem como `%u` |
| `sublime_text` | `%u:subl_recv%s`  | `0xe793e` | |
| `sublime_text` | `%u:subl_arecv%s` | `0xf56c4` | |
| `plugin_host-3.14` | `%s:subl_send%s`  | `0x7b132` | host recebe o id como **string** (`%s`, do `argv[1]`) |
| `plugin_host-3.14` | `%s:subl_recv%s`  | `0x78b1f` | |
| `plugin_host-3.14` | `%s:subl_arecv%s` | `0x751fb` | |
| `plugin_host-3.3` | `%s:subl_arecv%s` | `0xe624c` | mesmos três nomes |
| `plugin_host-3.3` | `%s:subl_recv%s`  | `0xfd412` | |
| `plugin_host-3.3` | `%s:subl_send%s`  | `0x10d4f4` | |

O `%s` **final** de cada template é o **sufixo de versão** (`-3.14` / `-3.3`) — ver §3.5.

### 3.2 Outras strings relevantes

| Binário | String | Offset | Papel |
|---|---|---|---|
| `sublime_text` | `Unable to init shm: %s` | `0xd073d` | erro de init do shm (núcleo) |
| `sublime_text` | `]: failed to create shm channel for worker ` | `0xebe8d` | **núcleo cria** o canal do worker (`grep "failed…"` → `0xebe90`) |
| `sublime_text` | `spawn_worker_process` | `0xebe78` | função de spawn do worker |
| `sublime_text` | `unable to launch plugin_host` | `0xd4e32` | erro de spawn |
| `sublime_text` | `]: unable to spawn worker ` | `0xd4e6d` | erro de spawn |
| `sublime_text` | `--safe-mode` | `0xd4e22` | flag repassada ao host |
| `sublime_text` | `disable_plugin_host_3.3` | `0xebddb` | setting que escolhe qual host lançar |
| `sublime_text` | `shm_reader` | `0xf56d4` | **nome de thread** do leitor; segue imediatamente `%u:subl_arecv%s` (`0xf56c4` + 16 = `0xf56d4`) |
| `plugin_host-3.14` | `unable to open channels` | `0x7a698` | erro de `open_shm_channel` no host (usado em `dprintf`, §4) |
| `plugin_host-3.14` | `sublime.XXXXXX` | `0x75a1d` | template estilo `mkstemp` (uso **não confirmado**, §8) |
| `plugin_host-3.14` | `-%s` | `0x75cb5` | monta o sufixo `-3.14` (§3.5) |
| `plugin_host-3.3` | `unable to open channels` | `0x107df9` | idem |
| `plugin_host-3.14` | `%s/%s.%d.%s` | `0x789e7` | **falso positivo**: vizinho de strings do *Crashpad* (`crashpad_client_linux.cc`), não é o canal |

### 3.3 Símbolos (`plugin_host` — `.dynsym`, mangled)

| Símbolo | Endereço (3.14) | Assinatura demangled | Papel |
|---|---|---|---|
| `_ZNK11shm_channel17wait_write_signalEv` | `0xf72d8` | `shm_channel::wait_write_signal()` | espera espaço |
| `_ZNK11shm_channel16wait_read_signalEl`  | `0xe0460` | `shm_channel::wait_read_signal(long)` | espera dado (com *timeout*) |
| `_ZNK11shm_channel13signal_readerEv` | `0xe017c` | `shm_channel::signal_reader()` | publica "há dado" |
| `_ZNK11shm_channel13signal_writerEv` | `0xe0320` | `shm_channel::signal_writer()` | publica "há espaço" |
| `_ZN11shm_channel11write_bytesEPKcm` | `0xe0184` | `write_bytes(char const*, size_t)` | escrita crua |
| `_ZN11shm_channel10read_bytesEPcmil` | `0xe032a` | `read_bytes(char*, size_t, int, long)` | leitura crua |
| `_ZN11shm_channel13write_messageEPKcm` | `0xe0110` | `write_message(char const*, size_t)` | framing de escrita |
| `_ZN11shm_channel12read_messageEP13string_bufferil` | `0xe02aa` | `read_message(string_buffer*, int, long)` | framing de leitura |
| `_Z9shm_writeP11shm_channelPKvm` | `0xe010b` | `shm_write(shm_channel*, void const*, size_t)` | wrapper |
| `_Z8shm_readP11shm_channelP13string_bufferil` | `0xe02a4` | `shm_read(shm_channel*, string_buffer*, int, long)` | wrapper |
| `_Z18create_shm_channelPKc…` | `0xf8293` | `create_shm_channel(char const*, std::string*)` | **nunca chamado no host** |
| `_Z16open_shm_channelPKc…` | `0xf851c` | `open_shm_channel(char const*, std::string*)` | aberto 3× em `main` |
| `_Z19destroy_shm_channelP11shm_channelPKc` | `0xf8418` | `destroy_shm_channel(shm_channel*, char const*)` | teardown |
| `_Z17close_shm_channelP11shm_channel` | `0xf8487` | `close_shm_channel(shm_channel*)` | teardown |
| `_Z18poison_shm_channelP11shm_channel` | `0x1a8722` | `poison_shm_channel(shm_channel*)` | marcação de canal morto |
| `_Z20create_shared_memoryPKcm…` | `0xf81a9` | `create_shared_memory(char const*, size_t, std::string*)` | `shm_open`+`ftruncate`+`mmap` |
| `_Z18open_shared_memoryPKcm…` | `0xf861d` | `open_shared_memory(char const*, size_t, std::string*)` | `shm_open`+`mmap` |
| `_Z20unlink_shared_memoryPKc` | `0xf83ad` | `unlink_shared_memory(char const*)` | `shm_unlink` |
| `_Z19close_shared_memory10shm_handle` | `0x1a871d` | `close_shared_memory(shm_handle)` | `munmap` |
| `_ZN10shm_bundle6configEm` | `0x173d84` | `shm_bundle::config(size_t)` | dimensiona/configura o bundle |
| `_ZN10shm_bundle4initEm` | `0x173eca` | `shm_bundle::init(size_t)` | |
| `_ZN10shm_bundle5fetchEm` | `0x173ede` | `shm_bundle::fetch(size_t)` | acessa o canal *i* |
| `_ZN10shm_bundle4sizeEv` | `0x173eb2` | `shm_bundle::size()` | nº de canais |
| `_Z12send_channelP10shm_bundle` | `0x175dc1` | `send_channel(shm_bundle*)` | flush de saída |
| `_Z23handle_protocol_messagemRK13string_buffer` | `0x17677e` | `handle_protocol_message(unsigned long, string_buffer const&)` | **dispatch por opcode** |
| `_Z14find_arg_valueiPPc9substring` | `0x1a358f` | `find_arg_value(int, char**, substring)` | parse de `argv` |
| `g_shm_bundles` (`B`) | `0x214890` | global | array de bundles |
| `_Z11api_channelv` / `_Z18api_channel_helperP7_objectS0_` | `0x194ab7` / `0x1a068e` | `api_channel()` / `api_channel_helper` | ponte para o módulo Python |
| `_Z20update_check_channelv` | `0x1aa0c7` | `update_check_channel()` | canal de update |
| `_Z11init_pythonb` | `0x1a1af5` | `init_python(bool)` | embute/liga CPython |
| `_Z20attach_crash_handlerRK…` | `0x1ab351` | `attach_crash_handler(std::string const&)` | cliente Crashpad |
| `_Z20init_paths_from_argsiPPc` | `0x1a4a5d` | `init_paths_from_args(int, char**)` | |
| `_Z21api_plugin_host_readyv` | `0x175d6a` | `api_plugin_host_ready()` | handshake de "pronto" |
| `_Z28start_process_monitor_threadjO8functionIFvvEE` | `0x1a7489` | `start_process_monitor_thread(unsigned int, function<void()>)` | watchdog |

> `plugin_host-3.3` possui **o mesmo conjunto** de símbolos de canal
> (`shm_channel`, `shm_bundle`, `open/close/destroy/poison_shm_channel`,
> `handle_protocol_message`, `find_arg_value`, `send_channel`, `g_shm_bundles`),
> com endereços diferentes (ex.: `open_shm_channel @0x2c419c`, `handle_protocol_message
> @0x4f6494`). **O mecanismo de IPC é idêntico nos dois hosts.**

### 3.4 Imports dinâmicos (prova do mecanismo)

`nm -D --undefined-only` (todos GLIBC 2.2.5):

| Import | `sublime_text` | `plugin_host-3.14` | `plugin_host-3.3` | `crash_handler` |
|---|:--:|:--:|:--:|:--:|
| `shm_open` / `shm_unlink` | ✔ | ✔ | ✔ | ✘ |
| `ftruncate` / `mmap` / `munmap` | ✔ | ✔ | ✔ | só `ftruncate`/`munmap` (**sem `mmap`**) |
| `sem_open` / `sem_unlink` / `sem_close` | ✔ | ✔ | ✔ | ✘ |
| `sem_init` (anônimo) | ✔ | ✔ | ✔ | ✔ |
| `sem_wait` / `sem_post` / `sem_timedwait` / `sem_trywait` | ✔ | ✔ | ✔ | ✔ (`sem_init/wait/post/timedwait`) |
| `socketpair` / `sendmsg` / `recvmsg` | ✔ | ✔ | ✔ | ✔ |
| `epoll_create1` / `eventfd` | ✘ | ✘ | ✔ (`epoll_create`) | ✔ |

Leitura: o núcleo e os **dois** hosts importam exatamente o par
`shm_open`+`sem_open`+`mmap`+`ftruncate`. O `crash_handler` **não** importa `shm_open`,
`mmap` nem `sem_open` → não participa do IPC de plugins (§7).

> **Nuance honesta:** `socketpair`/`sendmsg`/`recvmsg` **também** são importados pelo
> núcleo e pelos hosts. Eles **não** são o transporte das mensagens de plugin (isso é
> provado pelas strings e pelos símbolos `shm_channel`), mas existem para outra
> finalidade (possivelmente o cliente Crashpad embutido — `plugin_host-3.14` contém
> `../../../third_party/crashpad/client/crashpad_client_linux.cc`). Ver §8.

### 3.5 Descoberta que resolve a incógnita `%u` vs `%s`

Em `plugin_host-3.14`, o literal de versão `"\x083.14"` está no `.data` em
`vaddr 0x20fc31` (arquivo `0x20cc31`); em `plugin_host-3.3` o equivalente é
`"\x063.3"` em `vaddr 0x636680` (arquivo `0x633680`). O primeiro byte é o
**comprimento empacotado** (3 → `0x06`, 4 → `0x08`), padrão de `substring` interna.

`main` monta o sufixo com `sprintf(buf, "-%s", "3.14")` (**`-%s` @0x75cb5**) e então
`sprintf(nome, "%s:subl_recv%s", argv[1], "-3.14")`. Ou seja:

```
nome_do_objeto = "<id>:subl_<canal>-<versão_python>"     (ex.: "12345:subl_send-3.14")
```

No núcleo, `%u:subl_send%s` recebe o id como **inteiro** (`%u`, provavelmente o PID) e o
mesmo sufixo de versão; no host, `%s:…` recebe o id **já como string** em `argv[1]`.
Isto **explica** o `%u` vs `%s` e, de quebra, **por que** o nome carrega a versão:
impedir colisão quando `plugin_host-3.3` e `plugin_host-3.14` coexistem.

### 3.6 Disassembly dirigido (comportamento, não só nomes)

`create_shared_memory(name, size, err)` @`0xf81a9` — sequência observada:

- **prepende `/`** (constante `0x2f`) ao nome, que passa a `/<name>`, montado num `string_buffer`
  (`strlen` + *append*, no estilo de `resolve_path`);
- **flags `0xc2`** = `O_RDWR|O_CREAT|O_EXCL` (`0x2|0x40|0x80`) e **mode `0x1c0`** = `0700`;
- chama `shm_open("/<name>", 0xc2, 0700)` (via PLT) → `ftruncate` (dimensiona) →
  `mmap` (`PROT_READ|PROT_WRITE`(3), `MAP_SHARED`(1), fd, 0) → `close` (fecha o fd, mantém o mapeamento).

`open_shared_memory(name, size, err)` @`0xf861d`: `shm_open` (sem `O_CREAT`) →
`mmap` → `close`. `close_shared_memory(shm_handle)` @`0x1a871d`: desvia para `munmap`.

`create_shm_channel(name, err)` @`0xf8293`:
`unlink_shared_memory(name)` → `create_shared_memory(name, size, err)` → `new shm_channel`
→ `memset` → `sprintf` → **`sem_open` ×2** (dois semáforos por canal).

`open_shm_channel(name, err)` @`0xf851c`: `open_shared_memory` → … → **`sem_open` ×2**
(no caminho de falha, `sem_unlink`).

`destroy_shm_channel(name, ch)` @`0xf8418`: `unlink_shared_memory` + **`sem_unlink` ×2** + close.
`close_shm_channel(ch)` @`0xf8487`: **`munmap` + `sem_close` ×2**.

Semântica de sinal (disassembly das funções `shm_channel`):

| Função | Chamadas observadas | Leitura |
|---|---|---|
| `wait_read_signal(long)` | `sem_wait` → `clock_gettime` → `sem_timedwait` → `__errno_location` | espera por dado, com *deadline* (`sem_timedwait`) |
| `wait_write_signal()` | desvia para `sem_wait` | espera por espaço, **bloqueante** |
| `signal_reader()` | desvia para `sem_post` | publica "dado disponível" para o leitor |
| `signal_writer()` | desvia para `sem_post` | publica "espaço liberado" para o escritor |
| `write_message(buf,len)` | `pthread_mutex_lock` → `write_bytes` → `pthread_mutex_unlock` → `signal_reader` | escrita atômica + aviso |
| `read_message(sb,int,long)` | `read_bytes` (header) → `string_buffer::resize` → `read_bytes` (corpo) → `signal_writer` | **framing com comprimento** (2 etapas) |

---

## 4. Diagrama textual do handshake

Ordem reconstruída a partir do disassembly de `plugin_host-3.14::main` @`0x1a2d0b`
(idêntica em `plugin_host-3.3::main` @`0x522fa3`):

```
sublime_text  (processo do núcleo)
  │
  │  1. escolhe id (inteiro; formata "%u") e versão de Python ("3.14" | "3.3");
  │     checa "disable_plugin_host_3.3" para decidir qual binário lançar.
  │
  │  2. para cada canal C ∈ {subl_send, subl_recv, subl_arecv}:
  │        nome_C = "/" + sprintf("%u:subl_%s-%s", id, C, pyver)
  │        fd  = shm_open(nome_C, O_RDWR|O_CREAT|O_EXCL, 0700)
  │        ftruncate(fd, size);  mmap(NULL, size, PROT_RW, MAP_SHARED, fd, 0);  close(fd)
  │        sem_open(nome_C + sufixo_de_sinal) ×2      ← sinal de leitura + sinal de escrita
  │     (falha → "Unable to init shm: %s" | "]: failed to create shm channel for worker ")
  │
  │  3. spawn_worker_process(...) → fork/exec "plugin_host-3.14"
  │        (falha → "unable to launch plugin_host" | "]: unable to spawn worker ")
  │
  ▼  argv do host (ao menos 8 posições; argc <= 7 ⇒ o host desiste, §3.6)
     argv[0] = "plugin_host-…"
     argv[1] = id            (a MESMA cadeia usada no nome dos objetos)
     argv[2] = caminho base  → resolve_path(argv[2])
     argv[3] = diretório     → get_current_directory(argv[3])
     argv[4] = "true"|outro  → flag booleana (comparada com a substring "true")
     argv[5..7] = paths      → init_paths_from_args(3, &argv[5])
     (opção "--safe-mode" repassada quando aplicável)

plugin_host (main)
  │  4. signal(...) ; dprintf(...) ; resolve_path ; get_current_directory
  │  5. init_paths_from_args(3, &argv[5])
  │  6. attach_crash_handler(dir)      (pulado se g_is_development)
  │  7. shm_bundle::config(size)       → prepara o bundle (g_shm_bundles)
  │  8. sprintf("-3.14")  → suf
  │     para C em {subl_recv, subl_send, subl_arecv}   ← ORDEM EXATA do disassembly:
  │        nome_C = sprintf("%s:subl_%s%s", argv[1], C, suf)
  │        open_shm_channel(nome_C)     → open_shared_memory(): shm_open(nome_C,O_RDWR)
  │                                       + mmap + close  +  sem_open ×2
  │        unlink_shared_memory(nome_C) ← remove o NOME do namespace após mapear
  │        bundle[i] = canal
  │     (qualquer falha → dprintf("unable to open channels"))
  │  9. init_python(...)
  │ 10. atoi(...) ; start_process_monitor_thread(...)
  │ 11. api_plugin_host_ready()          → sinaliza "pronto" ao núcleo
  │
  └─► LOOP: read_message(canal) → handle_protocol_message(opcode, payload)
             → { plugin_reload_plugin | plugin_create_application_commands | plugin_load_finished | … }
```

Pontos-chave comprovados:

- **O host nunca cria objetos.** Não há **nenhuma** chamada a
  `create_shm_channel` (`0xf8293`) em `plugin_host-3.14` → o host só chama
  `open_shm_channel`, **três vezes**, na mesma função (`main`): `0x1a2e63`, `0x1a2e91`,
  `0x1a2ebf`. Logo, o **núcleo é o criador** (corroborado por
  `]: failed to create shm channel for worker ` no núcleo).
- **`open_shm_channel` é seguido de `unlink_shared_memory`** (sem desvio entre as duas
  chamadas) → o host abre o mapeamento e em seguida desvincula o nome do namespace
  (`shm_unlink`), padrão "unlink-after-open" que evita vazamento de nomes. O objeto
  permanece vivo enquanto houver mapeamentos.
- **Bundle com índice:** o resultado de cada `open_shm_channel` é guardado em
  `bundle->channel[i]` (ex.: o ponteiro do canal `recv` é gravado em `+0x8` sobre a base `g_shm_bundles`),
  o que casa com `shm_bundle::fetch(index)` / `size()`. A ordem observada no host é
  **recv (0), send (1), arecv (2)**.
- O loop de `main` itera os canais com **stride `0x20`** (avanço de `0x20` no ponteiro de iteração),
  consistente com `sizeof(shm_channel)`.
  > ⚠️ **Caveat (P1.3):** `ipc-protocol.md` §3.2 mede o objeto alocado pelo *ctor* de `shm_channel`
  > em **`0x58`** bytes, o que **não** casa com o stride `0x20` deste loop — a incompatibilidade está
  > registrada como `[DESCONHECIDO]` lá; o loop pode iterar outro vetor (ex.: array de ponteiros).

---

## 5. Threading

O modelo é **multi-thread** dentro de cada processo:

- Núcleo: `shm_reader` @`0xf56d4` é nome de thread — o `%u:subl_arecv%s` @`0xf56c4`
  aparece imediatamente antes, sugerindo uma thread dedicada a consumir o canal
  **assíncrono** (`arecv`) e outra para o `recv` síncrono.
- Host: `start_process_monitor_thread(unsigned int, function<void()>)` @`0x1a7489` é
  chamado em `main` logo antes de `api_plugin_host_ready()` — watchdog de processo.
- Infra de filas de trabalho (`.dynsym` do host):

| Símbolo | Endereço |
|---|---|
| `g_async_work_queue` (`B`) | `0x2148b0` |
| `g_async_work_queue_runner` (`B`) | `0x2148f8` |
| `g_main_thread_wait_count` (`B`) | `0x214888` |
| `g_is_main_thread` (`B`) | `0xa58` |
| `g_is_main_thread_blocking` (`B`) | `0x214939` |
| `g_is_main_thread_handling_message` (`B`) | `0x214938` |
| `is_main_thread()` | `0x1a8bc7` |
| `work_queue::push*` / `attach_runner` | `0xeaa70`, `0x1a9bec` … |
| RTTI `work_queue_runner` / `thread_queue_runner` / `async_thread_queue_runner` | `0x1a9d9a`, `0xf3068`, `0x1a9ec2` |

- `plugin_host-3.14` importa `pthread_*` (mutex/cond) e usa
  `pthread_mutex_lock/unlock` **dentro de `shm_channel::write_message`** — ou seja, há
  um mutex por canal protegendo os acessos ao anel de memória compartilhada.

**Modelo de concorrência inferido:** um `shm_channel` = 1 buffer circular + 1 mutex +
2 semáforos; o escritor (`write_message`) trava o mutex, escreve os bytes, destrava e
faz `sem_post` no semáforo do leitor; o leitor (`read_message`) lê header+corpo e faz
`sem_post` no semáforo do escritor para liberar espaço. `wait_read_signal` aceita
*timeout* (`sem_timedwait`), `wait_write_signal` é bloqueante (`sem_wait`).

---

## 6. CPython embutido vs. ligado (diff 3.3 ↔ 3.14)

| Aspecto | `plugin_host-3.14` | `plugin_host-3.3` |
|---|---|---|
| `NEEDED libpython…` | **sim** (`libpython3.14.so.1.0`; `RUNPATH=$ORIGIN`) | **não** |
| Símbolos `Py_*`/`_Py_*` **definidos** | `0` | **1582** (pela tabela dinâmica, `readelf -sW`) |
| Símbolos `Py_*` **importados** (`U`) | ~80 (`Py_InitializeFromConfig`, `PyConfig_*`, `PyPreConfig_*`, `PyGILState_Ensure/Release`, `PyRun_SimpleStringFlags`, `PyModule_Create2`, `PyEval_SaveThread/RestoreThread`, …) | 0 |
| Versão embutida | — (usa 3.14 do `.so`) | `3.3.7` @`0xf1b54` |
| Stdlib | — | `/Lib/python3.3.zip` @`0xe963f` (e uma 2ª ocorrência @`0xf44df`) |
| Banner | — | `Copyright (c) 2001-2017 Python Software Foundation.` |
| `Py_Initialize` definido em | — | `0x3dd22c` |
| Outras `NEEDED` | `librt, libdl, libm, libgcc_s, libpthread, libc` | `librt, libdl, **libutil**, **libcrypto.so.1.1**, **libssl.so.1.1**, **libsqlite3**, libm, libgcc_s, libpthread, libc` |
| Tamanho | 2,16 MB | 6,52 MB (**3×**) |
| Strings `api_*` (enum de protocolo) | **281** | **282** |
| Mecanismo de IPC | `shm_channel`/`shm_bundle` | **idênticos** (mesmos símbolos e mesmos 3 nomes) |

**Conclusões:**
1. O 3× de tamanho do host-3.3 é explicado por **CPython 3.3.7 estático** (+ `ssl`,
   `crypto`, `sqlite3` também estáticos/ligados) — já o host-3.14 **liga** a
   `libpython3.14.so.1.0` (11,4 MB, com 195 símbolos `Py_*` exportados via `nm -D`).
2. A API de inicialização é a **antiga** no 3.3 (`Py_Initialize`/`PyEval_InitThreads`)
   e a **moderna** no 3.14 (`PyConfig`/`Py_InitializeFromConfig`) —
   `PyEval_InitThreads` é importado pelo 3.14 por compatibilidade.
3. **O protocolo/IPC não muda entre as versões.** A única diferença observável no canal
   é o sufixo de versão no nome do objeto (`-3.3` vs `-3.14`).
4. Scan negativo: `libpython3.14.so.1.0` **não** contém `subl_send`/`subl_recv`/
   `subl_arecv` (`grep` → nenhum) → os canais **não** vêm do stdlib
   (`multiprocessing`/`posixshmem`); são código próprio do Sublime. *(Nota: a libpython
   contém a literal "shm_open", do stdlib, o que é irrelevante para o canal.)*

---

## 7. `crash_handler` — fora do escopo do IPC de plugins

**Veredito:** `crash_handler` é um **servidor Crashpad** e **não participa** da ponte IPC
dos plugins.

| Evidência | Achado |
|---|---|
| Strings de código-fonte | `../../../third_party/crashpad/handler/handler_main.cc`, `handler/minidump_to_upload_parameters.cc`, `handler/crash_report_upload_thread.cc`, `util/net/http_transport_libcurl.cc`, `util/linux/{socket,ptracer,memory_map}.cc`, `util/misc/paths_linux.cc` |
| Opções de CLI | `--no-rate-limit`, `--no-upload-gzip` (flags do handler Crashpad) |
| `shm_open` / `shm_unlink` | **ausentes** |
| `sem_open` / `sem_unlink` / `sem_close` | **ausentes** (só `sem_init` **anônimo**, `Check failed: sem_init(&semaphore_, 0, value) == 0`) |
| `mmap` | **ausente** (só `munmap`) |
| `subl_send` / `subl_recv` e demais nomes de canal | **ausentes** |
| Transporte próprio | `socketpair` + `sendmsg`/`recvmsg` + `epoll_create1` + `eventfd` |

Ou seja: o handler usa socketpair/`sendmsg`/`recvmsg` (protocolo do Crashpad) e
semáforos **anônimos** — nada disso é o anel de memória compartilhada do Sublime.

**Nota de relação:** `sublime_text` contém 35 literais `crashpad/*` e o
`plugin_host-3.14` contém `crashpad_client_linux.cc`; ambos são **clientes** Crashpad
(chamada `attach_crash_handler(dir)` em `main` do host). Portanto `crash_handler` é o
*servidor* de minidumps dos dois — canal **separado** do canal de plugins.

---

## 8. Limites e incógnitas

### ✅ Resolvidas pelo P1.3 (ver [`ipc-protocol.md`](ipc-protocol.md))

| # (aqui) | Incógnita antiga | Resolução |
|---|---|---|
| 1 | **Layout binário do canal.** Offsets internos do `shm_channel`, `size` de `config`/`create_shared_memory` e capacidade de cada anel **não recuperados** | **resolvida** — região shm = `0x80000` literal; anel com header `0x80` (índices `u64` @`0x0`/`0x40`), dados @`0x80`, capacidade **constante** `0x7ff80`; objeto `shm_channel` = `0x58` com semáforos @`0x0`/`0x8`, mutex @`0x10`, ring @`0x38`, base @`0x40`, size @`0x48`, creator @`0x50`, poison @`0x51`; bundle = 1 canal ×`0x78` ([`ipc-protocol.md`](ipc-protocol.md) §3 e §5, `E8–E11`/`E15–E17`) |
| 2 | **Framing de `read_message`/`write_message`.** Largura/endianness do prefixo e campos extras | **resolvida** — prefixo = **4 bytes `uint32` LE** nativo; corpo sem NUL e sem terminador garantido; **nenhum** campo além do comprimento (tipo/opcode/flags **não** existem no framing) ([`ipc-protocol.md`](ipc-protocol.md) §2, `E1–E7`) |
| 3 | **Enum de opcodes.** “Textual” e/ou 1º parâmetro `unsigned long`; mapeamento `api_*` → opcode | **resolvida** — dispatch **100% numérico**: opcode = 1º `uint32` do payload; o `unsigned long` é o **índice do bundle** (`stride 0x78`); dois enums: **U** (host→núcleo) = 281 ids `1..281` (tabela `.rodata 0x104a70`, Anexo A) e **V** (núcleo→host) = 71 ids `1..71` (`.rodata 0x81e28`) ([`ipc-protocol.md`](ipc-protocol.md) §6, `E22–E30`) |
| 8 | **Nomes exatos dos dois semáforos** por canal | **resolvida** — templates `%s:r` (val inicial 0) e `%s:w` (val inicial 1) → `<canal>:r` / `<canal>:w` (p.ex. `<id>:subl_send-3.14:r`); `open` faz `sem_unlink` imediato após cada `sem_open` ([`ipc-protocol.md`](ipc-protocol.md) §4, `E12–E14`) |

### Incógnitas remanescentes (renumeradas)

1. **Nome do objeto: barra inicial.** Os literais **não** trazem `/`. Provou-se que
   `create_shared_memory` **prepende** `/` (constante `0x2f`) antes de `shm_open`; resta
   confirmar se o **núcleo** faz o mesmo caminho e se há *normalização* por
   `resolve_path` (por usuário/sessão). O candidato a base `sublime.XXXXXX`
   (`mkstemp`) tem uso **não confirmado** (pode ser path de arquivo/log, não de shm).
2. **Significado exato de `argv[1]`.** É o id usado no nome (`%s` no host). O núcleo
   formata com `%u`; **não** foi confirmado que seja o **PID** (nem de quem: núcleo ou
   host).
3. **Os 8 argumentos de CLI.** `main` exige `argc > 7` e consome `argv[1..7]`; o
   **contrato completo** (nomes/semântica de `argv[5..7]`, e a flag `argv[4]=="true"`)
   não foi totalmente reconstruído.
4. **`socketpair`/`sendmsg`/`recvmsg` no núcleo e nos hosts.** Presentes, mas **não** são
   o transporte de mensagens de plugin. Uso exato **não determinado** (cliente Crashpad
   é o suspeito principal; pode haver também um canal auxiliar — o host cita
   `--shared-client-connection`).
5. **`sublime_text` é "cega" para símbolos.** Só exporta 12 dynsyms (família `malloc`);
   o lado do núcleo foi caracterizado por **strings + imports**, não por símbolos
   (`shm_channel` no núcleo é código estático, sem nomes). Toda afirmação sobre o lado
   do núcleo tem confiança um degrau abaixo daquelas sobre o host.
6. **Detalhe do bit em `.data` (`0x20fc30`)**: próximo ao literal `"3.14"`; a leitura
   exata (teste do bit `0x1`) e a variante "dinâmica" de versão (`[g_alive+0x18]`, nula
   estaticamente) não foram totalmente explicadas. *(Relacionada a
   [`ipc-protocol.md`](ipc-protocol.md) §7.3, incógnita do campo `shm_channel+0x50`.)*

> **Pendências herdadas / novas do P1.3** (sem promoção de confiança) vivem em
> [`ipc-protocol.md`](ipc-protocol.md) §7: padding do header do anel `0x8..0x40`/`0x48..0x80`;
> semântica exata do trio de canais do bundle (por que o request/response **lê** de `subl_send` e
> **escreve** em `subl_recv`; quando `subl_arecv` é usado por thread não-main); uso real de
> `shm_channel+0x50`; modo **síncrono vs assíncrono** por id e geração do `req_id`; quais ids
> retornam `true` em `is_app_blocking_while_sending`; subcódigos de `data[0] == 0`.

---

## 9. Ledger de evidências

| # | Conclusão | Evidência | Tipo | Confiança |
|---|---|---|---|---|
| 1 | IPC = memória compartilhada POSIX nomeada + semáforos nomeados | `create_shared_memory` chama `shm_open`/`ftruncate`/`mmap`/`close`; `create_shm_channel` chama `sem_open` ×2; `destroy` faz `sem_unlink` ×2; `close` faz `munmap`+`sem_close` ×2 | disassembly (`objdump -d` PLT calls) | **alta** |
| 2 | Três canais: `subl_send`, `subl_recv`, `subl_arecv` | 3× `sprintf("%s:subl_%s%s")` + 3× `open_shm_channel` em `main`; strings nos dois lados | disassembly + strings | **alta** |
| 3 | Núcleo cria; host só abre | host-3.14/3.3: zero chamadas a `create_shm_channel`; 3× chamada a `open_shm_channel`; núcleo tem `]: failed to create shm channel for worker ` | disassembly + string | **alta** |
| 4 | Nome = `<id>:subl_<canal>-<versão>`, prefixado com `/` | literais `%u:subl_*%s` (núcleo) e `%s:subl_*%s` (host); `-%s` @`0x75cb5` + literal `"3.14"` (`0x20fc31`) / `"3.3"` (`0x636680`); prefixo `/` (constante `0x2f`) prependido antes de `shm_open` | disassembly + `.data` | **alta** (média em `argv[1]`=PID) |
| 5 | Mutex por canal + 2 semáforos (leitura/escrita) | `write_message`: `pthread_mutex_lock`→`write_bytes`→`unlock`→`signal_reader`; `signal_*`: desvia para `sem_post` | disassembly | **alta** |
| 6 | Espera com timeout no `read`, bloqueante no `write` | `wait_read_signal`: `sem_wait`+`clock_gettime`+`sem_timedwait`; `wait_write_signal`: desvia para `sem_wait` | disassembly | **alta** |
| 7 | Mensagem tem prefixo de comprimento | `read_message`: `read_bytes`→`string_buffer::resize`→`read_bytes` | disassembly | **alta** |
| 8 | Dispatch por `handle_protocol_message(unsigned long, string_buffer const&)` | símbolo `_Z23handle_protocol_messagemRK13string_buffer` @`0x17677e`, chamado no loop de `main` | símbolo + disassembly | **alta** |
| 9 | Enum de protocolo textual `api_*` (281/282 comandos) | `strings \| grep '^api_…$'` = 281 (3.14), 282 (3.3) | strings | **média** (contagem alta; o *mapeamento* para opcode é incógnita §8.3) |
| 10 | Bundle com índice de canais | `shm_bundle::config/init/size/fetch`, `g_shm_bundles`, `send_channel(shm_bundle*)`; store `bundle->chan[i]` | símbolos + disassembly | **alta** |
| 11 | Host exige ≥8 argumentos | `main`: compara a contagem de argumentos com `0x7` (prossegue se maior), senão `dprintf`+`return 1`; `init_paths_from_args(3,&argv[5])` | disassembly | **alta** |
| 12 | `plugin_host-3.3` embute CPython 3.3.7 | 1582 `Py_*`/`_Py_*` definidos (`readelf -sW`), `3.3.7`@`0xf1b54`, `python3.3.zip`@`0xe963f`, `Py_Initialize`@`0x3dd22c` | dynsym + strings | **alta** |
| 13 | `plugin_host-3.14` liga `libpython3.14.so.1.0` | `NEEDED` + `RUNPATH=$ORIGIN`; 0 `Py_*` definidos, ~80 importados (`Py_InitializeFromConfig`, `PyConfig_*`) | `readelf -d` + dynsym | **alta** |
| 14 | IPC idêntico entre 3.3 e 3.14 | mesmos símbolos de canal e mesmos 3 nomes nos dois hosts; mesma sequência em `main` | símbolos + disassembly | **alta** |
| 15 | Canais **não** são `multiprocessing` do CPython | `libpython3.14.so.1.0` sem `subl_send/subl_recv/subl_arecv`; canal é C++ próprio (`shm_channel`) | `grep` + símbolos | **alta** |
| 16 | `crash_handler` não participa do IPC de plugins | Crashpad (`handler_main.cc`, `crash_report_upload_thread.cc`); sem `shm_open`/`mmap`/`sem_open`; sem `subl_*`; só `sem_init` anônimo | strings + imports | **alta** |
| 17 | Núcleo e hosts importam o mesmo par shm/sem | `nm -D -u`: `shm_open, shm_unlink, mmap, munmap, ftruncate, sem_open, sem_post, sem_wait, sem_timedwait, sem_unlink, sem_close` | imports | **alta** |
| 18 | Thread dedicada ao canal assíncrono no núcleo | literal `shm_reader` @`0xf56d4` imediatamente após `%u:subl_arecv%s` @`0xf56c4` | strings (adjacência) | **média** (adjacência é forte, mas nome de thread) |
| 19 | Modelo multi-thread com filas de trabalho | `g_async_work_queue(_runner)`, `work_queue`, RTTI `*_queue_runner`, `is_main_thread()`, `start_process_monitor_thread` | símbolos | **alta** |
| 20 | Mensagens do host → núcleo saem por `subl_send` | `send_channel(shm_bundle*)` @`0x175dc1` + 3 nomes | símbolos | **média** (direção inferida; não segui o buffer até o índice) — ⚠️ **revisado em P1.3**: a evidência nova inverte a direção (`subl_send` = **entrada do host**); ver §1 nota de revisão e [`ipc-protocol.md`](ipc-protocol.md) `E18`/`E19` |
| 21 | Framing = `[uint32 LE len][payload len bytes]`, sem tipo/opcode/flags; corpo sem terminador NUL | store de 4 bytes do comprimento @`0xe012b`; `resize` `0xd7a2c`; `malloc(len)` sem `+1` @`0xe5e60` | disassembly | **alta** ([`ipc-protocol.md`](ipc-protocol.md) `E1–E7`) |
| 22 | Anel shm `0x80000`: índices `u64` @`0x0`/`0x40`, dados @`0x80`, capacidade **constante** `0x7ff80` (útil `0x7ff7f`) | constante `0x80000` como 2º argumento `0xf82ae`; divisão pelo divisor `0x7ff80` | disassembly | **alta** ([`ipc-protocol.md`](ipc-protocol.md) `E8–E10`) |
| 23 | `shm_channel` = `0x58`: sem @`0x0`/`0x8`, mutex @`0x10`, ring @`0x38`, base @`0x40`, size @`0x48`, creator @`0x50`, poison @`0x51` | ctor `0xf84fc`, dtor `0xf84a4`, mark-dead `0xfa3f0` | disassembly | **alta** ([`ipc-protocol.md`](ipc-protocol.md) `E11`) |
| 24 | Semáforos nomeados `<canal>:r` (val 0) e `<canal>:w` (val 1); `open` = *unlink-after-open* | literais `%s:r` `0x7aafe` / `%s:w` `0x7a26f`; `sem_open` `0xf8317`/`0xf8344`; `sem_unlink` `0xf8592`/`0xf85d1` | disassembly + bytes | **alta** ([`ipc-protocol.md`](ipc-protocol.md) `E12–E14`) |
| 25 | Bundle = 1 elemento de `0x78`; canais em `+0x8` `subl_recv`, `+0x10` `subl_send`, `+0x18` `subl_arecv`; *slot* por papel de thread | `config(1)` `0x1a2de4`; literais `0x78b1f`/`0x7b132`/`0x751fb`; `send_channel` `0x175dd1` | disassembly | **alta** ([`ipc-protocol.md`](ipc-protocol.md) `E15–E17`) |
| 26 | Dispatch **numérico**: opcode = 1º `uint32` do payload; `unsigned long` = índice do bundle; enum **U** = 281 ids (`1..281`, `.rodata 0x104a70`) e enum **V** = 71 ids (`1..71`, `.rodata 0x81e28`); tabelas de saltos densas | `handle_protocol_message` @`0x17677e`; dispatcher gêmeo do núcleo @`0x54d999`; `main` @`0x1a2f99`–`0x1a2fc7` | disassembly + readelf | **alta** ([`ipc-protocol.md`](ipc-protocol.md) `E22–E30`, Anexo A) |

> **Notas de revisão P1.3:** (a) o enum **não** é textual — a linha 9 acima descrevia 281–282
> literais `api_*` como “candidatos a nomes de comando”; o mapeamento **foi** estabelecido e é
> **numérico** (`id 1..281` ↔ `api_*`, Anexo A de [`ipc-protocol.md`](ipc-protocol.md)); (b) a linha
> 20 fica **superada** quanto à direção (mantida como registro da inferência antiga); (c) pendências
> remanescentes em [`ipc-protocol.md`](ipc-protocol.md) §7.
