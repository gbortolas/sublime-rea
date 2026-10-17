/**
 * Barrel do módulo `src/core/buffer` (doc `01` — Buffer & edição).
 *
 * Só este módulo é dono destes símbolos; nada de import cruzado com outros módulos de
 * `src/core/**` (ver `docs/scaffold/00-convencoes-e-costuras.md`). O núcleo síncrono
 * (`PieceTable`) e o índice (`LineIndex`) são exportados para teste, exatamente como o scaffold
 * autoriza para a `PieceTable`.
 */
export { PieceTable } from "./piece-table";

export { LineIndex } from "./line-index";
export type { LineSource, LineIndexInit } from "./line-index";

export {
  TextDeltaError,
  isHighSurrogate,
  isLowSurrogate,
  splitsSurrogatePair,
  assertOffset,
  validateDelta,
  applyDelta,
  deltaToEdit,
  editToDelta,
  validateEdit,
  applyEdit,
  invertDelta,
  invertEdit,
  isEmptyDelta,
  utf16ToCodePoints,
  codePointsToUtf16,
} from "./delta";
export type { TextDeltaErrorReason } from "./delta";

export { LocalTextStore } from "./store";

export { BufferImpl, BufferDisposedError } from "./buffer";

export {
  DocumentRegistryImpl,
  FileSystemUnavailableError,
  DocumentIoError,
  UnknownDocumentError,
  RegistryCapacityError,
  createNodeFileSystem,
} from "./registry";
export type { FileSystem } from "./registry";
