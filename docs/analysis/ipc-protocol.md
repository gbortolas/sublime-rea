# Wire protocol núcleo ↔ `plugin_host` — framing, anel e enum de opcodes (P1.3) 📡

> **Entregável:** **P1.3** — o **protocolo observável** da ponte `sublime_text` ↔ `plugin_host`:
> o *framing* de `write_message`/`read_message`, o layout do anel em memória compartilhada e do
> objeto `shm_channel`, os nomes dos semáforos, os *slots* do `shm_bundle` e o **dispatch por
> opcode** (dois enums, um por direção), com o mapa completo `id → api_*` (Anexo A).
> Continua o doc irmão [`ipc-plugin-host.md`](ipc-plugin-host.md) (mecanismo/transporte) — **este**
> doc fecha as incógnitas §8.1, §8.2, §8.3 e §8.8 de lá.
>
> **Alvo primário:** `target/sublime_text/plugin_host-3.14` (tem `.dynsym`); cross-check em
> `plugin_host-3.3` e no núcleo `target/sublime_text/sublime_text`.
> **Regime clean-room:** só **endereços, larguras, offsets, contagens, nomes e papel arquitetural**
> — nenhum bloco de implementação/assembly do alvo é transcrito.
> **Convenção:** cada afirmação é rotulada **[OBSERVADO]**, **[INFERIDO]** ou **[DESCONHECIDO]**.

**Achado central (1–2 frases):** o transporte é um **anel circular em shm** (região de `0x80000` B =
512 KiB, header de `0x80` B com índices `u64` de leitura/escrita, dados a partir de `+0x80`,
capacidade **constante** `0x7ff80`) e a **única** estrutura de mensagem é
`[uint32 LE len][payload len bytes]` — **sem** campo de tipo, opcode ou flags no framing
[OBSERVADO]; o **opcode é o primeiro `uint32` do próprio payload** e o dispatch é **100% numérico**
por **tabela de saltos densa**, com **dois enums** em direções opostas: **U** (host→núcleo,
**281 ids** contíguos, `1..281`) e **V** (núcleo→host, **71 ids**, `1..71`) [OBSERVADO]. O enum **U
foi reconstruído por inteiro** por dois caminhos independentes que concordam 1:1 (imediato do id
dentro de cada `api_*()` e a ordem da `PyMethodDef[]` do módulo `sublime_api`) — Anexo A
[OBSERVADO, confiança alta].

**Docs irmãos (Fase 1):** [`ipc-plugin-host.md`](ipc-plugin-host.md) (P1.3 — mecanismo/transporte) ·
[`buffer-structure.md`](buffer-structure.md) (P1.1) · [`concurrency.md`](concurrency.md) (P1.2) ·
[`api-python.md`](api-python.md) (API de plugins) · [`packaging.md`](packaging.md) (P1.6).

---

## 1. 🔎 Escopo, artefatos e método

### 1.1 Artefatos (SHA-256 aferido em [`ipc-plugin-host.md`](ipc-plugin-host.md) §2.1)

| Artefato | Tam. | SHA-256 | Papel aqui |
|---|---:|---|---|
| `plugin_host-3.14` | 2,16 MB | `194bfb8f6ecdb31cd3719efe681095f30920cddfa9e63e957b524fe67b70b0ce` | **alvo primário** (`.dynsym`); 281 strings `api_*` |
| `plugin_host-3.3` | 6,52 MB | `fda8e3ea00a59f4666e92649ef4afcd3b9e23ce3f574c1d5fc52f70d1f81a52c` | cross-check (282 strings `api_*`) |
| `sublime_text` | 9,95 MB | `8b105b1839d7809f60ec186b6c6dcb2d107e22ad23f42c5f8ba7dec67ab43d92` | lado núcleo (**stripped**, só 1 string `api_*`, alheia) |

### 1.2 Métodos

- `nm -D --defined-only` (símbolos C++ mangled) e `objdump -d -M intel` dirigido por faixa
  (`--start-address/--stop-address`) para **sítios de chamada e constantes**, não para copiar código.
- `readelf -rSW` para relocações (`R_X86_64_RELATIVE`) e seções; `strings -t x` para literais com
  offset exato; `python3` para **leitura direta dos bytes** (tabelas de saltos, `.data.rel.ro`).
- Tabelas de saltos lidas **entrada por entrada** (offset `int32` relativo → alvo em `.text`).
- **Nenhum** uso de Ghidra nesta etapa: o caminho foi `objdump`/`readelf`/bytes (mesma linhagem do
  Track A de [`ipc-plugin-host.md`](ipc-plugin-host.md)).

> **Convenção de offsets:** como em [`ipc-plugin-host.md`](ipc-plugin-host.md), nos binários deste
> alvo `vaddr == p_offset` nas seções usadas, então os offsets de string citados são simultaneamente
> **offset de arquivo e endereço virtual**. Símbolos são endereços virtuais (PIE, base somada em
> runtime) — `plugin_host-3.14`, `plugin_host-3.3` e núcleo têm **bases de espaço diferentes**.

---

## 2. 🧱 Framing de `write_message` / `read_message`

Funções no 3.14 (`.dynsym`): `write_message` @`0xe0110`, `write_bytes` @`0xe0184`,
`signal_reader` @`0xe017c`, `read_message` @`0xe02aa`, `read_bytes` @`0xe032a`,
`signal_writer` @`0xe0320`, `wait_read_signal(long)` @`0xe0460`, `wait_write_signal()` @`0xf72d8`.

**[OBSERVADO] F1 — O prefixo de comprimento é 4 bytes: `uint32` little-endian nativo (x86-64).**
`write_message` grava os 32 bits baixos do `size_t` num scratch de 4 bytes (store de 4 bytes do
comprimento, truncado a 32 bits, em @`0xe012b`; o valor é o `size_t` len). **Não** há prefixo de 8 bytes nem *packing*. A assinatura
demangled é `write_message(char const*, size_t)`, mas a serialização **trunca para 32 bits**.

**[OBSERVADO] F2 — `write_message` faz DUAS escritas (header 4 B + corpo), não uma.**
`write_bytes(this,&len32,4)` em `0xe0144` e depois `write_bytes(this,buf,len)` em `0xe0152`.
Ordem observada: `pthread_mutex_lock([this+0x10])` (`0xe0136`) → header → corpo →
`pthread_mutex_unlock` (`0xe015a`) → `signal_reader`/`sem_post` (`0xe0162`) →
**lock→write→write→unlock→sem_post** confirmado. Retorno: `!(byte[this+0x51] & 1)`
(`0xe0167`–`0xe016c`) = “sucesso **e** canal não envenenado”.

**[OBSERVADO] F3 — `read_message` faz DUAS leituras (header 4 B → `resize` → corpo).**
- Zera um local de 4 bytes (zeragem do dword, `0xe02c1`).
- Header: `read_bytes(this,&local,4,spin,timeout)` em `0xe02c9` (count = 4).
- Comprimento lido como **dword** a partir do local de 4 bytes (`0xe02d2`).
- `string_buffer::resize(sb, len)` em `0xe02dd` → `0xd7a2c`.
- Corpo: `read_bytes(this, sb->data@[sb+0x10], len, spin, 0)` em `0xe02f1` (**timeout 0 =
  bloqueante**).
- `signal_writer` (`sem_post` em `[this+0x8]`) em `0xe02fd`.
- Retorno `!(byte[this+0x51] & 1)`; em falha chama `mark-dead`/`poison_shm_channel` (`0xfa3f0`) e
  retorna 0.

**[OBSERVADO] F4 — NÃO há outros campos no framing (sem tipo/opcode/flags antes ou depois do
comprimento).** O transporte é exatamente `[uint32 len][payload de len bytes]`. O **opcode não está
no framing**: ele é o **primeiro dword do próprio payload** (evidência em §6.1). Ou seja: o *header*
é puramente um delimitador de comprimento.

### 2.1 `string_buffer` e semântica do corpo

**[OBSERVADO] F5 — `string_buffer` = estrutura com comprimento explícito.** Layout:
`size_t length@0x0`, `size_t capacity@0x8`, `char* data@0x10`, buffer **inline (SSO)** a partir de
`0x18` (referência a `rbx+0x18` em `reserve_exact` `0xe5e3e`). `resize(len)` (@`0xd7a2c`):
se `capacity >= len`, só faz `length = len`; senão chama `reserve_exact(len)`.

