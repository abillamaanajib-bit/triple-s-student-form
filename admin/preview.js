// Shows one CV from the private "cvs" bucket in this tab instead of downloading it.
// The dashboard links here as preview.html#<path>; the part after # never
// reaches the web server. Reading the file needs a signed-in staff session
// (supabase/admin.sql), which this page shares with the dashboard.
// PDFs open in the browser's own viewer. Word .docx files are converted to HTML
// in the browser (mammoth) and shown in a sandboxed frame, so nothing in the
// document can run or load from the internet.

const MAMMOTH_SRC = "https://cdn.jsdelivr.net/npm/mammoth@1.12.3/mammoth.browser.min.js";
const MAMMOTH_INTEGRITY = "sha384-xqNXvcKbEqifokHcBnB0H32p+OQchhD/T/xJGWCMAW5fC0c0MBf9atO3weoPCT84";
const TYPES = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

const $ = (id) => document.getElementById(id);

function showMessage(message) {
  $("preview-status").textContent = message;
  $("preview-status").hidden = false;
}

function showViewer(id) {
  $("preview-status").hidden = true;
  $(id).hidden = false;
}

function loadScript(src, integrity) {
  return new Promise((resolve, reject) => {
    const script = Object.assign(document.createElement("script"), { src, integrity, crossOrigin: "anonymous" });
    script.onload = resolve;
    script.onerror = () => reject(new Error("The Word previewer couldn’t load."));
    document.head.append(script);
  });
}

// Keep only ordinary web and email links from the document (no "javascript:" etc.).
// DOMParser builds an inert document, so nothing in it runs while we clean it.
function cleanLinks(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const link of doc.querySelectorAll("a[href]")) {
    if (/^(https?:|mailto:)/i.test(link.getAttribute("href").trim())) link.rel = "noopener noreferrer";
    else link.removeAttribute("href");
  }
  return doc.body.innerHTML;
}

// A plain "page of paper" around the converted document. The CSP blocks any
// images or styles the document tries to fetch from elsewhere; links open in a new tab.
function wordPage(bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>
  body { margin: 0; padding: 32px 16px; background: #e9eff0; color: #1b1b1b; font: 15px/1.6 Calibri, "Segoe UI", Arial, sans-serif; }
  main { max-width: 800px; margin: 0 auto; padding: 56px 64px; background: #fff; box-shadow: 0 1px 4px rgb(0 0 0 / 0.15); }
  h1, h2, h3, h4 { line-height: 1.25; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; }
  td, th { padding: 4px 8px; border: 1px solid #d0d7d9; vertical-align: top; }
  a[href] { color: #2b7c83; }
  @media (max-width: 600px) { main { padding: 24px 20px; } }
</style></head><body><main>${bodyHtml}</main></body></html>`;
}

async function openPreview(db) {
  const path = decodeURIComponent(location.hash.slice(1));
  if (!path) {
    showMessage("No CV selected. Open CVs from the submissions dashboard.");
    return;
  }
  const name = path.slice(path.lastIndexOf("/") + 1);
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  document.title = `${name} · CV preview`;
  $("file-name").textContent = name;

  const { data: { session } } = await db.auth.getSession();
  if (!session) {
    showMessage("Sign in on the submissions dashboard first, then open the CV again.");
    return;
  }

  const { data, error } = await db.storage.from(CV_BUCKET).download(path);
  if (error) {
    console.error(error);
    showMessage("This CV couldn’t be opened. It may have been deleted, or this account may not have access.");
    return;
  }
  const file = new Blob([data], { type: TYPES[extension] ?? data.type });
  const fileUrl = URL.createObjectURL(file);
  Object.assign($("download"), { href: fileUrl, download: name, hidden: false });

  if (extension === ".pdf") {
    $("pdf-viewer").src = fileUrl;
    showViewer("pdf-viewer");
  } else if (extension === ".docx") {
    showMessage("Preparing preview…");
    try {
      await loadScript(MAMMOTH_SRC, MAMMOTH_INTEGRITY);
      const { value } = await window.mammoth.convertToHtml({ arrayBuffer: await data.arrayBuffer() });
      $("doc-viewer").srcdoc = wordPage(cleanLinks(value));
      showViewer("doc-viewer");
    } catch (conversionError) {
      console.error(conversionError);
      showMessage("This Word file couldn’t be previewed. Use Download to open it in Word.");
    }
  } else {
    showMessage("Older Word files (.doc) can’t be previewed in the browser. Use Download to open it in Word.");
  }
}

// A different file in the same tab starts over cleanly.
window.addEventListener("hashchange", () => location.reload());

if (!window.supabase || !SUPABASE_URL) {
  showMessage("The preview couldn’t load. Check your connection and refresh the page.");
} else {
  openPreview(window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY));
}
