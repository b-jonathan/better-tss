# TSS "Better Client" — Technical Spec & Reverse-Engineering Notes

**Target system:** UCSD TSS Schedule of Classes / student self-service — `https://tss.ucsd.edu`
**Date of investigation:** 2026-07-21
**Product thesis:** TSS's UI is painful. Build a nicer desktop-only client that lets students search, plan, and manage their schedule without touching the SAP Fiori UI, running against the same backend endpoints on the user's own authenticated session.

---

## 1. What TSS actually is

TSS is a **SAP S/4HANA + Student Lifecycle Management (SLcM)** deployment, fronted by **SAP Fiori Launchpad**.

| Layer | Technology |
|---|---|
| Frontend framework | **SAPUI5 1.120.46** (JavaScript) |
| Design system | **SAP Fiori** (the look/UX; SAPUI5 renders it) |
| App shell | **Fiori Launchpad** (`/fiori#<SemanticObject>-<action>`) |
| Transport / API | **OData** — V4 for new custom apps, V2 for SAP-standard student services |
| Backend | SAP NetWeaver Gateway → S/4HANA SLcM, **system ID `S4P`, client `500`** |
| Edge | AWS ALB (`AWSALBTG*` stickiness cookies) |

Mental model for a typical stack: SAPUI5 ≈ Angular, Fiori ≈ Material UI, Launchpad ≈ a micro-frontend shell, OData ≈ a GraphQL-ish query layer expressed as REST URLs — all shipped by one vendor.

**Key architectural fact:** the Fiori/JS layer is a *thin client with no authority*. All data and business rules live behind the OData endpoints, gated only by the session. This is what makes an alternate client possible.

---

## 2. Auth model (the load-bearing section)

- Login is **SAML / Shibboleth SSO** via a dedicated proxy IdP: `https://tssproxy.ucsd.edu/idp/profile/SAML2/POST/SSO`, plus **Duo two-step**.
- There is **NO bearer token, NO OAuth, NO JWT**. Requests carry no `Authorization` header.
- Auth is a **stateful SAP session cookie**: `SAP_SESSIONID_S4P_500` — **HttpOnly**. It is not readable from page JS (`document.cookie`) and is not an extractable/portable token. It authenticates the *entire* SAP session, not just Schedule of Classes.
- Non-secret companion cookies: `sap-usercontext` (`sap-client=500&sap-language=EN`), `AWSALBTG`, `AWSALBTGCORS`, `ystudent_redirect`.
- **Reads (GET):** need only the session cookie. No CSRF.
- **Writes (POST / `$batch` / entity CUD):** additionally require an **`x-csrf-token`**, fetched with a `GET`/`HEAD` carrying `x-csrf-token: Fetch` (server returns the token in a response header). The UI's search fires as a `$batch` POST, so it shows the classic **403 → fetch token → 200** retry.
- **Session lifetime is short** (idles out within ~tens of minutes). An expired session does **not** return an error JSON — the OData URL returns an **HTML page that auto-POSTs a `SAMLRequest`** to the IdP. Detect this (body starts with `<html`/contains `SAMLRequest`, or a `403`) and re-trigger SSO.

### Verified behavior
- Direct GET to an OData entity set with the session cookie and no other auth → **200 + JSON**. Confirmed from a headless HTTP client (no page/DOM/UI5), sending only `Accept`.
- Same request from a cookie-less context → the SAML logon-redirect HTML.
- So: **callable "bare" (curl/Python) with just the cookie** — but obtaining/holding that cookie is the whole problem (see §4).

---

## 3. API surface catalog

### 3.1 Schedule of Classes — browse (READ-ONLY)
Service (OData **V4**):
```
/sap/opu/odata4/sap/yucsd_con_module_sb/srvd/sap/yucsd_con_module_servicedef/0001/
```
`actions: []`, `functions: []` — pure browse. Entity sets:

| Entity set | Contents |
|---|---|
| `YUCSD_CON_MODULE` | Course rows (38 fields). Main search target. |
| `YUCSD_CON_MODULE_DATA` | Section/offering detail |
| `YUCSD_CON_MODULE_SCHED` | Meeting times (`DoW`, `BeginTime`, `EndTime`, `DurationMins`, `SectionId`) |
| `YUCSD_CON_MODULE_INSTR` | Instructors (`InstructorID`, `InstructorName`) |
| `YUCSD_CON_MODULE_BLDG` / `_LOC` | Building / location |
| `YUCSD_CON_MODULE_MODALITY` | In-person/remote/hybrid |
| `YUCSD_CON_MOD_CREDITS` / `_MOD_LONG_DESC` | Units / long description |
| `YUCSD_I_PREREQ_TREE` | Prerequisite tree (parameterized) |
| `YUCSD_CON_DESCRIPTIONS`, `YUCSD_CON_EVENTS` | Descriptions, events |
| `YUCSD_I_PERYRT_SOC` / `_PERIDT_SOC` | Academic year / term value lists |
| `YUCSD_I_MINMAXUNITS` | Min/max units per term |
| `YUCSD_CON_SOC_STUDENT_STUDY` | Student study context |

