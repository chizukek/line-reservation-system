require("dotenv").config();

const { PrismaClient } = require("@prisma/client");
const express = require("express");
const session = require("express-session");
const line = require("@line/bot-sdk");
const config = require("./config");

const prisma = new PrismaClient();
const app = express();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PORT = process.env.PORT || 3000;

const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

/* =========================
   必須環境変数
========================= */

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRETが設定されていません。");
}

if (!ADMIN_PASSWORD) {
  throw new Error("ADMIN_PASSWORDが設定されていません。");
}

/* =========================
   Express基本設定
========================= */

app.set("view engine", "ejs");
app.set("views", "views");

app.disable("x-powered-by");

if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("public"));

/* =========================
   セッション
========================= */

app.use(
  session({
    name: "clinic.sid",

    secret: process.env.SESSION_SECRET,

    resave: false,
    saveUninitialized: false,
    rolling: true,

    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 60 * 1000,
    },
  }),
);

/* =========================
   キャッシュ禁止
========================= */

app.use((req, res, next) => {
  const sensitivePaths = [
    "/admin-login",
    "/mypage",
    "/verify",
    "/confirm",
    "/cancel-confirm",
    "/complete",
  ];

  const isSensitivePage =
    req.path.startsWith("/admin") || sensitivePaths.includes(req.path);

  if (isSensitivePage) {
    res.set({
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      Expires: "0",
    });
  }

  return next();
});

/* =========================
   EJS共通変数
========================= */

app.use(async (req, res, next) => {
  res.locals.isPatientLoggedIn = Boolean(req.session.patientNumber);

  res.locals.isAdminLoggedIn = Boolean(req.session.isAdmin);

  res.locals.isAdminPage =
    req.path === "/admin-login" || req.path.startsWith("/admin");

  res.locals.doctor = null;
  res.locals.doctors = [];

  if (!req.session.isAdmin) {
    return next();
  }

  try {
    const doctors = await prisma.doctor.findMany({
      where: {
        isActive: true,
      },
      orderBy: {
        id: "asc",
      },
    });

    res.locals.doctors = doctors;

    const doctorId = Number(req.session.doctorId);

    if (Number.isInteger(doctorId) && doctorId > 0) {
      res.locals.doctor =
        doctors.find((doctorItem) => doctorItem.id === doctorId) || null;
    }

    return next();
  } catch (error) {
    console.error("管理ヘッダー情報取得エラー:", error);

    return next(error);
  }
});

/* =========================
   共通関数
========================= */

function formatJapaneseDate(dateText) {
  const date = new Date(`${dateText}T00:00:00+09:00`);

  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];

  return (
    `${date.getFullYear()}年` +
    `${date.getMonth() + 1}月` +
    `${date.getDate()}日` +
    `(${weekdays[date.getDay()]})`
  );
}

function isValidPatientNumber(patientNumber) {
  return /^\d{5}$/.test(String(patientNumber || ""));
}

function isValidDateText(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(date || ""));
}

function isValidDoctorId(doctorId) {
  return Number.isInteger(doctorId) && doctorId > 0;
}

function isValidSlot(slot, doctorId) {
  if (!isValidDoctorId(doctorId)) {
    return false;
  }

  if (typeof slot !== "string") {
    return false;
  }

  return config.getDisplaySlots(doctorId).includes(slot);
}

function isWithinReservationPeriod(dateText) {
  if (!isValidDateText(dateText)) {
    return false;
  }

  const todayText = new Date().toLocaleDateString("sv-SE", {
    timeZone: "Asia/Tokyo",
  });

  const today = new Date(`${todayText}T00:00:00+09:00`);

  const maxDate = new Date(today);
  maxDate.setDate(maxDate.getDate() + 30);

  const targetDate = new Date(`${dateText}T00:00:00+09:00`);

  return targetDate > today && targetDate <= maxDate;
}

/* =========================
   管理者認証
========================= */

function requireAdminLogin(req, res, next) {
  if (!req.session.isAdmin) {
    return res.redirect("/admin-login?reason=timeout");
  }

  req.session.cookie.maxAge = 15 * 60 * 1000;

  return next();
}

