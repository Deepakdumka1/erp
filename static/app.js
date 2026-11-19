// EduSense AI workspace. Renders one page at a time from /api/summary,
// posts changes to the Flask API, and listens to /api/stream for live updates.
const role = document.body.dataset.role;
const userName = document.body.dataset.name || "";
const myStudentId = document.body.dataset.studentId || "";
const currentTheme = () => (document.documentElement && document.documentElement.getAttribute("data-theme")) || "light";
const app = document.getElementById("app");
let data = {};
let centerData = {batches: [], provenance: [], activity: [], benchmark: null};
let page = "Overview";
let showAllStudents = false;
let teacherAttendanceSubject = "all";
let teacherAssignmentSubject = "all";
let rosterSubject = "";
let attendanceEditId = null;
let formDirty = false;
let liveSource = null;
let liveTimer = null;
let refreshTimer = null;
let feed = [];
let unread = 0;
const PREVIEW_ROWS = 6;

const navGroups = {
  admin: [["Workspace", ["Overview"]], ["Records", ["Students", "Teachers", "Subjects", "Fees"]], ["Insights & data", ["AI Risk", "Data Center", "Reports"]], ["Campus", ["Notices", "Project Guide", "Account"]]],
  teacher: [["Workspace", ["Overview"]], ["Teaching", ["Attendance", "Marks", "Assignments", "Exams", "Timetable"]], ["Insights & data", ["AI Risk", "Data Center", "Reports"]], ["Campus", ["Notices", "Project Guide", "Account"]]],
  student: [["Workspace", ["Dashboard"]], ["Academics", ["Attendance", "Marks", "Assignments", "Exams", "Timetable"]], ["Insights", ["Risk & What-if", "Reports"]], ["Me", ["Fees", "Notices", "Account"]]]
};
const navByRole = Object.fromEntries(Object.entries(navGroups).map(([key, groups]) => [key, groups.flatMap(group => group[1])]));

/* ---------- Utilities ---------- */
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[ch]));
const money = value => new Intl.NumberFormat("en-IN", {style: "currency", currency: "INR", maximumFractionDigits: 0}).format(Number(value) || 0);
const pct = (value, digits = 1) => `${(Number(value) || 0).toFixed(digits)}%`;
const clamp = value => Math.max(0, Math.min(100, Number(value) || 0));
const todayISO = () => new Date().toLocaleDateString("en-CA");
const initials = name => String(name || "").split(/\s+/).filter(Boolean).map(part => part[0]).slice(0, 2).join("").toUpperCase();
const roomLabel = room => /^room\b/i.test(String(room || "").trim()) ? String(room).trim() : `Room ${room}`;
const plural = (count, word, many = word + "s") => `${count} ${count === 1 ? word : many}`;
const lowerFirst = text => String(text || "").charAt(0).toLowerCase() + String(text || "").slice(1);
function fmtDate(value, opts = {day: "numeric", month: "short", year: "numeric"}) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(value || ""))) return esc(value || "Not set");
  return new Date(String(value).slice(0, 10) + "T12:00:00").toLocaleDateString("en-IN", opts);
}
function daysUntil(iso) { return Math.round((new Date(iso + "T12:00:00") - new Date(todayISO() + "T12:00:00")) / 86400000); }
function when(iso) { const d = daysUntil(iso); return d === 0 ? "today" : d === 1 ? "tomorrow" : d < 0 ? `${plural(-d, "day")} ago` : `in ${plural(d, "day")}`; }
function fmtTime(time) { const [h, m] = String(time).split(":"); return `${Number(h) % 12 || 12}:${m} ${Number(h) >= 12 ? "PM" : "AM"}`; }
function timeAgo(stamp) {
  const t = new Date(String(stamp).replace(" ", "T") + (String(stamp).includes("Z") || String(stamp).includes("+") ? "" : "Z"));
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (!isFinite(s)) return esc(stamp);
  if (s < 60) return "just now"; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return t.toLocaleDateString("en-IN", {day: "numeric", month: "short"});
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const contentType = response.headers.get("content-type") || "";
  if (response.status === 401) { window.location.href = "/login"; throw new Error("Your session has ended. Sign in again."); }
  if (!contentType.includes("application/json")) throw new Error(`The server returned a page instead of data for ${url}. Restart EduSense AI from the project folder.`);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed.");
  return result;
}
const jsonBody = (method, body) => ({method, headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});

function toast(message, tone = "success", detail = "") {
  const stack = document.getElementById("toasts");
  const node = document.createElement("div");
  node.className = `toast ${tone}`;
  node.setAttribute("role", tone === "error" ? "alert" : "status");
  node.innerHTML = `${icon(tone === "error" ? "Alert" : tone === "live" ? "Pulse" : "Check", "icon-sm")}<span>${esc(message)}${detail ? `<small>${esc(detail)}</small>` : ""}</span>`;
  stack.appendChild(node);
  while (stack.children.length > 3) stack.firstElementChild.remove();
  setTimeout(() => { node.classList.add("leaving"); setTimeout(() => node.remove(), 220); }, tone === "error" ? 5500 : 3500);
}

/* ---------- Icons ---------- */
const iconPaths = {
  Overview: "M3 3h7v9H3z M14 3h7v5h-7z M14 12h7v9h-7z M3 16h7v5H3z",
  Students: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M22 21v-2a4 4 0 0 0-3-3.9 M16 3.1a4 4 0 0 1 0 7.8",
  Teachers: "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1",
  Subjects: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5",
  Fees: "M3 6h18v12H3z M3 10h18 M7 15h4",
  Attendance: "M8 2v4 M16 2v4 M3 9h18 M3 5h18v16H3z M9 15l2 2 4-4",
  Marks: "M9 3h6v4H9z M9 5H5v16h14V5h-4 M9 12h6 M9 16h4",
  Assignments: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z M14 3v6h6 M9 14h6 M9 18h4",
  Exams: "M12 20h9 M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z",
  Timetable: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18 M12 7v5l3 2",
  "AI Risk": "M3 12h4l3-8 4 16 3-8h4",
  "Data Center": "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3 M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  Reports: "M4 20V10 M10 20V4 M16 20v-7 M22 20H2",
  "Project Guide": "M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z",
  Notices: "M18 8a6 6 0 0 0-12 0c0 7-3 8-3 9h18c0-1-3-2-3-9 M10.3 21a1.9 1.9 0 0 0 3.4 0",
  Account: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M5 21a7 7 0 0 1 14 0",
  Download: "M12 3v12 M7 10l5 5 5-5 M4 17v4h16v-4",
  Upload: "M12 21V9 M7 14l5-5 5 5 M4 7V3h16v4",
  Search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14 M21 21l-4.3-4.3",
  Check: "M20 6 9 17l-5-5",
  Alert: "M12 3 2 21h20z M12 10v5 M12 18h.01",
  Info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18 M12 11v5 M12 8h.01",
  Calendar: "M8 2v4 M16 2v4 M3 9h18 M3 5h18v16H3z",
  ArrowRight: "M5 12h14 M13 6l6 6-6 6",
  File: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z M14 3v6h6",
  Printer: "M6 9V3h12v6 M6 18H4v-7h16v7h-2 M6 14h12v7H6z",
  External: "M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6",
  Wallet: "M3 7h18v13H3z M3 7l3-4h12l3 4 M16 13h2",
  Trash: "M3 6h18 M8 6V4h8v2 M6 6l1 15h10l1-15 M10 11v6 M14 11v6",
  X: "M6 6l12 12 M18 6 6 18",
  Sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10 M12 1v2 M12 21v2 M4.2 4.2l1.4 1.4 M18.4 18.4l1.4 1.4 M1 12h2 M21 12h2 M4.2 19.8l1.4-1.4 M18.4 5.6l1.4-1.4",
  Moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  Pulse: "M22 12h-4l-3 9L9 3l-3 9H2",
  Logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9",
  Plus: "M12 5v14 M5 12h14",
  Report: "M6 2h9l5 5v15H6z M14 2v6h6 M9 13h8 M9 17h5"
};
iconPaths.Dashboard = iconPaths.Overview;
iconPaths["Risk & What-if"] = iconPaths["AI Risk"];
function icon(name, cls = "icon") {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${iconPaths[name] || iconPaths.Overview}"/></svg>`;
}

/* ---------- Components ---------- */
function pageHeader(title, subtitle, actions = "") {
  return `<header class="page-header"><div><h1>${esc(title)}</h1>${subtitle ? `<p>${esc(subtitle)}</p>` : ""}</div>${actions ? `<div class="page-actions">${actions}</div>` : ""}</header>`;
}
function card(title, body, {sub = "", tools = "", cls = "", id = ""} = {}) {
  const head = title ? `<div class="card-head"><div><h2>${esc(title)}</h2>${sub ? `<p>${sub}</p>` : ""}</div>${tools ? `<div class="card-tools">${tools}</div>` : ""}</div>` : "";
  return `<section class="card ${cls}" ${id ? `id="${id}"` : ""}>${head}${body}</section>`;
}
function emptyState(message, iconName = "Info", title = "") {
  return `<div class="empty"><span class="empty-icon">${icon(iconName, "icon-sm")}</span>${title ? `<b>${esc(title)}</b>` : ""}<p>${esc(message)}</p></div>`;
}
const badge = (label, tone = "") => `<span class="badge ${tone}">${esc(label)}</span>`;
function risk(level) { const v = String(level || "Unknown"); return `<span class="badge ${esc(v.toLowerCase())}">${esc(v)}<span class="sr-only"> risk</span></span>`; }
function percentageStatus(value) {
  const s = clamp(value);
  if (s >= 75) return {tone: "success", label: "On track"};
  if (s >= 60) return {tone: "warning", label: "Needs attention"};
  return {tone: "danger", label: "At risk"};
}
function meter(value, tone = "", ref = null, label = "", cls = "") {
  const w = clamp(value);
  return `<div class="meter ${tone} ${cls}" role="img" aria-label="${esc(label || `${w.toFixed(0)} percent`)}"><i style="width:${w}%"></i>${ref !== null ? `<span class="ref" style="left:calc(${ref}% - 1px)"></span>` : ""}</div>`;
}
function kpi(label, value, detail, iconName, {brass = false, bar = null} = {}) {
  return `<article class="card kpi"><div class="kpi-top"><span class="kpi-label">${esc(label)}</span><span class="kpi-icon ${brass ? "brass" : ""}">${icon(iconName, "icon-sm")}</span></div><div class="kpi-value">${value}</div><p class="kpi-desc">${esc(detail)}</p>${bar !== null ? meter(bar.value, bar.tone || "", bar.ref ?? null, bar.label || "", "thin") : ""}</article>`;
}
function searchBox(label, placeholder = "Search") {
  return `<div class="search">${icon("Search", "icon-sm")}<input type="search" data-table-search aria-label="${esc(label)}" placeholder="${esc(placeholder)}"></div>`;
}
function table(headers, rows, {empty = "No records yet.", caption = "", count = true, noun = "record", extra = ""} = {}) {
  if (!rows.length) return emptyState(empty, "File");
  const head = headers.map(h => Array.isArray(h) ? `<th scope="col" class="${h[1]}">${esc(h[0])}</th>` : `<th scope="col">${esc(h)}</th>`).join("");
  const foot = count ? `<div class="card-foot"><span class="table-count" data-count data-total="${rows.length}" data-noun="${esc(noun)}">${plural(rows.length, noun)}</span>${extra}</div>` : "";
  return `<div class="table-wrap"><table>${caption ? `<caption class="sr-only">${esc(caption)}</caption>` : ""}<thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table></div>${foot}`;
}
function field(label, control, {hint = "", wide = false} = {}) {
  return `<label class="field ${wide ? "field-wide" : ""}"><span>${esc(label)}</span>${control}${hint ? `<span class="hint">${esc(hint)}</span>` : ""}</label>`;
}
const selectOptions = (items, id, label, selected = "") => items.map(item => `<option value="${esc(item[id])}" ${String(item[id]) === String(selected) ? "selected" : ""}>${esc(label(item))}</option>`).join("");
function subjectSelect(name = "subject_id") {
  if (!data.subjects.length) return field("Subject", `<select name="${name}" required disabled><option value="">No subjects assigned</option></select>`);
  return field("Subject", `<select name="${name}" required>${selectOptions(data.subjects, "id", s => `${s.code}, ${s.name}`)}</select>`);
}
const studentSelect = (name = "student_id") => field("Student", `<select name="${name}" required>${selectOptions(data.students, "id", s => `${s.roll_no}, ${s.name}`)}</select>`);
function form(url, fields, button, kind = "") {
  return `<form class="form-grid" data-url="${url}" ${kind ? `data-kind="${kind}"` : ""}>${fields}<div class="form-actions"><button type="submit" class="btn btn-primary">${esc(button)}</button></div></form>`;
}
function subjectFilter(attr, current) {
  return `<label class="filter"><span>Subject</span><select ${attr}><option value="all">All my subjects</option>${data.subjects.map(s => `<option value="${s.id}" ${String(s.id) === current ? "selected" : ""}>${esc(s.code)}, ${esc(s.name)}</option>`).join("")}</select></label>`;
}
const deleteBtn = (kind, id, label) => `<button type="button" class="btn btn-danger-ghost btn-sm" data-delete="${kind}" data-id="${id}" data-label="${esc(label)}" aria-label="Delete ${esc(label)}">${icon("Trash", "icon-sm")}<span class="sr-only">Delete</span></button>`;
const sourceNote = (text, link = true) => `<p class="source-note"><span>${icon("Info", "icon-sm")}<span>${esc(text)}</span></span>${link && role !== "student" ? `<button class="btn btn-ghost btn-sm" data-page="Data Center">See where the data comes from</button>` : ""}</p>`;
function averageBySubject(records, valueFn) {
  const grouped = {};
  records.forEach(r => { (grouped[r.subject] ||= []).push(valueFn(r)); });
  return Object.entries(grouped).map(([label, values]) => ({label, value: values.reduce((a, b) => a + b, 0) / values.length}));
}
function attendanceBySubject(records) {
  const grouped = {};
  records.forEach(a => {
    const item = grouped[a.subject] ||= {subject: a.subject, attended: 0, total: 0, date: a.date};
    item.attended += Number(a.attended); item.total += Number(a.total);
    if (a.date > item.date) item.date = a.date;
  });
  return Object.values(grouped);
}
const personLink = (s, sub = s.roll_no) => role === "student" ? `<div class="person"><span class="avatar">${esc(initials(s.name))}</span><span><b>${esc(s.name)}</b><small>${esc(sub)}</small></span></div>`
  : `<button type="button" class="person-link" data-student="${s.id}" aria-label="Open profile of ${esc(s.name)}"><span class="avatar">${esc(initials(s.name))}</span><span><b>${esc(s.name)}</b><small>${esc(sub)}</small></span></button>`;

