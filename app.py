"""Flask routes: login, role checks, simple data entry, and student views."""
import json
import logging
import math
import os
import secrets
import sqlite3
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta
from functools import wraps
from urllib.parse import urlsplit
from uuid import uuid4
from flask import Flask, Response, g, jsonify, redirect, render_template, request, send_from_directory, session, url_for, make_response
from security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename
import db
import ml

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INSTANCE_DIR = os.path.join(BASE_DIR, "instance")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("edusense")


def load_secret_key():
    """Use EDUSENSE_SECRET_KEY, otherwise a private key file so sessions survive restarts."""
    if os.environ.get("EDUSENSE_SECRET_KEY"):
        return os.environ["EDUSENSE_SECRET_KEY"]
    os.makedirs(INSTANCE_DIR, exist_ok=True)
    path = os.path.join(INSTANCE_DIR, "secret_key")
    if not os.path.exists(path):
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            handle.write(secrets.token_hex(32))
    with open(path) as handle:
        return handle.read().strip()


app = Flask(__name__)
if os.environ.get("EDUSENSE_PROXY") == "1":
    # Behind a hosting proxy (Render, Railway, nginx): trust one hop of X-Forwarded-* headers
    # so request.host_url matches the browser's https:// origin.
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
app.secret_key = load_secret_key()
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax",
                  SESSION_COOKIE_SECURE=os.environ.get("EDUSENSE_HTTPS") == "1",
                  PERMANENT_SESSION_LIFETIME=timedelta(hours=8))
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
LOGIN_WINDOW, LOGIN_LIMIT = 600, 5
_login_failures = defaultdict(deque)
_login_lock = threading.Lock()
ALLOWED_FILES = {"pdf", "doc", "docx", "txt"}
db.setup()


def api(*roles):
    """Protect an API route and give it a database connection."""
    def decorate(function):
        @wraps(function)
        def wrapped(*args, **kwargs):
            if session.get("role") not in roles:
                return jsonify(error="Please sign in with the correct account."), 401
            con = db.connect()
            try:
                response = make_response(function(con, *args, **kwargs))
                if request.method in ("POST", "PUT", "DELETE") and response.status_code < 400:
                    action = getattr(g, "audit", None) or function.__name__.replace("_", " ").capitalize()
                    con.execute("INSERT INTO audit_log(user_id,action) VALUES(?,?)", (session["user_id"], action[:200]))
                    con.commit()
                return response
            except sqlite3.IntegrityError:
                con.rollback()
                return jsonify(error="The referenced record does not exist or a unique value is already used."), 400
            except (ValueError, TypeError, KeyError):
                con.rollback()
                return jsonify(error="Check the required fields and numeric values."), 400
            finally:
                con.close()
        return wrapped
    return decorate


def same_origin(origin):
    """Compare the browser's Origin host with the host the request was sent to.
    Hosting proxies may rewrite the scheme, so the host (domain and port) decides."""
    if origin == "null":
        return False
    allowed = {request.host.lower()}
    forwarded = request.headers.get("X-Forwarded-Host", "")
    if forwarded and os.environ.get("EDUSENSE_PROXY") == "1":
        allowed.update(h.strip().lower() for h in forwarded.split(","))
    return urlsplit(origin).netloc.lower() in allowed


@app.before_request
def check_origin():
    if request.method in ("POST", "PUT", "DELETE"):
        origin = request.headers.get("Origin")
        if origin and not same_origin(origin):
            log.warning("Blocked cross-site %s %s from %s (host %s)", request.method, request.path, origin, request.host)
            return jsonify(error="Cross-site changes are not allowed."), 403


