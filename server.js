require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const express = require("express");
const session = require("express-session");
const config = require("./config");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PORT = process.env.PORT || 3000;

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
const validPatients = ["10001", "10002", "10003"];

app.get("/", async (req, res) => {
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

  res.render("index", {
    title: "予約表",
    week,
    dates,
    slots: config.allSlots,
    reservations,
    today,
    holidays: config.holidays,
    getSlotsForDate: config.getSlotsForDate,
  });
});

app.get("/input", (req, res) => {
  const date = req.query.date;
  const slot = req.query.slot;

  res.render("input", {
    title: "患者番号入力",
    date,
    slot,
    patientNumber: "",
    error: null,
  });
});

app.post("/confirm", async (req, res) => {
  const patientNumber = req.body.patientNumber;
  const date = req.body.date;
  const slot = req.body.slot;

  const patient = await prisma.patient.findUnique({
    where: {
      patientNumber,
    },
  });

  if (!patient) {
    return res.render("input", {
      title: "患者番号入力",
      date,
      slot,
      patientNumber,
      error: "患者番号が間違っています。もう一度入力してください。",
    });
  }

  res.render("confirm", {
    title: "予約確認",
    patient,
    date,
    slot,
  });
});

app.post("/reserve", async (req, res) => {
  const patientNumber = req.body.patientNumber;
  const date = req.body.date;
  const slot = req.body.slot;

  const patient = await prisma.patient.findUnique({
    where: {
      patientNumber,
    },
  });

  if (!patient) {
    return res.redirect("/");
  }

  const existingReservation = await prisma.reservation.findFirst({
    where: {
      patientNumber,
      date,
    },
  });

  if (existingReservation) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "同じ日にすでに予約があります。",
      detail: `既存予約：${existingReservation.date} ${existingReservation.slot}`,
      backUrl: "/",
    });
  }

  const count = await prisma.reservation.count({
    where: {
      date,
      slot,
    },
  });

  if (count >= 2) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: `${date} ${slot} は満員です。`,
      detail: "",
      backUrl: "/",
    });
  }

  const reservationCode = Math.random()
    .toString(36)
    .substring(2, 8)
    .toUpperCase();

  await prisma.reservation.create({
    data: {
      patientNumber,
      date,
      slot,
      reservationCode,
    },
  });

  res.render("complete", {
    title: "予約完了",
    patient,
    date,
    slot,
    reservationCode,
  });
});

app.get("/admin-login", (req, res) => {
  res.send(`
    <h1>管理者ログイン</h1>

    <form action="/admin-login" method="POST">
      <input
        type="password"
        name="password"
        placeholder="パスワード"
        required
      >

      <button type="submit">ログイン</button>
    </form>
  `);
});

app.post("/admin-login", (req, res) => {
  const password = req.body.password;

  if (password !== ADMIN_PASSWORD) {
    return res.send(`
      <h1>ログイン失敗</h1>
      <p>パスワードが違います。</p>
      <a href="/admin-login">戻る</a>
    `);
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

  res.send(`
    <h1>電話予約確認</h1>

    <p>患者番号：${patientNumber}</p>
    <p>氏名：${patient.name}</p>
    <p>予約日：${date}</p>
    <p>予約時間：${slot}</p>

    <form action="/admin/add/complete" method="POST">

      <input type="hidden" name="patientNumber" value="${patientNumber}">
      <input type="hidden" name="date" value="${date}">
      <input type="hidden" name="slot" value="${slot}">

      <button type="submit">
        この内容で登録
      </button>

    </form>

    <br>

    <a href="/admin/add">
      戻る
    </a>
  `);
});

app.post("/admin/add/complete", async (req, res) => {
  if (!req.session.isAdmin) {
    return res.redirect("/admin-login");
  }

  const { patientNumber, date, slot } = req.body;

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

  const existingReservation = await prisma.reservation.findFirst({
    where: {
      patientNumber,
      date,
    },
  });

  if (existingReservation) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: "同じ日にすでに予約があります。",
      detail: `既存予約：${existingReservation.date} ${existingReservation.slot}`,
      backUrl: "/admin/add",
    });
  }

  const count = await prisma.reservation.count({
    where: {
      date,
      slot,
    },
  });

  if (count >= 2) {
    return res.render("error", {
      title: "予約不可",
      heading: "予約不可",
      message: `${date} ${slot} は満員です。`,
      detail: "",
      backUrl: "/admin/add",
    });
  }

  const reservationCode = Math.random()
    .toString(36)
    .substring(2, 8)
    .toUpperCase();

  await prisma.reservation.create({
    data: {
      patientNumber,
      date,
      slot,
      reservationCode,
    },
  });

  res.render("complete", {
    title: "電話予約完了",
    patient,
    date,
    slot,
    reservationCode,
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
    return res.send(`
      <h1>予約が見つかりません</h1>
      <a href="/admin">戻る</a>
    `);
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
    return res.send(`
      <h1>予約が見つかりません</h1>
      <a href="/admin">戻る</a>
    `);
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

  const existingPatient = await prisma.patient.findUnique({
    where: {
      patientNumber,
    },
  });

  if (existingPatient) {
    res.render("patient-add", {
      title: "患者登録",
      error: "この患者番号はすでに登録されています。",
    });
  }

  await prisma.patient.create({
    data: {
      patientNumber,
      name,
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
    return res.send(`
      <h1>患者が見つかりません</h1>
      <a href="/admin/patients">戻る</a>
    `);
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

  const patient = await prisma.patient.findUnique({
    where: { id },
  });

  if (!patient) {
    return res.send(`
      <h1>患者が見つかりません</h1>
      <a href="/admin/patients">戻る</a>
    `);
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
    return res.send(`
      <h1>患者が見つかりません</h1>
      <a href="/admin/patients">戻る</a>
    `);
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
    return res.send(`
      <h1>患者が見つかりません</h1>
      <a href="/admin/patients">戻る</a>
    `);
  }

  const reservationCount = await prisma.reservation.count({
    where: {
      patientNumber: patient.patientNumber,
    },
  });

  if (reservationCount > 0) {
    return res.send(`
      <h1>削除できません</h1>
      <p>この患者には予約が存在するため削除できません。</p>
      <p>予約件数：${reservationCount}件</p>
      <a href="/admin/patients">戻る</a>
    `);
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

  res.render("cancel-confirm", {
    title: "予約キャンセル確認",
    reservation,
    from,
  });
});

app.get("/cancel-input", (req, res) => {
  res.render("cancel-input", {
    title: "予約キャンセル",
    patientNumber: "",
    error: null,
  });
});

app.post("/cancel-patient", async (req, res) => {
  const patientNumber = req.body.patientNumber;
  const today = new Date().toLocaleDateString("sv-SE");

  const patient = await prisma.patient.findUnique({
    where: {
      patientNumber,
    },
  });

  if (!patient) {
    return res.render("cancel-input", {
      title: "予約キャンセル",
      patientNumber,
      error: "患者番号が見つかりません。",
    });
  }

  const reservations = await prisma.reservation.findMany({
    where: {
      patientNumber,
      date: {
        gt: today,
      },
    },
    include: {
      patient: true,
    },
    orderBy: [{ date: "asc" }, { slot: "asc" }],
  });

  if (reservations.length === 0) {
    return res.render("cancel-input", {
      title: "予約キャンセル",
      patientNumber,
      error: "キャンセルできる予約が見つかりません。",
    });
  }

  res.render("cancel-list", {
    title: "予約キャンセル",
    patient,
    reservations,
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

  return res.redirect("/");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
