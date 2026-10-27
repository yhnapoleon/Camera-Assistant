# Guided solutions implementation plan

> **For agentic workers:** Use superpowers:executing-plans task by task. Track checks below.

**Goal:** Implement the approved five-stage programming lesson and dual runnable code modes.
**Architecture:** One validated lesson JSON per analysis, persisted in existing jobs. A focused browser renderer consumes that contract; existing mouse navigation integrates it without changing capture providers.
**Tech Stack:** Node.js, native JS/CSS/SVG, local syntax highlighter.
**Spec:** ../specs/2026-10-27-guided-solutions-design.md (approved by user).

## Global constraints
- Default LeetCode core plus local runner/data; ACM stdin/stdout switch, same language/algorithm.
- No generated-code execution on server. No extra image service. Old records remain readable.
- Stable step IDs tie analysis, graph and source blocks together; generated data is untrusted text.

## Review focus
- Truncated/malformed JSON must fail explicitly, with retry (task 1).
- Invalid step/range/edge references must fail validation (task 1).
- Reconnection must not lose detail or enlarge listing payloads (task 2).
- Mouse text selection and touch controls must not trigger capture (task 3).
- Multiple/mixed questions and narrow/rotated viewports remain readable (tasks 3–4).

## Task 1: Lesson contract and generation
Files: src/lesson.js, src/mouse-core.js, src/mouse-server.js, test/lesson.test.js, test/fixtures/lesson.js.
Interfaces: parseLesson(text) -> parsed job fields or null for legacy prose; validateLesson(payload) -> normalized lesson; lessonPrompt appended as authoritative coding-output rules; demoLesson() returns representative complete payload.
- [ ] Write tests through splitAnswer for valid mixed lesson, missing variants, broken ranges/IDs, malformed JSON, legacy compatibility.
- [ ] Run node --test test/lesson.test.js and observe expected failures.
- [ ] Implement version 1 schema, prompt, demo and parse integration.
- [ ] Run lesson and mouse-core tests; commit task.

## Task 2: Storage, API and retry
Files: src/mouse-core.js, src/mouse-server.js, test/lesson-server.test.js.
Interfaces: JobStore.retry(id) retries failed analysis with original images/prompt; POST /api/retry?id=…; detail includes lesson, summary excludes lesson and adds hasLesson.
- [ ] Test real HTTP authenticated retry, invalid state, stored/reloaded lesson, compact listing.
- [ ] Observe failing tests, implement endpoints/storage semantics.
- [ ] Run targeted tests; commit task.

## Task 3: Reading experience
Files: public/mouse/lesson-view.js, lesson.css, index.html, mouse.js, mouse.css; test/lesson-view.test.js, mouse-input.test.js.
Interfaces: window.LessonView.render(lesson, {stage, problemIndex, mode}, callbacks) -> DOM; stages insight/analysis/implementation/diagram/code integrated with mouse levels. Renderer uses safe text nodes, local highlighting, controlled SVG.
- [ ] Write behavioral DOM tests for stage rendering, mode switching, complete source copy payload, step/graph links, mixed problem selection; extend actual mouse-handler tests for non-capture controls.
- [ ] Observe failures, implement renderer, styles, navigation and copy fallback for HTTP.
- [ ] Test old records and unloaded details; commit task.

## Task 4: Validation and launch
Files: README.md, demo fixture/server and tests as needed.
- [ ] Run npm test; inspect and resolve failures.
- [ ] Inspect representative lesson in browser: all stages, both modes, return navigation, sample input/output and graph.
- [ ] Fresh reviewer audits changed files vs approved design; resolve material issues with regression tests.
- [ ] Document exact limitations, check active production jobs before restart, restart service and verify live HTTP/WS.

## Execution ledger
Ruling: implement in the explicitly named project on its clean feature branch so the user's local service uses the result; no worktree or branch migration.
Ruling: user's instruction to start the approved design authorizes execution; no additional plan approval gate.
Pre-flight: tasks 1–3 share a versioned lesson contract; names and fields defined in src/lesson.js before renderer work. Task 2 summary hasLesson indicates that the detail fetch is needed.
