// TRIPLE S staff dashboard: lists form submissions with their CVs.
// Supabase enforces access (supabase/admin.sql): only signed-in @triple-s.me
// accounts can read or delete anything, whatever this page does.
// Everything shown here was typed by the public, so it is only ever inserted
// as text (see el()), never as HTML.

const FAILED_CV_PREFIX = "UPLOAD FAILED: ";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const $ = (id) => document.getElementById(id);
const views = ["loading", "login", "denied", "dashboard"];
const filters = ["search", "school", "interest", "experience", "cv", "contact"].reduce(
  (all, name) => ({ ...all, [name]: $(`filter-${name}`) }),
  {}
);
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
// Availability dates are plain calendar dates ("2027-06-01"); format them in UTC
// so they don't shift a day in other time zones.
const calendarDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });

let db;
let currentUserId;
let submissions = [];
let openRow;

// --- helpers ---------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.flat().filter((child) => child != null && child !== false));
  return node;
}

function show(view) {
  for (const name of views) $(`view-${name}`).hidden = name !== view;
  $("account").hidden = !["denied", "dashboard"].includes(view);
}

function setStatus(message, isError = false) {
  $("status").textContent = message;
  $("status").classList.toggle("is-error", isError);
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.textContent = label;
}

const hasStoredCv = (path) => Boolean(path) && !path.startsWith(FAILED_CV_PREFIX);
const areaName = (interest) => interest.slice(interest.indexOf(":") + 1).trim();
const fileName = (path) => path.slice(path.lastIndexOf("/") + 1);

// Only real web links become clickable; anything else (e.g. "javascript:") is shown as text.
function safeWebUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

// --- auth ------------------------------------------------------------------

async function handleSession(session) {
  if (!session) {
    clearData();
    show("login");
    return;
  }
  $("account-email").textContent = session.user.email;
  const { data: isStaff, error } = await db.rpc("is_staff");
  if (error) console.error(error);
  if (!isStaff) {
    clearData();
    $("denied-detail").textContent = error
      ? `Access couldn’t be checked (${error.message}). Make sure supabase/admin.sql has been run.`
      : "This account can’t view submissions. Sign in with an @triple-s.me email address.";
    show("denied");
    return;
  }
  show("dashboard");
  await loadSubmissions();
}

function clearData() {
  submissions = [];
  $("rows").replaceChildren();
  if ($("detail").open) $("detail").close();
}

async function signIn(event) {
  event.preventDefault();
  const email = $("login-email").value.trim();
  const password = $("login-password").value;
  const errorEl = $("login-error");
  errorEl.textContent = "";
  if (!email || !password) {
    errorEl.textContent = "Enter your email and password.";
    return;
  }
  setBusy($("login-submit"), true, "Signing in…");
  const { error } = await db.auth.signInWithPassword({ email, password });
  setBusy($("login-submit"), false, "Sign in");
  if (error) {
    errorEl.textContent = /invalid login credentials/i.test(error.message)
      ? "That email and password don’t match an account."
      : error.message;
    return;
  }
  $("login-password").value = "";
}

// --- data ------------------------------------------------------------------

async function loadSubmissions() {
  setStatus("Loading submissions…");
  $("refresh").disabled = true;
  const { data, error } = await db
    .from(SUBMISSIONS_TABLE)
    .select("*")
    .order("submitted_at", { ascending: false })
    .limit(1000);
  $("refresh").disabled = false;
  if (error) {
    setStatus(`Couldn’t load submissions: ${error.message}`, true);
    return;
  }
  submissions = data;
  setStatus("");
  fillInterestFilter();
  render();
}

async function deleteSubmission(row) {
  const what = hasStoredCv(row.cv_path) ? "submission and CV" : "submission";
  if (!confirm(`Delete ${row.full_name}’s ${what}? This can’t be undone.`)) return;
  const button = $("detail-delete");
  setBusy(button, true, "Deleting…");
  try {
    if (hasStoredCv(row.cv_path)) {
      const { error } = await db.storage.from(CV_BUCKET).remove([row.cv_path]);
      if (error) throw error;
    }
    const { error, count } = await db.from(SUBMISSIONS_TABLE).delete({ count: "exact" }).eq("id", row.id);
    if (error) throw error;
    if (count === 0) throw new Error("Nothing was deleted. This account may not have permission.");
    submissions = submissions.filter((item) => item.id !== row.id);
    $("detail").close();
    fillInterestFilter();
    render();
  } catch (error) {
    console.error(error);
    alert(`Couldn’t delete: ${error.message}`);
  } finally {
    setBusy(button, false, "Delete submission");
  }
}