**[OBSERVADO] F6 — `reserve_exact(len)` aloca EXATAMENTE `len` bytes (malloc/realloc), sem `+1` →
sem terminador NUL garantido.** `reserve_exact` @`0xe5e2c`: `realloc(data,len)` (`0xe5e4a`) ou
`malloc(len)` (`0xe5e60`) quando ainda no SSO — **sem** somar 1. `copy_to` @`0xd7a74` copia
exatamente `length` bytes para `std::string`. **Corolário:** o comprimento **não** inclui NUL e o
conteúdo é um **buffer de bytes por comprimento**, reinterpretável como texto (UTF-8) no
consumidor; o corpo só vai para o heap quando `len` excede a capacidade inline (SSO).

---

## 3. 📦 Layout do anel no shm e do objeto `shm_channel`

### 3.1 A região compartilhada (o anel)

**[OBSERVADO] F7 — Região shm = `0x80000` bytes (512 KiB), literal.** `create_shm_channel`
(constante `0x80000` passada como 2º argumento @`0xf82ae`) e `open_shm_channel` (`0xf8532`) passam a mesma constante a
`create_shared_memory`/`open_shared_memory`; o lado `create` ainda faz `memset(base,0,0x80000)`
(`0xf82f7`).

**[OBSERVADO] F8 — Header do anel = `0x80` bytes; dados em `[base+0x80, base+0x80000)`.**

| Offset no shm | Campo | Evidência |
|---|---|---|
| `+0x00` | índice de **escrita**, `uint64` | `[rbp+0x0]` em `write_bytes` `0xe01be`/`0xe022e`, `read_bytes` `0xe0373` |
| `+0x40` | índice de **leitura**, `uint64` | `[rbp+0x40]` em `write_bytes` `0xe01c2`, `read_bytes` `0xe036f`/`0xe03e9` |
| `+0x80` | **início dos dados** | ponteiro para `base+0x80` em `0xe0206` e `0xe03ba` |
| `0x80000` | fim da região | `memset`/`mmap` |

- **Capacidade do anel = `0x7ff80`** (= `0x80000 − 0x80` = **524 160 B**) — **constante embutida, não
  armazenada**: o acesso usa divisão pelo divisor `0x7ff80` em `write_bytes` (`0xe018d`/`0xe0226`) e
  `read_bytes` (`0xe034a`/`0xe03e1`).
- Espaço livre usa `cap−1 = 0x7ff7f` (soma da constante `0x7ff7f` @`0xe01c9`) → **1 byte reservado** (regra
  *full/empty* do anel).
- Bytes `0x8..0x40` e `0x48..0x80` **não são referenciados** por `write_bytes`/`read_bytes`. **Não**
  há contador de capacidade nem flag no shm: **ambos os lados usam a constante**.
  `[DESCONHECIDO]` o conteúdo/utilidade dessas lacunas (ver §7.1).

### 3.2 O objeto `shm_channel` (heap)

**[OBSERVADO] F9 — `shm_channel` = `0x58` (88) bytes** (`new(0x58)` em `0xf82cf` *create* e `0xf854e`
*open*). Layout inferido do ctor/dtor e dos *setters* (todos com endereço observado):

| Offset | Campo | Papel |
|---|---|---|
| `+0x00` | `sem_t*` **sem0** — nome `…:r`, valor inicial **0** | “há dado” (reader semaphore) |
| `+0x08` | `sem_t*` **sem1** — nome `…:w`, valor inicial **1** | “há espaço” (writer semaphore) |
| `+0x10` | `pthread_mutex_t` embutido (attrs default, `0x28` B → `+0x10..+0x38`) | serializa escrita |
| `+0x38` | `void*` **anel** (= base do shm) | usado por `write/read_bytes` como `[this+0x38]` |
| `+0x40` | `void*` base do **mapeamento** | usado por `munmap` no dtor |
| `+0x48` | `size_t` tamanho do mapeamento (= `0x80000`) | |
| `+0x50` | `bool` **creator** (=1 em *create*; 0 em *open*) | |
| `+0x51` | `bool` **poisoned** (setado por `mark-dead` @`0xfa3f0`) | canal morto |

Evidência: ctor @`0xf84fc` (zera `[0x0..0x10)`, inicializa mutex @`0x10`, zera `[0x38..0x48)`);
*create* seta `[0x40]`,`[0x48]`,`[0x50]=1` (`0xf82e0`–`0xf82e8`) e `[0x38]=base` (`0xf82fc`);
dtor @`0xf84a4`: `munmap([0x40],[0x48])`, `sem_close([0x0])`, `sem_close([0x8])`,
`pthread_mutex_destroy([0x10])`. Nota: `+0x38` e `+0x40` têm **o mesmo valor** aqui (dois campos,
mesma base). `[OBSERVADO]` o shm contém **só o anel** (índices + dados): mutex e semáforos vivem no
objeto do processo.

> **Ajuste do doc irmão `[DESCONHECIDO]`:** [`ipc-plugin-host.md`](ipc-plugin-host.md) §4 anotou que
> o loop de `main` itera canais com *stride* `0x20`, “consistente com
> `sizeof(shm_channel)`”; a **alocação** observada do objeto aqui é **`0x58`** (`new(0x58)`). As duas
> medidas são **incompatíveis**: `0x20` pode ser o passo de um **array de ponteiros**
> (`shm_channel*`, 8 B) ou de um subobjeto não mapeado — `[DESCONHECIDO]`. Fica registrado; o
> objeto tem `0x58` (E11).

---

## 4. 🔑 Semáforos nomeados: `<canal>:r` e `<canal>:w`

**[OBSERVADO] F10 — Os dois semáforos são SEMPRE nomeados** (`sem_open`), **nunca** `sem_init`
anônimo embutido no shm. Os `sem_t*` ficam no objeto do processo; o shm contém só o anel.

**[OBSERVADO] F11 — Templates de nome: `%s:r` e `%s:w`.**

| Literal | 3.14 | 3.3 | Núcleo |
|---|---|---|---|
| `%s:r` | vaddr `0x7aafe` (referência RIP-relativa ao literal em `0xf8300`/`0xf856d`) | `0x109a31` | `0xeae6b` |
| `%s:w` | vaddr `0x7a26f` (referência RIP-relativa ao literal em `0xf8330`/`0xf85a2`) | `0x106349` | `0xe8cf2` |

Logo, para o canal `<id>:subl_send-3.14`, os semáforos são **`<id>:subl_send-3.14:r`** e
**`<id>:subl_send-3.14:w`**.

- `create`: `sem_open(name, 0xc0, 0777, val)` com `val=0` (`:r`, `0xf8317`–`0xf832d`) e `val=1`
  (`:w`, `0xf8344`–`0xf835b`).
- `open`: `sem_open(name, 0, 0777, val)` com `val=0/1` **e `sem_unlink` imediato logo após cada
  `open`** (`0xf8592`, `0xf85d1`) — semântica “*unlink-after-open*”, igual ao shm.
