const SERVICE =
  "https://tss.ucsd.edu/sap/opu/odata4/sap/yucsd_con_module_sb/srvd/sap/yucsd_con_module_servicedef/0001";
const COURSE_ENTITY = "YUCSD_CON_MODULE";
const SCHED_ENTITY = "YUCSD_CON_MODULE_SCHED";
const INSTR_ENTITY = "YUCSD_CON_MODULE_INSTR";
const COURSE_SELECT =
  "CourseAbbr,CourseTitle,DepartmentAbbr,DepartmentText,CreditsDisplay,AcademicLevel,ModuleID,AcademicYear,AcademicPeriod";
const PAGE_SIZE = 50;

class SessionExpiredError extends Error {}
class TssUnavailableError extends Error {}

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

function formatTime(value) {
  if (!value) return "";
  const [h, m] = value.split(":");
  const hour = Number(h);
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${m} ${suffix}`;
}

function groupSections(schedRows, instructorNames) {
  const bySection = new Map();
  for (const row of schedRows) {
    const id = row.SectionId || "—";
    if (!bySection.has(id)) bySection.set(id, { sectionId: id, meetings: [] });
    bySection.get(id).meetings.push({
      days: row.DoWText || "",
      time:
        row.BeginTime && row.EndTime
          ? `${formatTime(row.BeginTime)}–${formatTime(row.EndTime)}`
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
};

function setStatus(text) {
  els.status.textContent = text;
}

function showBanner(show) {
  els.banner.hidden = !show;
}

function renderSections(host, sections) {
  host.replaceChildren();
  if (sections.length === 0) {
    host.textContent = "No sections listed.";
    return;
  }
  const table = document.createElement("table");
  table.className = "sections";
  table.innerHTML =
    "<thead><tr><th>Section</th><th>Days</th><th>Time</th><th>Instructor</th></tr></thead>";
  const tbody = document.createElement("tbody");
  for (const s of sections) {
    const meetings = s.meetings.length ? s.meetings : [{ days: "", time: "TBA" }];
    meetings.forEach((meeting, i) => {
      const tr = document.createElement("tr");
      const cells = [
        i === 0 ? s.sectionId : "",
        meeting.days,
        meeting.time,
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
        renderSections(detail, sections);
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
