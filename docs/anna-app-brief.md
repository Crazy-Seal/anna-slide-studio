# Anna developer platform — staging docs brief

Sources: the 9 requested pages (all HTTP 200). Supplemented where a point was absent, from `app-ui-bundle.md`, `app-ui-manifest.md`, `app-manifest.md`, `app-ui-overview.md`, `app-ui-llm.md`, `app-ui-windows.md`, `verified-developer.md`, `host-api-llm.md`, `host-api-web.md`, `host-api-embed.md`. `/developers/reference/quota.md`, `credits.md`, `cu.md` → **404**.

## A. CLI (`anna-app`, package `@anna-ai/cli`)

Global: exit `0` ok / `1` runtime (invoke error, missing PAT scope) / `2` launch-config (bad flags, no saved PAT). Most commands accept `--json` and `--account <host>`. Identity is cached in `.anna/app.json` (apps) / `.anna/executa.json` (executas); apps publish as `@handle/slug`.

**Auth / account**
- `anna-app login` — device-code flow; **`--host <url>` is required**; `--no-browser`. Saves a long-lived JWT PAT (audience `aps-dev-pat`, type `anna_app_dev_pat`, 90-day TTL, `aps:dev`).
- `anna-app logout` — `--host <url>` for one, `--all` for all.
- `anna-app whoami` — `--json`.
- `anna-app account set-handle <handle>` — `--host`, `--json`; **required before creating your first app**.

**Login to staging** — the docs give only the generic form, never a staging hostname: `anna-app login --host https://staging.anna.partners` (substitute the real host; all examples use `https://nexus.example.com`). `ANNA_APP_HOST` exists as an env fallback for `executa upload-binaries --host` only.

**Scaffold / dev / validate**
- `anna-app init <dir>` — `--slug` (default: dir basename), `--template minimal` (default; working UI+manifest), `--force`.
- `anna-app validate` — schema + UI static checks on `manifest.json`, `--bundle <dir>`, `--strict` (greps bundle for unimplemented `anna.<ns>.<method>`). Same validators as the server upload path.
- `anna-app dev` — in-process dispatcher + iframe + SSE relay; auto-discovers `executas/`. CLI-ref flags: `--port` (5180), `--user-id` (1), `--bundle`, `--view`, `--matrix-nexus-root`/`$ANNA_NEXUS_ROOT`, `--no-watch`, `--no-llm`, `--mock-llm <fixture>`, `--llm-account <host>`, `--llm-app-slug`, `--storage legacy|aps` (default `legacy`), repeatable `--executa 'dir=...,type=...'`. `local-dev.md` adds `--manifest <path>`, `--slug <slug>`. `local-dev-llm.md` uses `--llm real | --llm mock | --llm off` — **note: `--llm` appears in no flag table**; only `--no-llm` / `--mock-llm` are documented as flags.
- `anna-app fixture verify|summarize|replay <file>` — `--json`, `--manifest <path>`.

**Real LLM in local dev.** Prereq is the PAT from login; there is no documented env var for setting a PAT manually. Then:
```
anna-app login --host https://staging.anna.partners
cd my-app
anna-app dev --llm real
```
`--llm real` mints `app_session_token`s via `POST /api/v1/anna-apps/dev/session/mint` and bills your real quota. Free/offline alternatives: `anna-app dev --llm mock --mock-llm fixtures/replies.jsonl`, or `anna-app dev --no-llm` (returns `{"ok":false,"error":{"code":"llm_disabled",...}}`). `--storage aps` also needs login and cannot combine with `--no-llm`/`--mock-llm`.

