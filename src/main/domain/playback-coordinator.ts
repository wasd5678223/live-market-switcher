import type {
  PlaybackState,
  RankedProduct,
  VoteEvent,
  VoteSource,
} from "../../shared/types";
import { DanmakuScheduler } from "./danmaku-scheduler";

export type MediaStatus = { remainingMs: number; ended: boolean };

export interface PlaybackAdapter {
  prepareStandby(code: string): Promise<void>;
  switchToStandby(): Promise<string>;
}

export class UnplayableProductError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UnplayableProductError";
  }
}

export type CoordinatorSnapshot = {
  playback: PlaybackState;
  ranking: RankedProduct[];
};

export class PlaybackCoordinator {
  private playback: PlaybackState;
  private switching = false;
  private preparationVersion = 0;
  private lockTask?: Promise<void>;

  constructor(
    private readonly scheduler: DanmakuScheduler,
    private readonly adapter: PlaybackAdapter,
    private readonly lockAheadMs: number,
    private readonly onChange: (snapshot: CoordinatorSnapshot) => void = () => undefined,
    private readonly onLog: (message: string) => void = () => undefined,
  ) {
    this.playback = {
      current: scheduler.snapshot().current,
      remainingMs: 0,
    };
  }

  snapshot(): CoordinatorSnapshot {
    return {
      playback: { ...this.playback },
      ranking: this.scheduler.snapshot().ranking,
    };
  }

  async initialize(): Promise<void> {
    await this.refreshTentativeNext();
  }

  async ingestText(
    text: string,
    source: VoteSource,
    messageId: string,
    observedAt = Date.now(),
  ): Promise<VoteEvent[]> {
    const events = this.scheduler.ingestText(text, source, messageId, observedAt);
    if (events.length > 0 && !this.playback.lockedNext && !this.lockTask) {
      await this.refreshTentativeNext();
    } else {
      this.emit();
    }
    return events;
  }

  async applyMediaStatus(status: MediaStatus): Promise<void> {
    this.playback.remainingMs = status.remainingMs;
    if (
      !this.playback.lockedNext &&
      !this.lockTask &&
      status.remainingMs > 0 &&
      status.remainingMs <= this.lockAheadMs
    ) {
      await this.lockNext();
    } else {
      this.emit();
    }
    if (status.ended) await this.handlePlaybackEnded();
  }

  async handlePlaybackEnded(): Promise<void> {
    if (this.switching) return;
    this.switching = true;
    try {
      if (!this.playback.lockedNext) await this.lockNext();
      const next = await this.adapter.switchToStandby();
      this.scheduler.setCurrent(next);
      this.playback = { current: next, remainingMs: 0 };
      this.onLog(`已切换到 ${next} 号视频`);
      await this.refreshTentativeNext();
    } finally {
      this.switching = false;
    }
  }

  private async refreshTentativeNext(): Promise<void> {
    const version = ++this.preparationVersion;
    while (true) {
      const next = this.scheduler.selectNext();
      if (next === this.playback.current) {
        throw new Error("没有可用的备用视频");
      }
      try {
        await this.adapter.prepareStandby(next);
        if (version !== this.preparationVersion) return;
        this.playback.tentativeNext = next;
        this.emit();
        return;
      } catch (error) {
        if (version !== this.preparationVersion) return;
        if (!(error instanceof UnplayableProductError)) throw error;
        this.scheduler.disableProduct(error.code);
        this.onLog(`已禁用无法播放的 ${error.code} 号视频：${error.message}`);
      }
    }
  }

  private async lockNext(): Promise<void> {
    if (this.lockTask) return this.lockTask;
    this.lockTask = this.performLockNext();
    try {
      await this.lockTask;
    } finally {
      this.lockTask = undefined;
    }
  }

  private async performLockNext(): Promise<void> {
    ++this.preparationVersion;
    while (true) {
      const next = this.scheduler.lockNext();
      if (next === this.playback.current) {
        throw new Error("没有可用的备用视频");
      }
      try {
        await this.adapter.prepareStandby(next);
        this.playback.tentativeNext = next;
        this.playback.lockedNext = next;
        this.onLog(`已锁定下一条：${next} 号`);
        this.emit();
        return;
      } catch (error) {
        if (!(error instanceof UnplayableProductError)) throw error;
        this.scheduler.disableProduct(error.code);
        this.onLog(`已禁用无法播放的 ${error.code} 号视频：${error.message}`);
      }
    }
  }

  private emit(): void {
    this.onChange(this.snapshot());
  }
}
