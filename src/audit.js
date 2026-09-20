/** 민감 작업 감사 로그 (환불, 직원 변경, 비밀번호 변경, 문자 충전, 고객 일괄 가져오기/내보내기 등) */
export function audit(db, req, action, detail = '') {
  db.prepare('INSERT INTO audit_log(shop_id, staff_id, action, detail, ip) VALUES (?,?,?,?,?)').run(
    req.user.shop, req.user.sid, action, String(detail), req.ip ?? null,
  );
}
