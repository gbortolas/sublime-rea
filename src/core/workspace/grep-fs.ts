/**
 * Scribe — o **port de leitura** do `grep` sobre o disco (`node:fs`).
 *
 * ⚠️ **Só o worker importa este arquivo.** O `grep` roda **no worker** (task `grep` da lane
 * `grep` do `TaskPool`): a leitura dos arquivos acontece **lá** ⇒ o processo principal nunca
 * materializa o conteúdo de um arquivo de 2 GB, e a varredura (CPU-bound) não bloqueia a
 * janela/IPC/LSP.
 *
 * ⚠️ **Contrato do port (o mesmo do core — `GrepReadFile`):** o port recebe o **teto** do
 * arquivo (`maxLength`, em code units do texto decodificado) e **precisa respeitá-lo** — o
 * `stat` vem **antes** da leitura ⇒ um arquivo grande demais é **recusado** (erro com o código
 * `search.tooLarge`) **sem nunca ser materializado**. Sem isto, o worker leria o arquivo
 * **inteiro** e só depois o core o descartaria.
 *
 * ⚠️ O `size` do `stat` é em **bytes** e o teto é em **code units** do texto decodificado: um
 * arquivo multibyte (acentos) pode ser recusado antes de o texto decodificado caber no teto —
 * é o lado **conservador** (nunca lemos mais do que o teto).
 */
import { readFile, stat } from "node:fs/promises";

import { SearchInputError } from "../../shared";
import { GREP_FILE_TOO_LARGE } from "./grep";
import type { GrepReadFile } from "./grep";

/**
 * Lê um arquivo de texto **respeitando o teto** (o port do `grepWorkspace`).
 *
 * O core trata o erro como "arquivo grande demais" (pula o arquivo e continua a busca) — o
 * `onError` traduz para o aviso que o usuário vê.
 */
export const nodeGrepReadFile: GrepReadFile = async (
  path: string,
  maxLength: number,
): Promise<string> => {
  const stats = await stat(path);
  // ⚠️ **Só arquivo regular**: um **FIFO** leria em bloco (sem escritor ⇒ o worker fica
  // preso até o teto duro); um **device** (`/dev/zero`) leria infinito (OOM). O índice da
  // workspace inclui symlink-de-arquivo e tudo que não é diretório ⇒ o port tem de
  // recusar. O erro **não** é `search.tooLarge` (o core reescreveria a mensagem como
  // "excede o teto") ⇒ o arquivo é pulado como "ilegível".
  if (!stats.isFile()) {
    throw new Error(`"${path}" não é um arquivo regular (FIFO/device/diretório)`);
  }
  if (stats.size > maxLength) {
    throw new SearchInputError(
      GREP_FILE_TOO_LARGE,
      `o arquivo "${path}" excede o teto de ${maxLength} code units por arquivo`,
    );
  }
  return readFile(path, "utf8");
};
