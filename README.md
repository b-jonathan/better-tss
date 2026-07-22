# better-tss

A humane desktop client for **UCSD's TSS Schedule of Classes** — search, plan, and manage your schedule without fighting the SAP Fiori UI.

TSS is a SAP S/4HANA + Student Lifecycle Management system fronted by SAPUI5/Fiori, talking to the backend over OData. This project is a thin alternate client over those same endpoints, running on the student's own authenticated session — **no credential custody, no server-side session storage.**

## Status

Early prototype (v0.1). A minimal Manifest V3 extension that opens a full-page
UI and searches the TSS course catalog via a direct OData `fetch`. Reads only.

- [`extension/`](extension/) — the unpacked MV3 extension.
- [`docs/tss-client-spec.md`](docs/tss-client-spec.md) — system architecture, auth model, full OData endpoint/entity catalog, client design, and read-vs-write feasibility.

## Running it

1. Log in to TSS once in the same browser: <https://tss.ucsd.edu/fiori> (SSO + Duo).
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the `extension/` folder.
3. Click the **better-tss** toolbar icon. A new tab opens with the search page.
4. Type a subject/course (e.g. `CSE`), pick year + term, hit **Search**.

If the session has expired, the page shows a **Log in to TSS** button instead of results; log in, return, and search again.

## Known caveat (the thing most likely to need work next)

The page issues a cross-origin `fetch` to `tss.ucsd.edu` with `credentials: "include"`.
The extension's `host_permissions` grant the CORS bypass, and the browser attaches
the `SAP_SESSIONID_S4P_500` cookie — **but only if that cookie's `SameSite` policy
allows it on a cross-site subrequest.** If TSS sets the session cookie `SameSite=Lax/Strict`,
the direct fetch may come back as the SSO redirect even while you're logged in.

The fix, if that happens, is to move the fetch into a **content script** injected into
an open `tss.ucsd.edu` tab (same-origin, cookie always attached) and relay results to the
app page via `chrome.runtime` messaging. That's the planned v0.2 hardening.

## Planned architecture (summary)

- **Desktop-only browser extension** (Chrome/Edge/Firefox) with a full-page custom UI.
- Runs in the user's own `tss.ucsd.edu` session; extension `host_permissions` let same-host `fetch()` carry the (HttpOnly) session cookie and bypass CORS.
- Login stays the real UCSD SSO + Duo flow — the extension takes over the UI afterward.
- Reads (catalog, sections, times, instructors, prereqs, my-schedule, holds) are fully reachable via OData today. Enrollment writes are unconfirmed and gated on re-checking during a live registration window — see the spec.

## Scope & ethics

Personal, on-device use against your own authorized account. This is not a credential broker and must never collect other users' logins or sessions. Review UCSD's acceptable-use policy before distributing.
