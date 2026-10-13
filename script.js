// Supabase settings (SUPABASE_URL etc.) live in config.js, shared with admin/.
// With SUPABASE_URL empty the form runs in preview mode: it validates and shows
// the thank-you screen, but nothing is sent.

const MAX_CV_BYTES = 5 * 1024 * 1024;
const CV_TYPES = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_PATTERN = /^\+?[\d\s().-]+$/;
const BAD_LINK = "Enter a full link, e.g. https://www.linkedin.com/in/your-name.";
const OTHER_UNIVERSITY = "other";

const form = document.getElementById("interest-form");
const summary = document.getElementById("error-summary");
const statusMessage = document.getElementById("form-status");
const submitButton = form.querySelector('button[type="submit"]');
const success = document.getElementById("success");

const value = (name) => form.elements[name].value.trim();
const checkedValues = (name) => [...form.querySelectorAll(`[name="${name}"]:checked`)].map((input) => input.value);
const extension = (fileName) => fileName.slice(fileName.lastIndexOf(".")).toLowerCase();

// Each validator returns an error message, or "" when the field is fine.
// Listed in page order so the error summary reads top to bottom.
const validators = {
  full_name: () => (value("full_name") ? "" : "Enter your full name."),
  email: () => {
    const email = value("email");
    if (!email) return "Enter your email address.";
    return EMAIL_PATTERN.test(email) ? "" : "Enter an email address in the format name@example.com.";
  },
  mobile: () => {
    const mobile = value("mobile");
    if (!mobile) return "Enter your mobile number.";
    const digits = mobile.replace(/\D/g, "").length;
    return PHONE_PATTERN.test(mobile) && digits >= 7 && digits <= 15
      ? ""
      : "Enter a valid mobile number using digits, spaces and an optional + country code.";
  },
  university: () => (value("university") ? "" : "Select your university."),
  university_other: () =>
    value("university") === OTHER_UNIVERSITY && !value("university_other") ? "Enter your university’s name." : "",
  school: () => (value("school") ? "" : "Select your school or faculty."),
  major: () => (value("major") ? "" : "Enter your major or program."),
  year_of_study: () => (value("year_of_study") ? "" : "Select your current year of study."),
  available_until: () => {
    const from = value("available_from");
    const until = value("available_until");
    return from && until && until < from ? "The “Until” date must be on or after the “From” date." : "";
  },
  profile_link: () => {
    const link = value("profile_link");
    if (!link) return "";
    try {
      const url = new URL(link);
      return /^https?:$/.test(url.protocol) && url.hostname.includes(".") ? "" : BAD_LINK;
    } catch {
      return BAD_LINK;
    }
  },
  cv_file: () => {
    const file = form.elements.cv_file.files[0];
    if (!file) return "";
    if (!(extension(file.name) in CV_TYPES)) return "Upload your CV as a PDF or Word document.";
    return file.size <= MAX_CV_BYTES ? "" : "Your CV must be 5 MB or smaller.";
  },
  contact_consent: () => (value("contact_consent") ? "" : "Select whether TRIPLE S may contact you."),
};

function hasError(name) {
  return form.querySelector(`[data-field="${name}"]`).classList.contains("has-error");
}

function validate(name) {
  const message = validators[name]();
  form.querySelector(`[data-field="${name}"]`).classList.toggle("has-error", Boolean(message));
  document.getElementById(`${name}-error`).textContent = message;
  for (const control of form.querySelectorAll(`[name="${name}"]`)) {
    if (message) control.setAttribute("aria-invalid", "true");
    else control.removeAttribute("aria-invalid");
  }
  return message;
}

function showSummary(errors) {
  const items = errors.map(([name, message]) => {
    const link = document.createElement("a");
    link.href = `#${form.querySelector(`[name="${name}"]`).id}`;
    link.textContent = message;
    const item = document.createElement("li");
    item.append(link);
    return item;
  });
  summary.querySelector("ul").replaceChildren(...items);
  summary.hidden = false;
  summary.focus();
}

