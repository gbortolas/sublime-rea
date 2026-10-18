/**
 * Scribe — `theme.ts`: resolução de **escopo → estilo** por *selector* (DEC-PKG-9, lado aparência).
 *
 * Regra de **especificidade** (escolha nossa — a spec deixou em aberto):
 * - o selector é um **prefixo de escopo** em componentes separados por `.`
 *   (ex.: `string.quoted` casa `string.quoted.double.demo`);
 * - vence o selector com **mais componentes**; **empate = a última regra da ordem de carga**
 *   (determinístico, sem depender de ordenação de objeto).
 *
 * Não há selectores descendentes nem `,` (mantemos o mínimo da DEC-PKG-9; a spec não exige mais).
 */
import type { Scope, ScopeStyle, ThemeResolver } from "../../shared";
import type { RGBA } from "../../shared";

/** Regra de tema: um selector de escopo + o estilo aplicado. */
export interface ThemeRule {
  readonly selector: string;
  readonly style: ScopeStyle;
}

export class ThemeResolverImpl implements ThemeResolver {
  private readonly rules: ThemeRule[] = [];

  /** Anexa uma regra ao fim da ordem de carga (empates ficam com a última). */
  add(selector: string, style: ScopeStyle): void {
    this.rules.push({ selector, style });
  }

  styleFor(scope: Scope): ScopeStyle | undefined {
    let best: ScopeStyle | undefined;
    let bestScore = -1;
    for (const rule of this.rules) {
      if (!selectorMatches(rule.selector, scope)) continue;
      const score = selectorSpecificity(rule.selector);
      if (score >= bestScore) {
        best = rule.style;
        bestScore = score;
      }
    }
    return best;
  }
}

function components(value: string): string[] {
  return value.split(".").filter((part) => part.length > 0);
}

function selectorSpecificity(selector: string): number {
  return components(selector).length;
}

function selectorMatches(selector: string, scope: Scope): boolean {
  const selectorParts = components(selector);
  if (selectorParts.length === 0) return false;
  const scopeParts = components(scope);
  if (selectorParts.length > scopeParts.length) return false;
  for (let index = 0; index < selectorParts.length; index++) {
    if (selectorParts[index] !== scopeParts[index]) return false;
  }
  return true;
}

/**
 * Tema default do Scribe (escolha nossa — paleta escura no espírito do alvo, sem copiar tema algum).
 * Cobre só os escopos da nossa gramática de brinquedo; o escopo-base não tem regra de propósito,
 * para o trecho sem destaque cair na cor default do layout.
 */
export function createDefaultTheme(): ThemeResolverImpl {
  const theme = new ThemeResolverImpl();
  theme.add("comment", { color: 0x6a9955ff as RGBA, italic: true });
  theme.add("keyword", { color: 0xc586c0ff as RGBA });
  theme.add("string", { color: 0xce9178ff as RGBA });
  theme.add("constant.numeric", { color: 0xb5cea8ff as RGBA });
  theme.add("constant.character.escape", { color: 0xd7ba7dff as RGBA });
  theme.add("variable", { color: 0x9cdcfeff as RGBA });
  theme.add("punctuation", { color: 0x808080ff as RGBA });
  theme.add("entity.name", { color: 0xdcdcaaff as RGBA });
  return theme;
}

/**
 * Tema de sintaxe CLARO: par do `createDefaultTheme()` para quando o tema do editor é claro.
 *
 * Motivo de existir: as cores do par escuro são **claras** (para fundo escuro) e ficam
 * praticamente invisíveis sobre fundo branco — o texto vira uma mancha ilegível. Cobre
 * exatamente os mesmos escopos do tema escuro, mudando só a paleta.
 */
export function createLightTheme(): ThemeResolverImpl {
  const theme = new ThemeResolverImpl();
  theme.add("comment", { color: 0x008000ff as RGBA, italic: true });
  theme.add("keyword", { color: 0xaf00dbff as RGBA });
  theme.add("string", { color: 0xa31515ff as RGBA });
  theme.add("constant.numeric", { color: 0x098658ff as RGBA });
  theme.add("constant.character.escape", { color: 0xee0000ff as RGBA });
  theme.add("variable", { color: 0x001080ff as RGBA });
  theme.add("punctuation", { color: 0x666666ff as RGBA });
  theme.add("entity.name", { color: 0x795e26ff as RGBA });
  return theme;
}

/** Tema de sintaxe adequado ao tipo do tema do editor (`dark` → default, `light` → claro). */
export function createSyntaxTheme(kind: "dark" | "light"): ThemeResolverImpl {
  return kind === "light" ? createLightTheme() : createDefaultTheme();
}