/* =========================
   操作ログ
========================= */

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
    console.error("操作ログ保存エラー:", error);
  }
}

/* =========================
   EJSヘルパー
========================= */

app.use((req, res, next) => {
  res.locals.formatJapaneseDate = formatJapaneseDate;

  return next();
});

app.get("/psychiatry", (req, res) => {
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
    include: {
      doctor: true,
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

app.get("/select-doctor", async (req, res) => {
  const doctors = await prisma.doctor.findMany({
    where: { isActive: true },
    orderBy: { id: "asc" },
  });

  res.render("select-doctor", {
    title: "担当医を選択",
    doctors,
    isChangeMode: Boolean(req.session.changeReservationId),
  });
});

app.get("/new", (req, res) => {
  req.session.changeReservationId = null;
  res.redirect("/select-doctor");
});

app.get("/api/slots", (req, res) => {
  const date = req.query.date;

  if (!date) {
    return res.json([]);
  }

  const doctorId = Number(req.query.doctorId);

  const slots = config.getSlotsForDate(date, doctorId);

  res.json(slots);
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

  res.redirect("/select-doctor");
});

app.get("/reserve", async (req, res) => {
  try {
    const patientNumber = req.session.patientNumber;
    const doctorId = Number(req.query.doctorId);
    const week = Math.max(0, Number(req.query.week || 0));

    if (!patientNumber) {
      return res.redirect("/psychiatry");
    }

    if (!isValidDoctorId(doctorId)) {
      return res.redirect("/select-doctor");
    }

    const doctor = await prisma.doctor.findFirst({
      where: {
        id: doctorId,
        isActive: true,
      },
    });

    if (!doctor) {
      return res.redirect("/select-doctor");
    }

    const todayDate = new Date(
      new Date().toLocaleString("en-US", {
        timeZone: "Asia/Tokyo",
      }),
    );

    const today = todayDate.toLocaleDateString("sv-SE");

    const maxReservableDate = new Date(todayDate);
    maxReservableDate.setDate(maxReservableDate.getDate() + 30);

    const maxReservableText = maxReservableDate.toLocaleDateString("sv-SE");

    const dates = [];

    for (let i = week * 7; i < week * 7 + 7; i++) {
      const date = new Date(todayDate);
      date.setDate(todayDate.getDate() + i);

      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");

      const value = `${year}-${month}-${day}`;
      const weekdays = ["日", "月", "火", "水", "木", "金", "土"];

      dates.push({
        value,
        label: `${date.getMonth() + 1}/${date.getDate()}（${weekdays[date.getDay()]}）`,
        weekday: date.getDay(),
      });
    }

    const startDate = dates[0].value;
    const endDate = dates[dates.length - 1].value;

    const reservations = await prisma.reservation.findMany({
      where: {
        doctorId,
        date: {
          gte: startDate,
          lte: endDate,
        },
      },
      select: {
        id: true,
        date: true,
        slot: true,
      },
    });

    const nextWeekStart = new Date(todayDate);
    nextWeekStart.setDate(todayDate.getDate() + (week + 1) * 7);

    const nextWeekStartText = nextWeekStart.toLocaleDateString("sv-SE");

    const canGoNextWeek = nextWeekStartText <= maxReservableText;

    return res.render("reserve", {
      title: "予約日時を選択",
      doctor,
      doctorId,
      week,
      dates,
      reservations,
      slots: config.getDisplaySlots(doctorId),
      today,
      maxReservableText,
      canGoNextWeek,
      holidays: config.holidays,
      getSlotsForDate: config.getSlotsForDate,
      getCapacityForSlot: config.getCapacityForSlot,
      getSlotLabel: config.getSlotLabel,
      isChangeMode: Boolean(req.session.changeReservationId),
    });
  } catch (error) {
    console.error("患者予約表表示エラー:", error);

    return res.status(500).render("error", {
      title: "エラー",
      heading: "エラー",
      message: "予約表の表示中にエラーが発生しました。",
      detail: "",
      backUrl: "/select-doctor",
    });
  }
});

app.get("/confirm", async (req, res) => {
  const patientNumber = req.session.patientNumber;
  const doctorId = Number(req.query.doctorId);

  if (!patientNumber) {
    return res.redirect("/psychiatry");
  }

  const date = req.query.date;
  const slot = req.query.slot;

  if (
    !isValidDoctorId(doctorId) ||
    !isValidDateText(date) ||
    !isValidSlot(slot, doctorId) ||
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

  const availableSlots = config.getSlotsForDate(date, doctorId);

  if (!availableSlots.includes(slot)) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "その時間は診療時間外です。",
      detail: "",
      backUrl: "/",
    });
  }

  const doctor = await prisma.doctor.findUnique({
    where: { id: doctorId },
  });

  if (!doctor || !doctor.isActive) {
    return res.redirect("/select-doctor");
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
    doctor,
    doctorId,
    slot,
    isChangeMode: Boolean(req.session.changeReservationId),
  });
});

