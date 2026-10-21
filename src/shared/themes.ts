import type { EditorTheme } from "./theme-contract";
import type { RGBA } from "./render-contract";

/**
 * Tema escuro (padrão do Scribe).
 *
 * Paleta na família do "VS Code Dark Modern": **conteúdo** (editor) ligeiramente mais claro que a
 * **casca** (rail, painel, tab bar, rodapé) — a separação vem da cor, não de bordas grossas.
 *
 * **Degraus de superfície da casca** (rail → painel → tab bar → tab ativa): cada degrau é um
 * pouco mais claro que o anterior, então a hierarquia se lê sem bordas grossas. O rail é o
 * degrau mais escuro (recua), o painel e a tab bar compartilham o tom, e a tab ativa volta ao
 * tom do editor (a aba "case" com a superfície do texto). As cores do **canvas**
 * (`background`, `foreground`, `gutter`, `selection`, `caret`, `lineHighlight`) não são
 * tocadas aqui — elas pertencem ao documento, não à casca.
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
    activityBar: 0x161719ff as RGBA,
    sidebar: 0x1a1b1eff as RGBA,
    statusBar: 0x18191bff as RGBA,
    border: 0x303238ff as RGBA,
    tabBar: 0x1a1b1eff as RGBA,
    tabActive: 0x1e1f22ff as RGBA,
    tabInactive: 0x1a1b1eff as RGBA,
  },
};

/**
 * Tema claro (alto contraste, família "VS Code Light Modern"): a casca vive em **degraus**
 * de cinza-claro — rail (#f3f3f3) → painel/tab bar/rodapé (#f7f7f7) → tab ativa (#ffffff,
 * casando com o branco do editor). Antes era um cinza único (#f8f8f8) em tudo: a casca
 * "desaparecia" no editor branco.
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
    activityBar: 0xf3f3f3ff as RGBA,
    sidebar: 0xf7f7f7ff as RGBA,
    statusBar: 0xf7f7f7ff as RGBA,
    border: 0xe0e0e2ff as RGBA,
    tabBar: 0xf7f7f7ff as RGBA,
    tabActive: 0xffffffff as RGBA,
    tabInactive: 0xf7f7f7ff as RGBA,
  },
};

/** Lista de temas disponíveis. */
export const BUILTIN_THEMES: readonly EditorTheme[] = [DARK_THEME, LIGHT_THEME];
