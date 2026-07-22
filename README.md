# better-tss

A humane desktop client for **UCSD's TSS Schedule of Classes** — search, plan, and manage your schedule without fighting the SAP Fiori UI.

TSS is a SAP S/4HANA + Student Lifecycle Management system fronted by SAPUI5/Fiori, talking to the backend over OData. This project is a thin alternate client over those same endpoints, running on the student's own authenticated session — **no credential custody, no server-side session storage.**

## Status

Early prototype (v0.2). A Manifest V3 extension that opens a full-page UI and
searches the TSS course catalog. Reads only.

- [`extension/`](extension/) — the unpacked MV3 extension.
- [`docs/tss-client-spec.md`](docs/tss-client-spec.md) — system architecture, auth model, full OData endpoint/entity catalog, client design, and read-vs-write feasibility.

## Running it

1. Log in to TSS once in the same browser: <https://tss.ucsd.edu/fiori> (SSO + Duo).
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the `extension/` folder.
3. Click the **better-tss** toolbar icon. A new tab opens with the search page.
4. Type a subject/course (e.g. `CSE`), pick year + term, hit **Search**.

If the session has expired, the page shows a **Log in to TSS** button instead of results; log in, return, and search again.

## How auth works (v0.2)

The extension page does **not** fetch TSS directly — a cross-origin fetch wouldn't
reliably attach the `SAP_SESSIONID_S4P_500` cookie (SameSite), so TSS would treat it
as logged-out even while you have a valid session.

Instead, the background service worker finds (or opens) your logged-in `tss.ucsd.edu`
tab and runs the OData `fetch` **inside that tab's own page context** via
`chrome.scripting.executeScript`. There the request is same-origin, so the session
cookie attaches natively, exactly as the real TSS UI does it. Results are relayed back
to the app page via `chrome.runtime` messaging.

TSS's gateway rejects any request that lacks a non-empty **`sap-passport`** header
(the SAP end-to-end tracing header the UI5 framework attaches to every call) with a
generic `403 "Access denied"`. A plain `fetch` omits it, so every request 403s. We
send a non-empty `sap-passport` header to clear the gate — the gateway only checks
presence, not the value. GET reads need no CSRF token (only writes will).

Responses are classified honestly:

- SAML redirect / no TSS tab logged in → **"Log in to TSS"** banner
- `5xx` / timeout / no network → **"TSS isn't responding"** (an outage, not your session)
- JSON → rendered results

If no `tss.ucsd.edu` tab is open, the worker opens one in the background on first search.

## Planned architecture (summary)

- **Desktop-only browser extension** (Chrome/Edge/Firefox) with a full-page custom UI.
- Runs in the user's own `tss.ucsd.edu` session; extension `host_permissions` let same-host `fetch()` carry the (HttpOnly) session cookie and bypass CORS.
- Login stays the real UCSD SSO + Duo flow — the extension takes over the UI afterward.
- Reads (catalog, sections, times, instructors, prereqs, my-schedule, holds) are fully reachable via OData today. Enrollment writes are unconfirmed and gated on re-checking during a live registration window — see the spec.

## Scope & ethics

Personal, on-device use against your own authorized account. This is not a credential broker and must never collect other users' logins or sessions. Review UCSD's acceptable-use policy before distributing.
