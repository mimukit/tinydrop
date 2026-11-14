// Clean Up Bookmarks. Duplicates come from the store and work offline. Dead Links, Unsure and
// Skipped list the link checks; opening one of them starts or resumes a check, which saves each
// result to SQLite as it arrives, so closing the command keeps a pending retry for the next launch.
// Cleanup moves bookmarks to Raindrop Trash in bulk, with one confirmation per operation (count and
// sync age), one ⌘Z undo entry, and a rescan after each operation. Sync First leads every action
// panel when the last sync is an hour old.
import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Icon,
  List,
  Toast,
  confirmAlert,
  environment,
  open,
  showToast,
  useNavigation,
  type Keyboard,
} from "@raycast/api";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { join } from "node:path";
import { getAuth } from "../auth/secrets";
import { saveDeadLinksCsv } from "../cleanup/csv";
import { groupDuplicates, hasAnnotations, type DuplicateGroup } from "../cleanup/duplicates";
import { LinkChecker } from "../cleanup/linkcheck";
import { markLinkLive } from "../cleanup/manual";
import {
  CHECK_VIEWS,
  CLEANUP_VIEWS,
  applyKeepers,
  bulkDeadTargets,
  canIgnoreHost,
  checkRowText,
  checkToast,
  cleanupDoneText,
  clockTime,
  deadConfirm,
  duplicateConfirm,
  duplicatePlan,
  groupText,
  hostOf,
  needsSyncFirst,
  trashConfirm,
  visibleChecks,
  type CleanupViewId,
} from "../cleanup/view";
import { syncAgo } from "../search/format";
import type { CleanupRow, LinkCheckListRow, LinkCheckTarget } from "../store/types";
import { progressText, syncSummary } from "../sync/text";
import type { BookmarkWriter, CleanupResult } from "../write/writer";
import { AccountView } from "./AccountView";
import { EditBookmarkForm } from "./EditBookmarkForm";
import { Picker } from "./Picker";
import { showFailure } from "./failure";
import { openStore } from "./store";
import { syncNow, syncTimes } from "./sync";
import { newWriter, undoneMessage } from "./writer";

const TRASH_KEY: Keyboard.Shortcut = { modifiers: ["cmd"], key: "backspace" };
const UNDO_KEY: Keyboard.Shortcut = { modifiers: ["cmd"], key: "z" };
const SYNC_KEY: Keyboard.Shortcut = { modifiers: ["cmd"], key: "r" };
const RECHECK_KEY: Keyboard.Shortcut = { modifiers: ["cmd", "shift"], key: "r" };
const OPEN_ALL_KEY: Keyboard.Shortcut = { modifiers: ["cmd"], key: "o" };
const KEEPER_KEY: Keyboard.Shortcut = { modifiers: ["cmd"], key: "k" };
const EDIT_KEY: Keyboard.Shortcut = { modifiers: ["cmd"], key: "e" };
const LIVE_KEY: Keyboard.Shortcut = { modifiers: ["cmd"], key: "l" };
/** The check list reloads at most this often while a check saves results. */
const CHECK_RELOAD_MS = 1000;

type Phase = "loading" | "signed-out" | "ready" | "broken";

