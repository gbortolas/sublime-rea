/**
 * Scribe — handles opacos (canônico).
 *
 * Fonte: `docs/architecture/06-padroes-transversais.md` (DEC-TR-1) e
 * `docs/architecture/03-extensao-e-ipc.md` (DEC-IPC-7).
 *
 * Reconciliação de divergência: o digest da Fase 2 encontrou o brand de handle escrito de
 * 3 formas (`{__opaque}`, `{__brand:"DocumentHandle"}`, `Handle<T>`). **Canônico: `Handle<T>`**
 * — um `number` brandado, com *slot* nos bits baixos e *geração* nos bits altos (anti-ABA).
 *
 * Regra (DEC-TR-1): o handle é **valor**, nunca objeto; o estado mora no registry.
 */
declare const handleBrand: unique symbol;

/** Número brandado — a marca só existe em tempo de tipo. */
export type Branded<B extends string> = number & { readonly [handleBrand]: B };

/** Handle opaco de qualquer entidade nomeada. */
export type Handle<B extends string> = Branded<B>;

export type DocumentHandle = Handle<"DocumentHandle">;
export type ViewHandle = Handle<"ViewHandle">;
export type WindowHandle = Handle<"WindowHandle">;
export type HostHandle = Handle<"HostHandle">;

/** Bits baixos: índice do slot. Bits altos: geração (muda a cada reciclagem). */
export const SLOT_BITS = 20;
export const GENERATION_BITS = 11;
/** Soma 31 bits → o handle cabe num `int32` **não negativo** (importa para `Atomics`). */
export const HANDLE_BITS = SLOT_BITS + GENERATION_BITS;

export const MAX_SLOT = (1 << SLOT_BITS) - 1;
/** Geração 0 é reservada: significa "nunca emitido". */
export const MAX_GENERATION = (1 << GENERATION_BITS) - 1;

const SLOT_MASK = MAX_SLOT;

/** Empacota slot + geração. A geração circula (`MAX_GENERATION` → 1). */
export function makeHandle<B extends string>(slot: number, generation: number): Handle<B> {
  if (!Number.isInteger(slot) || slot < 0 || slot > MAX_SLOT) {
    throw new RangeError(`makeHandle: slot fora da faixa 0..${MAX_SLOT}: ${slot}`);
  }
  if (!Number.isInteger(generation) || generation < 1) {
    throw new RangeError(`makeHandle: geração deve ser >= 1: ${generation}`);
  }
  const gen = generation > MAX_GENERATION ? ((generation - 1) % MAX_GENERATION) + 1 : generation;
  return ((gen << SLOT_BITS) | slot) as Handle<B>;
}

export function handleSlot(h: Handle<string>): number {
  return h & SLOT_MASK;
}

export function handleGeneration(h: Handle<string>): number {
  return (h >>> SLOT_BITS) & MAX_GENERATION;
}

/** Igualdade estrita — geração incluída (um handle velho NÃO é o mesmo documento). */
export function sameHandle(a: Handle<string>, b: Handle<string>): boolean {
  return a === b;
}

/** Próxima geração de um slot (usado pelo registry ao reabrir um slot reciclado). */
export function nextGeneration(generation: number): number {
  return generation >= MAX_GENERATION ? 1 : generation + 1;
}
