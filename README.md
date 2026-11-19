# EduSense AI — campus workspace

A local Flask + SQLite college ERP prototype with Admin, Teacher and Student portals.
The redesigned interface uses local CSS, inline SVG charts and plain JavaScript;
no frontend build or external asset service is required.

## Design

Minimal black and white: black ink on white paper, one typeface (DM Sans,
bundled under SIL OFL 1.1 in `static/fonts`). Status is shown by form rather
than colour: an outlined badge for low risk, grey for medium, solid black for
high. Dark mode inverts the palette and is remembered per browser. Each
dashboard opens with a solid "today" block listing the day's real classes and
the next deadline. The campus picture is a labelled illustration, not a
photograph of any institution.

## Highlights

- **Real time**: every change is pushed over Server-Sent Events (`/api/stream`).
  Open dashboards refresh themselves and show who changed what. If someone is
  typing, their draft is kept and a "Show latest" banner appears instead.
- **Attendance session**: a teacher marks the whole class in one step
  (everyone starts present; untick absentees).
- **Student profile drawer** from any student name, and a printable
  **report card** at `/report/<id>` (students can open only their own).
- **Ctrl/⌘ K** search across pages, students and actions.
- Delete notices, assignments (with their submissions), exams and timetable
  classes, with a confirmation step and ownership checks.
- Change password from Account (8+ characters, letters and numbers).

## Production hardening

- Secret key stored in `instance/secret_key` (created on first run, mode 600),
  so sessions survive restarts; `EDUSENSE_SECRET_KEY` overrides it.
- 8-hour sessions, HttpOnly + SameSite cookies, `EDUSENSE_HTTPS=1` for Secure cookies.
- Sign-in rate limit: 5 failures per username and address in 10 minutes.
- Content-Security-Policy (no inline scripts), X-Frame-Options, nosniff,
  Referrer-Policy, no-store on API responses, same-origin checks on changes.
- Custom 404/500 pages, JSON errors for the API, request logging.
- Served by **waitress** when installed (it is in `requirements.txt`);
  `HOST` and `PORT` choose the address.

## Run

```sh
python3 -m pip install -r requirements.txt
python3 app.py
```

On a Mac you can instead double-click `run_edusense.command`. It creates `.venv`,
installs the requirements and serves the app at http://127.0.0.1:5050/login.

Open http://127.0.0.1:5000/login. The server binds to localhost, with debug disabled.
Set `PORT` to change the port and `EDUSENSE_SECRET_KEY` to supply a persistent,
private session key. Without it, sessions expire when the server restarts.
On Windows, replace `python3` with `py` if needed.

Fresh demo accounts:

| Workspace | Username | Password |
| --- | --- | --- |
| Admin | admin | admin123 |
| Teacher | teacher3 | teacher123 |
| Student | stu01 | student123 |

Select the matching workspace at login. Existing accounts may have been edited.
The password helper supports macOS Python builds without `hashlib.scrypt` while
preserving verification of existing passwords. New passwords use PBKDF2.

## Deploy on Render

1. Push this repository to GitHub.
2. In Render: **New + > Blueprint**, pick the repository. `render.yaml` sets up a
   free web service that runs `python app.py` under waitress, with a generated
   secret key, `HOST=0.0.0.0`, HTTPS cookies and proxy headers enabled.
3. Open the `*.onrender.com` URL and sign in with a demo account.

On the free plan the disk is temporary: SQLite is re-seeded with demo data when
the service restarts or redeploys. Attach a Render disk (paid) and point
`DB_FILE` at it, or move to PostgreSQL, for data that must persist.
`/healthz` is the health check. `Procfile` is included for Railway or Heroku-style hosts.

## What works

- Calculated role dashboards, subject performance charts, risk distribution,
  student search, deadline calendar, notices and manual refresh.
- Admin: student/faculty accounts, teacher assignment to subjects, fee ledger.
- Teacher: assigned-subject marks, attendance, assignments, exams, timetable,
  submission downloads and notices.
- Student: own records, assignment file submission, attendance recovery forecast,
  fee balance and what-if academic risk simulation.
- Data Center: transactional CSV imports, source labels, timestamps, SHA-256
  fingerprints, duplicate-file checks and import history.
- Reports: role-scoped CSV exports and a log of successful API changes since
  this upgrade. Browser Print can save a page to PDF.
- Project Guide: official-source comparison, demonstration narrative, data flow,
  current capabilities and explicit limitations.

