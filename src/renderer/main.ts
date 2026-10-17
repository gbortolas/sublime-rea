/**
 * Scribe — boot do renderer (Electron/Chromium). **Nada de nó DOM por linha** (DEC-REN-7): o corpo
 * do editor é um único `<canvas>` (`#editor-surface`, já existente em `index.html`) desenhado pelo
 * `RenderPipeline`. O DOM serve só à casca (status bar, futuros menus).
 *
 * Documento: a demo estática é o **fallback**. Quando a ponte do preload existe (`window.scribe`),
 * o renderer liga um adaptador `LineSource` ao **documento real** (`document.open/text/insert`);
 * sem a ponte (teste/ambiente sem Electron) degrada para a demo — de forma **explícita e logada**
 * na status bar (DEC-TR-7). Digitação mínima: `keydown` imprimível → `insert(handle, caret, texto)`
 * e um novo frame redesenha o damage.
 *
 * Backend: escolhido por `render.backend` (knob `RENDER_BACKEND_PROPERTY`, DEC-REN-1) — o **default
 * de fábrica é `canvas2d`** (DEC-REN-2). O **modo efetivo é logado** na status bar.
 */
import {
  DEFAULT_RENDER_BACKEND,
  RENDER_BACKEND_PROPERTY,
  toDisposable,
} from "../shared";
import type {
  Disposable,
  DocumentHighlight,
  HighlightSpan,
  RenderBackendKind,
  RGBA,
  ReplaceAllResult,
  RenderPipeline,
  SearchDocumentResult,
  SearchMatch,
  SearchQuery,
  TextStyle,
} from "../shared";
import {
  FindBarModel,
  createDebounceScheduler,
} from "./find-bar";
import type { FindBarApi, FindBarState } from "./find-bar";
import {
  Canvas2DBackend,
  GlyphAtlas,
  ViewportImpl,
  WebGPUBackend,
  WebGPUUnavailableError,
  type AtlasSurface,
  type GlyphBitmap,
  type GlyphRasterizer,
  type LineLayout,
  type LineSource,
  type SceneHighlight,
  type SearchHighlight,
  type TextMeasurer,
  buildInstances,
} from "../core/render";
import { createDefaultTheme } from "../core/syntax";

const DEMO_LINE_COUNT = 200;
const GLYPH_CHUNK = 2048;

const TEXT_STYLE: TextStyle = { family: "monospace", sizePx: 15, weight: 400, italic: false };
const COLORS = {
  background: 0x1e1f22ff as RGBA,
  text: 0xd4d4d4ff as RGBA,
  caret: 0x7fb3ffff as RGBA,
  gutter: 0x2b2d30ff as RGBA,
};

// ---- rasterização/medição no renderer (fora da main thread seria o ideal — DEC-REN-3) ----------

function fontString(style: TextStyle): string {
  return `${style.italic ? "italic " : ""}${style.weight} ${style.sizePx}px ${style.family}`;
}

function createCanvasRasterizer(): GlyphRasterizer {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Scribe: contexto 2D indisponível para rasterizar glifos");
  return {
    rasterize(rune: string, style: TextStyle): GlyphBitmap {
      const height = Math.max(1, Math.ceil(style.sizePx * 1.3));
      const width = Math.max(1, Math.ceil(style.sizePx * 0.8));
      canvas.width = width;
      canvas.height = height;
      ctx.clearRect(0, 0, width, height);
      ctx.font = fontString(style);
      ctx.textBaseline = "top";
      ctx.fillStyle = "#ffffff";
      ctx.fillText(rune, 0, 0);
      const advance = ctx.measureText(rune).width;
      const rgba = ctx.getImageData(0, 0, width, height).data;
      const pixels = new Uint8Array(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        const alpha = rgba[i * 4 + 3] ?? 0;
        // Tinta branca "reta" (não pré-multiplicada): o backend aplica a cor/alpha.
        pixels[i * 4] = 255;
        pixels[i * 4 + 1] = 255;
        pixels[i * 4 + 2] = 255;
        pixels[i * 4 + 3] = alpha;
      }
      return { width, height, bearingX: 0, bearingY: height, advance, pixels };
    },
  };
}

function createCanvasMeasurer(): TextMeasurer {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Scribe: contexto 2D indisponível para medir texto");
  let currentFont = "";
  return (text, style) => {
    const font = fontString(style);
    if (font !== currentFont) {
      ctx.font = font;
      currentFont = font;
    }
    const measured = ctx.measureText(text);
    return {
      advance: measured.width,
      bearingX: 0,
      bearingY: style.sizePx,
      width: measured.width,
      height: style.sizePx,
    };
  };
}

/** Superfície do atlas em `<canvas>` — o `Canvas2DBackend` faz `drawImage` a partir dela. */
function createAtlasSurface(size: number): { surface: AtlasSurface; canvas: HTMLCanvasElement } {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Scribe: contexto 2D indisponível para a superfície do atlas");
  const surface: AtlasSurface = {
    image: canvas,
    write(region, bitmap): void {
      const data = new Uint8ClampedArray(bitmap.pixels);
      ctx.putImageData(new ImageData(data, region.w, region.h), region.x, region.y);
    },
  };
  return { surface, canvas };
}

// ---- seleção de backend -------------------------------------------------------------------------

function resolveBackendKind(): RenderBackendKind {
  const fromQuery = new URLSearchParams(window.location.search).get("backend");
  if (fromQuery === "webgpu" || fromQuery === "canvas2d") return fromQuery;
  const config = (globalThis as { __scribeRenderConfig?: Record<string, unknown> }).__scribeRenderConfig;
  const fromConfig = config?.[RENDER_BACKEND_PROPERTY];
  if (fromConfig === "webgpu" || fromConfig === "canvas2d") return fromConfig;
  return DEFAULT_RENDER_BACKEND;
}

// ---- adaptador documento → LineSource (o seam real) ---------------------------------------------

function splitLines(text: string): string[] {
  return text.split("\n");
}

/**
 * `LineSource` ligado ao **texto do documento** (o adaptador mínimo do renderer). Guarda o texto
 * completo e o fatia por linha sob demanda — o `Viewport` só materializa o range visível, então
 * **não** há nó DOM por linha (DEC-REN-7).
 */
export class DocumentLineSource implements LineSource {
  private textValue: string;
  private lines: string[];
  private revisionValue: number;

  constructor(text = "", revision = 0) {
    this.textValue = text;
    this.lines = splitLines(text);
    this.revisionValue = revision;
  }

  get text(): string {
    return this.textValue;
  }

