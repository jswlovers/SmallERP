import { DEFAULT_SETTINGS, getSetting } from './settings.js';
import { addMinutes } from './util.js';

const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const weekdayOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
const INACTIVE = "('cancelled','noshow')";

/**
 * 예약 가능 여부 검증. 불가하면 사유 문자열, 가능하면 null.
 * 검사 순서: 휴무일 → 근무시간/요일 휴무 → 브레이크 타임 → 예약금지 시간대 → 담당자 중복 예약.
 * 스케줄 데이터가 없으면 제한하지 않는다(기존 동작 유지).
 */
export function checkAvailability(db, shop, staffId, start, end, { excludeId = 0 } = {}) {
  const day = start.slice(0, 10);
  const wd = weekdayOf(day);
  const s = minutes(start.slice(11));
  const e = end.slice(0, 10) > day ? 24 * 60 : minutes(end.slice(11));

  const off = db.prepare('SELECT reason FROM day_off WHERE shop_id = ? AND date = ? AND (staff_id IS NULL OR staff_id = ?)').get(shop, day, staffId);
  if (off) return `휴무일입니다${off.reason ? ` (${off.reason})` : ''}.`;

  const sch = db.prepare('SELECT * FROM staff_schedule WHERE staff_id = ? AND weekday = ?').get(staffId, wd);
  if (sch) {
    if (sch.off) return '해당 요일은 담당자 휴무입니다.';
    if (s < minutes(sch.start_time) || e > minutes(sch.end_time)) return `근무시간(${sch.start_time}~${sch.end_time})이 아닙니다.`;
  }

  for (const b of db.prepare('SELECT * FROM staff_break WHERE staff_id = ? AND (weekday IS NULL OR weekday = ?)').all(staffId, wd))
    if (s < minutes(b.end_time) && e > minutes(b.start_time)) return `${b.label}(${b.start_time}~${b.end_time}) 시간입니다.`;

  const blk = db
    .prepare('SELECT reason FROM time_block WHERE shop_id = ? AND (staff_id IS NULL OR staff_id = ?) AND start_at < ? AND end_at > ?')
    .get(shop, staffId, end, start);
  if (blk) return `예약금지 시간대입니다${blk.reason ? ` (${blk.reason})` : ''}.`;

  const dup = db
    .prepare(`SELECT id FROM reservation WHERE shop_id = ? AND staff_id = ? AND id <> ? AND status NOT IN ${INACTIVE} AND start_at < ? AND end_at > ?`)
    .get(shop, staffId, excludeId, end, start);
  if (dup) return '해당 시간에 담당 직원의 다른 예약이 있습니다.';
  return null;
}

/** 특정 날짜의 예약 가능 시작 시각 목록 (담당자별) */
export function freeSlots(db, shop, staffId, date, durationMin) {
  const cfg = getSetting(db, shop, 'reservation', DEFAULT_SETTINGS.reservation);
  const wd = weekdayOf(date);
  const sch = db.prepare('SELECT * FROM staff_schedule WHERE staff_id = ? AND weekday = ?').get(staffId, wd);
  if (sch?.off) return [];
  const open = minutes(sch?.start_time ?? cfg.openTime);
  const close = minutes(sch?.end_time ?? cfg.closeTime);
  const step = Number(cfg.unit) || 30;
  const out = [];
  for (let t = open; t + durationMin <= close; t += step) {
    const start = `${date}T${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    if (!checkAvailability(db, shop, staffId, start, addMinutes(start, durationMin))) out.push(start.slice(11));
  }
  return out;
}
