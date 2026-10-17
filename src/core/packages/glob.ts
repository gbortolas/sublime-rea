/**
 * Scribe — matcher mínimo de glob para `PackageResolver.find`.
 *
 * Fonte: `docs/architecture/05-empacotamento-e-recursos.md` (`find_resources` por glob de nome
 * lógico, `PKG-E19`). Sem dependência nova: o padrão é compilado para `RegExp` **ancorado** e
 * cacheado.
 *
 * Suporte (escolha nossa): `**` (atravessa `/`), `*` (um segmento), `?` (um caractere, não `/`),
 * `{a,b}` (alternância simples, sem aninhamento), **case-sensitive**. `*`/`?` nunca casam `/`,
 * então `*.txt` **não** casa `a/b.txt`.
 *
 * Anti-ReDoS: `*` → `[^/]*`, `?` → `[^/]`, e `**` seguido de `/` → um grupo que consome
 * segmentos inteiros — cada iteração do quantificador externo come um `/`, então não há
 * ambiguidade exponencial.
 */
const REGEX_SPECIALS = new Set([".", "+", "^", "$", "(", ")", "[", "]", "|", "\\", "{", "}"]);

function escapeChar(ch: string): string {
  return REGEX_SPECIALS.has(ch) ? `\\${ch}` : ch;
}

function translate(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern.charAt(i);
    if (ch === "*") {
      if (pattern.charAt(i + 1) === "*") {
        if (pattern.charAt(i + 2) === "/") {
          out += "(?:[^/]*/)*";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "{") {
      const close = pattern.indexOf("}", i + 1);
      const inner = close >= 0 ? pattern.slice(i + 1, close) : "";
      if (close >= 0 && inner.includes(",")) {
        const alternatives = inner.split(",").map((part) => translate(part));
        out += `(?:${alternatives.join("|")})`;
        i = close + 1;
        continue;
      }
      out += "\\{";
      i += 1;
      continue;
    }
    out += escapeChar(ch);
    i += 1;
  }
  return out;
}

const cache = new Map<string, RegExp>();

/** Compila (e memoriza) um padrão glob em `RegExp` ancorado e case-sensitive. */
export function compileGlob(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached !== undefined) return cached;
  const compiled = new RegExp(`^${translate(pattern)}$`);
  cache.set(pattern, compiled);
  return compiled;
}

/** Testa se `value` casa com `pattern`. */
export function globMatches(pattern: string, value: string): boolean {
  return compileGlob(pattern).test(value);
}

/** Fonte RegExp do padrão (exposto para diagnóstico/teste). */
export function globToRegExpSource(pattern: string): string {
  return compileGlob(pattern).source;
}
