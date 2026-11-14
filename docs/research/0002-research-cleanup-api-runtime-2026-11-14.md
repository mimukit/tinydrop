# Research: cleanup API and Tinycast runtime (Phase 1)

Date: 2026-11-14. Plan: [0002-plan-bookmark-cleanup-2026-11-14.md](../plans/0002-plan-bookmark-cleanup-2026-11-14.md), "Phase 1: verify the API and Tinycast runtime".

## Method

The API half ran `PROBE_ONLY=cleanup pnpm probe` (`scripts/probe.mjs`) against `https://api.raindrop.io/rest/v1` with the test token from `RAINDROP_TOKEN`. The new cleanup section shares the pacer, the nonce and the leftover sweep with the 2026-11-05 probe. Without `PROBE_ONLY` the probe runs the old checks and then the cleanup section.

The section makes two bookmarks in Unsorted (collection `-1`): `tinydrop cleanup probe A` (`https://example.com/tinydrop-cleanup-probe-a`) and `tinydrop cleanup probe B` (`https://example.com/tinydrop-cleanup-probe-b`). Every bulk call goes through one guard, `bulkCall()`, which refuses a call without a non-empty `ids` array, refuses any ID that the run did not create, refuses a bulk `DELETE` to collection `0` or `-99`, and refuses a bulk `PUT` to collection `0`. No bulk call carries a `search` parameter. Before the first bulk trash the probe pages all of Unsorted, and after it the probe checks that no other Unsorted bookmark moved. The two probes are deleted one by one with `DELETE /raindrop/{id}` in a `finally` block.

The runtime half reads the Tinycast checkout at `/home/dev/projects/tinycast`, commit `dc265b263ad9afad1978f79d1d3533bb144bef0a`. Paths below are relative to that checkout. Each runtime fact carries one of three labels:

- Source: proved by reading the Swift or JS source.
- Test: a Tinycast test exercises it.
- Unverified: neither source nor test settles it. Phase 6 on macOS must check it.

The JS runtime test (`Scripts/raycast-runtime/test.mjs`) and tinydrop's `pnpm smoke` answer `fetch.request` with Node's own `fetch` (`test.mjs:335-350`). Neither proves native URLSession behavior, and this report does not use them as proof of it.

## API results

