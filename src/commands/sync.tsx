// Sync (no-view): runs the incremental sync and shows a HUD with the counts.
import { showHUD } from "@raycast/api";
import { errorMessage, isTokenRejected } from "../api/errors";
import { TOKEN_REJECTED } from "../components/failure";
import { NotSignedInError, syncNow } from "../components/sync";
import { syncSummary } from "../sync/text";

export default async function Command() {
  try {
    await showHUD(syncSummary(await syncNow()));
  } catch (error) {
    if (error instanceof NotSignedInError) await showHUD(error.message);
    else if (isTokenRejected(error)) await showHUD(`${TOKEN_REJECTED}. Paste a new test token in Account`);
    else await showHUD(`Sync failed: ${errorMessage(error)}`);
  }
}
