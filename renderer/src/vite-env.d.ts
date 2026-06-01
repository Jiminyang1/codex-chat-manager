/// <reference types="vite/client" />

import type { ActionName, ActionPayload, ActionResult } from "../../src/actions.cjs";

declare global {
  interface Window {
    codexManager?: {
      invoke<Action extends ActionName>(
        action: Action,
        payload?: ActionPayload<Action> | Record<string, unknown>
      ): Promise<ActionResult<Action>>;
    };
  }
}

export {};

