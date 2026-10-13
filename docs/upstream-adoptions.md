# Upstream adoption records

The watcher queues changes; a queue decision does not deploy a runtime. Keep
dated investigations, device/site-specific results and reviewer notes in ignored
`private/` or `artifacts/upstream-watch/`. Share a sanitized adoption summary only
after review. Never publish the private repository's state branch with a source
export.

## Frame seccomp

The launcher retains its documented compatibility workaround. Test restoring the
filter against the actual OS/SteamVR build in an isolated candidate, keeping the
same browser artifact. Repeated XR entry/exit, controls, browser return and worn
playback must pass before defaults change. No new adoption is established here.

## Runtime changes

Review Linux OpenXR synchronization/layers, decoder/driver changes and browser
distribution options against the pinned tree. Public upstream announcements or
merged changes do not establish availability or performance on Frame. Preserve
the working projection-layer fallback and prior runtime until exact-artifact
acceptance passes.

## Required record

Record source evidence, affected layer, baseline/candidate hashes, dependencies,
input changes, expected benefit, acceptance criteria, observed results, remaining
limits, profile migration and rollback pair. Keep observation, shipping state,
device acceptance and adoption separate. Runtime/app receipts connect tests to
frozen inputs. Preserve private dates and reviewer identity outside public docs.

See [upstream tracking](upstream-watch.md), [device acceptance](source-runtime.md#device-acceptance-and-rollback)
and [verification](verification.md).
