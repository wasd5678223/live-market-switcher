import { createIcons, icons } from "lucide";
import { createWorker, OEM, PSM, type Worker } from "tesseract.js";
import { containsDigit } from "../shared/digit-parser";
import type { CropRect, DashboardState, OcrDetection } from "../shared/types";
import "./styles.css";

const elements = {
  obsStatus: required("obs-status"),
  captureStatus: required("capture-status"),
  cameraStatus: required("camera-status"),
  captureToggle: required<HTMLButtonElement>("capture-toggle"),
  captureVideo: required<HTMLVideoElement>("capture-video"),
  previewFrame: required("preview-frame"),
  cropOverlay: required("crop-overlay"),
  captureMessage: required("capture-message"),
  ocrActivity: required("ocr-activity"),
  currentCode: required("current-code"),
  remainingLabel: required("remaining-label"),
  remainingProgress: required("remaining-progress"),
  nextStateLabel: required("next-state-label"),
  nextCode: required("next-code"),
  nextDetail: required("next-detail"),
  manualForm: required<HTMLFormElement>("manual-form"),
  manualMessage: required<HTMLInputElement>("manual-message"),
  rankingList: required("ranking-list"),
  logList: required("log-list"),
};

let state = await window.market.getState();
let captureStream: MediaStream | undefined;
let ocrWorker: Worker | undefined;
let captureLoopActive = false;
let ocrBusy = false;
let lastOcrAt = 0;
let ocrScanCount = 0;
let lastDetectedTexts: string[] = [];
let lastOcrDurationMs = 0;
let ocrPhase: "idle" | "loading" | "scanning" | "ready" | "error" = "idle";
let displayedCrop: CropRect = { ...state.crop };
let cropInteraction: CropInteraction | undefined;

type ResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
type CropInteraction = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startCrop: CropRect;
  mode: "move" | ResizeHandle;
};

createIcons({ icons });
render(state);
window.market.onState((next) => {
  state = next;
  render(next);
});

elements.captureToggle.addEventListener("click", () => {
  if (captureLoopActive) stopCapture();
  else void startCapture();
});

elements.manualForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = elements.manualMessage.value.trim();
  if (!text) return;
  window.market.submitMessage(text);
  elements.manualMessage.value = "";
  elements.manualMessage.focus();
});

for (const input of document.querySelectorAll<HTMLInputElement>("[data-crop]")) {
  input.addEventListener("input", () => {
    displayedCrop = boundCrop(cropFromInputs());
    applyCropOverlay(displayedCrop);
  });
  input.addEventListener("change", commitDisplayedCrop);
}

elements.cropOverlay.addEventListener("pointerdown", beginCropInteraction);
elements.cropOverlay.addEventListener("pointermove", updateCropInteraction);
elements.cropOverlay.addEventListener("pointerup", endCropInteraction);
elements.cropOverlay.addEventListener("pointercancel", endCropInteraction);
elements.captureVideo.addEventListener("loadedmetadata", () => applyCropOverlay(displayedCrop));
new ResizeObserver(() => applyCropOverlay(displayedCrop)).observe(elements.previewFrame);

window.addEventListener("beforeunload", () => {
  stopCapture();
  void ocrWorker?.terminate();
});

async function startCapture(): Promise<void> {
  try {
    captureLoopActive = true;
    ocrScanCount = 0;
    lastDetectedTexts = [];
    lastOcrDurationMs = 0;
    ocrPhase = "loading";
    window.market.setCaptureStatus("starting", "正在连接直播伴侣窗口");
    captureStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    elements.captureVideo.srcObject = captureStream;
    await elements.captureVideo.play();
    captureStream.getVideoTracks()[0]?.addEventListener("ended", stopCapture);
    elements.previewFrame.classList.add("active");
    elements.captureToggle.innerHTML = '<i data-lucide="square"></i><span>停止捕获</span>';
    createIcons({ icons });
    window.market.setCaptureStatus("running", "正在识别互动消息");
    void runOcrLoop();
  } catch (error) {
    captureLoopActive = false;
    ocrPhase = "error";
    window.market.setCaptureStatus("error", `捕获失败：${errorMessage(error)}`);
  }
}

function stopCapture(): void {
  captureLoopActive = false;
  captureStream?.getTracks().forEach((track) => track.stop());
  captureStream = undefined;
  elements.captureVideo.srcObject = null;
  elements.previewFrame.classList.remove("active");
  elements.captureToggle.innerHTML = '<i data-lucide="scan-line"></i><span>开始捕获</span>';
  elements.ocrActivity.textContent = "OCR IDLE";
  ocrPhase = "idle";
  createIcons({ icons });
  window.market.setCaptureStatus("idle", "捕获已停止");
}

