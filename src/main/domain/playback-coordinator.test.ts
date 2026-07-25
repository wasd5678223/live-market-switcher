import { describe, expect, it } from "vitest";
import { DanmakuScheduler } from "./danmaku-scheduler";
import {
  PlaybackCoordinator,
  UnplayableProductError,
  type PlaybackAdapter,
} from "./playback-coordinator";

const products = [
  { code: "1", videoPath: "1.mp4", enabled: true },
  { code: "2", videoPath: "2.mp4", enabled: true },
  { code: "3", videoPath: "3.mp4", enabled: true },
];

class FakePlayback implements PlaybackAdapter {
  prepared: string[] = [];
  standby = "";

  async prepareStandby(code: string): Promise<void> {
    this.prepared.push(code);
    this.standby = code;
  }

  async switchToStandby(): Promise<string> {
    return this.standby;
  }
}

describe("playback coordination", () => {
  it("preheats the leader, consumes it at lock time, then switches only after end", async () => {
    const adapter = new FakePlayback();
    const coordinator = new PlaybackCoordinator(
      new DanmakuScheduler(products, "1"),
      adapter,
      2_000,
    );

    await coordinator.ingestText("2", "manual", "a", 100);
    await coordinator.ingestText("我要2号", "manual", "b", 200);
    await coordinator.ingestText("3号", "manual", "c", 300);
    expect(coordinator.snapshot().playback.current).toBe("1");
    expect(adapter.prepared.at(-1)).toBe("2");

    await coordinator.applyMediaStatus({ remainingMs: 1_500, ended: false });
    expect(coordinator.snapshot().playback.lockedNext).toBe("2");
    expect(coordinator.snapshot().ranking).toEqual([
      { code: "3", count: 1, lastSeenAt: 300 },
    ]);

    await coordinator.handlePlaybackEnded();
    expect(coordinator.snapshot().playback.current).toBe("2");
    expect(coordinator.snapshot().playback.tentativeNext).toBe("3");
    expect(adapter.prepared.at(-1)).toBe("3");
  });

  it("disables an unplayable winner and preheats the next candidate", async () => {
    class FailingPlayback extends FakePlayback {
      override async prepareStandby(code: string): Promise<void> {
        if (code === "2") throw new UnplayableProductError(code, "bad media");
        await super.prepareStandby(code);
      }
    }

    const adapter = new FailingPlayback();
    const logs: string[] = [];
    const coordinator = new PlaybackCoordinator(
      new DanmakuScheduler(products, "1"),
      adapter,
      2_000,
      () => undefined,
      (message) => logs.push(message),
    );

    await coordinator.ingestText("2号 3号", "manual", "a", 100);
    expect(coordinator.snapshot().playback.tentativeNext).toBe("3");
    expect(coordinator.snapshot().ranking.map((entry) => entry.code)).toEqual(["3"]);
    expect(logs[0]).toContain("已禁用无法播放的 2 号视频");
  });

  it("keeps the newest tentative candidate when preheats finish out of order", async () => {
    const pending = new Map<string, () => void>();
    const adapter: PlaybackAdapter = {
      prepareStandby: (code) => new Promise<void>((resolve) => pending.set(code, resolve)),
      switchToStandby: async () => "3",
    };
    const coordinator = new PlaybackCoordinator(
      new DanmakuScheduler(products, "1"),
      adapter,
      2_000,
    );

    const older = coordinator.ingestText("2号", "manual", "older", 100);
    const newer = coordinator.ingestText("3号", "manual", "newer", 200);
    pending.get("3")?.();
    await newer;
    pending.get("2")?.();
    await older;

    expect(coordinator.snapshot().playback.tentativeNext).toBe("3");
  });
});
