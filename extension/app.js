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
  "#2563eb", "#16a34a", "#db2777", "#d97706",
  "#7c3aed", "#0891b2", "#dc2626", "#4d7c0f",
];

class SessionExpiredError extends Error {}
class TssUnavailableError extends Error {}

const calendar = new Map();
const courseColor = new Map();

function colorFor(code) {
  if (!courseColor.has(code)) {
    courseColor.set(code, COURSE_COLORS[courseColor.size % COURSE_COLORS.length]);
  }
  return courseColor.get(code);
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

async function fetchOData(url) {
  const { status, body } = await sendToBackground({ type: "tssFetch", url });
  if (status === 401 || isLoginRedirect(body || "")) throw new SessionExpiredError();
  if (status === 0) throw new TssUnavailableError(body || "no network response");
  if (status >= 500) throw new TssUnavailableError(`TSS returned ${status}`);
  if (status < 200 || status >= 300) throw new Error(`TSS returned ${status}`);
  return JSON.parse(body).value ?? [];
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
    if (!bySection.has(id)) bySection.set(id, { sectionId: id, meetings: [] });
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

async function loadSections(moduleId) {
  const [schedRows, instrRows] = await Promise.all([
    fetchOData(buildByModuleUrl(SCHED_ENTITY, moduleId)),
    fetchOData(buildByModuleUrl(INSTR_ENTITY, moduleId)),
  ]);
  return groupSections(schedRows, instrRows.map((r) => r.InstructorName).filter(Boolean));
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
};

function setStatus(text) {
  els.status.textContent = text;
}

function showBanner(show) {
  els.banner.hidden = !show;
}

function placedBlocks() {
  const perDay = DAYS.map(() => []);
  const unplaced = [];
  for (const item of calendar.values()) {
    for (const meeting of item.meetings) {
      if (meeting.startMin === null || meeting.endMin === null || meeting.dayIndices.length === 0) {
        unplaced.push(`${item.label} (${meeting.daysText || "TBA"} ${meeting.timeLabel})`);
        continue;
      }
      for (const dayIdx of meeting.dayIndices) {
        if (dayIdx >= DAYS.length) {
          unplaced.push(`${item.label} (${meeting.daysText})`);
          continue;
        }
        perDay[dayIdx].push({ item, startMin: meeting.startMin, endMin: meeting.endMin, timeLabel: meeting.timeLabel });
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
  perDay.forEach((blocks, dayIdx) => {
    const col = document.createElement("div");
    col.className = "cal-daycol";
    col.style.height = `${GRID_HEIGHT}px`;
    for (const block of blocks) {
      const el = document.createElement("div");
      el.className = "cal-block" + (block.conflict ? " conflict" : "");
      el.style.top = `${(block.startMin - DAY_START_MIN) * PX_PER_MIN}px`;
      el.style.height = `${(block.endMin - block.startMin) * PX_PER_MIN}px`;
      el.style.background = block.item.color;
      el.innerHTML = `<strong>${block.item.label}</strong><span>${block.timeLabel}</span>`;
      col.appendChild(el);
    }
    els.calendar.appendChild(col);
    void dayIdx;
  });

  els.calNote.textContent =
    calendar.size === 0
      ? "Add sections from the results below to see them here."
      : unplaced.length
        ? `Not shown (weekend or no time): ${unplaced.join("; ")}`
        : "";
}

function sectionKey(moduleId, sectionId) {
  return `${moduleId}:${sectionId}`;
}

function toggleSection(course, section, btn) {
  const key = sectionKey(course.ModuleID, section.sectionId);
  if (calendar.has(key)) {
    calendar.delete(key);
    btn.textContent = "＋ Add";
    btn.classList.remove("added");
  } else {
    calendar.set(key, {
      key,
      label: `${course.CourseAbbr ?? ""} ${section.sectionId}`.trim(),
      color: colorFor(course.CourseAbbr ?? key),
      meetings: section.meetings,
    });
    btn.textContent = "✓ Added";
    btn.classList.add("added");
  }
  renderCalendar();
}

function renderSections(host, course, sections) {
  host.replaceChildren();
  if (sections.length === 0) {
    host.textContent = "No sections listed.";
    return;
  }
  const table = document.createElement("table");
  table.className = "sections";
  table.innerHTML =
    "<thead><tr><th></th><th>Section</th><th>Days</th><th>Time</th><th>Instructor</th></tr></thead>";
  const tbody = document.createElement("tbody");
  for (const s of sections) {
    const meetings = s.meetings.length ? s.meetings : [{ daysText: "", timeLabel: "TBA" }];
    meetings.forEach((meeting, i) => {
      const tr = document.createElement("tr");

      const addCell = document.createElement("td");
      if (i === 0) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "add-btn";
        const key = sectionKey(course.ModuleID, s.sectionId);
        const isAdded = calendar.has(key);
        btn.textContent = isAdded ? "✓ Added" : "＋ Add";
        if (isAdded) btn.classList.add("added");
        btn.addEventListener("click", () => toggleSection(course, s, btn));
        addCell.appendChild(btn);
      }
      tr.appendChild(addCell);

      const cells = [
        i === 0 ? s.sectionId : "",
        meeting.daysText,
        meeting.timeLabel,
        i === 0 ? s.instructors : "",
      ];
      for (const value of cells) {
        const td = document.createElement("td");
        td.textContent = value;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

function renderCourses(courses) {
  els.results.replaceChildren();
  for (const course of courses) {
    const block = document.createElement("section");
    block.className = "course";

    const headerBtn = document.createElement("button");
    headerBtn.className = "course-header";
    headerBtn.type = "button";
    headerBtn.innerHTML = `
      <span class="caret">▸</span>
      <span class="course-code">${course.CourseAbbr ?? ""}</span>
      <span class="course-title">${course.CourseTitle ?? ""}</span>
      <span class="course-units">${course.CreditsDisplay ?? ""} units</span>`;

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
        const sections = await loadSections(course.ModuleID);
        renderSections(detail, course, sections);
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
  calendar.clear();
  renderCalendar();
  document.querySelectorAll(".add-btn.added").forEach((b) => {
    b.textContent = "＋ Add";
    b.classList.remove("added");
  });
});

renderCalendar();
