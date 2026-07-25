import type { MarketBridge } from "../preload/preload";

declare global {
  interface Window {
    market: MarketBridge;
  }
}

export {};
