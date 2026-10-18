/**
 * Scribe — módulo `core/extension` (doc `03`): host de plugins isolado + ponte tipada.
 *
 * Barrel do módulo. Importável pelos demais módulos **apenas** através daqui (ou de
 * `src/shared/**`), conforme `docs/scaffold/00-convencoes-e-costuras.md`.
 */
export {
  OPS,
  OPS_HASH,
  OPS_ORDER,
  OPS_COUNT,
  computeOpsHash,
  isMethodName,
  nameOf,
  opcodeOf,
} from "./ops";

export {
  RpcCallError,
  createBridge,
  createBridgeInternal,
  isCompatibleVersion,
  parseBridgeVersion,
  parseEnvelope,
} from "./bridge";
export type {
  BridgeInternals,
  BridgeOptions,
  BridgeTimer,
  Handshake,
  MethodHandlers,
  TimerHandle,
} from "./bridge";

export { createExtensionAPI, createMethodHandlers } from "./api-facade";
export type { ExtensionApiDeps, MethodHandlerDeps } from "./api-facade";

export {
  ExtensionHostImpl,
  createElectronPortPair,
  electronHostSpawner,
} from "./host";
export type {
  ExtensionHostOptions,
  HostProcess,
  HostProcessEventName,
  HostProcessEvents,
  HostSpawnOptions,
  HostSpawner,
  PortPair,
} from "./host";

export type { HostSession } from "../../shared";
