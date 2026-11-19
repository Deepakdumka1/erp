"""Small SQLite database and clearly labelled demo records."""
import os
import sqlite3
from security import generate_password_hash

DB_FILE = os.path.join(os.path.dirname(__file__), "college.db")


def connect():
    con = sqlite3.connect(DB_FILE)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def setup():
    """Create tables, then add sample data only when the database is empty."""
    con = connect()
    con.executescript("""
    CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, roll_no TEXT UNIQUE NOT NULL,
        class_name TEXT NOT NULL DEFAULT 'CSE-A'
    );
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
        role TEXT NOT NULL, name TEXT NOT NULL, student_id INTEGER REFERENCES students(id)
    );
    CREATE TABLE IF NOT EXISTS subjects (
        id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        teacher_id INTEGER REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS marks (
        id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES students(id),
        subject_id INTEGER NOT NULL REFERENCES subjects(id), assessment TEXT NOT NULL,
        score REAL NOT NULL, date TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES students(id),
        subject_id INTEGER NOT NULL REFERENCES subjects(id), attended INTEGER NOT NULL,
        total INTEGER NOT NULL, date TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assignments (
        id INTEGER PRIMARY KEY, subject_id INTEGER NOT NULL REFERENCES subjects(id),
        title TEXT NOT NULL, due_date TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS submissions (
        student_id INTEGER NOT NULL REFERENCES students(id),
        assignment_id INTEGER NOT NULL REFERENCES assignments(id),
        status TEXT NOT NULL DEFAULT 'Pending', file_name TEXT, stored_name TEXT, submitted_at TEXT,
        PRIMARY KEY(student_id, assignment_id)
    );
    CREATE TABLE IF NOT EXISTS exams (
        id INTEGER PRIMARY KEY, subject_id INTEGER NOT NULL REFERENCES subjects(id),
        exam_date TEXT NOT NULL, details TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS timetable (
        id INTEGER PRIMARY KEY, subject_id INTEGER NOT NULL REFERENCES subjects(id),
        day TEXT NOT NULL, start_time TEXT NOT NULL, room TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fees (
        student_id INTEGER PRIMARY KEY REFERENCES students(id), total REAL NOT NULL,
        paid REAL NOT NULL, due_date TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notices (
        id INTEGER PRIMARY KEY, title TEXT NOT NULL, message TEXT NOT NULL, date TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS import_batches (
        id INTEGER PRIMARY KEY, kind TEXT NOT NULL, source TEXT NOT NULL,
        filename TEXT NOT NULL, checksum TEXT NOT NULL, row_count INTEGER NOT NULL,
        imported_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(kind,checksum)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id),
        action TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS benchmark_rows (
        id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES import_batches(id),
        school TEXT NOT NULL, g1 REAL NOT NULL, g2 REAL NOT NULL, g3 REAL NOT NULL,
        absences INTEGER NOT NULL
    );
    """)
    subject_columns = {row[1] for row in con.execute("PRAGMA table_info(subjects)")}
    if "teacher_id" not in subject_columns:
        con.execute("ALTER TABLE subjects ADD COLUMN teacher_id INTEGER REFERENCES users(id)")
    # Keep databases created by the previous simple version working.
    columns = {row[1] for row in con.execute("PRAGMA table_info(submissions)")}
    for column in ("file_name", "stored_name", "submitted_at"):
        if column not in columns:
            con.execute(f"ALTER TABLE submissions ADD COLUMN {column} TEXT")
    for table in ("marks", "attendance"):
        columns = {row[1] for row in con.execute(f"PRAGMA table_info({table})")}
        if "source" not in columns:
            con.execute(f"ALTER TABLE {table} ADD COLUMN source TEXT NOT NULL DEFAULT 'Legacy demo / unverified'")
        if "batch_id" not in columns:
            con.execute(f"ALTER TABLE {table} ADD COLUMN batch_id INTEGER REFERENCES import_batches(id)")
    # Initialization must never rewrite accounts, assignments, or academic records.
    has_data = con.execute("SELECT COUNT(*) FROM users").fetchone()[0] > 0
    if not has_data:
        _seed(con)
    con.commit()
    con.close()


