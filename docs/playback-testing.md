# Playback validation

Use synthetic or redistributable samples. Keep URLs, media filenames, device
addresses, cookies, full logs and raw captures in ignored `private/` or
`docs/validation/`. Never commit a personal browser profile.

Run `npm test` for media bounds, readable-frame checks, projections, controller
replay and lifecycle regressions. For device comparisons use a separate profile
and state directory, a preserved baseline, and the same sample and measurement
conditions. The opt-in CDP relay is test instrumentation; keep it on loopback.

`scripts/frame-decode-probe.py --help` documents explicit SSH target, sample URL,
relay and output arguments. Measure the actual decoder/platform status and owned
process CPU, not only advertised graphics capability. Check texture readback,
seek/source changes, looping, end-of-stream, real XR entry/exit and browser return.
Separate headless, visible-session and watched-headset results.

Prior source-runtime H.264 Baseline/High tests identified native V4L2 decoding
and a CPU reduction against the same binary's software path. Conversion still
used CPU image processing. Short software VP9/AV1 checks passed. A HEVC sample
did not decode through the selected stateful path. These results establish
neither sustained high-resolution support nor network/thermal endurance.

Application callbacks and dropped-video-frame counts are not compositor
presentation, headset refresh or reprojection measurements. Record human comfort
separately. See [source runtime](source-runtime.md) and [verification](verification.md).
