# VRWatch upstream tracking

Review upstream changes weekly and before a Chromium rebuild or a Frame OS,
SteamVR, or graphics-driver update. Check whether platform fixes can replace
local workarounds while developing VRWatch. Announced, merged, shipped,
device-tested and adopted are separate milestones.

Maintainers review triage and adoption evidence.
Track actionable changes in [the adoption records](upstream-adoptions.md).

## Sources and their purpose

| Layer | Sources | Review for |
| --- | --- | --- |
| Chromium | [Linux OpenXR reviews](https://chromium-review.googlesource.com/q/project:chromium/src+OpenXR+Linux), [Linux WebXR issues](https://github.com/utzcoz/chromium-webxr-linux/issues), [Linux WebXR tracker](https://issues.chromium.org/issues/506004811) | Sandbox, GPU synchronization, Linux layers, regressions and patch rebases. |
| Valve | [Frame announcements](https://steamcommunity.com/app/4165890/allnews/), [SteamVR announcements](https://steamcommunity.com/app/250820/allnews/), [SteamVR Linux issues](https://github.com/ValveSoftware/SteamVR-for-Linux/issues) | OS/client updates, OpenXR, Flatpak/PIDs, controllers, dashboard focus and compositor. |
| Integration | [Chrome XR](https://github.com/phit/chromium-webxr-steam-frame) main and google branches | Launch flags, packaging and Steam integration; README status can lag Gerrit. |
| Player/standards | [video2webxr](https://github.com/phit/video2webxr), [WebXR Layers](https://github.com/immersive-web/layers), [three.js WebXR manager](https://github.com/mrdoob/three.js/blob/dev/src/renderers/webxr/WebXRManager.js) | Projections, feature negotiation, layers, rendering and session cleanup. |
| Drivers/decoding | [Mesa releases](https://docs.mesa3d.org/relnotes.html), [Linux media development](https://lore.kernel.org/linux-media/), [our decoding record](source-runtime.md) | Turnip/Zink import, Iris firmware/recovery, V4L2 and usable codecs. Match upstream changes to Valve's shipped kernel/Mesa/firmware. |

## Check for changes

Use a fresh state directory for a public repository. Existing private state,
reviewer notes and dated before/after reports are excluded from the export.
Set `REVIEW_DATE` to an ISO calendar date for the example below.


The standard-library checker reads public GitHub, Chromium Gerrit and official
Steam announcement APIs using [the source list](upstream-watch-sources.json):

```sh
python3 scripts/check-upstream.py
```

Local state defaults to ignored `artifacts/upstream-watch/`. The checker queues
each change with its before/after content **before** advancing its observation
baseline. Pending entries stay visible on unchanged runs. First-time and legacy
baselines each create a source-review entry. Reviews preserve a dated history;
deferred/watched entries require a next-review date, and candidates require an
adoption-record reference. No queue decision deploys anything.

Failed sources return nonzero and retain their baseline; successful sources
advance independently. `last-run.json` records source health. Network errors
and transient HTTP failures receive bounded retries, while bad data fails the
source. A process lock rejects overlapping runs. `--no-save` compares without
advancing baselines or changing the queue.

The prepared [GitHub Actions workflow](../.github/workflows/upstream-watch.yml)
requires `VRWATCH_UPSTREAM_WATCH=enabled` and runs Mondays at 07:23 UTC on a standard Ubuntu runner, with a five-minute cap.
It can also be dispatched manually for a check or a queue review. It persists
observations, pending reviews and reports in the dedicated `upstream-watch-state`
branch, including after partial source failure. Failed persistence fails the job.
This state is not stored only in an expiring cache. State-branch pushes are
excluded from ordinary build CI. Workflow runs create summaries without posting
messages or automatically adopting changes.

The schedule becomes active only when explicitly enabled and the workflow is on
GitHub's default branch; a local workflow file does not enable it. GitHub may delay or drop
scheduled runs, so check freshness before source selection and platform changes:

```sh
python3 scripts/check-upstream.py --health
```

Health fails if a source is missing, its configuration changed, the last fetch
failed, or any observation is older than nine days. For GitHub state, restore
the state branch into a separate worktree and pass `--state-dir` to that command.
A missed schedule is detected when health is checked; this is not an independent
out-of-band alert. Review the Actions run and rerun failed/missed checks.

To review locally against that state worktree:

```sh
python3 scripts/check-upstream.py --state-dir /path/to/state-worktree \
  --review FULL_EVENT_ID --decision defer --reviewer YOUR_GITHUB_HANDLE \
  --note 'Waiting for the OS fix to ship' --revisit-on "$REVIEW_DATE"
```

Commit/push local state reviews to the state branch before the next hosted run;
do not leave decisions only in the workstation's default ignored state folder.
The manual Actions form provides the same review operation. Decisions are
`ignore`, `watch`, `defer` or `candidate`; only ignored entries leave the visible
queue. Use `--evidence docs/upstream-adoptions.md#frame-seccomp` for candidates.

API windows are bounded: 30 commits/news entries, 50 Gerrit results and 100
issues. Comment threads follow pagination, failing rather than truncating at
20 pages. A listing with no overlap against the previous observation fails
without advancing its baseline. This detects recent activity, not complete
history; frequent activity or long gaps can still require manual pagination.
Mesa/kernel and Chromium's
issue tracker are manual sources. Keyword queries may miss relevant changes;
also inspect affected source paths and dependencies when rebasing.

## Review and adoption

For actionable changes, record source/date, affected layer, upstream state,
shipping version/build if known, our workaround, next test and device result.
Keep planned, merged, shipped, device-tested and adopted distinct. Update private records and a sanitized adoption summary after review; a fetch timestamp alone
must not change a decision.

Review seccomp, XR synchronization/layers, decoding and distribution against current sources. Preserve the working runtime and
profile for each candidate. See [runtime acceptance](source-runtime.md#device-acceptance-and-rollback)
and [verification scope](verification.md) for required checks.

The operating sequence is: successful fresh check → reasoned review → pinned
candidate → exact-artifact tests → recorded adoption decision → versioned
installation with rollback. Avoid combining an OS fix, browser rebase and
player redesign in one comparison when isolating a regression. Batch compatible,
reviewed runtime work into one candidate only after its acceptance scope is clear.
