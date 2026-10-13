# Live Activity verification

This protocol closes layout gates; previews and unsigned build success alone do not prove system clipping is fixed. The user builds and installs iOS applications; agents do not sign, install (including in a simulator), distribute, or deploy them. Fresh system captures require a user-installed build.

Open gates are tracked with the rest of the project's current work, not in this file. Package tests and unsigned builds do not replace the native matrix below.

## Source checks

From `apps/ios`, run:

```sh
swift test
xcodebuild -project Relo.xcodeproj -scheme Relo -configuration Debug -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO ONLY_ACTIVE_ARCH=NO build
xcodebuild -project Relo.xcodeproj -scheme ReloNativeReference -configuration Debug -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO ONLY_ACTIVE_ARCH=NO build
```

Use `ReloLiveActivityPreviews.swift` to inspect content, expanded, compact, and minimal states. The previews use the same synthetic wire-tested fixtures as the reference host. Preview source and native alert behavior are separate evidence categories.

## Native fixture launch

### Card-allocation regression repair

`LiveActivityFittingLayout` replaces the card's flexible maximum-height frame. It proposes the same finite surface budget to `ViewThatFits` during measurement and placement, then reports the selected child's measured height instead of reserving the entire budget. It does not apply root `fixedSize` or remove overflow limits. The rich progress variant no longer repeats its measured fact in the footer; condensed variants retain the fact.

Five SwiftUI `ImageRenderer` regression tests (eight parameterized cases) cover the 96/132 pt budgets, retention of fitting primary content, smaller and unbounded host proposals, and 80/120-character decision context at 240/300/380 pt widths. The old allocation behavior failed; the new allocator passed. These execute against macOS SwiftUI, **not** the iOS WidgetKit/ActivityKit host. They establish allocator regression coverage, not the full native matrix.

Run the isolated layout suite:

```sh
swift test --filter LiveActivityFittingLayoutTests
```

Generate a labelled layout-harness comparison using the exact production allocator, without installing an iOS app:

```sh
xcrun swiftc -parse-as-library Sources/LiveActivities/LiveActivityFittingLayout.swift Scripts/render-live-activity-layout-regression.swift -o /tmp/relo-layout-regression-renderer
/tmp/relo-layout-regression-renderer /absolute/private/output/layout-regression-comparison.png
```

The comparison independently checks the old padded allocation is 124 pt and the corrected padded allocation is 72 pt for the same 44 pt fallback. It must be labelled “native SwiftUI layout harness, not an iOS/ActivityKit screenshot.” Historical simulator screenshots must not be relabelled as a later build.

### Installed reference host

After the user has installed the dedicated reference host, launch it with Xcode scheme arguments:

- `--reference-case decision-with-progress`: the original approval hierarchy, with project/thread context and a progress component that must not crowd the decision.
- Add `--reference-alert` to request an alert update after five seconds; return to the Home Screen before the update. The host briefly requests background execution. Record whether iOS actually presents an alert; requesting an alert is not evidence it appeared.
- Repeat on a Dynamic Island device and a device without Dynamic Island. Capture alert-triggered expansion separately from long-press expansion.
- Use `expiry-transition` to check a pending decision fifteen seconds after creation. Record whether ActivityKit invalidation visibly removes the actions at the deadline; an intent/server refusal alone does not pass the UI gate.
- Use `stale-progress` to check “Update overdue” independently of the interaction deadline and lifecycle.

Existing cases: `information`, `progress-bar`, `steps`, `image-cache-miss`, `approval`, `yes-no`, `appearance-light`, `appearance-dark`, `appearance-system`, `long-text`, `mixed-identity`, `response-sending`, `response-queued`, `response-accepted`, `response-rejected`, `response-expired`.

Additional wire-tested cases: `max-text`, `many-components`, `all-pending`, `all-complete`, `zero-progress`, `full-progress`, `decision-with-progress`, `response-denied`, `response-canceled`, `stale-progress`, `expiry-transition`.

Synthetic references never submit production approvals. Real App Intent verification requires a separate authenticated test request on the user's installed production build.

## Evidence to record

For every capture, record source commit/hash, unsigned/signed build provenance, model, iOS version, locale, text size, appearance, scale, fixture, lifecycle/response state, and trigger. Mark each item as passed, failed, or not observed. Never infer a passed presentation from a different trigger or device. Keep private payloads and credentials out of artifacts.

Required surfaces: Lock Screen, non-Island alert banner, alert-triggered expanded Island, long-press expanded Island, compact, minimal with competing activity, and StandBy. Required breadth: small/large Island hosts; maximum text and components; 0/100% and all-pending stages; approved/denied/queued/rejected/expired states; light/dark, large text, VoiceOver, Reduced Motion, reduced luminance/AOD, and privacy.

## Pass conditions

- No clipped glyphs, button silhouettes, or progress marks. The complete Island includes camera-adjacent regions, not only its bottom view.
- A question always shows its answer buttons on the Lock Screen and in the expanded Island; the title and question text shorten to make room. The card never shows a button that opens Relo: tapping the card opens the full question.
- Response controls have nonoverlapping 44 × 44 pt usable targets fully inside the rounded host. Verify geometry/hit bounds as well as screenshots.
- State facts agree across presentations. A denied response is not an approval; a queued response is not accepted; 100% is not invented terminal success.
- Missing/corrupt images have the same slot size as successful images; response transitions do not move the row.
- VoiceOver reads task identity/context and actions without repeated status, including private content and unavailable deadlines.
- Contrast, large text, Reduced Motion, and AOD pass on the actual hosts. No status relies only on color or animation.
- Tapping the card opens the exact activity. Deadline checks remain authoritative in App Intents/server handling.

Existing OCR and pixel-comparison scripts help validate provenance and detect regressions, but do not certify corner geometry, targets, or VoiceOver. Do not label absent captures “passed.”