/* ---------- Charts ---------- */
function subjectChart(records, attendanceRecords) {
  const marks = averageBySubject(records, m => Number(m.score));
  const attendance = {};
  attendanceBySubject(attendanceRecords).forEach(a => { attendance[a.subject] = a.total ? 100 * a.attended / a.total : null; });
  const keys = [...new Set([...marks.map(x => x.label), ...Object.keys(attendance)])].sort().slice(0, 10);
  if (!keys.length) return emptyState("Add the first record of marks or attendance to see subject averages here.", "Reports", "No academic records yet");
  const W = 640, top = 24, bottom = 196, left = 40, right = 6, h = bottom - top, group = (W - left - right) / keys.length;
  const y = v => bottom - v / 100 * h;
  const bw = Math.max(10, Math.min(28, group / 3.2));
  const grid = [0, 25, 50, 75, 100].map(n => `<line class="${n ? "grid" : "base"}" x1="${left}" x2="${W - right}" y1="${y(n)}" y2="${y(n)}"/><text x="${left - 8}" y="${y(n) + 4}" text-anchor="end">${n}</text>`).join("");
  const bar = (x, v, cls, name, key, i) => v == null
    ? `<text x="${x + bw / 2}" y="${bottom - 6}" text-anchor="middle">–</text>`
    : `<rect class="${cls}" style="animation-delay:${i * 40}ms" x="${x}" y="${y(v)}" width="${bw}" height="${Math.max(1, bottom - y(v))}" rx="4"><title>${esc(key)} ${name}: ${v.toFixed(1)}%</title></rect><text class="val" x="${x + bw / 2}" y="${y(v) - 6}" text-anchor="middle">${v.toFixed(0)}</text>`;
  const bars = keys.map((key, i) => {
    const cx = left + group * (i + .5), m = marks.find(v => v.label === key)?.value ?? null, a = attendance[key] ?? null;
    return `<g>${bar(cx - bw - 2, m, "bar-1", "average marks", key, i)}${bar(cx + 2, a, "bar-2", "attendance", key, i)}<text x="${cx}" y="${bottom + 20}" text-anchor="middle">${esc(key)}</text></g>`;
  }).join("");
  const sr = keys.map(key => { const m = marks.find(v => v.label === key)?.value, a = attendance[key]; return `<li>${esc(key)}: marks ${m == null ? "not recorded" : m.toFixed(1) + "%"}, attendance ${a == null ? "not recorded" : a.toFixed(1) + "%"}</li>`; }).join("");
  return `<div class="chart-scroll"><svg class="chart" viewBox="0 0 ${W} 228" role="img" aria-label="Average marks and attendance by subject, 0 to 100 percent"><text x="0" y="12">%</text>${grid}${bars}</svg></div><ul class="sr-only">${sr}</ul>`;
}
function riskCounts(students) {
  const c = {Low: 0, Medium: 0, High: 0};
  students.forEach(s => { if (c[s.risk.level] !== undefined) c[s.risk.level]++; });
  return c;
}
function riskRing(students) {
  if (!students.length) return emptyState("Risk indicators appear once students have academic records.", "AI Risk");
  const c = riskCounts(students), total = students.length, r = 60, C = 2 * Math.PI * r;
  const colors = {Low: "var(--risk-low)", Medium: "var(--risk-mid)", High: "var(--risk-high)"};
  let offset = 0;
  const arcs = Object.entries(c).filter(([, v]) => v).map(([k, v]) => { const len = C * v / total; const seg = `<circle cx="75" cy="75" r="${r}" stroke="${colors[k]}" stroke-dasharray="${Math.max(0, len - 3)} ${C}" stroke-dashoffset="${-offset}" transform="rotate(-90 75 75)"><title>${k}: ${v}</title></circle>`; offset += len; return seg; }).join("");
  return `<div class="ring-wrap"><svg class="ring" viewBox="0 0 150 150" role="img" aria-label="${c.Low} low, ${c.Medium} medium and ${c.High} high risk out of ${total} students"><circle class="track" cx="75" cy="75" r="${r}"/>${arcs}<text x="75" y="78" text-anchor="middle" font-size="30">${total}</text><text class="ring-sub" x="75" y="98" text-anchor="middle">students</text></svg>
    <div class="ring-legend">${Object.entries(c).map(([k, v]) => `<div>${risk(k)}<span></span><b>${v}<small>${Math.round(100 * v / total)}%</small></b></div>`).join("")}</div></div>
    <p class="card-caption">Decision Tree indicators, trained on synthetic examples. A prompt for a support conversation, not a verdict.</p>`;
}
function standingPanel(stats) {
  const items = [["Average marks", stats.average_marks, 60], ["Attendance", stats.attendance, 75], ["Assignment completion", stats.assignment_completion, 70]];
  return `<div class="metric-list">${items.map(([label, value, ref]) => `<div><div class="metric-head"><span>${label}</span><b>${pct(value)}</b></div>${meter(value, value >= ref ? "" : "warning", ref, `${label} ${pct(value)}, reference ${ref}%`)}<p class="metric-foot">${value >= ref ? "At or above" : "Below"} the ${ref}% reference</p></div>`).join("")}</div>
    <p class="card-caption">The marker on each bar is the reference level the risk indicator uses.</p>`;
}
function progressList(items) {
  if (!items.length) return emptyState("Nothing recorded yet.");
  return `<div class="metric-list">${items.map(item => `<div><div class="metric-head"><span>${esc(item.label)}</span><b>${esc(item.display ?? pct(item.value, 0))}</b></div>${meter(item.value, item.tone || "", item.ref ?? null, `${item.label} ${item.display ?? pct(item.value, 0)}`)}${item.note ? `<p class="metric-foot">${esc(item.note)}</p>` : ""}</div>`).join("")}</div>`;
}

