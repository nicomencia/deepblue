import type { Platform, PlatformAdapter } from "@deepblue/core";
import { wallapopAdapter } from "./wallapop.js";

export const adapters: Partial<Record<Platform, PlatformAdapter>> = {
  wallapop: wallapopAdapter,
  // autoscout24: Phase 1 follow-up (HTML __NEXT_DATA__ scraping, see RECON.md)
};