app.post("/reserve", async (req, res) => {
  const patientNumber = req.session.patientNumber;
  const doctorId = Number(req.body.doctorId);
  const date = req.body.date;
  const slot = req.body.slot;
  const changeReservationId = req.session.changeReservationId;

  if (
    !isValidDoctorId(doctorId) ||
    !isValidPatientNumber(patientNumber) ||
    !isValidDateText(date) ||
    !isValidSlot(slot, doctorId) ||
    !isWithinReservationPeriod(date)
  ) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "予約内容が不正です。",
      detail: "",
      backUrl: "/reserve?doctorId=" + doctorId,
    });
  }

  const doctor = await prisma.doctor.findUnique({
    where: { id: doctorId },
  });

  if (!doctor || !doctor.isActive) {
    return res.redirect("/select-doctor");
  }

  const availableSlots = config.getSlotsForDate(date, doctorId);

  if (!availableSlots.includes(slot)) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "その時間は診療時間外です。",
      detail: "",
      backUrl: "/reserve?doctorId=" + doctorId,
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
            doctorId,
            ...(changeReservationId
              ? {
                  id: {
                    not: changeReservationId,
                  },
                }
              : {}),
          },
        });

        const capacity = config.getCapacityForSlot(date, slot, doctorId);

        if (count >= capacity) {
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
              doctorId,
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
            doctorId,
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
        backUrl: "/reserve?doctorId=" + doctorId,
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
      backUrl: "/reserve?doctorId=" + doctorId,
    });
  }

  await createAuditLog(
    changeReservationId ? "患者予約変更" : "患者予約",
    `患者番号:${patientNumber}`,
    `${date} ${slot} / 医師ID:${doctorId}`,
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
      doctor,
      reservationCode,
      patient: {
        patientNumber: patient.patientNumber,
        name: patient.name,
      },
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
  req.session.doctorId = null;

  await createAuditLog("管理者ログイン", null, req.ip);

  res.redirect("/admin/doctors");
});

app.get("/admin-logout", async (req, res) => {
  await createAuditLog("管理者ログアウト", null, req.ip);

  req.session.isAdmin = false;
  res.redirect("/admin-login");
});

app.get("/admin/doctors", requireAdminLogin, async (req, res) => {
  const doctors = await prisma.doctor.findMany({
    where: {
      isActive: true,
    },
    orderBy: {
      id: "asc",
    },
  });

  res.render("admin-select-doctor", {
    title: "担当医選択",
    doctors,
  });
});

app.get("/admin/select-doctor", requireAdminLogin, async (req, res) => {
  const doctorId = Number(req.query.doctorId);

  if (!Number.isInteger(doctorId)) {
    return res.redirect("/admin/doctors");
  }

  const doctor = await prisma.doctor.findFirst({
    where: {
      id: doctorId,
      isActive: true,
    },
  });

  if (!doctor) {
    return res.redirect("/admin/doctors");
  }

  req.session.doctorId = doctor.id;

  return res.redirect("/admin");
});

