// TRIPLE S staff dashboard: analytics and the list of form submissions.
// Supabase enforces access (supabase/admin.sql): only signed-in @triple-s.me
// accounts can read or delete anything, whatever this page does.
// Everything shown here was typed by the public, so it is only ever inserted
// as text (see el() and svg()), never as HTML.

const FAILED_CV_PREFIX = "UPLOAD FAILED: ";
const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 50;
const TOP_BARS = 8;
const MIN_PASSWORD = 8;
const YEARS = ["Year 1", "Year 2", "Year 3", "Year 4", "Year 5 or above", "Master’s / postgraduate"];
const UNIVERSITY_NAMES = new Map(UNIVERSITIES);
const SVG_NS = "http://www.w3.org/2000/svg";

const $ = (id) => document.getElementById(id);
const views = ["loading", "login", "forgot", "recovery", "denied", "dashboard"];
const filters = Object.fromEntries(
  ["period", "university", "school", "interest", "experience", "cv", "contact"].map((name) => [name, $(`filter-${name}`)])
);
const tooltip = $("tooltip");
const number = new Intl.NumberFormat();
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const timeOnly = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
// Availability dates are plain calendar dates ("2027-06-01"); format them in UTC
// so they don't shift a day in other time zones.
const calendarDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });

// A password-reset email link lands here with "#...type=recovery" (or an error) in the address.
const linkParams = new URLSearchParams(location.hash.slice(1));
let recoveryMode = linkParams.get("type") === "recovery";
const linkError = linkParams.get("error_description");

let db;
let currentUserId;
let submissions = [];
let currentRows = []; // submissions after the filter bar
let visibleCount = PAGE_SIZE;
let openRow;

// --- helpers ---------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  setAttributes(node, attrs);
  node.append(...children.flat().filter((child) => child != null && child !== false));
  return node;
}

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  setAttributes(node, attrs);
  node.append(...children);
  return node;
}

function setAttributes(node, attrs) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.setAttribute("class", value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
}

function show(view) {
  for (const name of views) $(`view-${name}`).hidden = name !== view;
  $("account").hidden = !["denied", "dashboard"].includes(view);
  hideTooltip();
}

function setStatus(message, isError = false) {
  $("status").textContent = message;
  $("status").classList.toggle("is-error", isError);
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.textContent = label;
}

const plural = (count, word) => `${number.format(count)} ${word}${count === 1 ? "" : "s"}`;
const percent = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
const hasStoredCv = (path) => Boolean(path) && !path.startsWith(FAILED_CV_PREFIX);
const areaName = (interest) => interest.slice(interest.indexOf(":") + 1).trim();
const fileName = (path) => path.slice(path.lastIndexOf("/") + 1);
const universityTitle = (code) => (UNIVERSITY_NAMES.has(code) ? `${code} – ${UNIVERSITY_NAMES.get(code)}` : code);

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
  setAccount(session.user.email);
  if (recoveryMode) {
    show("recovery");
    return;
  }
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
  currentUserEmail = session.user.email;
  // "Manage team" only for admins (the server checks again on every change).
  db.rpc("is_admin").then(({ data }) => {
    $("menu-team").hidden = data !== true;
  });
  await loadSubmissions();
}

function setAccount(email) {
  $("account-email").textContent = email;
  $("account-email-menu").textContent = `Signed in as ${email}`;
  $("account-initial").textContent = email.charAt(0);
}

function clearData() {
  submissions = [];
  currentRows = [];
  $("menu-team").hidden = true;
  $("rows").replaceChildren();
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
}

