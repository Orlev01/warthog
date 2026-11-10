import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { readArchive, writeArchive, crc32 } from "./archive";

test("ZIP export/import preserves exact UTF-8 file paths and content", () => {
  const files = [{ path: "SKILL.md", content: "\uFEFFhello 🌏\r\n" }, { path: ".mcp.json", content: "{}" }];
  assert.deepEqual(readArchive(writeArchive(files)).files, files);
});

test("bounded deflate archives import without filesystem extraction", () => {
  const content = "test content ".repeat(500);
  const zip = writeArchive([{ path: "file.md", content }]);
  const compressed = deflateRawSync(Buffer.from(content));
  const local = Buffer.from(zip.subarray(0, 37));
  local.writeUInt16LE(8, 8); local.writeUInt32LE(compressed.length, 18);
  const central = Buffer.from(zip.subarray(37 + Buffer.byteLength(content), zip.length - 22));
  central.writeUInt16LE(8, 10); central.writeUInt32LE(compressed.length, 20);
  // ZIP's deflate level hint is independent of the compressed stream.
  local.writeUInt16LE(0x0802, 6); central.writeUInt16LE(0x0802, 8);
  const end = Buffer.from(zip.subarray(-22)); end.writeUInt32LE(37 + compressed.length, 16);
  assert.equal(readArchive(Buffer.concat([local, compressed, central, end])).files[0].content, content);
});

test("rejects corrupt, truncated, encrypted, traversing and oversized archives", () => {
  assert.throws(() => readArchive(Buffer.from("not a zip")));
  const original = writeArchive([{ path: "file.md", content: "hello" }]);
  assert.throws(() => readArchive(original.subarray(0, -1)));
  const bad = Buffer.from(original); bad[37] ^= 1;
  assert.throws(() => readArchive(bad), /corrupt/i);
  const encrypted = Buffer.from(original); encrypted.writeUInt16LE(1, 6); encrypted.writeUInt16LE(1, 50);
  assert.throws(() => readArchive(encrypted));
  assert.throws(() => writeArchive([{ path: "../x", content: "hello" }]));
  assert.throws(() => readArchive(Buffer.alloc(5_000_001)), /large/);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("refuses symlinks, forged expansion lengths and excessive archive counts", () => {
  const zip = writeArchive([{ path: "file.md", content: "content" }]);
  const central = 30 + 7 + 7;
  const symlink = Buffer.from(zip); symlink.writeUInt32LE((0xa1ff << 16) >>> 0, central + 38);
  assert.throws(() => readArchive(symlink));
  const expansion = Buffer.from(zip); expansion.writeUInt32LE(1_000_001, central + 24);
  assert.throws(() => readArchive(expansion), /large/);
  const count = Buffer.from(zip); count.writeUInt16LE(201, count.length - 14); count.writeUInt16LE(201, count.length - 12);
  assert.throws(() => readArchive(count), /entries/);
  const truncated = Buffer.from(zip); truncated.writeUInt32LE(999999, central + 20);
  assert.throws(() => readArchive(truncated));
});