/* ---------- Dashboard blocks ---------- */
function upcomingItems() {
  const source = role === "student" ? data.student : data, today = todayISO();
  return [
    ...(source.exams || []).map(e => ({title: e.details, date: e.exam_date, subject: e.subject, kind: "Exam"})),
    ...(source.assignments || []).filter(a => a.status !== "Submitted").map(a => ({title: a.title, date: a.due_date, subject: a.subject, kind: "Assignment"}))
  ].filter(e => e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
}
function todayPanel() {
  const entries = role === "student" ? data.student.timetable : data.timetable;
  const dayName = new Date().toLocaleDateString("en-US", {weekday: "long"});
  const now = new Date(), mins = now.getHours() * 60 + now.getMinutes();
  const todays = entries.filter(t => t.day === dayName).sort((a, b) => a.start_time.localeCompare(b.start_time));
  let nextMarked = false;
  const slots = todays.slice(0, 4).map(t => {
    const [h, m] = t.start_time.split(":").map(Number), start = h * 60 + m;
    const state = mins >= start + 60 ? "done" : mins >= start ? "now" : "";
    let tag = "";
    if (state === "now") tag = `<span class="tag">Now</span>`;
    else if (!state && !nextMarked) { tag = `<span class="tag next">Next</span>`; nextMarked = true; }
    return `<li class="slot ${state}"><time datetime="${esc(t.start_time)}">${fmtTime(t.start_time)}</time><span style="min-width:0"><b>${esc(t.subject)}</b><small>${esc(roomLabel(t.room))}${role !== "teacher" && t.teacher ? `, ${esc(t.teacher)}` : ""}</small></span>${tag}</li>`;
  }).join("");
  const next = upcomingItems()[0];
  const title = role === "admin" ? "Classes on campus today" : role === "teacher" ? "Your classes today" : "Your classes today";
  return `<aside class="today" aria-label="${title}"><div class="today-head"><h2>${title}</h2><span>${plural(todays.length, "class", "classes")}</span></div>
    ${slots ? `<ul class="slot-list">${slots}</ul>${todays.length > 4 ? `<p class="today-empty">and ${todays.length - 4} more</p>` : ""}` : `<p class="today-empty">No classes are scheduled for ${dayName}.</p>`}
    <div class="today-foot"><span>Next deadline</span>${next ? `<span><b>${esc(next.title)}</b>, ${when(next.date)}</span>` : `<span>None scheduled</span>`}</div></aside>`;
}
function upcomingCard(limit = 5) {
  const items = upcomingItems();
  const list = items.slice(0, limit).map(e => { const d = new Date(e.date + "T12:00:00"); return `<article class="event"><div class="date-tile" aria-hidden="true"><b>${d.getDate()}</b><small>${d.toLocaleDateString("en", {month: "short"})}</small></div><div style="min-width:0"><h3>${esc(e.title)}</h3><p>${esc(e.subject)}, ${fmtDate(e.date, {day: "numeric", month: "short"})}, ${when(e.date)}</p></div>${badge(e.kind, e.kind === "Exam" ? "brass plain" : "info plain")}</article>`; }).join("");
  return card("Deadlines and exams", list ? `<div class="event-list">${list}</div>` : emptyState("Nothing scheduled from today onward.", "Calendar"), {sub: items.length ? `${plural(items.length, "item")} coming up` : "", tools: role !== "admin" ? `<button class="btn btn-ghost btn-sm" data-page="${role === "student" ? "Assignments" : "Exams"}">View all</button>` : ""});
}
function noticeItems(rows, canDelete = false) {
  return rows.map(n => `<article class="notice"><h3>${esc(n.title)}</h3><time datetime="${esc(n.date)}">${fmtDate(n.date)}</time><p>${esc(n.message)}</p>${canDelete && n.id ? `<div class="notice-actions">${deleteBtn("notice", n.id, `notice “${n.title}”`)}</div>` : ""}</article>`).join("");
}
function noticePreview() {
  const all = role === "student" ? data.student.notices : data.notices;
  return card("Notices", all.length ? `<div class="notice-list">${noticeItems(all.slice(0, 3))}</div>` : emptyState("No notices yet.", "Notices"), {tools: `<button class="btn btn-ghost btn-sm" data-page="Notices">View all${all.length > 3 ? ` ${all.length}` : ""}</button>`});
}
function quickActions(actions) {
  return card("Quick actions", `<div class="quick">${actions.map(([target, label, detail, ic]) => `<button class="quick-action" data-page="${target}"><span class="kpi-icon">${icon(ic, "icon-sm")}</span><span><b>${esc(label)}</b><small>${esc(detail)}</small></span>${icon("ArrowRight", "icon-sm")}</button>`).join("")}</div>`);
}
function studentRows(rows, {edit = false, preview = false} = {}) {
  return rows.map((s, i) => {
    const overflow = preview && i >= PREVIEW_ROWS;
    return `<tr ${overflow ? `data-overflow="1" ${showAllStudents ? "" : "hidden"}` : ""}><td>${personLink(s, edit ? `${s.roll_no}, ${s.username}` : s.roll_no)}</td><td>${esc(s.class_name)}</td><td class="num">${pct(s.average_marks)}</td><td class="num"><span class="inline-meter">${pct(s.attendance)}${meter(s.attendance, s.attendance >= 75 ? "" : "warning", null, `Attendance ${pct(s.attendance)}`)}</span></td>${edit ? `<td class="num">${pct(s.assignment_completion)}</td>` : ""}<td>${risk(s.risk.level)}</td>${edit ? `<td class="actions"><button class="btn btn-secondary btn-sm" data-edit-user="${s.user_id}" data-role="student" aria-label="Edit account of ${esc(s.name)}">Edit</button></td>` : ""}</tr>`;
  });
}

/* ---------- Dashboard ---------- */
function overview() { return dashboardOverview(); }
function dashboardOverview() {
  const student = role === "student", source = student ? data.student : data;
  const first = userName.split(" ")[0] || userName, hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const date = new Date().toLocaleDateString("en-IN", {weekday: "long", day: "numeric", month: "long", year: "numeric"});
  let line, actions, cards;
  if (student) {
    const s = source.stats, pending = source.assignments.filter(a => a.status !== "Submitted"), balance = source.fees.total - source.fees.paid;
    line = pending.length ? `You have ${plural(pending.length, "assignment")} waiting for submission, and your current risk indicator is ${s.risk.level.toLowerCase()}.` : `Every assignment is submitted. Your current risk indicator is ${s.risk.level.toLowerCase()}.`;
    actions = `<button class="btn btn-brass" data-page="${pending.length ? "Assignments" : "Risk & What-if"}">${pending.length ? "Submit assignments" : "Plan with what-if"}</button><a class="btn btn-outline" href="/report/${esc(myStudentId)}" target="_blank" rel="noopener">${icon("Report", "icon-sm")}Report card</a>`;
    cards = kpi("Average marks", pct(s.average_marks), `Across ${plural(source.marks.length, "assessment")}`, "Marks", {bar: {value: s.average_marks, ref: 60, tone: s.average_marks >= 60 ? "" : "warning"}})
      + kpi("Attendance", pct(s.attendance), s.attendance >= 75 ? "At or above 75%" : "Below the 75% requirement", "Attendance", {bar: {value: s.attendance, ref: 75, tone: s.attendance >= 75 ? "" : "warning"}})
      + kpi("Assignments", `${source.assignments.length - pending.length}<span class="muted" style="font-size:18px"> / ${source.assignments.length}</span>`, `${pct(s.assignment_completion, 0)} submitted`, "Assignments", {bar: {value: s.assignment_completion}})
      + kpi("Fee balance", money(balance), balance > 0 ? `Due ${fmtDate(source.fees.due_date)}` : "Nothing outstanding", "Wallet", {brass: true});
  } else {
    const students = data.students, c = riskCounts(students);
    if (role === "admin") {
      const avg = students.length ? students.reduce((n, s) => n + s.attendance, 0) / students.length : 0;
      const classes = new Set(students.map(s => s.class_name)).size, unassigned = data.subjects.filter(s => !s.teacher_id).length;
      const outstanding = data.fees.reduce((n, f) => n + (f.total - f.paid), 0);
      line = `${plural(students.length, "student")} in ${plural(classes, "class", "classes")}. ${c.High ? `${plural(c.High, "student")} ${c.High === 1 ? "needs" : "need"} academic support` : "No students are at high risk"}, and ${money(outstanding)} in fees is outstanding.`;
      actions = `<button class="btn btn-brass" data-page="AI Risk">Review students at risk</button><button class="btn btn-outline" data-page="Students">Student directory</button>`;
      cards = kpi("Enrolled students", students.length, `${plural(classes, "class", "classes")} on record`, "Students")
        + kpi("Active teachers", data.teachers.length, `${plural(data.subjects.length, "subject")}${unassigned ? `, ${unassigned} unassigned` : ""}`, "Teachers")
        + kpi("Average attendance", pct(avg), "Mean of per-student attendance", "Attendance", {bar: {value: avg, ref: 75, tone: avg >= 75 ? "" : "warning"}})
        + kpi("Need support", c.High, `High risk, plus ${c.Medium} at medium`, "AI Risk", {brass: true});
    } else {
      const att = data.attendance.reduce((a, r) => ({attended: a.attended + Number(r.attended), total: a.total + Number(r.total)}), {attended: 0, total: 0});
      const classAtt = att.total ? 100 * att.attended / att.total : null;
      const pending = Math.max(0, data.assignments.length * students.length - data.submissions.length);
      line = data.subjects.length ? `You teach ${data.subjects.map(s => s.name).join(", ")}. ${pending ? `${plural(pending, "submission")} still outstanding` : "All coursework is in"}, and ${plural(c.High, "student")} ${c.High === 1 ? "is" : "are"} flagged for support.` : "No subjects are assigned to you yet. An administrator can assign them from Subjects.";
      actions = `<button class="btn btn-brass" data-page="Attendance">Take attendance</button><button class="btn btn-outline" data-page="Marks">Enter marks</button>`;
      cards = kpi("Your subjects", data.subjects.length, data.subjects.length ? data.subjects.map(s => s.code).join(", ") : "None assigned yet", "Subjects")
        + kpi("Class attendance", classAtt === null ? "—" : pct(classAtt), classAtt === null ? "No attendance yet" : `${att.attended} of ${att.total} classes attended`, "Attendance", classAtt === null ? {} : {bar: {value: classAtt, ref: 75, tone: classAtt >= 75 ? "" : "warning"}})
        + kpi("Pending coursework", pending, `Across ${plural(data.assignments.length, "assignment")}`, "Assignments")
        + kpi("Need support", c.High, `High risk, plus ${c.Medium} at medium`, "AI Risk", {brass: true});
    }
  }
  const hero = `<section class="hero" aria-labelledby="hero-title"><div class="hero-copy"><p class="hero-date">${date}</p><h1 id="hero-title">${greeting}, ${esc(first)}</h1><p>${esc(line)}</p><div class="hero-actions">${actions}</div></div>${todayPanel()}</section>`;
  const chart = card("Performance by subject", subjectChart(source.marks, source.attendance), {sub: "Average marks and attendance, 0 to 100%", tools: `<div class="legend"><span><i></i>Marks</span><span><i class="s2"></i>Attendance</span></div>`});
  const side = student ? card("Academic standing", `<div style="display:flex;justify-content:space-between;align-items:center;margin:-6px 0 18px"><span class="muted">Current indicator</span>${risk(source.stats.risk.level)}</div>` + standingPanel(source.stats))
    : card("Risk distribution", riskRing(data.students), {tools: `<button class="btn btn-ghost btn-sm" data-page="AI Risk">Details</button>`});
  let left;
  if (student) {
    const recovery = attendanceBySubject(source.attendance).map(a => ({...a, p: a.total ? 100 * a.attended / a.total : 0})).filter(a => a.p < 75).map(a => ({...a, need: Math.ceil((75 * a.total - 100 * a.attended) / 25)}));
    const shown = recovery.slice(0, 3);
    const steps = [
      ...source.stats.risk.reasons.map(r => `<li class="${/at or above/.test(r) ? "" : "warn"}">${icon(/at or above/.test(r) ? "Check" : "Alert", "icon-sm")}<span>${esc(r)}</span></li>`),
      ...shown.map(a => `<li class="warn">${icon("Attendance", "icon-sm")}<span>Attend the next ${plural(a.need, "class", "classes")} of ${esc(a.subject)} to reach 75%. You are at ${pct(a.p, 0)}.</span></li>`),
      ...(recovery.length > shown.length ? [`<li>${icon("Info", "icon-sm")}<span>${plural(recovery.length - shown.length, "more subject")} below 75%. <button class="btn btn-ghost btn-sm" data-page="Attendance" style="height:24px;padding:0 4px">Open attendance guidance</button></span></li>`] : [])
    ];
    left = card("Your next steps", `<ul class="reasons">${steps.join("")}</ul>`, {sub: "Worked out from your current records", tools: `<button class="btn btn-ghost btn-sm" data-page="Risk & What-if">Try what-if</button>`});
  } else {
    const more = data.students.length > PREVIEW_ROWS ? `<button class="btn btn-ghost btn-sm" data-show-students aria-expanded="${showAllStudents}">${showAllStudents ? "Show fewer" : `View all ${data.students.length}`}</button>` : "";
    left = card("Students", table(["Student", "Class", ["Avg. marks", "num"], ["Attendance", "num"], "Risk"], studentRows(data.students, {preview: true}), {noun: "student", empty: "No students enrolled yet.", extra: more}), {sub: "Select a name to open the full profile", tools: searchBox("Search students", "Name or roll number")});
  }
  const quick = student
    ? [["Attendance", "Attendance recovery", "Classes needed in each subject", "Attendance"], ["Timetable", "Weekly timetable", "Rooms, times and teachers", "Timetable"], ["Fees", "Fee ledger", "Balance and due date", "Fees"]]
    : role === "teacher"
      ? [["Assignments", "Coursework", "Create assignments, download submissions", "Assignments"], ["Exams", "Exams", "Schedule an examination", "Exams"], ["Notices", "Publish a notice", "Reach every workspace", "Notices"]]
      : [["Subjects", "Subjects and teachers", "Assign a teacher to each subject", "Subjects"], ["Fees", "Fee ledger", "Payments and due dates", "Fees"], ["Data Center", "Import records", "Bring in a college register", "Data Center"]];
  return `${hero}<div class="kpi-grid">${cards}</div>
    <div class="grid-main">${chart}${side}</div>
    <div class="grid-main"><div class="stack">${left}${noticePreview()}</div><div class="stack">${upcomingCard()}${quickActions(quick)}</div></div>
    ${sourceNote("Figures are calculated live from the SQLite records. Seeded records are demo data and unverified. Risk indicators come from a Decision Tree trained on synthetic examples.")}`;
}

/* ---------- Admin ---------- */
function accountForm(type) {
  const extra = type === "student" ? field("Roll number", `<input name="roll_no" required>`) + field("Class", `<input name="class_name" value="CSE-A">`) : "";
  return `<form class="form-grid" data-user-form="${type}"><input type="hidden" name="role" value="${type}"><input type="hidden" name="user_id">
    ${field("Full name", `<input name="name" required autocomplete="off">`)}${field("Username", `<input name="username" required autocomplete="off">`)}${extra}
    ${field("Password", `<input name="password" type="password" minlength="6" required autocomplete="new-password">`, {hint: "At least 6 characters. Leave blank when editing to keep it."})}
    <div class="form-actions"><button type="submit" class="btn btn-primary save-account">Add ${type}</button><button type="button" class="btn btn-secondary cancel-edit" hidden>Cancel editing</button></div></form>`;
}
function adminStudents() {
  return pageHeader("Students", "Accounts and current academic indicators for every enrolled student.")
    + card("Add a student", accountForm("student"), {sub: "To edit an existing account, choose Edit in the directory."})
    + card("Directory", table(["Student", "Class", ["Avg. marks", "num"], ["Attendance", "num"], ["Assignments", "num"], "Risk", ["Account", "num"]], studentRows(data.students, {edit: true}), {noun: "student", empty: "No students yet. Add the first one above."}), {sub: "Select a name for the full profile and report card", tools: searchBox("Search students", "Search students")});
}
function adminTeachers() {
  const subs = id => data.subjects.filter(s => s.teacher_id === id).map(s => s.code);
  const rows = data.teachers.map(t => { const list = subs(t.user_id); return `<tr><td><div class="person"><span class="avatar brass">${esc(initials(t.name))}</span><span><b>${esc(t.name)}</b><small>${esc(t.username)}</small></span></div></td><td>${list.length ? list.map(c => badge(c, "info plain")).join(" ") : `<span class="muted">None assigned</span>`}</td><td class="actions"><button class="btn btn-secondary btn-sm" data-edit-user="${t.user_id}" data-role="teacher" aria-label="Edit ${esc(t.name)}">Edit</button></td></tr>`; });
  return pageHeader("Teachers", "Faculty accounts. Assign subjects from the Subjects page.")
    + card("Add a teacher", accountForm("teacher"))
    + card("Faculty", table(["Teacher", "Subjects", ["Account", "num"]], rows, {noun: "teacher"}), {tools: searchBox("Search teachers", "Search faculty")});
}
function adminSubjects() {
  const opts = sel => `<option value="" ${sel ? "" : "selected"}>Unassigned</option>${data.teachers.map(t => `<option value="${t.user_id}" ${t.user_id === sel ? "selected" : ""}>${esc(t.name)}</option>`).join("")}`;
  const rows = data.subjects.map(s => `<tr><td><b>${esc(s.code)}</b></td><td>${esc(s.name)}</td><td><label class="sr-only" for="st-${s.id}">Teacher for ${esc(s.code)}</label><select id="st-${s.id}" data-subject-teacher="${s.id}" style="min-width:200px">${opts(s.teacher_id)}</select></td><td>${s.teacher_id ? badge("Assigned", "success") : badge("Unassigned", "warning")}</td><td class="actions"><button class="btn btn-secondary btn-sm" data-save-subject="${s.id}">Save</button></td></tr>`);
  return pageHeader("Subjects", "Courses offered and the teacher responsible for each.")
    + card("Add a subject", form("/api/admin/subject", field("Subject code", `<input name="code" required placeholder="e.g. CN">`) + field("Subject name", `<input name="name" required placeholder="e.g. Computer Networks">`) + field("Teacher", `<select name="teacher_id">${opts(null)}</select>`), "Add subject"))
    + card("All subjects", table(["Code", "Subject", "Teacher", "Status", ["Action", "num"]], rows, {noun: "subject"}), {sub: "Change a teacher, then choose Save on that row.", tools: searchBox("Search subjects", "Search subjects")});
}
function feeStatus(f) {
  const b = f.total - f.paid;
  if (b <= 0) return badge("Paid", "success");
  if (f.due_date && f.due_date < todayISO()) return badge("Overdue", "danger");
  return badge("Balance due", "warning");
}
function adminFees() {
  const billed = data.fees.reduce((n, f) => n + f.total, 0), paid = data.fees.reduce((n, f) => n + f.paid, 0), withBal = data.fees.filter(f => f.total - f.paid > 0).length;
  const rows = data.fees.map(f => `<tr><td>${personLink({id: f.student_id, name: f.student, roll_no: f.roll_no})}</td><td class="num">${money(f.total)}</td><td class="num">${money(f.paid)}</td><td class="num">${money(f.total - f.paid)}</td><td>${fmtDate(f.due_date)}</td><td>${feeStatus(f)}</td></tr>`);
  return pageHeader("Fee ledger", "Totals, payments and due dates for every student.")
    + `<div class="kpi-grid">${kpi("Billed", money(billed), plural(data.fees.length, "ledger entry", "ledger entries"), "Fees")}${kpi("Collected", money(paid), billed ? `${Math.round(100 * paid / billed)}% of billed` : "Nothing billed yet", "Check", {bar: billed ? {value: 100 * paid / billed, tone: "success"} : null})}${kpi("Outstanding", money(billed - paid), "Across all students", "Wallet", {brass: true})}${kpi("Students with a balance", withBal, "Including overdue", "Students")}</div>`
    + card("Record a payment or fee", form("/api/admin/fee", studentSelect() + field("Total fee (₹)", `<input name="total" type="number" min="0" step="1" required>`) + field("Amount paid (₹)", `<input name="paid" type="number" min="0" step="1" required>`) + field("Due date", `<input name="due_date" type="date" required>`), "Save fee record"), {sub: "Saving replaces that student's existing record."})
    + card("Ledger", table(["Student", ["Total", "num"], ["Paid", "num"], ["Balance", "num"], "Due date", "Status"], rows, {noun: "entry", empty: "No fee records yet."}), {tools: searchBox("Search fee ledger", "Search students")});
}

/* ---------- Shared ---------- */
function noticesPage(canAdd) {
  const notices = role === "student" ? data.student.notices : data.notices;
  const add = canAdd ? card("Publish a notice", form("/api/teacher/notice", field("Title", `<input name="title" required maxlength="120">`, {wide: true}) + field("Message", `<textarea name="message" required maxlength="2000"></textarea>`, {wide: true}), "Publish notice"), {sub: "Everyone sees it immediately, in every workspace."}) : "";
  return pageHeader("Notices", "Announcements for the whole college.") + add + card("All notices", notices.length ? `<div class="notice-list">${noticeItems(notices, canAdd)}</div>` : emptyState("No notices yet.", "Notices"), {sub: plural(notices.length, "notice")});
}
function timetablePage() {
  const entries = role === "student" ? data.student.timetable : data.timetable;
  const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const days = weekdays.filter((d, i) => i < 5 || entries.some(t => t.day === d));
  const slots = [...new Set(["09:00", "10:00", "11:00", "12:00", "14:00", "15:00", ...entries.map(t => t.start_time)])].sort();
  const today = new Date().toLocaleDateString("en-US", {weekday: "long"});
  const rows = slots.map(time => `<tr><th scope="row">${esc(fmtTime(time))}</th>${days.map(day => {
    const m = entries.filter(t => t.day === day && t.start_time === time);
    return m.length ? `<td class="class-slot">${m.map(t => `<div class="cls"><b>${esc(t.subject)}</b><small>${esc(t.teacher || "Unassigned")}</small><span>${esc(roomLabel(t.room))}</span>${role !== "student" && t.id ? `<button type="button" class="icon-btn sm" data-delete="timetable" data-id="${t.id}" data-label="${esc(t.subject)} class on ${day} at ${fmtTime(time)}" aria-label="Remove ${esc(t.subject)} on ${day} at ${fmtTime(time)}">${icon("X", "icon-sm")}</button>` : ""}</div>`).join("")}</td>` : `<td class="free-slot"><span aria-hidden="true">—</span><span class="sr-only">No class</span></td>`;
  }).join("")}</tr>`).join("");
  const grid = card("Weekly schedule", entries.length ? `<div class="table-wrap timetable"><table><caption class="sr-only">Weekly timetable</caption><thead><tr><th scope="col">Time</th>${days.map(d => `<th scope="col">${d}${d === today ? " (today)" : ""}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("No classes scheduled yet.", "Timetable"), {sub: plural(entries.length, "class", "classes")});
  if (role === "student") return pageHeader("Timetable", "Your classes for the week.") + grid;
  const weekdaysOpt = weekdays.map(d => `<option ${d === today ? "selected" : ""}>${d}</option>`).join("");
  return pageHeader("Timetable", "The weekly class schedule. Clashes for a room or teacher are blocked.") + card("Schedule a class", form("/api/teacher/item", subjectSelect() + field("Day", `<select name="day">${weekdaysOpt}</select>`) + field("Start time", `<input name="time" type="time" required>`) + field("Room", `<input name="room" required placeholder="e.g. B-204">`), "Add class", "timetable")) + grid;
}
function accountPage() {
  const theme = currentTheme();
  return pageHeader("Account", "Your profile, appearance and password.")
    + `<div class="grid-2">${card("Profile", `<div class="profile-head" style="margin-bottom:20px"><span class="avatar lg">${esc(initials(userName))}</span><div><h2>${esc(userName)}</h2><p class="muted">${esc(role.charAt(0).toUpperCase() + role.slice(1))} workspace</p></div></div>
        <dl class="dl"><dt>Role</dt><dd>${esc(role.charAt(0).toUpperCase() + role.slice(1))}</dd><dt>Session</dt><dd>Signs out after 8 hours</dd>${role === "student" ? `<dt>Report card</dt><dd><a href="/report/${esc(myStudentId)}" target="_blank" rel="noopener">Open report card</a></dd>` : ""}</dl>`)}
      ${card("Appearance", `<fieldset style="border:0;padding:0;margin:0"><legend class="sr-only">Theme</legend><div class="theme-choice">${["light", "dark"].map(t => `<label><input type="radio" name="theme-choice" value="${t}" ${theme === t ? "checked" : ""}>${icon(t === "light" ? "Sun" : "Moon", "icon-sm")}${t === "light" ? "Light" : "Dark"}</label>`).join("")}</div></fieldset><p class="card-caption">Saved on this browser.</p>`)}</div>`
    + card("Change password", `<form id="password-form" class="form-grid" novalidate>${field("Current password", `<input name="current" type="password" required autocomplete="current-password">`)}${field("New password", `<input name="new" type="password" required minlength="8" autocomplete="new-password">`, {hint: "At least 8 characters, with letters and numbers."})}${field("Confirm new password", `<input name="confirm" type="password" required autocomplete="new-password">`)}<p class="field-error field-wide" id="password-error" role="alert"></p><div class="form-actions"><button type="submit" class="btn btn-primary">Change password</button></div></form>`);
}

/* ---------- Teacher ---------- */
function rosterCard() {
  if (!data.subjects.length) return card("Take attendance", emptyState("No subjects are assigned to you yet.", "Attendance"));
  if (!rosterSubject || !data.subjects.some(s => String(s.id) === rosterSubject)) rosterSubject = String(data.subjects[0].id);
  const people = data.students.map(s => `<label><input type="checkbox" name="present" value="${s.id}" checked><span><b>${esc(s.name)}</b><small>${esc(s.roll_no)}</small></span><span class="state" aria-hidden="true"></span></label>`).join("");
  return card("Take attendance for today's class", `<form id="roster-form">
      <div class="roster-tools"><label class="filter"><span>Subject</span><select name="subject_id" id="roster-subject">${selectOptions(data.subjects, "id", s => `${s.code}, ${s.name}`, rosterSubject)}</select></label>
      <button type="button" class="btn btn-secondary btn-sm" data-roster="all">Mark all present</button><button type="button" class="btn btn-secondary btn-sm" data-roster="none">Mark all absent</button>
      <span class="roster-count" id="roster-count" aria-live="polite"><b>${data.students.length}</b> of ${data.students.length} present</span></div>
      <div class="roster" role="group" aria-label="Students present">${people}</div>
      <div class="form-actions" style="margin-top:16px"><button type="submit" class="btn btn-primary">Save attendance</button><span class="hint">Untick anyone who is absent. Each student gets one class; present students get one attended.</span></div></form>`, {sub: "Everyone starts as present"});
}
function teacherAttendance() {
  const filtered = data.attendance.filter(a => teacherAttendanceSubject === "all" || String(a.subject_id) === teacherAttendanceSubject);
  const rows = filtered.map(a => { const p = a.total ? 100 * a.attended / a.total : 0, s = percentageStatus(p); return `<tr><td>${personLink({id: a.student_id, name: a.student, roll_no: a.subject})}</td><td class="num">${a.attended} / ${a.total}</td><td class="num">${pct(p, 0)}</td><td>${badge(s.label, s.tone)}</td><td>${fmtDate(a.date)}</td><td class="actions"><button type="button" class="btn btn-secondary btn-sm" data-edit-attendance="${a.id}" data-attended="${a.attended}" data-total="${a.total}" data-label="${esc(a.student)}, ${esc(a.subject)}">Correct</button></td></tr>`; });
  const summary = attendanceBySubject(filtered).map(a => { const p = a.total ? 100 * a.attended / a.total : 0; return {label: a.subject, value: p, display: pct(p), tone: p >= 75 ? "" : "warning", ref: 75, note: `${a.attended} of ${a.total} classes`}; });
  const manual = studentSelect() + subjectSelect() + field("Classes attended", `<input name="attended" type="number" min="0" step="1" required>`) + field("Total classes", `<input name="total" type="number" min="1" step="1" required>`);
  return pageHeader("Attendance", "Take today's attendance in one go, add class counts, or correct earlier entries.")
    + rosterCard()
    + `<div class="grid-main">${card("Add class counts", form("/api/teacher/record", manual, "Save counts", "attendance"), {sub: "For several classes at once, such as a week of lab sessions."})}${card("By subject", progressList(summary) + (summary.length ? `<p class="card-caption">The marker is the 75% requirement.</p>` : ""))}</div>`
    + card("Attendance records", table(["Student / subject", ["Present / total", "num"], ["Percentage", "num"], "Status", "Date", ["Action", "num"]], rows, {noun: "record", empty: "No attendance for this selection yet."}), {tools: subjectFilter("data-attendance-subject-filter", teacherAttendanceSubject) + searchBox("Search attendance", "Search students")});
}
function teacherMarks() {
  const fields = studentSelect() + subjectSelect() + field("Assessment", `<input name="assessment" value="End Term Exam" required>`) + field("Marks out of 100", `<input name="score" type="number" min="0" max="100" step="0.5" required>`);
  const rows = data.marks.map(m => { const s = percentageStatus(m.score); return `<tr><td>${personLink({id: m.student_id, name: m.student, roll_no: m.subject})}</td><td>${esc(m.assessment)}</td><td class="num">${esc(m.score)} / 100</td><td>${badge(s.label, s.tone)}</td><td>${fmtDate(m.date)}</td></tr>`; });
  const avgs = averageBySubject(data.marks, m => Number(m.score)).map(a => ({label: a.label, value: a.value, display: `${a.value.toFixed(1)} / 100`, tone: a.value >= 60 ? "" : "warning", ref: 60}));
  return pageHeader("Marks", "Assessment scores for your subjects.")
    + `<div class="grid-main">${card("Enter marks", form("/api/teacher/record", fields, "Save marks", "marks"))}${card("Average by subject", progressList(avgs) + (avgs.length ? `<p class="card-caption">The marker is the 60% reference.</p>` : ""))}</div>`
    + card("Recorded marks", table(["Student / subject", "Assessment", ["Score", "num"], "Status", "Date"], rows, {noun: "mark", empty: "No marks yet."}), {tools: searchBox("Search marks", "Search students or assessments")});
}
function teacherAssignments() {
  const by = x => teacherAssignmentSubject === "all" || String(x.subject_id) === teacherAssignmentSubject, today = todayISO();
  const list = data.assignments.filter(by).map(a => { const n = data.submissions.filter(s => s.assignment_id === a.id).length; return `<tr><td><b>${esc(a.title)}</b></td><td>${esc(a.subject)}</td><td>${fmtDate(a.due_date)}</td><td class="num"><span class="inline-meter">${n} / ${data.students.length}${meter(data.students.length ? 100 * n / data.students.length : 0)}</span></td><td>${a.due_date < today ? badge("Closed", "plain") : badge("Open", "info")}</td><td class="actions">${deleteBtn("assignment", a.id, `assignment “${a.title}” and its submissions`)}</td></tr>`; });
  const subs = data.submissions.filter(by).map(s => `<tr><td>${personLink({id: s.student_id, name: s.student, roll_no: s.subject})}</td><td>${esc(s.assignment)}</td><td>${esc(s.file_name)}</td><td>${esc(String(s.submitted_at || "").replace("T", " "))}</td><td class="actions"><a class="btn btn-secondary btn-sm" href="/submission/${s.student_id}/${s.assignment_id}" aria-label="Download ${esc(s.file_name)} from ${esc(s.student)}">${icon("Download", "icon-sm")}Download</a></td></tr>`);
  return pageHeader("Assignments", "Create coursework and collect submissions.")
    + card("Create an assignment", form("/api/teacher/item", subjectSelect() + field("Title", `<input name="title" required maxlength="160">`) + field("Due date", `<input name="date" type="date" required>`), "Create assignment", "assignment"))
    + card("Assignments", table(["Title", "Subject", "Due", ["Submitted", "num"], "Status", ["", "num"]], list, {noun: "assignment", empty: "No assignments for this selection."}), {tools: subjectFilter("data-assignment-subject-filter", teacherAssignmentSubject)})
    + card("Submissions", table(["Student / subject", "Assignment", "File", "Submitted", ["", "num"]], subs, {noun: "submission", empty: "No files submitted yet."}), {tools: searchBox("Search submissions", "Search submissions")});
}
function teacherExams() {
  const today = todayISO();
  const rows = data.exams.map(e => `<tr><td><b>${esc(e.subject)}</b></td><td>${esc(e.details)}</td><td>${esc(e.teacher || "Unassigned")}</td><td>${fmtDate(e.exam_date)}</td><td>${e.exam_date < today ? badge("Completed", "plain") : badge(`In ${plural(daysUntil(e.exam_date), "day")}`, "info")}</td><td class="actions">${deleteBtn("exam", e.id, `${e.subject} exam “${e.details}”`)}</td></tr>`);
  return pageHeader("Exams", "Examinations scheduled for your subjects.") + card("Schedule an exam", form("/api/teacher/item", subjectSelect() + field("Exam name", `<input name="details" required placeholder="e.g. Mid-semester exam">`) + field("Date", `<input name="date" type="date" required>`), "Schedule exam", "exam")) + card("Exam schedule", table(["Subject", "Exam", "Teacher", "Date", "Status", ["", "num"]], rows, {noun: "exam", empty: "No exams scheduled yet."}));
}

/* ---------- Student ---------- */
function studentAttendance() {
  const g = attendanceBySubject(data.student.attendance);
  const rows = g.map(a => {
    const p = a.total ? 100 * a.attended / a.total : 0, s = percentageStatus(p);
    const need = p >= 75 ? 0 : Math.ceil((75 * a.total - 100 * a.attended) / 25), safe = p < 75 ? 0 : Math.floor((100 * a.attended - 75 * a.total) / 75);
    return `<tr><td><b>${esc(a.subject)}</b></td><td class="num">${a.attended} / ${a.total}</td><td class="num"><span class="inline-meter">${pct(p, 0)}${meter(p, p >= 75 ? "" : "warning", 75)}</span></td><td>${badge(s.label, s.tone)}</td><td class="wrap">${need ? `Attend the next ${plural(need, "class", "classes")} without missing one` : `You can miss ${plural(safe, "class", "classes")} and stay at 75%`}</td></tr>`;
  });
  const below = g.filter(a => a.total && 100 * a.attended / a.total < 75).length;
  return pageHeader("Attendance", "Where you stand in each subject, and what it takes to stay above 75%.")
    + (below ? `<div class="alert warning">${icon("Alert", "icon-sm")}<span>${plural(below, "subject is", "subjects are")} below 75%. The guidance column shows how many classes in a row bring each one back.</span></div>` : g.length ? `<div class="alert success">${icon("Check", "icon-sm")}<span>Every subject is at or above 75%.</span></div>` : "")
    + card("By subject", table(["Subject", ["Attended", "num"], ["Percentage", "num"], "Status", "Guidance"], rows, {noun: "subject", empty: "No attendance recorded yet."}));
}
function studentMarks() {
  const rows = data.student.marks.map(m => { const s = percentageStatus(m.score); return `<tr><td><b>${esc(m.subject)}</b></td><td>${esc(m.assessment)}</td><td class="num">${esc(m.score)} / 100</td><td>${badge(s.label, s.tone)}</td><td>${fmtDate(m.date)}</td></tr>`; });
  const avgs = averageBySubject(data.student.marks, m => Number(m.score)).map(a => ({label: a.label, value: a.value, display: `${a.value.toFixed(1)} / 100`, tone: a.value >= 60 ? "" : "warning", ref: 60}));
  return pageHeader("Marks", "Every recorded assessment.", `<a class="btn btn-secondary" href="/report/${esc(myStudentId)}" target="_blank" rel="noopener">${icon("Report", "icon-sm")}Report card</a>`)
    + `<div class="grid-main">${card("Results", table(["Subject", "Assessment", ["Score", "num"], "Status", "Date"], rows, {noun: "result", empty: "No marks yet."}))}${card("Subject averages", progressList(avgs))}</div>`;
}
function studentAssignments() {
  const items = data.student.assignments, pending = items.filter(a => a.status !== "Submitted").length;
  const content = items.map(a => {
    const done = a.status === "Submitted", d = daysUntil(a.due_date);
    return `<article class="assignment-card"><div><h3>${esc(a.title)}</h3><p class="meta">${esc(a.subject)}, due ${fmtDate(a.due_date)} (${when(a.due_date)})</p></div>${done ? badge("Submitted", "success") : badge(d < 0 ? "Overdue" : "Pending", d < 0 ? "danger" : "warning")}
      <form class="upload-form" data-upload="${a.id}"><label class="sr-only" for="file-${a.id}">File for ${esc(a.title)}</label><input id="file-${a.id}" name="file" type="file" accept=".pdf,.doc,.docx,.txt" required><button type="submit" class="btn ${done ? "btn-secondary" : "btn-primary"} btn-sm">${icon("Upload", "icon-sm")}${done ? "Replace file" : "Submit file"}</button></form>
      ${a.file_name ? `<p class="submitted-file">${icon("File", "icon-sm")}${esc(a.file_name)}, submitted ${esc(String(a.submitted_at || "").replace("T", " "))}</p>` : ""}</article>`;
  }).join("");
  return pageHeader("Assignments", "PDF, DOC, DOCX or TXT, up to 10 MB.") + card("Your assignments", content ? `<div class="assignment-list">${content}</div>` : emptyState("No assignments yet.", "Assignments"), {sub: `${items.length - pending} of ${plural(items.length, "assignment")} submitted`});
}
function studentExams() {
  const today = todayISO();
  const rows = data.student.exams.map(e => `<tr><td><b>${esc(e.subject)}</b></td><td>${esc(e.details)}</td><td>${esc(e.teacher || "Unassigned")}</td><td>${fmtDate(e.exam_date)}</td><td>${e.exam_date < today ? badge("Completed", "plain") : badge(`In ${plural(daysUntil(e.exam_date), "day")}`, "info")}</td></tr>`);
  return pageHeader("Exams", "Your examination schedule.") + card("Schedule", table(["Subject", "Exam", "Teacher", "Date", "Status"], rows, {noun: "exam", empty: "No exams scheduled yet."}));
}
function studentFees() {
  const f = data.student.fees, bal = f.total - f.paid, p = f.total ? 100 * f.paid / f.total : 0;
  return pageHeader("Fees", "Your ledger, as recorded by the accounts office.")
    + `<div class="kpi-grid">${kpi("Total fee", money(f.total), "As recorded", "Fees")}${kpi("Paid", money(f.paid), f.total ? `${p.toFixed(0)}% of total` : "No fee recorded", "Check", {bar: {value: p, tone: "success"}})}${kpi("Balance", money(bal), bal > 0 ? "Remaining" : "Nothing outstanding", "Wallet", {brass: true})}${kpi("Due date", fmtDate(f.due_date), bal > 0 && f.due_date < todayISO() ? "Past due" : "Payment deadline", "Calendar")}</div>`
    + card("Payment progress", progressList([{label: "Paid so far", value: p, display: `${money(f.paid)} of ${money(f.total)}`, tone: bal <= 0 ? "success" : ""}]) + `<p class="card-caption">Online payment is not part of this prototype. Pay at the accounts office.</p>`, {tools: f.total ? feeStatus(f) : ""});
}
function studentRiskPage() {
  const s = data.student.stats;
  const slider = (name, label, id, value, hint) => `<div class="field"><span><label for="wf-${name}">${label}</label><output id="${id}" for="wf-${name}">${value}</output></span><input id="wf-${name}" name="${name}" type="range" min="0" max="100" step="1" value="${value}" aria-describedby="wf-${name}-hint"><span class="hint" id="wf-${name}-hint">${hint}</span></div>`;
  return pageHeader("Risk & what-if", "See what drives your indicator, and test how changes would move it.")
    + `<div class="grid-main">${card("What-if simulation", `<form id="what-if-form" class="form-grid" style="grid-template-columns:1fr">
        ${slider("average_marks", "Average marks (%)", "marks-output", s.average_marks, `Now ${pct(s.average_marks)}, reference 60%`)}
        ${slider("attendance", "Attendance (%)", "attendance-output", s.attendance, `Now ${pct(s.attendance)}, reference 75%`)}
        ${slider("assignment_completion", "Assignment completion (%)", "assignment-output", s.assignment_completion, `Now ${pct(s.assignment_completion)}, reference 70%`)}
        <div class="form-actions"><button type="submit" class="btn btn-primary" id="what-if-button">Check simulated risk</button></div></form>
        <div id="what-if-result" class="what-if-result" role="status" aria-live="polite"><div class="compare"><span>Current ${risk(s.risk.level)}</span></div><p class="muted">Move the sliders, then check.</p></div>`, {sub: "Runs the same Decision Tree on the values you choose"})}
      ${card("Current standing", `<div style="display:flex;justify-content:space-between;align-items:center;margin:-6px 0 18px"><span class="muted">Current indicator</span>${risk(s.risk.level)}</div>` + standingPanel(s) + `<h3 style="font-size:14px;margin:22px 0 10px">Why</h3><ul class="reasons">${s.risk.reasons.map(r => `<li class="${/at or above/.test(r) ? "" : "warn"}">${icon(/at or above/.test(r) ? "Check" : "Alert", "icon-sm")}<span>${esc(r)}</span></li>`).join("")}</ul>`)}</div>`
    + sourceNote("The Decision Tree is trained on synthetic, rule-generated examples. Simulations are indicative and are not saved.", false);
}

/* ---------- Insights ---------- */
function modelPage() {
  const m = data.model, students = data.students;
  const watch = students.filter(s => s.risk.level !== "Low").sort((a, b) => ({High: 0, Medium: 1}[a.risk.level] - {High: 0, Medium: 1}[b.risk.level]) || a.average_marks - b.average_marks);
  const rows = watch.map(s => `<tr><td>${personLink(s)}</td><td class="num">${pct(s.average_marks)}</td><td class="num">${pct(s.attendance)}</td><td class="num">${pct(s.assignment_completion)}</td><td>${risk(s.risk.level)}</td><td class="wrap">${esc(s.risk.reasons[0] || "")}</td></tr>`);
  const matrix = `<div class="table-wrap"><table class="matrix"><caption class="sr-only">Confusion matrix: actual rows, predicted columns</caption><thead><tr><th scope="col">Actual / predicted</th>${m.labels.map(l => `<th scope="col">${esc(l)}</th>`).join("")}</tr></thead><tbody>${m.confusion_matrix.map((row, i) => `<tr><th scope="row">${esc(m.labels[i])}</th>${row.map((n, j) => `<td class="num ${i === j ? "hit" : ""}">${n}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  return pageHeader("Academic risk", "Who may need support, and how the indicator model was evaluated.")
    + card("Students to check in with", table(["Student", ["Marks", "num"], ["Attendance", "num"], ["Assignments", "num"], "Risk", "Main reason"], rows, {noun: "student", empty: "No students are at medium or high risk."}), {sub: "High risk first. Select a name for the full profile.", tools: searchBox("Search students", "Search students")})
    + `<div class="grid-main">${card("Model evaluation", `<div class="stat-pair"><div class="mini"><span>Accuracy on held-out examples</span><b>${Math.round(m.accuracy * 100)}%</b></div><div class="mini"><span>Test examples</span><b>${m.test_rows}</b></div></div>${matrix}<div class="alert info" style="margin-top:16px">${icon("Info", "icon-sm")}<span>${esc(m.note)} Labels come from a weighted rule, so accuracy shows how well the tree learned that rule, not how it predicts real outcomes.</span></div>`, {sub: "Depth-4 Decision Tree on marks, attendance and assignment completion"})}${card("Risk distribution", riskRing(students))}</div>`;
}
function dataCenterPage() {
  const c = centerData, b = c.benchmark;
  const history = c.batches.map(r => `<tr><td><b>${esc(r.filename)}</b><span class="sub"><code>${esc(r.checksum.slice(0, 16))}…</code></span></td><td>${esc(r.kind)}</td><td class="wrap">${esc(r.source)}</td><td class="num">${r.row_count}</td><td>${esc(r.created_at)} UTC</td></tr>`);
  const prov = c.provenance.map(r => `<tr><td>${esc(r.kind)}</td><td class="wrap">${esc(r.source)} ${/demo|seed|legacy|unverified/i.test(r.source) ? badge("Demo, unverified", "warning") : ""}</td><td class="num">${r.records}</td></tr>`);
  const importer = role === "admin" ? card("Import college records", `<form class="form-grid" data-import-form>
      ${field("Dataset", `<select name="kind"><option value="marks">College marks (comma-separated CSV)</option><option value="attendance">College attendance (comma-separated CSV)</option><option value="benchmark">UCI benchmark (semicolon-separated CSV)</option></select>`)}
      ${field("Source", `<input name="source" maxlength="200" required placeholder="e.g. CSE marks register, Nov 2026">`)}
      ${field("CSV file", `<input type="file" name="file" accept=".csv,text/csv" required>`, {wide: true})}
      <div class="form-actions"><button type="submit" class="btn btn-primary">${icon("Upload", "icon-sm")}Validate and import</button><a class="btn btn-ghost btn-sm" href="/api/import-template/marks">${icon("Download", "icon-sm")}Marks template</a><a class="btn btn-ghost btn-sm" href="/api/import-template/attendance">${icon("Download", "icon-sm")}Attendance template</a></div></form>
      <p class="form-note">Students and subject codes must already exist. One bad row cancels the whole file, and the same file cannot be imported twice.</p>`, {sub: "Every row is validated before anything is saved"}) : "";
  const bench = card("Public research benchmark", `<div class="prose"><p><strong>UCI Student Performance</strong>: school reports from two Portuguese secondary schools, CC BY 4.0. Grades out of 20 are shown as percentages. This data stays separate from college records and does not train the risk model.</p></div>
      <p class="hint" style="margin-top:10px">Cortez, P. (2008). DOI 10.24432/C5TG7T</p>
      <div class="link-row"><a href="https://archive.ics.uci.edu/dataset/320/student+performance" target="_blank" rel="noopener noreferrer">Source and licence${icon("External", "icon-sm")}<span class="sr-only"> (opens in a new tab)</span></a><a href="https://archive.ics.uci.edu/static/public/320/student+performance.zip">Download dataset</a>${role === "admin" ? `<button class="btn btn-secondary btn-sm" data-fetch-uci>Import from UCI</button>` : ""}</div>
      <p id="import-feedback" class="form-note" role="status" aria-live="polite"></p>
      ${b ? `<div style="margin-top:18px;padding-top:18px;border-top:1px solid var(--line)"><div class="stat-pair"><div class="mini"><span>Course records</span><b>${b.records}</b></div><div class="mini"><span>Mean final grade</span><b>${b.final_grade}%</b></div></div>${progressList([{label: "First period", value: b.first_grade, tone: "brass"}, {label: "Second period", value: b.second_grade, tone: "brass"}, {label: "Final grade", value: b.final_grade}])}<p class="card-caption">Batch ${b.batch_id}. Average absences ${b.absences}.</p></div>` : `<div class="alert info" style="margin-top:14px">${icon("Info", "icon-sm")}<span>Not imported yet. Nothing is claimed until an import succeeds.</span></div>`}`, {sub: "Kept apart from college records"});
  return pageHeader("Data Center", "Where every record comes from: imports, declared sources and file fingerprints.")
    + `<div class="grid-main"><div class="stack">${importer}${card("Record sources", table(["Dataset", "Declared source", ["Records", "num"]], prov, {noun: "source"}), {sub: "Older records cannot be verified after the fact."})}</div>${bench}</div>`
    + card("Import history", table(["File / SHA-256", "Type", "Source", ["Rows", "num"], "Imported"], history, {noun: "import", empty: "No files imported yet."}), {sub: "Each file is fingerprinted so duplicates are rejected."});
}
function reportsPage() {
  const scope = role === "student" ? "your" : role === "teacher" ? "your subjects'" : "all college";
  const exp = [["marks", "Assessment results", "Marks"], ["attendance", "Attendance register", "Attendance"]].map(([k, t, ic]) => `<article class="card action-card"><span class="kpi-icon">${icon(ic, "icon-sm")}</span><h2>${t}</h2><p>A CSV of ${scope} ${k} with dates and sources.</p><a class="btn btn-secondary btn-sm" href="/api/export/${k}">${icon("Download", "icon-sm")}Download CSV</a></article>`).join("");
  const third = role === "student" ? `<article class="card action-card"><span class="kpi-icon brass">${icon("Report", "icon-sm")}</span><h2>Report card</h2><p>A printable summary of your results, attendance and risk indicators.</p><a class="btn btn-secondary btn-sm" href="/report/${esc(myStudentId)}" target="_blank" rel="noopener">${icon("Printer", "icon-sm")}Open report card</a></article>`
    : `<article class="card action-card"><span class="kpi-icon brass">${icon("Report", "icon-sm")}</span><h2>Student report cards</h2><p>Open any student's profile and choose Report card for a printable copy.</p><button class="btn btn-secondary btn-sm" data-page="${role === "admin" ? "Students" : "AI Risk"}">Find a student</button></article>`;
  const act = role === "student" ? "" : card(`${role === "admin" ? "Workspace" : "Your"} activity`, centerData.activity.length ? `<div class="activity">${centerData.activity.map(a => `<div class="activity-row"><span class="avatar">${esc(initials(a.actor || "?"))}</span><div>${esc(a.action)}<small>${esc(a.actor || "User")}</small></div><time>${timeAgo(a.created_at)}</time></div>`).join("")}</div>` : emptyState("Changes will appear here as they happen.", "Pulse"), {sub: "Updates live as changes are made."});
  return pageHeader("Reports & activity", "Exports, report cards and a live log of changes.") + `<div class="grid-3">${exp}${third}</div>${act}`;
}
function guidePage() {
  const li = (items, warn) => `<ul class="reasons">${items.map(t => `<li class="${warn ? "warn" : ""}">${icon(warn ? "Alert" : "Check", "icon-sm")}<span>${t}</span></li>`).join("")}</ul>`;
  return pageHeader("Project guide", "Problem, scope, architecture and limits, for the demonstration and viva.")
    + `<div class="grid-2">${card("The problem", `<div class="prose"><p>Academic records sit in separate registers, so students who are slipping are noticed late. EduSense brings marks, attendance, coursework and fees together, and adds explainable early-warning indicators with a traceable path from source data to dashboard.</p></div>`)}
      ${card("Architecture", `<ol class="reasons" style="list-style:none">${["Forms and validated CSV imports, checked against role permissions", "SQLite, served through a Flask JSON API with security headers and rate-limited sign-in", "Server-Sent Events push every change to open dashboards in real time", "Decision Tree risk indicators with a what-if simulator and printable report cards"].map((t, i) => `<li><span class="badge info plain" style="min-width:24px;justify-content:center">${i + 1}</span><span>${t}</span></li>`).join("")}</ol>`)}</div>`
    + card("Existing solutions and scope", `<div class="table-wrap"><table><thead><tr><th scope="col">System</th><th scope="col">Established capabilities</th><th scope="col">Positioning</th></tr></thead><tbody>
      <tr><td><a href="https://fedena.com/feature-tour" target="_blank" rel="noopener noreferrer">Fedena</a></td><td class="wrap">Attendance, timetable, exams, finance, transport, library and administration.</td><td class="wrap">A broad institution ERP. EduSense does not claim feature parity.</td></tr>
      <tr><td><a href="https://docs.frappe.io/education/introduction" target="_blank" rel="noopener noreferrer">Frappe Education</a></td><td class="wrap">Students, curriculum, fees, attendance and a student portal within ERPNext.</td><td class="wrap">A mature open-source platform with wider ERP integration.</td></tr>
      <tr><td><b>EduSense</b></td><td class="wrap">Three role workspaces, one-tap attendance sessions, marks, file submissions, exams, timetable, fee ledger, notices, CSV imports, live updates, report cards.</td><td class="wrap">A focused prototype with explainable risk indicators, what-if simulation and explicit data provenance.</td></tr>
      </tbody></table></div><p class="card-caption">Based on official documentation reviewed in November 2026. No claim of unique invention.</p>`)
    + `<div class="grid-2">${card("What works today", li(["Real-time updates across every open workspace.", "Whole-class attendance in one step, with corrections.", "Validated, all-or-nothing CSV imports with fingerprints.", "Role-scoped exports, activity log and printable report cards.", "Hardened sign-in: rate limiting, 8-hour sessions, persistent keys.", "Light and dark themes, keyboard search, accessible markup."]))}
      ${card("Known limitations", li(["The risk model is trained on synthetic labels; its accuracy is not real-world evidence.", "No per-subject enrolment: every student is counted in every subject.", "Admissions, payroll, hostel, transport, library and online payment are out of scope.", "A real rollout needs HTTPS, backups, monitoring and consented institutional data."], true))}</div>`;
}

const pages = {
  Overview: overview, Dashboard: overview, Students: adminStudents, Teachers: adminTeachers, Subjects: adminSubjects,
  Fees: () => role === "admin" ? adminFees() : studentFees(), Notices: () => noticesPage(role !== "student"),
  Attendance: () => role === "teacher" ? teacherAttendance() : studentAttendance(),
  Marks: () => role === "teacher" ? teacherMarks() : studentMarks(),
  Assignments: () => role === "teacher" ? teacherAssignments() : studentAssignments(),
  Exams: () => role === "teacher" ? teacherExams() : studentExams(),
  Timetable: timetablePage, "AI Risk": modelPage, "Data Center": dataCenterPage, Reports: reportsPage, "Project Guide": guidePage, "Risk & What-if": studentRiskPage, Account: accountPage
};

/* ---------- Shell ---------- */
function drawNav() {
  const nav = document.getElementById("nav");
  const counts = {"AI Risk": role !== "student" && data.students ? riskCounts(data.students).High : 0, Assignments: role === "student" && data.student ? data.student.assignments.filter(a => a.status !== "Submitted").length : 0};
  nav.innerHTML = navGroups[role].map(([label, items]) => { const id = "nav-" + label.replace(/\W+/g, "-"); return `<div class="nav-group"><p class="nav-label" id="${id}">${esc(label)}</p><div role="list" aria-labelledby="${id}">${items.map(item => `<div role="listitem"><button class="nav-item ${item === page ? "active" : ""}" data-page="${esc(item)}" ${item === page ? 'aria-current="page"' : ""}>${icon(item)}<span>${esc(item)}</span>${counts[item] ? `<span class="nav-count" aria-label="${counts[item]} need attention">${counts[item]}</span>` : ""}</button></div>`).join("")}</div></div>`; }).join("");
  document.getElementById("identity").textContent = `Signed in as ${userName}`;
  if (typeof document.title === "string") document.title = `${page} · EduSense AI`;
}
function drawPage() {
  drawNav();
  formDirty = false;
  app.innerHTML = pages[page] ? pages[page]() : overview();
}
function goTo(target) {
  if (!pages[target] || !navByRole[role].includes(target)) return;
  page = target; drawPage(); closeSidebar();
  window.scrollTo(0, 0); app.focus({preventScroll: true});
}
async function fetchData() {
  const results = await Promise.all([api("/api/summary"), role === "student" ? Promise.resolve(null) : api("/api/data-center")]);
  data = results[0];
  if (results[1]) centerData = results[1];
}
async function load(keepPage = true) {
  try {
    await fetchData();
    if (!keepPage || !navByRole[role].includes(page)) page = navByRole[role][0];
    drawPage();
    if (!feed.length) seedFeed();
    if (!liveSource && typeof EventSource !== "undefined") connectLive();
  } catch (error) {
    app.innerHTML = card("Your workspace couldn't load", `<div class="alert error">${icon("Alert", "icon-sm")}<span>${esc(error.message)}</span></div><div class="form-actions" style="margin-top:16px"><button class="btn btn-primary" data-retry>Try again</button><a class="btn btn-secondary" href="/login">Sign in again</a></div>`);
  } finally {
    app.setAttribute("aria-busy", "false");
  }
}

/* ---------- Real time ---------- */
function setLive(state) {
  const node = document.getElementById("live-state");
  node.className = `live ${state}`;
  node.innerHTML = `<span>${state === "on" ? "Live" : state === "off" ? "Offline" : "Connecting"}</span>`;
  node.title = state === "on" ? "Changes from other users appear automatically" : state === "off" ? "Live updates paused. Reconnecting…" : "Connecting to live updates";
}
function connectLive() {
  liveSource = new EventSource("/api/stream");
  liveSource.onopen = () => { clearTimeout(liveTimer); setLive("on"); };
  liveSource.onerror = () => { clearTimeout(liveTimer); liveTimer = setTimeout(() => { if (liveSource.readyState !== 1) setLive("off"); }, 6000); };
  liveSource.addEventListener("change", event => {
    let item; try { item = JSON.parse(event.data); } catch (e) { return; }
    const mine = item.actor === userName && item.actor_role === role;
    if (!mine) {
      feed.unshift({...item, fresh: true});
      feed = feed.slice(0, 40);
      unread++; updateBell();
      toast(item.actor ? `${item.actor} ${lowerFirst(item.action)}` : "Records were updated", "live", "Updated live");
    }
    scheduleRefresh();
  });
}
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      await fetchData();
      const busy = formDirty || document.querySelector("dialog[open]") || (app.contains(document.activeElement) && document.activeElement.matches("input, textarea, select"));
      if (busy) { showUpdateBanner(); drawNav(); return; }
      const y = window.scrollY; drawPage(); window.scrollTo(0, y);
    } catch (e) { /* the next event retries */ }
  }, 500);
}
function showUpdateBanner() {
  if (document.getElementById("update-banner")) return;
  app.insertAdjacentHTML("afterbegin", `<div class="update-banner" id="update-banner" role="status"><span>New changes arrived while you were typing.</span><button class="btn btn-secondary btn-sm" data-apply-update>Show latest</button></div>`);
}
function seedFeed() {
  feed = role === "student"
    ? (data.student.notices || []).slice(0, 8).map(n => ({action: `Notice: ${n.title}`, created_at: n.date, actor: ""}))
    : (centerData.activity || []).slice(0, 15).map(a => ({...a}));
}
function updateBell() {
  const dot = document.getElementById("bell-count");
  dot.hidden = !unread; dot.textContent = unread > 9 ? "9+" : String(unread);
  document.getElementById("bell").setAttribute("aria-label", unread ? `Notifications, ${unread} new` : "Notifications");
}
function renderBell() {
  const panel = document.getElementById("bell-panel");
  panel.innerHTML = `<div class="popover-head"><h2>${role === "student" ? "Updates and notices" : "Live activity"}</h2><button class="btn btn-ghost btn-sm" data-page="${role === "student" ? "Notices" : "Reports"}">See all</button></div><div class="popover-list">${feed.length ? feed.map(f => `<div class="feed-item ${f.fresh ? "new" : ""}"><div>${esc(f.actor ? `${f.actor} ${lowerFirst(f.action)}` : f.action)}<small>${/^\d{4}-\d{2}-\d{2}$/.test(f.created_at || "") ? fmtDate(f.created_at) : f.created_at ? timeAgo(f.created_at) : "Just now"}</small></div></div>`).join("") : emptyState("Nothing yet. Changes appear here live.", "Pulse")}</div>`;
}
function toggleBell(force) {
  const panel = document.getElementById("bell-panel"), button = document.getElementById("bell");
  const open = force ?? panel.hidden;
  if (open) { renderBell(); unread = 0; updateBell(); feed.forEach(f => { f.fresh = false; }); }
  panel.hidden = !open; button.setAttribute("aria-expanded", String(open));
}

