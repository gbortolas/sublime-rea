/**
 * Scribe — contrato do sistema de comandos (Command Palette).
 *
 * Define o formato de um comando registrado e o resultado de busca, usados pelo
 * core (para listar) e pelo renderer (para exibir na palette).
 */
/** Um comando registrado no sistema (visível na palette). */
export interface Command {
  readonly id: string;
  readonly label: string;
  readonly category?: string;       // "File", "Edit", "View", etc.
  readonly accelerator?: string;    // "Ctrl+O", "Ctrl+S", etc.
}

/** Resultado da busca na palette. */
export interface CommandListResult {
  readonly commands: readonly Command[];
}