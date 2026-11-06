import { describe, expect, it } from "vitest";
import {
  matchesMagicBytes,
  uploadObjectPath,
} from "../../src/domain/uploads.js";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

describe("matchesMagicBytes（SEC-07 拡張子偽装検査）", () => {
  it("宣言MIMEと一致する署名を受理する", () => {
    expect(matchesMagicBytes(JPEG, "image/jpeg")).toBe(true);
    expect(matchesMagicBytes(PNG, "image/png")).toBe(true);
    expect(matchesMagicBytes(PDF, "application/pdf")).toBe(true);
  });

  it("宣言と異なる内容を拒否する", () => {
    expect(matchesMagicBytes(PDF, "image/jpeg")).toBe(false);
    expect(matchesMagicBytes(JPEG, "application/pdf")).toBe(false);
    expect(matchesMagicBytes(new Uint8Array([0x00, 0x01]), "image/png")).toBe(
      false,
    );
  });

  it("署名長に満たないprefixは判定不能として拒否する", () => {
    expect(matchesMagicBytes(new Uint8Array([0xff, 0xd8]), "image/jpeg")).toBe(
      false,
    );
  });
});

describe("uploadObjectPath", () => {
  it("所有者スコープのパスを生成しファイル名を含まない", () => {
    const p = uploadObjectPath("uid-1", "up-1");
    expect(p).toBe("patient-uploads/uid-1/up-1/original");
  });
});
