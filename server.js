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

app.get("/psychiatry", (req, res) => {
  res.render("psychiatry", {
    title: "心療内科再診予約",
  });
});

app.post("/mypage", async (req, res) => {
  const { patientNumber, birthDate } = req.body;

  const patient = await prisma.patient.findUnique({
    where: {
      patientNumber,
    },
    include: {
      reservations: true,
    },
  });

  if (!patient || !patient.birthDate) {
    return res.render("psychiatry", {
      title: "心療内科再診予約",
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
    return res.render("psychiatry", {
      title: "心療内科再診予約",
      error: "患者番号または生年月日が違います。",
    });
  }

  req.session.patientNumber = patient.patientNumber;

  res.redirect("/mypage");
});

app.get("/logout", (req, res) => {
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

app.post("/admin-login", (req, res) => {
  const password = req.body.password;

  if (password !== ADMIN_PASSWORD) {
    return res.render("admin-login", {
      title: "管理者ログイン",
      error: "パスワードが違います。",
    });
  }

  req.session.isAdmin = true;
  res.redirect("/admin");
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
      backUrl: "/",
    });
  }

  if (!isValidSlot(slot)) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "時間帯が不正です。",
      detail: "",
      backUrl: "/",
    });
  }

  if (!isWithinReservationPeriod(date)) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "予約可能期間外です。",
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
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "患者番号が見つかりません。",
      detail: "",
      backUrl: "/",
    });
  }

  const availableSlots = config.getSlotsForDate(date);

  if (!availableSlots.includes(slot)) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: `${date} ${slot} は診療時間外です。`,
      detail: "",
      backUrl: "/",
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
        backUrl: "/",
      });
    }

    if (error.message === "FULL") {
      return res.render("error", {
        title: "予約不可",
        heading: "予約不可",
        message: `${date} ${slot} は満員です。`,
        detail: "",
        backUrl: "/",
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

  req.session.completeMessage = {
    title: "電話予約完了",
    heading: "電話予約が完了しました",
    message: "予約を登録しました。",
    reservation: {
      date,
      slot,
    },
    showProgress: false,
    backUrl: "/admin",
    backLabel: "予約一覧へ戻る",
  };

  return res.redirect("/complete");
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

  await prisma.reservation.update({
    where: { id },
    data: {
      date,
      slot,
    },
  });

  res.redirect("/admin");
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

  const patientNumber = String(req.body.patientNumber).trim();
  const name = String(req.body.name).trim();
  const birthDate = new Date(req.body.birthDate);

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

  res.redirect("/admin/patients");
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

  res.render("patient-edit", {
    title: "患者編集",
    patient,
    error: null,
  });
});

app.post("/admin/patients/edit/:id", async (req, res) => {
  if (!req.session.isAdmin) {
    return res.redirect("/admin-login");
  }

  const id = Number(req.params.id);
  const patientNumber = String(req.body.patientNumber).trim();
  const name = String(req.body.name).trim();
  const birthDate = new Date(req.body.birthDate);

  const patient = await prisma.patient.findUnique({
    where: { id },
  });

  if (!patient) {
    return res.render("error", {
      title: "エラー",
      heading: "エラー",
      message: "患者が見つかりません。",
      detail: "",
      backUrl: "/admin",
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
        id,
        patientNumber,
        name,
      },
      error: "この患者番号はすでに使われています。",
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

  res.redirect("/admin/patients");
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

  res.redirect("/admin/patients");
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

  await prisma.reservation.delete({
    where: {
      id,
    },
  });

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
