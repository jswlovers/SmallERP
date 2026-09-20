// 개발/시연용 계정과 샘플 데이터 생성 (멱등). 운영 환경에서는 실행을 거부한다.
//   npm run seed
//   테스트 매장 계정:  test  / test1234
//   플랫폼 관리자:     admin / admin12345!
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { ensureAdmin } from '../src/bootstrap.js';
import { addDays, todayLocal } from '../src/util.js';

if (process.env.NODE_ENV === 'production') {
  console.error('운영 환경에서는 seed 를 실행할 수 없습니다.');
  process.exit(1);
}

process.env.SMS_LOG = '0';
const db = openDb();
const app = buildApp({ db });

const ADMIN = { login: process.env.ADMIN_LOGIN || 'admin', password: process.env.ADMIN_PASSWORD || 'admin12345!' };
const adminFromEnv = !!process.env.ADMIN_PASSWORD;
// 이미 관리자가 있으면 비밀번호를 덮어쓰지 않는다(변경한 비밀번호 보호)
const adminCreated = !db.prepare('SELECT 1 FROM admin_user WHERE login_id = ?').get(ADMIN.login);
if (adminCreated) ensureAdmin(db, ADMIN.login, ADMIN.password);

const TEST = { loginId: 'test', password: 'test1234' };
let created = false;

if (!db.prepare('SELECT 1 FROM staff WHERE login_id = ?').get(TEST.loginId)) {
  created = true;
  const call = async (method, url, body, token) => {
    const res = await app.inject({ method, url, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });
    const data = res.body ? JSON.parse(res.body) : null;
    if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode} ${data?.error}`);
    return data;
  };

  const { token } = await call('POST', '/api/auth/register', { shopName: '테스트 헤어살롱', ownerName: '김원장', ...TEST });
  const me = await call('GET', '/api/me', null, token);
  const owner = me.staff.id;
  const d1 = (await call('POST', '/api/staff', { name: '이디자이너', commissionRate: 30 }, token)).id;
  const d2 = (await call('POST', '/api/staff', { name: '박네일', commissionRate: 40 }, token)).id;
  const svc = Object.fromEntries((await call('GET', '/api/services', null, token)).map((s) => [s.name, s]));

  const people = [
    ['홍길동', '010-1000-0001', '1990-05-01', true], ['김영희', '010-1000-0002', '1988-09-20', true],
    ['이철수', '010-1000-0003', '1995-01-15', false], ['박지민', '010-1000-0004', '1992-12-03', true],
    ['최수아', '010-1000-0005', '2000-03-27', true], ['정민호', '010-1000-0006', '1985-07-08', false],
    ['강하늘', '010-1000-0007', '1998-11-11', true], ['윤서연', '010-1000-0008', '1993-06-30', true],
  ];
  const custs = [];
  for (const [name, phone, birth, consent] of people)
    custs.push((await call('POST', '/api/customers', { name, phone, birth, marketingConsent: consent, grade: custs.length < 2 ? 'vip' : 'normal', staffId: d1 }, token)).id);
  await call('POST', `/api/customers/${custs[0]}/prepaid`, { amount: 300000 }, token);

  // 지난 30일 매출 (미래 날짜 예약과 겹치지 않는 과거 결제)
  const menu = [svc['커트'], svc['펌'], svc['염색'], svc['젤 네일']];
  const staffs = [owner, d1, d2];
  const today = todayLocal();
  for (let i = 1; i <= 30; i++) {
    const day = addDays(today, -i);
    const n = 1 + (i % 3);
    for (let k = 0; k < n; k++) {
      const s = menu[(i + k) % menu.length];
      await call('POST', '/api/payments', {
        customerId: custs[(i + k) % custs.length], staffId: staffs[(i + k) % staffs.length],
        items: [{ serviceId: s.id }], lines: [{ method: k % 2 ? 'cash' : 'card', amount: s.price }], paidAt: `${day}T${String(10 + k * 2).padStart(2, '0')}:00`,
      }, token);
    }
  }
  // 오늘/내일 예약
  const slots = [[0, '10:00', d1, 0, ['커트']], [0, '13:00', d1, 1, ['염색']], [0, '15:00', d2, 2, ['젤 네일']], [1, '11:00', owner, 3, ['펌']], [1, '14:00', d2, 4, ['젤 네일']]];
  for (const [off, time, staffId, ci, names] of slots)
    await call('POST', '/api/reservations', { customerId: custs[ci], staffId, startAt: `${addDays(today, off)}T${time}`, serviceIds: names.map((n) => svc[n].id) }, token);
}

console.log(created ? '테스트 매장/샘플 데이터를 생성했습니다.' : '테스트 매장이 이미 있어 건너뜁니다.');
console.log(`\n  [매장]   http://localhost:${process.env.PORT || 3001}/            ${TEST.loginId} / ${TEST.password}`);
console.log(`  [관리자] http://localhost:${process.env.PORT || 3001}/admin.html  ${ADMIN.login} / ${adminFromEnv ? '(.env 의 ADMIN_PASSWORD)' : adminCreated ? ADMIN.password : '(이미 존재: 기존 비밀번호 유지)'}\n`);
await app.close();