**Publish / versioning**
- `anna-app apps push` — upserts the single mutable **working draft** (no SemVer, executa deps unfrozen, idempotent on content hash). `--bump patch|minor|major`, `--no-write`, `--dry-run`, `--bundle-dir`, `--no-bundle`, `--executa-id <handle=id>`, `--skip-executa-publish`, `--no-bundled-executas`, `--no-install-local`, `--if-match <revision>`, `--profile <name>`, `--account`, `--json`.
- `anna-app apps cut <version>` — immutable snapshot; `--changelog <text>`, `--slug`, `--cwd`, `--dry-run`.
- `anna-app apps release <version>` — go live; `--allow-create` runs `apps publish` first.
- `anna-app apps publish` — one-shot mint of an immutable version (recursive bundled-executa publish).
- `anna-app apps discard`, `apps submit-review [slug]`, `apps list`, `apps status <slug>`, `apps versions <slug>`, `apps sync-meta`, `apps rename-slug <new-slug>`, `apps unpublish <slug>` (`--yes` + `--confirm <slug>`), `apps archive`, `apps unarchive`, `apps delete`.
- `anna-app publish` — auto-detects cwd (`manifest.json` → app, `executa.json` → executa); `--bump`, `--dry-run`, `--publish`, `--no-bundle`, `--bundle-dir`.

**Executa**: `executa init <dir>` (`--template python|node|go`, `--tool-id`), `executa register`, `executa install`, `executa dev` (`--describe`/`--health`/`--invoke <tool> --args <json>`, plus `--spec`, `--mock-sampling|--mock-agent|--mock-storage|--mock-image|--mock-upload`, `--storage off|memory|mock|real`, `--no-*`), `executa publish` (`--bump`, `--publish`, `--profile`), `executa upload-binaries` (`--oidc`, `--dry-run`), `executa trusted-publisher add|list|remove`, `executa list|status|versions|unpublish|yank|delete|cache-clear`.

**Tokens / diagnostics**: `anna-app token list` (`--include-revoked`), `token revoke <id>`, `token scopes`, `anna-app doctor` (`--matrix-nexus-root`; non-zero exit if `uv`/Nexus checkout/dev key missing).

**Absent from the docs**: no `anna-app test`, no `anna-app bundle upload`, no `anna-app auth` / `anna-app account login`. "Bundle upload" is implicit in `apps push` / `apps publish` (`--bundle-dir`, `--no-bundle`); the raw HTTP pipeline is `bundle/init` → per-file PUT → `bundle/finalize`.

## B. Code-ready → PUBLISHED

0. Verified Developer: self-service at `/developer` → `POST /api/v1/developer/profile/activate` (browser session only; PAT rejected). Without `is_verified_developer`, developer endpoints return `403 Verified developer status required.`
1. Create the app record / listing — Console **Listing** tab, i.e. `POST /api/v1/developer/apps` (`slug` is sent here and is immutable: `PATCH` silently ignores it). No `apps create` CLI subcommand is documented.
2. `anna-app init` → edit `manifest.json` (`"schema": 4`).
3. `anna-app validate` → `valid: true`.
4. `anna-app apps push --bump patch` — creates/updates the working draft and uploads the bundle.
5. UI bundle (schema ≥ 2): `POST .../versions/{version_id}/bundle/init` with `file_map` (`byte_size`, `sha256`, `content_type`) → PUT each file to `presigned_put_url` (10-min TTL) or `proxy_upload_url` → `POST .../bundle/finalize` → `status: bundle_ready` (immutable). Quotas: 50 MB total, 2 000 files, 10 MB/file.
6. `anna-app apps cut 1.0.0 --changelog "…"` — immutable version, frozen executa bindings.
7. `anna-app apps submit-review` (= `POST /developer/apps/{id}/submit-review`) — pins the newest cut as `review_candidate_version`, runs a release precheck (manifest validation, executa freeze dry-run, bundle readiness). → `PENDING_REVIEW`. Requires ≥1 cut version; state must be `DRAFT`/`REJECTED`/`PENDING_REVIEW`.
8. Admin: `POST /api/v1/super-admin/apps/{id}/approve` body `{ "publish": bool, "notes": string? }` (or `.../reject`).
9. `anna-app apps release <version>` (= `POST /developer/apps/{id}/versions/{vid}/publish`) — allowed only when status ∈ {`APPROVED`,`PUBLISHED`}; clears other `is_latest`, sets `published_at`, rebuilds `anna_app_executas`, auto-promotes to `PUBLISHED`.
10. App appears in the App Store; new installs auto-install `required_executas`.

`anna-app apps publish` = push + cut only. It does **not** put the app on the store. `APPROVED` apps are invisible in the store but installable by direct lookup.

