/**
 * Scribe — costuras compartilhadas (barrel).
 *
 * Só o que está aqui pode ser importado **entre** módulos de `src/core/**`. Cada módulo é dono
 * da sua implementação; estes arquivos são a forma congelada dos contratos da Fase 2
 * (`docs/architecture/`). Ver `docs/scaffold/00-convencoes-e-costuras.md`.
 */
export * from "./handles";
export * from "./disposable";
export * from "./events";
export * from "./async";
export * from "./buffer-contract";
export * from "./concurrency-contract";
export * from "./render-contract";
export * from "./packages-contract";
export * from "./properties-contract";
export * from "./extension-contract";
export * from "./ipc-contract";
export * from "./syntax-contract";
export * from "./search-contract";
export * from "./selection-contract";
