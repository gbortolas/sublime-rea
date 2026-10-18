/**
 * Scribe — barrel do módulo `render` (doc 04). É a **única** porta de entrada do módulo: o boot
 * (`src/renderer`) importa daqui, nunca de arquivos internos.
 */

export * from "./errors";
export * from "./atlas";
export * from "./pipeline";
export * from "./canvas2d-backend";
export * from "./webgpu-backend";
export * from "./viewport";
export * from "./scene";
export * from "./soft-wrap";
