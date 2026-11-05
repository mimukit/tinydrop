import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Form,
  Icon,
  List,
  LocalStorage,
  Toast,
  confirmAlert,
  showToast,
  useNavigation,
} from "@raycast/api";
import { useEffect, useState } from "react";
import { RaindropClient } from "../api/client";
import { errorMessage, isTokenRejected } from "../api/errors";
import { userName, type User } from "../api/types";
import { deleteToken, getAuth, saveToken } from "../auth/secrets";
import { percentile } from "../store/timing";
import { showFailure } from "./failure";
import { currentStore, deleteStore } from "./store";

const ACCOUNT_KEY = "account";

/** What Account shows about the user. No secret: the token stays in the Keychain. */
interface AccountInfo {
  name: string;
  pro: boolean;
}

function accountInfo(user: User): AccountInfo {
  return { name: userName(user), pro: !!user.pro };
}

async function cachedAccount(): Promise<AccountInfo | undefined> {
  const raw = await LocalStorage.getItem<string>(ACCOUNT_KEY);
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw) as AccountInfo;
  } catch {
    return undefined;
  }
}

type State =
  | { phase: "loading" }
  | { phase: "signed-out" }
  | { phase: "signed-in"; info?: AccountInfo; checking: boolean; rejected?: boolean };

/** The p95 of the last searches in this window, as text. */
export function queryTimeText(times: number[]): string {
  const p95 = percentile(times, 95);
  if (p95 === undefined) return "No searches yet in this window";
  return `p95 ${Math.round(p95)} ms over the last ${times.length} ${times.length === 1 ? "search" : "searches"}`;
}

/** `onChange` runs after a sign-in or a sign-out, so the screen that pushed Account can follow it. */
export function AccountView({ onChange }: { onChange?: () => void } = {}) {
  const [state, setState] = useState<State>({ phase: "loading" });

  const load = async () => {
    let token: string | undefined;
    try {
      token = (await getAuth()).token;
    } catch (error) {
      setState({ phase: "signed-out" });
      await showToast({ style: Toast.Style.Failure, title: "Could not read the Keychain", message: errorMessage(error) });
      return;
    }
    if (!token) {
      setState({ phase: "signed-out" });
      return;
    }
    const cached = await cachedAccount();
    setState({ phase: "signed-in", info: cached, checking: true });
    try {
      const info = accountInfo(await new RaindropClient(token).getUser());
      await LocalStorage.setItem(ACCOUNT_KEY, JSON.stringify(info));
      setState({ phase: "signed-in", info, checking: false });
    } catch (error) {
      setState({ phase: "signed-in", info: cached, checking: false, rejected: isTokenRejected(error) });
      await showFailure(error, { title: "Could not check the token" });
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const reload = () => {
    void load();
    onChange?.();
  };

  const signedIn = state.phase === "signed-in";
  const info = signedIn ? state.info : undefined;
  const status =
    state.phase === "loading"
      ? "Checking…"
      : state.phase === "signed-out"
        ? "Not signed in"
        : state.rejected
          ? "Token rejected"
          : info
            ? info.name
            : "Signed in";
  const times = currentStore()?.queryTimes() ?? [];

  return (
    <List isLoading={state.phase === "loading" || (signedIn && state.checking)} navigationTitle="Raindrop Account">
      <List.Section title="Status">
        <List.Item
          title={status}
          subtitle={signedIn && !state.rejected ? "Signed in with a test token" : undefined}
          icon={{
            source: signedIn && !state.rejected ? Icon.CheckCircle : Icon.XMarkCircle,
            tintColor: signedIn && !state.rejected ? Color.Green : Color.Red,
          }}
        />
        {info && <List.Item title="Plan" subtitle={info.pro ? "Raindrop Pro" : "Raindrop free plan"} icon={Icon.Star} />}
        <List.Item title="Query time" subtitle={queryTimeText(times)} icon={Icon.Clock} />
      </List.Section>
      <List.Section title="Sign In">
        <List.Item
          title={signedIn ? "Replace the test token" : "Sign in with a test token"}
          subtitle="app.raindrop.io › Settings › Integrations › Create new app › Create test token"
          icon={Icon.Key}
          actions={
            <ActionPanel>
              <Action.Push title="Enter Test Token" icon={Icon.Key} target={<TokenForm onDone={reload} />} />
            </ActionPanel>
          }
        />
        {signedIn && (
          <List.Item
            title="Sign out"
            subtitle="Removes the token and the bookmark database"
            icon={{ source: Icon.Logout, tintColor: Color.Red }}
            actions={
              <ActionPanel>
                <Action
                  title="Sign Out"
                  icon={Icon.Logout}
                  style={Action.Style.Destructive}
                  onAction={async () => {
                    const ok = await confirmAlert({
                      title: "Sign out of Raindrop?",
                      message: "This removes the stored token and the bookmark database. The next sign-in runs a full sync.",
                      primaryAction: { title: "Sign Out", style: Alert.ActionStyle.Destructive },
                    });
                    if (!ok) return;
                    try {
                      await deleteToken();
                      deleteStore();
                      await LocalStorage.removeItem(ACCOUNT_KEY);
                      reload();
                      await showToast({ style: Toast.Style.Success, title: "Signed out" });
                    } catch (error) {
                      await showFailure(error, { title: "Could not sign out" });
                    }
                  }}
                />
              </ActionPanel>
            }
          />
        )}
      </List.Section>
    </List>
  );
}

export function TokenForm({ onDone }: { onDone: () => void }) {
  const { pop } = useNavigation();
  const [busy, setBusy] = useState(false);
  return (
    <Form
      isLoading={busy}
      navigationTitle="Test Token"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Save Token"
            icon={Icon.Key}
            onSubmit={async (values: { token?: string }) => {
              const token = (values.token ?? "").trim();
              if (!token) return;
              setBusy(true);
              try {
                const user = await new RaindropClient(token).getUser();
                await saveToken(token);
                await LocalStorage.setItem(ACCOUNT_KEY, JSON.stringify(accountInfo(user)));
                onDone();
                pop();
                await showToast({ style: Toast.Style.Success, title: `Signed in as ${userName(user)}` });
              } catch (error) {
                await showFailure(error, { title: "Could not sign in" });
              } finally {
                setBusy(false);
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description text="Create a test token in Raindrop: Settings › Integrations › Create new app, then Create test token. tinydrop checks it with Raindrop and stores it in the macOS Keychain." />
      <Form.PasswordField id="token" title="Test token" />
    </Form>
  );
}
