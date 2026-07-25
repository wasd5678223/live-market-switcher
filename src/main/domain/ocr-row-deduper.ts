import type { OcrDetection } from "../../shared/types";

type SeenRow = OcrDetection & { seenAt: number };

export class OcrRowDeduper {
  private readonly seen: SeenRow[] = [];

  constructor(
    private readonly retentionMs = 45_000,
    private readonly maximumDistance = 8,
    private readonly positionTolerance = 0.08,
  ) {}

  accept(detection: OcrDetection, now = Date.now()): boolean {
    this.prune(now);
    const duplicate = this.seen.find(
      (row) =>
        row.text === detection.text &&
        hammingDistance(row.fingerprint, detection.fingerprint) <=
          this.maximumDistance &&
        Math.abs(row.position - detection.position) <= this.positionTolerance,
    );
    if (duplicate) {
      duplicate.seenAt = now;
      duplicate.position = detection.position;
      duplicate.fingerprint = detection.fingerprint;
      return false;
    }
    this.seen.push({ ...detection, seenAt: now });
    return true;
  }

  private prune(now: number): void {
    while (this.seen[0] && now - this.seen[0].seenAt > this.retentionMs) {
      this.seen.shift();
    }
  }
}

function hammingDistance(left: string, right: string): number {
  if (left.length !== right.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const xor = Number.parseInt(left[index] ?? "0", 16) ^ Number.parseInt(right[index] ?? "0", 16);
    distance += POPCOUNT[xor] ?? 4;
  }
  return distance;
}

const POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