app.get("/admin", requireAdminLogin, async (req, res) => {
  try {
    const doctorId = req.session.doctorId;

    if (!Number.isInteger(doctorId)) {
      return res.redirect("/admin/doctors");
    }

    const doctor = await prisma.doctor.findFirst({
      where: {
        id: doctorId,
        isActive: true,
      },
    });

    if (!doctor) {
      req.session.doctorId = null;
      return res.redirect("/admin/doctors");
    }

    const doctors = await prisma.doctor.findMany({
      where: {
        isActive: true,
      },
      orderBy: {
        id: "asc",
      },
    });

    const today = new Date().toLocaleDateString("sv-SE", {
      timeZone: "Asia/Tokyo",
    });

    const reservations = await prisma.reservation.findMany({
      where: {
        doctorId,
        date: today,
      },
      include: {
        patient: true,
      },
      orderBy: [
        {
          slot: "asc",
        },
        {
          id: "asc",
        },
      ],
    });

    const slots = config.getSlotsForDate(today, doctorId);
    res.render("admin-dashboard", {
      title: "予約管理",

      isAdminPage: true,
      isAdminLoggedIn: true,

      doctorId,
      doctor,
      doctors,
      today,
      slots,
      reservations,

      getCapacityForSlot: config.getCapacityForSlot,

      updatedAt: new Date(),
    });
  } catch (error) {
    console.error("管理ダッシュボード表示エラー:", error);

    res.status(500).send("管理画面の表示中にエラーが発生しました。");
  }
});

