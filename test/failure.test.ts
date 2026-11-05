import { beforeEach, describe, expect, it, vi } from "vitest";

const toasts: Array<Record<string, unknown>> = [];
vi.mock("@raycast/api", () => ({
  Toast: { Style: { Failure: "failure", Success: "success" } },
  showToast: async (options: Record<string, unknown>) => void toasts.push(options),
}));

const { showFailure, TOKEN_REJECTED } = await import("../src/components/failure");
const { RaindropApiError } = await import("../src/api/errors");
const { StoreFeatureError } = await import("../src/store/types");

describe("showFailure", () => {
  beforeEach(() => void (toasts.length = 0));

  it("shows Token rejected with an action that opens Account on a 401", async () => {
    const openAccount = vi.fn();
    await showFailure(new RaindropApiError(401, "/user", ""), { openAccount });
    expect(toasts[0].title).toBe(TOKEN_REJECTED);
    const action = toasts[0].primaryAction as { title: string; onAction: () => void };
    expect(action.title).toBe("Open Account");
    action.onAction();
    expect(openAccount).toHaveBeenCalledOnce();
  });

  it("does not say Token rejected for a 500", async () => {
    await showFailure(new RaindropApiError(500, "/user", "boom"), { title: "Sync failed", openAccount: () => undefined });
    expect(toasts[0].title).toBe("Sync failed");
    expect(toasts[0].primaryAction).toBeUndefined();
  });

  it("names the missing sqlite3 feature", async () => {
    await showFailure(new StoreFeatureError("FTS5", "no such module: fts5"));
    expect(toasts[0].title).toBe("sqlite3 lacks FTS5");
  });
});
