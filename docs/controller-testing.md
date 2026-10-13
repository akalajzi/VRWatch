# Controller validation

Automated replay checks ray intersections, seek/volume targets, recentering,
thumbstick routing, menu state and XR cleanup. Use `npm test` for the regression
suite. These fixtures use synthetic media and page state.

For physical acceptance, use a disposable profile and record the exact app and
runtime identities in an ignored private report. Check both controllers, trigger
selection, grips and the right-controller B button, thumbstick scrolling, paused
panel visibility, seek/volume, format changes, recentering, XR exit and return to
the browser panel. Check readable controls and comfortable placement while
wearing the headset. Repeat after focus, fullscreen and tab changes.

Prior replay and device checks covered hit geometry and basic lifecycle/input;
they do not establish sustained comfort or universal third-party WebXR controls.
Publish only a sanitized result with check scope and limitations. See
[verification scope](verification.md).