// Students often paste "linkedin.com/in/..." without the https:// prefix.
function normalizeLink() {
  const input = form.elements.profile_link;
  const link = input.value.trim();
  if (link && !/^[a-z][a-z\d+.-]*:\/\//i.test(link)) input.value = `https://${link}`;
}

function fillUniversities() {
  const select = form.elements.university;
  for (const [code, name] of UNIVERSITIES) select.append(new Option(`${code} – ${name}`, code));
  select.append(new Option("Other (not listed)", OTHER_UNIVERSITY));
}

function toggleOtherUniversity() {
  const isOther = value("university") === OTHER_UNIVERSITY;
  form.querySelector('[data-field="university_other"]').hidden = !isOther;
  if (!isOther && hasError("university_other")) validate("university_other");
}

function highlightSchoolGroup() {
  const school = value("school");
  for (const group of form.querySelectorAll(".area-group")) {
    const match = group.dataset.school === school;
    group.classList.toggle("is-match", match);
    group.querySelector(".badge").hidden = !match;
  }
}

function setSubmitting(busy) {
  submitButton.disabled = busy;
  submitButton.textContent = busy ? "Submitting…" : "Submit";
}

function showSuccess({ cvFailed = false } = {}) {
  document.getElementById("preview-note").hidden = Boolean(SUPABASE_URL);
  document.getElementById("cv-note").hidden = !cvFailed;
  form.hidden = true;
  success.hidden = false;
  window.scrollTo({ top: 0 });
  success.focus({ preventScroll: true });
}

// One row of public.student_interest_submissions; keys match its columns.
function buildRecord() {
  const optional = (name) => value(name) || null;
  return {
    full_name: value("full_name"),
    email: value("email"),
    mobile: value("mobile"),
    university: value("university") === OTHER_UNIVERSITY ? value("university_other") : value("university"),
    school: value("school"),
    major: value("major"),
    year_of_study: value("year_of_study"),
    interests: checkedValues("interests"),
    experience_types: checkedValues("experience_types"),
    skills: optional("skills"),
    available_from: optional("available_from"),
    available_until: optional("available_until"),
    availability_notes: optional("availability_notes"),
    profile_link: optional("profile_link"),
    contact_consent: value("contact_consent") === "Yes",
  };
}

// Stored as <random id>/<original name> so CVs never overwrite each other and
// keep a recognisable name when downloaded from the dashboard.
async function uploadCv(db, file) {
  const safeName = file.name.replace(/[^\w.-]+/g, "_").slice(-100);
  const path = `${crypto.randomUUID()}/${safeName}`;
  // Browsers often report Word files with an empty type, which the bucket would
  // reject, and the client ignores `contentType` for files, so set it here.
  const typed = new File([file], safeName, { type: CV_TYPES[extension(file.name)] });
  const { error } = await db.storage.from(CV_BUCKET).upload(path, typed);
  if (error) throw error;
  return path;
}

async function saveSubmission() {
  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const record = buildRecord();
  const file = form.elements.cv_file.files[0];
  let cvFailed = false;
  if (file) {
    try {
      record.cv_path = await uploadCv(db, file);
    } catch (error) {
      // Never lose an application over the optional CV: save the rest and
      // mark the row so the team knows to ask for it.
      console.error(error);
      record.cv_path = `UPLOAD FAILED: ${file.name}`.slice(0, 400);
      cvFailed = true;
    }
  }
  const { error } = await db.from(SUBMISSIONS_TABLE).insert(record);
  if (error) throw error;
  return { cvFailed };
}

// Validate when a field is finished with ("change" skips fields the student
// only tabbed past), then re-check live while they fix an error.
fillUniversities();

form.addEventListener("change", ({ target }) => {
  if (target.name === "university") toggleOtherUniversity();
  if (target.name === "school") highlightSchoolGroup();
  if (target.name === "profile_link") normalizeLink();
  const name = target.name === "available_from" ? "available_until" : target.name;
  if (name in validators) validate(name);
});

form.addEventListener("input", ({ target }) => {
  if (target.name in validators && hasError(target.name)) validate(target.name);
});

summary.addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (!link) return;
  event.preventDefault();
  const target = document.getElementById(link.hash.slice(1));
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "center", behavior: "smooth" });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  statusMessage.textContent = "";
  normalizeLink();

  const errors = Object.keys(validators)
    .map((name) => [name, validate(name)])
    .filter(([, message]) => message);
  if (errors.length) {
    showSummary(errors);
    return;
  }
  summary.hidden = true;

  // Bots fill the hidden field; pretend it worked and send nothing.
  if (form.elements._gotcha.value) {
    showSuccess();
    return;
  }

  setSubmitting(true);
  try {
    let outcome;
    if (SUPABASE_URL) {
      outcome = await saveSubmission();
    } else {
      console.info("Preview mode, nothing was sent. Submission:", buildRecord());
    }
    showSuccess(outcome);
  } catch (error) {
    console.error(error);
    statusMessage.textContent = "Sorry, your form couldn’t be sent. Please check your connection and try again.";
  } finally {
    setSubmitting(false);
  }
});
