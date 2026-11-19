"""Validated imports, provenance and portable reports for the college ERP."""
import csv
import hashlib
import io
import math
import sqlite3
import urllib.request
import zipfile
from datetime import date

from flask import Response, g, jsonify, request, session
from werkzeug.utils import secure_filename

UCI_PAGE = "https://archive.ics.uci.edu/dataset/320/student+performance"
UCI_DOWNLOAD = "https://archive.ics.uci.edu/static/public/320/student+performance.zip"


def number(value, low, high):
    result = float(value)
    if not math.isfinite(result) or not low <= result <= high:
        raise ValueError(f"Number must be between {low} and {high}.")
    return result


def import_file(con, raw, kind, filename, source):
    if kind not in ("marks", "attendance", "benchmark"):
        raise ValueError("Choose marks, attendance, or benchmark.")
    if len(raw) > 2_000_000:
        raise ValueError("CSV must be smaller than 2 MB.")
    checksum = hashlib.sha256(raw).hexdigest()
    if con.execute("SELECT id FROM import_batches WHERE kind=? AND checksum=?", (kind, checksum)).fetchone():
        raise ValueError("This file has already been imported. No duplicate records were added.")
    text = raw.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text), delimiter=";" if kind == "benchmark" else ",")
    required = {"school", "G1", "G2", "G3", "absences"} if kind == "benchmark" else {"roll_no", "subject_code", "date"} | ({"assessment", "score"} if kind == "marks" else {"attended", "total"})
    if not required.issubset(reader.fieldnames or []):
        raise ValueError("Required columns: " + ", ".join(sorted(required)))
    rows = list(reader)
    if not 1 <= len(rows) <= 5000:
        raise ValueError("Import between 1 and 5,000 records at a time.")
    batch = con.execute("INSERT INTO import_batches(kind,source,filename,checksum,row_count,imported_by) VALUES(?,?,?,?,?,?)", (kind, source, filename, checksum, len(rows), session["user_id"])).lastrowid
    for index, row in enumerate(rows, 2):
        try:
            if kind == "benchmark":
                grades = [number(row[key], 0, 20) for key in ("G1", "G2", "G3")]
                absence = number(row["absences"], 0, 365)
                if not absence.is_integer() or row["school"] not in ("GP", "MS"):
                    raise ValueError("Invalid school or absence count.")
                con.execute("INSERT INTO benchmark_rows(batch_id,school,g1,g2,g3,absences) VALUES(?,?,?,?,?,?)", (batch, row["school"], *grades, int(absence)))
                continue
            student = con.execute("SELECT id FROM students WHERE roll_no=?", (row["roll_no"].strip(),)).fetchone()
            subject = con.execute("SELECT id FROM subjects WHERE code=?", (row["subject_code"].strip().upper(),)).fetchone()
            if not student or not subject:
                raise ValueError("Student roll number or subject code does not exist. Create it first.")
            day = date.fromisoformat(row["date"]).isoformat()
            if kind == "marks":
                score = number(row["score"], 0, 100)
                assessment = row["assessment"].strip()
                if not assessment:
                    raise ValueError("Assessment is required.")
                con.execute("INSERT INTO marks(student_id,subject_id,assessment,score,date,source,batch_id) VALUES(?,?,?,?,?,?,?)", (student[0], subject[0], assessment, score, day, source, batch))
            else:
                total = number(row["total"], 1, 10000)
                attended = number(row["attended"], 0, total)
                if not total.is_integer() or not attended.is_integer():
                    raise ValueError("Attendance counts must be whole numbers.")
                con.execute("INSERT INTO attendance(student_id,subject_id,attended,total,date,source,batch_id) VALUES(?,?,?,?,?,?,?)", (student[0], subject[0], int(attended), int(total), day, source, batch))
        except (ValueError, TypeError, KeyError) as exc:
            raise ValueError(f"CSV row {index}: {exc}") from exc
    return len(rows)


