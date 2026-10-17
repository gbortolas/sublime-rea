/**
 * Scribe — tabela densa de opcodes da `ExtensionBridge` (doc `06` §5, `DEC-TR-5`).
 *
 * Fonte: `docs/architecture/06-padroes-transversais.md` §5 ("tabela de opcodes gerada — a ORDEM é
 * o contrato") e `docs/architecture/03-extensao-e-ipc.md` (`DEC-IPC-5`/`DEC-IPC-11`).
 *
 * Regra do alvo que **mantemos** (`IPC-E27`): *id e superfície não podem divergir*. Aqui a tabela
 * é escrita à mão (não há gerador nesta fase) mas o tipo `OpsTable` garante, em tempo de compilação,
 * que **todo** método de `ExtensionMethods` tem exatamente um opcode — método novo sem entrada na
 * tabela não compila; entrada sobrando também não.
 *
 * Contrato de wire (congelado): cada método tem um número **denso** `1..N`; a posição é a ordem de
 * `OPS_ORDER`; `OPS_HASH` (sha256 dos nomes nessa ordem) vai no handshake (`HostToCore.ready`) e uma
 * divergência **falha cedo e alto** (`DEC-IPC-11`, `§9`).
 *
 * Diferente do alvo (`IPC-E24`: opcode inválido = silêncio), aqui opcode **ou** nome desconhecido
 * lança `ProtocolError` — nunca silencioso (`DEC-TR-5`).
 */
import { createHash } from "node:crypto";

import { ProtocolError } from "../../shared";
import type { ExtensionMethodName, OpsTable } from "../../shared";

/**
 * Tabela densa: nome → número. **A ordem (1-based) é o contrato de wire** — `buffer.insert` = 4
 * significa que o 4º slot do wire é `buffer.insert` em toda parte.
 *
 * Ordem escolhida (agrupada por namespace, estável): `ping`, `documents.*`, `packages.*`,
 * `buffer.*`, `view.*`. Mudar a ordem renumera o contrato inteiro ⇒ o handshake acusa (`OPS_HASH`).
 */
const OPS_NUMBER: Record<ExtensionMethodName, number> = {
  ping: 1,
  "documents.open": 2,
  "packages.resolve": 3,
  "buffer.insert": 4,
  "buffer.erase": 5,
  "view.scroll": 6,
};

/** Tabela imutável de opcodes — `Readonly<Record<ExtensionMethodName, number>>`. */
export const OPS: OpsTable = Object.freeze({ ...OPS_NUMBER });

/**
 * Nomes na ordem do wire (índice `i` → opcode `i + 1`). Derivada de `OPS` ordenando por número, de
 * modo que editar a tabela acima não exige reordenar nada à mão.
 */
export const OPS_ORDER: readonly ExtensionMethodName[] = Object.freeze(
  (Object.keys(OPS) as ExtensionMethodName[]).sort((a, b) => OPS[a] - OPS[b]),
);

/** Tamanho da tabela (número do último opcode). */
export const OPS_COUNT: number = OPS_ORDER.length;

/** Garante, em tempo de carga, que os números são densos `1..N` e únicos. */
function validateOpsTable(): void {
  const seen = new Set<number>();
  for (const name of OPS_ORDER) {
    const opcode = OPS[name];
    if (!Number.isInteger(opcode) || opcode < 1 || opcode > OPS_ORDER.length || seen.has(opcode)) {
      throw new ProtocolError("ops.invalid", `tabela de opcodes inválida para "${name}": ${opcode}`);
    }
    seen.add(opcode);
  }
}
validateOpsTable();

const OPS_BY_NAME: Readonly<Record<string, number>> = OPS;
const NAME_BY_OPCODE: ReadonlyMap<number, ExtensionMethodName> = new Map(
  OPS_ORDER.map((name) => [OPS[name], name] as const),
);

/**
 * Hash (sha256, hex) dos **nomes na ordem** do wire. Determinístico: reordenar, adicionar ou
 * remover um método muda o hash — é o que o handshake usa para detectar drift de protocolo.
 * Exportada para que o teste de estabilidade possa provar a sensibilidade à ordem sem tocar no módulo.
 */
export function computeOpsHash(order: readonly string[]): string {
  return createHash("sha256").update(order.join("\n"), "utf8").digest("hex");
}

/** Hash da tabela canônica (`OPS_ORDER`). */
export const OPS_HASH: string = computeOpsHash(OPS_ORDER);

/** `true` se `name` é um método conhecido da tabela. */
export function isMethodName(name: string): name is ExtensionMethodName {
  return OPS_BY_NAME[name] !== undefined;
}

/** Nome → opcode. Nome desconhecido ⇒ `ProtocolError` (nunca silencioso). */
export function opcodeOf(name: string): number {
  const opcode = OPS_BY_NAME[name];
  if (opcode === undefined) {
    throw new ProtocolError("ops.unknown-name", `método sem opcode na tabela: "${name}"`);
  }
  return opcode;
}

/** Opcode → nome. Opcode desconhecido ⇒ `ProtocolError` (nunca silencioso). */
export function nameOf(opcode: number): ExtensionMethodName {
  const name = NAME_BY_OPCODE.get(opcode);
  if (name === undefined) {
    throw new ProtocolError("ops.unknown-opcode", `opcode desconhecido: ${opcode}`);
  }
  return name;
}