export function CleanupView() {
  const { push } = useNavigation();
  const [phase, setPhase] = useState<Phase>("loading");
  const [generation, setGeneration] = useState(0);
  const [view, setView] = useState<CleanupViewId>("duplicates");
  const [rows, setRows] = useState<CleanupRow[]>([]);
  const [checks, setChecks] = useState<LinkCheckListRow[]>([]);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [lastSync, setLastSync] = useState<number | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [rescan, setRescan] = useState(0);
  const [approved, setApproved] = useState<ReadonlySet<string>>(new Set());
  const [keepers, setKeepers] = useState<ReadonlyMap<string, number>>(new Map());
  const [scanning, setScanning] = useState(false);
  const [undoSize, setUndoSize] = useState(0);
  const [undoLabel, setUndoLabel] = useState<string | undefined>(undefined);
  const checkerRef = useRef<LinkChecker | undefined>(undefined);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const syncing = useRef(false);
  const busy = useRef(false);
  const checkWrites = useRef<Promise<unknown>>(Promise.resolve());
  const markedLive = useRef(new Map<number, string>());

  // Keep manual decisions after earlier scan writes, and suppress later results from that scan.
  function queueCheckWrite<T>(write: () => Promise<T>): Promise<T> {
    const next = checkWrites.current.then(write);
    checkWrites.current = next.catch(() => undefined);
    return next;
  }

  const openAccount = () => push(<AccountView onChange={() => setGeneration((g) => g + 1)} />);
  const reload = () => setRescan((r) => r + 1);

  // One writer per window: its undo stack ends when the window closes.
  const writerRef = useRef<BookmarkWriter | undefined>(undefined);
  const writer = (writerRef.current ??= newWriter({
    onChange: () => {
      setUndoSize(writerRef.current?.undo.size ?? 0);
      setUndoLabel(writerRef.current?.undo.peek()?.label);
      reload();
    },
    openAccount,
  }));

  // Sign-in state and the store, again after Account changes it.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { token } = await getAuth();
        if (!live) return;
        if (!token) {
          setPhase("signed-out");
          return;
        }
        await openStore();
        if (live) setPhase("ready");
      } catch (error) {
        if (!live) return;
        setPhase("broken");
        await showFailure(error, { title: "Could not open the bookmark store", openAccount });
      }
    })();
    return () => {
      live = false;
    };
  }, [generation]);

  // The rescan: cleanup rows, checks, the ignore list and the sync age, after every operation.
  useEffect(() => {
    if (phase !== "ready") return;
    let live = true;
    (async () => {
      try {
        const store = await openStore();
        const [found, foundChecks, hosts, times] = await Promise.all([store.cleanupRows(), store.linkChecks(), store.ignoredHosts(), syncTimes()]);
        if (!live) return;
        setRows(found);
        setChecks(foundChecks);
        setIgnored(hosts);
        setLastSync(times.lastSync);
        setLoaded(true);
      } catch (error) {
        if (live) await showFailure(error, { title: "Could not read the store", openAccount });
      }
    })();
    return () => {
      live = false;
    };
  }, [phase, rescan]);

  // Stop the check when the command closes. Saved results and pending retries stay in SQLite.
  useEffect(
    () => () => {
      checkerRef.current?.stop();
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
    },
    [],
  );

  /** Reloads the check list at most once a second while a check saves results. */
  const reloadSoon = () => {
    if (reloadTimer.current) return;
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = undefined;
      reload();
    }, CHECK_RELOAD_MS);
  };

  /** Runs one link check: the store's work (missing, old, changed, pending) or the given targets. */
  const startCheck = async (targets?: LinkCheckTarget[]) => {
    if (checkerRef.current) return;
    let checker: LinkChecker | undefined;
    try {
      const store = await openStore();
      await store.invalidateLinkChecks();
      const work = targets ?? (await store.linkCheckWork(Date.now()));
      if (work.length === 0 || checkerRef.current) return;
      if (targets) for (const target of targets) markedLive.current.delete(target.id);
      const hosts = await store.ignoredHosts();
      const toast = showToast({ style: Toast.Style.Animated, title: "Checking links" });
      checker = new LinkChecker({
        ignoredHosts: hosts,
        save: async (row) => {
          await queueCheckWrite(async () => {
            if (markedLive.current.get(row.bookmarkId) !== row.url) await store.saveLinkCheck(row);
          });
          reloadSoon();
        },
        onSaveError: (error) => void showFailure(error, { title: "Could not save a link check" }),
        onProgress: (progress) => {
          const text = checkToast(progress);
          void toast.then((t) => {
            if (!text) return t.hide();
            t.style = text.style === "success" ? Toast.Style.Success : Toast.Style.Animated;
            t.title = text.title;
            t.message = text.message;
          });
        },
      });
      checkerRef.current = checker;
      setScanning(true);
      await checker.run(work);
    } catch (error) {
      await showFailure(error, { title: "Link check failed" });
    } finally {
      if (checker && checkerRef.current === checker) {
        checkerRef.current = undefined;
        if (!checker.stopped) {
          setScanning(false);
          reload();
        }
      }
    }
  };

  // Opening a check view starts or resumes the check.
  useEffect(() => {
    if (phase === "ready" && loaded && CHECK_VIEWS.has(view)) void startCheck();
  }, [phase, loaded, view]);

  const sync = async () => {
    if (syncing.current) return;
    syncing.current = true;
    const toast = await showToast({ style: Toast.Style.Animated, title: "Syncing" });
    try {
      const result = await syncNow({ onProgress: (p) => (toast.message = progressText(p.done, p.total)) });
      toast.style = Toast.Style.Success;
      toast.title = syncSummary(result);
      toast.message = undefined;
      reload();
    } catch (error) {
      await toast.hide();
      await showFailure(error, { title: "Sync failed", openAccount });
    } finally {
      syncing.current = false;
    }
  };

  /** One bulk operation: a progress toast, then the counts. The writer reports a partial result itself. */
  const runCleanup = async (title: string, work: () => Promise<CleanupResult>) => {
    if (busy.current) return;
    busy.current = true;
    const toast = await showToast({ style: Toast.Style.Animated, title });
    try {
      const result = await work();
      const text = cleanupDoneText(result);
      if (text) {
        toast.style = Toast.Style.Success;
        toast.title = text;
      } else {
        await toast.hide();
      }
    } catch (error) {
      await toast.hide();
      await showFailure(error, { title: `Could not finish: ${title}`, openAccount });
    } finally {
      busy.current = false;
      reload();
    }
  };

  const now = Date.now();
  const syncAge = syncAgo(lastSync, now);
  const ignoredSet = new Set(ignored);
  const groups = applyKeepers(groupDuplicates(rows), keepers);

  const confirm = (c: { title: string; message: string }, action: string) =>
    confirmAlert({
      title: c.title,
      message: c.message,
      primaryAction: { title: action, style: Alert.ActionStyle.Destructive },
      dismissAction: { title: "Cancel" },
    });

  const trashExtras = async (targetGroups: DuplicateGroup[], label: string) => {
    const plan = duplicatePlan(targetGroups, approved);
    if (plan.count === 0) {
      await showToast({ style: Toast.Style.Failure, title: "Nothing to move", message: "Approve the annotated extras first" });
      return;
    }
    if (!(await confirm(duplicateConfirm(plan, syncAge), "Move to Trash"))) return;
    await runCleanup(label, () => writer.cleanupDuplicates(plan.groups, { label, approvedAnnotated: approved }));
  };

  const approveGroup = async (group: DuplicateGroup) => {
    const confirmed = await confirmAlert({
      title: `Include ${group.warnings.length} annotated extra${group.warnings.length === 1 ? "" : "s"}?`,
      message: "Cleanup does not merge notes or highlights into the keeper. These extras go to Trash with the others.",
      primaryAction: { title: "Include", style: Alert.ActionStyle.Destructive },
      dismissAction: { title: "Cancel" },
    });
    if (confirmed) setApproved((s) => new Set([...s, group.key]));
  };

  const trashAllDead = async () => {
    const targets = bulkDeadTargets(checks, rows, ignoredSet);
    if (targets.length === 0) return;
    if (!(await confirm(deadConfirm(targets.length, syncAge), "Move to Trash"))) return;
    await runCleanup("Trash All Dead", () => writer.trashBookmarks(targets, { label: "Trash All Dead" }));
  };

  const trashOne = async (check: LinkCheckListRow) => {
    const row = rows.find((r) => r.id === check.bookmarkId);
    if (!row) return;
    if (!(await confirm(trashConfirm(check.title || check.url, syncAge), "Move to Trash"))) return;
    await runCleanup("Trash", () => writer.trashBookmarks([{ id: row.id, collectionId: row.collectionId }], { label: "Trash" }));
  };

  const editBookmark = async (check: LinkCheckListRow) => {
    try {
      const store = await openStore();
      const [row, collections, tags] = await Promise.all([store.getBookmark(check.bookmarkId), store.collections(), store.tags()]);
      if (!row || row.collectionId === -99) {
        reload();
        await showToast({ style: Toast.Style.Failure, title: "The bookmark is no longer available", message: "Sync the library and try again" });
        return;
      }
      push(
        <EditBookmarkForm
          row={row}
          collections={collections}
          tags={tags}
          onSubmit={(patch) => writer.update(row, patch, { label: "Edit", message: "Bookmark updated" })}
        />,
      );
    } catch (error) {
      await showFailure(error, { title: "Could not open the bookmark editor", openAccount });
    }
  };

  const markAsLive = async (check: LinkCheckListRow) => {
    try {
      const store = await openStore();
      const saved = await queueCheckWrite(async () => {
        const saved = await markLinkLive(store, check);
        if (saved) markedLive.current.set(check.bookmarkId, check.url);
        return saved;
      });
      reload();
      await showToast(saved
        ? { style: Toast.Style.Success, title: "Marked as live" }
        : { style: Toast.Style.Failure, title: "The bookmark changed or is no longer available", message: "Sync the library and try again" });
    } catch (error) {
      await showFailure(error, { title: "Could not mark the link as live" });
    }
  };

  const ignoreHost = async (host: string) => {
    try {
      await (await openStore()).addIgnoredHost(host);
      await showToast({ style: Toast.Style.Success, title: `Ignoring ${host}`, message: "Its links leave the check views" });
    } catch (error) {
      await showFailure(error, { title: "Could not ignore the host" });
    }
    reload();
  };

  const stopIgnoring = async (host: string) => {
    try {
      await (await openStore()).removeIgnoredHost(host);
      await showToast({ style: Toast.Style.Success, title: `Stopped ignoring ${host}`, message: "The next check covers its links" });
    } catch (error) {
      await showFailure(error, { title: "Could not stop ignoring the host" });
    }
    reload();
  };

  const undo = async () => {
    const entry = await writer.undoLast({ message: undoneMessage });
    if (entry) await showToast({ style: Toast.Style.Success, title: undoneMessage(entry) });
  };

  const exportDeadLinks = async () => {
    try {
      const store = await openStore();
      const directory = join(environment.supportPath, "exports");
      const result = saveDeadLinksCsv(directory, await store.linkChecks(), new Set(await store.ignoredHosts()));
      if (!result) {
        await showToast({ style: Toast.Style.Success, title: "No confirmed dead links to export", message: "Pending retries are excluded" });
        return;
      }
      await showToast({
        style: Toast.Style.Success,
        title: `Exported ${result.count} dead link${result.count === 1 ? "" : "s"}`,
        message: result.path,
        primaryAction: {
          title: "Open Export Folder",
          onAction: () => open(directory).catch((error) => showFailure(error, { title: "Could not open the export folder" })),
        },
      });
    } catch (error) {
      await showFailure(error, { title: "Could not export dead links" });
    }
  };

  // ─── Shared actions ─────────────────────────────────────────────

  const syncFirst = needsSyncFirst(lastSync, now) ? (
    <Action title="Sync First" icon={Icon.ArrowClockwise} onAction={() => void sync()} />
  ) : null;
  const undoAction =
    undoSize > 0 ? <Action title={`Undo ${undoLabel ?? ""}`.trim()} icon={Icon.Undo} shortcut={UNDO_KEY} onAction={() => void undo()} /> : null;
  const commonActions = (
    <ActionPanel.Section>
      {view === "dead" && <Action title="Export Dead Links CSV" icon={Icon.Download} onAction={() => void exportDeadLinks()} />}
      {undoAction}
      {syncFirst ? null : <Action title="Sync Now" icon={Icon.ArrowClockwise} shortcut={SYNC_KEY} onAction={() => void sync()} />}
      <Action title="Account" icon={Icon.Person} onAction={openAccount} />
    </ActionPanel.Section>
  );

  const placeholder = (title: string, subtitle?: string, extra?: ReactNode) => (
    <List.Item
      title={title}
      subtitle={subtitle}
      icon={Icon.CheckCircle}
      actions={
        <ActionPanel>
          {syncFirst}
          {extra}
          {commonActions}
        </ActionPanel>
      }
    />
  );

  // ─── Views ──────────────────────────────────────────────────────

  const keeperPicker = (group: DuplicateGroup) => (
    <Picker
      title="Choose Keeper"
      options={group.rows.map((r) => ({
        id: String(r.id),
        title: `${r.title || r.link}${hasAnnotations(r) ? " · annotated" : ""}${r.important ? " · favorite" : ""} · ${r.id}`,
        icon: r.id === group.keeper.id ? Icon.Checkmark : Icon.Circle,
        selected: r.id === group.keeper.id,
        onPick: () => setKeepers((m) => new Map([...m, [group.key, r.id]])),
      }))}
    />
  );

  const duplicateItems = () => {
    if (groups.length === 0) return placeholder("No duplicate groups", syncAge);
    return (
      <List.Section title="Duplicate groups" subtitle={`${groups.length}`}>
        {groups.map((group) => {
          const text = groupText(group, approved);
          const isApproved = approved.has(group.key);
          return (
            <List.Item
              key={group.key}
              id={`group-${group.key}`}
              title={text.title}
              subtitle={text.host}
              icon={Icon.CopyClipboard}
              accessories={[
                ...(text.annotated
                  ? [{ tag: { value: text.annotated, color: isApproved ? Color.Red : Color.Orange }, tooltip: "Extras with notes or highlights" }]
                  : []),
                { text: text.count },
              ]}
              actions={
                <ActionPanel>
                  {syncFirst}
                  <ActionPanel.Section title="Group">
                    <Action
                      title="Trash Extras"
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      shortcut={TRASH_KEY}
                      onAction={() => void trashExtras([group], "Trash Extras")}
                    />
                    {group.warnings.length > 0 && !isApproved && (
                      <Action title="Include Annotated Extras" icon={Icon.ExclamationMark} onAction={() => void approveGroup(group)} />
                    )}
                    {isApproved && (
                      <Action
                        title="Skip Annotated Extras"
                        icon={Icon.XMarkCircle}
                        onAction={() => setApproved((s) => new Set([...s].filter((k) => k !== group.key)))}
                      />
                    )}
                    <Action.Push title="Choose Keeper" icon={Icon.Star} shortcut={KEEPER_KEY} target={keeperPicker(group)} />
                    <Action
                      title="Open All"
                      icon={Icon.Globe}
                      shortcut={OPEN_ALL_KEY}
                      onAction={() => void Promise.all(group.rows.map((r) => open(r.link)))}
                    />
                  </ActionPanel.Section>
                  <ActionPanel.Section>
                    <Action
                      title="Trash All Extras"
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      onAction={() => void trashExtras(groups, "Trash All Extras")}
                    />
                  </ActionPanel.Section>
                  {commonActions}
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>
    );
  };

  const deadCount = bulkDeadTargets(checks, rows, ignoredSet).length;
  const trashAllDeadAction =
    view === "dead" && deadCount > 0 ? (
      <Action title="Trash All Dead" icon={Icon.Trash} style={Action.Style.Destructive} onAction={() => void trashAllDead()} />
    ) : null;

  const checkItem = (check: LinkCheckListRow) => {
    const text = checkRowText(check, now);
    const host = hostOf(check.url);
    return (
      <List.Item
        key={check.bookmarkId}
        id={`check-${check.bookmarkId}`}
        title={text.title}
        subtitle={text.host}
        icon={check.class === "dead" ? { source: Icon.XMarkCircle, tintColor: Color.Red } : check.class === "pending" ? Icon.Clock : Icon.QuestionMarkCircle}
        accessories={[{ text: text.reason }, { text: text.time }]}
        actions={
          <ActionPanel>
            {syncFirst}
            <ActionPanel.Section title="Bookmark">
              <Action title="Open" icon={Icon.Globe} onAction={() => void open(check.url)} />
              {(view === "dead" || view === "unsure") && (
                <Action title="Edit Bookmark" icon={Icon.Pencil} shortcut={EDIT_KEY} onAction={() => void editBookmark(check)} />
              )}
              {view === "unsure" && <Action title="Mark as Live" icon={Icon.CheckCircle} shortcut={LIVE_KEY} onAction={() => void markAsLive(check)} />}
              {!scanning && (
                <Action
                  title="Recheck"
                  icon={Icon.RotateClockwise}
                  shortcut={RECHECK_KEY}
                  onAction={() => void startCheck([{ id: check.bookmarkId, link: check.url }])}
                />
              )}
              <Action title="Trash" icon={Icon.Trash} style={Action.Style.Destructive} shortcut={TRASH_KEY} onAction={() => void trashOne(check)} />
              {trashAllDeadAction}
              {host && canIgnoreHost(check) && <Action title="Ignore Host" icon={Icon.EyeDisabled} onAction={() => void ignoreHost(host)} />}
            </ActionPanel.Section>
            {commonActions}
          </ActionPanel>
        }
      />
    );
  };

  const checkItems = () => {
    const visible = visibleChecks(checks, view, ignoredSet);
    if (visible.length === 0) {
      const name = CLEANUP_VIEWS.find((v) => v.value === view)?.title ?? "";
      return placeholder(scanning ? "Checking links…" : `No results in ${name}`, scanning ? "Results appear as they arrive" : undefined);
    }
    if (view !== "dead") return visible.map(checkItem);
    const dead = visible.filter((c) => c.class === "dead");
    const pending = visible.filter((c) => c.class === "pending");
    const nextRetry = pending.reduce<number | undefined>((m, c) => (c.retryDue !== undefined && (m === undefined || c.retryDue < m) ? c.retryDue : m), undefined);
    return (
      <>
        {dead.length > 0 && (
          <List.Section title="Dead" subtitle={`${dead.length}`}>
            {dead.map(checkItem)}
          </List.Section>
        )}
        {pending.length > 0 && (
          <List.Section title="Retry pending" subtitle={nextRetry !== undefined ? `Earliest retry ${clockTime(nextRetry)}` : undefined}>
            {pending.map(checkItem)}
          </List.Section>
        )}
      </>
    );
  };

  const ignoredItems = () => {
    if (ignored.length === 0) return placeholder("No ignored hosts", "Ignore Host on a checked link adds one");
    return ignored.map((host) => {
      const count = rows.filter((r) => hostOf(r.link) === host).length;
      return (
        <List.Item
          key={host}
          id={`host-${host}`}
          title={host}
          icon={Icon.EyeDisabled}
          accessories={[{ text: `${count} bookmark${count === 1 ? "" : "s"}` }]}
          actions={
            <ActionPanel>
              {syncFirst}
              <Action title="Stop Ignoring" icon={Icon.Eye} onAction={() => void stopIgnoring(host)} />
              {commonActions}
            </ActionPanel>
          }
        />
      );
    });
  };

  if (phase === "signed-out") {
    return (
      <List navigationTitle="Clean Up Bookmarks">
        <List.Item
          title="Sign in with a Raindrop test token"
          icon={Icon.Key}
          actions={
            <ActionPanel>
              <Action title="Open Account" icon={Icon.Person} onAction={openAccount} />
            </ActionPanel>
          }
        />
      </List>
    );
  }

  return (
    <List
      isLoading={phase === "loading" || (phase === "ready" && !loaded) || scanning}
      navigationTitle={phase === "ready" ? `Clean Up Bookmarks · ${syncAge}` : "Clean Up Bookmarks"}
      searchBarPlaceholder="Filter"
      searchBarAccessory={
        <List.Dropdown tooltip="View" value={view} onChange={(v) => setView(v as CleanupViewId)}>
          {CLEANUP_VIEWS.map((v) => (
            <List.Dropdown.Item key={v.value} value={v.value} title={v.title} />
          ))}
        </List.Dropdown>
      }
    >
      {phase === "broken" && (
        <List.Item
          title="The bookmark store did not open"
          subtitle="See the toast for the reason"
          icon={{ source: Icon.Warning, tintColor: Color.Red }}
          actions={
            <ActionPanel>
              <Action title="Account" icon={Icon.Person} onAction={openAccount} />
            </ActionPanel>
          }
        />
      )}
      {phase === "ready" && loaded && view === "duplicates" && duplicateItems()}
      {phase === "ready" && loaded && CHECK_VIEWS.has(view) && checkItems()}
      {phase === "ready" && loaded && view === "ignored" && ignoredItems()}
    </List>
  );
}
