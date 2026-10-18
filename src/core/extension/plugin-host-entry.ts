/**
 * Scribe — entry point do processo `utilityProcess` do plugin host (DEC-IPC-1/2/11).
 *
 * Esse arquivo é **forkado** pelo `ExtensionHostImpl.spawn()` e executa num processo filho
 * isolado (sem janela, sem DOM, sem Electron APIs além da mensageria).
 *
 * Fluxo de boot:
 * 1. O núcleo cria um `MessageChannelMain`, transfere uma das portas via `child.postMessage`.
 * 2. Aqui recebemos o envelope `{ kind: "bootstrap", name, port }` pelo `process.on("message")`.
 * 3. Conectamos a porta, instanciamos a `ExtensionBridge` no lado do host, enviamos o handshake
 *    `{ kind: "ready", hostVersion, apiVersion, opsHash }`.
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

/**
 * Escuta o envelope `bootstrap` enviado pelo núcleo, conecta a ponte e entra no loop de
 * mensagens do host. Resolve quando o handshake é concluído ou rejeita em caso de erro.
 */
function bootstrap(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onMessage = (message: unknown): void => {
      const record = message as Record<string, unknown>;
      if (record.kind !== "bootstrap") return;
      const port = record.port as BridgePort | undefined;
      if (port === undefined) {
        reject(new Error("plugin-host: bootstrap sem port"));
        return;
      }
      process.off?.("message", onMessage);

      try {
        // O host **não** expõe handlers de método — quem recebe `call`/`notify` do núcleo
        // (ex.: o core chamar de volta o host) não faz parte do contrato atual. Se um dia
        // o core precisar chamar o host, os handlers entram aqui.
        createBridgeInternal<ExtensionMethods, ExtensionMethods>(port, {
          initialState: "spawned",
        });

        // Handshake imediato: avisa o núcleo que estamos vivos e qual protocolo falamos.
        const handshake = {
          kind: "ready" as const,
          hostVersion: HOST_VERSION,
          apiVersion: EXTENSION_BRIDGE_VERSION,
          opsHash: OPS_HASH,
        };
        port.postMessage(handshake);

        resolve();
      } catch (err) {
        reject(err);
      }
    };

    process.on("message", onMessage);

    // Timeout de segurança: se o núcleo não mandar bootstrap em 60s, falha.
    const timeout = setTimeout(() => {
      process.off?.("message", onMessage);
      reject(new Error("plugin-host: timeout aguardando bootstrap do núcleo"));
    }, 60_000);
    timeout.unref();
  });
}

/**
 * Plugin host principal: bootstrap → mantém o processo vivo até o núcleo fechar a porta
 * ou o processo ser morto.
 */
async function main(): Promise<void> {
  try {
    await bootstrap();
    // O processo filho fica vivo enquanto a bridge estiver aberta. O `MessagePort` mantém
    // o event loop do Node ativo; se o núcleo fechar a porta, o processo termina naturalmente.
    // Nada mais a fazer aqui — o loop de eventos cuida do resto.
  } catch (err) {
    console.error("[plugin-host] erro fatal:", err);
    process.exit(1);
  }
}

void main();