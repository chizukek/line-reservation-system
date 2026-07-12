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
const doctorAMorningSlots = ["10:00", "11:00"];

const doctorAAfternoonSlots = ["16:00", "17:00", "18:00"];

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
    const slots = [];

    // 午前：火・水・金
    if (weekday === 2 || weekday === 3 || weekday === 5) {
      slots.push(...doctorAMorningSlots);
    }

    // 午後：月・火・水・金
    if (weekday === 1 || weekday === 2 || weekday === 3 || weekday === 5) {
      slots.push(...doctorAAfternoonSlots);
    }

    return slots;
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

  // A医師
  if (doctorId === 1) {
    // 午前は1枠1人
    if (slot === "10:00" || slot === "11:00") {
      return 1;
    }

    // 午後は1枠2人
    if (slot === "16:00" || slot === "17:00" || slot === "18:00") {
      return 2;
    }
  }

  // B医師は今まで通り1枠2人
  return 2;
}

function getSlotLabel(slot, doctorId) {
  doctorId = Number(doctorId);

  // A医師だけ時間帯として表示
  if (doctorId === 1) {
    const labels = {
      "10:00": "10:00〜11:00",
      "11:00": "11:00〜12:00",
      "16:00": "16:00〜17:00",
      "17:00": "17:00〜18:00",
      "18:00": "18:00〜18:45",
    };

    return labels[slot] || slot;
  }

  // B医師は開始時刻だけ表示
  return slot;
}

const doctorASlots = ["10:00", "11:00", "16:00", "17:00", "18:00"];

const doctorBSlots = [...morningSlots, ...afternoonSlots];

function getDisplaySlots(doctorId) {
  doctorId = Number(doctorId);

  if (doctorId === 1) {
    return doctorASlots;
  }

  return doctorBSlots;
}

const allSlots = [
  ...new Set([
    ...morningSlots,
    ...afternoonSlots,
    ...doctorAMorningSlots,
    ...doctorAAfternoonSlots,
  ]),
].sort();

module.exports = {
  morningSlots,
  afternoonSlots,
  doctorAMorningSlots,
  doctorAAfternoonSlots,
  allSlots,
  holidays,
  getSlotsForDate,
  getCapacityForSlot,
  getSlotLabel,
  getDisplaySlots,
};
