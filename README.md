<p align="center">
  <img src="assets/branding/odysseus-wordmark.png" alt="Odysseus" width="238">
</p>

<p align="center">
  A self-hosted AI workspace for chat, agents, research, documents, email, notes, calendar, and local model workflows.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="website/setup.md">Setup Guide</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="ROADMAP.md">Roadmap</a>
</p>

<p align="center">
  <a href="https://repology.org/project/odysseus-ai/versions"><img src="https://repology.org/badge/vertical-allrepos/odysseus-ai.svg" alt="Packaging status"></a>
</p>

<p align="center">
  <img src="assets/branding/odysseus-browser.jpg" alt="Odysseus interface">
</p>

---

## Quick Start

> `dev` is the default branch and gets the newest changes first. Use [`main`](https://github.com/odysseus-dev/odysseus/tree/main) if you want the more curated branch.

```bash
git clone https://github.com/odysseus-dev/odysseus.git
cd odysseus
cp .env.example .env
docker compose up -d --build
```

Open `http://localhost:7011` when the containers are healthy. The first admin password is printed in `docker compose logs odysseus`.

The compose files pull the official multi-arch image `ghcr.io/odysseus-dev/odysseus` (published by CI on every push to `main` and `dev`) and only build locally if the pull fails — so this also works on hosts without a build toolchain, e.g. as a [Portainer](https://www.portainer.io/) stack.

**Production deployments:** pin the immutable tag instead of `:latest`. `:latest` and bare `:X.Y.Z` tags move on every push to `main`, but `:X.Y.Z-<sha>` (e.g. `1.0.2-7c8070f`) always refers to one specific build:

```bash
ODYSSEUS_IMAGE=ghcr.io/odysseus-dev/odysseus:1.0.2-7c8070f docker compose up -d
```

Native installs, GPU notes, Windows/macOS instructions, HTTPS, and configuration live in the [setup guide](website/setup.md).

## Features

- **Chat + Agents** — local/API models, tools, MCP, files, shell, skills, and memory.
- **Cookbook** — hardware-aware model recommendations, downloads, and serving.
- **Deep Research** — multi-step web research with source reading and report generation.
- **Compare** — blind side-by-side model testing and synthesis.
- **Documents** — writing-first editor with AI edits, suggestions, Markdown, HTML, CSV, and syntax highlighting.
- **Email** — IMAP/SMTP inbox with triage, tags, summaries, reminders, and reply drafts.
- **Personal Integrations** — owner-scoped Gmail/Moodle/WhatsApp retrieval, ETH Shibboleth browser access, maps, read-only product discovery, and browser automation. Connector history can be searched with citations through shared RAG; WhatsApp pairing and outbound writes are explicit opt-ins.
- **Notes, Tasks + Calendar** — reminders, todos, scheduled agent tasks, and CalDAV sync.
- **Extras** — gallery/image editor, themes, uploads, web search, presets, sessions, and 2FA.

## Personal Integrations

Open **Settings → Integrations** to add per-owner connector accounts. Gmail indexing uses an existing configured Email account and its authorized Google OAuth/IMAP connection; it never copies mail credentials into the retrieval index. Moodle accepts a user-authorized web-service token or opens the normal ETH Shibboleth/MFA login in a separate, owner-isolated browser profile. Inspect the login page in Settings and explicitly fill/click its sign-in controls yourself; password values pass transiently through the Odysseus backend for the requested HTTPS field fill and are not saved as connector credentials. Complete ETH MFA yourself; Odysseus does not automate authentication. For a headless host, install Playwright's Chromium with `python -m playwright install chromium`, set `ODYSSEUS_BROWSER_HEADLESS=true`, and use the Moodle browser controls in Settings. Docker installs Playwright Chromium under `/ms-playwright` and defaults browser sessions to headless.

WhatsApp requires the optional single-device bridge and an explicit pairing scan. History is limited to data available from the provider/bridge and may be partial; it does not guarantee every older message. Bridge connections and outbound messages are disabled unless explicitly enabled on both app and bridge; each scheduled send also requires explicit confirmation. Maps need an owner-scoped OpenRouteService key and provide OpenStreetMap attribution. Shopping uses public SearXNG/product-page data, which can be stale; it never places orders or handles payment. Browser sessions are isolated per owner/account; all page, resource, and WebSocket egress is DNS-pinned and private-network targets are blocked. Cart, checkout, purchase, and payment actions and handoffs are not automated.

For this fork's integrations, build the checked-out source rather than pulling the upstream image:

```bash
ODYSSEUS_IMAGE=odysseus-personal:local docker compose build odysseus
ODYSSEUS_IMAGE=odysseus-personal:local docker compose up -d --no-build
```

Native installs need the complete `requirements.txt` environment, followed by `python -m playwright install chromium` (on supported Linux hosts, `python -m playwright install --with-deps chromium` also installs system libraries). Reinstall the browser after changing the pinned Playwright version. The optional [WhatsApp bridge](whatsapp-bridge/README.md) requires Node.js 22.x and `npm ci`; pairing is never part of dependency installation. Protect the app with HTTPS when entering credentials remotely. Browser field values are cleared from Settings after either success or rejection.

Keyword retrieval and citations work without a vector service. Semantic indexing is an explicit per-source option requiring a healthy ChromaDB/embedding setup; deleting a source or replacing its content with empty text removes its previous indexed content. Actual Google OAuth, ETH Shibboleth/MFA and WhatsApp pairing must be completed by the account owner; synthetic protocol/browser checks are not proof of those live account authorizations.
Moodle calendar dates are normalized to UTC for date-filtered retrieval and removal of disappeared events; the next sync also repairs older epoch-string dates. Bounded file/REST fetches request uncompressed responses and reject servers that still return compressed content before decoding it, matching the shared web-fetch safety policy.
Connector tools participate in the request-scoped tool authority and untrusted-content approval gates. Read-only WhatsApp requests do not authorize sends, even before any external content is read; immediate and scheduled sends require affirmative send intent. Scheduled WhatsApp actions validate the same account/confirmation controls from both Settings and agent task creation; their sealed payload cannot be changed after admission. This release freezes the official `dev` update at `c3819e3cbf56c4f899eacc66b21115a77d9c570d`.
The frozen tree's canonical Settings → Integrations flow was exercised with isolated synthetic Alice/Bob accounts: account creation, browser navigation/read/click/back/download, HTTPS field fill and rejection clearing, Moodle courses/calendar/files, IMAP-backed Gmail sync, Maps routing, Shopping JSON-LD and guarded browser handoff, and authenticated WhatsApp history/live reads. Scheduler sync and persisted-occurrence recovery were exercised with provider writes disabled; no live messages or purchases were made. Non-admin users can manage only their own connectors. These checks do not replace live authorization or a healthy semantic-index service.


## Demo

A full hover-to-play tour lives on the [Odysseus landing page](https://odysseus-dev.github.io/odysseus/). Its source lives under [`website/`](website/).

## Contributing

Help is welcome. The best entry points are fresh-install testing, provider setup bugs, mobile/editor polish, docs, and small focused refactors. See [CONTRIBUTING.md](CONTRIBUTING.md) and [ROADMAP.md](ROADMAP.md).

## Security

Odysseus is a self-hosted workspace with powerful local tools. Keep auth enabled, keep private data out of Git, and do not expose raw model/service ports publicly.

- Keep `AUTH_ENABLED=true` for any network-accessible deployment.
- Keep `LOCALHOST_BYPASS=false` outside local development.

Deployment details are in the [setup guide](website/setup.md#security-notes).

## Star History

<a href="https://star-history.dera.page/#odysseus-dev/odysseus&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://star-history.dera.page/svg?repos=odysseus-dev/odysseus&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://star-history.dera.page/svg?repos=odysseus-dev/odysseus&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://star-history.dera.page/svg?repos=odysseus-dev/odysseus&type=date&legend=top-left" />
 </picture>
</a>

## License

AGPL-3.0-or-later -- see [LICENSE](LICENSE) and [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md).