Primary documentation: [developer.raindrop.io/v1/raindrops/multiple](https://developer.raindrop.io/v1/raindrops/multiple), read on 2026-11-14.

- Update many: `PUT /raindrops/{collectionId}` with optional `search` and/or `ids`. Body `collection: { "$id": N }` moves the bookmarks.
- Remove many: `DELETE /raindrops/{collectionId}` with optional `search` and/or `ids`, moves to Trash. "When `:collectionId` is **-99**, raindrops will be permanently removed!"
- Collection `0`: "Warning: update or remove methods not support 0 yet. Will be fixed in future."
- `ids`: "You can specify exact raindrop ID's for batch update/remove methods."
- Limits: "Maximum 100 objects in array!" applies to Create many (`POST /raindrops`). The page states no limit for update many or remove many.
- Documented remove reply: `{ "result": true, "modified": 330 }`. The update reply is documented as an empty 200.

The plan proposed `DELETE /raindrops/0`. The documentation says remove does not support `0`, and nothing documents how a remove to `0` treats `ids`. The probe therefore did not send it, so an unknown failure mode could not reach the owner's library. The collection-scoped form below is documented and worked.

Probe run on 2026-11-14 (bookmarks `1928669526` and `1928669530`, 31 calls, 16.9 s, no 429, no errors):

| Step | Request | Status | Reply body | State after |
|------|---------|--------|------------|-------------|
| Create A, B | `POST /raindrop`, `collection.$id: -1` | 200 | `item` | both in `-1` |
| Bulk trash | `DELETE /raindrops/-1`, body `{ "ids": [A, B] }` | 200 | `{ "result": true, "matched": 2, "modified": 2 }` | both in `-99` |
| Restore, wrong source | `PUT /raindrops/-1`, body `{ "collection": { "$id": -1 }, "ids": [A, B] }` | 200 | `{ "result": true, "matched": 0, "modified": 0 }` | both still in `-99` |
| Restore from Trash | `PUT /raindrops/-99`, body `{ "collection": { "$id": -1 }, "ids": [A, B] }` | 200 | `{ "result": true, "matched": 2, "modified": 2 }` | both in `-1` |
| Bulk trash again | `DELETE /raindrops/-1`, body `{ "ids": [A, B] }` | 200 | `{ "result": true, "matched": 2, "modified": 2 }` | both in `-99` |

Unsorted held 4 bookmarks before the first bulk trash and 2 after it. No other Unsorted bookmark moved (`otherUnsortedMoved: 0`).

What the run shows:

- The path collection is a filter. The server applies `ids` inside the path collection only. The wrong-source restore matched 0 of 2 IDs, so an ID outside the path collection is left alone.
- The bulk replies carry `matched` as well as `modified`. Neither field is per-ID, so the reply does not say which IDs changed.
- Restore works with source `-99` and target `collection.$id`.
- A bulk call to a collection that holds none of the IDs still returns 200 and `result: true`. A caller must read `modified`, not `result`, to learn whether anything moved.

### Batch limit

The documentation states no limit for update many or remove many. The only documented array limit is 100, for Create many. The probe tested 2 IDs, because the owner approved two probe bookmarks and no more. A larger live test would need more probe bookmarks and a new approval. Keep the plan's batch of at most 100 IDs, which stays inside the only documented array limit.

## Probe cleanup

Each probe was in Trash after the last step, so one `DELETE /raindrop/{id}` per probe removed it for good (status 200 each). Afterward:

- `GET /raindrop/1928669526` and `GET /raindrop/1928669530` both returned 404.
- A `tinydrop` search of the library and of Trash found no probe.
- A full page pass of Unsorted and of Trash (1 page) found no probe.
- A separate read-only full pass of the library (`/raindrops/0`, 1,964 bookmarks, 40 pages) and of Trash (44 bookmarks) found no bookmark with either probe ID or a probe link.

## Tinycast fetch bridge

The JS `fetch` is `tinycastFetch` (`Scripts/raycast-runtime/src/polyfills.js:379-397`). It sends `{ url, method, headers, bodyBase64 }` to the host call `fetch.request` and nothing else. `ExtensionHostBridge.fetch` (`Tinycast/Features/Extensions/Service/ExtensionHostBridge.swift:167-192`) passes that spec to `ExtensionFetcher.request` (`Tinycast/Features/Extensions/Service/ExtensionFetcher.swift:37-75`). The fetcher runs `session.data(for:)` on one ephemeral `URLSession` with no delegate (`ExtensionFetcher.swift:8-19, 59`). The whole body comes back base64-encoded in one reply.

| Capability | Finding | Evidence | Label |
|------------|---------|----------|-------|
| HEAD | Supported. The method string goes to `URLRequest.httpMethod` unchanged. | `ExtensionFetcher.swift:45`; `polyfills.js:369, 387` | Source for URLSession. Test only for the Unix-socket path (`Tests/ext-fetch-test.swift:169-170`). |
| Custom headers (User-Agent, Accept) | Supported. JS lowercases the names (`polyfills.js:127-129`) and every header reaches `request.setValue(_:forHTTPHeaderField:)`. User-Agent and Accept are not on Apple's list of reserved URLRequest headers. | `ExtensionFetcher.swift:46-49`; `polyfills.js:388` | Source. A test covers Authorization only (`ext-fetch-test.swift:30-41, 48-73`). That the server sees the custom User-Agent is unverified. |
| Timeout | No per-request timeout. The session sets `timeoutIntervalForRequest = 60`, an idle timeout, and leaves the resource timeout at the URLSession default. | `ExtensionFetcher.swift:13` | Source |
| AbortController cancellation | Not carried across the bridge. `fetch` checks `signal.aborted` before the host call and again after the host reply (`polyfills.js:382, 392`). An abort during the request does not reject the promise. The caller waits for the full reply and then gets `AbortError`. `AbortSignal.timeout` only fires the signal (`polyfills.js:492-496`). Tinycast documents the limit (`docs/features/extensions.md:846`). | `polyfills.js:379-397` | Source |
| Timers for a JS timeout | `setTimeout` is host-backed, so `Promise.race` with a timer works while the command runs. | `Tinycast/Features/Extensions/Service/ExtensionRuntime.swift:211-227, 309-322` | Source |
| Redirects followed | Yes, natively. The session has no delegate, so URLSession follows redirects with its default policy before JS sees anything. | `ExtensionFetcher.swift:18, 59` | Source. No Tinycast test covers redirects. |
| `redirect: "manual"` | Not supported. `TinycastRequest` does not read `init.redirect` and the host spec has no such field. | `polyfills.js:360-377, 384-391` | Source |
| Final URL | Available. Swift returns `response.url?.absoluteString` and JS sets `Response.url` from it. | `ExtensionFetcher.swift:72`; `polyfills.js:393-397, 317` | Source |
| `response.redirected` | Always `false`. | `polyfills.js:319` | Source |
| Redirect to an excluded host | Possible. URLSession follows every hop, to localhost, private addresses or `.local` hosts included, before JS can check it. JS sees only the final URL. Intermediate hops are invisible. | `ExtensionFetcher.swift:18, 59, 72` | Source |
| DNS failure vs other errors | Not distinguishable. A thrown Swift error crosses as its localized description string only (`ExtensionRuntime.swift:253-256`), and JS wraps it as `new Error(String(payload))` (`Scripts/raycast-runtime/src/host.js:47-48`). No `URLError` code reaches JS. The message text follows the macOS language. | `ExtensionRuntime.swift:241-259`; `host.js:43-50` | Source |
| TLS errors | Same as DNS: a localized message string, no code. | same as above | Source |
| Plain `http://` links | `Tinycast/Info.plist` has no `NSAppTransportSecurity` key. App Transport Security probably blocks cleartext loads to public hosts, which would throw an error. | `Tinycast/Info.plist` (no ATS key) | Unverified |
| Large GET bodies | The whole body downloads and crosses the bridge base64-encoded, with no streaming. | `ExtensionFetcher.swift:59-74`; `docs/features/extensions.md` "Streaming HTTP" row | Source |

## Runtime lifetime on close and hide

- Leaving the command ends its runtime. Escape past an empty search calls `extensions.stop()` (`Tinycast/Features/Extensions/UI/ExtensionCoordinator.swift:263-269`). Any mode change away from `.extensionCommand` also calls it (`Tinycast/Palette/RootPaletteView.swift:465-468`). Label: source.
- `ExtensionManager.stop()` calls `runtime.stop(session:)`, which unmounts the React tree (`Scripts/raycast-runtime/src/index.js:183-187`), so effect cleanups run. It then calls `runtime.shutdown()` (`Tinycast/Features/Extensions/Service/ExtensionManager.swift:489-500`). Label: source.
- `shutdown()` cancels every timer and every pending host task, drops the `JSContext` and changes the generation, so late replies are discarded (`ExtensionRuntime.swift:334-346, 261-268`). A cancelled host task cancels its URLSession request: `Tests/ext-fetch-test.swift:48-73` proves that cancelling a `fetcher.request` task returns `URLError.cancelled` and leaves other requests running. Label: source and test.
- Hiding the palette schedules Pop to Root Search (`Tinycast/Palette/PaletteWindowController.swift:151-170, 180-204`). Pop to root sets the mode to `.launcher`, which stops the command. The default timeout is `.immediately` (`Tinycast/Features/Settings/AppSettings.swift:736-738`), so with default settings a hide ends the command at once. With a 5 to 90 second setting, the command keeps running while hidden until the timer fires. A re-summon inside that window keeps it. During an extension sign-in no reset is scheduled. Label: source.

The runtime does not survive a close. Nothing in the command can keep running, and a pending retry can only resume from SQLite on the next launch.

## Safari User-Agent

Use this string:

```
Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15
```

Safari on macOS freezes the OS token at `10_15_7` and the WebKit token at `605.1.15`. Only `Version/` moves. Apple's Safari release notes list 27.2 as the newest release, released on October 26, 2026 (build 20625.2.8), with 27.3 still in beta. The string was assembled from that frozen format and that version, not captured from a running Safari. Phase 6 can compare it with Safari on the Mac.

## Decisions for Phases 3 and 4

1. Bulk trash: `DELETE /raindrops/{sourceCollectionId}` with body `{ "ids": [...] }`, one call per source collection and batch. Do not use `DELETE /raindrops/0`, which the documentation says is unsupported. Never use `-99` as the remove path, because that deletes for good. Group the selected bookmarks by their current collection, Unsorted (`-1`) included.
2. Bulk restore: `PUT /raindrops/-99` with body `{ "ids": [...], "collection": { "$id": originalCollectionId } }`, one call per original collection and batch.
3. Never send a bulk call without a non-empty `ids` array or with `search`. Refuse it in the client, as the probe's `bulkCall()` does.
4. Batch size: at most 100 IDs per call.
5. Reply handling: a bulk reply is `{ "result": true, "matched": N, "modified": N }` with no per-ID detail. If `modified` equals the batch size, count the whole batch as done. Otherwise treat the batch as uncertain. Reconcile each ID with `GET /raindrop/{id}` or a fresh sync before a retry or an undo entry. A 200 with `modified: 0` is not a success.
6. Redirect strategy: fetch follows redirects natively, `redirect: "manual"` does not work, and `redirected` is always false. Detect a redirect by comparing the normalized `response.url` with the request URL. If the final host is excluded, classify the result `skipped` with the reason "redirected to an excluded host". Apply the home-page redirect rule to the final URL. An empty final URL is `unsure`.
7. DNS classification: a thrown fetch error never counts as a nonexistent host. Classify every thrown network error as `unsure`, after the GET fallback the plan already requires. `dead` comes only from HTTP 404 or 410. TLS errors, connection refusals and ATS refusals of `http://` links also land in `unsure`.
8. Timeout: wrap each request in `Promise.race` with a 10 second `setTimeout`. On the timer, record `unsure` with reason "timeout" and ignore the late result. Do not rely on `AbortController` or `AbortSignal.timeout`. Neither ends the wait. Keep the host's slot in the per-host limiter until the native call settles, so a slow host never gets a second request at once. URLSession's 60 second idle timeout bounds most stalled calls. Release the global slot at the timer.
9. GET fallback: send `Range: bytes=0-0` on the GET so a large file does not download whole through the bridge. Count 200 and 206 as ok. Count 416 as `unsure`.
10. Headers: send the User-Agent above and `Accept: text/html` on both HEAD and GET.
11. Runtime lifetime: closing the view, and hiding it under the default setting, destroys the runtime and cancels in-flight fetches natively. Phase 3 still cancels its own work in the effect cleanup, because unmount runs before shutdown. Save each result as it arrives, because nothing runs after close. A pending retry resumes from SQLite on the next launch.

## Owner decision needed (STOP item)

The checker cannot enforce the host exclusions on redirect hops. A public bookmark that redirects to `localhost`, a private address or a `.local` host makes URLSession send HEAD or GET to that host before JS can see it. Intermediate hops are invisible. Exclusions are also enforced on literal hosts only. A public name that resolves to a private address is not detectable, because the runtime exposes no public DNS lookup (`ExtensionNameResolver` is reachable only through the private `__tinycastHost` seam, and it returns an empty list for every failure).

What the fallback does enforce: no request goes to a bookmark whose own URL is excluded, and a final URL on an excluded host is classified `skipped`. The session sends no cookies and no stored credentials (`ExtensionFetcher.swift:14-15`), and the checker sends only HEAD and a one-byte-range GET.

Stop the redirect-hop part of the exclusion work until the owner chooses one:

- Accept the residual risk with the fallback above. This is the option I prefer for a single-user tool.
- Ask for a Tinycast change: a `URLSessionTaskDelegate` that honors `redirect: "manual"` and returns `redirected`. That change is outside this repository.

The timeout is enforceable with `Promise.race`, so the timeout work does not stop.

## Plan changes

- The plan's `DELETE /raindrops/0` becomes `DELETE /raindrops/{sourceCollectionId}`, grouped by source collection.
- `PUT /raindrops/-99` with `ids` and `collection.$id` is confirmed for restore.
- A nonexistent host is never `dead`, because Tinycast cannot tell DNS failure apart from other errors.
