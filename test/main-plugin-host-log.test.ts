/**
 * Scribe — log do plugin host (achado BAIXO da auditoria com runtime).
 *
 * **O bug:** o log imprimia `Scribe: plugin host ready (handle=1048576, pid=[object Object]`
 * — faltava o `)` de fechamento e `bridge.port` **não** é um pid (é o objeto da ponte).
 *
 * **A correção:** o log fecha a linha e imprime o pid **real** — quando o `core` o expõe
 * (o `HostSession` hoje **não** expõe ⇒ o log diz isso explicitamente).
 */
import { describe, expect, it } from "vitest";

import { describePluginHostPid } from "../src/main/index";

describe("main — log do plugin host", () => {
  it("imprime o pid quando a sessão o expõe", () => {
    expect(describePluginHostPid({ pid: 4242 })).toBe("4242");
  });

  it("diz explicitamente quando o core não expõe o pid", () => {
    expect(describePluginHostPid({})).toBe("(não exposto pelo core)");
    expect(describePluginHostPid({ pid: "4242" })).toBe("(não exposto pelo core)");
    expect(describePluginHostPid(null)).toBe("(não exposto pelo core)");
    expect(describePluginHostPid(undefined)).toBe("(não exposto pelo core)");
  });
});