def _seed(con):
    subjects = [("DBMS", "Database Systems"), ("OS", "Operating Systems"), ("PY", "Python Programming"),
                ("DSA", "Data Structures and Algorithms"), ("CN", "Computer Networks"),
                ("SE", "Software Engineering")]
    con.execute("INSERT INTO users(username,password,role,name) VALUES(?,?,?,?)",
                ("admin", generate_password_hash("admin123"), "admin", "Project Admin"))
    con.execute("INSERT INTO users(username,password,role,name) VALUES(?,?,?,?)",
                ("teacher", generate_password_hash("teacher123"), "teacher", "Helly Gupta"))
    con.execute("INSERT INTO users(username,password,role,name) VALUES(?,?,?,?)",
                ("teacher2", generate_password_hash("teacher123"), "teacher", "Pankaj Singh"))
    con.execute("INSERT INTO users(username,password,role,name) VALUES(?,?,?,?)",
                ("teacher3", generate_password_hash("teacher123"), "teacher", "Gaurav Aneja"))
    con.execute("INSERT INTO users(username,password,role,name) VALUES(?,?,?,?)",
                ("teacher4", generate_password_hash("teacher123"), "teacher", "SN Verma"))
    teacher_ids = [row[0] for row in con.execute("SELECT id FROM users WHERE role='teacher' ORDER BY id")]
    con.executemany("INSERT INTO subjects(code,name,teacher_id) VALUES(?,?,?)",
                    [(code, name, teacher_ids[index % len(teacher_ids)]) for index, (code, name) in enumerate(subjects)])

    names = ["Aarav Shah", "Diya Patel", "Kabir Rao", "Meera Das", "Arjun Nair", "Isha Khan",
             "Rohan Sen", "Anaya Bose", "Dev Mehta", "Sara Roy", "Neil Thomas", "Tara Joshi"]
    for n, name in enumerate(names, start=1):
        cur = con.execute("INSERT INTO students(name,roll_no) VALUES(?,?)", (name, f"CSE-A-{n:02d}"))
        sid = cur.lastrowid
        con.execute("INSERT INTO users(username,password,role,name,student_id) VALUES(?,?,?,?,?)",
                    (f"stu{n:02d}", generate_password_hash("student123"), "student", name, sid))
        con.execute("INSERT INTO fees(student_id,total,paid,due_date) VALUES(?,?,?,date('now','+30 day'))",
                    (sid, 85000, [85000, 60000, 40000][n % 3]))
        # Varied demo records let the teacher dashboard show more than one risk category.
        average = [42, 55, 68, 78, 86, 61][(n - 1) % 6]
        attendance_pct = [58, 70, 76, 84, 92, 66][(n - 1) % 6]
        for subject_id, (code, _) in enumerate(subjects, start=1):
            con.execute("INSERT INTO marks(student_id,subject_id,assessment,score,date) VALUES(?,?,?,?,date('now'))",
                        (sid, subject_id, "End Term Exam", max(0, min(100, average + subject_id - 2))))
            total = 20
            attended = round(total * attendance_pct / 100)
            con.execute("INSERT INTO attendance(student_id,subject_id,attended,total,date) VALUES(?,?,?,?,date('now'))",
                        (sid, subject_id, attended, total))

    for index, (subject_id, (code, _)) in enumerate(zip(range(1, len(subjects) + 1), subjects)):
        con.execute("INSERT INTO assignments(subject_id,title,due_date) VALUES(?,?,date('now','+7 day'))",
                    (subject_id, f"{code} course assignment"))
        con.execute("INSERT INTO exams(subject_id,exam_date,details) VALUES(?,date('now','+14 day'),?)",
                    (subject_id, "Final examination"))
        days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
        times = ["09:00", "10:00", "11:00", "12:00", "14:00", "15:00"]
        subjects_rows = list(con.execute("SELECT id FROM subjects ORDER BY id"))
        slot = 0
        for day in days:
            for time in times:
                subject_id = subjects_rows[slot % len(subjects_rows)]["id"]
                con.execute("INSERT INTO timetable(subject_id,day,start_time,room) VALUES(?,?,?,?)",
                            (subject_id, day, time, f"Room {101 + slot % 10}"))
                slot += 1
    if con.execute("SELECT COUNT(*) FROM notices").fetchone()[0] == 0:
        con.executemany("INSERT INTO notices(title,message,date) VALUES(?,?,date('now'))",
                        [("Exam timetable published", "Check the exam dates page for your subject schedule."),
                         ("Library hours", "The library is open until 8 PM this week.")])
    keep_codes = ("DBMS", "OS", "PY", "DSA", "CN", "SE")
    placeholders = ",".join("?" for _ in keep_codes)
    removed_subjects = [row[0] for row in con.execute(f"SELECT id FROM subjects WHERE code NOT IN ({placeholders})", keep_codes)]
    for subject_id in removed_subjects:
        con.execute("DELETE FROM submissions WHERE assignment_id IN (SELECT id FROM assignments WHERE subject_id=?)", (subject_id,))
        con.execute("DELETE FROM marks WHERE subject_id=?", (subject_id,))
        con.execute("DELETE FROM attendance WHERE subject_id=?", (subject_id,))
        con.execute("DELETE FROM exams WHERE subject_id=?", (subject_id,))
        con.execute("DELETE FROM timetable WHERE subject_id=?", (subject_id,))
        con.execute("DELETE FROM assignments WHERE subject_id=?", (subject_id,))
        con.execute("DELETE FROM subjects WHERE id=?", (subject_id,))
    kept_subjects = list(con.execute("SELECT id,code FROM subjects WHERE code IN ('DBMS','OS','PY','DSA','CN','SE') ORDER BY CASE code WHEN 'DBMS' THEN 1 WHEN 'OS' THEN 2 WHEN 'PY' THEN 3 WHEN 'DSA' THEN 4 WHEN 'CN' THEN 5 ELSE 6 END"))
    if len(kept_subjects) == 6:
        exam_offsets = {"DBMS":14,"OS":16,"PY":18,"DSA":21,"CN":23,"SE":26}
        con.execute("DELETE FROM exams")
        for subject in kept_subjects:
            con.execute("INSERT INTO exams(subject_id,exam_date,details) VALUES(?,date('now',?),?)", (subject["id"], f"+{exam_offsets[subject['code']]} day", "End Term examination"))
        con.execute("DELETE FROM timetable")
        days = ["Monday","Tuesday","Wednesday","Thursday","Friday"]
        times = ["09:00","10:00","11:00","12:00","14:00","15:00"]
        slot = 0
        for day in days:
            for time in times:
                subject_id = kept_subjects[slot % len(kept_subjects)]["id"]
                con.execute("INSERT INTO timetable(subject_id,day,start_time,room) VALUES(?,?,?,?)", (subject_id, day, time, f"Room {101 + slot % 6}"))
                slot += 1


setup()
