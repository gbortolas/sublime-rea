/**
 * Scribe — contrato de fronteira dos **snippets de pacote** (`.sublime-snippet`).
 *
 * Um pacote (`Packages/<Nome>/…`) pode trazer snippets no formato `.sublime-snippet`: um
 * **JSON** por arquivo, com `prefix` (o trigger), `body` (o texto) e `description` opcional.
 * O texto do pacote é **dado do usuário** (vem de um `.sublime-package` ou da pasta de
 * pacotes do usuário) ⇒ ele cruza a fronteira main → renderer como **string** (nunca como
 * objeto vivo) e é limitado em tamanho antes de cruzar (tetos abaixo).
 *
 * O *shape* é o mesmo para todas as camadas: o `main` lê o pacote (`PackageResolver`), o
 * renderer expande pelo **mesmo** pipeline dos snippets embutidos (`parseSnippet`).
 *
 * Rótulo de origem: escolha nossa (o alvo é clean-room) — o formato do arquivo é o
 * `.sublime-snippet` **público** (JSON com `prefix`/`body`/`description`).
 */

/**
 * Uma definição de snippet vinda de um pacote.
 *
 * `trigger` é o `prefix` do arquivo (o que o usuário digita antes do `Tab`); `body` é o
 * corpo já **unido** (`\n` entre as linhas do array `body`); `source` é o caminho lógico de
 * origem (`packages://<Nome>/<caminho>`) — existe para depurar e para exibir de onde veio.
 */
export interface PackageSnippetDefinition {
  readonly trigger: string;
  readonly body: string;
  readonly description?: string;
  /** URI lógica de origem (`packages://…`) — para depurar/mostrar. */
  readonly source: string;
}

/** Envelope de `snippets.list` (o renderer lê `result.snippets`). */
export interface SnippetsListResult {
  readonly snippets: readonly PackageSnippetDefinition[];
}

/**
 * Teto de definições devolvidas por `snippets.list`.
 *
 * Pacote é entrada **não confiável** (o usuário pode instalar qualquer `.sublime-package`):
 * a lista é limitada para o renderer nunca carregar um volume absurdo de templates.
 */
export const MAX_PACKAGE_SNIPPETS = 500;

/**
 * Teto do **corpo** de um snippet de pacote (64 KiB).
 *
 * Maior ⇒ o snippet é ignorado (com `warn`) — um template gigante travaria a expansão.
 */
export const MAX_PACKAGE_SNIPPET_BODY_BYTES = 64 * 1024;
