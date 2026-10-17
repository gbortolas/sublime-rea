/**
 * Scribe — escopo de edição aninhável (`EditScopeImpl`).
 *
 * Fonte: `docs/architecture/01-buffer-e-edicao.md` (DEC-BUF-8: *um `EditScope` é exatamente o
 * aninhamento de grupo de undo*; DEC-BUF-4: o grupo só consolida quando o aninhamento zera) e
 * `docs/architecture/06-padroes-transversais.md` (§3, DEC-TR-3: transação explícita).
 *
 * **Escolha nossa (não observada no alvo):** o alvo abre/fecha um *edit token* opaco (`PY-E17`) e
 * bloqueia limpeza da pilha durante o comando (`BUF-E10`). Aqui o **token é um objeto tipado** e o
 * **contador de aninhamento mora no `CommandBus`** (`EditScopeHost`), não no escopo — o escopo só
 * avisa que saiu. Limpar/colar a pilha com escopo aberto é **erro alto** (`UndoStackBusyError`,
 * D4), nunca silêncio (DEC-TR-5).
 *
 * Clean-room: só nomes/papel arquitetural; nenhum código do alvo.
 */
import type { EditScope } from "../../shared";
import { UndoStackBusyError } from "../../shared";

/**
 * Quem mantém o contador de aninhamento. Implementado pelo `CommandBus`; o escopo só notifica a
 * saída (o `dispose()` é idempotente, então a notificação nunca é duplicada).
 */
export interface EditScopeHost {
  /** Chamado **uma vez**, quando o escopo sai de `active`. */
  releaseScope(scope: EditScopeImpl): void;
}

/**
 * Guard de "pilha ocupada" (DEC-BUF-4/D4): limpar ou colar a pilha de undo com escopo aberto
 * **falha alto** com o erro tipado compartilhado. Vive aqui porque é o escopo quem define a
 * condição de ocupação; o `CommandBus` é quem sabe a contagem.
 */
export function assertScopesClosed(openScopes: number): void {
  if (openScopes > 0) {
    throw new UndoStackBusyError(openScopes);
  }
}

/**
 * Token de escopo — `id` monotônico, `reason` legível, `active` observável e `dispose()`
 * idempotente. O aninhamento é do host; aqui só guardamos a própria vivacidade.
 */
export class EditScopeImpl implements EditScope {
  readonly id: number;
  readonly reason: string;

  private activeFlag = true;
  private readonly host: EditScopeHost;

  constructor(id: number, reason: string, host: EditScopeHost) {
    this.id = id;
    this.reason = reason;
    this.host = host;
  }

  get active(): boolean {
    return this.activeFlag;
  }

  dispose(): void {
    if (!this.activeFlag) return;
    this.activeFlag = false;
    this.host.releaseScope(this);
  }
}
