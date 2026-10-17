/**
 * Scribe — módulo `concurrency` (doc 02): `Scheduler`, `TaskPool` (worker_threads) e
 * contadores compartilhados. Dono: `src/core/concurrency/**`; importa **apenas** `../../shared`.
 *
 * Fonte: `docs/architecture/02-concorrencia-e-scheduling.md` (DEC-CON-1..12).
 */
export * from "./scheduler";
export * from "./pool";
export * from "./counters";
export type {
  CancelMessage,
  ReadyMessage,
  TextRegisterMessage,
  WorkerInbound,
  WorkerOutbound,
  WorkerRuntime,
} from "./worker-entry";
