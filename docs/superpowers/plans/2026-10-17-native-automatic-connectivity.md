# Native automatic connectivity implementation plan

> **For agentic workers:** Use Superpowers systematic-debugging and verification-before-completion. Independent networking and UI work may use dispatching-parallel-agents; integrate and review the whole change before packaging.

**Goal:** Receive native streams automatically, preferring P2P and using the main branch's connectivity fallbacks.

**Architecture:** Keep the C++ capture/encoder and native WebRTC. Add pinned direct WSS beside the existing encrypted relay and reuse main's endpoint ordering and router leases. The local viewer bridge selects signaling automatically and produces sanitized diagnostics.

**Tech Stack:** Existing Electron, Node.js, ws, selfsigned, native C++/GStreamer, HTML/CSS.

**Spec:** `docs/superpowers/specs/2026-10-17-native-automatic-connectivity-design.md`

## Global constraints

- Windows x64; capture remains C++; GStreamer 1.28.8.
- No new dependency for existing network/UI capabilities.
- Default ICE policy `all`; no manual TURN required for the normal flow.
- Never log tokens, invitations, secrets, SDP, full candidates or IPs.
- No external service deployment or invented TURN credentials.

## Review focus

- Wrong certificate must prevent sending the invitation token.
- Receiver closing during discovery must not leave a relay/native peer alive.
- Router leases must correspond to actual ICE ports and be removed on shutdown.
- Busy/absent/stale host must produce an entry error, not TURN advice.
- A public signaling relay must never be labelled as relayed media.

## Task 1: Native media port range and main connectivity reuse

Files: `native/mvp/main.cpp`, `src/native-mvp/network.js`, shared
`src/main/connectivity.js` / `src/main/portmapper.js` only if private mapping
metadata is needed, `test/native-network.test.js` and relevant shared tests.

Interfaces: `createNativeNetwork({servers,udpPorts,env,onUpdate})` with the methods
in the spec. C++ connect accepts optional `udpMin` / `udpMax` and validates them
before setting `min-rtp-port` / `max-rtp-port` on the WebRTC ICE agent.

- [x] Write and run failing tests for default automatic mapping, off mode,
  candidate generation only for real mapped sockets, CGNAT, cancellation.
- [x] Reuse shared connectivity and mapping lifetimes; add only process-private
  mapping metadata required for the advertised ICE candidate.
- [x] Add C++ range configuration, build and verify existing native smoke.
- [x] Run native-network, connectivity and portmapper tests; report evidence.

## Task 2: Direct signaling and automatic fallback

Files: `src/native-mvp/direct.js`, `src/native-mvp/internet.js`,
`src/native-mvp/server.js`, `test/native-internet.test.js`, new direct tests.

Interfaces: direct TLS server exposes `wsPort`, `bindings`, `fingerprint`, `close`;
viewer transport uses the same `{type:'join',token}` protocol as LAN/relay.
Invitation parser preserves old relay-only invitations and accepts validated
direct endpoint lists. The receiver keeps a loopback-only browser bridge.

- [x] Add red tests for direct pin mismatch before authentication, handshake
  timeout, direct success, dead-direct to relay fallback, absent host and cancel.
- [x] Build direct dual-stack WSS with pinned certificates and bounded cleanup.
- [x] Implement one automatic selection flow with endpoint priorities from main.
- [x] Distinguish relay registration failure from host absence and authentication.
- [x] Keep media/session lifetimes and one-viewer enforcement across attempts.
- [x] Run direct, internet and existing native server tests to green.

## Task 3: Product interface with automatic connection status

Files: `src/native-mvp/ui/host.html`, `host.js`, `style.css`, `viewer.html`,
`viewer.js`; UI smoke fixture/scripts if necessary.

Interfaces: preserve existing IDs/bridge calls and support `connection-stage`
and `port-mapping` from the spec. `nativeMvp.join(invitation, logging)` accepts an
optional boolean defaulting true. TURN remains in advanced settings.

- [x] Audit existing hierarchy, focus, field errors and technical clutter using
  UI UX Pro Max and Taste's redesign guidance for existing apps.
- [x] Improve the transmitter/receiver layout, automatic connection description,
  route progress and actionable errors. Preserve capture/GPU/log controls.
- [x] Keep fullscreen/video aspect ratio and avoid recurring GPU-heavy effects.
- [x] Verify idle, transmitting, connecting and failed states at practical widths;
  keyboard focus, reduced motion, contrast and no overflow.

## Task 4: Integration, receiver audit and delivery

Files: `src/native-mvp/main.js`, `preload.js`, `audit.js`, build configuration,
native smoke scripts, `docs/native-mvp.md` and skill installation provenance.

- [x] Wire UDP range to native helper and browser before negotiation.
- [x] Persist sanitized receiver-stage logs when requested, including failures
  before media exists, with filenames that cannot collide with host audit files.
- [x] Include every shared dependency and TLS runtime asset in the portable.
- [x] Run syntax/unit checks, real direct and public relay fallback video smokes,
  receiver diagnostics and shutdown tests. Review diff independently.
- [x] Generate a separate portable, inspect packaged sources, launch it and
  verify the UI/IPC. Delivery remains on the experiment branch; no merge to main.
- [x] Report actual evidence and remaining two-network/TURN validation limits.

## Verification evidence (2026-10-18)

- `npm test`: 200 tests, 198 pass, zero fail, two opt-in skips (native range and authenticated TURN). The real native range test was also run explicitly and passed after rebuilding C++.
- `npm run check`: syntax validated; `git diff --check` clean.
- Real LAN video: WGC/D3D11/hardware H.264 decode, client crop, minimize/restore, resize, reconnect, priority and native helper shutdown passed.
- Real pinned direct WSS video passed without a relay. Public WSS fallback passed after an injected wrong direct certificate; media remained direct P2P. Both apps ran on this PC.
- UI fixture and production receiver audit smoke passed; logging opt-out creates no receiver audit. LAN receiver-state and media/signaling attribution regressions were reproduced failing, then verified passing.
- UI inspected at desktop and narrow widths with no overflow; DOM focus and focus styling checked. Native Windows keyboard traversal was not separately tested.
- Independent review found no remaining must-fix after the two regression fixes.
- Actual two-PC/two-ISP NAT combinations and authenticated TURN media were not tested; no credentials service was deployed. These are delivery limits, not passed acceptance tests.
- Packaged ASAR: all 24 native/shared source files match the working tree; native EXE bytes match the built binary; GIO TLS, CA bundle and plugin scanner are present. Public relay fallback and decoded direct P2P video also passed with the packaged native helper/runtime.
- Portable EXE built successfully: `dist/native-mvp-automatic/Self-Live-Native-MVP-0.1.0-x64-automatic.exe` (102,556,972 bytes). Actual EXE startup verified the updated receiver UI, preload/network IPC, native GPU enumeration and clean shutdown (exit 0).
