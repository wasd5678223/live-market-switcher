import type { CropRect, DashboardState, PlaybackState, RankedProduct } from "../shared/types";

type Listener = (state: DashboardState) => void;

export class DashboardStore {
  private readonly listeners = new Set<Listener>();
  private state: DashboardState;

  constructor(current: string, crop: CropRect, ocrIntervalMs: number) {
    this.state = {
      obsConnected: false,
      virtualCameraActive: false,
      captureStatus: "idle",
      captureMessage: "等待捕获直播伴侣",
      playback: { current, remainingMs: 0 },
      ranking: [],
      crop,
      ocrIntervalMs: Math.max(750, ocrIntervalMs),
      logs: [],
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): DashboardState {
    return structuredClone(this.state);
  }

  setConnection(obsConnected: boolean, virtualCameraActive = false): void {
    this.state.obsConnected = obsConnected;
    this.state.virtualCameraActive = virtualCameraActive;
    this.emit();
  }

  setCapture(status: DashboardState["captureStatus"], message: string): void {
    this.state.captureStatus = status;
    this.state.captureMessage = message;
    this.emit();
  }

  setPlayback(playback: PlaybackState): void {
    this.state.playback = playback;
    this.emit();
  }

  setRanking(ranking: RankedProduct[]): void {
    this.state.ranking = ranking;
    this.emit();
  }

  setCrop(crop: CropRect): void {
    this.state.crop = crop;
    this.emit();
  }

  log(level: "info" | "warn" | "error", message: string): void {
    this.state.logs.unshift({ at: Date.now(), level, message });
    this.state.logs = this.state.logs.slice(0, 80);
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