  get revision(): number {
    return this.revisionValue;
  }

  /** Substitui o texto (vindo da ponte) e guarda a revisão associada. */
  setText(next: string, revision?: number): void {
    this.textValue = next;
    this.lines = splitLines(next);
    if (revision !== undefined) this.revisionValue = revision;
  }

  lineCount(): number {
    return this.lines.length;
  }

  line(index: number): string {
    return this.lines[index] ?? "";
  }

  /** Offset (code units UTF-16) → linha/coluna (0-based). */
  positionAt(offset: number): { line: number; column: number } {
    const clamped = Math.max(0, Math.min(offset, this.textValue.length));
    let remaining = clamped;
    for (let index = 0; index < this.lines.length; index += 1) {
      const length = this.lines[index]?.length ?? 0;
      if (remaining <= length) return { line: index, column: remaining };
      remaining -= length + 1;
    }
    const last = Math.max(0, this.lines.length - 1);
    return { line: last, column: this.lines[last]?.length ?? 0 };
  }

  /** Linha/coluna (0-based) → offset (code units UTF-16). */
  offsetOf(line: number, column: number): number {
    const target = Math.max(0, Math.min(line, this.lines.length - 1));
    let offset = 0;
    for (let index = 0; index < target; index += 1) {
      offset += (this.lines[index]?.length ?? 0) + 1;
    }
    const length = this.lines[target]?.length ?? 0;
    return offset + Math.max(0, Math.min(column, length));
  }
}

/** Estado de undo/redo que a ponte devolve (espelha `DocumentUndoState` do contrato). */
interface UndoStateDto {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly revision: number;
  readonly caret: number;
}

/** Superfície do preload consumida pelo renderer (subconjunto de `window.scribe`). */
interface ScribeBridge {
  open(path: string, signalId?: number): Promise<number>;
  openDialog(): Promise<string | null>;
  text(handle: number): Promise<string>;
  revision(handle: number): Promise<number>;
  insert(handle: number, at: number, text: string, origin?: "plugin" | "user"): Promise<number>;
  undo(handle: number): Promise<UndoStateDto>;
  redo(handle: number): Promise<UndoStateDto>;
  undoState(handle: number): Promise<UndoStateDto>;
  save(handle: number): Promise<void>;
  /**
   * Destaque de sintaxe de um range (opcional de propósito): um preload **mais antigo** que o
   * contrato atual simplesmente não a expõe — o renderer degrada para a cor default, sem crash.
   */
  highlight?(handle: number, first: number, count: number): Promise<DocumentHighlight>;
  /**
   * Busca/substituição numa lane de fundo (opcionais pelo mesmo motivo de `highlight`: um preload
   * antigo simplesmente não as expõe e o renderer desliga a find bar, sem crash).
   */
  find?(handle: number, query: SearchQuery): Promise<SearchDocumentResult>;
  replaceAll?(handle: number, query: SearchQuery, replacement: string): Promise<ReplaceAllResult>;
  cancel(signalId: number): void;
  nextSignalId(): number;
  snapshot(): Promise<unknown>;
  onDocumentChanged(callback: (event: { handle: number; revision: number }) => void): () => void;
}

function readBridge(): ScribeBridge | undefined {
  const candidate = (globalThis as { scribe?: Partial<ScribeBridge> }).scribe;
  if (candidate === undefined) return undefined;
  // `highlight` **não** entra na guarda: exigir o método quebraria um preload antigo (achado de
  // revisão da Slice D). Quem não tiver o método só não ganha destaque (ver `bootRenderer`).
  const ready =
    typeof candidate.open === "function" &&
    typeof candidate.text === "function" &&
    typeof candidate.insert === "function" &&
    typeof candidate.undo === "function" &&
    typeof candidate.redo === "function" &&
    typeof candidate.openDialog === "function" &&
    typeof candidate.onDocumentChanged === "function";
  return ready ? (candidate as ScribeBridge) : undefined;
}

interface DocumentSession {
  readonly bridge: ScribeBridge;
  readonly handle: number;
  readonly source: DocumentLineSource;
  caret: number;
  dispose(): void;
}

/** Requisição de destaque em voo: o que o renderer pediu (a resposta tem de cobrir exatamente isto). */
export interface HighlightRequest {
  /** Identidade do documento do pedido (ver `HighlightDocumentKey`). */
  readonly docKey: HighlightDocumentKey;
  readonly revision: number;
  readonly first: number;
  readonly count: number;
}

/**
 * Identidade do **documento ativo** no renderer: o `handle` da sessão aberta (`handle:<n>`) ou
 * `"demo"` quando não há ponte. É `string` opaca para o `HighlightStore` (só compara igualdade).
 *
 * Por que a identidade é obrigatória (achado ALTO de revisão): `revision` **reinicia em 1 por
 * documento** (`src/core/buffer/store.ts`), então chavear o realce só por revisão fazia o 2º arquivo
 * aberto casar com os spans do 1º (`covers(1, …)` verdadeiro, `blocked(1)` verdadeiro) — cores
 * erradas até o 1º edit.
 */
export type HighlightDocumentKey = string;

/** Chave do documento sem sessão (o texto de demonstração). */
export const DEMO_DOCUMENT_KEY: HighlightDocumentKey = "demo";

/** Chave derivada de um `handle` de documento da ponte. */
export function documentHighlightKey(handle: number): HighlightDocumentKey {
  return `handle:${handle}`;
}

/**
 * Intervalo mínimo entre **retentativas** de uma revisão cuja resposta veio vazia (sem gramática
 * pronta ainda). Curto de propósito: as gramáticas costumam carregar em poucos milissegundos, e o
 * intervalo impede que "resposta vazia não é cobertura" vire uma requisição (que relê o documento
 * inteiro no `main`) **por frame**.
 */
export const EMPTY_HIGHLIGHT_RETRY_MS = 250;

/**
 * Teto de **tentativas** por documento+revisão depois de respostas vazias (achado MÉDIO de revisão).
 * "Sem nenhum span" **não** é o mesmo que "sem gramática": um range visível todo em branco (arquivo
 * sem tokens, `start >= lines.length` ⇒ `lines: []`) também devolve zero spans — e aí a retentativa
 * disparava a cada `EMPTY_HIGHLIGHT_RETRY_MS` **para sempre**, cada uma com um `text()` do documento
 * inteiro no `main`. Esgotado o teto, a revisão entra em `blocked` **definitivo** (degrada à cor
 * default, com **um** `console.warn`): custo explicitamente limitado. Um edit muda a revisão e
 * reabre a tentativa.
 */
