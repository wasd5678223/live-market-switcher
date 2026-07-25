import { app, BrowserWindow, desktopCapturer, ipcMain, session } from "electron";
import { resolve } from "node:path";
import { ApplicationController } from "./application-controller";
import { loadConfiguration } from "./config";
import type { CropRect, OcrDetection } from "../shared/types";

let mainWindow: BrowserWindow | undefined;
let controller: ApplicationController | undefined;

async function createWindow(): Promise<void> {
  const projectRoot = app.getAppPath();
  const { products, appConfig } = loadConfiguration(projectRoot);

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ["window"] });
    const liveCompanion = sources.find((source) => source.name.trim() === "直播伴侣")
      ?? sources.find((source) => source.name.includes("直播伴侣"));
    callback(liveCompanion ? { video: liveCompanion } : {});
  });

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    title: "卖场调度台",
    backgroundColor: "#171918",
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolve(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  controller = new ApplicationController(projectRoot, products, appConfig, mainWindow);
  registerIpc(controller);

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) await mainWindow.loadURL(devServer);
  else await mainWindow.loadFile(resolve(projectRoot, "dist-renderer/index.html"));

  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  await controller.initialize();
}

function registerIpc(activeController: ApplicationController): void {
  ipcMain.handle("dashboard:get-state", () => activeController.snapshot());
  ipcMain.on("dashboard:submit-message", (_event, text: string) => {
    activeController.submitManualMessage(text);
  });
  ipcMain.on("dashboard:ocr-detections", (_event, detections: OcrDetection[]) => {
    activeController.submitOcrDetections(detections);
  });
  ipcMain.on(
    "dashboard:capture-status",
    (_event, status: "idle" | "starting" | "running" | "error", message: string) => {
      activeController.updateCapture(status, message);
    },
  );
  ipcMain.on("dashboard:update-crop", (_event, crop: CropRect) => {
    activeController.updateCrop(crop);
  });
}

app.whenReady().then(createWindow).catch((error) => {
  console.error(error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void controller?.shutdown();
});
