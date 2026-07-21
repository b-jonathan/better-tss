# better-tss

A humane desktop client for **UCSD's TSS Schedule of Classes** — search, plan, and manage your schedule without fighting the SAP Fiori UI.

TSS is a SAP S/4HANA + Student Lifecycle Management system fronted by SAPUI5/Fiori, talking to the backend over OData. This project is a thin alternate client over those same endpoints, running on the student's own authenticated session — **no credential custody, no server-side session storage.**

## Status

Research / spec phase. No application code yet. The reverse-engineering findings and the planned architecture live in:

- [`docs/tss-client-spec.md`](docs/tss-client-spec.md) — system architecture, auth model, full OData endpoint/entity catalog, client design, and read-vs-write feasibility.

## Planned architecture (summary)

- **Desktop-only browser extension** (Chrome/Edge/Firefox) with a full-page custom UI.
- Runs in the user's own `tss.ucsd.edu` session; extension `host_permissions` let same-host `fetch()` carry the (HttpOnly) session cookie and bypass CORS.
- Login stays the real UCSD SSO + Duo flow — the extension takes over the UI afterward.
- Reads (catalog, sections, times, instructors, prereqs, my-schedule, holds) are fully reachable via OData today. Enrollment writes are unconfirmed and gated on re-checking during a live registration window — see the spec.

## Scope & ethics

Personal, on-device use against your own authorized account. This is not a credential broker and must never collect other users' logins or sessions. Review UCSD's acceptable-use policy before distributing.