async function runOcrLoop(): Promise<void> {
  while (captureLoopActive) {
    const elapsed = Date.now() - lastOcrAt;
    const intervalMs = Math.max(750, state.ocrIntervalMs);
    if (elapsed < intervalMs) await delay(intervalMs - elapsed);
    if (!captureLoopActive || ocrBusy) continue;
    ocrBusy = true;
    lastOcrAt = Date.now();
    try {
      const scanStartedAt = performance.now();
      ocrPhase = "scanning";
      elements.ocrActivity.textContent = "OCR SCANNING";
      renderRanking(state);
      const detections = await recognizeCurrentFrame();
      lastOcrDurationMs = performance.now() - scanStartedAt;
      ocrScanCount += 1;
      lastDetectedTexts = detections.map((item) => item.text);
      ocrPhase = "ready";
      if (detections.length > 0) window.market.submitOcrDetections(detections);
      elements.ocrActivity.textContent = detections.length > 0
        ? `OCR #${ocrScanCount} · ${lastDetectedTexts.join(" / ")} · ${formatScanTime(lastOcrDurationMs)}`
        : `OCR READY · #${ocrScanCount} · ${formatScanTime(lastOcrDurationMs)}`;
      renderRanking(state);
    } catch (error) {
      ocrPhase = "error";
      elements.ocrActivity.textContent = "OCR ERROR";
      window.market.setCaptureStatus("error", `识别失败：${errorMessage(error)}`);
      await delay(1_500);
    } finally {
      ocrBusy = false;
    }
  }
}

async function recognizeCurrentFrame(): Promise<OcrDetection[]> {
  const video = elements.captureVideo;
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) return [];
  const crop = state.crop;
  const sourceX = Math.round(video.videoWidth * crop.x);
  const sourceY = Math.round(video.videoHeight * crop.y);
  const sourceWidth = Math.max(1, Math.round(video.videoWidth * crop.width));
  const sourceHeight = Math.max(1, Math.round(video.videoHeight * crop.height));
  const scale = Math.min(2, 640 / sourceWidth, 720 / sourceHeight);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return [];
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.filter = "grayscale(1) contrast(1.9)";
  context.drawImage(
    video,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  const worker = await getOcrWorker();
  const result = await worker.recognize(canvas, {}, { blocks: true, text: true });
  const detections: OcrDetection[] = [];
  for (const block of result.data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        const text = line.text.normalize("NFKC").trim();
        if (!containsDigit(text)) continue;
        detections.push({
          text,
          fingerprint: fingerprintRow(canvas, line.bbox.y0 - 8, line.bbox.y1 + 8),
          position: (line.bbox.y0 + line.bbox.y1) / (2 * canvas.height),
        });
      }
    }
  }
  return detections;
}

async function getOcrWorker(): Promise<Worker> {
  if (ocrWorker) return ocrWorker;
  elements.ocrActivity.textContent = "OCR LOADING";
  const ocrBase = new URL("./ocr/", window.location.href).href;
  ocrWorker = await createWorker("eng", OEM.LSTM_ONLY, {
    workerPath: `${ocrBase}worker.min.js`,
    workerBlobURL: false,
    corePath: ocrBase,
    langPath: ocrBase.replace(/\/$/, ""),
    logger: (message) => {
      if (message.status === "recognizing text") {
        elements.ocrActivity.textContent = `OCR ${Math.round(message.progress * 100)}%`;
      }
    },
  });
  await ocrWorker.setParameters({
    tessedit_char_whitelist: "0123456789",
    tessedit_pageseg_mode: PSM.SPARSE_TEXT,
    preserve_interword_spaces: "1",
  });
  return ocrWorker;
}

function fingerprintRow(canvas: HTMLCanvasElement, top: number, bottom: number): string {
  const sample = document.createElement("canvas");
  sample.width = 9;
  sample.height = 8;
  const context = sample.getContext("2d", { willReadFrequently: true })!;
  const y = Math.max(0, Math.floor(top));
  const height = Math.max(1, Math.min(canvas.height - y, Math.ceil(bottom - top)));
  context.drawImage(canvas, 0, y, canvas.width, height, 0, 0, 9, 8);
  const pixels = context.getImageData(0, 0, 9, 8).data;
  let bits = "";
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const left = luminance(pixels, (row * 9 + column) * 4);
      const right = luminance(pixels, (row * 9 + column + 1) * 4);
      bits += left > right ? "1" : "0";
    }
  }
  return bits.match(/.{4}/g)!.map((nibble) => Number.parseInt(nibble, 2).toString(16)).join("");
}

