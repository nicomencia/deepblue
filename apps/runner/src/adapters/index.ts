import type { Platform, PlatformAdapter } from "@deepblue/core";
import { autoscout24Adapter } from "./autoscout24.js";
import { wallapopAdapter } from "./wallapop.js";

export const adapters: Partial<Record<Platform, PlatformAdapter>> = {
  wallapop: wallapopAdapter,
  autoscout24: autoscout24Adapter,
};