Example live query (the "Go" button):
```
GET /sap/opu/odata4/sap/yucsd_con_module_sb/srvd/sap/yucsd_con_module_servicedef/0001/YUCSD_CON_MODULE
    ?$count=true
    &$search="CSE"
    &$filter=AcYearText eq '2026/2027' and AcademicPeriodText eq 'Fall Quarter'
    &$select=CourseAbbr,CourseTitle,CreditsDisplay,DepartmentAbbr,ModuleID,incrementDisplay
    &$top=30&$skip=0
Accept: application/json
```
Standard OData V4: `$search`, `$filter`, `$select`, `$top`/`$skip`, `$count`. Server-side paging/sort/filter.

### 3.2 My Courses / enrollment view (READ-ONLY today)
App `ZUSModule-display` ("My Courses"), service (OData **V2**):
```
/sap/opu/odata/ITUS/PR_MY_MODULES_V2_SRV/
```
SAP-standard SLcM student self-service (namespace `ITUS`). Notable entity sets: `ModuleSet`, `ModuleOfferingSet`, `WishListSet`, `RequestSet`, `BookingCheckLogSet`, `CreditOptionSet`, `EventScheduleSet`, `ExamSet`, `ProgramSet`, `PersonSet`.

**All reg-relevant sets are `creatable=false, updatable=false, deletable=false`.** Only function import is `FindModuleGroups` (GET search). `WishListSet` has no CRUD flags declared (possibly creatable by SAP default → the *planner wishlist*, not a booking).

### 3.3 Full provisioned app inventory (this student account)
| Intent | Title | UI5 app | OData service | Role |
|---|---|---|---|---|
| `YSchedule-view` | Schedule of Classes | `yucsd_soc` | `yucsd_con_module_sb` (V4) | Browse (RO) |
| `ZUSModule-display` | My Courses | `itus/mymodules` | `ITUS/PR_MY_MODULES_V2_SRV` (V2) | My enrolled (RO) |
| `YStudent-Overview` | Student dashboard | `yucsdovpstudent` | multiple `ited/BC_OVP_*` (V2) | Reads |
| `YStudent-apptTimes` | Enrollment appointment times | `yappttimes` | — | Read |
| `YStudent-myHolds` | Holds / reg blocks | `yucsdmyholds` | — | Read |
| `YStudent-myPersonalDetails` | Personal details | `yucsdpersdets` | — | Read |
| `YTEA-studentView` | TEA / evaluations | `ytea_request` | — | — |
| `ZBankAccount-display` | My Bank Accounts | `ited/sfbnkacc1` | — | Read |
| `YSharingPermission-maintain` | Sharing permissions | `yucsd_pridet` | — | Maintain |
| `Shell-startGUI` / `startWDA` | Classic SAP GUI / WebDynpro launcher | — | — | **Infra — see §5 risk** |

Enumerate via: `GET /sap/bc/ui2/start_up?so=*&action=*&systemAliasesFormat=object&shellType=FLP&depth=0` → parse `targetMappings`.

---

## 4. Client architecture — chosen design

**Decision: Option 2 — full-page browser extension UI. Desktop-only. Mobile explicitly out of scope.**

### Why not a plain web app
- `SAP_SESSIONID_S4P_500` is HttpOnly + first-party to `tss.ucsd.edu`; a page on another origin can't read it or attach it.
- SAP sends no CORS `Access-Control-Allow-Origin` for a third-party origin → browser blocks reading responses.
- The only way around is a server-side proxy — which forces you to custody users' live sessions. Rejected (liability).

### Why the extension works
`HttpOnly` blocks *JS from reading* the cookie, not the *browser from attaching* it. An extension with `host_permissions: ["https://tss.ucsd.edu/*"]` makes `fetch()` calls that (a) auto-attach the session cookie and (b) bypass CORS for that host. So the extension's own full-page UI (`chrome-extension://…/app.html`) can drive all OData routes while being 100% custom UI. **Zero credential custody** — the session never leaves the user's browser.

### Login / session flow
1. User opens the extension app → probe session with a cheap OData GET.
2. If body is the SAML-redirect HTML (or 403) → open a `tss.ucsd.edu` tab; user completes normal SSO + Duo there (interactive; acceptable per requirements).
3. Session cookie now in the browser → extension fetches ride it → return to custom UI.
4. On any later logon-redirect/403 → repeat step 2. (No background jobs; Duo-gated re-auth is fine.)

