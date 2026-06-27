function makeSlots(startHour, endHour) {
  const slots = [];

  for (let hour = startHour; hour < endHour; hour++) {
    slots.push(`${String(hour).padStart(2, "0")}:00`);
    slots.push(`${String(hour).padStart(2, "0")}:30`);
  }

  return slots;
}

const morningSlots = makeSlots(9, 13); // 09:00〜12:30
const afternoonSlots = makeSlots(14, 18); // 14:00〜17:30

const holidays = [];

function getWeekday(dateText) {
  const [year, month, day] = dateText.split("-").map(Number);
  return new Date(year, month - 1, day).getDay();
}

function isEvenWeekSaturday(dateText) {
  const base = new Date(2026, 0, 3); // 基準土曜日
  const [year, month, day] = dateText.split("-").map(Number);
  const target = new Date(year, month - 1, day);

  const diffDays = Math.floor((target - base) / (1000 * 60 * 60 * 24));
  const diffWeeks = Math.floor(diffDays / 7);

  return diffWeeks % 2 === 0;
}

function getSlotsForDate(dateText) {
  if (holidays.includes(dateText)) {
    return [];
  }

  const weekday = getWeekday(dateText);

  // 0日 1月 2火 3水 4木 5金 6土
  if (weekday === 1) return morningSlots; // 月
  if (weekday === 3) return afternoonSlots; // 水
  if (weekday === 4) return morningSlots; // 木
  if (weekday === 5) return afternoonSlots; // 金

  if (weekday === 6) {
    return isEvenWeekSaturday(dateText) ? morningSlots : afternoonSlots;
  }

  return [];
}

module.exports = {
  morningSlots,
  afternoonSlots,
  allSlots: [...morningSlots, ...afternoonSlots],
  holidays,
  getSlotsForDate,
};