function luminance(pixels: Uint8ClampedArray, index: number): number {
  return (pixels[index] ?? 0) * 0.2126 + (pixels[index + 1] ?? 0) * 0.7152 + (pixels[index + 2] ?? 0) * 0.0722;
}

function render(next: DashboardState): void {
  setStatus(elements.obsStatus, next.obsConnected, false);
  setStatus(elements.cameraStatus, next.virtualCameraActive, false);
  setStatus(elements.captureStatus, next.captureStatus === "running", next.captureStatus === "error");
  elements.captureMessage.textContent = next.captureMessage;
  elements.currentCode.textContent = next.playback.current;
  elements.remainingLabel.textContent = formatDuration(next.playback.remainingMs);
  elements.remainingProgress.style.width = `${Math.max(0, Math.min(100, (10_000 - next.playback.remainingMs) / 100))}%`;
  const nextCode = next.playback.lockedNext ?? next.playback.tentativeNext;
  elements.nextCode.textContent = nextCode ?? "--";
  elements.nextStateLabel.textContent = next.playback.lockedNext ? "已锁定" : "预热";
  elements.nextDetail.textContent = next.playback.lockedNext ? "等待当前视频结束" : nextCode ? "首帧已准备" : "等待候选";
  renderRanking(next);
  renderLogs(next);
  if (!cropInteraction) displayedCrop = { ...next.crop };
  syncCropInputs(displayedCrop);
  applyCropOverlay(displayedCrop);
}

function renderRanking(next: DashboardState): void {
  if (next.ranking.length === 0) {
    elements.rankingList.innerHTML = emptyRankingState(next);
    return;
  }
  const maximum = next.ranking[0]?.count ?? 1;
  elements.rankingList.innerHTML = next.ranking.map((entry, index) => `
    <div class="ranking-row" style="--heat:${Math.max(8, entry.count / maximum * 100)}%">
      <span class="ranking-code">${escapeHtml(entry.code)}</span>
      <span class="ranking-label">第 ${index + 1} 位</span>
      <strong class="ranking-count">${entry.count}</strong>
    </div>`).join("");
}

function emptyRankingState(next: DashboardState): string {
  if (next.captureStatus === "idle") {
    return '<div class="empty-row ocr-state"><strong>OCR 未开始</strong><span>开始捕获后统计 1 / 2 / 3</span></div>';
  }
  if (next.captureStatus === "starting") {
    return '<div class="empty-row ocr-state"><strong>正在连接直播伴侣</strong><span>等待画面输入</span></div>';
  }
  if (next.captureStatus === "error") {
    return `<div class="empty-row ocr-state error"><strong>OCR 捕获异常</strong><span>${escapeHtml(next.captureMessage)}</span></div>`;
  }
  if (ocrPhase === "loading") {
    return '<div class="empty-row ocr-state"><strong>OCR 正在初始化</strong><span>正在加载本地识别模型</span></div>';
  }
  if (ocrPhase === "scanning" && ocrScanCount === 0) {
    return '<div class="empty-row ocr-state"><strong>OCR 正在识别首帧</strong><span>识别完成后会显示扫描结果</span></div>';
  }
  if (lastDetectedTexts.length > 0) {
    return `<div class="empty-row ocr-state warn"><strong>识别到 ${escapeHtml(lastDetectedTexts.join(" / "))}</strong><span>未新增票：消息重复或不是商品号</span></div>`;
  }
  return `<div class="empty-row ocr-state online"><strong>OCR 正常运行</strong><span>已扫描 ${ocrScanCount} 次 · ${formatScanTime(lastOcrDurationMs)} · 未识别到 1 / 2 / 3</span></div>`;
}

