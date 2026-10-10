# Camera Study Assistant Implementation Plan

**Goal:** Run an independent Android web capture / silent-analysis / voice-question MVP.
**Architecture:** Browser captures; Node controls queues and API adapters; explicit disk memory connects observations to questions.
**Tech Stack:** Node 22, ws, sharp, tesseract.js, AudioWorklet, Codex/Claude CLI.
**Spec:** design.md

## Constraints and review focus
Keep existing project untouched. Secrets stay server-side. No analysis text is auto-spoken. Batch closure follows final upload. Duplicate STT items and frames must be idempotent. Interrupted/failed work must never be reported as fully successful.

## Tasks
1. Core engine and command router (`src/core.js`, `test/core.test.js`): test then implement serial silent processing, strict commands, immutable question scope, cancellation, per-batch completion events.
2. Provider adapters (`src/providers.js`, `src/speech.js`, `test/speech.test.js`): implement OCR/visual dedup, read-only image CLI calls, transcript session payload and client VAD segmentation; test with controlled provider boundaries.
3. HTTP and WS host (`src/server.js`, `test/server.test.js`): authenticated frame upload, state events, paired controller, STT bridge, private TTS, explicit status when key missing.
4. Mobile interface (`public/*`): responsive camera view, capture controls/timers, upload completion barrier, transcript and tasks, TTS queue and completion chimes, microphone streaming.
5. Windows screen source (`src/remote-source.js`, `scripts/screen-agent.ps1`): one-time rectangle selection, authenticated command polling, upload ordering, disconnect detection.
6. Operational docs and verification (`README.md`): independent startup, Windows LAN agent, USB/LAN HTTPS paths; run full tests and local HTTP/browser smoke checks.

## Execution ledger
- 2026-09-24: Requirements accepted in conversation; proceeding under explicit user authorization to build. No new approval gate for routine reversible scaffolding.
- No git repository exists in parent; standalone folder is isolation boundary. No parent files are edited.
- No OPENAI_API_KEY in environment; external STT/TTS validation will remain explicitly unverified until configured.
- Implemented both camera and remote Windows screen sources, with screen selected by default for the requested first test.
- Review fixes: imported-image upload barrier, stale STT callback rejection, and upstream TTS cancellation; regression tests cover all three.
- 20 automated tests passed, including the remote registration/command/upload/question flow with synthetic images and mocked model boundaries. PowerShell parser check passed. Browser connection and layout verified in demo mode.
- Remote Windows capture, actual microphone/STT/TTS, and Codex/Claude image inference still require real-device/account validation. OCR language downloads may delay first use; OCR_ENABLED=false is available for initial connectivity testing.