**Reviewer checks**: manifest re-validates against schema and the live Executa catalogue; listing copy and screenshots match observed behaviour; mobile checklist walked in a mobile viewport (failure blocks approval).

**Listing fields**: `name` 1–120 required; `slug` 3–80, `^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$`, globally unique, immutable; `category` one of `productivity`, `developer-tools`, `creative`, `data`, `lifestyle`, `education`, `communication`, `entertainment`, `utilities`; `tagline` ≤160; `description` ≤20000; `logo_url` ≤500; `cover_url` ≤500; `screenshots[]` max 6 URLs; `homepage_url`/`support_url`/`privacy_url` ≤500. Logo upload `POST /api/v1/developer/apps/{id}/logo`: `image/jpeg|png|webp|gif`, ≤2 MB, EXIF-rotated, centre-cropped square, resized 256×256, WebP q88; 503 if R2 unconfigured. `tags` live in the manifest, not the listing; no starter prompts/persona/default model/temperature/greeting exist in the schema.

## C. Quota / CU economics

- Gate: every Host API namespace is available with no declaration — "the user's CU quota is the only usage gate". Installing is consent; users can only disable/uninstall.
- `llm.complete`: no CU-per-token figure. `_meta.quotaConsumed` = provider cost × `cost_multiplier`; per-call cap `quota_caps.max_tokens_per_call` default **4096** (silently clamped); sync ceiling 8192 tokens, `llm.stream` 65536. Worst-case precheck → `APP_QUOTA_EXCEEDED` carrying `requiredCu`/`remainingCu`/`requestedMaxTokens`.
- `llm.embed`: separate billing surface (`APP_EMBED`), pay-per-token, no CU figure. Alias `anna-managed-v1` (1536-dim), batch ≤64, ≤32 000 chars/item, reject-not-truncate.
- `web.search`: `max(provider_cost_usd × QUOTA_COST_RATIO, floor_cu)` — ddgs basic **0.5 CU** floor, tavily basic **≈13.8 CU**, advanced **≈27.6 CU**; `max_results` cap 50.
- `web.fetch`: **1.0 CU/URL**; failed provider-chain calls not billed. `web.image_fetch`: **1.0 CU floor**/image.
- Image: Nano Banana 2 **16/image** (0.5K 12 · 1K 16 · 2K 24 · 4K 32; `+3` with `enable_web_search`, `+1` for `thinking_level=high`); GPT Image 2 **42/image** (1024×768 low=1 · medium=7 · high=29); Seedream 5.0 Pro **14** (≤4.2MP **27**).
- TTS (CU/1k chars): Qwen3 TTS Flash Realtime **1**, Qwen Audio 3.0 TTS Flash **3**, TTS Plus **4**, xAI TTS v1 **3**, ElevenLabs Turbo v2.5 **10**, Eleven v3 / Multilingual v2 / MiniMax Speech 02 HD **20**.
- Video (CU/s): MiniMax H3 Max Turbo 480p **5** / 768p **8** / 1080p **16**; H3 Max 480p **10** / 768p **16** / 1080p **32**; Kling v3 Pro **22** (audio on **34**); Seedance 2.5 480p **44** / 720p **95** / 1080p **233**. Async: CU held on submit, settled/refunded at terminal state.
- Music: MiniMax Music 2.6 **30/song**, Lyria 3 Pro **16**, Lyria 3 **8**, Stable Audio 2.5 **40**, ACE-Step **1/s**, ElevenLabs Music **120/started minute**.
- Free: `llm.complete`/`embed`/web are never free, but nothing is charged for failed web provider-chain calls; local `--llm mock` / `--no-llm` cost nothing.
- **Not found**: any statement that new verified users get **1000 credits**, and any CU figure for text completion or embeddings. `reference/quota.md` 404s. Prices are "CU at the platform's current USD→CU ratio".
- Remaining balance: `llm.catalog` returns `quota:{remainingCU}`; Developer Console Playground **Compare** tab (`/developer?view=playground&modality=compare`); `APP_QUOTA_EXCEEDED.data.remainingCu`; usage dashboard for `--llm real`.

## D. Mobile

