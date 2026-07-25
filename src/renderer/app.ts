import { createIcons, icons } from "lucide";
import { createWorker, OEM, PSM, type Worker } from "tesseract.js";
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
    const crop = cropFromInputs();
    applyCropOverlay(crop);
  });
  input.addEventListener("change", () => window.market.updateCrop(cropFromInputs()));
}

window.addEventListener("beforeunload", () => {
  stopCapture();
  void ocrWorker?.terminate();
});

async function startCapture(): Promise<void> {
  try {
    captureLoopActive = true;
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
      elements.ocrActivity.textContent = "OCR SCANNING";
      const detections = await recognizeCurrentFrame();
      if (detections.length > 0) window.market.submitOcrDetections(detections);
      elements.ocrActivity.textContent = detections.length > 0
        ? `OCR ${detections.map((item) => item.text).join(" / ")}`
        : "OCR READY";
    } catch (error) {
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
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = sourceWidth * scale;
  canvas.height = sourceHeight * scale;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return [];
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
        if (line.confidence < 45 || !/(?<!\d)\d{1,4}(?!\d)/.test(text)) continue;
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
  syncCropInputs(next.crop);
  applyCropOverlay(next.crop);
}

function renderRanking(next: DashboardState): void {
  if (next.ranking.length === 0) {
    elements.rankingList.innerHTML = '<div class="empty-row">等待有效数字</div>';
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
  Object.assign(elements.cropOverlay.style, {
    left: `${crop.x * 100}%`, top: `${crop.y * 100}%`,
    width: `${crop.width * 100}%`, height: `${crop.height * 100}%`,
  });
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