Dashboard numbers come from SQLite, not hardcoded counters. Data refreshes after
successful changes or when the refresh button is pressed; this is not live push.
Initialization creates missing tables/columns and seeds only an empty database.
It no longer reassigns teachers, rewrites assessment names or deletes custom subjects.

## Campus data: import a genuine college register

Sign in as Admin → Data Center → download a CSV template. Create the student
and subject first, then fill in these fields:

Marks: `roll_no,subject_code,assessment,score,date`

Attendance: `roll_no,subject_code,attended,total,date`

Use ISO dates (`2026-11-19`). Marks are 0–100. Attendance uses whole class counts
with `0 <= attended <= total` and `total > 0`. Each attendance row represents
additional classes, **not a cumulative snapshot**. Student attendance and recovery
forecasts aggregate the recorded counts by subject.

Enter an accurate source label such as the department register and reporting
period. A label is an admin declaration, not independent verification of origin.
Every row must validate; otherwise the whole file rolls back. Identical files
of the same type cannot be imported twice. Overlapping rows in different files
are not automatically deduplicated; reconcile them before importing.

Existing records are labelled `Legacy demo / unverified`. Newly entered marks
and attendance are labelled `Manual entry`; edited attendance is `Manual edit`.
Never present the demo names, fees, marks or attendance as actual college records.

## Public research data: UCI Student Performance

The Admin Data Center includes **Connect UCI dataset**. It downloads the official
archive, imports `student-mat.csv` into separate benchmark tables, and records the
source and checksum. If the server has no internet access, use the Download link,
unzip the outer archive and `student.zip`, then upload `student-mat.csv` as a
benchmark. The original UCI CSV is semicolon-separated.

- Source: https://archive.ics.uci.edu/dataset/320/student+performance
- Citation: Cortez, P. (2008). Student Performance [Dataset].
- DOI: https://doi.org/10.24432/C5TG7T
- License: CC BY 4.0; attribution is displayed in the app.

The published data concerns two Portuguese secondary schools, not this college.
G1/G2/G3 are grades out of 20; dashboard percentages multiply these by five.
Absences remain counts because a class-total denominator is unavailable.
There is no equivalent assignment-completion feature. Public benchmark rows
never become campus users and do not train the current risk model. The benchmark
summary shows the latest imported batch, avoiding double-counting across courses.

No public benchmark is bundled or claimed as imported unless an import succeeds.

## AI and honest project positioning

The Decision Tree trains on 600 synthetic, rule-labelled examples and evaluates
on a held-out 20%. Accuracy measures reproduction of that rule, not validity on
real students. Risk reasons are threshold-based support cues, not causal model
explanations. What-if checks do not change saved academic records.

Established products already cover college/school ERP workflows:

| Product | Official reference | Relevant scope |
| --- | --- | --- |
| Fedena | https://fedena.com/feature-tour | Academic, finance and broad institution administration |
| Frappe Education | https://docs.frappe.io/education/introduction | Academic workflows and student portal in the ERPNext ecosystem |

EduSense is a focused student project combining core workflows, transparent
imports, a small explainable model and what-if exploration. It does not claim
feature parity or that these capabilities are unique to this project.

## Checks

```sh
python3 -m unittest -v test_app
node test_ui.cjs
```

Backend tests use disposable database copies. UI checks exercise each role's
page renderer with fresh synthetic test data; they do not substitute for visual
browser tests. `test_ui.cjs` requires Node only for testing, not to run the app.

## Code map

- `app.py`: authentication, role checks, academic workflows and change logging.
- `db.py`: schema, additive migrations and demo seed.
- `data_center.py`: validation, CSV/UCI import, provenance and scoped exports.
- `security.py`: portable password hashing and verification.
- `ml.py`: synthetic Decision Tree and evaluation report.
- `templates/`: sign-in and workspace shell.
- `static/`: responsive UI and page renderers.
- `college.db`: current local records; back it up with `uploads/`.

## Limits before a campus deployment

This is not a production campus ERP. It needs consented institutional data,
validated educational outcomes, enrollment-based scoping beyond the current
shared cohort, pagination at scale, deployment hardening, managed sessions,
backup/restore tooling and operational monitoring. Teacher exports are scoped
to assigned subjects; student exports are scoped to their own identity.

There is no payment gateway, admissions workflow, payroll, parent portal, library,
hostel or transport module. Fee values are a ledger, not evidence of payment.
The change log covers successful API writes after this upgrade, not all historic
edits, sign-ins or external database changes. Cross-origin browser writes are
rejected, but a production deployment needs a complete CSRF and abuse-control strategy.
