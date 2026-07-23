const SERVICE =
  "https://tss.ucsd.edu/sap/opu/odata4/sap/yucsd_con_module_sb/srvd/sap/yucsd_con_module_servicedef/0001";
const COURSE_ENTITY = "YUCSD_CON_MODULE";
const SCHED_ENTITY = "YUCSD_CON_MODULE_SCHED";
const INSTR_ENTITY = "YUCSD_CON_MODULE_INSTR";
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
let sessionSeen = false;

function colorFor(code) {
  if (!courseColor.has(code)) {
    courseColor.set(code, COURSE_COLORS[courseColor.size % COURSE_COLORS.length]);
  }
  return courseColor.get(code);
}

function familyLetter(sectionId) {
  const m = String(sectionId).match(/^[A-Za-z]+/);
  return m ? m[0].toUpperCase() : String(sectionId);
}

function isLecture(sectionId) {
  return /0\s*$/.test(String(sectionId)) && /00\s*$/.test(String(sectionId));
}

function methodLabel(sectionId) {
  return isLecture(sectionId) ? "LE" : "DI";
}

function methodBadge(method, small) {
  const b = document.createElement("span");
  b.className = `method-badge ${method === "LE" ? "le" : "di"}${small ? " small" : ""}`;
  b.textContent = method;
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

  const cleaned = lower.replace(/[^a-z]/g, "");
  const two = { su: 6, sa: 5, tu: 1, th: 3, mo: 0, we: 2, fr: 4 };
  const one = { m: 0, t: 1, w: 2, f: 4, s: 5, u: 6, r: 3 };
  const days = new Set();
  let i = 0;
  while (i < cleaned.length) {
    const pair = cleaned.slice(i, i + 2);
    const single = cleaned.slice(i, i + 1);
    if (two[pair] !== undefined) {
      days.add(two[pair]);
      i += 2;
    } else if (one[single] !== undefined) {
      days.add(one[single]);
      i += 1;
    } else {
      i += 1;
    }
  }
  if (days.size) return [...days];

  const num = parseInt(text, 10);
  if (!Number.isNaN(num) && num >= 1 && num <= 7) return [num - 1];
  return [];
}

function groupSections(schedRows, instructorNames) {
  const bySection = new Map();
  for (const row of schedRows) {
    const id = row.SectionId || "—";
    if (!bySection.has(id)) {
      bySection.set(id, { sectionId: id, method: methodLabel(id), meetings: [] });
    }
    const startMin = toMinutes(row.BeginTime);
    const endMin = toMinutes(row.EndTime);
    bySection.get(id).meetings.push({
      daysText: row.DoWText || row.DoW || "",
      dayIndices: parseDays(row.DoWText || row.DoW),
      startMin,
      endMin,
      timeLabel:
        startMin !== null && endMin !== null
          ? `${formatMinutes(startMin)}–${formatMinutes(endMin)}`
          : "TBA",
    });
  }
  const sections = [...bySection.values()];
  const instructors = [...new Set(instructorNames)].join(", ");
  for (const s of sections) s.instructors = instructors;
  return sections;
}

function buildFamilies(sections) {
  const fams = new Map();
  for (const s of sections) {
    const letter = familyLetter(s.sectionId);
    if (!fams.has(letter)) fams.set(letter, { letter, lecture: null, subs: [] });
    const fam = fams.get(letter);
    if (isLecture(s.sectionId) && !fam.lecture) fam.lecture = s;
    else fam.subs.push(s);
  }
  for (const fam of fams.values()) {
    if (!fam.lecture && fam.subs.length) fam.lecture = fam.subs.shift();
  }
  return [...fams.values()];
}

