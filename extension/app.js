const SERVICE =
  "https://tss.ucsd.edu/sap/opu/odata4/sap/yucsd_con_module_sb/srvd/sap/yucsd_con_module_servicedef/0001";
const ENTITY = "YUCSD_CON_MODULE";
const SELECT =
  "CourseAbbr,CourseTitle,DepartmentAbbr,DepartmentText,CreditsDisplay,AcademicLevel,ModuleID";
const PAGE_SIZE = 50;

class SessionExpiredError extends Error {}

function buildUrl({ query, year, term }) {
  const filter = `AcYearText eq '${year}' and AcademicPeriodText eq '${term}'`;
  const params = [
    "sap-client=500",
    "$count=true",
    `$select=${SELECT}`,
    `$filter=${encodeURIComponent(filter)}`,
    `$top=${PAGE_SIZE}`,
    "$skip=0",
  ];
  const q = query.trim();
  if (q) params.push(`$search=${encodeURIComponent(`"${q}"`)}`);
  return `${SERVICE}/${ENTITY}?${params.join("&")}`;
}

function looksLikeLogin(status, body) {
  return (
    status === 403 ||
    /^\s*<(?:!doctype|html)/i.test(body) ||
    body.includes("SAMLRequest")
  );
}

async function searchCourses(opts) {
  const res = await fetch(buildUrl(opts), {
    headers: { Accept: "application/json" },
    credentials: "include",
  });
  const body = await res.text();
  if (looksLikeLogin(res.status, body)) throw new SessionExpiredError();
  if (!res.ok) throw new Error(`TSS returned ${res.status}`);
  const data = JSON.parse(body);
  return { total: data["@odata.count"] ?? 0, rows: data.value ?? [] };
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
  const opts = {
    query: els.query.value,
    year: els.year.value,
    term: els.term.value,
  };
  showBanner(false);
  setStatus("Searching…");
  els.table.hidden = true;
  try {
    const { total, rows } = await searchCourses(opts);
    renderRows(rows);
    const shown = Math.min(rows.length, PAGE_SIZE);
    setStatus(
      total === 0
        ? "No courses found."
        : `Showing ${shown} of ${total} course${total === 1 ? "" : "s"}.`,
    );
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      setStatus("");
      showBanner(true);
      return;
    }
    setStatus(`Couldn't reach TSS: ${err.message}`);
  }
}

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  runSearch();
});

els.loginBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://tss.ucsd.edu/fiori" });
});
