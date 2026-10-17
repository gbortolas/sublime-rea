/**
 * Scribe — leitor ZIP mínimo (dependency-free).
 *
 * Fonte: `docs/architecture/05-empacotamento-e-recursos.md` (DEC-PKG-5). O alvo guarda recursos em
 * `.sublime-package` = **ZIP comum, sem manifesto** (`PKG-E2`, `PKG-E4`); para não depender de um
 * pacote novo, o leitor é implementado à mão só com `node:zlib` (stored + deflate).
 *
 * Escopo (escolha nossa, não observada no alvo):
 * - Só **stored (0)** e **deflate (8)**; qualquer outro método → `UnsupportedArchiveError`.
 * - **Sem ZIP64** (EOCD com sentinelas) e **sem criptografia** → `UnsupportedArchiveError`.
 * - Entradas de diretório (`nome` terminando em `/`) são catalogadas com `isDirectory = true`.
 * - Qualquer ZIP malformado (sem EOCD, assinatura errada, offset fora do buffer) →
 *   `UnsupportedArchiveError` com mensagem legível. É o análogo tipado do `ProtocolError` de `03`.
 * - O nome é decodificado como **UTF-8** (suficiente para nomes lógicos ASCII/UTF-8).
 */
import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;

/** ZIP inválido ou com recurso não suportado (ZIP64, método exótico, truncamento). */
export class UnsupportedArchiveError extends Error {
  constructor(message: string) {
    super(`UnsupportedArchiveError: ${message}`);
    this.name = "UnsupportedArchiveError";
  }
}

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localHeaderOffset: number;
  readonly isDirectory: boolean;
}

function decodeUtf8(data: Uint8Array, offset: number, length: number): string {
  return new TextDecoder("utf-8").decode(data.subarray(offset, offset + length));
}

/**
 * ZIP em modo leitura, montado sobre os bytes em memória. O índice é a **central directory**
 * (`PKG-E4`: não depender da ordem das entradas).
 */
export class ZipArchive {
  private readonly data: Uint8Array;
  private readonly view: DataView;
  private readonly index: Map<string, ZipEntry>;
  private readonly list: readonly ZipEntry[];

  private constructor(data: Uint8Array, entries: readonly ZipEntry[]) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.list = entries;
    this.index = new Map(entries.map((e) => [e.name, e]));
  }

  static open(data: Uint8Array): ZipArchive {
    if (data.byteLength < EOCD_MIN_BYTES) {
      throw new UnsupportedArchiveError("arquivo menor que o EOCD mínimo (22 B)");
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const len = data.byteLength;

    let eocd = -1;
    const lowest = Math.max(0, len - EOCD_MIN_BYTES - MAX_COMMENT_BYTES);
    for (let i = len - EOCD_MIN_BYTES; i >= lowest; i--) {
      if (view.getUint32(i, true) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) {
      throw new UnsupportedArchiveError("end of central directory não encontrado (não é um ZIP)");
    }

    const totalEntries = view.getUint16(eocd + 10, true);
    const centralSize = view.getUint32(eocd + 12, true);
    const centralOffset = view.getUint32(eocd + 16, true);
    if (
      totalEntries === ZIP64_SENTINEL_16 ||
      centralSize === ZIP64_SENTINEL_32 ||
      centralOffset === ZIP64_SENTINEL_32
    ) {
      throw new UnsupportedArchiveError("ZIP64 não suportado (use um pacote < 4 GiB e < 65535 entradas)");
    }
    if (centralOffset + centralSize > len) {
      throw new UnsupportedArchiveError("central directory aponta para fora do arquivo");
    }

    const entries: ZipEntry[] = [];
    let p = centralOffset;
    for (let n = 0; n < totalEntries; n++) {
      if (p + 46 > len || view.getUint32(p, true) !== CENTRAL_SIG) {
        throw new UnsupportedArchiveError(`central directory corrompido na entrada ${n}`);
      }
      const method = view.getUint16(p + 10, true);
      const compressedSize = view.getUint32(p + 20, true);
      const size = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localHeaderOffset = view.getUint32(p + 42, true);
      if (p + 46 + nameLen + extraLen + commentLen > len) {
        throw new UnsupportedArchiveError(`entrada ${n} extrapola o fim do arquivo`);
      }
      const name = decodeUtf8(data, p + 46, nameLen);
      entries.push({
        name,
        method,
        compressedSize,
        size,
        localHeaderOffset,
        isDirectory: name.endsWith("/"),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }

    return new ZipArchive(data, entries);
  }

  get entries(): readonly ZipEntry[] {
    return this.list;
  }

  has(name: string): boolean {
    return this.index.has(name);
  }

  entry(name: string): ZipEntry | undefined {
    return this.index.get(name);
  }

  /** Lê e descomprime uma entrada; `undefined` se ela não existir. */
  read(name: string): Uint8Array | undefined {
    const entry = this.index.get(name);
    if (entry === undefined) return undefined;
    if (entry.isDirectory) {
      throw new UnsupportedArchiveError(`"${name}" é um diretório`);
    }
    const data = this.data;
    const len = data.byteLength;
    const off = entry.localHeaderOffset;
    if (off + 30 > len || this.view.getUint32(off, true) !== LOCAL_SIG) {
      throw new UnsupportedArchiveError(`local header inválido para "${name}"`);
    }
    const nameLen = this.view.getUint16(off + 26, true);
    const extraLen = this.view.getUint16(off + 28, true);
    const dataStart = off + 30 + nameLen + extraLen;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > len) {
      throw new UnsupportedArchiveError(`dados de "${name}" extrapolam o fim do arquivo`);
    }
    const raw = data.subarray(dataStart, dataEnd);
    if (entry.method === 0) {
      return raw.slice();
    }
    if (entry.method === 8) {
      return new Uint8Array(inflateRawSync(raw));
    }
    throw new UnsupportedArchiveError(`método de compressão não suportado em "${name}": ${entry.method}`);
  }
}
