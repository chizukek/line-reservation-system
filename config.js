function makeSlots(startHour, endHour, intervalMinutes = 30) {
  const slots = [];

  const start = startHour * 60;
  const end = endHour * 60;

  for (let min = start; min < end; min += intervalMinutes) {
    const hour = Math.floor(min / 60);
    const minute = min % 60;

    slots.push(
      `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    );
  }

  return slots;
}

// B医師用：今まで通り
const morningSlots = makeSlots(9, 13, 30);
// 09:00、09:30〜12:30

const afternoonSlots = makeSlots(14, 18, 30);
// 14:00、14:30〜17:30

// A医師用
// DBには枠の開始時刻を保存する
// A医師用：30分単位
const doctorAMondaySlots = makeSlots(17, 19, 30);
// 17:00、17:30、18:00、18:30

const doctorATuesdayWednesdaySlots = ["12:00"];
// 12:00〜12:30

const doctorAFridaySlots = ["17:00"];
// 17:00〜17:30

const holidays = [];

function getWeekday(dateText) {
  const [year, month, day] = dateText.split("-").map(Number);

  return new Date(year, month - 1, day).getDay();
}

function isEvenWeekSaturday(dateText) {
  const base = new Date(2026, 0, 3);

  const [year, month, day] = dateText.split("-").map(Number);
  const target = new Date(year, month - 1, day);

  const diffDays = Math.floor((target - base) / (1000 * 60 * 60 * 24));

  const diffWeeks = Math.floor(diffDays / 7);

  return diffWeeks % 2 === 0;
}

function getSlotsForDate(dateText, doctorId) {
  doctorId = Number(doctorId);

  if (holidays.includes(dateText)) {
    return [];
  }

  const weekday = getWeekday(dateText);

  // 0:日 1:月 2:火 3:水 4:木 5:金 6:土

  // A医師
  if (doctorId === 1) {
    // 月曜：17:00〜19:00
    if (weekday === 1) {
      return doctorAMondaySlots;
    }

    // 火曜・水曜：12:00〜12:30
    if (weekday === 2 || weekday === 3) {
      return doctorATuesdayWednesdaySlots;
    }

    // 金曜：17:00〜17:30
    if (weekday === 5) {
      return doctorAFridaySlots;
    }

    return [];
  }

  // B医師：今まで通り
  if (doctorId === 2) {
    if (weekday === 1) {
      return morningSlots;
    }

    if (weekday === 3) {
      return afternoonSlots;
    }

    if (weekday === 4) {
      return morningSlots;
    }

    if (weekday === 5) {
      return afternoonSlots;
    }

    if (weekday === 6) {
      return isEvenWeekSaturday(dateText) ? morningSlots : afternoonSlots;
    }

    return [];
  }

  return [];
}

function getCapacityForSlot(dateText, slot, doctorId) {
  doctorId = Number(doctorId);

  // A医師は全枠30分・定員3人
  if (doctorId === 1) {
    return 3;
  }

  // B医師は1枠2人
  if (doctorId === 2) {
    return 2;
  }

  return 0;
}

function getSlotLabel(slot, doctorId) {
  doctorId = Number(doctorId);

  if (doctorId === 1) {
    const labels = {
      "12:00": "12:00〜12:30",
      "17:00": "17:00〜17:30",
      "17:30": "17:30〜18:00",
      "18:00": "18:00〜18:30",
      "18:30": "18:30〜19:00",
    };

    return labels[slot] || slot;
  }

  // B医師は開始時刻だけ表示
  return slot;
}

const doctorASlots = [
  ...new Set([
    ...doctorAMondaySlots,
    ...doctorATuesdayWednesdaySlots,
    ...doctorAFridaySlots,
  ]),
].sort();

const doctorBSlots = [...morningSlots, ...afternoonSlots];

function getDisplaySlots(doctorId) {
  doctorId = Number(doctorId);

  if (doctorId === 1) {
    return doctorASlots;
  }

  return doctorBSlots;
}

const RESERVATION_DAYS = 60;

const allSlots = [
  ...new Set([
    ...morningSlots,
    ...afternoonSlots,
    ...doctorAMondaySlots,
    ...doctorATuesdayWednesdaySlots,
    ...doctorAFridaySlots,
  ]),
].sort();

module.exports = {
  morningSlots,
  afternoonSlots,
  doctorAMondaySlots,
  doctorATuesdayWednesdaySlots,
  doctorAFridaySlots,
  allSlots,
  holidays,
  getSlotsForDate,
  getCapacityForSlot,
  getSlotLabel,
  getDisplaySlots,
  RESERVATION_DAYS,
};