export const EMPTY_HIGHLIGHT_MAX_ATTEMPTS = 4;

/**
 * Corte **defensivo** do backoff das retentativas (dobra por tentativa). Com
 * `EMPTY_HIGHLIGHT_MAX_ATTEMPTS = 4` este corte é **inalcançável**: a 4ª resposta vazia já chama
 * `markFailed` **antes** de agendar o retry, então o backoff efetivo é `250 → 500 → 1000` ms
 * (`backoffMs` só é chamado com `attempts` ∈ {1, 2, 3}) — ver teste de backoff efetivo. Mantido como
 * guarda para o caso de o teto de tentativas subir.
 */
export const EMPTY_HIGHLIGHT_RETRY_MAX_MS = 2_000;

/**
 * Timeout do slot de requisição **em voo** (achado BAIXO de revisão): uma promise da ponte que nunca
 * resolve deixaria aquela revisão deduplicada para sempre (realce desligado em silêncio). Passado o
 * timeout o slot é liberado e a revisão é tratada como **falha** (mesma degradação explícita acima).
 * Folgado de propósito: uma resposta lenta de verdade (tokenização de um arquivo grande no `main`)
 * não deve virar falha — ver risco aberto de teto de tokenização em `docs/BACKLOG.md` §P2.4b.
 */
export const IN_FLIGHT_HIGHLIGHT_TIMEOUT_MS = 10_000;

/**
 * Resposta "vazia" = nenhum span em nenhuma linha. Cobre tanto `lines` com `spans: []` (o `main`
 * tokeniza antes de as gramáticas carregarem) quanto `lines: []` (range fora do documento).
 */
function isEmptyHighlight(highlight: DocumentHighlight): boolean {
  for (const line of highlight.lines) {
    if (line.spans.length > 0) return false;
  }
  return true;
}

/**
 * Cache de spans por linha no renderer (a resposta do IPC `syntax.highlight`). Guarda o realce do
 * **documento ativo** (`docKey`) **na revisão** dele e só serve o que cobriu o range pedido — quem
 * não estiver coberto cai na cor default e um novo pedido é disparado (a resposta volta e redesenha).
 *
 * Guardas (achados de revisão):
 * - **identidade do documento** (achado ALTO): todo estado é chaveado por `docKey` + `revision`.
 *   Trocar de documento (`activate` com chave nova) **descarta** spans, `failed`, `warned`, `inFlight`
 *   e o estado de retentativa — o `revision` do arquivo novo reinicia em 1 e não pode herdar nada do
 *   anterior. `spansFor` é uma leitura **pura** e devolve `undefined` para chave alheia (nem um frame
 *   do documento novo pinta com os spans do antigo);
 * - `set` só aceita a resposta que **casa com a requisição** que a originou (mesmo documento, mesma
 *   revisão e range cobrindo o pedido): resposta fora de ordem — ou de um documento já trocado — é
 *   descartada em vez de virar cobertura inválida;
 * - `markFailed` lembra a falha **daquele documento+revisão** (`blocked`) e loga **no máximo uma
 *   vez** — gramática que registra e não compila não dispara IPC + `console.warn` por frame;
 * - resposta **sem nenhum span** **não** vira cobertura (senão a tela ficaria sem realce para
 *   sempre), mas a retentativa tem **teto**: `EMPTY_HIGHLIGHT_MAX_ATTEMPTS` com backoff exponencial
 *   de `250/500/1000` ms (o corte `EMPTY_HIGHLIGHT_RETRY_MAX_MS` não chega a agir; ver a constante),
 *   e depois disso a revisão fica `blocked` de forma definitiva —
 *   "sem span" também acontece em range em branco, que nunca vai virar realce;
 * - requisição **em voo** deduplica por documento+revisão (N frames antes da 1ª resposta geram **1**
 *   IPC) com `IN_FLIGHT_HIGHLIGHT_TIMEOUT_MS`: promise que nunca resolve não deduplica para sempre.
 */
export class HighlightStore {
  private docKey: HighlightDocumentKey | undefined;
  private revision = -1;
  private first = 0;
  private count = 0;
  private spans: (readonly HighlightSpan[] | undefined)[] = [];
  private failedRevision = -1;
  private warnedRevision = -1;
  private inFlightRevision = -1;
  private inFlightSince = 0;
  private emptyRevision = -1;
  private emptyAttempts = 0;
  private emptyRetryAt = 0;

  /** `now` é injetável para os testes de retentativa/timeout (`EMPTY_HIGHLIGHT_*`, `IN_FLIGHT_*`). */
  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Fixa o documento ativo em `docKey`; se a identidade mudou, **descarta todo o estado** do
   * documento anterior (spans, falha, aviso já dado, requisição em voo e retentativas).
   */
  private activate(docKey: HighlightDocumentKey): void {
    if (this.docKey === docKey) return;
    this.docKey = docKey;
    this.resetState();
  }

  /**
   * Descarta **todo** o estado e volta a "nenhum documento ativo" (a próxima resposta decide o dono:
   * `set` adota a requisição). Usado quando a `LineSource` é trocada no dev-seam: a identidade do
   * documento vem do `controller`, não da fonte anexada, então os spans do documento anterior não
   * podem pintar o texto novo.
   */
  invalidate(): void {
    this.docKey = undefined;
    this.resetState();
  }

  private resetState(): void {
    this.revision = -1;
    this.first = 0;
    this.count = 0;
    this.spans = [];
    this.failedRevision = -1;
    this.warnedRevision = -1;
    this.inFlightRevision = -1;
    this.inFlightSince = 0;
    this.emptyRevision = -1;
    this.emptyAttempts = 0;
    this.emptyRetryAt = 0;
  }