app.get("/admin/reservations", requireAdminLogin, async (req, res) => {
  const doctorId = Number(req.query.doctorId);

  if (!isValidDoctorId(doctorId)) {
    return res.redirect("/admin");
  }

  const doctor = await prisma.doctor.findUnique({
    where: { id: doctorId },
  });

  if (!doctor || !doctor.isActive) {
    return res.redirect("/admin");
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

  const today = new Date().toLocaleDateString("sv-SE");

  const maxReservableDate = new Date();
  maxReservableDate.setDate(maxReservableDate.getDate() + 30);
  const maxReservableText = maxReservableDate.toLocaleDateString("sv-SE");

  const nextWeekStart = new Date();
  nextWeekStart.setDate(nextWeekStart.getDate() + (week + 1) * 7);
  const nextWeekStartText = nextWeekStart.toLocaleDateString("sv-SE");

  const canGoNextWeek = nextWeekStartText <= maxReservableText;

  const reservations = await prisma.reservation.findMany({
    where: {
      doctorId,
    },
    include: {
      patient: true,
      doctor: true,
    },
    orderBy: [{ date: "asc" }, { slot: "asc" }],
  });

  res.render("admin", {
    title: "予約一覧",
    doctor,
    doctorId,
    reservations,
    week,
    dates,
    slots: config.getDisplaySlots(doctorId),
    today,
    maxReservableText,
    canGoNextWeek,
    holidays: config.holidays,
    getSlotsForDate: config.getSlotsForDate,
    getCapacityForSlot: config.getCapacityForSlot,
    getSlotLabel: config.getSlotLabel,
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

app.get("/admin/add", requireAdminLogin, async (req, res) => {
  const doctorId = Number(req.query.doctorId);

  if (!isValidDoctorId(doctorId)) {
    return res.redirect("/admin");
  }

  const doctor = await prisma.doctor.findUnique({
    where: { id: doctorId },
  });

  if (!doctor || !doctor.isActive) {
    return res.redirect("/admin");
  }

  res.render("admin-add", {
    title: "電話予約",
    doctor,
    doctorId,
    slots: config.getDisplaySlots(doctorId),
    error: null,
  });
});

app.post("/admin/add", requireAdminLogin, async (req, res) => {
  const doctorId = Number(req.body.doctorId);
  const { patientNumber, date, slot } = req.body;

  const doctor = await prisma.doctor.findUnique({
    where: { id: doctorId },
  });

  const renderAdd = (error) => {
    return res.render("admin-add", {
      title: "電話予約",
      doctor,
      doctorId,
      slots: config.getDisplaySlots(doctorId),
      error,
    });
  };

  if (!isValidDoctorId(doctorId) || !doctor || !doctor.isActive) {
    return res.redirect("/admin");
  }

  if (!isValidPatientNumber(patientNumber)) {
    return renderAdd("患者番号は5桁の数字で入力してください。");
  }

  if (
    !isValidDateText(date) ||
    !isValidSlot(slot, doctorId) ||
    !isWithinReservationPeriod(date)
  ) {
    return renderAdd("予約内容が不正です。");
  }

  const availableSlots = config.getSlotsForDate(date, doctorId);

  if (!availableSlots.includes(slot)) {
    return renderAdd("その時間は診療時間外です。");
  }

  const patient = await prisma.patient.findUnique({
    where: {
      patientNumber,
    },
  });

  if (!patient) {
    return renderAdd("患者番号が見つかりません。");
  }

  res.render("admin-add-confirm", {
    title: "電話予約確認",
    doctor,
    doctorId,
    patient,
    date,
    slot,
  });
});

app.post("/admin/add/complete", requireAdminLogin, async (req, res) => {
  const doctorId = Number(req.body.doctorId);
  const { patientNumber, date, slot } = req.body;

  const backUrl = `/admin/add?doctorId=${doctorId}`;

  if (!isValidDoctorId(doctorId)) {
    return res.redirect("/admin");
  }

  const doctor = await prisma.doctor.findUnique({
    where: { id: doctorId },
  });

  if (!doctor || !doctor.isActive) {
    return res.redirect("/admin");
  }

  if (!isValidPatientNumber(patientNumber)) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "患者番号が不正です。",
      detail: "",
      backUrl,
    });
  }

  if (!isValidDateText(date)) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "日付が不正です。",
      detail: "",
      backUrl,
    });
  }

  if (!isValidSlot(slot, doctorId)) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "時間帯が不正です。",
      detail: "",
      backUrl,
    });
  }

  if (!isWithinReservationPeriod(date)) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "予約可能期間外です。",
      detail: "",
      backUrl,
    });
  }

  const patient = await prisma.patient.findUnique({
    where: { patientNumber },
  });

  if (!patient) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "患者番号が見つかりません。",
      detail: "",
      backUrl,
    });
  }

  const availableSlots = config.getSlotsForDate(date, doctorId);

  if (!availableSlots.includes(slot)) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: `${date} ${slot} は診療時間外です。`,
      detail: "",
      backUrl,
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
            doctorId,
          },
        });

        const capacity = config.getCapacityForSlot(date, slot, doctorId);

        if (count >= capacity) {
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
            doctorId,
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
        backUrl,
      });
    }

    if (error.message === "FULL") {
      return res.render("error", {
        title: "予約不可",
        heading: "予約不可",
        message: `${date} ${slot} は満員です。`,
        detail: "",
        backUrl,
      });
    }

    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "予約処理中にエラーが発生しました。",
      detail: "",
      backUrl,
    });
  }

  await createAuditLog(
    "電話予約追加",
    `患者番号:${patientNumber}`,
    `${date} ${slot} / 医師ID:${doctorId}`,
  );

  return res.render("admin-complete", {
    title: "電話予約完了",
    message: "電話予約を登録しました。",
    buttonText: "予約一覧へ戻る",
    buttonLink: `/admin/reservations?doctorId=${doctorId}`,
  });
});

app.get("/admin/edit/:id", requireAdminLogin, async (req, res) => {
  const id = Number(req.params.id);
  const doctorId = Number(req.query.doctorId);

  if (!isValidDoctorId(doctorId)) {
    return res.redirect("/admin");
  }

  const doctor = await prisma.doctor.findUnique({
    where: { id: doctorId },
  });

  if (!doctor || !doctor.isActive) {
    return res.redirect("/admin");
  }

  const reservation = await prisma.reservation.findUnique({
    where: { id },
    include: {
      patient: true,
      doctor: true,
    },
  });

  if (!reservation) {
    return res.render("error", {
      title: "エラー",
      heading: "エラー",
      message: "予約が見つかりません。",
      detail: "",
      backUrl: `/admin/reservations?doctorId=${doctorId}`,
    });
  }

  res.render("admin-edit", {
    title: "予約変更",
    doctor,
    doctorId,
    reservation,
    slots: config.getDisplaySlots(doctorId),
    error: null,
  });
});