/* ---------- Theme ---------- */
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem("edusense-theme", theme); } catch (e) {}
  const btn = document.getElementById("theme-toggle");
  btn.innerHTML = icon(theme === "dark" ? "Sun" : "Moon");
  btn.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
  btn.title = btn.getAttribute("aria-label");
}

/* ---------- Command palette ---------- */
let paletteItems = [], paletteIndex = 0;
function paletteSource(query) {
  const q = query.trim().toLowerCase(), out = [];
  const pagesList = navByRole[role].map(p => ({group: "Pages", label: p, icon: p, run: () => goTo(p)}));
  const actions = [
    {group: "Actions", label: currentTheme() === "dark" ? "Switch to light theme" : "Switch to dark theme", icon: "Moon", run: () => applyTheme(currentTheme() === "dark" ? "light" : "dark")},
    ...(role === "teacher" ? [{group: "Actions", label: "Take attendance", icon: "Attendance", run: () => goTo("Attendance")}, {group: "Actions", label: "Enter marks", icon: "Marks", run: () => goTo("Marks")}] : []),
    ...(role !== "student" ? [{group: "Actions", label: "Publish a notice", icon: "Notices", run: () => goTo("Notices")}] : [{group: "Actions", label: "Open my report card", icon: "Report", run: () => window.open(`/report/${myStudentId}`, "_blank", "noopener")}]),
    {group: "Actions", label: "Change password", icon: "Account", run: () => goTo("Account")},
    {group: "Actions", label: "Sign out", icon: "Logout", run: () => { window.location.href = "/logout"; }}
  ];
  const people = role !== "student" ? (data.students || []).map(s => ({group: "Students", label: s.name, hint: `${s.roll_no}, ${s.risk.level} risk`, icon: "Students", run: () => openStudent(s.id)})) : [];
  for (const item of [...pagesList, ...people, ...actions]) {
    if (!q || item.label.toLowerCase().includes(q) || (item.hint || "").toLowerCase().includes(q)) out.push(item);
  }
  const limited = []; const perGroup = {};
  out.forEach(i => { perGroup[i.group] = (perGroup[i.group] || 0) + 1; if (perGroup[i.group] <= (q ? 8 : 5)) limited.push(i); });
  return limited;
}
function renderPalette() {
  const list = document.getElementById("palette-list"), input = document.getElementById("palette-input");
  paletteItems = paletteSource(input.value);
  paletteIndex = Math.min(paletteIndex, Math.max(0, paletteItems.length - 1));
  let group = "";
  list.innerHTML = paletteItems.length ? paletteItems.map((item, i) => { const head = item.group !== group ? `<li class="palette-group" role="presentation">${esc(item.group)}</li>` : ""; group = item.group; return `${head}<li role="presentation"><button type="button" class="palette-item" role="option" id="pal-${i}" data-pal="${i}" aria-selected="${i === paletteIndex}" tabindex="-1">${icon(item.icon, "icon-sm")}<span>${esc(item.label)}</span>${item.hint ? `<small>${esc(item.hint)}</small>` : ""}</button></li>`; }).join("")
    : `<li class="palette-group" role="presentation">No matches for “${esc(input.value)}”</li>`;
  input.setAttribute("aria-activedescendant", paletteItems.length ? `pal-${paletteIndex}` : "");
  document.getElementById(`pal-${paletteIndex}`)?.scrollIntoView({block: "nearest"});
}
function openPalette() {
  const dialog = document.getElementById("palette"), input = document.getElementById("palette-input");
  input.value = ""; paletteIndex = 0; renderPalette();
  if (!dialog.open) dialog.showModal();
  input.focus();
}
function runPalette(i) {
  const item = paletteItems[i]; if (!item) return;
  document.getElementById("palette").close();
  item.run();
}