  /**
   * Armazena a resposta **se** ela casar com `request`; devolve `false` quando descarta (documento
   * já trocado, revisão diferente, resposta fora de ordem, range que não cobre o pedido ou resposta
   * sem nenhum span).
   */
  set(highlight: DocumentHighlight, request: HighlightRequest): boolean {
    // Store novo (nenhum documento ativo ainda) adota a requisição; store já ligado a **outro**
    // documento descarta — resposta atrasada do arquivo anterior não reativa o estado dele.
    if (this.docKey === undefined) this.activate(request.docKey);
    if (this.docKey !== request.docKey) return false;
    if (highlight.revision !== request.revision) return false;
    const responseEnd = highlight.first + highlight.lines.length;
    const requestEnd = request.first + request.count;
    if (highlight.first > request.first || responseEnd < requestEnd) return false;
    if (this.revision !== -1 && highlight.revision < this.revision) return false;
    if (isEmptyHighlight(highlight)) {
      // Sem gramática pronta o main devolve o range pedido com `spans` vazios: registra a janela de
      // retentativa e **não** marca cobertura, para uma resposta posterior (já com gramática) valer.
      // A contagem é **por revisão**: um edit recomeça o teto (evita bloquear a revisão nova pelo
      // histórico da antiga).
      if (this.emptyRevision !== highlight.revision) {
        this.emptyRevision = highlight.revision;
        this.emptyAttempts = 0;
      }
      this.emptyAttempts += 1;
      if (this.emptyAttempts >= EMPTY_HIGHLIGHT_MAX_ATTEMPTS) {
        // Degradação explícita e definitiva: sem span depois do teto, parar de reler o documento.
        this.markFailed(
          request.docKey,
          highlight.revision,
          `sem spans após ${this.emptyAttempts} tentativas`,
        );
        return false;
      }
      this.emptyRetryAt = this.now() + this.backoffMs(this.emptyAttempts);
      return false;
    }
    this.revision = highlight.revision;
    this.first = highlight.first;
    this.count = highlight.lines.length;
    this.spans = [];
    for (const line of highlight.lines) this.spans[line.line] = line.spans;
    // Resposta boa da mesma revisão: se ela estava marcada como falha (ex.: timeout do slot), o
    // realce voltou a funcionar — libera a revisão para pedir os ranges seguintes.
    if (this.failedRevision === highlight.revision) this.failedRevision = -1;
    this.emptyRevision = -1;
    this.emptyAttempts = 0;
    this.emptyRetryAt = 0;
    return true;
  }

  /**
   * Spans da linha **se** forem do documento `docKey` (leitura pura, sem efeito colateral: é o que o
   * desenho chama a cada frame — não pode ativar/invalidar nada).
   */
  spansFor(docKey: HighlightDocumentKey, line: number): readonly HighlightSpan[] | undefined {
    if (this.docKey !== docKey) return undefined;
    return this.spans[line];
  }

  covers(docKey: HighlightDocumentKey, revision: number, first: number, count: number): boolean {
    this.activate(docKey);
    return (
      this.revision === revision && first >= this.first && first + count <= this.first + this.count
    );
  }

  /** Já falhou nesta revisão (deste documento)? Então nem tenta de novo (nada de IPC em loop). */
  blocked(docKey: HighlightDocumentKey, revision: number): boolean {
    this.activate(docKey);
    return this.failedRevision === revision;
  }

  /**
   * Vale a pena pedir este range? `false` = bloqueado (falhou ou esgotou o teto de retentativas), já
   * coberto, com requisição **em voo** para a mesma revisão (dedupe) ou dentro da janela de
   * retentativa pós-resposta-vazia. O slot em voo vencido (`IN_FLIGHT_HIGHLIGHT_TIMEOUT_MS`) é
   * liberado aqui e a revisão é marcada como falha.
   */
  needsRequest(
    docKey: HighlightDocumentKey,
    revision: number,
    first: number,
    count: number,
  ): boolean {
    this.activate(docKey);
    if (this.failedRevision === revision) return false;
    if (this.inFlightRevision === revision) {
      if (this.now() - this.inFlightSince < IN_FLIGHT_HIGHLIGHT_TIMEOUT_MS) return false;
      // Promise da ponte que não resolveu: libera o slot/dedupe e degrada explicitamente.
      this.inFlightRevision = -1;
      this.inFlightSince = 0;
      this.markFailed(
        docKey,
        revision,
        `requisição em voo sem resposta após ${IN_FLIGHT_HIGHLIGHT_TIMEOUT_MS} ms`,
      );
      return false;
    }
    if (this.covers(docKey, revision, first, count)) return false;
    if (this.emptyRevision === revision && this.now() < this.emptyRetryAt) return false;
    return true;
  }

  /** Marca a requisição da revisão como **em voo** (ver `needsRequest`). */
  beginRequest(docKey: HighlightDocumentKey, revision: number): void {
    this.activate(docKey);
    this.inFlightRevision = revision;
    this.inFlightSince = this.now();
  }

  /** Libera a requisição em voo (sucesso, falha ou resposta descartada). */
  endRequest(docKey: HighlightDocumentKey, revision: number): void {
    // Sem `activate`: a resolução atrasada do documento anterior não pode retomar o estado dele.
    if (this.docKey !== docKey) return;
    if (this.inFlightRevision === revision) {
      this.inFlightRevision = -1;
      this.inFlightSince = 0;
    }
  }

  /**
   * Marca a falha da revisão e loga **uma única vez** por documento+revisão (degradação explícita,
   * DEC-TR-7).
   */
  markFailed(docKey: HighlightDocumentKey, revision: number, error?: unknown): void {
    this.activate(docKey);
    this.failedRevision = revision;
    if (this.warnedRevision === revision) return;
    this.warnedRevision = revision;
    console.warn("Scribe: destaque de sintaxe indisponível (degradando à cor default)", error);
  }

  /**
   * Backoff exponencial das retentativas (dobra por tentativa, cortado em
   * `EMPTY_HIGHLIGHT_RETRY_MAX_MS`). Com `EMPTY_HIGHLIGHT_MAX_ATTEMPTS = 4` só `attempts` ∈ {1, 2, 3}
   * chegam aqui ⇒ backoff efetivo `250/500/1000` ms.
   */
  private backoffMs(attempts: number): number {
    return Math.min(EMPTY_HIGHLIGHT_RETRY_MS * 2 ** (attempts - 1), EMPTY_HIGHLIGHT_RETRY_MAX_MS);
  }
}

function documentPath(): string | undefined {
  const fromQuery = new URLSearchParams(window.location.search).get("file");
  return fromQuery !== null && fromQuery.length > 0 ? fromQuery : undefined;
}

/**
 * Controlador do documento no renderer: mantém a sessão ativa, abre arquivos (boot por `?file=`,
 * diálogo nativo) e faz undo/redo e digitação — sempre relendo o texto inteiro do documento (o
 * seam mínimo do slice). A abertura é **cancelável** por `signalId` (DEC-IPC-9): trocar de arquivo
 * (ou Esc) aborta a abertura anterior.
 */
class DocumentController {
  private session: DocumentSession | undefined;
  private opening: { readonly signalId: number; readonly path: string } | undefined;

