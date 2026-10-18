import type { EditorTheme } from "./theme-contract";
import type { RGBA } from "./render-contract";

/**
 * Tema escuro (padrão do Scribe).
 *
 * Paleta na família do "VS Code Dark Modern": **conteúdo** (editor) ligeiramente mais claro que a
 * **casca** (rail, painel, tab bar, rodapé) — a separação vem da cor, não de bordas grossas.
 */
export const DARK_THEME: EditorTheme = {
  name: "Scribe Dark",
  kind: "dark",
  colors: {
    background: 0x1e1f22ff as RGBA,
    foreground: 0xd4d4d4ff as RGBA,
    caret: 0x3794ffff as RGBA,
    gutter: 0x2b2d30ff as RGBA,
    gutterForeground: 0x6e6e6eff as RGBA,
    selection: 0x264f78ff as RGBA,
    searchMatch: 0xffff0044 as RGBA,
    searchCurrent: 0xff880088 as RGBA,
    scrollbarTrack: 0x222326ff as RGBA,
    scrollbarThumb: 0x4a4d52ff as RGBA,
    lineHighlight: 0x2b2d30ff as RGBA,
    accent: 0x3794ffff as RGBA,
    activityBar: 0x18191bff as RGBA,
    sidebar: 0x18191bff as RGBA,
    statusBar: 0x18191bff as RGBA,
    border: 0x2b2d30ff as RGBA,
    tabBar: 0x18191bff as RGBA,
    tabActive: 0x1e1f22ff as RGBA,
    tabInactive: 0x18191bff as RGBA,
  },
};

/**
 * Tema claro (alto contraste, família "VS Code Light Modern"): casca em cinza-claro
 * (`#f8f8f8`) sobre o branco do editor, para que a tab ativa "case" com a superfície do texto.
 */
export const LIGHT_THEME: EditorTheme = {
  name: "Scribe Light",
  kind: "light",
  colors: {
    background: 0xffffffff as RGBA,
    foreground: 0x3b3b3bff as RGBA,
    caret: 0x005fb8ff as RGBA,
    gutter: 0xf8f8f8ff as RGBA,
    gutterForeground: 0x8a8a8aff as RGBA,
    selection: 0xadd6ffff as RGBA,
    searchMatch: 0xffdd00ff as RGBA,
    searchCurrent: 0xff8800ff as RGBA,
    scrollbarTrack: 0xf5f5f5ff as RGBA,
    scrollbarThumb: 0xc1c1c1ff as RGBA,
    lineHighlight: 0xf2f2f2ff as RGBA,
    accent: 0x005fb8ff as RGBA,
    activityBar: 0xf8f8f8ff as RGBA,
    sidebar: 0xf8f8f8ff as RGBA,
    statusBar: 0xf8f8f8ff as RGBA,
    border: 0xe5e5e5ff as RGBA,
    tabBar: 0xf8f8f8ff as RGBA,
    tabActive: 0xffffffff as RGBA,
    tabInactive: 0xf8f8f8ff as RGBA,
  },
};

/** Lista de temas disponíveis. */
export const BUILTIN_THEMES: readonly EditorTheme[] = [DARK_THEME, LIGHT_THEME];
