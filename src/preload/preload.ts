import { contextBridge, ipcRenderer } from "electron";
import type { CropRect, DashboardState, OcrDetection } from "../shared/types";

const bridge = {
  getState: (): Promise<DashboardState> => ipcRenderer.invoke("dashboard:get-state"),
  onState: (listener: (state: DashboardState) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: DashboardState) => listener(state);
    ipcRenderer.on("dashboard:state", wrapped);
    return () => ipcRenderer.removeListener("dashboard:state", wrapped);
  },
  submitMessage: (text: string): void => ipcRenderer.send("dashboard:submit-message", text),
  submitOcrDetections: (detections: OcrDetection[]): void =>
    ipcRenderer.send("dashboard:ocr-detections", detections),
  setCaptureStatus: (
    status: DashboardState["captureStatus"],
    message: string,
  ): void => ipcRenderer.send("dashboard:capture-status", status, message),
  updateCrop: (crop: CropRect): void => ipcRenderer.send("dashboard:update-crop", crop),
};

contextBridge.exposeInMainWorld("market", bridge);

export type MarketBridge = typeof bridge;