### For writes (if/when reachable)
Fetch CSRF first: `GET <service>/ -H "x-csrf-token: Fetch"` → read `x-csrf-token` response header → include it on the POST/PUT/DELETE.

### Migration path
If Chrome Web Store review cadence becomes a bottleneck for UI iteration, move to **Option 3**: keep a thin, stable extension as the auth-bridge (`postMessage`), host the UI as a normal web app deployed freely. The fetch layer is unchanged.

---

## 5. Feasibility: read vs. write

| Capability | Reachable via clean OData? | Status |
|---|---|---|
| Search / browse catalog, sections, times, instructors, prereqs | ✅ V4 `yucsd_con_module` | **Build now** |
| View my enrolled courses, holds, appt times, personal details, dashboard | ✅ V2 `PR_MY_MODULES` + `BC_OVP_*` | **Build now** |
| **Enroll / drop / waitlist** | ❌ Not exposed to this account today | **UNKNOWN — see risk** |

### The enrollment risk (most important open item)
No add/drop/waitlist write op is exposed in the current provisioned app set. Two possible explanations, unresolved:
1. **Reg window closed.** SAP SLcM commonly flips booking `creatable` flags / provisions the booking app **only during the student's enrollment appointment**. The surface may look entirely different once the Fall 2026 appointment opens.
2. **Enrollment may run through classic SAP WebGUI**, not Fiori. `Shell-startGUI` → `webgui;~service=3200;transaction=ANY` is wired in. If the actual register step is a DYNPRO transaction rendered via WebGUI, it is **stateful screen-scraping, not a clean REST call** — effectively not cleanly reimplementable. This would cap the product at "read/plan," with enroll bouncing the user to real TSS.

**Action:** re-run the mapping (§3.3 app enumeration + service `$metadata` `creatable`/`deletable` flags + watch a real add-to-cart/enroll in the network tab) **the moment a Fall 2026 enrollment appointment is active** on a test account. That is the only way to resolve write feasibility.

---

## 6. Recommended build order
1. **Read/plan client (high confidence):** search + filters over `YUCSD_CON_MODULE`, section/time/instructor/prereq detail, my-schedule + holds + appt-times views. This is where TSS hurts most and it's fully reachable today.
2. **Session/auth plumbing:** session probe, SAML-redirect detection, re-auth handoff, CSRF fetch helper.
3. **Adapter layer:** isolate entity/field names and `sap-context-token` values behind a thin mapping module — these are undocumented and can change on any SAP transport with no versioning. A field rename should be a one-line fix.
4. **Enroll (gated on §5 re-check):** only after confirming an OData write path exists during a live reg window.

---

## 7. Risks & constraints
- **No API contract.** Undocumented internal endpoints; entity/field names and context tokens can change without notice. Build defensively.
- **Session fragility.** Short idle timeout; Duo re-auth required. Fine for interactive use, impossible for background automation.
- **Policy / authorization.** A personal, on-device client running in the user's *own* logged-in session is the defensible shape (no credential custody, no server-side session storage, no per-user credential capture). Do **not** build a server-side session broker or collect other users' credentials/cookies — that's credential harvesting and violates UCSD electronic-use policy. Review UCSD's acceptable-use policy before distributing; keep request patterns faithful to the UI and avoid aggressive polling.
- **Writes mutate real records.** Any enroll/drop path must fetch CSRF correctly and be idempotent (no double-enroll on retry).

---

## 8. Quick reference — request recipes

Search (read):
```
GET https://tss.ucsd.edu/sap/opu/odata4/sap/yucsd_con_module_sb/srvd/sap/yucsd_con_module_servicedef/0001/YUCSD_CON_MODULE
    ?$search="CSE"&$filter=AcYearText eq '2026/2027' and AcademicPeriodText eq 'Fall Quarter'
    &$select=CourseAbbr,CourseTitle,CreditsDisplay,ModuleID&$top=30&$count=true
Accept: application/json
Cookie: SAP_SESSIONID_S4P_500=…; sap-usercontext=sap-client=500&sap-language=EN
```

My enrolled modules (read):
```
GET https://tss.ucsd.edu/sap/opu/odata/ITUS/PR_MY_MODULES_V2_SRV/ModuleSet?$format=json
```

Enumerate provisioned apps:
```
GET https://tss.ucsd.edu/sap/bc/ui2/start_up?so=*&action=*&systemAliasesFormat=object&shellType=FLP&depth=0
```

CSRF token (before any write):
```
GET https://tss.ucsd.edu/sap/opu/odata/ITUS/PR_MY_MODULES_V2_SRV/
    x-csrf-token: Fetch
→ read response header  x-csrf-token: <value>
```

Session-expiry signal: any OData response whose body begins with `<html` or contains `SAMLRequest` = re-auth needed.
