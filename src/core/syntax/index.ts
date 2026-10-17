/**
 * Scribe — barrel do módulo `syntax` (doc 05/04): gramática → tokens → tema.
 *
 * Dono de `src/core/syntax/**`; importa apenas `../../shared` (barrel) e o próprio diretório.
 */
export * from "./yaml";
export * from "./tokenizer";
export * from "./grammar";
export * from "./theme";
export * from "./registry";
