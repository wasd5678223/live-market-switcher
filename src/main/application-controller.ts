import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type { AppConfig } from "./config";
import { saveCrop } from "./config";
import { DashboardStore } from "./dashboard-store";
import { DanmakuScheduler } from "./domain/danmaku-scheduler";
import { OcrRowDeduper } from "./domain/ocr-row-deduper";
import { PlaybackCoordinator } from "./domain/playback-coordinator";
import { ObsController } from "./obs/obs-controller";
import type { CropRect, DashboardState, OcrDetection, Product, VoteSource } from "../shared/types";

export class ApplicationController {
  private readonly scheduler: DanmakuScheduler;
  private readonly coordinator: PlaybackCoordinator;
  private readonly deduper = new OcrRowDeduper();
  private readonly store: DashboardStore;
  private readonly obs: ObsController;
  private poll?: NodeJS.Timeout;
  private polling = false;

  constructor(
    private readonly projectRoot: string,
    private readonly products: Product[],
    private readonly appConfig: AppConfig,
    mainWindow: BrowserWindow,
  ) {
    const enabled = products.filter((product) => product.enabled);
    if (enabled.length < 2) throw new Error("至少需要两个有效视频");
    this.scheduler = new DanmakuScheduler(enabled, enabled[0]!.code);
    this.store = new DashboardStore(enabled[0]!.code, appConfig.crop, appConfig.ocrIntervalMs);
    this.store.subscribe((state) => mainWindow.webContents.send("dashboard:state", state));
    this.obs = new ObsController(
      projectRoot,
      (level, message) => this.store.log(level, message),
      () => void this.coordinator.handlePlaybackEnded(),
      (connected) => this.store.setConnection(connected, connected && this.store.snapshot().virtualCameraActive),
    );
    this.coordinator = new PlaybackCoordinator(
      this.scheduler,
      this.obs,
      appConfig.lockAheadMs,
      (snapshot) => {
        this.store.setPlayback(snapshot.playback);
        this.store.setRanking(snapshot.ranking);
      },
      (message) => this.store.log("info", message),
    );
  }

  async initialize(): Promise<void> {
    const first = this.products.find((product) => product.enabled)!;
    const connected = await this.obs.connectAndBootstrap(this.products.filter((p) => p.enabled), first.code);
    if (!connected) return;
    const virtualCameraActive = await this.obs.ensureVirtualCamera();
    this.store.setConnection(true, virtualCameraActive);
    this.store.log("info", "虚拟摄像头已启动");
    await this.coordinator.initialize();
    this.poll = setInterval(() => void this.pollPlayback(), 250);
  }

  snapshot(): DashboardState {
    return this.store.snapshot();
  }

  submitManualMessage(text: string): void {
    this.ingestText(text, "manual", `manual-${randomUUID()}`);
  }

  submitOcrDetections(detections: OcrDetection[]): void {
    const now = Date.now();
    for (const detection of detections) {
      if (!this.deduper.accept(detection, now)) continue;
      this.ingestText(detection.text, "ocr", `ocr-${detection.fingerprint}-${now}`);
    }
  }

  updateCapture(status: DashboardState["captureStatus"], message: string): void {
    this.store.setCapture(status, message);
  }

  updateCrop(crop: CropRect): void {
    const bounded = boundCrop(crop);
    saveCrop(this.projectRoot, bounded);
    this.store.setCrop(bounded);
  }

  async shutdown(): Promise<void> {
    if (this.poll) clearInterval(this.poll);
    await this.obs.disconnect();
  }

  private ingestText(text: string, source: VoteSource, messageId: string): void {
    void this.coordinator.ingestText(text, source, messageId).then((events) => {
      if (events.length === 0) return;
      this.store.log(
        "info",
        `${source === "ocr" ? "弹幕" : "测试"}计票：${events.map((e) => e.code).join("、")} 号`,
      );
    }).catch((error) => this.store.log("error", `预热失败：${errorMessage(error)}`));
  }

  private async pollPlayback(): Promise<void> {
    if (!this.obs.isConnected() || this.polling) return;
    this.polling = true;
    try {
      const status = await this.obs.currentMediaStatus();
      await this.coordinator.applyMediaStatus(status);
    } catch (error) {
      this.store.log("warn", `播放状态读取失败：${errorMessage(error)}`);
    } finally {
      this.polling = false;
    }
  }
}

function boundCrop(crop: CropRect): CropRect {
  const width = clamp(crop.width, 0.05, 1);
  const height = clamp(crop.height, 0.05, 1);
  return {
    x: clamp(crop.x, 0, 1 - width),
    y: clamp(crop.y, 0, 1 - height),
    width,
    height,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
