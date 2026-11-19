// Exercise every page renderer using fresh synthetic test data, without a server.
const fs = require('fs');
const vm = require('vm');
const { spawnSync } = require('child_process');
const result = spawnSync(process.env.PYTHON || 'python3', ['-c', `
import tempfile, json
from pathlib import Path
import db
with tempfile.TemporaryDirectory() as folder:
    db.DB_FILE = str(Path(folder) / 'test.db')
    from app import app
    output = {}
    for role,username,password in [('admin','admin','admin123'),('teacher','teacher3','teacher123'),('student','stu01','student123')]:
        with app.test_client() as client:
            client.post('/login', data=dict(role=role,username=username,password=password))
            output[role] = {'data':client.get('/api/summary').get_json()}
            if role != 'student': output[role]['center'] = client.get('/api/data-center').get_json()
    print(json.dumps(output))
`], { cwd: __dirname, encoding: 'utf8' });
if (result.status !== 0) throw Error(result.stderr);
const fixtures = JSON.parse(result.stdout);
const source = fs.readFileSync(__dirname + '/static/app.js', 'utf8').replace('load(false);', '');
let pages = 0;
for (const role of ['admin', 'teacher', 'student']) {
  const nodes = new Map();
  const document = {
    body: { dataset: { role, name: 'Test User' } }, addEventListener() {},
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', addEventListener() {}, setAttribute() {}, classList: { remove() {}, toggle() {}, add() {} } });
      return nodes.get(id);
    }
  };
  const context = vm.createContext({ document, console, setTimeout });
  vm.runInContext(source, context);
  context.fixture = fixtures[role];
  pages += vm.runInContext(`
    data=fixture.data; if(fixture.center) centerData=fixture.center;
    for(const name of navByRole[role]) {
      page=name; drawPage();
      if(!app.innerHTML || app.innerHTML.includes('undefined')) throw Error(role+' / '+name);
    }
    navByRole[role].length;
  `, context);
  // Explicitly cover the otherwise empty benchmark summary view.
  if (role === 'admin') {
    vm.runInContext(`centerData.benchmark={records:2,first_grade:50,second_grade:60,final_grade:65,absences:3.5,batch_id:1};page='Data Center';drawPage();`, context);
    vm.runInContext(`
      page='Overview';showAllStudents=false;drawPage();
      if(!app.innerHTML.includes('class="hero"'))throw Error('Missing hero band');
      if(!app.innerHTML.includes('data-show-students'))throw Error('Missing student list control');
      if((app.innerHTML.match(/data-overflow="1" hidden/g)||[]).length!==data.students.length-6)throw Error('Overview should start with six visible students');
      showAllStudents=true;drawPage();
      if(app.innerHTML.includes('data-overflow="1" hidden'))throw Error('View all did not reveal students');
      if(/[^>]↗/.test(app.innerHTML))throw Error('KPI cards must not show trend arrows');
      const emptyChart=subjectChart([],[]);
      if(!emptyChart.includes('first record'))throw Error('Missing chart empty state');
    `, context);
  }
}
if(!fs.existsSync(__dirname+'/static/images/campus-hero.png'))throw Error('Missing local hero asset');
console.log(`PASS: ${pages} sidebar page renderers and populated benchmark view. Browser layout is not covered.`);
