/**
 * Scribe — `core/editor` (barrel do módulo de composição).
 *
 * Módulo de **costura final**: é o único autorizado a importar cruzado entre módulos de
 * `src/core/**` (ver `docs/scaffold/00-convencoes-e-costuras.md` §1). O `main` consome daqui.
 */
export {
  createEditorCore,
  INSERT_COMMAND_ID,
  PROPERTY_INDEX_WORKERS,
  PROPERTY_MAX_BACKGROUND_THREADS,
  InvalidDocumentHandleError,
  EditorCoreDisposedError,
  EditorArgumentError,
} from "./editor-core";
export type { EditorCore, EditorCoreOptions } from "./editor-core";
