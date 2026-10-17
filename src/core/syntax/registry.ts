/**
 * Scribe — `registry.ts`: registro de gramáticas por **extensão** (alimentado pelo `PackageResolver`).
 *
 * Puro quanto ao I/O: **recebe o texto** da gramática (quem lê o arquivo é o chamador — no Scribe, o
 * módulo de composição `core/editor`, que já fala com o `PackageResolver`). Registra a definição
 * normalizada e **compila sob demanda** (na primeira consulta por extensão), com cache por gramática.
 *
 * Escolhas nossas (a spec deixava em aberto):
 * - a **primeira** gramática registrada para uma extensão vence; gramáticas `hidden` também casam
 *   por extensão (o `hidden` do alvo é "oculto de *pickers*", não "não resolvível" — DEC-PKG-7);
 * - a extensão é normalizada sem ponto e em minúsculas; a chave lógica é o nome lógico recebido;
 * - **re-registrar** o mesmo nome lógico recalcula os claims do zero, **na ordem de registro**: a
 *   extensão que ele tinha e já não declara é solta, e volta a casar a gramática que a reivindicava
 *   em seguida (senão a extensão antiga continuaria órfã, apontando para quem não a declara).
 */
import { GrammarIncludeError, GrammarParseError } from "../../shared";
import type { GrammarDefinition, GrammarRegistry, SyntaxGrammar } from "../../shared";
import { compileGrammar, normalizeGrammarDocument } from "./grammar";
import type { GrammarDefinitionResolver } from "./grammar";
import { parseYamlSubset } from "./yaml";

/** Normaliza uma extensão para a chave do índice: sem ponto, minúscula. */
export function normalizeExtension(extension: string): string {
  const trimmed = extension.trim().toLowerCase();
  return trimmed.startsWith(".") ? trimmed.slice(1) : trimmed;
}

export class GrammarRegistryImpl implements GrammarRegistry {
  private readonly definitions = new Map<string, GrammarDefinition>();
  private readonly byExtension = new Map<string, string>();
  private readonly compiled = new Map<string, SyntaxGrammar>();
  private disposed = false;

  register(logicalName: string, source: string): GrammarDefinition {
    if (this.disposed) {
      throw new GrammarParseError(logicalName, "registro já foi descartado");
    }
    const definition = normalizeGrammarDocument(parseYamlSubset(source, logicalName), logicalName);
    this.definitions.set(logicalName, definition);
    this.compiled.delete(logicalName);
    // Recomputa os claims do zero, na **ordem de registro** (`definitions` preserva a ordem de
    // inserção — re-registrar mantém a posição original). Assim "a primeira vence" continua valendo
    // entre nomes distintos **e** a extensão solta pelo re-registro volta a casar quem a declarava
    // depois (antes ela ficava órfã: `forExtension` devolvia `undefined`).
    this.byExtension.clear();
    for (const [name, registered] of this.definitions) {
      for (const extension of registered.fileExtensions) {
        const key = normalizeExtension(extension);
        if (key.length === 0) continue;
        if (!this.byExtension.has(key)) this.byExtension.set(key, name);
      }
    }
    return definition;
  }

  forExtension(extension: string): SyntaxGrammar | undefined {
    const key = normalizeExtension(extension);
    const logicalName = this.byExtension.get(key);
    if (logicalName === undefined) return undefined;
    return this.compile(logicalName);
  }

  dispose(): void {
    this.disposed = true;
    this.definitions.clear();
    this.byExtension.clear();
    this.compiled.clear();
  }

  /** Resolvedor de `include`/`extends` sobre as definições já registradas. */
  private readonly resolver: GrammarDefinitionResolver = {
    resolveDefinition: (logicalName: string): GrammarDefinition | undefined =>
      this.definitions.get(logicalName),
  };

  private compile(logicalName: string): SyntaxGrammar {
    const cached = this.compiled.get(logicalName);
    if (cached !== undefined) return cached;
    const definition = this.definitions.get(logicalName);
    if (definition === undefined) {
      throw new GrammarIncludeError(logicalName, logicalName, "gramática não registrada");
    }
    const grammar = compileGrammar(definition, this.resolver);
    this.compiled.set(logicalName, grammar);
    return grammar;
  }
}