async function signIn(event) {
  event.preventDefault();
  const email = $("login-email").value.trim();
  const password = $("login-password").value;
  const errorEl = $("login-error");
  errorEl.textContent = "";
  $("login-notice").hidden = true;
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

async function sendResetLink(event) {
  event.preventDefault();
  const email = $("forgot-email").value.trim();
  $("forgot-error").textContent = "";
  $("forgot-done").hidden = true;
  if (!email) {
    $("forgot-error").textContent = "Enter your email address.";
    return;
  }
  setBusy($("forgot-submit"), true, "Sending…");
  const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  setBusy($("forgot-submit"), false, "Send reset link");
  if (error) {
    console.error(error);
    $("forgot-error").textContent = /rate limit/i.test(error.message)
      ? "Too many reset emails were sent recently. Please try again in an hour."
      : /not authorized/i.test(error.message)
        ? "Reset emails aren’t set up for this address yet. Ask the project owner to reset your password."
        : error.message;
    return;
  }
  $("forgot-done").textContent = `If ${email} has an account, a reset link is on its way. It can take a few minutes, so check your spam folder too.`;
  $("forgot-done").hidden = false;
}

// Shared by "Choose a new password" (after a reset link) and "Change password".
async function savePassword(form) {
  const errorEl = form.querySelector(".field-error");
  const button = form.querySelector('button[type="submit"]');
  const password = form.elements.password.value;
  errorEl.textContent =
    password.length < MIN_PASSWORD
      ? `Use at least ${MIN_PASSWORD} characters.`
      : password !== form.elements.confirm.value
        ? "The two passwords don’t match."
        : "";
  if (errorEl.textContent) return false;
  setBusy(button, true, "Saving…");
  const { error } = await db.auth.updateUser({ password });
  setBusy(button, false, "Save password");
  if (error) {
    console.error(error);
    errorEl.textContent = /different from the old/i.test(error.message)
      ? "Choose a password you haven’t used for this account."
      : /reauthenticat/i.test(error.message)
        ? "For security, sign out, sign in again, then change your password."
        : error.message;
    return false;
  }
  form.reset();
  return true;
}

// --- data ------------------------------------------------------------------

async function loadSubmissions() {
  $("dashboard-body").classList.add("is-loading");
  if (!submissions.length) setStatus("Loading submissions…");
  $("refresh").disabled = true;
  const { data, error } = await db
    .from(SUBMISSIONS_TABLE)
    .select("*")
    .order("submitted_at", { ascending: false })
    .limit(1000);
  $("refresh").disabled = false;
  $("dashboard-body").classList.remove("is-loading");
  if (error) {
    setStatus(`Couldn’t load submissions: ${error.message}`, true);
    return;
  }
  submissions = data;
  $("updated-at").textContent = `Updated at ${timeOnly.format(new Date())}`;
  setStatus("");
  fillFilterOptions();
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
    fillFilterOptions();
    render();
  } catch (error) {
    console.error(error);
    alert(`Couldn’t delete: ${error.message}`);
  } finally {
    setBusy(button, false, "Delete submission");
  }
}

// --- filters ---------------------------------------------------------------

function matchesFilters(row) {
  const f = Object.fromEntries(Object.entries(filters).map(([name, select]) => [name, select.value]));
  if (f.university && row.university !== f.university) return false;
  if (f.school && row.school !== f.school) return false;
  if (f.interest && !row.interests.includes(f.interest)) return false;
  if (f.experience && !row.experience_types.includes(f.experience)) return false;
  if (f.cv && hasStoredCv(row.cv_path) !== (f.cv === "yes")) return false;
  if (f.contact && row.contact_consent !== (f.contact === "yes")) return false;
  return true;
}

// periodsAgo 0 = the selected period up to now, 1 = the one before it.
function inPeriod(row, days, periodsAgo = 0) {
  const age = Date.now() - new Date(row.submitted_at).getTime();
  return age >= periodsAgo * days * DAY_MS && age < (periodsAgo + 1) * days * DAY_MS;
}

function applyFilters() {
  const days = Number(filters.period.value);
  return submissions.filter((row) => matchesFilters(row) && (!days || inPeriod(row, days)));
}

const activeFilterCount = () => Object.values(filters).filter((select) => select.value).length;

function setFilter(name, value) {
  filters[name].value = value;
  visibleCount = PAGE_SIZE;
  render();
}

function clearFilters() {
  for (const select of Object.values(filters)) select.value = "";
  visibleCount = PAGE_SIZE;
  render();
}

