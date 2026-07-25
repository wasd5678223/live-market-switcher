import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CropRect, Product } from "../shared/types";

export type AppConfig = {
  crop: CropRect;
  ocrIntervalMs: number;
  lockAheadMs: number;
};

export function loadConfiguration(projectRoot: string): {
  appConfig: AppConfig;
  products: Product[];
} {
  const appConfig = readJson<AppConfig>(resolve(projectRoot, "config/app.json"));
  const catalog = readJson<Product[]>(resolve(projectRoot, "config/catalog.json"));
  const products = catalog.map((product) => ({
    ...product,
    videoPath: resolve(projectRoot, product.videoPath),
    enabled: product.enabled && existsSync(resolve(projectRoot, product.videoPath)),
  }));
  return { appConfig, products };
}

export function saveCrop(projectRoot: string, crop: CropRect): AppConfig {
  const filePath = resolve(projectRoot, "config/app.json");
  const config = readJson<AppConfig>(filePath);
  const next = { ...config, crop };
  writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}
