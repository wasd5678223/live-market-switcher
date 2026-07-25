import { describe, expect, it } from "vitest";
import { DanmakuScheduler } from "./danmaku-scheduler";

const products = [
  { code: "1", videoPath: "1.mp4", enabled: true },
  { code: "2", videoPath: "2.mp4", enabled: true },
  { code: "3", videoPath: "3.mp4", enabled: true },
];

describe("danmaku scheduling", () => {
  it("ranks extracted product numbers and consumes the locked winner", () => {
    const scheduler = new DanmakuScheduler(products, "1");

    scheduler.ingestText("2", "manual", "m1", 100);
    scheduler.ingestText("我要2号", "manual", "m2", 200);
    scheduler.ingestText("3号", "manual", "m3", 300);

    expect(scheduler.snapshot().ranking).toEqual([
      { code: "2", count: 2, lastSeenAt: 200 },
      { code: "3", count: 1, lastSeenAt: 300 },
    ]);
    expect(scheduler.lockNext()).toBe("2");
    expect(scheduler.snapshot().ranking).toEqual([
      { code: "3", count: 1, lastSeenAt: 300 },
    ]);
  });

  it("normalizes digits, deduplicates messages, and falls back in catalog order", () => {
    const scheduler = new DanmakuScheduler(products, "1");

    expect(scheduler.ingestText("我要２号和3号，2号", "ocr", "row-a", 100)).toHaveLength(2);
    expect(scheduler.ingestText("我要２号和3号", "ocr", "row-a", 200)).toEqual([]);
    expect(scheduler.snapshot().ranking.map((entry) => entry.code)).toEqual(["2", "3"]);

    scheduler.lockNext();
    scheduler.setCurrent("2");
    expect(scheduler.selectNext()).toBe("3");
  });

  it("orders ties by recency then catalog order and never repeats the current product", () => {
    const scheduler = new DanmakuScheduler(products, "1");

    scheduler.ingestText("2号", "manual", "a", 100);
    scheduler.ingestText("3号", "manual", "b", 200);
    expect(scheduler.selectNext()).toBe("3");

    const catalogTie = new DanmakuScheduler(products, "1");
    catalogTie.ingestText("2号和3号", "manual", "same", 300);
    expect(catalogTie.selectNext()).toBe("2");
    catalogTie.setCurrent("2");
    expect(catalogTie.selectNext()).toBe("3");
  });

  it("ignores unsupported long numbers and skips disabled products", () => {
    const scheduler = new DanmakuScheduler(products, "1");

    expect(scheduler.ingestText("订单12345，选2号", "manual", "a", 100)).toHaveLength(1);
    scheduler.disableProduct("2");
    expect(scheduler.snapshot().ranking).toEqual([]);
    expect(scheduler.ingestText("2号", "manual", "b", 200)).toEqual([]);
    expect(scheduler.selectNext()).toBe("3");
  });
});