  constructor(
    private readonly bridge: ScribeBridge,
    private readonly source: DocumentLineSource,
    private readonly viewport: ViewportImpl,
    private readonly renderer: ScribeRenderer,
  ) {}

  get current(): DocumentSession | undefined {
    return this.session;
  }

  /** Aborta a abertura em curso (se houver). `true` = havia uma para cancelar. */
  cancelOpening(): boolean {
    const opening = this.opening;
    if (opening === undefined) return false;
    this.opening = undefined;
    this.bridge.cancel(opening.signalId);
    setDocStatus(`abertura cancelada: ${opening.path}`);
    return true;
  }

  /** Abre `path`, cancelando qualquer abertura anterior. `true` = documento ligado. */
  async open(path: string): Promise<boolean> {
    this.cancelOpening();
    const signalId = this.bridge.nextSignalId();
    this.opening = { signalId, path };
    setDocStatus(`abrindo: ${path}…`);

    let handle: number;
    try {
      handle = await this.bridge.open(path, signalId);
    } catch (error) {
      if (this.opening?.signalId === signalId) {
        this.opening = undefined;
        setDocStatus(`falha ao abrir: ${path}`);
        console.warn(`Scribe: falha ao abrir "${path}"`, error);
      }
      return false;
    }
    if (this.opening?.signalId !== signalId) return false; // cancelado ou substituído

    this.opening = undefined;
    this.detachSession();
    const revision = await this.bridge.revision(handle);
    this.source.setText(await this.bridge.text(handle), revision);
    this.viewport.setMetrics({ lineCount: this.source.lineCount() });
    const unsubscribe = this.bridge.onDocumentChanged((event) => {
      if (event.handle !== handle) return;
      void this.bridge.text(handle).then((next) => {
        this.source.setText(next, event.revision);
        this.viewport.setMetrics({ lineCount: this.source.lineCount() });
        setDirtyStatus(true);
        this.renderer.start();
      });
    });
    this.session = {
      bridge: this.bridge,
      handle,
      source: this.source,
      caret: 0,
      dispose: unsubscribe,
    };
    setDocStatus(path);
    updateCaretStatus(this.source, 0);
    await this.refreshUndoStatus();
    this.renderer.start();
    console.info(`Scribe: documento ligado via preload "${path}" (handle ${handle})`);
    return true;
  }

  /** Abre o diálogo nativo; se o usuário escolher um arquivo, abre-o. */
  async openDialog(): Promise<boolean> {
    const path = await this.bridge.openDialog();
    if (path === null || path.length === 0) return false;
    return this.open(path);
  }

  /**
   * Pede o destaque de um range de linhas do documento atual (o main tokeniza e devolve spans).
   * `null` = sem sessão, sem suporte na ponte (preload antigo) ou falha — nesse caso o renderer
   * degrada para a cor default; o log é consolidado no `HighlightStore` (**um** por revisão).
   * Rejeita se a ponte falhar (quem chama trata e marca a revisão como falha).
   */
  async loadHighlight(first: number, count: number): Promise<DocumentHighlight | null> {
    const session = this.session;
    if (session === undefined || count <= 0) return null;
    const highlight = session.bridge.highlight;
    // Preload antigo (sem `syntax.highlight`): degrada explicitamente, sem crash (DEC-TR-7).
    if (highlight === undefined) return null;
    return highlight.call(session.bridge, session.handle, first, count);
  }

  async undo(): Promise<void> {
    await this.runHistory("undo");
  }

  async redo(): Promise<void> {
    await this.runHistory("redo");
  }

  /** Digitação mínima: insere no caret e relê o documento. */
  async insertText(text: string): Promise<void> {
    const session = this.session;
    if (session === undefined) return;
    try {
      const revision = await session.bridge.insert(session.handle, session.caret, text, "user");
      session.caret += text.length;
      const next = await session.bridge.text(session.handle);
      session.source.setText(next, revision);
      this.viewport.setMetrics({ lineCount: session.source.lineCount() });
      updateCaretStatus(session.source, session.caret);
      await this.refreshUndoStatus();
      this.renderer.start();
    } catch (error) {
      console.error("Scribe: falha ao inserir texto no documento", error);
    }
  }

  private async runHistory(action: "undo" | "redo"): Promise<void> {
    const session = this.session;
    if (session === undefined) return;
    try {
      const state =
        action === "undo"
          ? await session.bridge.undo(session.handle)
          : await session.bridge.redo(session.handle);
      const next = await session.bridge.text(session.handle);
      session.source.setText(next, state.revision);
      session.caret = Math.min(state.caret, next.length);
      this.viewport.setMetrics({ lineCount: session.source.lineCount() });
      updateCaretStatus(session.source, session.caret);
      setUndoStatus(state.canUndo, state.canRedo);
      this.renderer.start();
    } catch (error) {
      console.error(`Scribe: falha ao ${action === "undo" ? "desfazer" : "refazer"}`, error);
    }
  }

  private async refreshUndoStatus(): Promise<void> {
    const session = this.session;
    if (session === undefined) {
      setUndoStatus(false, false);
      return;
    }
    try {
      const state = await session.bridge.undoState(session.handle);
      setUndoStatus(state.canUndo, state.canRedo);
    } catch {
      setUndoStatus(false, false);
    }
  }

  private detachSession(): void {
    this.session?.dispose();
    this.session = undefined;
  }

  async save(): Promise<void> {
    const session = this.session;
    if (session === undefined) return;
    try {
      await session.bridge.save(session.handle);
      setDirtyStatus(false);
    } catch (error) {
      console.error("Scribe: falha ao salvar", error);
      setDocStatus(`erro ao salvar: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// ---- demo (fallback sem documento) --------------------------------------------------------------

function demoText(): string {
  const lines = Array.from({ length: DEMO_LINE_COUNT }, (_, i) => {
    const n = String(i + 1).padStart(4, " ");
    if (i % 40 === 0) return `${n}  // ---- bloco ${i / 40 + 1} — Scribe (Canvas2D/WebGPU) ----`;
    if (i % 13 === 3) return `${n}  const linha = ${n}; // tela virtualizada: só o visível é desenhado`;
    return `${n}  linha de demonstração do pipeline de render (scroll: roda do mouse / setas)`;
  });
  return lines.join("\n");
}

// ---- app ------------------------------------------------------------------------------------------

class ScribeRenderer {
  private source: LineSource;
  private readonly style = TEXT_STYLE;
  private readonly dpr: number;
  private viewportWidth = 1;
  private viewportHeight = 1;
  private rafHandle = 0;
  private running = false;
  private highlighter: SceneHighlight | undefined;
  private requestHighlight: ((first: number, count: number) => void) | undefined;
  private searchHighlightValue: SearchHighlight | undefined;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly atlas: GlyphAtlas,
    private readonly pipeline: RenderPipeline,
    private readonly viewport: ViewportImpl,
    source: LineSource,
  ) {
    this.source = source;
    this.dpr = window.devicePixelRatio || 1;
  }

