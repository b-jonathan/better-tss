const SERVICE =
  "https://tss.ucsd.edu/sap/opu/odata4/sap/yucsd_con_module_sb/srvd/sap/yucsd_con_module_servicedef/0001";
const COURSE_ENTITY = "YUCSD_CON_MODULE";
const SCHED_ENTITY = "YUCSD_CON_MODULE_SCHED";
const EVENTS_ENTITY = "YUCSD_CON_EVENTS";
const COURSE_SELECT =
  "CourseAbbr,CourseTitle,DepartmentAbbr,DepartmentText,CreditsDisplay,AcademicLevel,ModuleID,AcademicYear,AcademicPeriod";
const PAGE_SIZE = 50;

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const DAY_START_MIN = 7 * 60;
const DAY_END_MIN = 22 * 60;
const PX_PER_MIN = 0.8;
const GRID_HEIGHT = (DAY_END_MIN - DAY_START_MIN) * PX_PER_MIN;
const COURSE_COLORS = [
  "#00629b", "#16a34a", "#db2777", "#d97706",
  "#7c3aed", "#0891b2", "#dc2626", "#4d7c0f",
];

class SessionExpiredError extends Error {}
class TssUnavailableError extends Error {}

const schedule = new Map();
const courseColor = new Map();

const KEEPALIVE_MS = 5 * 60 * 1000;
const STORAGE_KEY = "better-tss.schedule";
let sessionSeen = false;

function colorFor(code) {
  if (!courseColor.has(code)) {
    courseColor.set(code, COURSE_COLORS[courseColor.size % COURSE_COLORS.length]);
  }
  return courseColor.get(code);
}

function methodRank(method) {
  return { LE: 0, DI: 1, LA: 2 }[method] ?? 3;
}

function methodBadge(method) {
  const cls = method === "LE" ? "le" : method === "LA" ? "la" : "di";
  const b = document.createElement("span");
  b.className = `method-badge ${cls}`;
  b.textContent = method || "—";
  return b;
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
  return (
    /SAMLRequest/.test(body) ||
    /idp\/profile\/SAML2/.test(body) ||
    /tssproxy\.ucsd\.edu/.test(body)
  );
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
  const fullHits = Object.keys(full).filter((name) => lower.includes(name));
  if (fullHits.length) return [...new Set(fullHits.map((n) => full[n]))];

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
      daysText: row.DoWText || "",
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
      obj: e.EventObjid,
      method: e.TeachingMethod || "",
      schedLine: firstSchedLine(e.Sched),
      instr: e.InstructorName || "",
      meetings: meetingsBySid.get(e.EventObjid) || [],
    });
  }

  const packages = [...pkgMap.values()];
  const total = packages.length;
  const objCount = new Map();
  for (const p of packages) for (const o of p.objs) objCount.set(o, (objCount.get(o) || 0) + 1);
  const sharedObjs = new Set(
    total > 1 ? [...objCount].filter(([, c]) => c === total).map(([o]) => o) : [],
  );

  const byMethod = (a, b) => methodRank(a.method) - methodRank(b.method);
  const fixed = sharedObjs.size
    ? dedupeByObj(packages.flatMap((p) => p.events).filter((e) => sharedObjs.has(e.obj))).sort(byMethod)
    : [];
  for (const p of packages) {
    p.variant = p.events.filter((e) => !sharedObjs.has(e.obj)).sort(byMethod);
    p.events.sort(byMethod);
  }
  return { fixed, packages };
}

const els = {
  form: document.getElementById("search-form"),
  query: document.getElementById("query"),
  year: document.getElementById("year"),
  term: document.getElementById("term"),
  status: document.getElementById("status"),
  results: document.getElementById("results"),
  banner: document.getElementById("login-banner"),
  loginBtn: document.getElementById("login-btn"),
  calendar: document.getElementById("calendar"),
  calNote: document.getElementById("cal-note"),
  clearCal: document.getElementById("clear-cal"),
  scheduleList: document.getElementById("schedule-list"),
  calWrap: document.getElementById("cal-wrap"),
  viewList: document.getElementById("view-list"),
  viewCal: document.getElementById("view-cal"),
};

function setView(name) {
  els.viewList.classList.toggle("active", name === "list");
  els.viewCal.classList.toggle("active", name === "cal");
  els.scheduleList.hidden = name !== "list";
  els.calWrap.hidden = name !== "cal";
  if (name === "cal") renderCalendar();
}

function setStatus(text) {
  els.status.textContent = text;
}

function showBanner(show) {
  els.banner.hidden = !show;
}

function pkgKey(moduleId, pkgId) {
  return `${moduleId}:${pkgId}`;
}

function seatText(seats) {
  if (!seats || seats.limit == null) return "";
  const avail = seats.avail == null ? "?" : seats.avail;
  let t = `${avail}/${seats.limit} seats`;
  if (seats.wl) t += ` · ${seats.wl} waitlisted`;
  return t;
}