app.post("/admin/edit/:id", requireAdminLogin, async (req, res) => {
  const id = Number(req.params.id);
  const doctorId = Number(req.body.doctorId);
  const { date, slot } = req.body;

  const doctor = await prisma.doctor.findUnique({
    where: { id: doctorId },
  });

  if (!isValidDoctorId(doctorId) || !doctor || !doctor.isActive) {
    return res.redirect("/admin");
  }

  const reservation = await prisma.reservation.findUnique({
    where: { id },
    include: {
      patient: true,
      doctor: true,
    },
  });

  if (!reservation) {
    return res.render("error", {
      title: "エラー",
      heading: "エラー",
      message: "予約が見つかりません。",
      detail: "",
      backUrl: `/admin/reservations?doctorId=${doctorId}`,
    });
  }

  const renderEdit = (error) => {
    return res.render("admin-edit", {
      title: "予約変更",
      doctor,
      doctorId,
      reservation: {
        ...reservation,
        date,
        slot,
      },
      slots: config.getDisplaySlots(doctorId),
      error,
    });
  };

  if (
    !isValidDateText(date) ||
    !isValidSlot(slot, doctorId) ||
    !isWithinReservationPeriod(date)
  ) {
    return renderEdit("予約内容が不正です。");
  }

  const availableSlots = config.getSlotsForDate(date, doctorId);

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
      doctorId,
      id: {
        not: id,
      },
    },
  });

  const capacity = config.getCapacityForSlot(date, slot, doctorId);

  if (count >= capacity) {
    return renderEdit(`${date} ${slot} は満員です。`);
  }

  return res.render("admin-edit-confirm", {
    title: "予約変更確認",
    reservation,
    newReservation: {
      id,
      date,
      slot,
      doctorId,
      doctor,
    },
  });
});

app.get("/admin/slot", requireAdminLogin, async (req, res) => {
  const doctorId = Number(req.query.doctorId);
  const date = String(req.query.date || "");
  const slot = String(req.query.slot || "");
  const slotBlock = await prisma.slotBlock.findUnique({
    where: {
      doctorId_date_slot: {
        doctorId,
        date,
        slot,
      },
    },
  });

  if (
    !isValidDoctorId(doctorId) ||
    !isValidDateText(date) ||
    !isValidSlot(slot, doctorId)
  ) {
    return res.redirect("/admin");
  }

  const doctor = await prisma.doctor.findUnique({
    where: {
      id: doctorId,
    },
  });

  if (!doctor || !doctor.isActive) {
    return res.redirect("/admin");
  }

  const availableSlots = config.getSlotsForDate(date, doctorId);

  if (!availableSlots.includes(slot)) {
    return res.render("error", {
      title: "枠詳細",
      heading: "診療時間外",
      message: "この日時は診療時間外です。",
      detail: "",
      backUrl: `/admin/reservations?doctorId=${doctorId}`,
    });
  }

  const reservations = await prisma.reservation.findMany({
    where: {
      doctorId,
      date,
      slot,
    },
    include: {
      patient: true,
      doctor: true,
    },
    orderBy: {
      id: "asc",
    },
  });

  const capacity = config.getCapacityForSlot(date, slot, doctorId);

  res.render("admin-slot", {
    title: "予約枠詳細",
    doctor,
    doctorId,
    date,
    slot,
    slotLabel: config.getSlotLabel(slot, doctorId),
    reservations,
    capacity,
  });
});

app.get("/admin/slot/patient-search", requireAdminLogin, async (req, res) => {
  const doctorId = Number(req.query.doctorId);
  const date = String(req.query.date || "");
  const slot = String(req.query.slot || "");
  const keyword = String(req.query.keyword || "").trim();

  if (
    !isValidDoctorId(doctorId) ||
    !isValidDateText(date) ||
    !isValidSlot(slot, doctorId)
  ) {
    return res.redirect("/admin");
  }

  const doctor = await prisma.doctor.findUnique({
    where: {
      id: doctorId,
    },
  });

  if (!doctor || !doctor.isActive) {
    return res.redirect("/admin");
  }

  let patients = [];

  if (keyword) {
    patients = await prisma.patient.findMany({
      where: {
        OR: [
          {
            patientNumber: {
              contains: keyword,
            },
          },
          {
            name: {
              contains: keyword,
              mode: "insensitive",
            },
          },
        ],
      },
      orderBy: {
        patientNumber: "asc",
      },
      take: 50,
    });
  }

  res.render("admin-slot-patient-search", {
    title: "患者検索",
    doctor,
    doctorId,
    date,
    slot,
    slotLabel: config.getSlotLabel(slot, doctorId),
    keyword,
    patients,
  });
});

