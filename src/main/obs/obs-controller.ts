import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import OBSWebSocket, { EventSubscription } from "obs-websocket-js";
import type { Product } from "../../shared/types";
import { UnplayableProductError } from "../domain/playback-coordinator";

const execFileAsync = promisify(execFile);
const SCENE_NAME = "自动卖场";
const PLAYER_A = "卖场播放器 A";
const PLAYER_B = "卖场播放器 B";
const BACKGROUND = "卖场背景";
const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 720;

type Slot = { inputName: string; sceneItemId: number; code?: string };
type Logger = (level: "info" | "warn" | "error", message: string) => void;
type ObsSettings = Record<string, string | number | boolean>;

export class ObsController {
  private readonly obs = new OBSWebSocket();
  private currentSlot?: Slot;
  private standbySlot?: Slot;
  private products = new Map<string, Product>();
  private connected = false;
  private switching = false;
  private prepareVersion = 0;
  private reconnecting = false;
  private shuttingDown = false;
  private wsConfig?: { port: number; password: string };

  constructor(
    private readonly projectRoot: string,
    private readonly log: Logger,
    private readonly onPlaybackEnded: () => void,
    private readonly onConnectionChanged: (connected: boolean) => void = () => undefined,
  ) {
    this.obs.on("ConnectionClosed", () => {
      const wasConnected = this.connected;
      this.connected = false;
      if (wasConnected) {
        this.onConnectionChanged(false);
        this.log("warn", "OBS 连接已断开，等待重连");
        void this.reconnect();
      }
    });
    this.obs.on("MediaInputPlaybackEnded", ({ inputName }) => {
      if (inputName === this.currentSlot?.inputName) this.onPlaybackEnded();
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connectAndBootstrap(products: Product[], initialCode: string): Promise<boolean> {
    this.products = new Map(products.map((product) => [product.code, product]));
    const ws = this.ensureWebSocketConfiguration();
    this.wsConfig = ws;
    await this.launchObsIfNeeded();

    for (let attempt = 1; attempt <= 24; attempt += 1) {
      try {
        await this.obs.connect(`ws://127.0.0.1:${ws.port}`, ws.password, {
          eventSubscriptions: EventSubscription.All,
        });
        this.connected = true;
        this.onConnectionChanged(true);
        break;
      } catch {
        await delay(Math.min(250 + attempt * 100, 1_000));
      }
    }
    if (!this.connected) {
      this.log("error", "无法连接 OBS WebSocket；若 OBS 已打开，请重启一次使配置生效");
      return false;
    }

    await this.ensureScene();
    await this.startInitial(initialCode);
    this.log("info", "OBS 双播放器已就绪");
    return true;
  }

  async ensureVirtualCamera(): Promise<boolean> {
    if (!this.connected) return false;
    const status = await this.obs.call("GetVirtualCamStatus");
    if (!status.outputActive) await this.obs.call("StartVirtualCam");
    return true;
  }

  async prepareStandby(code: string): Promise<void> {
    if (!this.connected || !this.standbySlot) return;
    if (this.standbySlot.code === code) return;
    const product = this.products.get(code);
    if (!product) throw new Error(`商品 ${code} 不可用`);
    if (!existsSync(product.videoPath)) {
      throw new UnplayableProductError(code, "视频文件不存在");
    }
    const version = ++this.prepareVersion;
    const slot = this.standbySlot;
    try {
      await this.setPlayerFile(slot.inputName, product.videoPath);
      await this.obs.call("TriggerMediaInputAction", {
        inputName: slot.inputName,
        mediaAction: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART",
      });
      await this.waitUntilPlaying(slot.inputName, 2_500, true);
    } catch (error) {
      if (error instanceof MediaStartTimeoutError) {
        throw new UnplayableProductError(code, error.message);
      }
      throw error;
    }
    if (version !== this.prepareVersion) return;
    await this.obs.call("SetMediaInputCursor", {
      inputName: slot.inputName,
      mediaCursor: 0,
    });
    await this.obs.call("TriggerMediaInputAction", {
      inputName: slot.inputName,
      mediaAction: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP",
    });
    await this.waitUntilStopped(slot.inputName, 1_500);
    slot.code = code;
    this.log("info", `已预热 ${code} 号视频`);
  }

  async switchToStandby(): Promise<string> {
    if (!this.connected || !this.currentSlot || !this.standbySlot) {
      throw new Error("OBS 播放器尚未初始化");
    }
    if (this.switching) return this.currentSlot.code ?? "";
    if (!this.standbySlot.code) throw new Error("备用播放器没有已预热视频");
    this.switching = true;
    try {
      const next = this.standbySlot;
      await this.obs.call("TriggerMediaInputAction", {
        inputName: next.inputName,
        mediaAction: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART",
      });
      await this.waitUntilPlaying(next.inputName, 2_500, true);
      await this.putOnTop(next.sceneItemId);
      const previous = this.currentSlot;
      this.currentSlot = next;
      this.standbySlot = previous;
      this.standbySlot.code = undefined;
      return this.currentSlot.code ?? "";
    } finally {
      this.switching = false;
    }
  }

  async currentMediaStatus(): Promise<{ remainingMs: number; ended: boolean }> {
    if (!this.connected || !this.currentSlot) return { remainingMs: 0, ended: false };
    const status = await this.obs.call("GetMediaInputStatus", {
      inputName: this.currentSlot.inputName,
    });
    const duration = Number(status.mediaDuration ?? 0);
    const cursor = Number(status.mediaCursor ?? 0);
    return {
      remainingMs: Math.max(0, duration - cursor),
      ended: [
        "OBS_MEDIA_STATE_ENDED",
        "OBS_MEDIA_STATE_STOPPED",
        "OBS_MEDIA_STATE_ERROR",
      ].includes(status.mediaState),
    };
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    if (this.connected) await this.obs.disconnect();
    this.connected = false;
  }

  private ensureWebSocketConfiguration(): { port: number; password: string } {
    const path = resolve(
      this.projectRoot,
      "obs-studio/config/obs-studio/plugin_config/obs-websocket/config.json",
    );
    const config = JSON.parse(readFileSync(path, "utf8")) as {
      server_enabled: boolean;
      server_port: number;
      server_password: string;
    };
    if (!config.server_enabled) {
      config.server_enabled = true;
      writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      this.log("info", "已启用 OBS WebSocket，首次运行可能需要重启 OBS");
    }
    return { port: config.server_port, password: config.server_password };
  }

  private async launchObsIfNeeded(): Promise<void> {
    const { stdout } = await execFileAsync("tasklist", ["/FI", "IMAGENAME eq obs64.exe"]);
    if (stdout.toLowerCase().includes("obs64.exe")) return;
    const executable = resolve(this.projectRoot, "obs-studio/bin/64bit/obs64.exe");
    if (!existsSync(executable)) throw new Error("项目内未找到 OBS");
    const child = spawn(executable, ["--portable", "--minimize-to-tray"], {
      cwd: resolve(this.projectRoot, "obs-studio/bin/64bit"),
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    this.log("info", "已启动便携 OBS");
  }

  private async ensureScene(): Promise<void> {
    await this.ensureVideoSettings();
    const sceneList = await this.obs.call("GetSceneList");
    if (!sceneList.scenes.some((scene) => scene.sceneName === SCENE_NAME)) {
      await this.obs.call("CreateScene", { sceneName: SCENE_NAME });
    }
    const kinds = await this.obs.call("GetInputKindList");
    const colorKind = kinds.inputKinds.includes("color_source_v3")
      ? "color_source_v3"
      : "color_source";
    await this.ensureInput(BACKGROUND, colorKind, {
      color: 0xff000000,
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
    });
    const a = await this.ensureInput(PLAYER_A, "ffmpeg_source", playerSettings());
    const b = await this.ensureInput(PLAYER_B, "ffmpeg_source", playerSettings());
    this.currentSlot = { inputName: PLAYER_A, sceneItemId: a };
    this.standbySlot = { inputName: PLAYER_B, sceneItemId: b };
    await this.fitToCanvas(a);
    await this.fitToCanvas(b);
    await this.obs.call("SetInputMute", { inputName: PLAYER_A, inputMuted: true });
    await this.obs.call("SetInputMute", { inputName: PLAYER_B, inputMuted: true });
    await this.obs.call("SetCurrentProgramScene", { sceneName: SCENE_NAME });
  }

  private async ensureVideoSettings(): Promise<void> {
    const current = await this.obs.call("GetVideoSettings");
    if (
      current.baseWidth === VIDEO_WIDTH &&
      current.baseHeight === VIDEO_HEIGHT &&
      current.outputWidth === VIDEO_WIDTH &&
      current.outputHeight === VIDEO_HEIGHT &&
      current.fpsNumerator === 30 &&
      current.fpsDenominator === 1
    ) return;

    const virtualCamera = await this.obs.call("GetVirtualCamStatus");
    if (virtualCamera.outputActive) {
      await this.obs.call("StopVirtualCam");
      await this.waitForVirtualCamera(false, 2_000);
    }
    try {
      await this.obs.call("SetVideoSettings", {
        fpsNumerator: 30,
        fpsDenominator: 1,
        baseWidth: VIDEO_WIDTH,
        baseHeight: VIDEO_HEIGHT,
        outputWidth: VIDEO_WIDTH,
        outputHeight: VIDEO_HEIGHT,
      });
      this.log("info", "OBS 视频设置已调整为 1280×720 / 30 FPS");
    } catch (error) {
      this.log("warn", `OBS 正在输出，暂时无法调整视频设置：${errorMessage(error)}`);
    }
  }

  private async waitForVirtualCamera(active: boolean, timeoutMs: number): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const status = await this.obs.call("GetVirtualCamStatus");
      if (status.outputActive === active) return;
      await delay(80);
    }
    this.log("warn", "等待 OBS 虚拟摄像头状态切换超时，继续启动");
  }

  private async ensureInput(
    inputName: string,
    inputKind: string,
    inputSettings: ObsSettings,
  ): Promise<number> {
    const inputs = await this.obs.call("GetInputList");
    if (!inputs.inputs.some((input) => input.inputName === inputName)) {
      const result = await this.obs.call("CreateInput", {
        sceneName: SCENE_NAME,
        inputName,
        inputKind,
        inputSettings,
        sceneItemEnabled: true,
      });
      return result.sceneItemId;
    }
    try {
      const result = await this.obs.call("GetSceneItemId", { sceneName: SCENE_NAME, sourceName: inputName });
      return result.sceneItemId;
    } catch {
      const result = await this.obs.call("CreateSceneItem", {
        sceneName: SCENE_NAME,
        sourceName: inputName,
        sceneItemEnabled: true,
      });
      return result.sceneItemId;
    }
  }

  private async startInitial(code: string): Promise<void> {
    if (!this.currentSlot) return;
    const product = this.products.get(code);
    if (!product) throw new Error(`初始商品 ${code} 不可用`);
    await this.setPlayerFile(this.currentSlot.inputName, product.videoPath);
    this.currentSlot.code = code;
    await this.obs.call("TriggerMediaInputAction", {
      inputName: this.currentSlot.inputName,
      mediaAction: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART",
    });
    await this.putOnTop(this.currentSlot.sceneItemId);
  }

  private async setPlayerFile(inputName: string, videoPath: string): Promise<void> {
    await this.obs.call("SetInputSettings", {
      inputName,
      inputSettings: { ...playerSettings(), local_file: videoPath },
      overlay: true,
    });
  }

  private async fitToCanvas(sceneItemId: number): Promise<void> {
    await this.obs.call("SetSceneItemTransform", {
      sceneName: SCENE_NAME,
      sceneItemId,
      sceneItemTransform: {
        positionX: 0,
        positionY: 0,
        boundsType: "OBS_BOUNDS_STRETCH",
        boundsWidth: VIDEO_WIDTH,
        boundsHeight: VIDEO_HEIGHT,
      },
    });
  }

  private async putOnTop(sceneItemId: number): Promise<void> {
    const items = await this.obs.call("GetSceneItemList", { sceneName: SCENE_NAME });
    await this.obs.call("SetSceneItemIndex", {
      sceneName: SCENE_NAME,
      sceneItemId,
      sceneItemIndex: items.sceneItems.length - 1,
    });
  }

  private async waitUntilPlaying(
    inputName: string,
    timeoutMs: number,
    requireBeginning = false,
  ): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const status = await this.obs.call("GetMediaInputStatus", { inputName });
      const atBeginning = status.mediaCursor !== null && status.mediaCursor <= 500;
      if (
        status.mediaState === "OBS_MEDIA_STATE_PLAYING" &&
        (!requireBeginning || atBeginning)
      ) return;
      await delay(80);
    }
    throw new MediaStartTimeoutError(`${inputName} 未能在 ${timeoutMs}ms 内开始播放`);
  }

  private async waitUntilStopped(inputName: string, timeoutMs: number): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const status = await this.obs.call("GetMediaInputStatus", { inputName });
      if (status.mediaState === "OBS_MEDIA_STATE_STOPPED") return;
      await delay(60);
    }
    this.log("warn", `${inputName} 首帧保持确认超时，切换时仍会强制重新播放`);
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.shuttingDown || !this.wsConfig) return;
    this.reconnecting = true;
    try {
      for (let attempt = 0; attempt < 8 && !this.shuttingDown; attempt += 1) {
        await delay(Math.min(500 * 2 ** attempt, 15_000));
        try {
          await this.obs.connect(
            `ws://127.0.0.1:${this.wsConfig.port}`,
            this.wsConfig.password,
            { eventSubscriptions: EventSubscription.All },
          );
          this.connected = true;
          this.onConnectionChanged(true);
          this.log("info", "OBS 已重新连接");
          return;
        } catch {
          // Continue with the next backoff interval.
        }
      }
      this.log("error", "OBS 重连失败，请检查 OBS 是否仍在运行");
    } finally {
      this.reconnecting = false;
    }
  }
}

class MediaStartTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaStartTimeoutError";
  }
}

function playerSettings(): ObsSettings {
  return {
    is_local_file: true,
    looping: false,
    restart_on_activate: false,
    close_when_inactive: false,
    clear_on_media_end: false,
    hw_decode: true,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
