/**
 * Scribe — contrato de fronteira da **busca na workspace** (o "grep").
 *
 * O Scribe tem **duas** buscas:
 * - o **find bar** busca **no documento aberto** (`src/shared/search-contract.ts` ⇒ task
 *   `search` na lane `index` do `TaskPool`);
 * - o **grep** busca **em vários arquivos** da workspace — é a task `grep`, que roda **no
 *   worker** (a varredura é CPU-bound e um padrão regex patológico **não pode** travar o
 *   processo principal — DEC-CON-1/6).
 *
 * ⚠️ **Fronteira única:** este arquivo é a **fonte da verdade** dos tipos do grep. O core
 * (`src/core/workspace/grep.ts`) e o contrato IPC (`src/shared/ipc-contract.ts`) **importam**
 * daqui — nenhum dos dois espelha. (Antes havia **dois espelhos** do mesmo tipo: o `tsc` não
 * acusa a divergência estrutural; ela só apareceria em runtime.)
 *
 * Unidades: `line`/`column` são **0-based**, em **code units UTF-16** (a unidade do buffer —
 * DEC-BUF-9). `path` é o **caminho absoluto** que o chamador passou (o núcleo é **agnóstico de
 * raízes**: quem resolve as raízes é o `main`).
 */

/** Uma ocorrência encontrada num arquivo da workspace. */
export interface GrepMatch {
  /** Caminho do arquivo (o mesmo string que o chamador passou em `files`). */
  readonly path: string;
  /** Linha da ocorrência — **0-based**. */
  readonly line: number;
  /** Coluna da ocorrência — **0-based**, em code units UTF-16. */
  readonly column: number;
  /** A **linha inteira** onde a ocorrência está (sem o terminador de linha). */
  readonly text: string;
}

/**
 * Resultado de uma varredura da workspace.
 *
 * ⚠️ É o **mesmo** tipo que o contrato IPC devolve (`search.files`): o renderer não conhece
 * o core, só este contrato.
 */
export interface GrepResult {
  /** Ocorrências ordenadas por `(path, line, column)`. */
  readonly matches: readonly GrepMatch[];
  /** `true` = o resultado está **incompleto** (bateu no teto de matches/arquivos ou no orçamento de tempo). */
  readonly truncated: boolean;
  /** Quantos arquivos foram **de fato varridos** (lidos e varridos — pulados não contam). */
  readonly filesScanned: number;
  /**
   * Os **avisos** da busca (o que foi desligado/ajustado — **nunca** um crash).
   *
   * Ex.: "a busca acento-insensitiva foi desligada no modo regex", "a busca foi interrompida
   * por tempo (20 s) — o resultado está incompleto".
   */
  readonly warnings?: readonly string[];
}

/**
 * Opções da task `grep` — **serializáveis** (cruzam o port do `TaskPool` por structured clone).
 *
 * São o **subconjunto** das opções do core (`GrepOptions`, em `src/core/workspace/grep.ts`):
 * tudo que é número/booleano. A I/O **não** entra aqui — no worker a leitura é feita pelo
 * próprio worker (port `node:fs`), com o teto respeitado.
 */
export interface GrepTaskOptions {
  /** Teto de ocorrências. */
  readonly maxMatches?: number;
  /**
   * Teto de tamanho por arquivo, em **code units UTF-16 do texto decodificado**.
   *
   * ⚠️ Em modo `regex` o teto efetivo é **menor** (64 KiB) — a regex do usuário pode ser cara.
   */
  readonly maxFileLength?: number;
  /** Teto de arquivos varridos. */
  readonly maxFiles?: number;
  /** Leituras em paralelo dentro do worker. */
  readonly concurrency?: number;
  /** Busca acento-insensitiva (default `true`): "acao" casa com "ação". */
  readonly ignoreAccents?: boolean;
  /** O padrão é uma **expressão regular** (default `false` ⇒ literal). */
  readonly regex?: boolean;
  /** A busca **diferencia maiúsculas** (default `false` ⇒ ignora o case). */
  readonly caseSensitive?: boolean;
  /** Inclui os arquivos **binários** na varredura (default `false` ⇒ são pulados). */
  readonly includeBinary?: boolean;
  /**
   * Orçamento de tempo da varredura (**soft**, em ms): a varredura para **entre arquivos** e
   * o resultado sai **incompleto** (`truncated: true`) com um aviso.
   */
  readonly budgetMs?: number;
}

/**
 * Payload da task `grep` — serializável (nada de closure cruza a fronteira — DEC-CON-4/11).
 *
 * ⚠️ `files` são **caminhos absolutos**; o worker lê cada um (respeitando o teto) e devolve
 * as ocorrências.
 */
export interface GrepTaskPayload {
  readonly kind: "grep";
  /** O padrão **cru** (o que o usuário digitou). */
  readonly query: string;
  /** Os arquivos candidatos (caminhos absolutos). */
  readonly files: readonly string[];
  /** As opções (todas opcionais — o worker aplica os defaults). */
  readonly options?: GrepTaskOptions;
}

/**
 * Orçamento de tempo da varredura (**soft**): a varredura para **entre arquivos** (nunca no
 * meio de um `RegExp` — o motor do JS não é interrompível) e o resultado sai **incompleto**
 * (`truncated: true`) com um aviso.
 *
 * Escolha nossa (o alvo não expõe o conceito): é a rede de segurança para uma workspace
 * gigante — sem ela, o grep pode varrer minutos sem devolver nada.
 */
export const GREP_DEFAULT_BUDGET_MS = 20_000;

/**
 * Teto **duro** da task `grep` (o `TaskPool` **mata** o worker que estourou).
 *
 * É o que impede que um padrão regex que escape do detector de padrões catastróficos trave o
 * app: o worker morre, a lane se recupera e a busca devolve um aviso de "interrompida".
 *
 * ⚠️ Precisa ser **maior** que {@link GREP_DEFAULT_BUDGET_MS}: o orçamento soft é o caminho
 * normal (devolve resultado parcial); o duro é o último recurso (o resultado parcial se perde).
 */
export const GREP_TASK_TIMEOUT_MS = 30_000;