@app.after_request
def security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    response.headers.setdefault("Content-Security-Policy",
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
        "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
    if request.path.startswith("/api/") and "Cache-Control" not in response.headers:
        response.headers["Cache-Control"] = "no-store"
    return response


def wants_json():
    return request.path.startswith("/api/") or request.path.startswith("/submission/")


@app.errorhandler(404)
def not_found(error):
    if wants_json():
        return jsonify(error="Not found."), 404
    return render_template("error.html", code=404, title="Page not found",
                           message="The address may be mistyped, or the page has moved."), 404


@app.errorhandler(500)
def server_error(error):
    log.exception("Unhandled server error")
    if wants_json():
        return jsonify(error="Something went wrong on the server. Try again."), 500
    return render_template("error.html", code=500, title="Something went wrong",
                           message="The server hit an unexpected error. Go back and try again."), 500


@app.errorhandler(413)
def too_large(error):
    return jsonify(error="File is too large. The maximum upload size is 10 MB."), 413


def login_blocked(key):
    now = time.time()
    with _login_lock:
        attempts = _login_failures[key]
        while attempts and now - attempts[0] > LOGIN_WINDOW:
            attempts.popleft()
        if len(attempts) >= LOGIN_LIMIT:
            return max(1, math.ceil((LOGIN_WINDOW - (now - attempts[0])) / 60))
    return 0


def record_login_failure(key):
    with _login_lock:
        _login_failures[key].append(time.time())


def student_stats(con, sid):
    marks = con.execute("SELECT AVG(score) FROM marks WHERE student_id=?", (sid,)).fetchone()[0] or 0
    att = con.execute("SELECT SUM(attended)*100.0/NULLIF(SUM(total),0) FROM attendance WHERE student_id=?", (sid,)).fetchone()[0] or 0
    total = con.execute("SELECT COUNT(*) FROM assignments").fetchone()[0]
    submitted = con.execute("SELECT COUNT(*) FROM submissions WHERE student_id=? AND status='Submitted'", (sid,)).fetchone()[0]
    assignment_pct = 100 * submitted / total if total else 100
    risk = ml.predict_risk(marks, att, assignment_pct)
    return {"average_marks": round(marks, 1), "attendance": round(att, 1),
            "assignment_completion": round(assignment_pct, 1), "risk": risk}


def student_records(con, sid):
    profile = con.execute("SELECT * FROM students WHERE id=?", (sid,)).fetchone()
    return {
        "profile": dict(profile),
        "stats": student_stats(con, sid),
        "marks": [dict(r) for r in con.execute("""SELECT m.assessment,m.score,m.date,s.code subject
            FROM marks m JOIN subjects s ON s.id=m.subject_id WHERE m.student_id=? ORDER BY m.date DESC,m.id DESC""", (sid,))],
        "attendance": [dict(r) for r in con.execute("""SELECT a.attended,a.total,a.date,s.code subject
            FROM attendance a JOIN subjects s ON s.id=a.subject_id WHERE a.student_id=? ORDER BY a.date DESC,a.id DESC""", (sid,))],
        "assignments": [dict(r) for r in con.execute("""SELECT a.id,a.title,a.due_date,s.code subject,
            COALESCE(x.status,'Pending') status,x.file_name,x.submitted_at FROM assignments a JOIN subjects s ON s.id=a.subject_id
            LEFT JOIN submissions x ON x.assignment_id=a.id AND x.student_id=? ORDER BY a.due_date""", (sid,))],
        "exams": [dict(r) for r in con.execute("""SELECT e.exam_date,e.details,s.code subject,u.name teacher FROM exams e
            JOIN subjects s ON s.id=e.subject_id LEFT JOIN users u ON u.id=s.teacher_id ORDER BY e.exam_date""")],
        "timetable": [dict(r) for r in con.execute("""SELECT t.day,t.start_time,t.room,s.code subject,u.name teacher FROM timetable t
            JOIN subjects s ON s.id=t.subject_id LEFT JOIN users u ON u.id=s.teacher_id
            ORDER BY CASE LOWER(t.day) WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2 WHEN 'wednesday' THEN 3 WHEN 'thursday' THEN 4 WHEN 'friday' THEN 5 WHEN 'saturday' THEN 6 WHEN 'sunday' THEN 7 ELSE 8 END,t.start_time""")],
        "fees": dict(con.execute("SELECT total,paid,due_date FROM fees WHERE student_id=?", (sid,)).fetchone() or {"total": 0, "paid": 0, "due_date": "Not set"}),
        "notices": [dict(r) for r in con.execute("SELECT id,title,message,date FROM notices ORDER BY id DESC")]
    }


@app.get("/healthz")
def healthz():
    con = db.connect()
    try:
        con.execute("SELECT 1").fetchone()
    finally:
        con.close()
    return jsonify(status="ok")


@app.route("/")
def home():
    return redirect(url_for("portal") if session.get("role") else url_for("login"))


@app.route("/login", methods=["GET", "POST"])
def login():
    error = ""
    if request.method == "POST":
        session.clear()
        username = request.form.get("username", "").strip()
        key = (request.remote_addr or "local", username.lower())
        wait = login_blocked(key)
        if wait:
            error = f"Too many failed attempts. Try again in {wait} minute{'s' if wait != 1 else ''}."
            return render_template("login.html", error=error, username=username, role=request.form.get("role", "admin")), 429
        con = db.connect()
        user = con.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        con.close()
        chosen_role = request.form.get("role", "").strip()
        password_ok = user and check_password_hash(user["password"], request.form.get("password", ""))
        if password_ok and chosen_role and chosen_role != user["role"]:
            error = f"These credentials belong to the {user['role'].title()} portal. Select {user['role'].title()} and try again."
        elif password_ok:
            with _login_lock:
                _login_failures.pop(key, None)
            session.clear()
            session.permanent = True
            session.update(user_id=user["id"], name=user["name"], role=user["role"], student_id=user["student_id"])
            log.info("Sign-in: %s (%s)", user["username"], user["role"])
            return redirect(url_for("portal"))
        else:
            record_login_failure(key)
            error = "Username or password is incorrect."
    return render_template("login.html", error=error,
                           username=request.form.get("username", "").strip() if error else "",
                           role=request.form.get("role", "admin") if error else "admin")


@app.route("/portal")
def portal():
    if not session.get("role"):
        return redirect(url_for("login"))
    return render_template("portal.html", name=session["name"], role=session["role"],
                           student_id=session.get("student_id") or "")


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.get("/api/summary")
@api("admin", "teacher", "student")
def summary(con):
    if session["role"] == "student":
        return jsonify(role="student", student=student_records(con, session["student_id"]))
    students = []
    for row in con.execute("SELECT s.id,s.name,s.roll_no,s.class_name,u.id user_id,u.username FROM students s JOIN users u ON u.student_id=s.id ORDER BY s.roll_no"):
        students.append({**dict(row), **student_stats(con, row["id"])})
    subject_sql = "SELECT s.*,u.name teacher FROM subjects s LEFT JOIN users u ON u.id=s.teacher_id"
    record_filter = " WHERE s.teacher_id=?" if session["role"] == "teacher" else ""
    param = (session["user_id"],) if record_filter else ()
    teacher_only = session["role"] == "teacher"
    mark_sql = "SELECT m.id,m.student_id,u.name student,s.code subject,m.assessment,m.score,m.date FROM marks m JOIN students u ON u.id=m.student_id JOIN subjects s ON s.id=m.subject_id"
    attendance_sql = "SELECT a.id,a.student_id,u.name student,s.id subject_id,s.code subject,a.attended,a.total,a.date FROM attendance a JOIN students u ON u.id=a.student_id JOIN subjects s ON s.id=a.subject_id"
    if teacher_only:
        mark_sql += " WHERE s.teacher_id=?"
        attendance_sql += " WHERE s.teacher_id=?"
    mark_sql += " ORDER BY m.id DESC"
    attendance_sql += " ORDER BY a.id DESC"
    return jsonify(role=session["role"], students=students,
                   teachers=[dict(r) for r in con.execute("SELECT id user_id,name,username FROM users WHERE role='teacher' ORDER BY name")],
                   subjects=[dict(r) for r in con.execute(subject_sql + record_filter + " ORDER BY s.code", param)],
                   assignments=[dict(r) for r in con.execute("SELECT a.*,s.code subject,u.name teacher FROM assignments a JOIN subjects s ON s.id=a.subject_id LEFT JOIN users u ON u.id=s.teacher_id" + (" WHERE s.teacher_id=?" if session["role"] == "teacher" else "") + " ORDER BY a.due_date", param)],
                   marks=[dict(r) for r in con.execute(mark_sql, param)],
                   attendance=[dict(r) for r in con.execute(attendance_sql, param)],
                   submissions=[dict(r) for r in con.execute("SELECT x.student_id,x.assignment_id,u.name student,a.title assignment,s.id subject_id,s.code subject,x.file_name,x.submitted_at FROM submissions x JOIN students u ON u.id=x.student_id JOIN assignments a ON a.id=x.assignment_id JOIN subjects s ON s.id=a.subject_id WHERE x.status='Submitted'" + (" AND s.teacher_id=?" if teacher_only else "") + " ORDER BY x.submitted_at DESC", param)],
                   exams=[dict(r) for r in con.execute("SELECT e.*,s.code subject,u.name teacher FROM exams e JOIN subjects s ON s.id=e.subject_id LEFT JOIN users u ON u.id=s.teacher_id" + (" WHERE s.teacher_id=?" if session["role"] == "teacher" else "") + " ORDER BY e.exam_date", param)],
                   timetable=[dict(r) for r in con.execute("SELECT t.*,s.code subject,u.name teacher FROM timetable t JOIN subjects s ON s.id=t.subject_id LEFT JOIN users u ON u.id=s.teacher_id" + (" WHERE s.teacher_id=?" if session["role"] == "teacher" else "") + " ORDER BY CASE LOWER(t.day) WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2 WHEN 'wednesday' THEN 3 WHEN 'thursday' THEN 4 WHEN 'friday' THEN 5 WHEN 'saturday' THEN 6 WHEN 'sunday' THEN 7 ELSE 8 END,t.start_time", param)],
                   fees=[dict(r) for r in con.execute("SELECT f.*,s.name student,s.roll_no FROM fees f JOIN students s ON s.id=f.student_id ORDER BY s.roll_no")] if session["role"] == "admin" else [],
                   notices=[dict(r) for r in con.execute("SELECT * FROM notices ORDER BY id DESC")],
                   model=ml.get_model()[1])


@app.post("/api/admin/user")
@api("admin")
def add_user(con):
    data = request.get_json() or {}
    role, name, username, password = (data.get(k, "").strip() for k in ("role", "name", "username", "password"))
    if role not in ("student", "teacher") or not name or not username or len(password) < 6:
        return jsonify(error="Choose student or teacher, fill all fields, and use a password of 6+ characters."), 400
    try:
        sid = None
        if role == "student":
            roll = data.get("roll_no", "").strip()
            if not roll:
                return jsonify(error="Enter a roll number for the student."), 400
            sid = con.execute("INSERT INTO students(name,roll_no,class_name) VALUES(?,?,?)",
                              (name, roll, data.get("class_name", "CSE-A").strip() or "CSE-A")).lastrowid
        con.execute("INSERT INTO users(username,password,role,name,student_id) VALUES(?,?,?,?,?)",
                    (username, generate_password_hash(password), role, name, sid))
        con.commit()
        g.audit = f"Added {role} account for {name}"
        return jsonify(message=f"{role.title()} account added.")
    except Exception as exc:
        con.rollback()
        return jsonify(error="Could not add account. Check that username and roll number are unique."), 400


@app.put("/api/admin/user/<int:user_id>")
@api("admin")
def edit_user(con, user_id):
    data = request.get_json() or {}
    name, username = data.get("name", "").strip(), data.get("username", "").strip()
    password, roll = data.get("password", "").strip(), data.get("roll_no", "").strip()
    class_name = data.get("class_name", "CSE-A").strip() or "CSE-A"
    user = con.execute("SELECT * FROM users WHERE id=? AND role IN ('student','teacher')", (user_id,)).fetchone()
    if not user or not name or not username:
        return jsonify(error="Choose a valid account and fill in the name and username."), 400
    if password and len(password) < 6:
        return jsonify(error="A new password must have at least 6 characters."), 400
    try:
        con.execute("UPDATE users SET name=?,username=? WHERE id=?", (name, username, user_id))
        if password:
            con.execute("UPDATE users SET password=? WHERE id=?", (generate_password_hash(password), user_id))
        if user["role"] == "student":
            if not roll:
                return jsonify(error="Student roll number is required."), 400
            con.execute("UPDATE students SET name=?,roll_no=?,class_name=? WHERE id=?",
                        (name, roll, class_name, user["student_id"]))
        con.commit()
        g.audit = f"Updated {user['role']} account for {name}"
        return jsonify(message=f"{user['role'].title()} account updated.")
    except Exception:
        con.rollback()
        return jsonify(error="Could not update account. Check that the username or roll number is not already used."), 400


@app.post("/api/admin/subject")
@api("admin")
def add_subject(con):
    data = request.get_json() or {}
    code, name = data.get("code", "").strip().upper(), data.get("name", "").strip()
    if not code or not name:
        return jsonify(error="Enter both subject code and name."), 400
    try:
        teacher_id = int(data["teacher_id"]) if data.get("teacher_id") else None
        if teacher_id and not con.execute("SELECT id FROM users WHERE id=? AND role='teacher'", (teacher_id,)).fetchone():
            return jsonify(error="Choose an existing teacher account."), 400
        con.execute("INSERT INTO subjects(code,name,teacher_id) VALUES(?,?,?)", (code, name, teacher_id))
        con.commit()
        g.audit = f"Added subject {code}"
        return jsonify(message="Subject added.")
    except Exception:
        con.rollback()
        return jsonify(error="That subject code already exists."), 400


@app.put("/api/admin/subject/<int:subject_id>")
@api("admin")
def assign_subject(con, subject_id):
    data = request.get_json() or {}
    teacher_id = int(data["teacher_id"]) if data.get("teacher_id") else None
    if teacher_id and not con.execute("SELECT id FROM users WHERE id=? AND role='teacher'", (teacher_id,)).fetchone():
        return jsonify(error="Choose an existing teacher account."), 400
    con.execute("UPDATE subjects SET teacher_id=? WHERE id=?", (teacher_id, subject_id))
    con.commit()
    g.audit = "Changed a subject's teacher"
    return jsonify(message="Subject teacher updated.")


@app.post("/api/admin/fee")
@api("admin")
def save_fee(con):
    data = request.get_json() or {}
    try:
        sid, total, paid = int(data["student_id"]), float(data["total"]), float(data["paid"])
        due = data["due_date"]
        datetime.strptime(due, "%Y-%m-%d")
        if not math.isfinite(total) or not math.isfinite(paid) or total < 0 or paid < 0 or paid > total:
            raise ValueError
        con.execute("INSERT INTO fees(student_id,total,paid,due_date) VALUES(?,?,?,?) ON CONFLICT(student_id) DO UPDATE SET total=excluded.total,paid=excluded.paid,due_date=excluded.due_date",
                    (sid, total, paid, due))
        con.commit()
        g.audit = "Updated a fee record"
        return jsonify(message="Fee record saved.")
    except (KeyError, ValueError, TypeError):
        con.rollback()
        return jsonify(error="Enter a valid student, fee total, paid amount, and due date."), 400


@app.post("/api/teacher/record")
@api("admin", "teacher")
def add_record(con):
    data = request.get_json() or {}
    kind = data.get("kind")
    try:
        sid, subject = int(data.get("student_id", 0)), int(data.get("subject_id", 0))
        if session["role"] == "teacher" and not con.execute("SELECT id FROM subjects WHERE id=? AND teacher_id=?", (subject, session["user_id"])).fetchone():
            return jsonify(error="You can only enter records for your assigned subjects."), 403
        if kind == "marks":
            score = float(data.get("score", -1))
            if not 0 <= score <= 100:
                raise ValueError
            con.execute("INSERT INTO marks(student_id,subject_id,assessment,score,date,source) VALUES(?,?,?,?,date('now'),'Manual entry')",
                        (sid, subject, data.get("assessment", "End Term Exam").strip() or "End Term Exam", score))
        elif kind == "attendance":
            attended, total = int(data.get("attended", -1)), int(data.get("total", 0))
            if total <= 0 or attended < 0 or attended > total:
                raise ValueError
            con.execute("INSERT INTO attendance(student_id,subject_id,attended,total,date,source) VALUES(?,?,?,?,date('now'),'Manual entry')",
                        (sid, subject, attended, total))
        else:
            return jsonify(error="Record type must be marks or attendance."), 400
        con.commit()
        who = con.execute("SELECT name FROM students WHERE id=?", (sid,)).fetchone()
        code = con.execute("SELECT code FROM subjects WHERE id=?", (subject,)).fetchone()
        g.audit = f"Recorded {kind} for {who[0] if who else 'a student'} in {code[0] if code else 'a subject'}"
        return jsonify(message=f"{kind.title()} record saved.")
    except (ValueError, TypeError):
        con.rollback()
        return jsonify(error="Check the student, subject, and numeric values."), 400


@app.post("/api/teacher/item")
@api("admin", "teacher")
def add_item(con):
    data = request.get_json() or {}
    kind = data.get("kind")
    try:
        subject = int(data.get("subject_id", 0))
        if session["role"] == "teacher" and not con.execute("SELECT id FROM subjects WHERE id=? AND teacher_id=?", (subject, session["user_id"])).fetchone():
            return jsonify(error="You can only manage your assigned subjects."), 403
        if kind in ("assignment", "exam"):
            datetime.strptime(data["date"], "%Y-%m-%d")
            if not data.get("title" if kind == "assignment" else "details", "").strip():
                raise ValueError
        if kind == "assignment":
            con.execute("INSERT INTO assignments(subject_id,title,due_date) VALUES(?,?,?)",
                        (subject, data["title"].strip(), data["date"]))
        elif kind == "exam":
            con.execute("INSERT INTO exams(subject_id,exam_date,details) VALUES(?,?,?)",
                        (subject, data["date"], data["details"].strip()))
        elif kind == "timetable":
            if data["day"] not in ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday") or not data["room"].strip():
                raise ValueError
            datetime.strptime(data["time"], "%H:%M")
            conflict = con.execute("SELECT t.id FROM timetable t JOIN subjects s ON s.id=t.subject_id WHERE t.day=? AND t.start_time=? AND (t.room=? OR s.teacher_id=(SELECT teacher_id FROM subjects WHERE id=?))", (data["day"], data["time"], data["room"].strip(), subject)).fetchone()
            if conflict:
                return jsonify(error="This room or teacher already has a class at that time."), 409
            con.execute("INSERT INTO timetable(subject_id,day,start_time,room) VALUES(?,?,?,?)",
                        (subject, data["day"], data["time"], data["room"].strip()))
        else:
            return jsonify(error="Choose assignment, exam, or timetable."), 400
        con.commit()
        code = con.execute("SELECT code FROM subjects WHERE id=?", (subject,)).fetchone()
        g.audit = f"Added {'a class to the timetable' if kind == 'timetable' else 'an ' + kind if kind == 'exam' else 'an assignment'} for {code[0] if code else 'a subject'}"
        return jsonify(message=f"{kind.title()} entry saved.")
    except (KeyError, ValueError, TypeError):
        con.rollback()
        return jsonify(error="Please complete all fields."), 400


@app.post("/api/teacher/notice")
@api("admin", "teacher")
def add_notice(con):
    data = request.get_json() or {}
    title, message = data.get("title", "").strip(), data.get("message", "").strip()
    if not title or not message:
        return jsonify(error="Enter a notice title and message."), 400
    con.execute("INSERT INTO notices(title,message,date) VALUES(?,?,date('now'))", (title, message))
    con.commit()
    g.audit = f"Published notice: {title}"
    return jsonify(message="Notice published.")


@app.post("/api/student/what-if")
@api("student")
def student_what_if(con):
    data = request.get_json() or {}
    try:
        marks = float(data["average_marks"])
        attendance = float(data["attendance"])
        assignments = float(data["assignment_completion"])
        if any(not math.isfinite(value) or value < 0 or value > 100 for value in (marks, attendance, assignments)):
            raise ValueError
    except (KeyError, ValueError, TypeError):
        return jsonify(error="Use values from 0 to 100."), 400
    current = student_stats(con, session["student_id"])
    simulated = ml.predict_risk(marks, attendance, assignments)
    return jsonify(current=current["risk"], simulated=simulated,
                   inputs={"average_marks": marks, "attendance": attendance,
                           "assignment_completion": assignments})


@app.post("/api/student/submit/<int:assignment_id>")
@api("student")
def submit_assignment(con, assignment_id):
    upload = request.files.get("file")
    assignment = con.execute("SELECT id FROM assignments WHERE id=?", (assignment_id,)).fetchone()
    if not assignment or not upload or not upload.filename:
        return jsonify(error="Choose your assignment file before submitting."), 400
    filename = secure_filename(upload.filename)
    extension = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if extension not in ALLOWED_FILES:
        return jsonify(error="Upload a PDF, DOC, DOCX, or TXT file."), 400
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    stored = f"{uuid4().hex}_{filename}"
    upload.save(os.path.join(UPLOAD_DIR, stored))
    con.execute("""INSERT INTO submissions(student_id,assignment_id,status,file_name,stored_name,submitted_at)
        VALUES(?,?,'Submitted',?,?,?) ON CONFLICT(student_id,assignment_id) DO UPDATE SET
        status='Submitted',file_name=excluded.file_name,stored_name=excluded.stored_name,submitted_at=excluded.submitted_at""",
        (session["student_id"], assignment_id, filename, stored, datetime.now().isoformat(timespec="minutes")))
    con.commit()
    g.audit = "Submitted an assignment file"
    return jsonify(message="Assignment file submitted.")


@app.get("/submission/<int:student_id>/<int:assignment_id>")
@api("admin", "teacher")
def download_submission(con, student_id, assignment_id):
    row = con.execute("""SELECT x.stored_name,x.file_name,s.teacher_id FROM submissions x
        JOIN assignments a ON a.id=x.assignment_id JOIN subjects s ON s.id=a.subject_id
        WHERE x.student_id=? AND x.assignment_id=? AND x.status='Submitted'""",
                      (student_id, assignment_id)).fetchone()
    if not row or not row["stored_name"]:
        return jsonify(error="No submitted file was found."), 404
    if session["role"] == "teacher" and row["teacher_id"] != session["user_id"]:
        return jsonify(error="You can only open submissions for your assigned subjects."), 403
    return send_from_directory(UPLOAD_DIR, row["stored_name"], as_attachment=True, download_name=row["file_name"])


@app.put("/api/teacher/attendance/<int:attendance_id>")
@api("admin", "teacher")
def update_attendance(con, attendance_id):
    data = request.get_json() or {}
    try:
        attended = int(data["attended"])
        total = int(data["total"])
        if total <= 0 or attended < 0 or attended > total:
            raise ValueError
        row = con.execute("""SELECT a.id,s.teacher_id FROM attendance a
            JOIN subjects s ON s.id=a.subject_id WHERE a.id=?""", (attendance_id,)).fetchone()
        if not row:
            return jsonify(error="Attendance record not found."), 404
        if session["role"] == "teacher" and row["teacher_id"] != session["user_id"]:
            return jsonify(error="You can only update attendance for your assigned subjects."), 403
        con.execute("UPDATE attendance SET attended=?,total=?,date=date('now'),source='Manual edit',batch_id=NULL WHERE id=?", (attended, total, attendance_id))
        con.commit()
        g.audit = "Corrected an attendance record"
        return jsonify(message="Attendance record updated.")
    except (KeyError, ValueError, TypeError):
        con.rollback()
        return jsonify(error="Enter valid attended and total class counts."), 400


def owns_subject(con, subject_id):
    if session["role"] == "admin":
        return con.execute("SELECT id FROM subjects WHERE id=?", (subject_id,)).fetchone() is not None
    return con.execute("SELECT id FROM subjects WHERE id=? AND teacher_id=?", (subject_id, session["user_id"])).fetchone() is not None


@app.get("/api/student/<int:student_id>")
@api("admin", "teacher")
def student_profile(con, student_id):
    if not con.execute("SELECT id FROM students WHERE id=?", (student_id,)).fetchone():
        return jsonify(error="Student not found."), 404
    records = student_records(con, student_id)
    records.pop("notices", None)
    account = con.execute("SELECT username FROM users WHERE student_id=?", (student_id,)).fetchone()
    records["profile"]["username"] = account["username"] if account else ""
    return jsonify(records)


@app.post("/api/teacher/attendance/session")
@api("admin", "teacher")
def attendance_session(con):
    """Record one class session: every student gets 1 class, present students get 1 attended."""
    data = request.get_json() or {}
    try:
        subject = int(data.get("subject_id", 0))
        present = {int(x) for x in data.get("present", [])}
    except (TypeError, ValueError):
        return jsonify(error="Choose a subject and valid students."), 400
    if not owns_subject(con, subject):
        return jsonify(error="You can only take attendance for your assigned subjects."), 403
    students = [r[0] for r in con.execute("SELECT id FROM students ORDER BY roll_no")]
    if not students:
        return jsonify(error="There are no students to mark."), 400
    if not present.issubset(set(students)):
        return jsonify(error="One or more selected students do not exist."), 400
    con.executemany("INSERT INTO attendance(student_id,subject_id,attended,total,date,source) VALUES(?,?,?,1,date('now'),'Class session')",
                    [(sid, subject, 1 if sid in present else 0) for sid in students])
    con.commit()
    code = con.execute("SELECT code FROM subjects WHERE id=?", (subject,)).fetchone()[0]
    g.audit = f"Took attendance for {code}: {len(present)} of {len(students)} present"
    return jsonify(message=f"Attendance saved: {len(present)} present, {len(students) - len(present)} absent.")


@app.delete("/api/notice/<int:notice_id>")
@api("admin", "teacher")
def delete_notice(con, notice_id):
    row = con.execute("SELECT title FROM notices WHERE id=?", (notice_id,)).fetchone()
    if not row:
        return jsonify(error="Notice not found."), 404
    con.execute("DELETE FROM notices WHERE id=?", (notice_id,))
    con.commit()
    g.audit = f"Deleted notice: {row['title']}"
    return jsonify(message="Notice deleted.")


@app.delete("/api/teacher/item/<kind>/<int:item_id>")
@api("admin", "teacher")
def delete_item(con, kind, item_id):
    tables = {"assignment": "assignments", "exam": "exams", "timetable": "timetable"}
    if kind not in tables:
        return jsonify(error="Choose assignment, exam, or timetable."), 400
    row = con.execute(f"SELECT subject_id FROM {tables[kind]} WHERE id=?", (item_id,)).fetchone()
    if not row:
        return jsonify(error="That entry no longer exists."), 404
    if not owns_subject(con, row["subject_id"]):
        return jsonify(error="You can only change your assigned subjects."), 403
    files = []
    if kind == "assignment":
        files = [r[0] for r in con.execute("SELECT stored_name FROM submissions WHERE assignment_id=? AND stored_name IS NOT NULL", (item_id,))]
        con.execute("DELETE FROM submissions WHERE assignment_id=?", (item_id,))
    con.execute(f"DELETE FROM {tables[kind]} WHERE id=?", (item_id,))
    con.commit()
    for name in files:
        try:
            os.remove(os.path.join(UPLOAD_DIR, os.path.basename(name)))
        except OSError:
            pass
    g.audit = f"Deleted {'a timetable class' if kind == 'timetable' else 'an ' + kind if kind == 'exam' else 'an assignment'}"
    return jsonify(message={"assignment": "Assignment deleted.", "exam": "Exam deleted.", "timetable": "Class removed from the timetable."}[kind])


@app.post("/api/account/password")
@api("admin", "teacher", "student")
def change_password(con):
    data = request.get_json() or {}
    current, new = data.get("current", ""), data.get("new", "")
    user = con.execute("SELECT password FROM users WHERE id=?", (session["user_id"],)).fetchone()
    if not user or not check_password_hash(user["password"], current):
        return jsonify(error="Your current password is incorrect."), 400
    if len(new) < 8 or new.isdigit() or new.isalpha():
        return jsonify(error="Use at least 8 characters with both letters and numbers."), 400
    con.execute("UPDATE users SET password=? WHERE id=?", (generate_password_hash(new), session["user_id"]))
    con.commit()
    g.audit = "Changed their password"
    return jsonify(message="Password changed.")


@app.get("/api/stream")
def live_stream():
    """Server-Sent Events: pushes each recorded change so open dashboards refresh themselves."""
    if not session.get("role"):
        return jsonify(error="Please sign in."), 401
    staff = session["role"] in ("admin", "teacher")
    con = db.connect()
    latest = con.execute("SELECT COALESCE(MAX(id),0) FROM audit_log").fetchone()[0]
    con.close()
    since = request.headers.get("Last-Event-ID", type=int)
    since = latest if since is None or since > latest else since

    def events(last):
        yield "retry: 3000\n\n"
        started = time.time()
        pinged = started
        while time.time() - started < 25:
            con = db.connect()
            rows = con.execute("""SELECT a.id,a.action,a.created_at,u.name actor,u.role actor_role FROM audit_log a
                LEFT JOIN users u ON u.id=a.user_id WHERE a.id>? ORDER BY a.id LIMIT 50""", (last,)).fetchall()
            con.close()
            for row in rows:
                last = row["id"]
                payload = dict(row) if staff else {"id": row["id"], "action": "Records updated"}
                yield f"id: {last}\nevent: change\ndata: {json.dumps(payload)}\n\n"
            if time.time() - pinged > 10:
                pinged = time.time()
                yield ": keep-alive\n\n"
            time.sleep(1.5)

    return Response(events(since), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/report/<int:student_id>")
def report_card(student_id):
    role = session.get("role")
    if not role:
        return redirect(url_for("login"))
    if role == "student" and session.get("student_id") != student_id:
        return not_found(None)
    con = db.connect()
    try:
        if not con.execute("SELECT id FROM students WHERE id=?", (student_id,)).fetchone():
            return not_found(None)
        records = student_records(con, student_id)
    finally:
        con.close()
    subjects = {}
    for m in records["marks"]:
        subjects.setdefault(m["subject"], {"marks": [], "attended": 0, "total": 0})["marks"].append(m["score"])
    for a in records["attendance"]:
        item = subjects.setdefault(a["subject"], {"marks": [], "attended": 0, "total": 0})
        item["attended"] += a["attended"]
        item["total"] += a["total"]
    rows = [{"subject": code, "average": round(sum(v["marks"]) / len(v["marks"]), 1) if v["marks"] else None,
             "assessments": len(v["marks"]), "attended": v["attended"], "total": v["total"],
             "attendance": round(100 * v["attended"] / v["total"], 1) if v["total"] else None}
            for code, v in sorted(subjects.items())]
    return render_template("report.html", r=records, rows=rows, generated=datetime.now().strftime("%d %b %Y, %I:%M %p"))


from data_center import register
register(app, api)


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))
    try:
        from waitress import serve
        log.info("EduSense AI running on http://%s:%s (waitress)", host, port)
        serve(app, host=host, port=port, threads=32, channel_timeout=60)
    except ImportError:
        log.info("waitress not installed; using Flask's built-in server")
        app.run(host=host, port=port, debug=False, threaded=True)
