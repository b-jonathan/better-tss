const SERVICE =
  "https://tss.ucsd.edu/sap/opu/odata4/sap/yucsd_con_module_sb/srvd/sap/yucsd_con_module_servicedef/0001";
const COURSE_ENTITY = "YUCSD_CON_MODULE";
const SCHED_ENTITY = "YUCSD_CON_MODULE_SCHED";
const EVENTS_ENTITY = "YUCSD_CON_EVENTS";
const COURSE_SELECT =
  "CourseAbbr,CourseTitle,DepartmentAbbr,CreditsDisplay,ModuleID,AcademicYear,AcademicPeriod";
const PAGE_SIZE = 50;

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const DAY_START_MIN = 7 * 60;
const DAY_END_MIN = 22 * 60;
const PX_PER_MIN = 0.7;
const GRID_HEIGHT = (DAY_END_MIN - DAY_START_MIN) * PX_PER_MIN;
const COURSE_COLORS = [
  "#00629b", "#16a34a", "#db2777", "#d97706",
  "#7c3aed", "#0891b2", "#dc2626", "#4d7c0f",
];

const KEEPALIVE_MS = 5 * 60 * 1000;
const STORAGE_KEY = "better-tss.planner";

class SessionExpiredError extends Error {}
class TssUnavailableError extends Error {}

const selection = new Map();
const courseColor = new Map();
let generated = null;
let genIndex = 0;
let sessionSeen = false;

function colorFor(code) {
  if (!courseColor.has(code)) {
    courseColor.set(code, COURSE_COLORS[courseColor.size % COURSE_COLORS.length]);
  }
  return courseColor.get(code);
}