function placedBlocks() {
  const perDay = DAYS.map(() => []);
  const unplaced = [];
  for (const entry of schedule.values()) {
    for (const ev of entry.events) {
      const label = `${entry.course.CourseAbbr ?? ""} ${ev.method}`.trim();
      for (const m of ev.meetings) {
        if (m.startMin == null || m.endMin == null || m.dayIndices.length === 0) {
          unplaced.push(`${label} (${m.daysText || "TBA"} ${m.timeLabel})`);
          continue;
        }
        for (const d of m.dayIndices) {
          if (d >= DAYS.length) {
            unplaced.push(`${label} (${m.daysText})`);
            continue;
          }
          perDay[d].push({
            label,
            color: entry.color,
            startMin: m.startMin,
            endMin: m.endMin,
            timeLabel: m.timeLabel,
          });
        }
      }
    }
  }
  for (const blocks of perDay) {
    blocks.sort((a, b) => a.startMin - b.startMin);
    for (let i = 0; i < blocks.length; i++) {
      for (let j = i + 1; j < blocks.length; j++) {
        if (blocks[j].startMin < blocks[i].endMin) {
          blocks[i].conflict = true;
          blocks[j].conflict = true;
        }
      }
    }
  }
  return { perDay, unplaced };
}

function renderCalendar() {
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

  const { perDay, unplaced } = placedBlocks();
  for (const blocks of perDay) {
    const col = document.createElement("div");
    col.className = "cal-daycol";
    col.style.height = `${GRID_HEIGHT}px`;
    for (const block of blocks) {
      const el = document.createElement("div");
      el.className = "cal-block" + (block.conflict ? " conflict" : "");
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

  els.calNote.textContent =
    schedule.size === 0
      ? "Add classes above to see them here."
      : unplaced.length
        ? `Not shown (weekend or no set time): ${unplaced.join("; ")}`
        : "";
}

function eventRow(ev) {
  const row = document.createElement("div");
  row.className = "event-row";
  row.appendChild(methodBadge(ev.method));
  const sched = document.createElement("span");
  sched.className = "event-sched";
  sched.textContent = ev.schedLine || "TBA";
  row.appendChild(sched);
  if (ev.instr) {
    const instr = document.createElement("span");
    instr.className = "event-instr";
    instr.textContent = ev.instr;
    row.appendChild(instr);
  }
  return row;
}

function renderScheduleList() {
  els.scheduleList.replaceChildren();
  if (schedule.size === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-schedule";
    empty.textContent = "Nothing added yet. Search above and add a class.";
    els.scheduleList.appendChild(empty);
    return;
  }
  for (const entry of schedule.values()) {
    const card = document.createElement("div");
    card.className = "sched-card";
    card.style.borderLeftColor = entry.color;

    const head = document.createElement("div");
    head.className = "sched-card-head";
    const title = document.createElement("span");
    title.className = "sched-title";
    title.textContent = `${entry.course.CourseAbbr ?? ""} — ${entry.course.CourseTitle ?? ""}`;
    const units = document.createElement("span");
    units.className = "sched-units";
    const seats = seatText(entry.seats);
    units.textContent = `${entry.course.CreditsDisplay ?? "?"} units${seats ? ` · ${seats}` : ""}`;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "rm-btn";
    rm.textContent = "Remove";
    rm.addEventListener("click", () => {
      schedule.delete(entry.key);
      commitSchedule();
    });
    head.append(title, units, rm);
    card.appendChild(head);

    for (const ev of entry.events) card.appendChild(eventRow(ev));
    els.scheduleList.appendChild(card);
  }
}

function renderSchedule() {
  renderScheduleList();
  renderCalendar();
}

function saveSchedule() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...schedule.values()]));
  } catch {
    return;
  }
}

function loadSchedule() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    for (const entry of JSON.parse(raw)) {
      if (!entry || !entry.key) continue;
      schedule.set(entry.key, entry);
      const code = entry.course?.CourseAbbr ?? entry.key;
      if (entry.color) courseColor.set(code, entry.color);
    }
  } catch {
    schedule.clear();
  }
}

function commitSchedule() {
  saveSchedule();
  renderSchedule();
  syncAddButtons();
}

function syncAddButtons() {
  document.querySelectorAll(".add-btn").forEach((btn) => {
    const added = schedule.has(btn.dataset.key);
    btn.textContent = added ? "✓ Added" : "＋ Add";
    btn.classList.toggle("added", added);
  });
}

function addPackage(course, pkg, fixed) {
  const key = pkgKey(course.ModuleID, pkg.pkgId);
  if (schedule.has(key)) {
    schedule.delete(key);
  } else {
    const events = fixed.length ? [...fixed, ...pkg.variant] : pkg.events;
    schedule.set(key, {
      key,
      course,
      pkgId: pkg.pkgId,
      pkgText: pkg.pkgText,
      seats: pkg.seats,
      events,
      color: colorFor(course.CourseAbbr ?? key),
    });
  }
  commitSchedule();
}

