const SERVICE =
  "https://tss.ucsd.edu/sap/opu/odata4/sap/yucsd_con_module_sb/srvd/sap/yucsd_con_module_servicedef/0001";
const ENTITY = "YUCSD_CON_MODULE";
const SELECT =
  "CourseAbbr,CourseTitle,DepartmentAbbr,DepartmentText,CreditsDisplay,AcademicLevel,ModuleID";
const PAGE_SIZE = 50;

class SessionExpiredError extends Error {}
class TssUnavailableError extends Error {}

function buildUrl({ query, year, term }) {
  const filter = `AcYearText eq '${year}' and AcademicPeriodText eq '${term}'`;
  const params = [
    "sap-client=500",
    `$select=${SELECT}`,
    `$filter=${encodeURIComponent(filter)}`,
    `$top=${PAGE_SIZE}`,
  ];
  const q = query.trim();
  if (q) params.push(`$search=${encodeURIComponent(`"${q}"`)}`);
  return `${SERVICE}/${ENTITY}?${params.join("&")}`;
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

async function searchCourses(opts) {
  const { status, body } = await sendToBackground({
    type: "tssFetch",
    url: buildUrl(opts),
  });
  if (status === 401 || isLoginRedirect(body || "")) throw new SessionExpiredError();
  if (status === 0) throw new TssUnavailableError(body || "no network response");
  if (status >= 500) throw new TssUnavailableError(`TSS returned ${status}`);
  if (status < 200 || status >= 300) throw new Error(`TSS returned ${status}`);
  const data = JSON.parse(body);
  return { rows: data.value ?? [] };
}

const els = {
  form: document.getElementById("search-form"),
  query: document.getElementById("query"),
  year: document.getElementById("year"),
  term: document.getElementById("term"),
  status: document.getElementById("status"),
  table: document.getElementById("results"),
  tbody: document.querySelector("#results tbody"),
  banner: document.getElementById("login-banner"),
  loginBtn: document.getElementById("login-btn"),
};

function setStatus(text) {
  els.status.textContent = text;
}

function showBanner(show) {
  els.banner.hidden = !show;
}

function renderRows(rows) {
  els.tbody.replaceChildren();
  for (const r of rows) {
    const tr = document.createElement("tr");
    const cells = [
      r.CourseAbbr,
      r.CourseTitle,
      r.DepartmentAbbr,
      r.CreditsDisplay,
      r.AcademicLevel,
    ];
    for (const value of cells) {
      const td = document.createElement("td");
      td.textContent = value ?? "";
      tr.appendChild(td);
    }
    els.tbody.appendChild(tr);
  }
  els.table.hidden = rows.length === 0;
}

async function runSearch() {
  showBanner(false);
  setStatus("Searching…");
  els.table.hidden = true;
  try {
    const { rows } = await searchCourses({
      query: els.query.value,
      year: els.year.value,
      term: els.term.value,
    });
    renderRows(rows);
    if (rows.length === 0) {
      setStatus("No courses found.");
    } else if (rows.length === PAGE_SIZE) {
      setStatus(`Showing the first ${PAGE_SIZE} — refine your search to narrow it down.`);
    } else {
      setStatus(`Showing ${rows.length} course${rows.length === 1 ? "" : "s"}.`);
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