function debounce(fn, ms) {
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

function methodBadge(method) {
  const cls = method === "LE" ? "le" : method === "LA" ? "la" : "di";
  const b = document.createElement("span");
  b.className = `method-badge ${cls}`;
  b.textContent = method || "—";
  return b;
}

function methodRank(method) {
  return { LE: 0, DI: 1, LA: 2 }[method] ?? 3;
}

function instructorsOf(entry) {
  const set = new Set();
  for (const opt of entry.options || []) {
    for (const ev of opt.meta.events) if (ev.instr) set.add(ev.instr);
  }
  return [...set];
}

function sectionsOf(entry) {
  const seen = new Set();
  const out = [];
  for (const opt of entry.options || []) {
    for (const ev of opt.meta.events) {
      const key = `${ev.method}|${ev.schedLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ev);
    }
  }
  return out.sort((a, b) => methodRank(a.method) - methodRank(b.method));
}

function buildCourseUrl({ query, year, term }) {
  const filter = `AcYearText eq '${year}' and AcademicPeriodText eq '${term}'`;
  const params = [
    "sap-client=500",
    `$select=${COURSE_SELECT}`,
    `$filter=${encodeURIComponent(filter)}`,
    `$top=${PAGE_SIZE}`,
  ];
  const q = query.trim();
  if (q) params.push(`$search=${encodeURIComponent(`"${q}"`)}`);
  return `${SERVICE}/${COURSE_ENTITY}?${params.join("&")}`;
}

function buildByModuleUrl(entity, moduleId) {
  const filter = encodeURIComponent(`ModuleID eq '${moduleId}'`);
  return `${SERVICE}/${entity}?sap-client=500&$filter=${filter}&$top=200`;
}

function isLoginRedirect(body) {
  return /SAMLRequest/.test(body) || /idp\/profile\/SAML2/.test(body) || /tssproxy\.ucsd\.edu/.test(body);
}

function sendToBackground(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(resp);
    });
  });
}

async function fetchOData(url, allowReauth = true) {
  const { status, body } = await sendToBackground({ type: "tssFetch", url });
  if (status === 401 || isLoginRedirect(body || "")) {
    if (allowReauth) {
      const res = await sendToBackground({ type: "silentReauth" });
      if (res && res.ok) return fetchOData(url, false);
    }
    throw new SessionExpiredError();
  }
  if (status === 0) throw new TssUnavailableError(body || "no network response");
  if (status >= 500) throw new TssUnavailableError(`TSS returned ${status}`);
  if (status < 200 || status >= 300) throw new Error(`TSS returned ${status}`);
  const rows = JSON.parse(body).value ?? [];
  sessionSeen = true;
  return rows;
}

function toMinutes(value) {
  if (!value) return null;
  const [h, m] = String(value).split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function formatMinutes(min) {
  const h = Math.floor(min / 60);
  const m = String(min % 60).padStart(2, "0");
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${suffix}`;
}

function parseDays(text) {
  if (!text) return [];
  const lower = String(text).toLowerCase();
  const full = { monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6 };
  const hits = Object.keys(full).filter((name) => lower.includes(name));
  if (hits.length) return [...new Set(hits.map((n) => full[n]))];
  const num = parseInt(text, 10);
  if (!Number.isNaN(num) && num >= 1 && num <= 7) return [num - 1];
  return [];
}

function firstSchedLine(sched) {
  return sched ? String(sched).split("\n")[0].trim() : "";
}

function schedMeetings(rows) {
  const bySid = new Map();
  for (const row of rows) {
    const sid = row.SectionId;
    if (!sid) continue;
    const startMin = toMinutes(row.BeginTime);
    const endMin = toMinutes(row.EndTime);
    if (!bySid.has(sid)) bySid.set(sid, []);
    bySid.get(sid).push({
      dayIndices: parseDays(row.DoWText || row.DoW),
      startMin,
      endMin,
      timeLabel:
        startMin != null && endMin != null
          ? `${formatMinutes(startMin)}–${formatMinutes(endMin)}`
          : "TBA",
    });
  }
  return bySid;
}

function dedupeByObj(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    if (seen.has(e.obj)) continue;
    seen.add(e.obj);
    out.push(e);
  }
  return out;
}

async function loadPackages(moduleId) {
  const [events, schedRows] = await Promise.all([
    fetchOData(buildByModuleUrl(EVENTS_ENTITY, moduleId)),
    fetchOData(buildByModuleUrl(SCHED_ENTITY, moduleId)),
  ]);
  const meetingsBySid = schedMeetings(schedRows);
  const pkgMap = new Map();
  for (const e of events) {
    const pkgId = e.EventPkgObjid;
    if (!pkgId) continue;
    if (!pkgMap.has(pkgId)) {
      pkgMap.set(pkgId, {
        pkgId,
        pkgText: e.EventPkgText || pkgId,
        seats: { avail: e.EventPkgSeatsAvailable, limit: e.EventPkgLimit, wl: e.EventPkgNumOnWaitl },
        events: [],
        objs: new Set(),
      });
    }
    const pk = pkgMap.get(pkgId);
    if (pk.objs.has(e.EventObjid)) continue;
    pk.objs.add(e.EventObjid);
    pk.events.push({
      method: e.TeachingMethod || "",
      schedLine: firstSchedLine(e.Sched),
      instr: e.InstructorName || "",
      meetings: meetingsBySid.get(e.EventObjid) || [],
    });
  }
  const packages = [...pkgMap.values()];
  const objCount = new Map();
  for (const p of packages) for (const o of p.objs) objCount.set(o, (objCount.get(o) || 0) + 1);
  const shared = new Set(packages.length > 1 ? [...objCount].filter(([, c]) => c === packages.length).map(([o]) => o) : []);
  const fixedObjs = [];
  for (const p of packages) {
    p.variant = [];
    p.fixedEvents = [];
    for (const ev of p.events) {
      const o = [...p.objs][p.events.indexOf(ev)];
      void o;
    }
  }
  const fixed = shared.size
    ? dedupeByObj(packages.flatMap((p) => p.events.map((ev, i) => ({ ...ev, obj: [...p.objs][i] })))
        .filter((e) => shared.has(e.obj)))
    : [];
  void fixedObjs;
  for (const p of packages) {
    const withObj = p.events.map((ev, i) => ({ ...ev, obj: [...p.objs][i] }));
    p.variant = withObj.filter((e) => !shared.has(e.obj));
  }
  return { fixed, packages };
}

function optionEvents(pkg, fixed) {
  return fixed.length ? [...fixed, ...pkg.variant] : pkg.events;
}

function optionBlocks(events) {
  const blocks = [];
  for (const ev of events) {
    for (const m of ev.meetings) {
      if (m.startMin == null || m.endMin == null) continue;
      for (const day of m.dayIndices) {
        if (day >= DAYS.length) continue;
        blocks.push({ day, start: m.startMin, end: m.endMin });
      }
    }
  }
  return blocks;
}

function buildOptions(course, data) {
  return data.packages.map((pkg) => {
    const events = optionEvents(pkg, data.fixed);
    return {
      id: pkg.pkgId,
      blocks: optionBlocks(events),
      meta: {
        pkgId: pkg.pkgId,
        pkgText: pkg.pkgText,
        seats: pkg.seats,
        courseAbbr: course.CourseAbbr,
        events: events.map((ev) => ({ method: ev.method, schedLine: ev.schedLine, instr: ev.instr, meetings: ev.meetings })),
      },
    };
  });
}

const els = {
  form: document.getElementById("search-form"),
  query: document.getElementById("query"),
  year: document.getElementById("year"),
  term: document.getElementById("term"),
  status: document.getElementById("status"),
  results: document.getElementById("results"),
  selection: document.getElementById("selection"),
  banner: document.getElementById("login-banner"),
  loginBtn: document.getElementById("login-btn"),
  calendar: document.getElementById("calendar"),
  calNote: document.getElementById("cal-note"),
  genLabel: document.getElementById("gen-label"),
  genSummary: document.getElementById("gen-summary"),
  prev: document.getElementById("prev"),
  next: document.getElementById("next"),
  viewCal: document.getElementById("view-cal"),
  viewList: document.getElementById("view-list"),
  calView: document.getElementById("cal-view"),
  listView: document.getElementById("list-view"),
  spread: document.getElementById("pref-spread"),
  b2b: document.getElementById("pref-b2b"),
  start: document.getElementById("pref-start"),
  end: document.getElementById("pref-end"),
  days: [...document.querySelectorAll(".pref-days input")],
};

function setStatus(text) {
  els.status.textContent = text;
}

function showBanner(show) {
  els.banner.hidden = !show;
}

function readPrefs() {
  const t = (v) => {
    const [h, m] = v.split(":").map(Number);
    return h * 60 + (m || 0);
  };
  return {
    spread: els.spread.value,
    avoidBackToBack: els.b2b.checked,
    preferredStart: t(els.start.value || "08:00"),
    preferredEnd: t(els.end.value || "22:00"),
    preferredDays: els.days.filter((d) => d.checked).map((d) => Number(d.value)),
  };
}

function renderCalendar(perDay) {
  els.calendar.replaceChildren();
  const corner = document.createElement("div");
  corner.className = "cal-corner";
  els.calendar.appendChild(corner);
  for (const day of DAYS) {
    const head = document.createElement("div");
    head.className = "cal-dayhead";
    head.textContent = day;
    els.calendar.appendChild(head);
  }
  const axis = document.createElement("div");
  axis.className = "cal-timeaxis";
  axis.style.height = `${GRID_HEIGHT}px`;
  for (let min = DAY_START_MIN; min <= DAY_END_MIN; min += 60) {
    const label = document.createElement("div");
    label.className = "cal-hour";
    label.style.top = `${(min - DAY_START_MIN) * PX_PER_MIN}px`;
    label.textContent = formatMinutes(min).replace(":00", "");
    axis.appendChild(label);
  }
  els.calendar.appendChild(axis);

  for (const blocks of perDay) {
    const col = document.createElement("div");
    col.className = "cal-daycol";
    col.style.height = `${GRID_HEIGHT}px`;
    for (const block of blocks) {
      const el = document.createElement("div");
      el.className = "cal-block";
      el.style.top = `${(block.startMin - DAY_START_MIN) * PX_PER_MIN}px`;
      el.style.height = `${(block.endMin - block.startMin) * PX_PER_MIN}px`;
      el.style.background = block.color;
      const name = document.createElement("strong");
      name.textContent = block.label;
      const time = document.createElement("span");
      time.textContent = block.timeLabel;
      el.append(name, time);
      col.appendChild(el);
    }
    els.calendar.appendChild(col);
  }
}

function chosenToPerDay(chosen) {
  const perDay = DAYS.map(() => []);
  for (const pick of chosen) {
    const meta = pick.option.meta;
    const color = colorFor(meta.courseAbbr);
    for (const ev of meta.events) {
      for (const m of ev.meetings) {
        if (m.startMin == null || m.endMin == null) continue;
        for (const day of m.dayIndices) {
          if (day >= DAYS.length) continue;
          perDay[day].push({
            label: `${meta.courseAbbr} ${ev.method}`,
            color,
            startMin: m.startMin,
            endMin: m.endMin,
            timeLabel: m.timeLabel,
          });
        }
      }
    }
  }
  return perDay;
}

function renderGenSummary(chosen) {
  els.genSummary.replaceChildren();
  for (const pick of chosen) {
    const meta = pick.option.meta;
    const card = document.createElement("div");
    card.className = "sched-card";
    card.style.borderLeftColor = colorFor(meta.courseAbbr);
    const head = document.createElement("div");
    head.className = "sched-card-head";
    const title = document.createElement("span");
    title.className = "sched-title";
    title.textContent = meta.courseAbbr;
    const seats = document.createElement("span");
    seats.className = "sched-units";
    seats.textContent =
      meta.seats && meta.seats.limit != null ? `${meta.seats.avail ?? "?"}/${meta.seats.limit} seats` : "";
    head.append(title, seats);
    card.appendChild(head);
    for (const ev of meta.events) {
      const row = document.createElement("div");
      row.className = "event-row";
      row.appendChild(methodBadge(ev.method));
      const s = document.createElement("span");
      s.className = "event-sched";
      s.textContent = ev.schedLine || "TBA";
      row.appendChild(s);
      card.appendChild(row);
    }
    els.genSummary.appendChild(card);
  }
}

function renderGenerated() {
  const has = generated && generated.count > 0;
  els.prev.disabled = !has || genIndex <= 0;
  els.next.disabled = !has || genIndex >= generated.count - 1;

  if (!generated) {
    els.genLabel.textContent = "Add classes and set preferences to see schedules.";
    renderCalendar(DAYS.map(() => []));
    els.genSummary.replaceChildren();
    els.calNote.textContent = "";
    return;
  }
  if (generated.count === 0) {
    els.genLabel.textContent = "No conflict-free schedule found — loosen preferences or drop a class.";
    renderCalendar(DAYS.map(() => []));
    els.genSummary.replaceChildren();
    els.calNote.textContent = "";
    return;
  }
  const cur = generated.schedules[genIndex];
  const more = generated.exhausted ? "" : "+";
  els.genLabel.textContent = `Schedule ${genIndex + 1} of ${generated.count}${more} · match ${(cur.score * 100).toFixed(0)}%`;
  renderCalendar(chosenToPerDay(cur.chosen));
  renderGenSummary(cur.chosen);
  els.calNote.textContent = "";
}

function generate() {
  const courses = [];
  for (const entry of selection.values()) {
    if (entry.included && entry.options && entry.options.length) {
      courses.push({ courseId: entry.course.ModuleID, options: entry.options });
    }
  }
  if (courses.length === 0) {
    generated = null;
    genIndex = 0;
    els.genLabel.textContent = "Add a course to generate schedules.";
    renderGenerated();
    return;
  }
  generated = generateSchedules(courses, readPrefs(), { cap: 500 });
  genIndex = 0;
  renderGenerated();
  saveState();
}

function renderSelection() {
  els.selection.replaceChildren();
  if (selection.size === 0) {
    const p = document.createElement("p");
    p.className = "empty-schedule";
    p.textContent = "No courses selected. Search and add some.";
    els.selection.appendChild(p);
    return;
  }
  for (const entry of selection.values()) {
    const card = document.createElement("div");
    card.className = "sel-card";

    const head = document.createElement("div");
    head.className = "sel-head";

    const inc = document.createElement("input");
    inc.type = "checkbox";
    inc.checked = entry.included;
    inc.addEventListener("click", (e) => e.stopPropagation());
    inc.addEventListener("change", () => {
      entry.included = inc.checked;
      saveState();
      requestGenerate();
    });

    const dot = document.createElement("span");
    dot.className = "course-dot";
    dot.style.background = colorFor(entry.course.CourseAbbr);

    const code = document.createElement("span");
    code.className = "sel-code";
    code.textContent = entry.course.CourseAbbr;

    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = "▸";

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "rm-btn";
    rm.textContent = "✕";
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      selection.delete(entry.course.ModuleID);
      renderSelection();
      syncAddButtons();
      saveState();
      requestGenerate();
    });

    head.append(inc, dot, code, caret, rm);

    const sub = document.createElement("div");
    sub.className = "sel-sub";
    const count = entry.options ? entry.options.length : 0;
    sub.textContent = `${entry.course.CourseTitle ?? ""} · ${entry.course.CreditsDisplay ?? "?"} units · ${count} option${count === 1 ? "" : "s"}`;

    const detail = document.createElement("div");
    detail.className = "sel-detail";
    detail.hidden = true;
    const instrs = instructorsOf(entry);
    if (instrs.length) {
      const ins = document.createElement("div");
      ins.className = "sel-instr";
      ins.textContent = `Instructors: ${instrs.join(", ")}`;
      detail.appendChild(ins);
    }
    for (const ev of sectionsOf(entry)) {
      const row = document.createElement("div");
      row.className = "event-row";
      row.appendChild(methodBadge(ev.method));
      const s = document.createElement("span");
      s.className = "event-sched";
      s.textContent = ev.schedLine || "TBA";
      row.appendChild(s);
      detail.appendChild(row);
    }

    head.addEventListener("click", () => {
      detail.hidden = !detail.hidden;
      card.classList.toggle("open", !detail.hidden);
    });

    card.append(head, sub, detail);
    els.selection.appendChild(card);
  }
}