app.get("/admin/slot/confirm", requireAdminLogin, async (req, res) => {
  const doctorId = Number(req.query.doctorId);
  const date = String(req.query.date || "");
  const slot = String(req.query.slot || "");
  const patientNumber = String(req.query.patientNumber || "").trim();

  if (
    !isValidDoctorId(doctorId) ||
    !isValidDateText(date) ||
    !isValidSlot(slot, doctorId) ||
    !isValidPatientNumber(patientNumber)
  ) {
    return res.redirect("/admin");
  }

  const [doctor, patient] = await Promise.all([
    prisma.doctor.findUnique({
      where: {
        id: doctorId,
      },
    }),
    prisma.patient.findUnique({
      where: {
        patientNumber,
      },
    }),
  ]);

  if (!doctor || !doctor.isActive || !patient) {
    return res.redirect("/admin");
  }

  const availableSlots = config.getSlotsForDate(date, doctorId);

  if (!availableSlots.includes(slot)) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "この日時は診療時間外です。",
      detail: "",
      backUrl:
        `/admin/slot?doctorId=${doctorId}` +
        `&date=${date}` +
        `&slot=${encodeURIComponent(slot)}`,
    });
  }

  const count = await prisma.reservation.count({
    where: {
      doctorId,
      date,
      slot,
    },
  });

  const capacity = config.getCapacityForSlot(date, slot, doctorId);

  if (count >= capacity) {
    return res.render("error", {
      title: "予約不可",
      heading: "満員です",
      message: "この予約枠はすでに満員です。",
      detail: "",
      backUrl:
        `/admin/slot?doctorId=${doctorId}` +
        `&date=${date}` +
        `&slot=${encodeURIComponent(slot)}`,
    });
  }

  res.render("admin-slot-confirm", {
    title: "予約確認",
    doctor,
    doctorId,
    date,
    slot,
    slotLabel: config.getSlotLabel(slot, doctorId),
    patient,
  });
});

app.post("/admin/slot/complete", requireAdminLogin, async (req, res) => {
  const doctorId = Number(req.body.doctorId);
  const date = String(req.body.date || "");
  const slot = String(req.body.slot || "");
  const patientNumber = String(req.body.patientNumber || "").trim();

  const backUrl =
    `/admin/slot?doctorId=${doctorId}` +
    `&date=${date}` +
    `&slot=${encodeURIComponent(slot)}`;

  if (
    !isValidDoctorId(doctorId) ||
    !isValidDateText(date) ||
    !isValidSlot(slot, doctorId) ||
    !isValidPatientNumber(patientNumber)
  ) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "予約内容が不正です。",
      detail: "",
      backUrl,
    });
  }

  const [doctor, patient] = await Promise.all([
    prisma.doctor.findUnique({
      where: {
        id: doctorId,
      },
    }),
    prisma.patient.findUnique({
      where: {
        patientNumber,
      },
    }),
  ]);

  if (!doctor || !doctor.isActive || !patient) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "医師または患者情報が見つかりません。",
      detail: "",
      backUrl,
    });
  }

  const availableSlots = config.getSlotsForDate(date, doctorId);

  if (!availableSlots.includes(slot)) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "この日時は診療時間外です。",
      detail: "",
      backUrl,
    });
  }

  let reservationCode;

  try {
    await prisma.$transaction(
      async (tx) => {
        const count = await tx.reservation.count({
          where: {
            doctorId,
            date,
            slot,
          },
        });

        const capacity = config.getCapacityForSlot(date, slot, doctorId);

        if (count >= capacity) {
          throw new Error("FULL");
        }

        const today = new Date().toLocaleDateString("sv-SE");

        const existingReservation = await tx.reservation.findFirst({
          where: {
            patientNumber,
            date: {
              gte: today,
            },
          },
        });

        if (existingReservation) {
          throw new Error("DUPLICATE");
        }

        reservationCode = Math.random()
          .toString(36)
          .substring(2, 8)
          .toUpperCase();

        await tx.reservation.create({
          data: {
            doctorId,
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
        heading: "満員です",
        message: "この予約枠はすでに満員です。",
        detail: "",
        backUrl,
      });
    }

    if (error.message === "DUPLICATE") {
      return res.render("error", {
        title: "予約不可",
        heading: "予約があります",
        message: "この患者にはすでに予約があります。",
        detail: "",
        backUrl,
      });
    }

    console.error(error);

    return res.render("error", {
      title: "予約不可",
      heading: "エラー",
      message: "予約処理中にエラーが発生しました。",
      detail: "",
      backUrl,
    });
  }

  await createAuditLog(
    "電話予約追加",
    `患者番号:${patientNumber}`,
    `${date} ${slot} / 医師ID:${doctorId}`,
  );

  res.render("admin-slot-complete", {
    title: "予約完了",
    doctor,
    doctorId,
    date,
    slot,
    slotLabel: config.getSlotLabel(slot, doctorId),
    patient,
    reservationCode,
  });
});

