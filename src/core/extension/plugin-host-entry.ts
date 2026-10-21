/**
 * Scribe — entry point do processo `utilityProcess` do plugin host (DEC-IPC-1/2/11).
 *
 * Esse arquivo é **forkado** pelo `ExtensionHostImpl.spawn()` e executa num processo filho
 * isolado (sem janela, sem DOM, sem Electron APIs além da mensageria).
 *
 * Fluxo de boot (canal **nativo** do `utilityProcess`):
 * 1. O núcleo envia o envelope `{ kind: "bootstrap", name }` pela mensageria do processo.
 *    **Nenhuma porta é transferida** — no Electron 38 o `utilityProcess.postMessage` não clona
 *    `MessagePortMain` (nem ports de `worker_threads`): *"An object could not be cloned."*
 *    O canal **é** a mensageria do processo.
 * 2. Aqui recebemos esse envelope pelo `process.parentPort` — que é a `BridgePort` do host —
 *    e montamos a ponte sobre o **mesmo** canal.
 * 3. Enviamos o handshake `{ kind: "ready", hostVersion, apiVersion, opsHash }`.
 * 4. A partir daí, a bridge gerencia requests do núcleo (ping, buffer.insert, etc.).
 *
 * **Nota:** este entry precisa ser bundleado (esbuild CJS, sem external) — o `utilityProcess`
 * não resolve imports relativos a partir do source TypeScript. Ver `scripts/build.mjs` etapa 3.6.
 */
import { createBridgeInternal } from "./bridge";
import { OPS_HASH } from "./ops";
import { EXTENSION_BRIDGE_VERSION } from "../../shared";
import type { BridgePort, ExtensionMethods } from "../../shared";

/** Versão do host — identifica qual runtime de plugin está rodando. */
const HOST_VERSION = "scribe-plugin-host/0.1.0";

/** Tempo máximo que o filho espera o bootstrap do núcleo antes de desistir. */
const BOOTSTRAP_TIMEOUT_MS = 60_000;

/**
 * `process.parentPort` — o canal nativo do `utilityProcess`.
 *
 * Tipado **localmente** (o processo filho não tem o módulo `electron`; o bundle é
 * self-contained) — a forma é a de `Electron.ParentPort`: `postMessage(message)` e
 * `on("message", (event) => …)`, onde `event.data` é a mensagem.
 */
interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { readonly data: unknown }) => void): unknown;
  off?(event: "message", listener: (event: { readonly data: unknown }) => void): unknown;
  start?(): void;
  close?(): void;
}

/** Envelope de bootstrap enviado pelo núcleo (sem porta — o canal é o do processo). */
interface BootstrapEnvelope {
  readonly kind: "bootstrap";
  readonly name: string;
}

function isBootstrap(message: unknown): message is BootstrapEnvelope {
  if (typeof message !== "object" || message === null) return false;
  return (message as { readonly kind?: unknown }).kind === "bootstrap";
}

/** Lê o `process.parentPort` (só existe em processos `utilityProcess`). */
function readParentPort(): ParentPortLike | undefined {
  const holder = process as unknown as { readonly parentPort?: unknown };
  const candidate = holder.parentPort;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const port = candidate as Partial<ParentPortLike>;
  if (typeof port.postMessage !== "function" || typeof port.on !== "function") return undefined;
  return port as ParentPortLike;
}

/**
 * Adapta o `process.parentPort` à interface `BridgePort` (a ponte do host).
 *
 * O `parentPort` entrega um `MessageEvent` (`event.data`); a ponte quer o valor cru — a
 * desembrulhagem acontece aqui (a `ExtensionBridge` também aceita as duas formas).
 */
function createParentPortAdapter(parentPort: ParentPortLike): BridgePort {
  const listeners = new Set<(value: unknown) => void>();
  const onMessage = (event: { readonly data: unknown }): void => {
    for (const listener of [...listeners]) listener(event.data);
  };
  parentPort.on("message", onMessage);

  const port: BridgePort = {
    postMessage: (message: unknown): void => {
      parentPort.postMessage(message);
    },
    on: (event: "message", listener: (value: unknown) => void): BridgePort => {
      if (event === "message") listeners.add(listener);
      return port;
    },
    off: (event: "message", listener: (value: unknown) => void): BridgePort => {
      if (event === "message") listeners.delete(listener);
      return port;
    },
    start: (): void => {
      parentPort.start?.();
    },
    close: (): void => {
      parentPort.close?.();
    },
  };
  return port;
}

/**
 * Escuta o envelope `bootstrap` enviado pelo núcleo, conecta a ponte e entra no loop de
 * mensagens do host. Resolve quando o handshake é concluído ou rejeita em caso de erro.
 */
function bootstrap(channel: BridgePort): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const onMessage = (message: unknown): void => {
      if (settled || !isBootstrap(message)) return;
      settled = true;
      // O bootstrap é consumido **aqui**: a ponte nasce depois, então nunca o vê.
      channel.off?.("message", onMessage);

      try {
        // O host **não** expõe handlers de método — quem recebe `call`/`notify` do núcleo
        // (ex.: o core chamar de volta o host) não faz parte do contrato atual. Se um dia
        // o core precisar chamar o host, os handlers entram aqui.
        createBridgeInternal<ExtensionMethods, ExtensionMethods>(channel, {
          initialState: "spawned",
        });

        // Handshake imediato: avisa o núcleo que estamos vivos e qual protocolo falamos.
        channel.postMessage({
          kind: "ready" as const,
          hostVersion: HOST_VERSION,
          apiVersion: EXTENSION_BRIDGE_VERSION,
          opsHash: OPS_HASH,
        });

        resolve();
      } catch (err) {
        reject(err);
      }
    };

    channel.on("message", onMessage);

    // Timeout de segurança: se o núcleo não mandar bootstrap em 60s, falha.
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      channel.off?.("message", onMessage);
      reject(new Error("plugin-host: timeout aguardando bootstrap do núcleo"));
    }, BOOTSTRAP_TIMEOUT_MS);
    timeout.unref();
  });
}

/**
 * Plugin host principal: bootstrap → mantém o processo vivo enquanto o canal com o núcleo
 * estiver aberto (o `parentPort` mantém o event loop do Node ativo).
 */
async function main(): Promise<void> {
  try {
    const parentPort = readParentPort();
    if (parentPort === undefined) {
      throw new Error(
        "plugin-host: process.parentPort ausente (o processo não foi forkado como utilityProcess?)",
      );
    }
    const channel = createParentPortAdapter(parentPort);
    await bootstrap(channel);
    // Nada mais a fazer aqui — o `parentPort` (e a ponte) mantêm o processo vivo.
  } catch (err) {
    console.error("[plugin-host] erro fatal:", err);
    process.exit(1);
  }
}

void main();