function syncAddButtons() {
  document.querySelectorAll(".add-btn").forEach((btn) => {
    const added = selection.has(btn.dataset.id);
    btn.textContent = added ? "✓ Added" : "＋ Add";
    btn.classList.toggle("added", added);
    btn.disabled = added;
  });
}

async function addCourse(course, btn) {
  if (selection.has(course.ModuleID)) return;
  if (btn) {
    btn.textContent = "Loading…";
    btn.disabled = true;
  }
  try {
    const data = await loadPackages(course.ModuleID);
    const options = buildOptions(course, data);
    selection.set(course.ModuleID, { course, options, included: true });
    renderSelection();
    els.results.replaceChildren();
    els.query.value = "";
    setStatus("");
    saveState();
    requestGenerate();
  } catch (err) {
    if (btn) {
      btn.textContent = "＋ Add";
      btn.disabled = false;
    }
    if (err instanceof SessionExpiredError) showBanner(true);
    else setStatus(`Couldn't load ${course.CourseAbbr}: ${err.message}`);
  }
}

function renderResults(courses) {
  els.results.replaceChildren();
  for (const course of courses) {
    const row = document.createElement("div");
    row.className = "result-row";
    const code = document.createElement("span");
    code.className = "course-code";
    code.textContent = course.CourseAbbr ?? "";
    const title = document.createElement("span");
    title.className = "course-title";
    title.textContent = course.CourseTitle ?? "";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "add-btn";
    btn.dataset.id = course.ModuleID;
    const added = selection.has(course.ModuleID);
    btn.textContent = added ? "✓ Added" : "＋ Add";
    if (added) {
      btn.classList.add("added");
      btn.disabled = true;
    }
    btn.addEventListener("click", () => addCourse(course, btn));
    row.append(code, title, btn);
    els.results.appendChild(row);
  }
}