`ui.form_factors: ["desktop"|"mobile"]`, default `["desktop"]`; optional `views[].mobile_entry` (defaults to `entry`). Review-enforced rows: usable at ≥320 px (iPhone SE 320×568, no horizontal scroll/clipping); safe-area padding via `env(safe-area-inset-*)` or `--anna-safe-area-*`; touch targets ≥44×44 pt; no hover-only interactions (grep `:hover`); no multi-window/geometry dependence (geometry calls are no-ops; `window.open_view` pushes the stack); realtime voice foreground-only — handle `host.app_state {state}` `active|inactive|background` and release `end()`; do not override the shell-injected `viewport` meta. Shell test path: `/api/v1/anna-apps/runtime/mobile-shell?wid=<window_uuid>`. `anna-app dev` validates `form_factors`/`mobile_entry` (CLI ≥0.1.50).

## E. Gotchas / rejection triggers

- Rate limits per developer: app creation **10/day**, submissions **5/day**, active apps **20**. No review SLA, no email notification; no penalty for repeat submissions.
- Cutting a new version during review does **not** move the review target — re-run `apps submit-review` to re-pin; unchanged candidate is an idempotent no-op.
- `bundle_not_ready` / `version_not_published` — `open_app_view` refuses to mount a window unless the version's bundle is `bundle_ready`; the platform refuses windows for `draft` bundles.
- Bundle `finalize` failures: `409 bundle_already_finalized`, `412 file_missing`, `412 sha256_mismatch`, `412 entry_not_in_bundle` (entry not in `file_map`).
- Missing `executa.json` `tool_id`/`type` → silently skipped, then `not_implemented: tools.invoke is not available in this runtime`. `app.json` `bundled_executas` must be an object keyed by handle, not an array (array yields `bundled handle "0"`).
- Go executas need an explicit `executa.json` (`go.mod` alone errors). Duplicate `tool_id`: first registration wins, others skipped.
- Harness <0.1.54 crashed on frames >64 KiB; production parity caps: sync `tools.invoke` ~4 MiB, async 256 KB / 64 KB args, 16 MiB stdio frame.
- Local harness serves bundles **without CSP** — embeds work locally but fail in production unless `csp_overrides["frame-src"]` is declared (no `*`, ≤8 origins); `view.py`-style size rules: `min_size.h` must be ≤600, `min_size.w` ≤1024.
- CSP/Permissions: every browser feature denied unless in `ui.browser_permissions`; entry HTML requires `Sec-Fetch-Dest: iframe` (`403 must_be_iframed`).
- Verified Developer: revocation blocks self-reactivation; PAT is rejected by `/profile/activate` (`403 PAT_NOT_ALLOWED`).
- Possible extra gate: new versions of a live app may be parked "in release review" depending on deployment config.
- Credential-path inconsistency between pages: `~/.config/anna/credentials.json` (CLI ref) vs `~/.local/share/anna-app/credentials.json` mode 600 (local-dev-llm). PAT revoke → `401 token_revoked`.

## F. Window opening / Executa requirement

When the user `#`mentions a `schema ≥ 2` app whose manifest has `ui.views`, three LangChain tools are injected: `open_app_view(app_id, view?, payload?)`, `update_app_view(window_uuid, title?, geometry?, runtime_state_patch?)`, `close_app_view(window_uuid, reason?)`. `app_id` must be the **numeric** `AnnaApp.id` (slugs rejected). Flow: backend builds `<user_mentioned_apps>` + `<ui_views>` into the prompt → LLM calls `open_app_view` → `AnnaAppWindowSession` created/deduped, 120 s JWT minted, SSE `open_view` → Window Manager mounts `<iframe sandbox>` at `/anna-apps/{slug}/{version}/{entry}?wid=…&t=…`. Errors: `app_not_installed`, `bundle_not_ready`, `version_not_published`, `agent_unavailable`, `quota_exceeded`. Windows are also openable by deck click via `POST /api/v1/anna-apps/runtime/windows`.

**No Executa is required for a UI app**: for `schema ≥ 2`, `required_executas` is optional — "Bundle-only UI apps that rely solely on the Host API (e.g. `image.*`, `storage.*`, `llm.*`) may leave both `required_executas` and `optional_executas` empty." Non-empty is required only for `schema: 1`. `schema: 1` has no UI at all.