  /** Liga o destaque de sintaxe (spans por linha) e o gatilho para buscá-lo quando faltar. */
  setHighlighter(highlighter: SceneHighlight, request: (first: number, count: number) => void): void {
    this.highlighter = highlighter;
    this.requestHighlight = request;
  }

  /** Define as ocorrências de busca a destacar no canvas (P3.11). */
  setSearchMatches(highlight: SearchHighlight | undefined): void {
    this.searchHighlightValue = highlight;
  }

  attachSource(source: LineSource): void {
    this.source = source;
    this.viewport.setMetrics({ lineCount: source.lineCount() });
    this.viewport.scrollTo(0);
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.viewportWidth = Math.max(1, Math.floor(cssWidth));
    this.viewportHeight = Math.max(1, Math.floor(cssHeight));
    this.canvas.width = Math.floor(this.viewportWidth * this.dpr);
    this.canvas.height = Math.floor(this.viewportHeight * this.dpr);
    if (this.pipeline instanceof Canvas2DBackend) {
      this.pipeline.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    this.viewport.setMetrics({ viewportWidth: this.viewportWidth, viewportHeight: this.viewportHeight });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.rafHandle = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    if (this.rafHandle !== 0) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  private readonly frame = (): void => {
    if (!this.running) return;
    this.renderOnce();
    this.rafHandle = requestAnimationFrame(this.frame);
  };

  private renderOnce(): void {
    const viewportRect = { x: 0, y: 0, w: this.viewportWidth, h: this.viewportHeight };
    const range = this.viewport.visibleLineRange();
    const layout: LineLayout = {
      lineHeight: this.lineHeight(),
      paddingLeft: 12,
      paddingTop: 8,
      tabWidth: 4,
      scrollOffsetPx: this.viewport.scrollOffsetPx(),
      viewport: viewportRect,
      background: COLORS.background,
      defaultColor: COLORS.text,
    };
    const scene = buildInstances(
      this.source,
      layout,
      this.atlas,
      this.style,
      range,
      {
        line: Math.floor(this.viewport.scrollOffsetPx() / layout.lineHeight),
        column: 0,
        color: COLORS.caret,
        width: 2,
      },
      this.highlighter,
      this.searchHighlightValue,
    );
    this.requestHighlight?.(range.first, range.count);

    // Damage da viewport → limpeza seletiva no beginFrame → desenho → present (DEC-REN-4).
    const damage = this.viewport.takeDamage();
    this.pipeline.invalidate(damage);
    this.pipeline.beginFrame(viewportRect);
    this.pipeline.pushRects(scene.rects);
    this.pipeline.pushLines(scene.lines);
    for (let i = 0; i < scene.glyphs.length; i += GLYPH_CHUNK) {
      this.pipeline.pushGlyphs(scene.glyphs.slice(i, i + GLYPH_CHUNK));
      this.pipeline.flush();
    }
    this.pipeline.present(damage);
  }

  private lineHeight(): number {
    return Math.ceil(this.style.sizePx * 1.4);
  }
}

function setStatus(text: string): void {
  const status = document.getElementById("status-backend");
  if (status) status.textContent = `backend: ${text}`;
}

function setDocStatus(text: string): void {
  const status = document.getElementById("status-doc");
  if (status) status.textContent = text;
}

function setDirtyStatus(dirty: boolean): void {
  const el = document.getElementById("status-dirty");
  if (!el) return;
  el.textContent = dirty ? "● modificado" : "";
  el.classList.toggle("dirty", dirty);
}

function updateCaretStatus(source: DocumentLineSource, offset: number): void {
  const status = document.getElementById("status-caret");
  if (!status) return;
  const position = source.positionAt(offset);
  status.textContent = `${position.line + 1}:${position.column + 1}`;
}

/** Reflete a disponibilidade de undo/redo na status bar (habilitado/desabilitado). */
function setUndoStatus(canUndo: boolean, canRedo: boolean): void {
  const undo = document.getElementById("status-undo");
  if (undo) {
    undo.textContent = "↶ undo";
    undo.classList.toggle("disabled", !canUndo);
  }
  const redo = document.getElementById("status-redo");
  if (redo) {
    redo.textContent = "↷ redo";
    redo.classList.toggle("disabled", !canRedo);
  }
}

/**
 * Boot do renderer. **Guardado**: sem `document`/canvas (ex.: ambiente `node` de teste) devolve
 * `false` **sem** lançar e **sem** agendar frame — o loop nunca sobe fora do navegador.
 */
export async function bootRenderer(): Promise<boolean> {
  if (typeof document === "undefined" || typeof HTMLCanvasElement === "undefined") return false;
  const surface = document.getElementById("editor-surface");
  if (!(surface instanceof HTMLCanvasElement)) return false;

  const requested = resolveBackendKind();
  const { surface: atlasSurface, canvas: atlasCanvas } = createAtlasSurface(1024);
  const atlas = new GlyphAtlas({
    size: 1024,
    rasterizer: createCanvasRasterizer(),
    measurer: createCanvasMeasurer(),
    surface: atlasSurface,
  });

  let pipeline: RenderPipeline;
  let effective: string = DEFAULT_RENDER_BACKEND;
  if (requested === "webgpu") {
    try {
      pipeline = await WebGPUBackend.create(surface, atlas);
      effective = "webgpu";
    } catch (error) {
      if (!(error instanceof WebGPUUnavailableError)) throw error;
      // DEC-TR-7: degradação DECLARADA e logada — nunca *fallback* silencioso.
      console.warn(`Scribe: webgpu indisponível, usando canvas2d — ${error.reason}`);
      pipeline = new Canvas2DBackend(assertiveContext(surface), atlas, { image: atlasCanvas });
      effective = "canvas2d (fallback de webgpu)";
    }
  } else {
    pipeline = new Canvas2DBackend(assertiveContext(surface), atlas, { image: atlasCanvas });
  }

  setStatus(effective);
  console.info(`Scribe: backend efetivo = ${effective} (pedido: ${requested})`);

  const source = new DocumentLineSource();
  const viewport = new ViewportImpl({
    lineCount: source.lineCount(),
    lineHeight: Math.ceil(TEXT_STYLE.sizePx * 1.4),
    viewportHeight: surface.clientHeight || 1,
    viewportWidth: surface.clientWidth || 1,
    overscan: 2,
    now: (): number => performance.now(),
    requestFrame: (cb): Disposable => {
      const handle = requestAnimationFrame((time) => cb(time));
      return toDisposable(() => cancelAnimationFrame(handle));
    },
    scrollDurationMs: 120,
  });

  const renderer = new ScribeRenderer(surface, atlas, pipeline, viewport, source);
  renderer.resize(surface.clientWidth || 800, surface.clientHeight || 600);

  const bridge = readBridge();
  const controller =
    bridge !== undefined
      ? new DocumentController(bridge, source, viewport, renderer)
      : undefined;

  // Destaque de sintaxe: o main resolve a gramática e tokeniza; aqui só colorimos (ThemeResolver).
  const highlightStore = new HighlightStore();
  const theme = createDefaultTheme();
  // Preload antigo sem `syntax.highlight`: realce desligado de forma explícita (uma linha de log).
  const canHighlight = bridge?.highlight !== undefined;
  if (bridge !== undefined && !canHighlight) {
    console.info("Scribe: ponte sem `syntax.highlight` — realce desligado (cor default)");
  }
  /**
   * Identidade do documento ativo: o `handle` da sessão aberta (muda a cada abertura) ou a chave de
   * demo sem ponte. Sem ela o realce do arquivo anterior casaria com a revisão 1 do arquivo novo.
   */
  const activeDocumentKey = (): HighlightDocumentKey =>
    controller?.current === undefined
      ? DEMO_DOCUMENT_KEY
      : documentHighlightKey(controller.current.handle);

  renderer.setHighlighter(
    { spansFor: (line) => highlightStore.spansFor(activeDocumentKey(), line), theme },
    (first, count) => {
      if (controller === undefined || !canHighlight) return;
      const docKey = activeDocumentKey();
      const revision = source.revision;
      // Falhou nesta revisão, já coberto, requisição **em voo** para a mesma revisão (dedupe), teto de
      // retentativas esgotado ou janela pós-resposta-vazia: não dispara IPC.
      if (!highlightStore.needsRequest(docKey, revision, first, count)) return;
      const request: HighlightRequest = { docKey, revision, first, count };
      highlightStore.beginRequest(docKey, revision);
      void controller.loadHighlight(first, count).then(
        (highlight) => {
          highlightStore.endRequest(docKey, revision);
          if (highlight === null || !highlightStore.set(highlight, request)) return;
          renderer.start();
        },
        // Falha (ex.: gramática que registra e não compila): marca a revisão e loga uma vez.
        (error: unknown) => {
          highlightStore.endRequest(docKey, revision);
          highlightStore.markFailed(docKey, revision, error);
        },
      );
    },
  );

  const initialPath = documentPath();
  let opened = false;
  if (controller !== undefined && initialPath !== undefined) {
    opened = await controller.open(initialPath);
  } else if (bridge !== undefined) {
    console.info("Scribe: ponte do preload presente, mas sem ?file= — renderer em modo demo");
  }
  if (!opened) {
    source.setText(demoText(), 0);
    viewport.setMetrics({ lineCount: source.lineCount() });
    if (initialPath === undefined) {
      setDocStatus(bridge === undefined ? "demo (sem preload)" : "demo (sem ?file=)");
    }
  }

  const globalScope = globalThis as { attachLineSource?: (source: LineSource) => void };
  globalScope.attachLineSource = (next: LineSource): void => {
    // Dev-seam: a identidade do documento ativo vem do `controller` (não da fonte anexada), então
    // trocar a fonte sem invalidar o store pintaria os spans do documento anterior no texto novo.
    highlightStore.invalidate();
    renderer.attachSource(next);
  };

  const findBar =
    bridge !== undefined && controller !== undefined
      ? attachFindBar({ bridge, controller, source, viewport, renderer, surface })
      : undefined;

  attachInputListeners(surface, viewport, renderer, controller, findBar);
  window.addEventListener("resize", () => renderer.resize(surface.clientWidth, surface.clientHeight));
  renderer.start();
  return true;
}

function assertiveContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Scribe: contexto 2D indisponível no #editor-surface");
  return ctx;
}

/**
 * Ligação find bar ↔ renderer: o modelo puro + a sincronização de documento ativo (abrir um
 * arquivo troca o alvo; o modelo precisa saber para descartar respostas do documento anterior).
 */
export interface FindBarBinding {
  readonly model: FindBarModel;
  /** Re-sincroniza documento/revisão ativos (após abrir arquivo e antes de buscar). */
  syncDocument(): void;
}

interface FindBarDeps {
  readonly bridge: ScribeBridge;
  readonly controller: DocumentController;
  readonly source: DocumentLineSource;
  readonly viewport: ViewportImpl;
  readonly renderer: ScribeRenderer;
  readonly surface: HTMLCanvasElement;
}

/**
 * Liga o `FindBarModel` ao DOM. Devolve `undefined` quando a ponte não expõe `find`/`replaceAll`
 * (preload antigo) ou falta markup — degradação **explícita** (um log), nunca crash (DEC-TR-7).
 * Toda a lógica (debounce injetado, navegação, descarte de resposta obsoleta) vive no modelo puro.
 */
export function attachFindBar(deps: FindBarDeps): FindBarBinding | undefined {
  const find = deps.bridge.find;
  const replaceAll = deps.bridge.replaceAll;
  const bar = document.getElementById("find-bar");
  const input = document.getElementById("find-input");
  const count = document.getElementById("find-count");
  const replaceInput = document.getElementById("find-replace-input");
  const replaceButton = document.getElementById("find-replace-all");
  const status = document.getElementById("find-status");
  const closeButton = document.getElementById("find-close");
  if (
    find === undefined ||
    replaceAll === undefined ||
    bar === null ||
    !(input instanceof HTMLInputElement) ||
    count === null ||
    !(replaceInput instanceof HTMLInputElement) ||
    !(replaceButton instanceof HTMLButtonElement) ||
    status === null ||
    !(closeButton instanceof HTMLButtonElement)
  ) {
    console.info("Scribe: find bar desligada (ponte sem busca ou markup ausente)");
    return undefined;
  }

  const currentHandle = (): number | undefined => deps.controller.current?.handle;

  const api: FindBarApi = {
    find: (query: SearchQuery): Promise<SearchDocumentResult> => {
      const handle = currentHandle();
      if (handle === undefined) {
        return Promise.reject(new Error("Scribe: nenhum documento aberto para buscar"));
      }
      return find.call(deps.bridge, handle, query);
    },
    replaceAll: (query: SearchQuery, replacement: string): Promise<ReplaceAllResult> => {
      const handle = currentHandle();
      if (handle === undefined) {
        return Promise.reject(new Error("Scribe: nenhum documento aberto para substituir"));
      }
      return replaceAll.call(deps.bridge, handle, query, replacement);
    },
  };

  let currentDocKey = "";
  const renderState = (state: FindBarState): void => {
    bar.hidden = !state.open;
    count.textContent = `${state.current}/${state.total}${state.truncated ? "+" : ""}`;
    status.textContent = state.status ?? "";
    // Empurra os matches pro renderer pintar no canvas (P3.11).
    if (state.open && model.allMatches.length > 0) {
      deps.renderer.setSearchMatches({
        matches: model.allMatches,
        currentIndex: model.currentMatchIndex,
      });
    } else {
      deps.renderer.setSearchMatches(undefined);
    }
    // Dispara um novo frame pra pintar os destaques.
    deps.renderer.start();
  };

  // Selecionar uma ocorrência move o caret (coluna do início) e rola até a linha dela.
  const moveCaretTo = (match: SearchMatch): void => {
    const session = deps.controller.current;
    if (session === undefined) return;
    session.caret = Math.min(match.index, session.source.text.length);
    updateCaretStatus(session.source, session.caret);
    deps.viewport.scrollTo(match.line);
    deps.renderer.start();
  };

  const model = new FindBarModel({
    api,
    schedule: createDebounceScheduler(),
    onChange: renderState,
    onSelect: moveCaretTo,
  });

  const syncDocument = (): void => {
    const session = deps.controller.current;
    if (session === undefined) return;
    currentDocKey = documentHighlightKey(session.handle);
    model.setDocument(currentDocKey, session.source.revision);
  };

  const openFind = (): void => {
    syncDocument();
    model.open();
    input.focus();
    input.select();
  };

  input.addEventListener("input", () => model.setPattern(input.value));
  replaceInput.addEventListener("input", () => model.setReplacement(replaceInput.value));
  replaceButton.addEventListener("click", () => void model.replaceAll());
  closeButton.addEventListener("click", () => {
    model.close();
    deps.surface.focus();
  });
  bar.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      model.close();
      deps.surface.focus();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) model.previous();
      else model.next();
    }
  });
  // Ctrl/Cmd+F em qualquer lugar da janela: a barra pode estar focada, não só o canvas.
  document.addEventListener("keydown", (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === "f" || event.key === "F")) {
      event.preventDefault();
      openFind();
    }
  });
  // Edição muda a revisão: o modelo descarta a resposta de revisão superada e refaz a contagem.
  deps.bridge.onDocumentChanged((event) => {
    const session = deps.controller.current;
    if (session === undefined || event.handle !== session.handle) return;
    currentDocKey = documentHighlightKey(session.handle);
    model.setDocument(currentDocKey, event.revision);
  });

  syncDocument();
  renderState(model.state());
  return { model, syncDocument };
}