// University and interest options come from the data, so new values show up by themselves.
function fillFilterOptions() {
  const universities = [...new Set(submissions.map((row) => row.university).filter(Boolean))].sort();
  replaceOptions(filters.university, universities.map((code) => el("option", { value: code }, universityTitle(code))));

  const groups = new Map();
  for (const interest of new Set(submissions.flatMap((row) => row.interests))) {
    const school = interest.includes(":") ? interest.slice(0, interest.indexOf(":")) : "Other";
    groups.set(school, [...(groups.get(school) ?? []), interest]);
  }
  replaceOptions(
    filters.interest,
    [...groups.keys()].sort().map((school) =>
      el("optgroup", { label: school }, groups.get(school).sort().map((interest) => el("option", { value: interest }, areaName(interest))))
    )
  );
}

function replaceOptions(select, options) {
  const chosen = select.value;
  select.replaceChildren(el("option", { value: "" }, "All"), ...options);
  select.value = [...select.options].some((option) => option.value === chosen) ? chosen : "";
}

// --- rendering -------------------------------------------------------------

function render() {
  currentRows = applyFilters();
  const active = activeFilterCount();
  $("filter-summary").textContent = active
    ? `Showing ${number.format(currentRows.length)} of ${plural(submissions.length, "submission")}`
    : `All ${plural(submissions.length, "submission")}`;
  $("clear-filters").hidden = !active;
  $("toggle-filters").textContent = active ? `Filters (${active})` : "Filters";
  renderKpis(currentRows);
  renderTimeline(currentRows);
  renderCharts(currentRows);
  renderTable();
}

function renderKpis(rows) {
  const total = rows.length;
  const days = Number(filters.period.value);
  $("kpi-total").textContent = number.format(total);
  const totalSub = $("kpi-total-sub");
  if (days) {
    const previous = submissions.filter((row) => matchesFilters(row) && inPeriod(row, days, 1)).length;
    const change = total - previous;
    totalSub.replaceChildren(
      change === 0
        ? "Same as the previous "
        : el("span", { class: change > 0 ? "delta-up" : "delta-down" }, `${change > 0 ? "▲" : "▼"} ${number.format(Math.abs(change))}`),
      change === 0 ? `${days} days` : ` vs previous ${days} days`
    );
  } else {
    const lastWeek = rows.filter((row) => inPeriod(row, 7)).length;
    totalSub.textContent = `${number.format(lastWeek)} in the last 7 days`;
  }

  const withCv = rows.filter((row) => hasStoredCv(row.cv_path)).length;
  const failed = rows.filter((row) => row.cv_path && !hasStoredCv(row.cv_path)).length;
  $("kpi-cv").textContent = number.format(withCv);
  $("kpi-cv-sub").textContent = `${percent(withCv, total)}% of submissions${failed ? ` · ${failed} failed upload${failed === 1 ? "" : "s"}` : ""}`;

  const open = rows.filter((row) => row.contact_consent).length;
  $("kpi-contact").textContent = number.format(open);
  $("kpi-contact-sub").textContent = `${percent(open, total)}% said yes`;

  const universities = countBy(rows, (row) => row.university);
  const [top] = [...universities].sort((a, b) => b[1] - a[1]);
  $("kpi-universities").textContent = number.format(universities.size);
  $("kpi-universities-sub").textContent = top ? `Most from ${top[0]} (${number.format(top[1])})` : "No universities yet";
}

