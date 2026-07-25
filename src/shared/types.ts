export type VoteSource = "ocr" | "manual";

export type Product = {
  code: string;
  videoPath: string;
  enabled: boolean;
};

export type VoteEvent = {
  id: string;
  code: string;
  source: VoteSource;
  observedAt: number;
};

export type RankedProduct = {
  code: string;
  count: number;
  lastSeenAt: number;
};

export type PlaybackState = {
  current: string;
  tentativeNext?: string;
  lockedNext?: string;
  remainingMs: number;
};

export type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type OcrDetection = {
  fingerprint: string;
  position: number;
  text: string;
};

export type DashboardState = {
  obsConnected: boolean;
  virtualCameraActive: boolean;
  captureStatus: "idle" | "starting" | "running" | "error";
  captureMessage: string;
  playback: PlaybackState;
  ranking: RankedProduct[];
  crop: CropRect;
  ocrIntervalMs: number;
  logs: Array<{ at: number; level: "info" | "warn" | "error"; message: string }>;
};