function attachInputListeners(
  surface: HTMLCanvasElement,
  viewport: ViewportImpl,
  renderer: ScribeRenderer,
  controller: DocumentController | undefined,
  findBar: FindBarBinding | undefined,
): void {
  const lineHeight = Math.ceil(TEXT_STYLE.sizePx * 1.4);
  const currentLine = (): number => Math.floor(viewport.scrollOffsetPx() / lineHeight);

  surface.addEventListener(
    "wheel",
    (event: WheelEvent) => {
      event.preventDefault();
      viewport.scrollTo(currentLine() + Math.sign(event.deltaY) * 3);
    },
    { passive: false },
  );

  surface.addEventListener("keydown", (event: KeyboardEvent) => {
    const primary = event.ctrlKey || event.metaKey;

    // Atalhos de documento: Ctrl/Cmd+O (abrir), Ctrl/Cmd+Z (undo), Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y
    // (redo) e Esc durante "abrindo…" (cancela a abertura em curso).
    if (primary && !event.altKey && (event.key === "o" || event.key === "O")) {
      event.preventDefault();
      // Abrir troca o documento ativo: re-sincroniza a find bar com o novo alvo.
      if (controller !== undefined) void controller.openDialog().then(() => findBar?.syncDocument());
      return;
    }
    if (primary && !event.altKey && !event.shiftKey && (event.key === "z" || event.key === "Z")) {
      event.preventDefault();
      if (controller !== undefined) void controller.undo();
      return;
    }
    if (
      primary &&
      !event.altKey &&
      ((event.shiftKey && (event.key === "z" || event.key === "Z")) ||
        event.key === "y" ||
        event.key === "Y")
    ) {
      event.preventDefault();
      if (controller !== undefined) void controller.redo();
      return;
    }
    if (primary && !event.altKey && !event.shiftKey && (event.key === "s" || event.key === "S")) {
      event.preventDefault();
      void controller?.save();
      return;
    }
    if (event.key === "Escape") {
      // Esc fecha a find bar primeiro (se aberta); só depois é que cancela uma abertura em curso.
      if (findBar !== undefined && findBar.model.isOpen) {
        event.preventDefault();
        findBar.model.close();
        return;
      }
      if (controller !== undefined && controller.cancelOpening()) {
        event.preventDefault();
        return;
      }
    }

    const page = Math.max(1, Math.floor(surface.clientHeight / lineHeight) - 1);
    const line = viewport.visibleLineRange();
    if (event.key === "PageDown") viewport.scrollTo(currentLine() + page, { animate: true });
    else if (event.key === "PageUp") viewport.scrollTo(currentLine() - page, { animate: true });
    else if (event.key === "Home") viewport.scrollTo(0, { animate: true });
    else if (event.key === "End") viewport.scrollTo(line.first + 1_000_000, { animate: true });
    else if (controller !== undefined && controller.current !== undefined && isPrintable(event)) {
      event.preventDefault();
      void controller.insertText(event.key);
      return;
    } else return;
    event.preventDefault();
    renderer.start();
  });
}

/** Tecla imprimível (um code point, sem modificadores) — a porta da digitação mínima. */
function isPrintable(event: KeyboardEvent): boolean {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

// Autostart só no navegador: em `node`/vitest o módulo é apenas importável (sem DOM, sem throw).
if (typeof document !== "undefined") {
  void bootRenderer().catch((error: unknown) => {
    console.error("Scribe: falha no boot do renderer", error);
  });
}