function countBy(rows, getKeys) {
  const counts = new Map();
  for (const row of rows) {
    for (const key of [].concat(getKeys(row) ?? [])) if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function renderCharts(rows) {
  const total = rows.length;
  renderBars($("chart-university"), countBy(rows, (row) => row.university), {
    total, filter: "university", title: universityTitle, otherLabel: "universities",
  });
  renderBars($("chart-interest"), countBy(rows, (row) => row.interests), {
    total, filter: "interest", label: areaName, title: (key) => key, unit: "student", noteUnit: "selection", otherLabel: "areas", top: 10,
  });
  renderBars($("chart-school"), countBy(rows, (row) => row.school), {
    total, filter: "school", order: ["Business", "Sciences", "Engineering"],
  });
  renderBars($("chart-experience"), countBy(rows, (row) => row.experience_types), {
    total, filter: "experience", unit: "student", order: ["Internship", "Part-time opportunity", "Supervised assignment"],
  });
  renderBars($("chart-year"), countBy(rows, (row) => row.year_of_study), { total, order: YEARS });
}

// Horizontal bars, one colour (one series), value at each bar's tip. Bars with a
// matching filter are buttons: clicking one filters the whole dashboard.
function renderBars(container, counts, { total, filter, order, top = TOP_BARS, label = (key) => key, title = label, unit = "submission", noteUnit = unit, otherLabel = "" }) {
  const items = order
    ? order.filter((key) => counts.has(key)).map((key) => ({ key, count: counts.get(key) }))
    : [...counts].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  if (!items.length) {
    container.replaceChildren(el("p", { class: "chart-empty" }, "Nothing to show for these filters yet."));
    return;
  }
  // The long tail is summarised in a note rather than a bar, so it can't dwarf the leaders.
  const rest = order ? [] : items.splice(top);
  const max = Math.max(...items.map((item) => item.count));
  const bars = items.map((item) => {
    const fullName = title(item.key);
    const share = percent(item.count, total);
    const clickable = Boolean(filter);
    const bar = el(
      clickable ? "button" : "div",
      {
        type: clickable ? "button" : null,
        class: `hbar${clickable && filters[filter].value === item.key ? " is-active" : ""}`,
        "aria-label": `${fullName}: ${plural(item.count, unit)}, ${share}%${clickable ? ". Select to filter by this." : ""}`,
        onclick: clickable ? () => setFilter(filter, item.key) : null,
      },
      el("span", { class: "hbar-label" }, label(item.key)),
      el(
        "span",
        { class: "hbar-bar" },
        el("span", { class: "hbar-fill", style: `width: calc((100% - 3.5em) * ${item.count / max})` }),
        el("span", { class: "hbar-value" }, number.format(item.count))
      )
    );
    attachTooltip(bar, () => ({
      value: plural(item.count, unit),
      label: fullName,
      detail: `${share}% of ${plural(total, "submission")}${clickable ? " · click to filter" : ""}`,
    }));
    return bar;
  });
  const restCount = rest.reduce((sum, item) => sum + item.count, 0);
  const note =
    rest.length > 0 &&
    el("p", { class: "chart-note", title: rest.map((item) => `${title(item.key)}: ${item.count}`).join("\n") },
      `+ ${rest.length} more ${otherLabel} (${plural(restCount, noteUnit)})`);
  container.replaceChildren(...[el("div", { class: "hbars" }, bars), note].filter(Boolean));
}

// Submissions per day (7 or 30 days) or per week (90 days or all time).
function timelineBuckets(rows) {
  const days = Number(filters.period.value);
  const weekly = !days || days > 31;
  const startOfDay = (date) => {
    const day = new Date(date);
    day.setHours(0, 0, 0, 0);
    return day;
  };
  const startOfWeek = (date) => {
    const day = startOfDay(date);
    day.setDate(day.getDate() - ((day.getDay() + 6) % 7)); // weeks start on Monday
    return day;
  };
  const bucketStart = weekly ? startOfWeek : startOfDay;
  const latest = bucketStart(new Date());
  let count = weekly ? Math.ceil(days / 7) : days;
  if (!days) {
    const oldest = rows.length ? Math.min(...rows.map((row) => new Date(row.submitted_at).getTime())) : Date.now();
    count = Math.min(26, Math.max(8, Math.round((latest - startOfWeek(oldest)) / (7 * DAY_MS)) + 1));
  }
  const buckets = [];
  for (let i = count - 1; i >= 0; i--) {
    const start = new Date(latest);
    start.setDate(latest.getDate() - i * (weekly ? 7 : 1));
    buckets.push({ start, count: 0 });
  }
  const byStart = new Map(buckets.map((bucket) => [bucket.start.getTime(), bucket]));
  for (const row of rows) {
    const bucket = byStart.get(bucketStart(new Date(row.submitted_at)).getTime());
    if (bucket) bucket.count += 1;
  }
  return { buckets, weekly };
}

// Round the axis top up so the three gridlines (0, half, top) are whole numbers.
function niceMax(max) {
  if (max <= 4) return 4;
  const half = max / 2;
  const magnitude = 10 ** Math.floor(Math.log10(half));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= half);
  return step * 2;
}

// Column with a 4px rounded top, square at the baseline.
function columnPath(x, top, width, height) {
  const r = Math.min(4, width / 2, height);
  const bottom = top + height;
  return `M${x},${bottom}V${top + r}Q${x},${top} ${x + r},${top}H${x + width - r}Q${x + width},${top} ${x + width},${top + r}V${bottom}Z`;
}

function renderTimeline(rows) {
  const container = $("chart-timeline");
  const { buckets, weekly } = timelineBuckets(rows);
  $("timeline-sub").textContent = weekly ? `Per week · last ${buckets.length} weeks` : `Per day · last ${buckets.length} days`;

  const width = Math.max(280, container.clientWidth);
  const height = 220;
  const pad = { top: 24, right: 8, bottom: 28, left: 34 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const max = Math.max(0, ...buckets.map((bucket) => bucket.count));
  const top = niceMax(max);
  const y = (value) => pad.top + plotHeight - (value / top) * plotHeight;
  const band = plotWidth / buckets.length;
  const columnWidth = Math.min(24, Math.max(3, band * 0.62));
  const labelEvery = Math.ceil(buckets.length / Math.max(2, Math.floor(plotWidth / 64)));
  const peak = max > 0 ? buckets.map((bucket) => bucket.count).lastIndexOf(max) : -1;

  const chart = svg("svg", {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: "group",
    "aria-label": `Submissions ${weekly ? "per week" : "per day"}`,
  });
  for (const tick of [0, top / 2, top]) {
    chart.append(
      svg("line", { class: tick === 0 ? "axis-line" : "grid-line", x1: pad.left, x2: width - pad.right, y1: y(tick), y2: y(tick) }),
      svg("text", { class: "tick", x: pad.left - 8, y: y(tick) + 4, "text-anchor": "end" }, number.format(tick))
    );
  }
  buckets.forEach((bucket, i) => {
    const center = pad.left + band * i + band / 2;
    const when = weekly ? `Week of ${dateOnly.format(bucket.start)}` : dateOnly.format(bucket.start);
    // The whole band is the hover/focus target; the column follows it so CSS can highlight it.
    const hit = svg("rect", {
      class: "hit",
      x: pad.left + band * i,
      y: pad.top,
      width: band,
      height: plotHeight,
      tabindex: "0",
      role: "img",
      "aria-label": `${when}: ${plural(bucket.count, "submission")}`,
    });
    attachTooltip(hit, () => ({ value: plural(bucket.count, "submission"), label: when }));
    chart.append(hit);
    if (bucket.count > 0) {
      const columnHeight = (bucket.count / top) * plotHeight;
      chart.append(svg("path", { class: "col", d: columnPath(center - columnWidth / 2, y(bucket.count), columnWidth, columnHeight) }));
    }
    if (i === peak) {
      chart.append(svg("text", { class: "peak", x: center, y: y(bucket.count) - 7, "text-anchor": "middle" }, number.format(bucket.count)));
    }
    if ((buckets.length - 1 - i) % labelEvery === 0) {
      chart.append(svg("text", { class: "tick", x: center, y: height - 8, "text-anchor": "middle" }, shortDate.format(bucket.start)));
    }
  });
  container.replaceChildren(chart);
}

function chips(values, limit = Infinity) {
  if (!values.length) return el("span", { class: "muted" }, "—");
  return el(
    "div",
    { class: "chips" },
    values.slice(0, limit).map((value) => el("span", { class: "chip", title: value }, areaName(value))),
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
  if (link) {
    const label = new URL(link).hostname.includes("linkedin.") ? "LinkedIn" : "Profile link";
    items.push(el("a", { class: "doc-link", href: link, target: "_blank", rel: "noopener noreferrer" }, label));
  }
  return items.length ? el("div", { class: "docs" }, items) : el("span", { class: "muted" }, "—");
}

const sorters = {
  newest: (a, b) => b.submitted_at.localeCompare(a.submitted_at),
  oldest: (a, b) => a.submitted_at.localeCompare(b.submitted_at),
  name: (a, b) => a.full_name.localeCompare(b.full_name),
  university: (a, b) => (a.university ?? "~").localeCompare(b.university ?? "~") || a.full_name.localeCompare(b.full_name),
};

function renderTable() {
  const query = $("search").value.trim().toLowerCase();
  const list = currentRows
    .filter((row) => !query || [row.full_name, row.email, row.mobile, row.major, row.university].some((text) => text?.toLowerCase().includes(query)))
    .sort(sorters[$("sort").value]);

  $("result-count").textContent = query
    ? `${number.format(list.length)} of ${plural(currentRows.length, "student")} match your search`
    : plural(currentRows.length, "student");
  $("empty").hidden = list.length > 0;
  $("empty").textContent = !submissions.length
    ? "No submissions yet. They’ll appear here as students fill in the form."
    : query
      ? "No students match your search."
      : "No students match these filters.";
  $("rows").replaceChildren(...list.slice(0, visibleCount).map(renderRow));
  const remaining = list.length - visibleCount;
  $("show-more").hidden = remaining <= 0;
  $("show-more").textContent = `Show ${Math.min(PAGE_SIZE, remaining)} more`;
}

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
    el(
      "td",
      { "data-label": "University", title: row.university ? universityTitle(row.university) : null },
      row.university ? el("span", { class: "uni-code" }, row.university) : el("span", { class: "muted" }, "—"),
      el("span", { class: "sub" }, row.school)
    ),
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
    ["University", row.university && universityTitle(row.university)],
    ["School or faculty", row.school],
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

// --- tooltip -----------------------------------------------------------------

function attachTooltip(node, getContent) {
  const showAt = (x, y) => {
    const { value, label, detail } = getContent();
    tooltip.replaceChildren(...[el("strong", {}, value), el("span", {}, label), detail && el("span", {}, detail)].filter(Boolean));
    tooltip.hidden = false;
    const { width, height } = tooltip.getBoundingClientRect();
    const left = x + 14 + width > innerWidth - 8 ? x - width - 14 : x + 14;
    const top = y - height - 12 < 8 ? y + 16 : y - height - 12;
    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${top}px`;
  };
  node.addEventListener("pointermove", (event) => {
    if (event.pointerType === "mouse") showAt(event.clientX, event.clientY);
  });
  node.addEventListener("pointerleave", hideTooltip);
  node.addEventListener("focus", () => {
    if (!node.matches(":focus-visible")) return; // a tap also focuses; only keyboard focus gets the tooltip
    const box = node.getBoundingClientRect();
    showAt(box.left + box.width / 2, box.top);
  });
  node.addEventListener("blur", hideTooltip);
}

function hideTooltip() {
  tooltip.hidden = true;
}

// --- team (staff accounts) -------------------------------------------------
// Admins only. Account changes go through the staff-admin Edge Function, which
// holds the secret key and re-checks that the caller is an admin.

let currentUserEmail = "";

async function teamRequest(action, details = {}) {
  const { data, error } = await db.functions.invoke("staff-admin", { body: { action, ...details } });
  if (error) {
    // The function's own message (e.g. "That email already exists") is in the response body.
    const message = await error.context?.json?.().then((body) => body.error).catch(() => null);
    throw new Error(message || "The team service isn’t reachable. Check that the staff-admin function is deployed.");
  }
  return data;
}

// 14 characters from letters and digits that can't be confused (no 0/O, 1/l/I).
function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const limit = 256 - (256 % chars.length); // reject values that would bias the pick
  let password = "";
  while (password.length < 14) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte < limit && password.length < 14) password += chars[byte % chars.length];
    }
  }
  return password;
}

function showTempPassword(message, password) {
  $("team-notice-text").textContent = message;
  $("team-notice-password").value = password;
  $("team-notice").hidden = false;
  $("team-notice").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

async function openTeam() {
  $("account").open = false;
  $("team-add").reset();
  $("team-add").querySelector(".field-error").textContent = "";
  $("team-password").value = generatePassword();
  $("team-notice").hidden = true;
  $("team-dialog").showModal();
  await loadTeam();
}

async function loadTeam() {
  setTeamStatus("Loading staff accounts…");
  try {
    const { users } = await teamRequest("list");
    setTeamStatus("");
    $("team-list").replaceChildren(...users.map(renderTeamMember));
  } catch (error) {
    setTeamStatus(error.message, true);
  }
}

function setTeamStatus(message, isError = false) {
  $("team-status").textContent = message;
  $("team-status").classList.toggle("is-error", isError);
}

function renderTeamMember(user) {
  const isMe = user.email.toLowerCase() === currentUserEmail.toLowerCase();
  const lastSeen = user.last_sign_in_at ? `Last signed in ${dateOnly.format(new Date(user.last_sign_in_at))}` : "Hasn’t signed in yet";
  const act = (label, action, extra = {}) =>
    el("button", { type: "button", class: extra.danger ? "button-danger" : "button-secondary", onclick: () => teamAction(action, user) }, label);
  return el(
    "li",
    { class: "team-member" },
    el(
      "div",
      { class: "team-member-info" },
      el("span", { class: "team-email" }, user.email, isMe && el("span", { class: "muted" }, " (you)")),
      el("span", { class: "sub" }, `Added ${dateOnly.format(new Date(user.created_at))} · ${lastSeen}`),
      user.is_admin && el("span", { class: "chip admin-chip" }, "Admin")
    ),
    el(
      "div",
      { class: "team-member-actions" },
      act("Reset password", "reset"),
      !isMe && act(user.is_admin ? "Remove admin" : "Make admin", "toggle-admin"),
      !isMe && act("Remove", "delete", { danger: true })
    )
  );
}

async function teamAction(action, user) {
  try {
    if (action === "reset") {
      if (!confirm(`Give ${user.email} a new temporary password? Their current password will stop working.`)) return;
      const password = generatePassword();
      await teamRequest("set_password", { user_id: user.id, password });
      showTempPassword(`New temporary password for ${user.email}:`, password);
    } else if (action === "toggle-admin") {
      const making = !user.is_admin;
      if (!confirm(making ? `Let ${user.email} add and remove staff accounts?` : `Stop ${user.email} from managing staff accounts?`)) return;
      await teamRequest("set_admin", { user_id: user.id, is_admin: making });
    } else if (action === "delete") {
      if (!confirm(`Remove ${user.email}? They won’t be able to sign in any more. Submissions aren’t affected.`)) return;
      await teamRequest("delete", { user_id: user.id });
    }
    await loadTeam();
  } catch (error) {
    alert(error.message);
  }
}

async function addStaffMember(event) {
  event.preventDefault();
  const form = event.target;
  const errorEl = form.querySelector(".field-error");
  const button = form.querySelector('button[type="submit"]');
  const email = form.elements.email.value.trim().toLowerCase();
  const password = form.elements.password.value;
  errorEl.textContent = !/^[^\s@]+@triple-s\.me$/.test(email)
    ? "Use their @triple-s.me email address."
    : password.length < MIN_PASSWORD
      ? `The password needs at least ${MIN_PASSWORD} characters.`
      : "";
  if (errorEl.textContent) return;
  setBusy(button, true, "Adding…");
  try {
    await teamRequest("create", { email, password, is_admin: form.elements.is_admin.checked });
    showTempPassword(`${email} can now sign in with this temporary password:`, password);
    form.reset();
    form.elements.password.value = generatePassword();
    await loadTeam();
  } catch (error) {
    errorEl.textContent = error.message;
  } finally {
    setBusy(button, false, "Add staff member");
  }
}

// --- share the form ----------------------------------------------------------

// The form lives one folder up from this dashboard, wherever the site is hosted.
const FORM_URL = new URL("../", location.href).href;

function openShare() {
  $("share-link").value = FORM_URL;
  $("copy-status").textContent = "";
  $("share-dialog").showModal();
}

async function copyFormLink() {
  try {
    await navigator.clipboard.writeText(FORM_URL);
  } catch {
    // Older browsers, or clipboard permission refused: copy from the selected box instead.
    $("share-link").select();
    document.execCommand("copy");
  }
  $("copy-status").textContent = "Link copied. Paste it into an email, chat or post.";
}

// --- CSV export --------------------------------------------------------------

function exportCsv() {
  const columns = [
    ["Submitted", (row) => dateTime.format(new Date(row.submitted_at))],
    ["Full name", (row) => row.full_name],
    ["Email", (row) => row.email],
    ["Mobile", (row) => row.mobile],
    ["University", (row) => row.university && universityTitle(row.university)],
    ["School or faculty", (row) => row.school],
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
  for (const row of currentRows) lines.push(columns.map(([, get]) => cell(get(row))));
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
  db = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { flowType: "implicit" } });

  if (linkError) {
    $("login-notice").textContent = "That reset link has expired or was already used. Request a new one with “Forgot password?”.";
    $("login-notice").hidden = false;
  }

  db.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") recoveryMode = true;
    const userId = session?.user.id ?? null;
    // Skip repeats for the same user, e.g. the hourly token refresh.
    if (!["INITIAL_SESSION", "PASSWORD_RECOVERY"].includes(event) && userId === currentUserId) return;
    currentUserId = userId;
    // Supabase advises not awaiting its own calls inside this callback.
    setTimeout(() => handleSession(session), 0);
  });

  $("login-form").addEventListener("submit", signIn);
  $("forgot-form").addEventListener("submit", sendResetLink);
  $("recovery-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!(await savePassword(event.target))) return;
    recoveryMode = false;
    const { data } = await db.auth.getSession();
    handleSession(data.session);
  });
  $("password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const done = event.target.querySelector(".notice-box");
    done.hidden = true;
    if (!(await savePassword(event.target))) return;
    done.textContent = "Password updated.";
    done.hidden = false;
    setTimeout(() => $("password-dialog").close(), 1500);
  });

  $("copy-link").addEventListener("click", copyFormLink);
  $("team-add").addEventListener("submit", addStaffMember);
  $("refresh").addEventListener("click", loadSubmissions);
  $("export").addEventListener("click", exportCsv);
  $("clear-filters").addEventListener("click", clearFilters);
  $("toggle-filters").addEventListener("click", () => {
    const open = $("filters").classList.toggle("is-open");
    $("toggle-filters").setAttribute("aria-expanded", String(open));
  });
  $("detail-delete").addEventListener("click", () => openRow && deleteSubmission(openRow));
  for (const select of Object.values(filters)) {
    select.addEventListener("change", () => {
      visibleCount = PAGE_SIZE;
      render();
    });
  }
  $("search").addEventListener("input", () => {
    visibleCount = PAGE_SIZE;
    renderTable();
  });
  $("sort").addEventListener("change", renderTable);
  $("show-more").addEventListener("click", () => {
    visibleCount += PAGE_SIZE;
    renderTable();
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".account-menu")) $("account").open = false;
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "sign-out") db.auth.signOut();
    if (action === "close-dialog") event.target.closest("dialog").close();
    if (action === "show-forgot") {
      $("forgot-email").value = $("login-email").value;
      $("forgot-error").textContent = "";
      $("forgot-done").hidden = true;
      show("forgot");
    }
    if (action === "show-login") show("login");
    if (action === "share") openShare();
    if (action === "team") openTeam();
    if (action === "generate-password") $("team-password").value = generatePassword();
    if (action === "copy-temp-password") {
      navigator.clipboard.writeText($("team-notice-password").value).catch(() => {
        $("team-notice-password").select();
        document.execCommand("copy");
      });
      event.target.textContent = "Copied";
      setTimeout(() => (event.target.textContent = "Copy"), 1500);
    }
    if (action === "change-password") {
      $("account").open = false;
      $("password-form").reset();
      $("password-form").querySelector(".field-error").textContent = "";
      $("password-form").querySelector(".notice-box").hidden = true;
      $("password-dialog").showModal();
    }
  });
  // Clicking the dimmed backdrop closes a dialog.
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.addEventListener("click", (event) => event.target === dialog && dialog.close());
  }
  // Nothing floating is left covering the page: the tooltip and the account menu
  // close on scroll, on a tap elsewhere and on Escape.
  window.addEventListener("scroll", () => {
    hideTooltip();
    $("account").open = false;
  }, { passive: true });
  document.addEventListener("touchstart", hideTooltip, { passive: true });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !$("account").open) return;
    $("account").open = false;
    $("account").querySelector("summary").focus();
  });
  // Redraw the time chart at its new width when the window is resized.
  new ResizeObserver(() => {
    if (!$("view-dashboard").hidden) renderTimeline(currentRows);
  }).observe($("chart-timeline"));
}
