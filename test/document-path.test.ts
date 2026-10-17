/**
 * Scribe — extração do caminho de documento dos argumentos do processo (CLI/`open-file`).
 *
 * Prova a heurística pura (`extractDocumentPath`): descarta `.`, o diretório do app e o binário
 * do Electron; devolve o último argumento que aponta para um arquivo existente. Sem Electron.
 */
import { describe, expect, it } from "vitest";

import { extractDocumentPath } from "../src/main/index";

const EXISTING = new Set(["/tmp/note.txt", "/tmp/two.txt", "/usr/bin/electron"]);
const isFile = (path: string): boolean => EXISTING.has(path);

const APP_DIR = "/home/u/proj";
const IGNORE = [".", APP_DIR, "/usr/bin/electron"];

describe("extractDocumentPath", () => {
  it("ignora '.', o diretório do app e o binário do Electron (mesmo existindo)", () => {
    expect(
      extractDocumentPath(["/usr/bin/electron", ".", APP_DIR], isFile, IGNORE),
    ).toBeUndefined();
  });

  it("devolve o último argumento que é arquivo existente", () => {
    expect(
      extractDocumentPath(["/usr/bin/electron", ".", "/tmp/note.txt"], isFile, IGNORE),
    ).toBe("/tmp/note.txt");
    expect(extractDocumentPath(["/usr/bin/electron", "/tmp/note.txt", "/tmp/two.txt"], isFile)).toBe(
      "/tmp/two.txt",
    );
  });

  it("pula flags (começam com '-')", () => {
    expect(extractDocumentPath(["--inspect", "/tmp/note.txt"], isFile)).toBe("/tmp/note.txt");
    expect(extractDocumentPath(["--inspect=9229"], isFile)).toBeUndefined();
  });

  it("devolve undefined sem candidato existente", () => {
    expect(extractDocumentPath(["/no/such/file.txt"], isFile)).toBeUndefined();
    expect(extractDocumentPath([], isFile)).toBeUndefined();
  });
});