// --- rendering -------------------------------------------------------------

function matches(row) {
  const query = filters.search.value.trim().toLowerCase();
  if (query && ![row.full_name, row.email, row.mobile, row.major].some((text) => text?.toLowerCase().includes(query))) {
    return false;
  }
  if (filters.school.value && row.school !== filters.school.value) return false;
  if (filters.interest.value && !row.interests.includes(filters.interest.value)) return false;
  if (filters.experience.value && !row.experience_types.includes(filters.experience.value)) return false;
  if (filters.cv.value && hasStoredCv(row.cv_path) !== (filters.cv.value === "yes")) return false;
  if (filters.contact.value && row.contact_consent !== (filters.contact.value === "yes")) return false;
  return true;
}

// Interest options come from the data, grouped by school ("Business: Marketing").
function fillInterestFilter() {
  const select = filters.interest;
  const chosen = select.value;
  const groups = new Map();
  for (const interest of new Set(submissions.flatMap((row) => row.interests))) {
    const school = interest.includes(":") ? interest.slice(0, interest.indexOf(":")) : "Other";
    groups.set(school, [...(groups.get(school) ?? []), interest]);
  }
  const optgroups = [...groups.keys()].sort().map((school) =>
    el("optgroup", { label: school }, groups.get(school).sort().map((interest) => el("option", { value: interest }, areaName(interest))))
  );
  select.replaceChildren(el("option", { value: "" }, "Interest: any"), ...optgroups);
  select.value = groups.size && [...select.options].some((option) => option.value === chosen) ? chosen : "";
}

function render() {
  const rows = submissions.filter(matches);
  const total = submissions.length;
  const weekAgo = Date.now() - WEEK_MS;
  $("stat-total").textContent = total;
  $("stat-week").textContent = submissions.filter((row) => new Date(row.submitted_at) >= weekAgo).length;
  $("stat-cv").textContent = submissions.filter((row) => hasStoredCv(row.cv_path)).length;
  $("stat-contact").textContent = submissions.filter((row) => row.contact_consent).length;

  $("result-count").textContent =
    rows.length === total ? `${total} submission${total === 1 ? "" : "s"}` : `Showing ${rows.length} of ${total} submissions`;
  $("empty").hidden = rows.length > 0;
  $("empty").textContent = total
    ? "No submissions match these filters."
    : "No submissions yet. They’ll appear here as students fill in the form.";
  $("rows").replaceChildren(...rows.map(renderRow));
}

function chips(values, limit = Infinity) {
  if (!values.length) return el("span", { class: "muted" }, "—");
  const shown = values.slice(0, limit);
  return el(
    "div",
    { class: "chips" },
    shown.map((value) => el("span", { class: "chip", title: value }, areaName(value))),
    values.length > limit && el("span", { class: "chip chip--more" }, `+${values.length - limit}`)
  );
}

function documents(row) {
  const items = [];
  if (hasStoredCv(row.cv_path)) {
    // Opens preview.html in a new tab; the path goes after # so it stays out of server logs.
    const href = `preview.html#${encodeURIComponent(row.cv_path)}`;
    items.push(el("a", { class: "doc-link", href, target: "_blank", title: fileName(row.cv_path) }, "View CV"));
  } else if (row.cv_path) {
    items.push(el("span", { class: "tag-warn", title: row.cv_path }, "CV upload failed"));
  }
  const link = safeWebUrl(row.profile_link);
  if (link) items.push(el("a", { class: "doc-link", href: link, target: "_blank", rel: "noopener noreferrer" }, linkLabel(link)));
  return items.length ? el("div", { class: "docs" }, items) : el("span", { class: "muted" }, "—");
}

const linkLabel = (url) => (new URL(url).hostname.includes("linkedin.") ? "LinkedIn" : "Profile link");

function renderRow(row) {
  const submitted = new Date(row.submitted_at);
  return el(
    "tr",
    { onclick: (event) => !event.target.closest("a, button") && openDetail(row) },
    el(
      "td",
      { class: "cell-student" },
      el("button", { type: "button", class: "student-button", onclick: () => openDetail(row) }, row.full_name),
      el("span", { class: "sub" }, row.email)
    ),
    el("td", { "data-label": "School" }, row.school),
    el("td", { "data-label": "Program" }, el("span", {}, row.major), el("span", { class: "sub" }, row.year_of_study)),
    el("td", { "data-label": "Interests" }, chips(row.interests, 3)),
    el("td", { "data-label": "Experience" }, row.experience_types.length ? row.experience_types.join(", ") : el("span", { class: "muted" }, "—")),
    el("td", { "data-label": "Documents" }, documents(row)),
    el("td", { "data-label": "Submitted", title: dateTime.format(submitted) }, dateOnly.format(submitted))
  );
}

