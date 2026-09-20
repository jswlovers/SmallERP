/** RFC4180 수준의 CSV 파서 (따옴표, 이스케이프된 따옴표, 셀 내 개행 지원) */
export function parseCsv(text) {
  const s = text.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

/** 엑셀 수식 주입 방지: = + - @ 로 시작하는 셀은 앞에 ' 를 붙인다(숫자 형태의 음수는 제외). */
const safe = (v) => {
  const s = String(v ?? '');
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};

export function toCsv(rows) {
  return '﻿' + rows.map((r) => r.map((v) => `"${safe(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
}
