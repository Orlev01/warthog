import { inflateRawSync } from "node:zlib";
import { PackageError, PACKAGE_LIMITS, ignoredPackagePath, safePackagePath, validateFiles, type PackageFile } from "../../domain/skills/package";

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ZIP32 only, stored/deflated text. No paths are ever extracted to disk. Check
// the central directory BEFORE bounded inflation, then lengths and CRC afterward.
export function readArchive(bytes: Uint8Array): { files: PackageFile[]; skipped: string[] } {
  if (bytes.length > PACKAGE_LIMITS.archiveBytes) throw new PackageError("This archive is too large (maximum 5 MB).");
  try { return decodeArchive(Buffer.from(bytes)); }
  catch (e) { if (e instanceof PackageError) throw e; throw new PackageError("Could not read this ZIP. It may be corrupt or use an unsupported format."); }
}

function decodeArchive(b: Buffer): { files: PackageFile[]; skipped: string[] } {
  const fail = () => { throw new PackageError("This ZIP is corrupt, encrypted or uses an unsupported format."); };
  let end = b.length - 22;
  let foundEnd = false;
  for (; end >= Math.max(0, b.length - 65557); end--) {
    if (b.readUInt32LE(end) === 0x06054b50 && end + 22 + b.readUInt16LE(end + 20) === b.length) { foundEnd = true; break; }
  }
  if (!foundEnd || b.readUInt16LE(end + 4) || b.readUInt16LE(end + 6)) return fail();
  const count = b.readUInt16LE(end + 10);
  const start = b.readUInt32LE(end + 16);
  if (b.readUInt16LE(end + 8) !== count || start + b.readUInt32LE(end + 12) !== end) return fail();
  if (count > 200) throw new PackageError("This archive has too many entries (maximum 200 including folders).");
  const files: PackageFile[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  let expanded = 0;
  let cursor = start;
  const ranges: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || b.readUInt32LE(cursor) !== 0x02014b50) return fail();
    const flags = b.readUInt16LE(cursor + 8), method = b.readUInt16LE(cursor + 10);
    const crc = b.readUInt32LE(cursor + 16), compressed = b.readUInt32LE(cursor + 20), size = b.readUInt32LE(cursor + 24);
    const nameLength = b.readUInt16LE(cursor + 28), extraLength = b.readUInt16LE(cursor + 30), commentLength = b.readUInt16LE(cursor + 32);
    const offset = b.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameLength + extraLength + commentLength > end || flags & ~0x080e || (method === 0 && (flags & 6)) || ![0, 8].includes(method)
      || b.readUInt16LE(cursor + 34) || ((b.readUInt32LE(cursor + 38) >>> 16) & 0xf000) === 0xa000) return fail();
    const rawName = b.subarray(cursor + 46, cursor + 46 + nameLength);
    const path = new TextDecoder("utf-8", { fatal: true }).decode(rawName);
    cursor += 46 + nameLength + extraLength + commentLength;
    const directory = path.endsWith("/");
    if (!safePackagePath(directory ? path.slice(0, -1) : path)) throw new PackageError("This archive contains an unsafe file path.");
    if (seen.has(path.toLowerCase())) throw new PackageError("Duplicate file paths in this archive.");
    seen.add(path.toLowerCase());
    expanded += size;
    if (size > PACKAGE_LIMITS.fileBytes || expanded > PACKAGE_LIMITS.totalBytes) throw new PackageError("Expanded files are too large (200 KB per file, 1 MB total).");
    if (offset + 30 > start || b.readUInt32LE(offset) !== 0x04034b50 || b.readUInt16LE(offset + 6) !== flags || b.readUInt16LE(offset + 8) !== method) return fail();
    const localNameSize = b.readUInt16LE(offset + 26);
    const dataStart = offset + 30 + localNameSize + b.readUInt16LE(offset + 28);
    const dataEnd = dataStart + compressed;
    if (dataEnd > start || !rawName.equals(b.subarray(offset + 30, offset + 30 + localNameSize))
      || ranges.some(([a, z]) => offset < z && dataEnd > a)) return fail();
    ranges.push([offset, dataEnd]);
    if (!(flags & 8) && (b.readUInt32LE(offset + 14) !== crc || b.readUInt32LE(offset + 18) !== compressed || b.readUInt32LE(offset + 22) !== size)) return fail();
    const data = method === 0 ? b.subarray(dataStart, dataEnd) : inflateRawSync(b.subarray(dataStart, dataEnd), { maxOutputLength: Math.max(1, size) });
    if (data.length !== size || crc32(data) !== crc) return fail();
    if (directory) continue;
    if (ignoredPackagePath(path)) { skipped.push(path); continue; }
    try {
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
      if (content.includes("\u0000")) throw new Error();
      files.push({ path, content });
    } catch { skipped.push(path); }
  }
  if (cursor !== end) return fail();
  return { files: validateFiles(files), skipped };
}

export function writeArchive(input: PackageFile[]): Buffer {
  const files = validateFiles(input);
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path), data = Buffer.from(file.content), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data); centrals.push(central, name); offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
