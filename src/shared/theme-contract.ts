/**
 * Scribe — contrato de temas do editor (cores da UI, não só sintaxe).
 *
 * Define o conjunto completo de cores que um tema pode personalizar.
 * Inspirado no formato .sublime-color-scheme, mas simplificado.
 */
import type { RGBA } from "./render-contract";

/** Paleta completa de cores do editor. */
export interface EditorTheme {
  readonly name: string;
  /** `"dark"` ou `"light"` — usado para ajustar comportamento de seleção/scrollbar. */
  readonly kind: "dark" | "light";
  readonly colors: {
    readonly background: RGBA;
    readonly foreground: RGBA;
    readonly caret: RGBA;
    readonly gutter: RGBA;
    readonly gutterForeground: RGBA;
    readonly selection: RGBA;
    readonly searchMatch: RGBA;
    readonly searchCurrent: RGBA;
    readonly scrollbarTrack: RGBA;
    readonly scrollbarThumb: RGBA;
    readonly lineHighlight: RGBA;
    /**
     * Acento da casca (foco, tab ativa, item selecionado). Separado do `caret` porque a casca
     * precisa de um azul de alto contraste para bordas e ícones, enquanto o caret é um traço fino
     * sobre o texto. Nos temas embutidos os dois coincidem.
     */
    readonly accent: RGBA;
    /** Fundo da faixa de atividades (rail vertical à esquerda). */
    readonly activityBar: RGBA;
    /** Fundo do painel lateral (explorador). */
    readonly sidebar: RGBA;
    /** Fundo da barra de status (rodapé). */
    readonly statusBar: RGBA;
    /** Divisórias entre superfícies da casca (painéis, tab bar, rodapé). */
    readonly border: RGBA;
    /** Cor de fundo da tab bar. */
    readonly tabBar: RGBA;
    /** Cor da tab ativa. */
    readonly tabActive: RGBA;
    /** Cor da tab inativa. */
    readonly tabInactive: RGBA;
  };
}