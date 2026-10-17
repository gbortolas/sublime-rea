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
    /** Cor de fundo da tab bar. */
    readonly tabBar: RGBA;
    /** Cor da tab ativa. */
    readonly tabActive: RGBA;
    /** Cor da tab inativa. */
    readonly tabInactive: RGBA;
  };
}