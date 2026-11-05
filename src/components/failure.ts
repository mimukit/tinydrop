// One toast for every failure. A 401 shows "Token rejected" with an action
// that opens Account; a missing sqlite3 feature names the feature.
import { Toast, showToast } from "@raycast/api";
import { errorMessage, isTokenRejected } from "../api/errors";
import { StoreFeatureError } from "../store/types";

export const TOKEN_REJECTED = "Token rejected";

export async function showFailure(error: unknown, options: { title?: string; openAccount?: () => void } = {}): Promise<void> {
  if (isTokenRejected(error)) {
    await showToast({
      style: Toast.Style.Failure,
      title: TOKEN_REJECTED,
      message: "Raindrop no longer accepts the test token. Paste a new one in Account.",
      primaryAction: options.openAccount ? { title: "Open Account", onAction: options.openAccount } : undefined,
    });
    return;
  }
  if (error instanceof StoreFeatureError) {
    await showToast({ style: Toast.Style.Failure, title: `sqlite3 lacks ${error.feature}`, message: error.message });
    return;
  }
  await showToast({ style: Toast.Style.Failure, title: options.title ?? "Something went wrong", message: errorMessage(error) });
}