- `destroy`: `sem_unlink` ×2 (`0xf8451`, `0xf846d`).
- Semântica: `wait_write_signal()` = `sem_wait([this+0x8])` (`0xf72d8`);
  `wait_read_signal(long)`: se `timeout == 0` → `sem_wait([this+0x0])` (`0xe0471`), senão
  `clock_gettime` + `sem_timedwait`. `write_bytes`/`read_bytes` **giram até 1000 vezes**
  (comparação com o limite `0x3e7` + pausa de CPU/*spin-wait*) antes de recorrer ao semáforo; o parâmetro `int` de
  `read_message`/`read_bytes` é o **nº de spins** (o helper usa `0x3e8` = 1000, `0x176527`) e o
  `long` é o **timeout** de `wait_read_signal` (0 = bloqueante) [OBSERVADO].

---

## 5. 🧩 `shm_bundle` e os slots de canal

**[OBSERVADO] F12 — `shm_bundle::config(n)` aloca `n` elementos de `0x78` (120) bytes.**
multiplicação do índice pelo stride `0x78` em `0x173db6` (com guarda de *overflow* pela constante `0x222222222222223`); por
elemento: **sentinela `-1` em `+0x0`**, `pthread_mutex` embutido em `+0x48`, `+0x70` zerado
(`0x173dd9`–`0x173e0c`). `init(i)` grava `i` em `element+0x0` (`0x173ed9`); `fetch(i)` =
`base + i*0x78` (`0x173ede`); `size()` = `(end−begin)/0x78` (`0x173eb2`). Global `g_shm_bundles`
@`0x214890`.

**[OBSERVADO] F13 — `main` usa exatamente 1 bundle e guarda 3 ponteiros de canal.**
`shm_bundle::config` chamado com `rdi=1` em `0x1a2de4`; `bundle[0]+0x0 = 0` (`0x1a2df0`). Os 3 canais
são **abertos** e gravados em:

| Slot no bundle | Canal | Literal do template (3.14) |
|---|---|---|
| `+0x08` | **`subl_recv`** | `0x78b1f` |
| `+0x10` | **`subl_send`** | `0x7b132` |
| `+0x18` | **`subl_arecv`** | `0x751fb` |

**[OBSERVADO] F14 — Seleção de canal por papel de thread.**
`send_channel(bundle)` = `[bundle + (is_main_thread ? 0x0 : 0x10) + 0x8]` → **`bundle+0x8` (main)** ou
**`bundle+0x18` (não-main)** (`0x175dd1`–`0x175de6`). No helper request/response:
`write_message([bundle+0x8] …)` em `0x1761c1` e `read_message([bundle+0x10] …)` em `0x176520`. I.e. o
host **escreve a requisição** em `bundle+0x8`/`+0x18` (`subl_recv`/`subl_arecv`) e **lê a resposta**
de `bundle+0x10` (`subl_send`).

**[INFERIDO] F15 — Direção dos canais (nomes relativos ao NÚCLEO) — confiança média.**
Núcleo→host chega por **`subl_send`** (o host lê de `+0x10`); host→núcleo sai por **`subl_recv`**
(síncrono, `+0x8`) ou **`subl_arecv`** (assíncrono, `+0x18`). Evidência: padrão request/response
(F14) + os offsets gravados em `main` (F13). ⚠️ Isto **contradiz** a tabela de
[`ipc-plugin-host.md`](ipc-plugin-host.md) §1 (que inferia host→núcleo por `subl_send`) — ver a nota
de revisão em §1/§9 daquele doc. `[OBSERVADO]` os **nomes** (`subl_send`/`subl_recv`/`subl_arecv`) e
os **offsets**; `[INFERIDO]` o **sentido** que se lê de cada nome.

---

## 6. 🔢 Dispatch por opcode — dois enums

### 6.1 Mecanismo de `handle_protocol_message(unsigned long, string_buffer const&)`

`handle_protocol_message` @`0x17677e` (3.14).

- **[OBSERVADO] O 1º parâmetro NÃO é o opcode.** Ele guarda `rdi` e depois usa
  multiplicação do índice pelo stride `0x78` + `g_shm_bundles` @`0x214890`, indexando `[bundle+0x00]`/`[bundle+0x08]` (site
  `0x17691a`–`0x176934`, `g_shm_bundles[idx].send->write_message(...)`). Ou seja: **`rdi` = índice do
  bundle** (para escolher o canal de resposta). O *caller* `main` @`0x1a2faa` passa como 1º argumento o
  índice guardado no 1º campo do bundle.
- **[OBSERVADO] O opcode é o 1º `uint32` do payload.** O handler lê tamanho (`+0x00`) e ponteiro
  (`+0x10`) do `string_buffer`, compara o tamanho com 4 e **descarta payload < 4 B** (desvio se menor)
  e lê o 1º dword do payload → **opcode = `uint32` LE nos 4 primeiros bytes**.
- **[OBSERVADO] Ids 1-based.** Logo depois: decremento do id e comparação com `0x46` + salto se acima → **`1..0x47` =
  `1..71`** (enum **V**).
- **[OBSERVADO] Estrutura de salto: tabela de saltos DENSA** — `.rodata` @`0x81e28`, **4 bytes por
  entrada** (offset relativo `int32` somado à base da tabela), indexada por `id−1`; **71 entradas**,
  todos os alvos **dentro** de `handle_protocol_message` (handlers *inlined*).
- **[OBSERVADO] Opcode fora de `1..71` e payload curto → desvio direto para o epílogo** (retorna sem
  fazer nada). **Não existe literal de “comando desconhecido”** no host (`grep` por
  `unknown|invalid|unrecognized command/opcode/message` → 0 hits relevantes) → **silêncio**.

`is_app_blocking_while_sending(unsigned int id)` @`0x1784f5` tem **outra** tabela de saltos
imediatamente após a principal: `.rodata` @`0x81f44`, `id−4 <= 0x43` → **68 entradas (ids `4..71`)**,
devolvendo `bool` por opcode. Propriedade **por opcode**, não por mensagem.

### 6.2 Enum **V** (núcleo→host) — 71 ids → handlers `plugin_*`

**[OBSERVADO]** primeira chamada de cada caso da tabela @`0x81e28` (demangled, `@@Base` omitido):

| id | handler | id | handler | id | handler |
|---|---|---|---|---|---|
| 1 | `plugin_shutdown` | 25 | `plugin_load_finished` | 49 | `plugin_object_input_description` |
| 2 | `plugin_exec_string` | 26 | `plugin_load_finished` | 50 | `plugin_object_run` |
| 3 | `plugin_load_finished`+`plugin_on_api_ready` | 27 | `plugin_on_modified` | 51 | `plugin_create_application_commands` |
| 4 | `plugin_on_api_ready` | 28 | `plugin_on_post_text_command` | 52 | `plugin_object_is_enabled` |
| 5 | `plugin_get_profiling_data` | 29,30 | `plugin_on_hover` | 53 | `plugin_object_dec_ref` |
| 6 | `plugin_exec_string` | 31 | `plugin_on_text_command` | 54 | `plugin_object_create_input_handler` |
| 7 | `plugin_on_text_command` | 32 | `plugin_exec_string` | 55 | `plugin_object_setup` |
| 8 | `plugin_exec_string` | 33 | `plugin_on_text_command` | 56 | `plugin_object_preview` |
| 9 | `plugin_on_text_command` | 34 | `plugin_object_input_description` | 57 | `plugin_object_validate` |
| 10 | `plugin_load_finished` | 35 | `plugin_on_post_text_command` | 58 | `plugin_object_cancel` |
| 11 | `plugin_on_text_command` | 36,37 | (deserialização) | 59 | `plugin_object_confirm` |
| 12 | `plugin_object_run` | 38 | (deserialização) | 60 | (deserialização) |
| 13 | `plugin_load_finished` | 39 | `plugin_on_hover` | 61 | `plugin_call_int_value` |
| 14 | `plugin_on_text_command` | 40 | (deserialização) | 62 | `plugin_exec_string` |
| 15 | `plugin_object_input_description` | 41 | `plugin_call_int_value` | 63 | `plugin_on_text_command` |
| 16 | `plugin_on_api_ready` | 42 | `plugin_exec_string` | 64 | `plugin_on_api_ready` |
| 17 | `plugin_call_bool` | 43 | `plugin_set_env` | 65 | (deserialização) |
| 18 | `plugin_exec_string` | 44 | `plugin_create_application_commands` | 66 | `plugin_call_int_value` |
| 19 | `plugin_on_text_command` | 45 | `plugin_object_input_description` | 67 | `plugin_call_string` |
| 20 | `plugin_object_cancel` | 46 | `plugin_create_window_commands` | 68 | `plugin_call_bool` |
| 21 | `plugin_exec_string` | 47 | `plugin_object_dec_ref` | 69 | `plugin_call_int` |
| 22 | `plugin_on_text_command` | 48 | `plugin_call_int_value` | 70 | `plugin_call_int_value`/`plugin_call_value` |
| 23 | `plugin_reload_plugin` | | | 71 | `plugin_create_application_commands` |
| 24 | `plugin_on_hover`/`plugin_on_modified` | | | | |

> Muitos handlers são **compartilhados** entre ids (o mesmo `plugin_exec_string`/`plugin_on_text_command`
> cobre vários opcodes) — coerente com a **deserialização** do payload no handler, que distingue o
> subcaso (ids marcados “(deserialização)”) [OBSERVADO].

### 6.3 O loop de mensagens de `main` e o *escape* `data[0] == 0`

`main` @`0x1a2d0b`; após `init_python`/`api_plugin_host_ready()` [OBSERVADO]:

1. Enquanto a flag `g_alive` @`0x20fc28` estiver ativa: `read_message(bundle->chan[+0x10], &sb, 10, 0)` — o `int` é o nº de
   *spins* e o `long 0` é o timeout de `wait_read_signal` (bloqueante) (§4). **Nota:** ler do canal
   `+0x10` = `subl_send` é o que sustenta a revisão de direção (F15).
2. Se `sb.size >= 4`:
   - **`uint32 data[0] != 0`** → `handle_protocol_message([bundle+0], sb)` (enum **V**).
   - **`uint32 data[0] == 0`** → handler @`0x1766e6`(`bundle`, `data[4]`): **entrega de resposta
     assíncrona**. Trava o mutex `[bundle+0x48]`, varre o vetor de requisições pendentes
     `[bundle+0x30]..[bundle+0x38]`, casa `req->id == data[4]`, copia o corpo da resposta para
     `req+0x10`, marca `[req+0x228]=1` e **remove a entrada do vetor**.

> **Leitura:** o “opcode” e o “id de correlação” **compartilham o mesmo campo**; `0` é o ***escape***
> que redireciona para o motor de requisições pendentes (modelo requisição/resposta **assíncrono**
> convivendo com o caminho **síncrono** usado por várias `api_*`). Rótulo: [OBSERVADO] para o
> mecanismo; `[DESCONHECIDO]` quais ids usam cada modo e como o `req_id` é gerado (§7.4).

### 6.4 Enum **U** (host→núcleo) — 281 ids → `api_*`

**Reconstrução (dois métodos independentes, concordantes 1:1):**

1. Para cada símbolo `api_<nome>()` (não-`_helper`), o **imediato**
   imediato de 32 bits gravado no 1º campo da mensagem (ou transferido por pilha no caminho de envio),
   inicializando o **1º campo da mensagem** → id.
2. A **ordem das 281 primeiras entradas** da `PyMethodDef[]` do módulo `sublime_api` → id.

**Resultado:** 281 nomes ↔ 281 ids, **sem lacunas, bijeção `1..281`** [OBSERVADO], confiança **alta**
(duas vias independentes + conferência com a tabela do núcleo, §6.6). A **tabela completa** está no
**Anexo A**. Exemplos: `1 = api_plugin_host_ready` · `3 = api_log_message` ·
`14 = api_run_command` · `108 = api_view_text_point_utf8` · `129 = api_view_erase` ·
`199 = api_buffers` · `217 = api_windows` · `281 = api_window_automate_ui`.

**[OBSERVADO] Os ids estão agrupados por domínio** (dialogs `6..13`, `run_command` `14`,
view/buffer/window em faixas próprias) → a numeração foi **gerada**, não é hash.

**[OBSERVADO] Ordem de endereço × id NÃO é monotônica:** a ordem dos literais em `.rodata`
(`0x7520b..0x7da01`) produz **19 359 inversões** frente à ordem de id → **não dá para derivar o enum
pela ordem das strings**; a ordem autoritativa é (a) os imediatos no código e (b) a ordem de `M`.

### 6.5 Tabelas: onde vivem, quantas entradas, largura

| Tabela | Binário | Seção / vaddr | Entradas | Largura | Conteúdo |
|---|---|---|---|---|---|
| **U** *dispatch* host→core | `sublime_text` | `.rodata` @**`0x104a70`** | **281** | 4 B (`int32` relativo) | alvos em `.text` (`0x54da16..0x55727f`), todos distintos |
| **V** *dispatch* core→host | `plugin_host-3.14` | `.rodata` @**`0x81e28`** | **71** | 4 B | handlers `plugin_*` *inlined* |
| **V′** *blocking-by-opcode* | `plugin_host-3.14` | `.rodata` @**`0x81f44`** | **68** (ids `4..71`) | 4 B | `bool` por opcode |
| **M** `PyMethodDef[]` de `sublime_api` | `plugin_host-3.14` | `.data.rel.ro` @**`0x20fc50`** | **294** | **32 B** | `{name_ptr, fn_ptr, flags(u32), pad, doc=0}` |
| **M′** idem 3.3 | `plugin_host-3.3` | `.data.rel.ro` @**`0x636700`** | **293** | 32 B | idem |
| `PyModuleDef` de `sublime_api` | `plugin_host-3.14` | `.data.rel.ro` @**`0x212130`** | — | — | `m_name` @`0x212158` → literal **`sublime_api`**; `m_methods` @`0x212170` = `0x20fc50` |

**[OBSERVADO]** `init_sublime_api` @`0x1a0a29` percorre `M` (294 itens, iterador de `8` a `0x24c8`,
passo `0x20`) e **patcheia o campo `fn` (+8)** de **6** entradas cujo `name` casa por `strcmp` com os
literais `view_insert`, `view_erase`, `view_replace`, `view_run_command`, `window_run_command`,
`run_command` → substitui por 6 *thunks* em `.text` (`0x1a0b6a`/`0x1a0b76`/`0x1a0b82`/`0x1a0b8e`/
`0x1a0b9a`/`0x1a0ba6`). **[INFERIDO]** tratamento especial de **reentrância / main-thread blocking**
para os comandos **mutantes de edit**.

**[OBSERVADO]** **A ordem de `M` é o enum U:** entrada `i` (0-based) ⇔ id `i+1` para `i=0..280`
(ids extraídos do código, na ordem da tabela, dão exatamente `[1,2,…,281]`).

**[OBSERVADO]** As entradas **281..293 de `M` não têm contraparte `api_*`** (sem id, sem comando de
protocolo) — são funções **locais** expostas ao Python: `version, platform, architecture, channel,
executable_path, packages_path, installed_packages_path, cache_path, lib_path, encode_value,
decode_value, view_cached_substr, set_timeout_async` (**13** no 3.14; **12** no 3.3: falta
`lib_path`).

#### 6.5.1 Nuance das strings `api_*` (importante para não errar o “nome”)

- **[OBSERVADO]** Os 281 literais `api_<nome>` existem em `.rodata` (seção **`AMS`** =
  ALLOC|MERGE|STRINGS), mas **nenhuma relocação e nenhuma referência de código aponta para o *início*
  deles** (0 hits em `R_X86_64_RELATIVE`; 0 referências RIP-relativas no código).
- **[OBSERVADO]** Os `name_ptr` de `M` apontam para **`<literal api_>+4`**, i.e. o nome **sem** o
  prefixo `api_` (ex.: `0x766c0` = `api_plugin_host_ready` ↔ ponteiro `0x766c4` =
  `plugin_host_ready`).
- **[INFERIDO]** *suffix-sharing* do linker (`SHF_STRINGS`): o literal mais longo é a âncora de merge
  e o mais curto aponta para dentro dele. `[DESCONHECIDO]` por que a referência ao literal longo não
  sobrevive (âncora órfã de seção/COMDAT descartada). **Isso não afeta o enum** — os ids vêm do
  código (§6.1) e a ordem, de `M`.

### 6.6 Payload: serialização binária tipada

- **[OBSERVADO]** Serialização **binária tipada**, não texto delimitado: `[uint32 opcode][campos…]`,
  escritos/lidos por `binary_output_stream`/`binary_input_stream` (`_ZlsR20binary_output_streamRKj`
  para `uint32`, `_Zls…RKi` para `int`, `_Zls…RKb` para `bool`, `_Zls…RK5value` para `value`,
  `_Zls…RKNSt3__112basic_string…` para string; e o lado leitor `_ZrsR19binary_input_stream…`).
  Também existem sobrecargas para `object_id`, `SelectionRegion`, `optional<string>`.
- **[OBSERVADO]** `find_arg_value(int, char**, substring)` @`0x1a358f` **NÃO** é usado no caminho de
  protocolo (0 chamadas a `find_arg_value` no host e no núcleo). **[INFERIDO]** é utilitário de `argv` de
  CLI (contrato `int argc, char** argv`).
- **[OBSERVADO]** **Não há literal de “comando desconhecido” nem de erro de protocolo** em nenhum dos
  dois lados; opcode inválido/payload curto = **silêncio** (retorno imediato). O núcleo tem
  `"Unknown command "` e `"ERROR: invalid command line"`, mas são da camada de **CLI/paleta**, não do
  canal shm.

### 6.7 3.14 vs 3.3 vs núcleo

| | `plugin_host-3.14` | `plugin_host-3.3` | `sublime_text` |
|---|---|---|---|
| Enum **V** (core→host) | 71 ids, tabela `0x81e28` | **idêntico** (mesma forma: decremento + comparação com `0x46` + salto se acima; tabela `0x4f652c+`) | — (só *envia*) |
| Enum **U** (host→core) | 281 ids (`1..281`) | **idênticos 1:1** (281/281 nomes com o mesmo id) | **281 ids**, tabela `0x104a70` (decremento + comparação com `0x118` + salto se acima) |
| `PyMethodDef[]` `sublime_api` | 294 (281 protocolo + 13 locais) | 293 (281 + 12; **sem `lib_path`**) | — |
| strings `api_*` | **281** | **282** | 1 (`api_completions_only`, alheio) |

- **[OBSERVADO]** O **dispatcher do núcleo** `sublime_text` @`0x54d999` é o **gêmeo** do lado core:
  mesmo layout de `string_buffer` (acesso a `[+0x0]`/`[+0x10]`), mesma comparação do comprimento com 4,
  lê o 1º `uint32` (`data[0]`), decremento, comparação com `0x118` e salto se acima →
  **tabela de 281 entradas @`0x104a70`** (referência à tabela @`0x54d9ea`).
  Tem **10 sítios de chamada** (`0x54da16..0x55727f` como alvos da tabela; os *chamadores* incluem o loop
  principal e a thread leitora assíncrona). O desvio do salto cai no epílogo (**silêncio**).
  > ⚠️ **Correção (verificação independente, P1.3).** Uma primeira leitura atribuiu este dispatcher a
  > `0x487aa0`; **errado** — `0x487aa0` é `aligned_alloc`. Os dois sítios antes citados
  > (`0x4bc220`, `0x91e1b6`) são *callers* de `aligned_alloc`, não do dispatcher. Endereço correto:
  > `0x54d999` (tabela `0x104a70`, comparação com o bound `0x118` @`0x54d9db`). A conclusão arquitetural
  > (dispatch numérico denso, 281 casos, sem nomes no núcleo) **não muda**.
- **[OBSERVADO]** O núcleo **não tem tabela de nomes** `api_*` — despacha **só por número**. Os nomes
  existem apenas no host (e, na prática, órfãos — §6.5.1).
- **[OBSERVADO] O “comando extra” de 3.3 é `api_version`, e NÃO é comando de protocolo:** não tem id
  (todos os 281 ids de 3.3 batem com 3.14 e o máximo é 281), não está na `PyMethodDef[]` (`M′` traz o
  item `version`, apontando para um literal avulso) e não tem relocação apontando para ele.
  **[INFERIDO]** literal morto. Na prática: **3.3 e 3.14 falam o MESMO protocolo (U=281, V=71)**; a
  diferença é de *surface* Python (`lib_path` a mais no 3.14).
- **[INFERIDO]** O ***contrato observável*** é: o host envia `uint32 id ∈ [1,281]`; o núcleo responde
  `[uint32 0][uint32 req_id][corpo]` (assíncrono) **ou** `opcode ∈ [1,71]` (enum V); e núcleo→host
  usa ids `∈ [1,71]`.

---

## 7. ⚠️ Limites e incógnitas remanescentes

Dois relatórios independentes (framing e opcodes) deixaram **3 incógnitas cada** — todas registradas
abaixo **sem** promoção de confiança.

**Do framing:**

1. `[DESCONHECIDO]` **Bytes de padding do header do anel** (`0x8..0x40`, `0x48..0x80`): não
   referenciados por `write_bytes`/`read_bytes`; podem carregar versão/flags futuras ou ser só
   alinhamento de cache line.
2. `[DESCONHECIDO]` **Semântica exata dos dois tipos de canal do bundle:** por que o helper
   request/response **lê** de `subl_send` e **escreve** em `subl_recv`, e **quando** `subl_arecv`
   (`+0x18`) é usado por threads não-main (o fluxo assíncrono não foi seguido até o consumidor).
3. `[DESCONHECIDO]` **`shm_channel+0x50` vs `+0x51`:** `+0x50` (=1 em *create*) parece “fui eu que
   criei”, mas seu uso (além de *set*) não foi localizado; e falta a relação com o bit em `.data`
   (`0x20fc30`) de [`ipc-plugin-host.md`](ipc-plugin-host.md) §8.10.

**Do dispatch/opcodes:**

4. **Contrato de resposta síncrona vs assíncrona.** Várias `api_*` fazem `read_message` +
   `handle_protocol_message` elas mesmas (ex.: `api_view_size` + `0x1d6`); outras dependem do loop de
   `main` + o motor de pendências @`0x1766e6`. Não foi mapeado **quais** ids usam cada modo nem como
   o `req_id` de correlação é gerado/atribuído. `[DESCONHECIDO]`
5. **Semântica de `is_app_blocking_while_sending`.** A tabela `0x81f44` (68 entradas) existe, mas
   falta listar **quais** ids retornam `true` e por quê (o critério arquitetural). `[DESCONHECIDO]`
6. **`data[0] == 0`.** Além de resposta assíncrona, pode ser um *namespace* de controle (ex.:
   `api_channel`). Não foi confirmado se há outros subcódigos além do `req_id`. `[DESCONHECIDO]`

> **Limite de método herdado:** `plugin_host-3.14` tem `.dynsym` (nomes de função C++), mas o
> **núcleo é stripped** — todo o lado `sublime_text` deste doc está caracterizado por
> **endereço + literais de bytes + tabelas**, sem nomes de símbolo (mesma cautela de um degrau de
> confiança abaixo, já registrada em [`ipc-plugin-host.md`](ipc-plugin-host.md) §8.9).

---

## 8. 🧮 LEDGER de evidências

Consolidação dos ledgers dos dois relatórios: **framing `E1–E21`** (mantidos com a numeração
original) + **opcodes `B1–B15`** (renumerados para **`E22–E36`**). Nenhum item foi perdido.

| # | Conclusão | Evidência (endereço/ref) | Tipo | Confiança |
|---|---|---|---|---|
| E1 | Prefixo de comprimento = 4 bytes, `uint32` LE nativo | store de 4 bytes do comprimento (truncado a 32 bits) `0xe012b` (write); leitura dword em `0xe02d2` (read) | disassembly | **alta** |
| E2 | `write_message` = 2 escritas (header 4 B + corpo), mutex lock/unlock em volta | `write_bytes` em `0xe0144` e `0xe0152`; lock `0xe0136`; unlock `0xe015a` | disassembly | **alta** |
| E3 | `read_message` = 2 leituras (header 4 B → resize → corpo) | `read_bytes` em `0xe02c9` e `0xe02f1`; `resize` `0xd7a2c` via `0xe02dd` | disassembly | **alta** |
| E4 | Ordem write = lock→header→corpo→unlock→sem_post(reader) | `0xe0136`→`0xe0144`→`0xe0152`→`0xe015a`→`0xe0162` | disassembly | **alta** |
| E5 | Sem campos além do comprimento no framing; opcode = 1º dword do payload | send serializa `unsigned` antes (`0x175e43`); comparação do 1º dword do payload com 0 (`0x176551`) | disassembly | **alta** |
| E6 | `string_buffer` = `{len@0x0, cap@0x8, data@0x10, SSO@0x18}` | `resize` `0xd7a2c`; `reserve_exact` `0xe5e3e`/`0xe5e60`; `copy_to` `0xd7a74` | disassembly | **alta** |
| E7 | Comprimento **não** inclui NUL; sem terminador garantido; corpo p/ heap só se > SSO | `malloc(len)` sem `+1` (`0xe5e60`); `memmove(len)` (`0xd7af5`) | disassembly | **alta** |
| E8 | shm = `0x80000` (512 KiB), literal | constante `0x80000` como 2º argumento `0xf82ae` (create), `0xf8532` (open) | disassembly | **alta** |
| E9 | Anel: header `0x80` (write@`0x0`, read@`0x40`), dados@`0x80`; cap = `0x7ff80` constante | índices em `[+0x0]`, `[+0x40]`, dados em `[+0x80]`; divisão pelo divisor `0x7ff80` | disassembly | **alta** |
| E10 | Capacidade útil = `0x7ff7f` (cap−1, 1 byte reservado) | soma da constante `0x7ff7f` `0xe01c9` | disassembly | **alta** |
| E11 | `shm_channel` = `0x58`; sem0@0, sem1@8, mutex@`0x10`, ring@`0x38`, base@`0x40`, size@`0x48`, creator@`0x50`, poison@`0x51` | ctor `0xf84fc`, dtor `0xf84a4`, create `0xf82e0`–`0xf82fc`, mark-dead `0xfa3f0` | disassembly | **alta** |
| E12 | Nomes de semáforo = `<canal>:r` (val 0) e `<canal>:w` (val 1) | literais `0x7aafe`/`0x7a26f`; `sem_open` `0xf8317`/`0xf8344` | disassembly + bytes | **alta** |
| E13 | `open` faz `sem_unlink` imediato após cada `sem_open` (*unlink-after-open*) | `sem_unlink` em `0xf8592` e `0xf85d1` | disassembly | **alta** |
| E14 | Semáforos **nomeados** (nunca `sem_init` anônimo no shm) | `sem_open` ×2 create/open; shm contém só o anel | disassembly + imports | **alta** |
| E15 | `shm_bundle` = N elementos de `0x78`; sentinela `-1`; mutex@`0x48` | multiplicação pelo stride `0x78` `0x173db6`; escrita da sentinela `-1` `0x173def` | disassembly | **alta** |
| E16 | `main` usa 1 bundle; canais em `+0x8` recv, `+0x10` send, `+0x18` arecv | `config(1)` `0x1a2de4`; stores `0x1a2e68`/`0x1a2e96`; literais `0x78b1f`/`0x7b132`/`0x751fb` | disassembly | **alta** |
| E17 | Seleção de canal por thread: main→`+0x8`, non-main→`+0x18` | `send_channel` `0x175dd1`–`0x175de6` | disassembly | **alta** |
| E18 | Host escreve requisição em `+0x8` e lê resposta de `+0x10` | `write_message` `0x1761c1`; `read_message` `0x176520` | disassembly | **média** |
| E19 | Direção: núcleo→host = `subl_send`; host→núcleo = `subl_recv`/`subl_arecv` (nomes core-relativos) | E16+E17+E18 | inferência | **média** |
| E20 | Framing/layout idênticos em 3.3 | `write_message` `0x2abd90`, `read_message` `0x2abf2a`, create `0x2c3f13` | disassembly | **alta** |
| E21 | Nomes de semáforo presentes também no núcleo | `%s:r` `0xeae6b`, `%s:w` `0xe8cf2` em `sublime_text` | bytes | **alta** |
| E22 | Opcode = `uint32` LE nos 4 primeiros bytes do payload; `unsigned long` = índice de bundle | `handle_protocol_message` lê o 1º `uint32` do payload, decrementa e compara com `0x46`; multiplica pelo stride `0x78` + `g_shm_bundles`; `main` passa o 1º campo do bundle | disassembly | **alta** |
| E23 | Dispatch por **tabela de saltos densa**, não por texto | `.rodata 0x81e28`, 71×4 B, índice estendido + soma da base + salto indireto; 0 comparações de string | disassembly | **alta** |
| E24 | Opcode inválido/curto = **silêncio** (sem literal de erro) | desvios diretos p/ epílogo `0x177df3`/`0x177e97`/`0x55e562`; grep de literais = 0 | disassembly + strings | **alta** |
| E25 | Enum V = 71 ids → handlers `plugin_*` | primeiras chamadas de cada caso da tabela `0x81e28` | disassembly | **alta** |
| E26 | Enum U = **281 ids (`1..281`)**, imediato `uint32` gravado no 1º campo em cada `api_*()` | 235+ sites de store de imediato (por pilha ou direto no campo); todos os 281 nomes casam | disassembly | **alta** |
| E27 | `PyMethodDef[]` `sublime_api` = 294×32 B @`.data.rel.ro 0x20fc50`; **ordem = ids 1..281** | relocs `R_X86_64_RELATIVE`; `init_sublime_api` @`0x1a0a29`; `PyModuleDef.m_name` = `sublime_api` | readelf + disassembly | **alta** |
| E28 | 13 métodos **locais** (sem protocolo) no fim da tabela | entradas 281..293 (3.14) | readelf | **alta** |
| E29 | Núcleo tem o **dispatcher gêmeo com 281 casos** @`0x54d999`, tabela `.rodata 0x104a70` | comparação com o bound `0x118` @`0x54d9db`; referência à tabela @`0x104a70` (`0x54d9ea`); 281 alvos em `.text` (`0x54da16..0x55727f`) | disassembly (reverificado) | **alta** |
| E30 | 3.3 tem o **mesmo** enum U (281 ids iguais) e o mesmo enum V (71) | extração id por id + tabela `M′`@`0x636700` com os mesmos 281 nomes na mesma ordem | disassembly + readelf | **alta** |
| E31 | O “extra” de 3.3 = string `api_version`, **não** comando | 3.3 `api_version()` retorna `"4215"` local; sem id; sem reloc; item `M′` = `version` | disassembly + readelf | **alta** |
| E32 | Payload = serialização binária tipada; `find_arg_value` fora do protocolo | `operator<<`/`>>` de `binary_(in\|out)put_stream` no dispatch; 0 chamadas a `find_arg_value` | disassembly | **alta** |
| E33 | Nomes `api_*` de `.rodata` apontam p/ `M` como `<literal>+4` (nome sem prefixo) | 281 relocs de `M` → `vaddr(api_X)+4`; 0 relocs nem referências RIP-relativas ao início | readelf + disassembly (seção `AMS`) | **alta** (o *porquê* = **média**) |
| E34 | Loop de `main` distingue `data[0]!=0` (enum V) de `data[0]==0` (resposta p/ requisição pendente) | `main`@`0x1a2f99..0x1a2fc7`; handler `0x1766e6` casa `req->id` e completa o vetor | disassembly | **alta** |
| E35 | Tabela auxiliar “blocking by opcode” (68 entradas, ids 4..71) | `is_app_blocking_while_sending` @`0x1784f5`, `.rodata 0x81f44` | disassembly | **alta** |
| E36 | 6 comandos têm `fn` remapeado no boot (`view_insert/erase/replace`, `view_run_command`, `window_run_command`, `run_command`) | `init_sublime_api` @`0x1a0a29` (`strcmp` + patch `+8`) | disassembly | **alta** |

---

## Anexo A — Enum **U** completo (281 ids → `api_*`)

Tabela gerada de `enum_3.14_full.tsv` (id, nome exposto, símbolo `api_*`, vaddr da string, entrada
em `M`, helper Python) — aqui só id, símbolo e vaddr. É **contrato observável** (nomes + ids
numéricos), não código do alvo. **Bijeção** verificada `1..281` (sem lacunas) e conferida contra a
tabela de ids extraída do código e contra a ordem de `M` (E26/E27).

| id | símbolo `api_*` | vaddr da string |
|---:|---|---|
| 1 | `api_plugin_host_ready` | `0x766c0` |
| 2 | `api_plugin_host_loaded_plugins` | `0x7b141` |
| 3 | `api_log_message` | `0x7562f` |
| 4 | `api_set_timeout` | `0x77043` |
| 5 | `api_status_message` | `0x7c7c7` |
| 6 | `api_error_message` | `0x78302` |
| 7 | `api_message_dialog` | `0x7a6b1` |
| 8 | `api_ok_cancel_dialog` | `0x7b4ee` |
| 9 | `api_yes_no_cancel_dialog` | `0x78b2e` |
| 10 | `api_open_dialog` | `0x7744a` |
| 11 | `api_save_dialog` | `0x7be58` |
| 12 | `api_select_folder_dialog` | `0x7520b` |
| 13 | `api_choose_font_dialog` | `0x7cc30` |
| 14 | `api_run_command` | `0x75224` |
| 15 | `api_can_accept_input` | `0x7d8b8` |
| 16 | `api_set_clipboard` | `0x7c34c` |
| 17 | `api_get_clipboard_async` | `0x766d6` |
| 18 | `api_get_clipboard` | `0x75cb9` |
| 19 | `api_log_commands` | `0x77966` |
| 20 | `api_log_input` | `0x7cc47` |
| 21 | `api_log_fps` | `0x79967` |
| 22 | `api_log_result_regex` | `0x7b160` |
| 23 | `api_log_indexing` | `0x7c7da` |
| 24 | `api_log_build_systems` | `0x7c7eb` |
| 25 | `api_log_control_tree` | `0x78faf` |
| 26 | `api_get_log_commands` | `0x76bea` |
| 27 | `api_get_log_input` | `0x79dfa` |
| 28 | `api_get_log_fps` | `0x7cc55` |
| 29 | `api_get_log_result_regex` | `0x7745a` |
| 30 | `api_get_log_indexing` | `0x7c801` |
| 31 | `api_get_log_build_systems` | `0x7ad8f` |
| 32 | `api_get_log_control_tree` | `0x7563f` |
| 33 | `api_ui_info` | `0x7c816` |
| 34 | `api_score_selector` | `0x78fc4` |
| 35 | `api_stat_resource_dir` | `0x7a1dc` |
| 36 | `api_stat_resource_file` | `0x7ada9` |
| 37 | `api_load_resource` | `0x7d8cd` |
| 38 | `api_load_binary_resource` | `0x78fd7` |
| 39 | `api_find_resources` | `0x7adc0` |
| 40 | `api_expand_variables` | `0x75234` |
| 41 | `api_get_macro` | `0x7cc65` |
| 42 | `api_folder_history` | `0x78ff0` |
| 43 | `api_project_history` | `0x7d8df` |
| 44 | `api_list_syntaxes` | `0x79e0c` |
| 45 | `api_get_syntax` | `0x7943e` |
| 46 | `api_find_syntax_for_file` | `0x75ccb` |
| 47 | `api_verify_pc_signature` | `0x7c35e` |
| 48 | `api_run_syntax_test` | `0x75979` |
| 49 | `api_profile_syntax_definition` | `0x79973` |
| 50 | `api_incompatible_syntax_patterns` | `0x77473` |
| 51 | `api_gather_plugin_profiling_data` | `0x766ee` |
| 52 | `api_load_settings` | `0x7d3cd` |
| 53 | `api_save_settings` | `0x7d8f3` |
| 54 | `api_settings_get` | `0x7a98b` |
| 55 | `api_settings_get_default` | `0x7be68` |
| 56 | `api_settings_has` | `0x7a99c` |
| 57 | `api_settings_set` | `0x7a6c4` |
| 58 | `api_settings_erase` | `0x78314` |
| 59 | `api_settings_add_on_change` | `0x75249` |
| 60 | `api_settings_clear_on_change` | `0x76bff` |
| 61 | `api_settings_to_dict` | `0x7d905` |
| 62 | `api_view_buffer_id` | `0x7d91a` |
| 63 | `api_view_sheet_id` | `0x79991` |
| 64 | `api_view_element` | `0x7d3df` |
| 65 | `api_view_is_primary` | `0x7a9ad` |
| 66 | `api_view_file_name` | `0x75658` |
| 67 | `api_view_retarget` | `0x7add3` |
| 68 | `api_view_get_name` | `0x79003` |
| 69 | `api_view_set_name` | `0x7670f` |
| 70 | `api_view_reset_reference_document` | `0x7d3f0` |
| 71 | `api_view_set_reference_document` | `0x7c376` |
| 72 | `api_view_is_loading` | `0x7d412` |
| 73 | `api_view_is_dirty` | `0x7ade5` |
| 74 | `api_view_is_read_only` | `0x77494` |
| 75 | `api_view_set_read_only` | `0x7944d` |
| 76 | `api_view_is_scratch` | `0x761ef` |
| 77 | `api_view_set_scratch` | `0x76203` |
| 78 | `api_view_encoding` | `0x75ce4` |
| 79 | `api_view_set_encoding` | `0x7d92d` |
| 80 | `api_view_line_endings` | `0x78b47` |
| 81 | `api_view_set_line_endings` | `0x7c822` |
| 82 | `api_view_size` | `0x76218` |
| 83 | `api_view_begin_edit` | `0x7598d` |
| 84 | `api_view_end_edit` | `0x7be81` |
| 85 | `api_view_is_in_edit` | `0x799a3` |
| 86 | `api_view_substr` | `0x786ab` |
| 87 | `api_view_classify` | `0x774aa` |
| 88 | `api_view_find_by_class` | `0x7c83c` |
| 89 | `api_view_expand_by_class` | `0x77d2c` |
| 90 | `api_view_run_command` | `0x75264` |
| 91 | `api_view_can_accept_input` | `0x7566b` |
| 92 | `api_view_meta_info` | `0x78b5d` |
| 93 | `api_view_extract_tokens_with_scopes` | `0x774bc` |
| 94 | `api_view_extract_scope` | `0x75cf6` |
| 95 | `api_view_expand_to_scope` | `0x7a6d5` |
| 96 | `api_view_scope_name` | `0x75d0d` |
| 97 | `api_view_context_backtrace` | `0x799b7` |
| 98 | `api_view_match_selector` | `0x79e1e` |
| 99 | `api_view_score_selector` | `0x79e36` |
| 100 | `api_view_find_by_selector` | `0x7be93` |
| 101 | `api_view_style_for_scope` | `0x78b70` |
| 102 | `api_view_style` | `0x7ba46` |
| 103 | `api_view_row_col` | `0x7adf7` |
| 104 | `api_view_row_col_utf16` | `0x79e4e` |
| 105 | `api_view_row_col_utf8` | `0x75279` |
| 106 | `api_view_text_point` | `0x7c396` |
| 107 | `api_view_text_point_utf16` | `0x7b175` |
| 108 | `api_view_text_point_utf8` | `0x75685` |
| 109 | `api_view_code_units_at` | `0x7d943` |
| 110 | `api_view_total_code_units` | `0x786bb` |
| 111 | `api_view_selection_size` | `0x7528f` |
| 112 | `api_view_lines` | `0x79e65` |
| 113 | `api_view_split_by_newlines` | `0x7d426` |
| 114 | `api_view_line_from_point` | `0x7569e` |
| 115 | `api_view_line_from_region` | `0x76721` |
| 116 | `api_view_full_line_from_point` | `0x75d21` |
| 117 | `api_view_full_line_from_region` | `0x7b18f` |
| 118 | `api_view_word_from_point` | `0x79015` |
| 119 | `api_view_word_from_region` | `0x7a6ee` |
| 120 | `api_view_visible_region` | `0x7a1f2` |
| 121 | `api_view_indented_region` | `0x752a7` |
| 122 | `api_view_indentation_level` | `0x7a9c1` |
| 123 | `api_view_has_non_empty_selection_region` | `0x752c0` |
| 124 | `api_view_show_point` | `0x752e8` |
| 125 | `api_view_show_region` | `0x7a9dc` |
| 126 | `api_view_show_point_at_center` | `0x752fc` |
| 127 | `api_view_show_region_at_center` | `0x77053` |
| 128 | `api_view_insert` | `0x786d5` |
| 129 | `api_view_erase` | `0x76226` |
| 130 | `api_view_replace` | `0x799d2` |
| 131 | `api_view_change_count` | `0x76235` |
| 132 | `api_view_change_id` | `0x7a708` |
| 133 | `api_view_transform_region_from` | `0x7624b` |
| 134 | `api_view_window` | `0x7c853` |
| 135 | `api_view_clones` | `0x7b1ae` |
| 136 | `api_view_find` | `0x799e3` |
| 137 | `api_view_find_all` | `0x7d441` |
| 138 | `api_view_find_all_with_contents` | `0x7d95a` |
| 139 | `api_view_viewport_position` | `0x7d453` |
| 140 | `api_view_set_viewport_position` | `0x79464` |
| 141 | `api_view_viewport_extents` | `0x78b89` |
| 142 | `api_view_layout_extents` | `0x7d97a` |
| 143 | `api_view_text_to_layout` | `0x78ba3` |
| 144 | `api_view_layout_to_text` | `0x7a9f1` |
| 145 | `api_view_window_to_layout` | `0x7b503` |
| 146 | `api_view_layout_to_window` | `0x759a1` |
| 147 | `api_view_line_height` | `0x7a20a` |
| 148 | `api_view_em_width` | `0x78bbb` |
| 149 | `api_view_is_folded` | `0x77977` |
| 150 | `api_view_folded_regions` | `0x78327` |
| 151 | `api_view_fold_region` | `0x7d46e` |
| 152 | `api_view_fold_regions` | `0x7673b` |
| 153 | `api_view_unfold_region` | `0x7d992` |
| 154 | `api_view_unfold_regions` | `0x7ae08` |
| 155 | `api_view_add_regions` | `0x7ba55` |
| 156 | `api_view_get_regions` | `0x7798a` |
| 157 | `api_view_erase_regions` | `0x7cc73` |
| 158 | `api_view_add_phantom` | `0x759bb` |
| 159 | `api_view_erase_phantoms` | `0x79e74` |
| 160 | `api_view_erase_phantom` | `0x7d483` |
| 161 | `api_view_query_phantoms` | `0x756b7` |
| 162 | `api_view_assign_syntax` | `0x7a71b` |
| 163 | `api_view_syntax` | `0x7bead` |
| 164 | `api_view_symbol_regions` | `0x77d45` |
| 165 | `api_view_indexed_symbol_regions` | `0x7c3aa` |
| 166 | `api_view_symbols` | `0x77072` |
| 167 | `api_view_indexed_symbols` | `0x786e5` |
| 168 | `api_view_indexed_references` | `0x7b51d` |
| 169 | `api_view_set_status` | `0x76c1c` |
| 170 | `api_view_get_status` | `0x77083` |
| 171 | `api_view_erase_status` | `0x786fe` |
| 172 | `api_view_extract_completions` | `0x7799f` |
| 173 | `api_view_find_all_results` | `0x7d49a` |
| 174 | `api_view_find_all_results_with_text` | `0x7bebd` |
| 175 | `api_view_command_history` | `0x7b539` |
| 176 | `api_view_selection_clear` | `0x79483` |
| 177 | `api_view_selection_add_region` | `0x78bcd` |
| 178 | `api_view_selection_add_point` | `0x7c3ca` |
| 179 | `api_view_selection_subtract_region` | `0x7b552` |
| 180 | `api_view_selection_contains` | `0x7902e` |
| 181 | `api_view_selection_get` | `0x799f1` |
| 182 | `api_view_selection_erase` | `0x7904a` |
| 183 | `api_view_selection_has_empty_region` | `0x7833f` |
| 184 | `api_view_selection_has_non_empty_region` | `0x7d9a9` |
| 185 | `api_view_selection_has_multiple_non_empty_regions` | `0x76c30` |
| 186 | `api_view_settings` | `0x7cc8a` |
| 187 | `api_view_get_overwrite_status` | `0x7b1be` |
| 188 | `api_view_set_overwrite_status` | `0x7626a` |
| 189 | `api_view_show_popup_table` | `0x78beb` |
| 190 | `api_view_show_popup` | `0x7a732` |
| 191 | `api_view_update_popup_content` | `0x7c863` |
| 192 | `api_view_is_popup_visible` | `0x7d4b4` |
| 193 | `api_view_hide_popup` | `0x7bee1` |
| 194 | `api_view_clear_undo_stack` | `0x76751` |
| 195 | `api_view_is_auto_complete_visible` | `0x7cf90` |
| 196 | `api_view_preserve_auto_complete_on_focus_lost` | `0x7676b` |
| 197 | `api_view_set_completions` | `0x756cf` |
| 198 | `api_view_export_to_html` | `0x7ae20` |
| 199 | `api_buffers` | `0x77d5d` |
| 200 | `api_buffer_views` | `0x79063` |
| 201 | `api_buffer_primary_view` | `0x78c05` |
| 202 | `api_buffer_file_name` | `0x7ae38` |
| 203 | `api_buffer_add_text_listener` | `0x7c881` |
| 204 | `api_buffer_clear_text_listener` | `0x7bef5` |
| 205 | `api_sheet_window` | `0x779bc` |
| 206 | `api_sheet_view` | `0x779cd` |
| 207 | `api_sheet_file_name` | `0x7949c` |
| 208 | `api_sheet_is_semi_transient` | `0x79e8c` |
| 209 | `api_sheet_is_transient` | `0x7bf14` |
| 210 | `api_sheet_is_selected` | `0x7c89e` |
| 211 | `api_sheet_group` | `0x76799` |
| 212 | `api_sheet_close` | `0x779dc` |
| 213 | `api_window_system_handle` | `0x767a9` |
| 214 | `api_window_active_sheet` | `0x78c1d` |
| 215 | `api_window_active_view` | `0x7d9d1` |
| 216 | `api_active_window` | `0x79074` |
| 217 | `api_windows` | `0x78714` |
| 218 | `api_window_run_command` | `0x7d4ce` |
| 219 | `api_window_can_accept_input` | `0x75d3f` |
| 220 | `api_window_new_html_sheet` | `0x79ea8` |
| 221 | `api_sheet_get_name` | `0x7ba6a` |
| 222 | `api_sheet_set_name` | `0x79086` |
| 223 | `api_html_sheet_set_contents` | `0x7aa09` |
| 224 | `api_window_new_file` | `0x7aa25` |
| 225 | `api_window_open_file` | `0x75d5b` |
| 226 | `api_window_find_open_file` | `0x794b0` |
| 227 | `api_window_close_file` | `0x759d0` |
| 228 | `api_window_file_history` | `0x79a08` |
| 229 | `api_window_num_groups` | `0x7cfb2` |
| 230 | `api_window_active_group` | `0x75d70` |
| 231 | `api_window_focus_group` | `0x79ec2` |
| 232 | `api_window_focus_sheet` | `0x7d4e5` |
| 233 | `api_window_focus_view` | `0x77097` |
| 234 | `api_window_select_sheets` | `0x7c3e7` |
| 235 | `api_window_bring_to_front` | `0x7ba7d` |
| 236 | `api_window_get_sheet_index` | `0x7b575` |
| 237 | `api_window_get_view_index` | `0x79ed9` |
| 238 | `api_window_set_sheet_index` | `0x78720` |
| 239 | `api_window_set_view_index` | `0x759e6` |
| 240 | `api_window_move_sheets_to_group` | `0x767c2` |
| 241 | `api_window_sheets` | `0x75d88` |
| 242 | `api_window_views` | `0x76288` |
| 243 | `api_window_active_sheet_in_group` | `0x76c62` |
| 244 | `api_window_active_view_in_group` | `0x76c83` |
| 245 | `api_window_sheets_in_group` | `0x7b590` |
| 246 | `api_window_views_in_group` | `0x794ca` |
| 247 | `api_window_num_sheets_in_group` | `0x794e4` |
| 248 | `api_window_num_views_in_group` | `0x7a746` |
| 249 | `api_window_transient_sheet_in_group` | `0x7873b` |
| 250 | `api_window_transient_view_in_group` | `0x7c400` |
| 251 | `api_window_promote_sheet` | `0x7d9e8` |
| 252 | `api_window_selected_sheets` | `0x7cfc8` |
| 253 | `api_window_selected_sheets_in_group` | `0x7531a` |
| 254 | `api_window_get_layout` | `0x7533e` |
| 255 | `api_window_set_layout` | `0x7b5ab` |
| 256 | `api_window_create_output_panel` | `0x7bf2b` |
| 257 | `api_window_find_output_panel` | `0x779ec` |
| 258 | `api_window_destroy_output_panel` | `0x774e0` |
| 259 | `api_window_active_panel` | `0x75d9a` |
| 260 | `api_window_panels` | `0x77d69` |
| 261 | `api_window_show_input_panel` | `0x75db2` |
| 262 | `api_window_show_quick_panel` | `0x75dce` |
| 263 | `api_window_is_ui_element_visible` | `0x77a09` |
| 264 | `api_window_set_ui_element_visible` | `0x79099` |
| 265 | `api_window_folders` | `0x78363` |
| 266 | `api_window_project_file_name` | `0x7cfe3` |
| 267 | `api_window_get_project_data` | `0x7ae4d` |
| 268 | `api_window_set_project_data` | `0x7bf4a` |
| 269 | `api_window_workspace_file_name` | `0x7b1dc` |
| 270 | `api_window_settings` | `0x756e8` |
| 271 | `api_window_template_settings` | `0x79ef3` |
| 272 | `api_window_symbol_locations` | `0x7bf66` |
| 273 | `api_window_lookup_symbol` | `0x7da01` |
| 274 | `api_window_lookup_references` | `0x770ad` |
| 275 | `api_window_lookup_symbol_in_open_files` | `0x7d4fc` |
| 276 | `api_window_lookup_references_in_open_files` | `0x7875f` |
| 277 | `api_window_extract_variables` | `0x75a00` |
| 278 | `api_window_status_message` | `0x79a20` |
| 279 | `api_window_is_dragging` | `0x7aa39` |
| 280 | `api_notify_application_commands` | `0x770ca` |
| 281 | `api_window_automate_ui` | `0x7d000` |

*Fim do Anexo A.*