async function runSearch() {
  showBanner(false);
  setStatus("Searching…");
  els.results.replaceChildren();
  try {
    const courses = await fetchOData(
      buildCourseUrl({ query: els.query.value, year: els.year.value, term: els.term.value }),
    );
    renderResults(courses);
    syncAddButtons();
    if (courses.length === 0) setStatus("No courses found.");
    else if (courses.length === PAGE_SIZE) setStatus(`First ${PAGE_SIZE} — refine to narrow.`);
    else setStatus(`${courses.length} course${courses.length === 1 ? "" : "s"}.`);
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      setStatus("");
      showBanner(true);
      return;
    }
    if (err instanceof TssUnavailableError) {
      setStatus(`TSS isn't responding (${err.message}).`);
      return;
    }
    setStatus(`Something went wrong: ${err.message}`);
  }
}

function saveState() {
  try {
    const prefs = {
      spread: els.spread.value,
      b2b: els.b2b.checked,
      start: els.start.value,
      end: els.end.value,
      days: els.days.filter((d) => d.checked).map((d) => d.value),
    };
    const sel = [...selection.values()].map((e) => ({ course: e.course, options: e.options, included: e.included }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ prefs, sel }));
  } catch {
    return;
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const { prefs, sel } = JSON.parse(raw);
    if (prefs) {
      els.spread.value = prefs.spread ?? "neutral";
      els.b2b.checked = !!prefs.b2b;
      els.start.value = prefs.start ?? "08:00";
      els.end.value = prefs.end ?? "22:00";
      const set = new Set(prefs.days ?? []);
      els.days.forEach((d) => (d.checked = set.has(d.value)));
    }
    for (const e of sel ?? []) {
      if (e && e.course && e.course.ModuleID) {
        selection.set(e.course.ModuleID, { course: e.course, options: e.options ?? [], included: e.included !== false });
        colorFor(e.course.CourseAbbr);
      }
    }
  } catch {
    selection.clear();
  }
}

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  runSearch();
});
els.loginBtn.addEventListener("click", () => sendToBackground({ type: "openTss" }).catch(() => {}));
els.prev.addEventListener("click", () => {
  if (generated && genIndex > 0) {
    genIndex--;
    renderGenerated();
  }
});
els.next.addEventListener("click", () => {
  if (generated && genIndex < generated.count - 1) {
    genIndex++;
    renderGenerated();
  }
});

function setMidView(name) {
  els.viewCal.classList.toggle("active", name === "cal");
  els.viewList.classList.toggle("active", name === "list");
  els.calView.hidden = name !== "cal";
  els.listView.hidden = name !== "list";
}
els.viewCal.addEventListener("click", () => setMidView("cal"));
els.viewList.addEventListener("click", () => setMidView("list"));

const debouncedGenerate = debounce(generate, 300);

function requestGenerate() {
  if (selection.size) els.genLabel.textContent = "Updating…";
  debouncedGenerate();
}

for (const input of [els.spread, els.b2b, els.start, els.end, ...els.days]) {
  input.addEventListener("change", () => {
    saveState();
    requestGenerate();
  });
  input.addEventListener("input", () => {
    saveState();
    requestGenerate();
  });
}

function keepSessionAlive() {
  if (!sessionSeen || document.hidden) return;
  sendToBackground({ type: "tssFetch", url: `${SERVICE}/YUCSD_I_PERYRT_SOC?sap-client=500&$top=1` }).catch(() => {});
}
setInterval(keepSessionAlive, KEEPALIVE_MS);

loadState();
renderSelection();
requestGenerate();
