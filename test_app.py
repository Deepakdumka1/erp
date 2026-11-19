"""Regression tests use a disposable copy; the campus database is never changed."""
import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import db
from app import app


class ERPTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        copied = str(Path(self.directory.name) / 'college.db')
        with sqlite3.connect(db.DB_FILE) as source, sqlite3.connect(copied) as target:
            source.backup(target)
        self.database = patch.object(db, 'DB_FILE', copied)
        self.database.start()
        app.config['TESTING'] = True
        self.client = app.test_client()
        self.login()

    def tearDown(self):
        self.database.stop()
        self.directory.cleanup()

    def login(self, role='admin'):
        user, password = {'admin': ('admin', 'admin123'), 'teacher': ('teacher3', 'teacher123'), 'student': ('stu01', 'student123')}[role]
        response = self.client.post('/login', data=dict(role=role, username=user, password=password), follow_redirects=True)
        self.assertEqual(response.request.path, '/portal')

    def upload(self, text, kind='marks'):
        return self.client.post('/api/admin/import', data={'kind': kind, 'source': 'Regression fixture, not real college data', 'file': (io.BytesIO(text.encode()), 'fixture.csv')})

    def count(self, table):
        with db.connect() as con:
            return con.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0]

    def test_role_portals_and_exports(self):
        for role in ('admin', 'teacher', 'student'):
            self.login(role)
            self.assertEqual(self.client.get('/api/summary').status_code, 200)
            self.assertEqual(self.client.get('/api/export/marks').status_code, 200)
            self.assertEqual(self.client.get('/api/data-center').status_code, 401 if role == 'student' else 200)
            if role == 'student':
                text = self.client.get('/api/export/marks').get_data(as_text=True)
                self.assertIn('CSE-A-01', text)
                self.assertNotIn('CSE-A-02', text)

    def test_atomic_import_and_provenance(self):
        original = self.count('marks')
        text = 'roll_no,subject_code,assessment,score,date\nCSE-A-01,DBMS,Midterm,81,2026-11-19\n'
        self.assertEqual(self.upload(text).status_code, 200)
        self.assertEqual(self.count('marks'), original + 1)
        self.assertIn('Regression fixture', self.client.get('/api/export/marks').get_data(as_text=True))
        self.assertEqual(self.upload(text).status_code, 400)
        self.assertEqual(self.count('marks'), original + 1)
        self.assertGreater(self.count('audit_log'), 0)

    def test_bad_row_rolls_back_entire_batch(self):
        original, batches = self.count('marks'), self.count('import_batches')
        text = 'roll_no,subject_code,assessment,score,date\nCSE-A-01,DBMS,Midterm,81,2026-11-19\nMISSING,DBMS,Midterm,70,2026-11-19\n'
        response = self.upload(text)
        self.assertEqual(response.status_code, 400)
        self.assertIn('row 3', response.get_json()['error'])
        self.assertEqual(self.count('marks'), original)
        self.assertEqual(self.count('import_batches'), batches)

    def test_import_permission_and_validation(self):
        for role in ('student', 'teacher'):
            self.login(role)
            self.assertEqual(self.upload('invalid').status_code, 401)
        self.login()
        text = 'roll_no,subject_code,attended,total,date\nCSE-A-01,DBMS,3.5,4,2026-11-19\n'
        self.assertEqual(self.upload(text, 'attendance').status_code, 400)
        text = 'roll_no,subject_code,assessment,score,date\nCSE-A-01,DBMS,Midterm,nan,2026-11-19\n'
        self.assertEqual(self.upload(text).status_code, 400)

    def test_benchmark_stays_separate(self):
        # Small test fixture exercises the UCI schema; it is not published as UCI data.
        students, marks = self.count('students'), self.count('marks')
        text = 'school;G1;G2;G3;absences\nGP;10;12;14;3\nMS;8;10;12;4\n'
        self.assertEqual(self.upload(text, 'benchmark').status_code, 200)
        summary = self.client.get('/api/data-center').get_json()['benchmark']
        self.assertEqual(summary['records'], 2)
        self.assertEqual(summary['final_grade'], 65)
        self.assertEqual(self.count('students'), students)
        self.assertEqual(self.count('marks'), marks)

    def test_restart_preserves_custom_subjects_and_assignments(self):
        with db.connect() as con:
            teacher = con.execute("SELECT id FROM users WHERE username='teacher3'").fetchone()[0]
            con.execute("INSERT INTO subjects(code,name,teacher_id) VALUES('CUSTOM','Custom Course',?)", (teacher,))
            con.commit()
        db.setup()
        db.setup()
        with db.connect() as con:
            row = con.execute("SELECT teacher_id FROM subjects WHERE code='CUSTOM'").fetchone()
            self.assertIsNotNone(row)
            self.assertEqual(row[0], teacher)

    def test_nonfinite_simulation_rejected(self):
        self.login('student')
        response = self.client.post('/api/student/what-if', json=dict(average_marks=float('nan'), attendance=80, assignment_completion=80))
        self.assertEqual(response.status_code, 400)

    def test_invalid_reference_returns_json(self):
        response = self.client.post('/api/teacher/record', json=dict(kind='marks', student_id=999999, subject_id=1, score=80))
        self.assertEqual(response.status_code, 400)
        self.assertIsNotNone(response.get_json())

    def test_timetable_conflict(self):
        with db.connect() as con:
            row = con.execute('SELECT * FROM timetable LIMIT 1').fetchone()
        response = self.client.post('/api/teacher/item', json=dict(kind='timetable', subject_id=row['subject_id'], day=row['day'], time=row['start_time'], room=row['room']))
        self.assertEqual(response.status_code, 409)

    def test_cross_origin_change_rejected(self):
        response = self.client.post('/api/teacher/notice', json=dict(title='x', message='y'), headers={'Origin': 'https://unrelated.example'})
        self.assertEqual(response.status_code, 403)

    def test_model_report(self):
        report = self.client.get('/api/summary').get_json()['model']
        self.assertEqual(report['test_rows'], 120)
        self.assertEqual(sum(map(sum, report['confusion_matrix'])), 120)

    def test_bad_dates_and_missing_subject(self):
        response = self.client.post('/api/admin/fee', json=dict(student_id=1, total=100, paid=10, due_date='yesterday'))
        self.assertEqual(response.status_code, 400)
        response = self.client.put('/api/admin/subject/1', json=dict(teacher_id='oops'))
        self.assertEqual(response.status_code, 400)

    def test_student_profile_and_report_card(self):
        data = self.client.get('/api/student/1').get_json()
        self.assertEqual(data['profile']['roll_no'], 'CSE-A-01')
        self.assertIn('stats', data)
        self.assertEqual(self.client.get('/api/student/99999').status_code, 404)
        self.assertIn(b'Report card', self.client.get('/report/1').data)
        self.login('student')
        self.assertEqual(self.client.get('/api/student/1').status_code, 401)
        self.assertEqual(self.client.get('/report/1').status_code, 200)
        self.assertEqual(self.client.get('/report/2').status_code, 404)

    def test_attendance_session(self):
        self.login('teacher')
        subject = self.client.get('/api/summary').get_json()['subjects'][0]['id']
        before = self.count('attendance')
        response = self.client.post('/api/teacher/attendance/session', json=dict(subject_id=subject, present=[1, 2, 3]))
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(self.count('attendance'), before + self.count('students'))
        with db.connect() as con:
            self.assertEqual(con.execute("SELECT SUM(attended) FROM attendance WHERE source='Class session'").fetchone()[0], 3)
        with db.connect() as con:
            other = con.execute("SELECT id FROM subjects WHERE teacher_id IS NOT (SELECT id FROM users WHERE username='teacher3') LIMIT 1").fetchone()[0]
        self.assertEqual(self.client.post('/api/teacher/attendance/session', json=dict(subject_id=other, present=[])).status_code, 403)
        self.assertEqual(self.client.post('/api/teacher/attendance/session', json=dict(subject_id=subject, present=[99999])).status_code, 400)

    def test_deletes_respect_ownership(self):
        self.client.post('/api/teacher/notice', json=dict(title='Temp', message='Remove me'))
        with db.connect() as con:
            nid = con.execute("SELECT id FROM notices WHERE title='Temp'").fetchone()[0]
        self.assertEqual(self.client.delete(f'/api/notice/{nid}').status_code, 200)
        self.assertEqual(self.client.delete(f'/api/notice/{nid}').status_code, 404)
        self.login('teacher')
        with db.connect() as con:
            mine = con.execute("SELECT a.id FROM assignments a JOIN subjects s ON s.id=a.subject_id JOIN users u ON u.id=s.teacher_id WHERE u.username='teacher3' LIMIT 1").fetchone()[0]
            theirs = con.execute("SELECT a.id FROM assignments a JOIN subjects s ON s.id=a.subject_id JOIN users u ON u.id=s.teacher_id WHERE u.username!='teacher3' LIMIT 1").fetchone()[0]
        self.assertEqual(self.client.delete(f'/api/teacher/item/assignment/{theirs}').status_code, 403)
        self.assertEqual(self.client.delete(f'/api/teacher/item/assignment/{mine}').status_code, 200)
        with db.connect() as con:
            self.assertIsNone(con.execute('SELECT id FROM assignments WHERE id=?', (mine,)).fetchone())
        self.assertEqual(self.client.delete('/api/teacher/item/bogus/1').status_code, 400)

    def test_change_password(self):
        self.login('student')
        bad = self.client.post('/api/account/password', json=dict(current='wrong', new='newpass123'))
        self.assertEqual(bad.status_code, 400)
        weak = self.client.post('/api/account/password', json=dict(current='student123', new='short'))
        self.assertEqual(weak.status_code, 400)
        ok = self.client.post('/api/account/password', json=dict(current='student123', new='newpass123'))
        self.assertEqual(ok.status_code, 200)
        self.client.get('/logout')
        response = self.client.post('/login', data=dict(role='student', username='stu01', password='newpass123'), follow_redirects=True)
        self.assertEqual(response.request.path, '/portal')

    def test_login_rate_limit_and_security_headers(self):
        import app as app_module
        app_module._login_failures.clear()
        self.client.get('/logout')
        for _ in range(5):
            self.client.post('/login', data=dict(role='admin', username='admin', password='nope'))
        blocked = self.client.post('/login', data=dict(role='admin', username='admin', password='admin123'))
        self.assertEqual(blocked.status_code, 429)
        self.assertIn(b'Too many failed attempts', blocked.data)
        app_module._login_failures.clear()
        page = self.client.get('/login')
        self.assertEqual(page.headers['X-Frame-Options'], 'DENY')
        self.assertIn("script-src 'self'", page.headers['Content-Security-Policy'])
        self.assertEqual(self.client.get('/nope').status_code, 404)
        self.assertEqual(self.client.get('/api/nope').get_json()['error'], 'Not found.')

    def test_live_stream_sends_changes(self):
        self.client.post('/api/teacher/notice', json=dict(title='Live', message='Push'))
        with db.connect() as con:
            last = con.execute('SELECT MAX(id) FROM audit_log').fetchone()[0]
        response = self.client.get('/api/stream', headers={'Last-Event-ID': str(last - 1)}, buffered=False)
        self.assertEqual(response.mimetype, 'text/event-stream')
        chunks = response.response
        text = ''
        for chunk in chunks:
            text += chunk.decode() if isinstance(chunk, bytes) else chunk
            if 'event: change' in text:
                break
        response.close()
        self.assertIn('Published notice: Live', text)
        self.client.get('/logout')
        self.assertEqual(self.client.get('/api/stream').status_code, 401)


    def test_origin_host_match_ignores_scheme(self):
        ok = self.client.post('/api/teacher/notice', json=dict(title='A', message='B'), headers={'Origin': 'https://localhost'})
        self.assertEqual(ok.status_code, 200)
        bad = self.client.post('/api/teacher/notice', json=dict(title='A', message='B'), headers={'Origin': 'https://evil.example'})
        self.assertEqual(bad.status_code, 403)
        null = self.client.post('/api/teacher/notice', json=dict(title='A', message='B'), headers={'Origin': 'null'})
        self.assertEqual(null.status_code, 403)

    def test_health_and_proxy_origin(self):
        self.assertEqual(self.client.get('/healthz').get_json()['status'], 'ok')
        from werkzeug.middleware.proxy_fix import ProxyFix
        import app as app_module
        original = app_module.app.wsgi_app
        app_module.app.wsgi_app = ProxyFix(original, x_for=1, x_proto=1, x_host=1)
        try:
            response = self.client.post('/api/teacher/notice', json=dict(title='Proxy', message='Behind TLS'),
                                        headers={'Origin': 'https://edusense.example', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'edusense.example'})
            self.assertEqual(response.status_code, 200)
        finally:
            app_module.app.wsgi_app = original

if __name__ == '__main__':
    unittest.main()