function formatScanTime(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

function renderLogs(next: DashboardState): void {
  if (next.logs.length === 0) return;
  elements.logList.innerHTML = next.logs.map((entry) => `
    <div class="log-row ${entry.level}">
      <span class="log-time">${new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false })}</span>
      <span class="log-level">${entry.level.toUpperCase()}</span>
      <span>${escapeHtml(entry.message)}</span>
    </div>`).join("");
}

function syncCropInputs(crop: CropRect): void {
  for (const input of document.querySelectorAll<HTMLInputElement>("[data-crop]")) {
    const key = input.dataset.crop as keyof CropRect;
    if (document.activeElement !== input) input.value = String(crop[key]);
  }
}

function cropFromInputs(): CropRect {
  const values = {} as CropRect;
  for (const input of document.querySelectorAll<HTMLInputElement>("[data-crop]")) {
    values[input.dataset.crop as keyof CropRect] = Number(input.value);
  }
  return values;
}

function applyCropOverlay(crop: CropRect): void {
  const bounds = displayedVideoBounds();
  Object.assign(elements.cropOverlay.style, {
    left: `${bounds.x + crop.x * bounds.width}px`,
    top: `${bounds.y + crop.y * bounds.height}px`,
    width: `${crop.width * bounds.width}px`,
    height: `${crop.height * bounds.height}px`,
  });
}

function beginCropInteraction(event: PointerEvent): void {
  if (event.button !== 0) return;
  const handle = (event.target as HTMLElement).closest<HTMLElement>("[data-resize]");
  cropInteraction = {
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startCrop: { ...displayedCrop },
    mode: (handle?.dataset.resize as ResizeHandle | undefined) ?? "move",
  };
  elements.cropOverlay.setPointerCapture(event.pointerId);
  elements.cropOverlay.classList.add("dragging");
  event.preventDefault();
}

function updateCropInteraction(event: PointerEvent): void {
  const interaction = cropInteraction;
  if (!interaction || interaction.pointerId !== event.pointerId) return;
  const bounds = displayedVideoBounds();
  if (bounds.width <= 0 || bounds.height <= 0) return;
  const deltaX = (event.clientX - interaction.startClientX) / bounds.width;
  const deltaY = (event.clientY - interaction.startClientY) / bounds.height;
  displayedCrop = interaction.mode === "move"
    ? moveCrop(interaction.startCrop, deltaX, deltaY)
    : resizeCrop(interaction.startCrop, deltaX, deltaY, interaction.mode);
  syncCropInputs(displayedCrop);
  applyCropOverlay(displayedCrop);
}

function endCropInteraction(event: PointerEvent): void {
  if (!cropInteraction || cropInteraction.pointerId !== event.pointerId) return;
  if (elements.cropOverlay.hasPointerCapture(event.pointerId)) {
    elements.cropOverlay.releasePointerCapture(event.pointerId);
  }
  cropInteraction = undefined;
  elements.cropOverlay.classList.remove("dragging");
  commitDisplayedCrop();
}

function commitDisplayedCrop(): void {
  displayedCrop = boundCrop(displayedCrop);
  state = { ...state, crop: displayedCrop };
  syncCropInputs(displayedCrop);
  applyCropOverlay(displayedCrop);
  window.market.updateCrop(displayedCrop);
}

function moveCrop(crop: CropRect, deltaX: number, deltaY: number): CropRect {
  return {
    ...crop,
    x: clamp(crop.x + deltaX, 0, 1 - crop.width),
    y: clamp(crop.y + deltaY, 0, 1 - crop.height),
  };
}

function resizeCrop(
  crop: CropRect,
  deltaX: number,
  deltaY: number,
  handle: ResizeHandle,
): CropRect {
  const minimumSize = 0.05;
  let left = crop.x;
  let top = crop.y;
  let right = crop.x + crop.width;
  let bottom = crop.y + crop.height;
  if (handle.includes("w")) left = clamp(crop.x + deltaX, 0, right - minimumSize);
  if (handle.includes("e")) right = clamp(crop.x + crop.width + deltaX, left + minimumSize, 1);
  if (handle.includes("n")) top = clamp(crop.y + deltaY, 0, bottom - minimumSize);
  if (handle.includes("s")) bottom = clamp(crop.y + crop.height + deltaY, top + minimumSize, 1);
  return { x: left, y: top, width: right - left, height: bottom - top };
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

function displayedVideoBounds(): { x: number; y: number; width: number; height: number } {
  const frameWidth = elements.previewFrame.clientWidth;
  const frameHeight = elements.previewFrame.clientHeight;
  if (frameWidth <= 0 || frameHeight <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  const videoRatio = elements.captureVideo.videoWidth > 0 && elements.captureVideo.videoHeight > 0
    ? elements.captureVideo.videoWidth / elements.captureVideo.videoHeight
    : 16 / 9;
  const frameRatio = frameWidth / frameHeight;
  if (frameRatio > videoRatio) {
    const width = frameHeight * videoRatio;
    return { x: (frameWidth - width) / 2, y: 0, width, height: frameHeight };
  }
  const height = frameWidth / videoRatio;
  return { x: 0, y: (frameHeight - height) / 2, width: frameWidth, height };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function setStatus(element: HTMLElement, online: boolean, warning: boolean): void {
  element.classList.toggle("online", online);
  element.classList.toggle("warning", warning);
}

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "--:--";
  const totalSeconds = Math.ceil(milliseconds / 1_000);
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
