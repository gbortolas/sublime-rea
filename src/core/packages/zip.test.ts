import { deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { UnsupportedArchiveError, ZipArchive } from "./zip";

interface ZipFileSpec {
  readonly name: string;
  readonly data: Buffer;
  readonly deflate?: boolean;
}

/** Constrói um ZIP **de verdade** à mão (local headers + central directory + EOCD). */
function buildZip(files: readonly ZipFileSpec[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const method = file.deflate === true ? 8 : 0;
    const payload = method === 8 ? deflateRawSync(file.data) : file.data;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const cen = Buffer.alloc(46 + nameBuf.length);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(0, 16);
    cen.writeUInt32LE(payload.length, 20);
    cen.writeUInt32LE(file.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    nameBuf.copy(cen, 46);

    parts.push(local, payload);
    central.push(cen);
    offset += local.length + payload.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cd, eocd]);
}

describe("ZipArchive", () => {
  it("lê entrada stored e entrada deflate", () => {
    const stored = Buffer.from("stored-content", "utf8");
    const deflated = Buffer.from("deflate-content ".repeat(50), "utf8");
    const zip = buildZip([
      { name: "a.txt", data: stored },
      { name: "b.txt", data: deflated, deflate: true },
    ]);

    const archive = ZipArchive.open(new Uint8Array(zip));
    expect(archive.entries.map((e) => e.name)).toEqual(["a.txt", "b.txt"]);
    expect(new TextDecoder().decode(archive.read("a.txt"))).toBe("stored-content");
    expect(new TextDecoder().decode(archive.read("b.txt"))).toBe("deflate-content ".repeat(50));
    expect(archive.entry("b.txt")?.size).toBe(deflated.byteLength);
  });

  it("cataloga diretório mas não o trata como arquivo", () => {
    const zip = buildZip([
      { name: "dir/", data: Buffer.alloc(0) },
      { name: "dir/f.txt", data: Buffer.from("x") },
    ]);
    const archive = ZipArchive.open(new Uint8Array(zip));
    expect(archive.entry("dir/")?.isDirectory).toBe(true);
    expect(archive.entry("dir/f.txt")?.isDirectory).toBe(false);
    expect(() => archive.read("dir/")).toThrow(UnsupportedArchiveError);
  });

  it("read devolve undefined para entrada ausente", () => {
    const archive = ZipArchive.open(new Uint8Array(buildZip([{ name: "a", data: Buffer.from("x") }])));
    expect(archive.read("nao-existe")).toBeUndefined();
    expect(archive.has("nao-existe")).toBe(false);
  });

  it("ZIP truncado falha com UnsupportedArchiveError", () => {
    const zip = buildZip([{ name: "a.txt", data: Buffer.from("abcdef") }]);
    const truncated = zip.subarray(0, zip.length - 10);
    expect(() => ZipArchive.open(new Uint8Array(truncated))).toThrow(UnsupportedArchiveError);
  });

  it("método de compressão desconhecido falha ao ler", () => {
    const zip = buildZip([{ name: "a.txt", data: Buffer.from("abc") }]);
    // corrompe o método na central directory e no local header (0 -> 99)
    zip.writeUInt16LE(99, 8);
    const cdOffset = zip.readUInt32LE(zip.length - 22 + 16);
    zip.writeUInt16LE(99, cdOffset + 10);
    const archive = ZipArchive.open(new Uint8Array(zip));
    expect(() => archive.read("a.txt")).toThrow(UnsupportedArchiveError);
  });

  it("buffer curto (sem espaço para EOCD) falha", () => {
    expect(() => ZipArchive.open(new Uint8Array(4))).toThrow(UnsupportedArchiveError);
  });
});