def csv_response(headers, rows, filename):
    stream = io.StringIO()
    writer = csv.writer(stream)
    writer.writerow(headers)
    for row in rows:
        # Spreadsheet applications must not interpret user text as formulas.
        writer.writerow(["'" + value if isinstance(value, str) and value.startswith(("=", "+", "-", "@")) else value for value in row])
    return Response(stream.getvalue(), mimetype="text/csv", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def register(app, api):
    @app.get("/api/data-center")
    @api("admin", "teacher")
    def data_center(con):
        batches = [dict(r) for r in con.execute("SELECT b.*,u.name imported_by_name FROM import_batches b LEFT JOIN users u ON u.id=b.imported_by ORDER BY b.id DESC LIMIT 50")]
        provenance = []
        for table in ("marks", "attendance"):
            provenance.extend({"kind": table, **dict(r)} for r in con.execute(f"SELECT source,COUNT(*) records FROM {table} GROUP BY source"))
        latest = con.execute("SELECT id FROM import_batches WHERE kind='benchmark' ORDER BY id DESC LIMIT 1").fetchone()
        benchmark = None
        if latest:
            benchmark = dict(con.execute("SELECT COUNT(*) records,ROUND(AVG(g1)*5,1) first_grade,ROUND(AVG(g2)*5,1) second_grade,ROUND(AVG(g3)*5,1) final_grade,ROUND(AVG(absences),1) absences FROM benchmark_rows WHERE batch_id=?", (latest[0],)).fetchone())
            benchmark["distribution"] = [dict(r) for r in con.execute("SELECT CASE WHEN g3<10 THEN 'Below pass' WHEN g3<14 THEN 'Pass' ELSE 'Strong' END band,COUNT(*) count FROM benchmark_rows WHERE batch_id=? GROUP BY band", (latest[0],))]
            benchmark["batch_id"] = latest[0]
        audit_sql = "SELECT a.action,a.created_at,u.name actor FROM audit_log a LEFT JOIN users u ON u.id=a.user_id"
        params = ()
        if session["role"] == "teacher":
            audit_sql += " WHERE a.user_id=?"
            params = (session["user_id"],)
        return jsonify(batches=batches, provenance=provenance, benchmark=benchmark,
                       citation={"url": UCI_PAGE, "download": UCI_DOWNLOAD, "author": "Cortez, P. (2008)", "doi": "10.24432/C5TG7T", "license": "CC BY 4.0"},
                       activity=[dict(r) for r in con.execute(audit_sql + " ORDER BY a.id DESC LIMIT 30", params)])

    @app.post("/api/admin/import")
    @api("admin")
    def upload_csv(con):
        upload = request.files.get("file")
        source = request.form.get("source", "").strip()
        if not upload or not upload.filename or not source or len(source) > 200:
            return jsonify(error="Choose a CSV and provide a source label (up to 200 characters)."), 400
        try:
            count = import_file(con, upload.read(2_000_001), request.form.get("kind"), secure_filename(upload.filename), "Uploaded: " + source)
            con.commit()
            g.audit = f"Imported {count} {request.form.get('kind')} records"
            return jsonify(message=f"Imported {count} records. Dashboard data has been refreshed.")
        except (ValueError, UnicodeError, csv.Error, sqlite3.IntegrityError) as exc:
            con.rollback()
            return jsonify(error=str(exc)), 400

    @app.post("/api/admin/import-uci")
    @api("admin")
    def fetch_uci(con):
        try:
            with urllib.request.urlopen(UCI_DOWNLOAD, timeout=15) as response:
                raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise ValueError("Unexpected archive size.")
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                if "student-mat.csv" in archive.namelist():
                    raw = archive.read("student-mat.csv")
                else:
                    if archive.getinfo("student.zip").file_size > 2_000_000:
                        raise ValueError("Unexpected nested archive size.")
                    with zipfile.ZipFile(io.BytesIO(archive.read("student.zip"))) as nested:
                        raw = nested.read("student-mat.csv")
            count = import_file(con, raw, "benchmark", "student-mat.csv", "UCI Student Performance · Mathematics · official download")
            con.commit()
            g.audit = f"Imported {count} UCI benchmark records"
            return jsonify(message=f"Imported {count} public benchmark records from UCI.")
        except ValueError as exc:
            con.rollback()
            return jsonify(error=str(exc)), 400
        except Exception:
            con.rollback()
            return jsonify(error="UCI could not be reached. Download the dataset using the source link, unzip student.zip, then upload student-mat.csv as a benchmark."), 502

    @app.get("/api/export/<kind>")
    @api("admin", "teacher", "student")
    def export(con, kind):
        if kind not in ("marks", "attendance"):
            return jsonify(error="Choose marks or attendance."), 404
        fields = "r.assessment,r.score" if kind == "marks" else "r.attended,r.total"
        headers = ["roll_no", "subject_code"] + (["assessment", "score"] if kind == "marks" else ["attended", "total"]) + ["date", "source"]
        sql = f"SELECT st.roll_no,s.code,{fields},r.date,r.source FROM {kind} r JOIN students st ON st.id=r.student_id JOIN subjects s ON s.id=r.subject_id"
        params = ()
        if session["role"] == "student":
            sql += " WHERE r.student_id=?"
            params = (session["student_id"],)
        elif session["role"] == "teacher":
            sql += " WHERE s.teacher_id=?"
            params = (session["user_id"],)
        return csv_response(headers, con.execute(sql + " ORDER BY r.id DESC", params), f"edusense-{kind}.csv")

    @app.get("/api/import-template/<kind>")
    @api("admin")
    def template(con, kind):
        if kind not in ("marks", "attendance"):
            return jsonify(error="Choose marks or attendance."), 404
        headers = ["roll_no", "subject_code"] + (["assessment", "score"] if kind == "marks" else ["attended", "total"]) + ["date"]
        return csv_response(headers, [], f"{kind}-template.csv")