app.post("/admin/edit/:id/complete", requireAdminLogin, async (req, res) => {
  const id = Number(req.params.id);
  const doctorId = Number(req.body.doctorId);
  const { date, slot } = req.body;

  const doctor = await prisma.doctor.findUnique({
    where: { id: doctorId },
  });

  if (!isValidDoctorId(doctorId) || !doctor || !doctor.isActive) {
    return res.redirect("/admin");
  }

  const reservation = await prisma.reservation.findUnique({
    where: { id },
    include: {
      patient: true,
      doctor: true,
    },
  });

  if (!reservation) {
    return res.render("error", {
      title: "エラー",
      heading: "エラー",
      message: "予約が見つかりません。",
      detail: "",
      backUrl: `/admin/reservations?doctorId=${doctorId}`,
    });
  }

  await prisma.reservation.update({
    where: { id },
    data: {
      date,
      slot,
      doctorId,
    },
  });

  await createAuditLog(
    "予約変更",
    `予約ID:${id}`,
    `${reservation.date} ${reservation.slot} / 医師ID:${reservation.doctorId} → ${date} ${slot} / 医師ID:${doctorId}`,
  );

  return res.render("admin-complete", {
    title: "予約変更完了",
    message: "予約を変更しました。",
    buttonText: "予約一覧へ戻る",
    buttonLink: `/admin/reservations?doctorId=${doctorId}`,
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
      doctor: true,
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
      doctor: true,
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
    where: {
      id,
    },
    include: {
      patient: true,
      doctor: true,
    },
  });

  // 以下は現在の処理を継続
});

app.get("/cancel-complete", (req, res) => {
  const data = req.session.cancelComplete;

  if (!data) {
    return res.redirect("/mypage");
  }

  req.session.cancelComplete = null;

  res.render("cancel-complete", data);
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

  const appUrl = process.env.APP_URL;
  const homeUrl = process.env.HOME_URL;
  const accessUrl = process.env.ACCESS_URL;
  const clinicPhone = process.env.CLINIC_PHONE;
  return lineClient.replyMessage({
    replyToken: event.replyToken,
    messages: [
      {
        type: "template",
        altText: "ご案内",
        template: {
          type: "buttons",
          title: "今村医院公式",
          text: "このアカウントでは個別返信は行っておりません。ご希望の内容をお選びください。",
          actions: [
            {
              type: "uri",
              label: "ホームページを見る",
              uri: homeUrl,
            },
            {
              type: "uri",
              label: "アクセス",
              uri: accessUrl,
            },
            {
              type: "uri",
              label: "心療内科再診予約",
              uri: `${appUrl}/psychiatry`,
            },
            {
              type: "uri",
              label: "電話をかける",
              uri: `tel:${clinicPhone}`,
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
