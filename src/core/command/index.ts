/**
 * Scribe — `command` (barrel do módulo).
 *
 * Dono: `src/core/command/**` (doc `01` §CommandBus + doc `06` §3/DEC-TR-3). Só importa
 * `../../shared` e o próprio diretório (ver `docs/scaffold/00-convencoes-e-costuras.md` §1).
 */
export * from "./edit-scope";
export * from "./undo-stack";
export * from "./command-bus";