async function loadFamilies(moduleId) {
  const [schedRows, instrRows] = await Promise.all([
    fetchOData(buildByModuleUrl(SCHED_ENTITY, moduleId)),
    fetchOData(buildByModuleUrl(INSTR_ENTITY, moduleId)),
  ]);
  const sections = groupSections(schedRows, instrRows.map((r) => r.InstructorName).filter(Boolean));
  return buildFamilies(sections);
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

function groupKey(moduleId, letter) {
  return `${moduleId}:${letter}`;
}

function partsOf(entry) {
  return [entry.lecture, entry.sub].filter(Boolean);
}

function placedBlocks() {
  const perDay = DAYS.map(() => []);
  const unplaced = [];
  for (const entry of schedule.values()) {
    for (const part of partsOf(entry)) {
      const label = `${entry.course.CourseAbbr ?? ""} ${part.sectionId}`.trim();
      for (const meeting of part.meetings) {
        if (meeting.startMin === null || meeting.endMin === null || meeting.dayIndices.length === 0) {
          unplaced.push(`${label} (${meeting.daysText || "TBA"} ${meeting.timeLabel})`);
          continue;
        }
        for (const dayIdx of meeting.dayIndices) {
          if (dayIdx >= DAYS.length) {
            unplaced.push(`${label} (${meeting.daysText})`);
            continue;
          }
          perDay[dayIdx].push({
            label,
            method: part.method,
            color: entry.color,
            startMin: meeting.startMin,
            endMin: meeting.endMin,
            timeLabel: meeting.timeLabel,
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
      name.textContent = `${block.label} ${block.method}`;
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
        ? `Not shown (weekend or no time): ${unplaced.join("; ")}`
        : "";
}

function meetingSummary(part) {
  return part.meetings
    .map((m) => `${m.daysText || "TBA"} ${m.timeLabel}`.trim())
    .join(", ");
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
    units.textContent = `${entry.course.CreditsDisplay ?? "?"} units`;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "rm-btn";
    rm.textContent = "Remove";
    rm.addEventListener("click", () => {
      schedule.delete(entry.key);
      renderSchedule();
      syncAddButtons();
    });
    head.append(title, units, rm);
    card.appendChild(head);

    for (const part of partsOf(entry)) {
      const line = document.createElement("div");
      line.className = "sched-part";
      const badge = methodBadge(part.method);
      const code = document.createElement("span");
      code.className = "sched-sec";
      code.textContent = part.sectionId;
      const meet = document.createElement("span");
      meet.className = "sched-meet";
      meet.textContent = meetingSummary(part) || "TBA";
      const instr = document.createElement("span");
      instr.className = "sched-instr";
      instr.textContent = part.instructors || "";
      line.append(badge, code, meet, instr);
      card.appendChild(line);
    }
    els.scheduleList.appendChild(card);
  }
}

function renderSchedule() {
  renderScheduleList();
  renderCalendar();
}

function syncAddButtons() {
  document.querySelectorAll(".add-btn").forEach((btn) => {
    const added = schedule.has(btn.dataset.key);
    btn.textContent = added ? "✓ Added" : "＋ Add";
    btn.classList.toggle("added", added);
  });
}

function addFamily(course, family, subId) {
  const key = groupKey(course.ModuleID, family.letter);
  if (schedule.has(key)) {
    schedule.delete(key);
  } else {
    const sub = family.subs.find((s) => s.sectionId === subId) || null;
    schedule.set(key, {
      key,
      course,
      lecture: family.lecture,
      sub,
      color: colorFor(course.CourseAbbr ?? key),
    });
  }
  renderSchedule();
  syncAddButtons();
}

function renderFamilies(host, course, families) {
  host.replaceChildren();
  if (families.length === 0) {
    host.textContent = "No sections listed.";
    return;
  }
  for (const family of families) {
    const fam = document.createElement("div");
    fam.className = "family";

    const lectureLine = document.createElement("div");
    lectureLine.className = "family-lecture";
    if (family.lecture) {
      const badge = methodBadge(family.lecture.method);
      const code = document.createElement("span");
      code.className = "sched-sec";
      code.textContent = family.lecture.sectionId;
      const meet = document.createElement("span");
      meet.className = "sched-meet";
      meet.textContent = meetingSummary(family.lecture) || "TBA";
      const instr = document.createElement("span");
      instr.className = "sched-instr";
      instr.textContent = family.lecture.instructors || "";
      lectureLine.append(badge, code, meet, instr);
    } else {
      lectureLine.textContent = `Section group ${family.letter}`;
    }

    const controls = document.createElement("div");
    controls.className = "family-controls";
    const radioName = `${course.ModuleID}-${family.letter}`;
    let selectedSub = family.subs[0]?.sectionId ?? null;

    if (family.subs.length) {
      family.subs.forEach((sub, idx) => {
        const opt = document.createElement("label");
        opt.className = "sub-opt";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = radioName;
        radio.value = sub.sectionId;
        if (idx === 0) radio.checked = true;
        radio.addEventListener("change", () => {
          selectedSub = sub.sectionId;
        });
        const text = document.createElement("span");
        const badge = methodBadge(sub.method, true);
        text.append(badge, document.createTextNode(` ${sub.sectionId} · ${meetingSummary(sub) || "TBA"}`));
        opt.append(radio, text);
        controls.appendChild(opt);
      });
    }

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "add-btn";
    const key = groupKey(course.ModuleID, family.letter);
    addBtn.dataset.key = key;
    const isAdded = schedule.has(key);
    addBtn.textContent = isAdded ? "✓ Added" : "＋ Add";
    if (isAdded) addBtn.classList.add("added");
    addBtn.addEventListener("click", () => addFamily(course, family, selectedSub));

    fam.append(lectureLine);
    if (family.subs.length) fam.append(controls);
    fam.append(addBtn);
    host.appendChild(fam);
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
        const families = await loadFamilies(course.ModuleID);
        renderFamilies(detail, course, families);
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
  renderSchedule();
  syncAddButtons();
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

renderSchedule();
setView("list");