/* ---------- Student drawer ---------- */
async function openStudent(id) {
  const drawer = document.getElementById("student-drawer");
  drawer.innerHTML = `<div class="drawer-head"><h2 id="drawer-title">Loading profile…</h2><button type="button" class="icon-btn" data-close-drawer aria-label="Close profile">${icon("X")}</button></div><div class="drawer-body"><div class="sk"></div><div class="sk"></div></div>`;
  if (!drawer.open) drawer.showModal();
  try {
    const r = await api(`/api/student/${id}`);
    const p = r.profile, s = r.stats, bal = r.fees.total - r.fees.paid;
    const subj = {};
    r.marks.forEach(m => { (subj[m.subject] ||= {marks: [], att: 0, tot: 0}).marks.push(m.score); });
    r.attendance.forEach(a => { const x = subj[a.subject] ||= {marks: [], att: 0, tot: 0}; x.att += a.attended; x.tot += a.total; });
    const rows = Object.entries(subj).sort().map(([code, v]) => { const avg = v.marks.length ? v.marks.reduce((a, b) => a + b, 0) / v.marks.length : null, at = v.tot ? 100 * v.att / v.tot : null; return `<tr><th scope="row">${esc(code)}</th><td class="num">${avg == null ? "—" : avg.toFixed(1)}</td><td class="num"><span class="inline-meter">${at == null ? "—" : pct(at, 0)}${at == null ? "" : meter(at, at >= 75 ? "" : "warning", 75)}</span></td></tr>`; }).join("");
    const pending = r.assignments.filter(a => a.status !== "Submitted").length;
    drawer.innerHTML = `<div class="drawer-head"><span class="avatar lg">${esc(initials(p.name))}</span><div><h2 id="drawer-title">${esc(p.name)}</h2><p>${esc(p.roll_no)}, ${esc(p.class_name)}${p.username ? `, username ${esc(p.username)}` : ""}</p></div><button type="button" class="icon-btn" data-close-drawer aria-label="Close profile">${icon("X")}</button></div>
      <div class="drawer-body">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><span>Risk indicator ${risk(s.risk.level)}</span><span class="form-actions"><a class="btn btn-primary btn-sm" href="/report/${p.id}" target="_blank" rel="noopener">${icon("Report", "icon-sm")}Report card</a>${role === "admin" ? `<button class="btn btn-secondary btn-sm" data-edit-from-drawer="${p.id}">Edit account</button>` : ""}</span></div>
        <div class="mini-stats"><div class="mini"><span>Average marks</span><b>${pct(s.average_marks)}</b></div><div class="mini"><span>Attendance</span><b>${pct(s.attendance)}</b></div><div class="mini"><span>Assignments submitted</span><b>${pct(s.assignment_completion, 0)}</b></div><div class="mini"><span>Fee balance</span><b>${money(bal)}</b></div></div>
        <section><h3>Why this indicator</h3><ul class="reasons">${s.risk.reasons.map(x => `<li class="${/at or above/.test(x) ? "" : "warn"}">${icon(/at or above/.test(x) ? "Check" : "Alert", "icon-sm")}<span>${esc(x)}</span></li>`).join("")}</ul></section>
        <section><h3>By subject</h3>${rows ? `<div class="table-wrap"><table><thead><tr><th scope="col">Subject</th><th scope="col" class="num">Avg. marks</th><th scope="col" class="num">Attendance</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("No records yet.")}</section>
        <section><h3>Coursework</h3><p class="muted">${pending ? `${plural(pending, "assignment")} not submitted.` : "Every assignment submitted."} Fee due ${fmtDate(r.fees.due_date)}.</p></section>
      </div>`;
    drawer.querySelector("[data-close-drawer]").focus();
  } catch (error) {
    drawer.querySelector(".drawer-body").innerHTML = `<div class="alert error">${icon("Alert", "icon-sm")}<span>${esc(error.message)}</span></div>`;
  }
}

/* ---------- Confirm ---------- */
function confirmAction(title, text, yes = "Delete") {
  const dialog = document.getElementById("confirm-dialog");
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-text").textContent = text;
  document.getElementById("confirm-yes").textContent = yes;
  dialog.showModal();
  return new Promise(resolve => {
    const done = value => { dialog.removeEventListener("close", onClose); dialog.querySelectorAll("[data-confirm]").forEach(b => { b.onclick = null; }); if (dialog.open) dialog.close(); resolve(value); };
    const onClose = () => done(false);
    dialog.addEventListener("close", onClose);
    dialog.querySelector('[data-confirm="yes"]').onclick = () => done(true);
    dialog.querySelector('[data-confirm="no"]').onclick = () => done(false);
  });
}

/* ---------- Helpers ---------- */
function openSidebar() {
  document.getElementById("sidebar").classList.add("open"); document.getElementById("scrim").classList.add("show");
  const b = document.getElementById("menu-button"); b.setAttribute("aria-expanded", "true"); b.setAttribute("aria-label", "Close navigation");
  document.querySelector("#nav .nav-item.active")?.focus();
}
function closeSidebar() {
  const sidebar = document.getElementById("sidebar"), was = sidebar.classList.contains("open");
  sidebar.classList.remove("open"); document.getElementById("scrim").classList.remove("show");
  const b = document.getElementById("menu-button"); b.setAttribute("aria-expanded", "false"); b.setAttribute("aria-label", "Open navigation");
  return was;
}
function setBusy(button, busy, text) {
  if (!button) return;
  if (busy) { button.dataset.label = button.innerHTML; button.disabled = true; button.textContent = text || "Saving…"; }
  else { button.disabled = false; if (button.dataset.label) button.innerHTML = button.dataset.label; }
}
function applyTableSearch(input) {
  const scope = input.closest(".card") || app, q = input.value.trim().toLowerCase();
  let visible = 0;
  scope.querySelectorAll("tbody tr").forEach(row => {
    const match = row.textContent.toLowerCase().includes(q);
    row.hidden = q ? !match : (row.dataset.overflow === "1" && !showAllStudents);
    if (!row.hidden) visible++;
  });
  const count = scope.querySelector("[data-count]");
  if (count) { const total = Number(count.dataset.total), noun = count.dataset.noun; count.textContent = q ? `Showing ${visible} of ${plural(total, noun)}` : plural(total, noun); }
  const more = scope.querySelector("[data-show-students]"); if (more) more.hidden = Boolean(q);
}
function updateRosterCount() {
  const form = document.getElementById("roster-form"); if (!form) return;
  const boxes = form.querySelectorAll("input[name=present]"), on = [...boxes].filter(b => b.checked).length;
  form.querySelectorAll(".roster .state").forEach((s, i) => { s.textContent = boxes[i].checked ? "Present" : "Absent"; });
  document.getElementById("roster-count").innerHTML = `<b>${on}</b> of ${boxes.length} present`;
}

/* ---------- Events ---------- */
document.addEventListener("click", async event => {
  const t = event.target;
  if (!t.closest("#bell-panel") && !t.closest("#bell") && !document.getElementById("bell-panel").hidden) toggleBell(false);
  if (t.closest("#bell")) { toggleBell(); return; }
  if (t.closest("[data-show-students]")) { showAllStudents = !showAllStudents; drawPage(); document.querySelector("[data-show-students]")?.focus(); return; }
  if (t.closest("[data-retry]")) { await load(); return; }
  if (t.closest("[data-apply-update]")) { const y = window.scrollY; drawPage(); window.scrollTo(0, y); return; }
  if (t.closest("[data-print]")) { window.print(); return; }
  if (t.closest("[data-close-drawer]")) { document.getElementById("student-drawer").close(); return; }
  if (t === document.getElementById("student-drawer")) { t.close(); return; }
  if (t === document.getElementById("palette")) { t.close(); return; }
  const pal = t.closest("[data-pal]"); if (pal) { runPalette(Number(pal.dataset.pal)); return; }
  if (t.closest("#cmd-trigger")) { openPalette(); return; }
  if (t.closest("#theme-toggle")) { applyTheme(currentTheme() === "dark" ? "light" : "dark"); if (page === "Account") drawPage(); return; }
  const studentBtn = t.closest("button[data-student]"); if (studentBtn) { openStudent(studentBtn.dataset.student); return; }
  const fromDrawer = t.closest("[data-edit-from-drawer]");
  if (fromDrawer) { const s = data.students.find(x => String(x.id) === fromDrawer.dataset.editFromDrawer); document.getElementById("student-drawer").close(); goTo("Students"); if (s) document.querySelector(`[data-edit-user="${s.user_id}"]`)?.click(); return; }
  const roster = t.closest("[data-roster]");
  if (roster) { document.querySelectorAll("#roster-form input[name=present]").forEach(b => { b.checked = roster.dataset.roster === "all"; }); updateRosterCount(); return; }
  if (t.closest("[data-fetch-uci]")) {
    const button = t.closest("[data-fetch-uci]"); setBusy(button, true, "Connecting to UCI…");
    try { const r = await api("/api/admin/import-uci", {method: "POST"}); toast(r.message); await load(); }
    catch (error) { toast(error.message, "error"); const fb = document.getElementById("import-feedback"); if (fb) fb.textContent = error.message; setBusy(button, false); }
    return;
  }
  if (t.closest("[data-dialog-cancel]")) { document.getElementById("attendance-dialog").close(); return; }
  const del = t.closest("[data-delete]");
  if (del) {
    const kind = del.dataset.delete, id = del.dataset.id;
    const ok = await confirmAction(kind === "timetable" ? "Remove this class?" : `Delete this ${kind}?`, `This permanently removes the ${del.dataset.label}. It cannot be undone.`, kind === "timetable" ? "Remove class" : "Delete");
    if (!ok) return;
    try { const r = await api(kind === "notice" ? `/api/notice/${id}` : `/api/teacher/item/${kind}/${id}`, {method: "DELETE"}); toast(r.message); await load(); }
    catch (error) { toast(error.message, "error"); }
    return;
  }
  const nav = t.closest("[data-page]");
  if (nav) { event.preventDefault(); toggleBell(false); goTo(nav.dataset.page); return; }
  const edit = t.closest("[data-edit-user]");
  if (edit) {
    const teacher = edit.dataset.role === "teacher";
    const account = teacher ? data.teachers.find(x => x.user_id === Number(edit.dataset.editUser)) : data.students.find(x => x.user_id === Number(edit.dataset.editUser));
    const f = document.querySelector("[data-user-form]"); if (!account || !f) return;
    for (const key of ["name", "username", "roll_no", "class_name"]) if (f.elements[key] && account[key]) f.elements[key].value = account[key];
    f.elements.user_id.value = account.user_id; f.elements.password.value = ""; f.elements.password.required = false;
    f.querySelector(".save-account").textContent = `Save ${teacher ? "teacher" : "student"}`;
    f.querySelector(".cancel-edit").hidden = false;
    const h = f.closest(".card").querySelector("h2"); if (h) h.textContent = `Editing ${account.name}`;
    formDirty = true;
    f.scrollIntoView({behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center"});
    f.elements.name.focus({preventScroll: true});
    return;
  }
  if (t.closest(".cancel-edit")) { drawPage(); return; }
  const saveSubject = t.closest("[data-save-subject]");
  if (saveSubject) {
    const id = saveSubject.dataset.saveSubject, teacherId = document.querySelector(`[data-subject-teacher="${id}"]`).value;
    setBusy(saveSubject, true);
    try { const r = await api(`/api/admin/subject/${id}`, jsonBody("PUT", {teacher_id: teacherId})); toast(r.message); await load(); }
    catch (error) { toast(error.message, "error"); setBusy(saveSubject, false); }
    return;
  }
  const ea = t.closest("[data-edit-attendance]");
  if (ea) {
    const dialog = document.getElementById("attendance-dialog"), f = document.getElementById("attendance-dialog-form");
    attendanceEditId = ea.dataset.editAttendance;
    f.elements.attended.value = ea.dataset.attended; f.elements.total.value = ea.dataset.total;
    f.elements.attended.removeAttribute("aria-invalid"); f.elements.total.removeAttribute("aria-invalid");
    document.getElementById("attendance-dialog-desc").textContent = ea.dataset.label || "";
    document.getElementById("attendance-dialog-error").textContent = "";
    dialog.showModal(); f.elements.attended.focus();
  }
});

document.addEventListener("submit", async event => {
  const f = event.target;
  if (f.id === "attendance-dialog-form") {
    event.preventDefault();
    const a = f.elements.attended.value.trim(), tt = f.elements.total.value.trim(), err = document.getElementById("attendance-dialog-error"), A = Number(a), T = Number(tt);
    let msg = "";
    if (a === "" || !Number.isInteger(A) || A < 0) msg = "Enter a whole number of attended classes (0 or more).";
    else if (tt === "" || !Number.isInteger(T) || T <= 0) msg = "Enter a whole number of total classes (at least 1).";
    else if (A > T) msg = "Attended classes cannot be more than total classes.";
    f.elements.attended.toggleAttribute("aria-invalid", /attended classes \(/.test(msg) || /more than/.test(msg));
    f.elements.total.toggleAttribute("aria-invalid", /total classes \(/.test(msg) || /more than/.test(msg));
    err.textContent = msg; if (msg) return;
    const b = f.querySelector("button[type=submit]"); setBusy(b, true);
    try { const r = await api(`/api/teacher/attendance/${attendanceEditId}`, jsonBody("PUT", {attended: A, total: T})); document.getElementById("attendance-dialog").close(); toast(r.message); await load(); }
    catch (error) { err.textContent = error.message; } finally { setBusy(b, false); }
    return;
  }
  if (f.id === "roster-form") {
    event.preventDefault();
    const present = [...f.querySelectorAll("input[name=present]:checked")].map(b => Number(b.value)), b = f.querySelector("button[type=submit]");
    setBusy(b, true);
    try { const r = await api("/api/teacher/attendance/session", jsonBody("POST", {subject_id: Number(f.elements.subject_id.value), present})); toast(r.message); await load(); }
    catch (error) { toast(error.message, "error"); setBusy(b, false); }
    return;
  }
  if (f.id === "password-form") {
    event.preventDefault();
    const err = document.getElementById("password-error"), cur = f.elements.current.value, nw = f.elements.new.value, cf = f.elements.confirm.value;
    let msg = "";
    if (!cur) msg = "Enter your current password.";
    else if (nw.length < 8 || /^\d+$/.test(nw) || /^[A-Za-z]+$/.test(nw)) msg = "Use at least 8 characters with both letters and numbers.";
    else if (nw !== cf) msg = "The new passwords do not match.";
    err.textContent = msg; if (msg) return;
    const b = f.querySelector("button[type=submit]"); setBusy(b, true);
    try { const r = await api("/api/account/password", jsonBody("POST", {current: cur, new: nw})); toast(r.message); f.reset(); formDirty = false; }
    catch (error) { err.textContent = error.message; } finally { setBusy(b, false); }
    return;
  }
  if (f.matches("[data-import-form]")) {
    event.preventDefault();
    const b = f.querySelector("button[type=submit]"), fb = document.getElementById("import-feedback"); setBusy(b, true, "Validating…");
    try { const r = await api("/api/admin/import", {method: "POST", body: new FormData(f)}); toast(r.message); await load(); }
    catch (error) { if (fb) fb.textContent = error.message; toast(error.message, "error"); setBusy(b, false); }
    return;
  }
  if (f.id === "what-if-form") {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(f)); for (const k in values) values[k] = Number(values[k]);
    const b = document.getElementById("what-if-button"), box = document.getElementById("what-if-result"); setBusy(b, true, "Checking…");
    try {
      const r = await api("/api/student/what-if", jsonBody("POST", values));
      box.innerHTML = `<div class="compare"><span>Current ${risk(r.current.level)}</span>${icon("ArrowRight", "icon-sm")}<span>Simulated ${risk(r.simulated.level)}</span></div><p class="muted">${r.current.level !== r.simulated.level ? "These values would change your indicator." : "These values keep the same indicator."}</p><ul class="reasons" style="margin-top:10px">${(r.simulated.reasons || []).map(x => `<li class="${/at or above/.test(x) ? "" : "warn"}">${icon(/at or above/.test(x) ? "Check" : "Alert", "icon-sm")}<span>${esc(x)}</span></li>`).join("")}</ul>`;
    } catch (error) { box.innerHTML = `<div class="alert error">${icon("Alert", "icon-sm")}<span>${esc(error.message)}</span></div>`; toast(error.message, "error"); }
    finally { setBusy(b, false); formDirty = false; }
    return;
  }
  if (!f.matches("form[data-url],form[data-user-form],form[data-upload]")) return;
  event.preventDefault();
  const b = f.querySelector("button[type=submit]"); setBusy(b, true);
  try {
    let r;
    if (f.dataset.upload) r = await api(`/api/student/submit/${f.dataset.upload}`, {method: "POST", body: new FormData(f)});
    else {
      const values = Object.fromEntries(new FormData(f));
      let endpoint = f.dataset.url, method = "POST";
      if (f.dataset.kind) values.kind = f.dataset.kind;
      if (f.dataset.userForm) { endpoint = "/api/admin/user"; if (values.user_id) { endpoint = `/api/admin/user/${values.user_id}`; method = "PUT"; } delete values.user_id; }
      r = await api(endpoint, jsonBody(method, values));
    }
    toast(r.message); formDirty = false; await load();
  } catch (error) { toast(error.message, "error"); setBusy(b, false); }
});

document.addEventListener("input", event => {
  const t = event.target;
  if (t.matches("[data-table-search]")) { applyTableSearch(t); return; }
  if (t.id === "palette-input") { paletteIndex = 0; renderPalette(); return; }
  if (t.closest("#app form") && !t.closest("#roster-form")) formDirty = true;
  const wf = t.closest("#what-if-form");
  if (wf) { const s = t.name === "average_marks" ? "marks" : t.name === "attendance" ? "attendance" : "assignment"; const o = document.getElementById(`${s}-output`); if (o) o.textContent = t.value; }
});
document.addEventListener("change", event => {
  const t = event.target;
  if (t.matches("[data-attendance-subject-filter]")) { teacherAttendanceSubject = t.value; drawPage(); document.querySelector("[data-attendance-subject-filter]")?.focus(); }
  if (t.matches("[data-assignment-subject-filter]")) { teacherAssignmentSubject = t.value; drawPage(); document.querySelector("[data-assignment-subject-filter]")?.focus(); }
  if (t.id === "roster-subject") rosterSubject = t.value;
  if (t.matches("#roster-form input[name=present]")) updateRosterCount();
  if (t.name === "theme-choice") applyTheme(t.value);
});
document.addEventListener("keydown", event => {
  const palette = document.getElementById("palette");
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); palette.open ? palette.close() : openPalette(); return; }
  if (palette.open && ["ArrowDown", "ArrowUp", "Enter"].includes(event.key) && document.activeElement.id === "palette-input") {
    event.preventDefault();
    if (event.key === "Enter") { runPalette(paletteIndex); return; }
    paletteIndex = (paletteIndex + (event.key === "ArrowDown" ? 1 : -1) + paletteItems.length) % Math.max(1, paletteItems.length);
    renderPalette(); return;
  }
  if (event.key === "Escape") {
    if (!document.getElementById("bell-panel").hidden) { toggleBell(false); document.getElementById("bell").focus(); return; }
    if (closeSidebar()) document.getElementById("menu-button").focus();
  }
});
document.getElementById("menu-button").addEventListener("click", () => { document.getElementById("sidebar").classList.contains("open") ? closeSidebar() : openSidebar(); });
document.getElementById("scrim").addEventListener("click", closeSidebar);
if (typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "")) document.getElementById("cmd-key").textContent = "⌘ K";
if (document.documentElement) applyTheme(currentTheme());
load(false);
