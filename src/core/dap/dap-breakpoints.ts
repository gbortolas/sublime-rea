/**
 * Scribe — normalização de breakpoints (DAP).
 *
 * Função **pura** (sem I/O, sem estado): converte o que chega do renderer/IPC numa lista
 * canônica de {@link DapBreakpointSpec} e, desta, na lista de `SourceBreakpoint` do protocolo.
 *
 * Por que normalizar em vez de confiar no chamador: a entrada vem do **renderer** (que pode
 * estar desatualizado) e do **IPC** (JSON arbitrário). Um breakpoint com linha `0`, condição
 * gigante ou `NaN` acabaria no `setBreakpoints` do adaptador — que pode responder erro e
 * derrubar a sessão inteira. Aqui o dado é saneado **antes** de cruzar a fronteira.
 */

import {
  MAX_BREAKPOINT_CONDITION_LENGTH,
  MAX_BREAKPOINT_HIT_CONDITION_LENGTH,
  MAX_BREAKPOINT_LOG_MESSAGE_LENGTH,
  type DapBreakpointSpec,
} from "../../shared/dap-contract";
import type { DapSourceBreakpoint } from "./dap-protocol";

/** Teto de breakpoints por arquivo (protege o `setBreakpoints` contra listas absurdas). */
export const MAX_BREAKPOINTS_PER_FILE = 500;

/**
 * Teto do tamanho da expressão condicional.
 *
 * O teto vive no **contrato compartilhado** (a interface e o core precisam do mesmo
 * número) — aqui ele é só reexportado, para o histórico do módulo.
 */
export const MAX_CONDITION_LENGTH = MAX_BREAKPOINT_CONDITION_LENGTH;

/** Teto do tamanho da condição de paradas (`hitCondition`). */
export const MAX_HIT_CONDITION_LENGTH = MAX_BREAKPOINT_HIT_CONDITION_LENGTH;

/** Teto do tamanho da mensagem de log (logpoint). */
export const MAX_LOG_MESSAGE_LENGTH = MAX_BREAKPOINT_LOG_MESSAGE_LENGTH;

/**
 * Converte uma entrada heterogênea (números e/ou objetos) numa lista canônica de specs.
 *
 * Regras:
 * - número inteiro `>= 1` ⇒ breakpoint incondicional na linha;
 * - objeto com `line` válida ⇒ idem, acrescido de `condition`/`hitCondition`/`logMessage`
 *   (strings não vazias, aparadas e truncadas nos tetos);
 * - qualquer outro item é **descartado** (não quebra a lista inteira);
 * - linhas repetidas: vence a **última** ocorrência (é assim que o renderer atualiza uma
 *   condição reenviando a lista completa);
 * - resultado ordenado por linha ascendente e limitado a {@link MAX_BREAKPOINTS_PER_FILE}.
 */
export function normalizeBreakpointSpecs(raw: unknown): DapBreakpointSpec[] {
  if (!Array.isArray(raw)) return [];

  const byLine = new Map<number, DapBreakpointSpec>();
  for (const item of raw) {
    const spec = toSpec(item);
    if (spec === undefined) continue;
    byLine.set(spec.line, spec);
  }

  return [...byLine.values()]
    .sort((a, b) => a.line - b.line)
    .slice(0, MAX_BREAKPOINTS_PER_FILE);
}

/** Converte as specs canônicas no formato `SourceBreakpoint` do protocolo DAP. */
export function toSourceBreakpoints(
  specs: readonly DapBreakpointSpec[],
): DapSourceBreakpoint[] {
  return specs.map((spec) => ({
    line: spec.line,
    ...(spec.condition !== undefined ? { condition: spec.condition } : {}),
    ...(spec.hitCondition !== undefined ? { hitCondition: spec.hitCondition } : {}),
    ...(spec.logMessage !== undefined ? { logMessage: spec.logMessage } : {}),
  }));
}

// ── Helpers ────────────────────────────────────────────────────────────────────────────────

function toSpec(item: unknown): DapBreakpointSpec | undefined {
  if (typeof item === "number") {
    return isValidLine(item) ? { line: item } : undefined;
  }
  if (typeof item !== "object" || item === null) return undefined;

  const record = item as Record<string, unknown>;
  const line = record["line"];
  if (typeof line !== "number" || !isValidLine(line)) return undefined;

  const condition = readText(record["condition"], MAX_CONDITION_LENGTH);
  const hitCondition = readText(record["hitCondition"], MAX_HIT_CONDITION_LENGTH);
  const logMessage = readText(record["logMessage"], MAX_LOG_MESSAGE_LENGTH);

  return {
    line,
    ...(condition !== undefined ? { condition } : {}),
    ...(hitCondition !== undefined ? { hitCondition } : {}),
    ...(logMessage !== undefined ? { logMessage } : {}),
  };
}

function isValidLine(line: number): boolean {
  return Number.isInteger(line) && line >= 1;
}

/** Lê um campo textual: só strings, aparadas, e limitadas ao teto (string vazia ⇒ ausente). */
function readText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, maxLength);
}