function openDetail(row) {
  openRow = row;
  $("detail-name").textContent = row.full_name;
  $("detail-meta").textContent = `Submitted ${dateTime.format(new Date(row.submitted_at))}`;

  const phone = row.mobile.replace(/[^\d+]/g, "");
  const availability = [
    row.available_from && `From ${calendarDate.format(new Date(row.available_from))}`,
    row.available_until && `until ${calendarDate.format(new Date(row.available_until))}`,
  ].filter(Boolean).join(" ");
  const fields = [
    ["Email", /^[^\s@]+@[^\s@]+$/.test(row.email) ? el("a", { href: `mailto:${row.email}` }, row.email) : row.email],
    ["Mobile", phone ? el("a", { href: `tel:${phone}` }, row.mobile) : row.mobile],
    ["School", row.school],
    ["Major or program", row.major],
    ["Year of study", row.year_of_study],
    ["Interest areas", chips(row.interests)],
    ["Experience types", row.experience_types.join(", ") || null],
    ["Skills and experience", row.skills && el("span", { class: "pre" }, row.skills)],
    ["Availability", [availability, row.availability_notes].filter(Boolean).join(" · ") || null],
    ["Documents", documents(row)],
    ["Open to contact", row.contact_consent ? "Yes" : "No"],
  ];
  $("detail-fields").replaceChildren(
    ...fields.flatMap(([label, value]) => [el("dt", {}, label), el("dd", {}, value ?? el("span", { class: "muted" }, "—"))])
  );
  $("detail").showModal();
}

// --- CSV export --------------------------------------------------------------

function exportCsv() {
  const columns = [
    ["Submitted", (row) => dateTime.format(new Date(row.submitted_at))],
    ["Full name", (row) => row.full_name],
    ["Email", (row) => row.email],
    ["Mobile", (row) => row.mobile],
    ["School", (row) => row.school],
    ["Major or program", (row) => row.major],
    ["Year of study", (row) => row.year_of_study],
    ["Interest areas", (row) => row.interests.join("; ")],
    ["Experience types", (row) => row.experience_types.join("; ")],
    ["Skills and experience", (row) => row.skills],
    ["Available from", (row) => row.available_from],
    ["Available until", (row) => row.available_until],
    ["Availability notes", (row) => row.availability_notes],
    ["Profile link", (row) => row.profile_link],
    ["CV file", (row) => row.cv_path],
    ["Open to contact", (row) => (row.contact_consent ? "Yes" : "No")],
  ];
  const cell = (value) => {
    let text = value == null ? "" : String(value);
    // Stop spreadsheet apps from running a value as a formula.
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const lines = [columns.map(([header]) => cell(header))];
  for (const row of submissions.filter(matches)) lines.push(columns.map(([, get]) => cell(get(row))));
  const csv = "﻿" + lines.map((line) => line.join(",")).join("\r\n");
  const link = el("a", {
    href: URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })),
    download: `triple-s-submissions-${new Date().toISOString().slice(0, 10)}.csv`,
  });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// --- wiring ------------------------------------------------------------------

if (!window.supabase || !SUPABASE_URL) {
  $("view-loading").textContent = "The dashboard couldn’t load. Check your connection and refresh the page.";
} else {
  db = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

  db.auth.onAuthStateChange((event, session) => {
    const userId = session?.user.id ?? null;
    if (event !== "INITIAL_SESSION" && userId === currentUserId) return; // e.g. hourly token refresh
    currentUserId = userId;
    // Supabase advises not awaiting its own calls inside this callback.
    setTimeout(() => handleSession(session), 0);
  });

  $("login-form").addEventListener("submit", signIn);
  $("refresh").addEventListener("click", loadSubmissions);
  $("export").addEventListener("click", exportCsv);
  $("detail-delete").addEventListener("click", () => openRow && deleteSubmission(openRow));
  for (const input of Object.values(filters)) input.addEventListener("input", render);
  document.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "sign-out") db.auth.signOut();
    if (action === "close-detail") $("detail").close();
  });
  // Clicking the dimmed backdrop closes the detail panel.
  $("detail").addEventListener("click", (event) => event.target === $("detail") && $("detail").close());
}
