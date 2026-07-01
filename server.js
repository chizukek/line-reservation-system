require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const express = require("express");
const session = require("express-session");
const line = require("@line/bot-sdk");
const config = require("./config");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PORT = process.env.PORT || 3000;
const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const app = express();
app.set("view engine", "ejs");
app.set("views", "views");
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
  }),
);
app.use((req, res, next) => {
  res.locals.isPatientLoggedIn = Boolean(req.session.patientNumber);
  res.locals.isAdminLoggedIn = Boolean(req.session.isAdmin);
  next();
});

function formatJapaneseDate(dateText) {
  const date = new Date(dateText);

  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];

  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日(${weekdays[date.getDay()]})`;
}

function isValidPatientNumber(patientNumber) {
  return /^\d{5}$/.test(patientNumber);
}

function isValidDateText(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function isValidSlot(slot) {
  return config.allSlots.includes(slot);
}

function isWithinReservationPeriod(date) {
  const today = new Date();

  const maxDate = new Date();
  maxDate.setDate(maxDate.getDate() + 30);

  const targetDate = new Date(date);

  return targetDate > today && targetDate <= maxDate;
}

function requireAdminLogin(req, res, next) {
  if (!req.session.isAdmin) {
    return res.redirect("/admin-login");
  }

  next();
}

async function createAuditLog(action, target = null, detail = null) {
  try {
    await prisma.auditLog.create({
      data: {
        action,
        target,
        detail,
      },
    });
  } catch (error) {
    console.error("AuditLog error:", error);
  }
}

app.use((req, res, next) => {
  res.locals.formatJapaneseDate = formatJapaneseDate;
  next();
});

app.get("/psychiatry", (req, res) => {
  if (req.session.patientNumber) {
    return res.redirect("/mypage");
  }

  res.render("psychiatry", {
    title: "心療内科再診予約",
  });
});

app.get("/verify", (req, res) => {
  if (req.session.patientNumber) {
    return res.redirect("/mypage");
  }

  res.render("verify", {
    title: "本人確認",
  });
});

app.post("/mypage", async (req, res) => {
  const { patientNumber, birthYear, birthMonth, birthDay } = req.body;

  const birthDate = `${birthYear}-${String(birthMonth).padStart(2, "0")}-${String(birthDay).padStart(2, "0")}`;

  const patient = await prisma.patient.findUnique({
    where: {
      patientNumber,
    },
    include: {
      reservations: true,
    },
  });

  if (!patient || !patient.birthDate) {
    return res.render("verify", {
      title: "本人確認",
      error: "患者番号または生年月日が違います。",
    });
  }

  const inputDate = new Date(birthDate);
  const patientDate = new Date(patient.birthDate);

  const sameBirthday =
    inputDate.getFullYear() === patientDate.getFullYear() &&
    inputDate.getMonth() === patientDate.getMonth() &&
    inputDate.getDate() === patientDate.getDate();

  if (!sameBirthday) {
    return res.render("verify", {
      title: "本人確認",
      error: "患者番号または生年月日が違います。",
    });
  }

  req.session.patientNumber = patient.patientNumber;

  res.redirect("/mypage");
});

app.get("/logout", (req, res) => {
  if (!req.session.patientNumber) {
    return res.redirect("/psychiatry");
  }

  res.render("logout-confirm", {
    title: "ログアウト確認",
  });
});

app.post("/logout", (req, res) => {
  req.session.patientNumber = null;
  req.session.changeReservationId = null;
  req.session.completeMessage = null;

  res.redirect("/psychiatry");
});

app.get("/complete", (req, res) => {
  const completeMessage = req.session.completeMessage;

  if (!completeMessage) {
    return res.redirect("/mypage");
  }

  req.session.completeMessage = null;

  res.render("complete", completeMessage);
});

app.get("/mypage", async (req, res) => {
  const patientNumber = req.session.patientNumber;

  if (!patientNumber) {
    return res.redirect("/psychiatry");
  }

  const today = new Date().toLocaleDateString("sv-SE");

  const patient = await prisma.patient.findUnique({
    where: {
      patientNumber,
    },
  });

  const reservation = await prisma.reservation.findFirst({
    where: {
      patientNumber,
      date: {
        gt: today,
      },
    },
    orderBy: [{ date: "asc" }, { slot: "asc" }],
  });

  if (!reservation) {
    req.session.changeReservationId = null;
  }

  res.render("mypage", {
    title: "マイページ",
    patient,
    reservation,
  });
});

app.get("/new", (req, res) => {
  if (!req.session.patientNumber) {
    return res.redirect("/psychiatry");
  }

  req.session.changeReservationId = null;
  res.redirect("/");
});

app.get("/api/slots", (req, res) => {
  const date = req.query.date;

  if (!date) {
    return res.json([]);
  }

  const slots = config.getSlotsForDate(date);

  res.json(slots);
});

app.get("/", async (req, res) => {
  if (!req.session.patientNumber) {
    return res.redirect("/psychiatry");
  }
  const week = Number(req.query.week || 0);
  const dates = [];

  for (let i = week * 7; i < week * 7 + 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);

    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");

    const value = `${year}-${month}-${day}`;
    const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
    const label = `${d.getMonth() + 1}/${d.getDate()}(${weekdays[d.getDay()]})`;

    dates.push({
      value,
      label,
    });
  }

  const reservations = await prisma.reservation.findMany();
  const today = new Date().toLocaleDateString("sv-SE");
  const maxReservableDate = new Date();
  maxReservableDate.setDate(maxReservableDate.getDate() + 30);
  const maxReservableText = maxReservableDate.toLocaleDateString("sv-SE");

  const nextWeekStart = new Date();
  nextWeekStart.setDate(nextWeekStart.getDate() + (week + 1) * 7);
  const nextWeekStartText = nextWeekStart.toLocaleDateString("sv-SE");

  const canGoNextWeek = nextWeekStartText <= maxReservableText;
  res.render("index", {
    title: "予約表",
    week,
    dates,
    slots: config.allSlots,
    reservations,
    isChangeMode: Boolean(req.session.changeReservationId),
    today,
    maxReservableText,
    canGoNextWeek,
    holidays: config.holidays,
    getSlotsForDate: config.getSlotsForDate,
  });
});

app.get("/change", async (req, res) => {
  const patientNumber = req.session.patientNumber;

  if (!patientNumber) {
    return res.redirect("/psychiatry");
  }

  const today = new Date().toLocaleDateString("sv-SE");

  const reservation = await prisma.reservation.findFirst({
    where: {
      patientNumber,
      date: {
        gt: today,
      },
    },
    orderBy: [{ date: "asc" }, { slot: "asc" }],
  });

  if (!reservation) {
    return res.redirect("/mypage");
  }

  req.session.changeReservationId = reservation.id;

  res.redirect("/");
});

app.get("/confirm", async (req, res) => {
  const patientNumber = req.session.patientNumber;

  if (!patientNumber) {
    return res.redirect("/psychiatry");
  }

  const date = req.query.date;
  const slot = req.query.slot;

  if (
    !isValidDateText(date) ||
    !isValidSlot(slot) ||
    !isWithinReservationPeriod(date)
  ) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "予約内容が不正です。",
      detail: "",
      backUrl: "/",
    });
  }

  const availableSlots = config.getSlotsForDate(date);

  if (!availableSlots.includes(slot)) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "その時間は診療時間外です。",
      detail: "",
      backUrl: "/",
    });
  }

  const patient = await prisma.patient.findUnique({
    where: {
      patientNumber,
    },
  });

  if (!patient) {
    req.session.patientNumber = null;
    return res.redirect("/psychiatry");
  }

  res.render("confirm", {
    title: req.session.changeReservationId ? "予約変更確認" : "予約確認",
    patient,
    date,
    slot,
    isChangeMode: Boolean(req.session.changeReservationId),
  });
});

app.post("/reserve", async (req, res) => {
  const patientNumber = req.session.patientNumber;

  if (!patientNumber) {
    return res.redirect("/psychiatry");
  }

  const date = req.body.date;
  const slot = req.body.slot;
  const changeReservationId = req.session.changeReservationId;

  if (
    !isValidPatientNumber(patientNumber) ||
    !isValidDateText(date) ||
    !isValidSlot(slot) ||
    !isWithinReservationPeriod(date)
  ) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "予約内容が不正です。",
      detail: "",
      backUrl: "/",
    });
  }

  const availableSlots = config.getSlotsForDate(date);

  if (!availableSlots.includes(slot)) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "その時間は診療時間外です。",
      detail: "",
      backUrl: "/",
    });
  }

  const patient = await prisma.patient.findUnique({
    where: { patientNumber },
  });

  if (!patient) {
    req.session.patientNumber = null;
    return res.redirect("/psychiatry");
  }

  let reservationCode;

  try {
    await prisma.$transaction(
      async (tx) => {
        const count = await tx.reservation.count({
          where: {
            date,
            slot,
            ...(changeReservationId
              ? {
                  id: {
                    not: changeReservationId,
                  },
                }
              : {}),
          },
        });

        if (count >= 2) {
          throw new Error("FULL");
        }

        if (changeReservationId) {
          const currentReservation = await tx.reservation.findUnique({
            where: { id: changeReservationId },
          });

          if (
            !currentReservation ||
            currentReservation.patientNumber !== patientNumber
          ) {
            throw new Error("NOT_FOUND");
          }

          await tx.reservation.update({
            where: { id: changeReservationId },
            data: {
              date,
              slot,
            },
          });

          return;
        }

        const todayText = new Date().toLocaleDateString("sv-SE");

        const existingReservation = await tx.reservation.findFirst({
          where: {
            patientNumber,
            date: {
              gte: todayText,
            },
          },
          orderBy: [{ date: "asc" }, { slot: "asc" }],
        });

        if (existingReservation) {
          throw new Error(
            `DUPLICATE:${existingReservation.date} ${existingReservation.slot}`,
          );
        }

        reservationCode = Math.random()
          .toString(36)
          .substring(2, 8)
          .toUpperCase();

        await tx.reservation.create({
          data: {
            patientNumber,
            date,
            slot,
            reservationCode,
          },
        });
      },
      {
        isolationLevel: "Serializable",
      },
    );
  } catch (error) {
    if (error.message === "FULL") {
      return res.render("error", {
        title: "予約不可",
        heading: "予約不可",
        message: `${date} ${slot} は満員です。`,
        detail: "",
        backUrl: "/",
      });
    }

    if (error.message === "NOT_FOUND") {
      req.session.changeReservationId = null;
      return res.redirect("/mypage");
    }
    if (error.message.startsWith("DUPLICATE:")) {
      return res.render("error", {
        title: "予約不可",
        heading: "予約不可",
        message: "すでに予約があります。",
        detail: `既存予約：${error.message.replace("DUPLICATE:", "")}`,
        backUrl: "/mypage",
      });
    }

    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "予約処理中にエラーが発生しました。",
      detail: "",
      backUrl: "/",
    });
  }

  await createAuditLog(
    changeReservationId ? "患者予約変更" : "患者予約",
    `患者番号:${patientNumber}`,
    `${date} ${slot}`,
  );

  req.session.changeReservationId = null;

  req.session.completeMessage = {
    title: changeReservationId ? "予約変更完了" : "予約完了",
    heading: changeReservationId ? "予約を変更しました" : "予約が完了しました",
    message: changeReservationId
      ? "予約内容を更新しました。"
      : "ご予約ありがとうございました。",
    reservation: {
      date,
      slot,
    },
    showProgress: !changeReservationId,
    backUrl: "/mypage",
    backLabel: "マイページへ戻る",
  };

  return res.redirect("/complete");
});

app.get("/admin-login", (req, res) => {
  res.render("admin-login", {
    title: "管理者ログイン",
    error: null,
  });
});

app.post("/admin-login", async (req, res) => {
  const password = req.body.password;

  if (password !== ADMIN_PASSWORD) {
    return res.render("admin-login", {
      title: "管理者ログイン",
      error: "パスワードが違います。",
    });
  }

  req.session.isAdmin = true;

  await createAuditLog("管理者ログイン", null, req.ip);

  res.redirect("/admin");
});

app.get("/admin-logout", async (req, res) => {
  await createAuditLog("管理者ログアウト", null, req.ip);

  req.session.isAdmin = false;
  res.redirect("/admin-login");
});

app.get("/admin", async (req, res) => {
  if (!req.session.isAdmin) {
    return res.redirect("/admin-login");
  }

  const searchPatientNumber = String(req.query.patientNumber || "").trim();
  const searchDate = String(req.query.date || "").trim();
  const today = new Date().toLocaleDateString("sv-SE");

  const where = {};

  if (searchPatientNumber) {
    where.patientNumber = searchPatientNumber;
  }

  if (searchDate) {
    where.date = searchDate;
  }

  const reservations = await prisma.reservation.findMany({
    where,
    include: {
      patient: true,
    },
    orderBy: [{ date: "asc" }, { slot: "asc" }],
  });

  res.render("admin", {
    title: "予約一覧",
    reservations,
    searchPatientNumber,
    searchDate,
    today,
  });
});

app.get("/admin/logs", async (req, res) => {
  if (!req.session.isAdmin) {
    return res.redirect("/admin-login");
  }

  const logs = await prisma.auditLog.findMany({
    orderBy: {
      createdAt: "desc",
    },
    take: 100,
  });

  res.render("admin-logs", {
    title: "操作ログ",
    logs,
  });
});

app.get("/admin/add", (req, res) => {
  if (!req.session.isAdmin) {
    return res.redirect("/admin-login");
  }

  res.render("admin-add", {
    title: "電話予約",
    slots: config.allSlots,
    error: null,
  });
});

app.post("/admin/add", async (req, res) => {
  if (!req.session.isAdmin) {
    return res.redirect("/admin-login");
  }

  const { patientNumber, date, slot } = req.body;

  if (!isValidPatientNumber(patientNumber)) {
    return res.render("admin-add", {
      title: "電話予約",
      slots: config.allSlots,
      error: "患者番号は5桁の数字で入力してください。",
    });
  }

  if (
    !isValidDateText(date) ||
    !isValidSlot(slot) ||
    !isWithinReservationPeriod(date)
  ) {
    return res.render("admin-add", {
      title: "電話予約",
      slots: config.allSlots,
      error: "予約内容が不正です。",
    });
  }

  const availableSlots = config.getSlotsForDate(date);

  if (!availableSlots.includes(slot)) {
    return res.render("admin-add", {
      title: "電話予約",
      slots: config.allSlots,
      error: "その時間は診療時間外です。",
    });
  }

  const patient = await prisma.patient.findUnique({
    where: {
      patientNumber,
    },
  });

  if (!patient) {
    return res.render("admin-add", {
      title: "電話予約",
      slots: config.allSlots,
      error: "患者番号が見つかりません。",
    });
  }

  res.render("admin-add-confirm", {
    title: "電話予約確認",
    patient,
    date,
    slot,
  });
});

app.post("/admin/add/complete", async (req, res) => {
  if (!req.session.isAdmin) {
    return res.redirect("/admin-login");
  }

  const { patientNumber, date, slot } = req.body;

  if (!isValidPatientNumber(patientNumber)) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "患者番号が不正です。",
      detail: "",
      backUrl: "/",
    });
  }

  if (!isValidDateText(date)) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "日付が不正です。",
      detail: "",
      backUrl: "/admin/add",
    });
  }

  if (!isValidSlot(slot)) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "時間帯が不正です。",
      detail: "",
      backUrl: "/admin/add",
    });
  }

  if (!isWithinReservationPeriod(date)) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "予約可能期間外です。",
      detail: "",
      backUrl: "/admin/add",
    });
  }

  const patient = await prisma.patient.findUnique({
    where: {
      patientNumber,
    },
  });

  if (!patient) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "患者番号が見つかりません。",
      detail: "",
      backUrl: "/admin/add",
    });
  }

  const availableSlots = config.getSlotsForDate(date);

  if (!availableSlots.includes(slot)) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: `${date} ${slot} は診療時間外です。`,
      detail: "",
      backUrl: "/admin/add",
    });
  }

  let reservationCode;

  try {
    await prisma.$transaction(
      async (tx) => {
        const todayText = new Date().toLocaleDateString("sv-SE");

        const existingReservation = await tx.reservation.findFirst({
          where: {
            patientNumber,
            date: {
              gte: todayText,
            },
          },
          orderBy: [{ date: "asc" }, { slot: "asc" }],
        });

        if (existingReservation) {
          throw new Error(
            `DUPLICATE:${existingReservation.date} ${existingReservation.slot}`,
          );
        }

        const count = await tx.reservation.count({
          where: {
            date,
            slot,
          },
        });

        if (count >= 2) {
          throw new Error("FULL");
        }

        reservationCode = Math.random()
          .toString(36)
          .substring(2, 8)
          .toUpperCase();

        await tx.reservation.create({
          data: {
            patientNumber,
            date,
            slot,
            reservationCode,
          },
        });
      },
      {
        isolationLevel: "Serializable",
      },
    );
  } catch (error) {
    if (error.message.startsWith("DUPLICATE:")) {
      return res.render("error", {
        title: "予約不可",
        heading: "予約不可",
        message: "すでに予約があります。",
        detail: `既存予約：${error.message.replace("DUPLICATE:", "")}`,
        backUrl: "/admin/add",
      });
    }

    if (error.message === "FULL") {
      return res.render("error", {
        title: "予約不可",
        heading: "予約不可",
        message: `${date} ${slot} は満員です。`,
        detail: "",
        backUrl: "/admin/add",
      });
    }

    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "予約処理中にエラーが発生しました。",
      detail: "",
      backUrl: "/admin/add",
    });
  }

  await createAuditLog(
    "電話予約追加",
    `患者番号:${patientNumber}`,
    `${date} ${slot}`,
  );

  return res.render("admin-complete", {
    title: "電話予約完了",
    message: "電話予約を登録しました。",
    buttonText: "予約一覧へ戻る",
    buttonLink: "/admin",
  });
});

app.get("/admin/edit/:id", async (req, res) => {
  if (!req.session.isAdmin) {
    return res.redirect("/admin-login");
  }

  const id = Number(req.params.id);

  const reservation = await prisma.reservation.findUnique({
    where: { id },
    include: { patient: true },
  });

  if (!reservation) {
    return res.render("error", {
      title: "エラー",
      heading: "エラー",
      message: "予約が見つかりません。",
      detail: "",
      backUrl: "/admin",
    });
  }

  res.render("admin-edit", {
    title: "予約変更",
    reservation,
    slots: config.allSlots,
    error: null,
  });
});

app.post("/admin/edit/:id", async (req, res) => {
  if (!req.session.isAdmin) {
    return res.redirect("/admin-login");
  }

  const id = Number(req.params.id);
  const { date, slot } = req.body;

  const reservation = await prisma.reservation.findUnique({
    where: { id },
    include: { patient: true },
  });

  if (!reservation) {
    return res.render("error", {
      title: "エラー",
      heading: "エラー",
      message: "予約が見つかりません。",
      detail: "",
      backUrl: "/admin",
    });
  }

  const renderEdit = (error) => {
    return res.render("admin-edit", {
      title: "予約変更",
      reservation: {
        ...reservation,
        date,
        slot,
      },
      slots: config.allSlots,
      error,
    });
  };

  const availableSlots = config.getSlotsForDate(date);

  if (!availableSlots.includes(slot)) {
    return renderEdit(`${date} ${slot} は診療時間外です。`);
  }

  const sameDayReservation = await prisma.reservation.findFirst({
    where: {
      patientNumber: reservation.patientNumber,
      date,
      id: {
        not: id,
      },
    },
  });

  if (sameDayReservation) {
    return renderEdit(
      `同じ日にすでに予約があります。既存予約：${sameDayReservation.date} ${sameDayReservation.slot}`,
    );
  }

  const count = await prisma.reservation.count({
    where: {
      date,
      slot,
      id: {
        not: id,
      },
    },
  });

  if (count >= 2) {
    return renderEdit(`${date} ${slot} は満員です。`);
  }

  return res.render("admin-edit-confirm", {
    title: "予約変更確認",
    reservation,
    newReservation: {
      id,
      date,
      slot,
    },
  });
});

app.post("/admin/edit/:id/complete", async (req, res) => {
  if (!req.session.isAdmin) {
    return res.redirect("/admin-login");
  }

  const id = Number(req.params.id);
  const { date, slot } = req.body;

  const reservation = await prisma.reservation.findUnique({
    where: { id },
    include: { patient: true },
  });

  if (!reservation) {
    return res.render("error", {
      title: "エラー",
      heading: "エラー",
      message: "予約が見つかりません。",
      detail: "",
      backUrl: "/admin",
    });
  }

  await prisma.reservation.update({
    where: { id },
    data: {
      date,
      slot,
    },
  });

  await createAuditLog(
    "予約変更",
    `予約ID:${id}`,
    `${reservation.date} ${reservation.slot} → ${date} ${slot}`,
  );

  return res.render("admin-complete", {
    title: "予約変更完了",
    message: "予約を変更しました。",
    buttonText: "予約一覧へ戻る",
    buttonLink: "/admin",
  });
});

app.get("/admin/patients", async (req, res) => {
  if (!req.session.isAdmin) {
    return res.redirect("/admin-login");
  }

  const patients = await prisma.patient.findMany({
    orderBy: {
      patientNumber: "asc",
    },
  });

  res.render("patients", {
    title: "患者一覧",
    patients,
  });
});

app.get("/admin/patients/add", (req, res) => {
  if (!req.session.isAdmin) {
    return res.redirect("/admin-login");
  }

  res.render("patient-add", {
    title: "患者登録",
    error: null,
  });
});

app.post("/admin/patients/add", async (req, res) => {
  if (!req.session.isAdmin) {
    return res.redirect("/admin-login");
  }

  const patientNumber = String(req.body.patientNumber || "").trim();
  const name = String(req.body.name || "").trim();

  const year = String(req.body.birthYear || "");
  const month = String(req.body.birthMonth || "").padStart(2, "0");
  const day = String(req.body.birthDay || "").padStart(2, "0");

  const birthDateText = `${year}-${month}-${day}`;
  const birthDate = new Date(birthDateText);

  if (
    !isValidPatientNumber(patientNumber) ||
    !name ||
    !year ||
    !month ||
    !day ||
    Number.isNaN(birthDate.getTime())
  ) {
    return res.render("patient-add", {
      title: "患者登録",
      error: "患者番号・氏名・生年月日を正しく入力してください。",
    });
  }

  const existingPatient = await prisma.patient.findUnique({
    where: {
      patientNumber,
    },
  });

  if (existingPatient) {
    return res.render("patient-add", {
      title: "患者登録",
      error: "この患者番号はすでに登録されています。",
    });
  }

  await prisma.patient.create({
    data: {
      patientNumber,
      name,
      birthDate,
    },
  });

  await createAuditLog("患者登録", `患者番号:${patientNumber}`, name);

  return res.render("admin-complete", {
    title: "患者登録完了",
    message: "患者情報を登録しました。",
    buttonText: "患者一覧へ戻る",
    buttonLink: "/admin/patients",
  });
});

app.get("/admin/patients/edit/:id", async (req, res) => {
  if (!req.session.isAdmin) {
    return res.redirect("/admin-login");
  }

  const id = Number(req.params.id);

  const patient = await prisma.patient.findUnique({
    where: { id },
  });

  if (!patient) {
    return res.render("error", {
      title: "エラー",
      heading: "エラー",
      message: "患者が見つかりません。",
      detail: "",
      backUrl: "/admin/patients",
    });
  }

  const birth = patient.birthDate ? new Date(patient.birthDate) : new Date();

  res.render("patient-edit", {
    title: "患者編集",
    patient,
    birthYear: birth.getFullYear(),
    birthMonth: birth.getMonth() + 1,
    birthDay: birth.getDate(),
    currentYear: new Date().getFullYear(),
    error: null,
  });
});

app.post("/admin/patients/edit/:id", async (req, res) => {
  if (!req.session.isAdmin) {
    return res.redirect("/admin-login");
  }

  const id = Number(req.params.id);
  const patientNumber = String(req.body.patientNumber || "").trim();
  const name = String(req.body.name || "").trim();

  const year = String(req.body.birthYear || "");
  const month = String(req.body.birthMonth || "").padStart(2, "0");
  const day = String(req.body.birthDay || "").padStart(2, "0");
  const birthDateText = `${year}-${month}-${day}`;
  const birthDate = new Date(birthDateText);

  const patient = await prisma.patient.findUnique({
    where: { id },
  });

  if (!patient) {
    return res.render("error", {
      title: "エラー",
      heading: "エラー",
      message: "患者が見つかりません。",
      detail: "",
      backUrl: "/admin/patients",
    });
  }

  if (
    !isValidPatientNumber(patientNumber) ||
    !name ||
    !year ||
    !month ||
    !day ||
    Number.isNaN(birthDate.getTime())
  ) {
    return res.render("patient-edit", {
      title: "患者編集",
      patient: {
        ...patient,
        patientNumber,
        name,
      },
      birthYear: Number(year) || new Date(patient.birthDate).getFullYear(),
      birthMonth: Number(month) || new Date(patient.birthDate).getMonth() + 1,
      birthDay: Number(day) || new Date(patient.birthDate).getDate(),
      currentYear: new Date().getFullYear(),
      error: "患者番号・氏名・生年月日を正しく入力してください。",
    });
  }

  const duplicate = await prisma.patient.findFirst({
    where: {
      patientNumber,
      id: {
        not: id,
      },
    },
  });

  if (duplicate) {
    return res.render("patient-edit", {
      title: "患者編集",
      patient: {
        ...patient,
        patientNumber,
        name,
      },
      birthYear: Number(year),
      birthMonth: Number(month),
      birthDay: Number(day),
      currentYear: new Date().getFullYear(),
      error: "この患者番号はすでに使われています。",
    });
  }

  return res.render("patient-edit-confirm", {
    title: "患者編集確認",
    patient,
    newPatient: {
      id,
      patientNumber,
      name,
      birthDateText,
    },
  });
});

app.post("/admin/patients/edit/:id/complete", async (req, res) => {
  if (!req.session.isAdmin) {
    return res.redirect("/admin-login");
  }

  const id = Number(req.params.id);
  const patientNumber = String(req.body.patientNumber || "").trim();
  const name = String(req.body.name || "").trim();
  const birthDateText = String(req.body.birthDate || "");
  const birthDate = new Date(birthDateText);

  if (
    !isValidPatientNumber(patientNumber) ||
    !name ||
    !isValidDateText(birthDateText) ||
    Number.isNaN(birthDate.getTime())
  ) {
    return res.render("error", {
      title: "エラー",
      heading: "エラー",
      message: "患者情報が不正です。",
      detail: "",
      backUrl: `/admin/patients/edit/${id}`,
    });
  }

  const patient = await prisma.patient.findUnique({
    where: { id },
  });

  if (!patient) {
    return res.render("error", {
      title: "エラー",
      heading: "エラー",
      message: "患者が見つかりません。",
      detail: "",
      backUrl: "/admin/patients",
    });
  }

  const duplicate = await prisma.patient.findFirst({
    where: {
      patientNumber,
      id: {
        not: id,
      },
    },
  });

  if (duplicate) {
    return res.render("error", {
      title: "エラー",
      heading: "エラー",
      message: "この患者番号はすでに使われています。",
      detail: "",
      backUrl: `/admin/patients/edit/${id}`,
    });
  }

  await prisma.patient.update({
    where: { id },
    data: {
      patientNumber,
      name,
      birthDate,
    },
  });

  await createAuditLog(
    "患者編集",
    `患者ID:${id}`,
    `患者番号:${patient.patientNumber} → ${patientNumber}`,
  );

  return res.render("admin-complete", {
    title: "患者編集完了",
    message: "患者情報を更新しました。",
    buttonText: "患者一覧へ戻る",
    buttonLink: "/admin/patients",
  });
});

app.get("/admin/patients/delete/:id", async (req, res) => {
  if (!req.session.isAdmin) {
    return res.redirect("/admin-login");
  }

  const id = Number(req.params.id);

  const patient = await prisma.patient.findUnique({
    where: { id },
  });

  if (!patient) {
    return res.render("error", {
      title: "エラー",
      heading: "エラー",
      message: "患者が見つかりません。",
      detail: "",
      backUrl: "/admin/patients",
    });
  }

  res.render("patient-delete", {
    title: "患者削除確認",
    patient,
  });
});

app.post("/admin/patients/delete/:id", async (req, res) => {
  if (!req.session.isAdmin) {
    return res.redirect("/admin-login");
  }

  const id = Number(req.params.id);

  const patient = await prisma.patient.findUnique({
    where: { id },
  });

  if (!patient) {
    return res.render("error", {
      title: "エラー",
      heading: "エラー",
      message: "患者が見つかりません。",
      detail: "",
      backUrl: "/admin/patients",
    });
  }

  const reservationCount = await prisma.reservation.count({
    where: {
      patientNumber: patient.patientNumber,
    },
  });

  if (reservationCount > 0) {
    return res.render("error", {
      title: "削除できません",
      heading: "削除できません",
      message: "この患者には予約が存在するため削除できません。",
      detail: `予約件数：${reservationCount}件`,
      backUrl: "/admin/patients",
    });
  }

  await prisma.patient.delete({
    where: { id },
  });

  await createAuditLog(
    "患者削除",
    `患者ID:${id}`,
    `患者番号:${patient.patientNumber}`,
  );

  return res.render("admin-complete", {
    title: "患者削除完了",
    message: "患者情報を削除しました。",
    buttonText: "患者一覧へ戻る",
    buttonLink: "/admin/patients",
  });
});

app.get("/admin/cancel-confirm/:id", requireAdminLogin, async (req, res) => {
  const reservation = await prisma.reservation.findUnique({
    where: {
      id: Number(req.params.id),
    },
    include: {
      patient: true,
    },
  });

  if (!reservation) {
    return res.redirect("/admin");
  }

  res.render("admin-cancel-confirm", {
    title: "予約キャンセル確認",
    reservation,
  });
});

app.post("/admin/cancel/:id", requireAdminLogin, async (req, res) => {
  const id = Number(req.params.id);

  const reservation = await prisma.reservation.findUnique({
    where: { id },
    include: { patient: true },
  });

  if (!reservation) {
    return res.render("error", {
      title: "エラー",
      heading: "エラー",
      message: "予約が見つかりません。",
      detail: "",
      backUrl: "/admin",
    });
  }

  await prisma.reservation.delete({
    where: { id },
  });

  await createAuditLog(
    "予約キャンセル",
    `予約ID:${id}`,
    `患者番号:${reservation.patientNumber} / ${reservation.date} ${reservation.slot}`,
  );

  return res.render("admin-complete", {
    title: "キャンセル完了",
    message: "予約をキャンセルしました。",
    buttonText: "予約一覧へ戻る",
    buttonLink: "/admin",
  });
});

app.post("/cancel", async (req, res) => {
  const id = Number(req.body.id);
  const from = req.body.from;

  const reservation = await prisma.reservation.findUnique({
    where: {
      id,
    },
    include: {
      patient: true,
    },
  });

  if (!reservation) {
    return res.render("error", {
      title: "エラー",
      heading: "エラー",
      message: "予約が見つかりません。",
      detail: "",
      backUrl: "/",
    });
  }

  res.render("cancel-confirm", {
    title: "予約キャンセル確認",
    reservation,
    from,
  });
});

app.post("/cancel-confirm", async (req, res) => {
  const id = Number(req.body.id);
  const from = req.body.from;

  const reservation = await prisma.reservation.findUnique({
    where: { id },
  });

  await prisma.reservation.delete({
    where: {
      id,
    },
  });

  await createAuditLog(
    "患者予約キャンセル",
    `予約ID:${id}`,
    `患者番号:${reservation.patientNumber}`,
  );

  if (from === "admin") {
    return res.redirect("/admin");
  }

  req.session.completeMessage = {
    title: "キャンセル完了",
    heading: "予約をキャンセルしました",
    message: "キャンセルが完了しました。",
    reservation: null,
    showProgress: false,
    backUrl: "/mypage",
    backLabel: "マイページへ戻る",
  };

  return res.redirect("/complete");
});

app.post("/line/webhook", line.middleware(lineConfig), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleLineEvent));
    res.status(200).end();
  } catch (error) {
    console.error(error);
    res.status(500).end();
  }
});

async function handleLineEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return;
  }

  const text = event.message.text.trim();
  const appUrl = process.env.APP_URL;

  if (text === "予約") {
    return lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: "template",
          altText: "予約メニュー",
          template: {
            type: "buttons",
            title: "予約メニュー",
            text: "ご希望の操作を選んでください。",
            actions: [
              {
                type: "uri",
                label: "予約する",
                uri: `${appUrl}/psychiatry`,
              },
              {
                type: "uri",
                label: "予約をキャンセルする",
                uri: `${appUrl}/psychiatry`,
              },
            ],
          },
        },
      ],
    });
  }

  if (text === "キャンセル") {
    return lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: "template",
          altText: "キャンセルメニュー",
          template: {
            type: "buttons",
            title: "キャンセル",
            text: "予約キャンセル画面を開きます。",
            actions: [
              {
                type: "uri",
                label: "キャンセル画面を開く",
                uri: `${appUrl}/psychiatry`,
              },
            ],
          },
        },
      ],
    });
  }

  return lineClient.replyMessage({
    replyToken: event.replyToken,
    messages: [
      {
        type: "template",
        altText: "メニュー",
        template: {
          type: "buttons",
          title: "予約システム",
          text: "ご希望の操作を選んでください。",
          actions: [
            {
              type: "uri",
              label: "予約する",
              uri: `${appUrl}/psychiatry`,
            },
            {
              type: "uri",
              label: "予約をキャンセルする",
              uri: `${appUrl}/psychiatry`,
            },
          ],
        },
      },
    ],
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
