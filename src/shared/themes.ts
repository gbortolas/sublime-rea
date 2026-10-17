import type { EditorTheme } from "./theme-contract";
import type { RGBA } from "./render-contract";

/** Tema escuro (padrão atual do Scribe). */
export const DARK_THEME: EditorTheme = {
  name: "Scribe Dark",
  kind: "dark",
  colors: {
    background: 0x1e1f22ff as RGBA,
    foreground: 0xd4d4d4ff as RGBA,
    caret: 0x7fb3ffff as RGBA,
    gutter: 0x2b2d30ff as RGBA,
    gutterForeground: 0x6e6e6eff as RGBA,
    selection: 0x264f78ff as RGBA,
    searchMatch: 0xffff0044 as RGBA,
    searchCurrent: 0xff880088 as RGBA,
    scrollbarTrack: 0x222326ff as RGBA,
    scrollbarThumb: 0x3a3d41ff as RGBA,
    lineHighlight: 0x2b2d30ff as RGBA,
    tabBar: 0x25272bff as RGBA,
    tabActive: 0x1e1f22ff as RGBA,
    tabInactive: 0x2d2f33ff as RGBA,
  },
};

/** Tema claro (alternativa de alto contraste). */
export const LIGHT_THEME: EditorTheme = {
  name: "Scribe Light",
  kind: "light",
  colors: {
    background: 0xffffffff as RGBA,
    foreground: 0x333333ff as RGBA,
    caret: 0x1a73e8ff as RGBA,
    gutter: 0xf0f0f0ff as RGBA,
    gutterForeground: 0x999999ff as RGBA,
    selection: 0xcce5ffff as RGBA,
    searchMatch: 0xffdd00ff as RGBA,
    searchCurrent: 0xff8800ff as RGBA,
    scrollbarTrack: 0xf5f5f5ff as RGBA,
    scrollbarThumb: 0xccccccff as RGBA,
    lineHighlight: 0xf5f5f5ff as RGBA,
    tabBar: 0xf0f0f0ff as RGBA,
    tabActive: 0xffffffff as RGBA,
    tabInactive: 0xe8e8e8ff as RGBA,
  },
};

/** Lista de temas disponíveis. */
export const BUILTIN_THEMES: readonly EditorTheme[] = [DARK_THEME, LIGHT_THEME];