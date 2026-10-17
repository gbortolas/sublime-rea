/**
 * Scribe — Snippets (P4#18): expansão de templates com Tab.
 *
 * Formato: { trigger, template } onde $1, $2, ... são tabstops,
 * ${1:default} tem valor default, $0 é o tabstop final.
 */

export interface Snippet {
  readonly trigger: string;
  readonly template: string;
  readonly description?: string;
}

export interface TabStop {
  readonly index: number;
  readonly start: number;       // offset no documento após expansão
  readonly end: number;         // offset no documento após expansão
  readonly defaultValue: string;
}

export interface SnippetExpansion {
  readonly text: string;
  readonly tabStops: readonly TabStop[];
}

/** Lista de snippets embutidos (simples, hardcoded por enquanto). */
const BUILTIN_SNIPPETS: Snippet[] = [
  { trigger: "for",    template: "for (let ${1:i} = 0; ${1} < ${2}; ${1}++) {\n  $0\n}" },
  { trigger: "forof",  template: "for (const ${1:item} of ${2:iterable}) {\n  $0\n}" },
  { trigger: "forin",  template: "for (const ${1:key} in ${2:obj}) {\n  $0\n}" },
  { trigger: "if",     template: "if (${1:condition}) {\n  $0\n}" },
  { trigger: "else",   template: "else {\n  $0\n}" },
  { trigger: "elif",   template: "else if (${1:condition}) {\n  $0\n}" },
  { trigger: "while",  template: "while (${1:condition}) {\n  $0\n}" },
  { trigger: "fun",    template: "function ${1:name}(${2:params}) {\n  $0\n}" },
  { trigger: "fn",     template: "(${1:params}) => ${2:void}" },
  { trigger: "log",    template: "console.log($1);$0" },
  { trigger: "try",    template: "try {\n  $0\n} catch (${1:error}) {\n  \n}" },
  { trigger: "class",  template: "class ${1:Name} {\n  constructor(${2:params}) {\n    $0\n  }\n}" },
];

/** Busca snippet pelo trigger (case-insensitive). */
export function findSnippet(word: string): Snippet | undefined {
  const lower = word.toLowerCase();
  return BUILTIN_SNIPPETS.find((s) => s.trigger === lower);
}

/**
 * Parseia um template de snippet e retorna o texto expandido + metadados dos tabstops.
 * Suporta $N, ${N:default}, $0.
 */
export function parseSnippet(template: string): SnippetExpansion {
  const tabStops: TabStop[] = [];
  const seen = new Map<number, { start: number; defaultValue: string }>();
  let result = "";
  let i = 0;

  while (i < template.length) {
    if (template[i] === "$" && i + 1 < template.length) {
      const next = template[i + 1]!;

      // $$ → literal $
      if (next === "$") {
        result += "$";
        i += 2;
        continue;
      }

      // ${N:default}
      if (next === "{" && i + 2 < template.length) {
        const close = template.indexOf("}", i + 2);
        if (close !== -1) {
          const inner = template.slice(i + 2, close);
          const colon = inner.indexOf(":");
          let index: number;
          let defaultValue = "";
          if (colon !== -1) {
            index = parseInt(inner.slice(0, colon), 10);
            defaultValue = inner.slice(colon + 1);
          } else {
            index = parseInt(inner, 10);
          }
          if (!isNaN(index)) {
            const start = result.length;
            result += defaultValue;
            if (!seen.has(index)) {
              seen.set(index, { start, defaultValue });
            }
            tabStops.push({ index, start, end: start + defaultValue.length, defaultValue });
          } else {
            result += "$" + inner + "}";
          }
          i = close + 1;
          continue;
        }
      }

      // $N (single digit or multi-digit number)
      const numMatch = template.slice(i + 1).match(/^(\d+)/);
      if (numMatch !== null) {
        const captured = numMatch[1];
        if (captured === undefined) {
          result += template[i];
          i++;
          continue;
        }
        const index = parseInt(captured, 10);
        i += 1 + captured.length;

        if (index === 0) {
          // $0 = tabstop final (não substitui nada, so marca posicao
          const start = result.length;
          tabStops.push({ index: 0, start, end: start, defaultValue: "" });
          continue;
        }

        const start = result.length;
        if (!seen.has(index)) {
          seen.set(index, { start, defaultValue: "" });
        }
        tabStops.push({ index, start, end: start, defaultValue: "" });
        continue;
      }
    }

    result += template[i];
    i++;
  }

  // Filtra duplicatas (mantem a ultima ocorrencia de cada $N para espelhar)
  // Mas o espelhamento real ($1 aparece duas vezes, digita um e reflete) e complexo
  // Por enquanto, so usamos o primeiro tabstop de cada indice para o cursor
  const unique = new Map<number, TabStop>();
  for (const ts of tabStops) {
    unique.set(ts.index, ts);
  }
  // Coloca $0 por ultimo
  const sorted: TabStop[] = [];
  for (const [index, ts] of unique) {
    if (index === 0) continue;
    sorted.push(ts);
  }
  sorted.sort((a, b) => a.index - b.index);

  return { text: result, tabStops: sorted };
}