function renderPackages(host, course, data) {
  host.replaceChildren();
  if (!data.packages.length) {
    host.textContent = "No sections listed.";
    return;
  }

  if (data.fixed.length) {
    const fixed = document.createElement("div");
    fixed.className = "fixed-events";
    const label = document.createElement("div");
    label.className = "fixed-label";
    label.textContent = "All sections include:";
    fixed.appendChild(label);
    for (const ev of data.fixed) fixed.appendChild(eventRow(ev));
    host.appendChild(fixed);
  }

  for (const pkg of data.packages) {
    const row = document.createElement("div");
    row.className = "pkg";

    const evWrap = document.createElement("div");
    evWrap.className = "pkg-events";
    const list = data.fixed.length ? pkg.variant : pkg.events;
    if (list.length === 0) {
      const only = document.createElement("div");
      only.className = "event-row";
      const tag = document.createElement("span");
      tag.className = "event-sched";
      tag.textContent = pkg.pkgText;
      only.appendChild(tag);
      evWrap.appendChild(only);
    } else {
      for (const ev of list) evWrap.appendChild(eventRow(ev));
    }

    const seats = document.createElement("div");
    seats.className = "pkg-seats";
    seats.textContent = seatText(pkg.seats);

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "add-btn";
    const key = pkgKey(course.ModuleID, pkg.pkgId);
    addBtn.dataset.key = key;
    const added = schedule.has(key);
    addBtn.textContent = added ? "✓ Added" : "＋ Add";
    if (added) addBtn.classList.add("added");
    addBtn.addEventListener("click", () => addPackage(course, pkg, data.fixed));

    row.append(evWrap, seats, addBtn);
    host.appendChild(row);
  }
}

function renderCourses(courses) {
  els.results.replaceChildren();
  for (const course of courses) {
    const block = document.createElement("section");
    block.className = "course";

    const headerBtn = document.createElement("button");
    headerBtn.className = "course-header";
    headerBtn.type = "button";
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = "▸";
    const code = document.createElement("span");
    code.className = "course-code";
    code.textContent = course.CourseAbbr ?? "";
    const title = document.createElement("span");
    title.className = "course-title";
    title.textContent = course.CourseTitle ?? "";
    const units = document.createElement("span");
    units.className = "course-units";
    units.textContent = `${course.CreditsDisplay ?? ""} units`;
    headerBtn.append(caret, code, title, units);

    const detail = document.createElement("div");
    detail.className = "course-detail";
    detail.hidden = true;

    let loaded = false;
    headerBtn.addEventListener("click", async () => {
      const opening = detail.hidden;
      detail.hidden = !opening;
      block.classList.toggle("open", opening);
      if (!opening || loaded) return;
      detail.textContent = "Loading sections…";
      try {
        const data = await loadPackages(course.ModuleID);
        renderPackages(detail, course, data);
        loaded = true;
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          detail.textContent = "";
          showBanner(true);
        } else if (err instanceof TssUnavailableError) {
          detail.textContent = `TSS isn't responding (${err.message}).`;
        } else {
          detail.textContent = `Couldn't load sections: ${err.message}`;
        }
      }
    });

    block.appendChild(headerBtn);
    block.appendChild(detail);
    els.results.appendChild(block);
  }
}

async function runSearch() {
  showBanner(false);
  setStatus("Searching…");
  els.results.replaceChildren();
  try {
    const courses = await fetchOData(
      buildCourseUrl({
        query: els.query.value,
        year: els.year.value,
        term: els.term.value,
      }),
    );
    renderCourses(courses);
    if (courses.length === 0) {
      setStatus("No courses found.");
    } else if (courses.length === PAGE_SIZE) {
      setStatus(`Showing the first ${PAGE_SIZE} — refine your search to narrow it down.`);
    } else {
      setStatus(`Showing ${courses.length} course${courses.length === 1 ? "" : "s"}.`);
    }
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      setStatus("");
      showBanner(true);
      return;
    }
    if (err instanceof TssUnavailableError) {
      setStatus(`TSS isn't responding right now (${err.message}). Try again shortly.`);
      return;
    }
    setStatus(`Something went wrong: ${err.message}`);
  }
}

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  runSearch();
});

els.loginBtn.addEventListener("click", () => {
  sendToBackground({ type: "openTss" }).catch(() => {});
});

els.clearCal.addEventListener("click", () => {
  schedule.clear();
  commitSchedule();
});

els.viewList.addEventListener("click", () => setView("list"));
els.viewCal.addEventListener("click", () => setView("cal"));

function keepSessionAlive() {
  if (!sessionSeen || document.hidden) return;
  sendToBackground({
    type: "tssFetch",
    url: `${SERVICE}/YUCSD_I_PERYRT_SOC?sap-client=500&$top=1`,
  }).catch(() => {});
}

setInterval(keepSessionAlive, KEEPALIVE_MS);

loadSchedule();
renderSchedule();
setView("list");
