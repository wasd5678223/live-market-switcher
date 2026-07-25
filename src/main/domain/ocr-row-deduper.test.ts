import { describe, expect, it } from "vitest";
import { OcrRowDeduper } from "./ocr-row-deduper";

describe("OCR row deduplication", () => {
  it("accepts a visible comment once and accepts it again after the retention window", () => {
    const deduper = new OcrRowDeduper(45_000, 2);

    expect(deduper.accept({ text: "3", fingerprint: "0f0f", position: 0.5 }, 1_000)).toBe(true);
    expect(deduper.accept({ text: "3", fingerprint: "0f0e", position: 0.52 }, 2_000)).toBe(false);
    expect(deduper.accept({ text: "3", fingerprint: "ffff", position: 0.5 }, 3_000)).toBe(true);
    expect(deduper.accept({ text: "3", fingerprint: "0f0f", position: 0.9 }, 47_000)).toBe(true);
  });

  it("tracks a moving row while allowing an identical row at another position", () => {
    const deduper = new OcrRowDeduper(45_000, 2, 0.08);

    expect(deduper.accept({ text: "2", fingerprint: "aaaa", position: 0.2 }, 1_000)).toBe(true);
    expect(deduper.accept({ text: "2", fingerprint: "aaab", position: 0.25 }, 2_000)).toBe(false);
    expect(deduper.accept({ text: "2", fingerprint: "aaaa", position: 0.7 }, 3_000)).toBe(true);
    expect(deduper.accept({ text: "2", fingerprint: "aaaa", position: 0.25 }, 46_000)).toBe(false);
  });
});
