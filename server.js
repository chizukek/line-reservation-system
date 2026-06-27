const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const express = require("express");
const session = require("express-session");
const config = require("./config");
const ADMIN_PASSWORD = "1234";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: "admin-secret-key",
    resave: false,
    saveUninitialized: false,
  }),
);
const PORT = 3000;
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

    dates.push(`${year}-${month}-${day}`);
  }

  const slots = config.allSlots;
  const reservations = await prisma.reservation.findMany();

  const rows = slots
    .map((slot) => {
      const cells = dates
        .map((date) => {
          const count = reservations.filter(
            (r) => r.date === date && r.slot === slot,
          ).length;

          const availableSlots = config.getSlotsForDate(date);

          if (!availableSlots.includes(slot)) {
            return `<td><span class="full">―</span></td>`;
          }

          const today = new Date().toLocaleDateString("sv-SE");

          if (config.holidays.includes(date)) {
            return `<td><span class="full">休</span></td>`;
          }
          if (date <= today) {
            return `<td><span class="full">×</span></td>`;
          }

          if (count >= 2) {
            return `<td><span class="full">×</span></td>`;
          }

          if (count === 1) {
            return `<td><a class="few" href="/input?date=${date}&slot=${slot}">△</a></td>`;
          }

          return `<td><a class="open" href="/input?date=${date}&slot=${slot}">○</a></td>`;
        })
        .join("");

      return `<tr><th>${slot}</th>${cells}</tr>`;
    })
    .join("");

  res.send(`
    <style>
  body {
    font-family: sans-serif;
    padding: 20px;
  }

  table {
    border-collapse: collapse;
  }

  th, td {
    border: 1px solid #ccc;
    padding: 10px;
    text-align: center;
  }

  th {
    background: #f2f2f2;
  }

  a {
    font-size: 20px;
    text-decoration: none;
  }

  .open {
    color: green;
    font-weight: bold;
  }

  .few {
    color: orange;
    font-weight: bold;
  }

  .full {
    color: red;
    font-weight: bold;
  }
</style>
    <h1>LINE予約システム</h1>
    <table border="1" cellpadding="10">
      <tr>
        <th>時間</th>
        ${dates
          .map((date) => {
            const d = new Date(date);
            const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
            const label = `${d.getMonth() + 1}/${d.getDate()}(${weekdays[d.getDay()]})`;
            return `<th>${label}</th>`;
          })
          .join("")}
      </tr>
      ${rows}
    </table>
    <br><br>

    <a href="/?week=${Math.max(0, week - 1)}">
    ← 前の週
    </a>

    &nbsp;&nbsp;&nbsp;

    <a href="/?week=${week + 1}">
    次の週 →
    </a>
    <br>
<a href="/cancel-input">予約をキャンセルする</a>
  `);
});

app.get("/input", (req, res) => {
  const date = req.query.date;
  const slot = req.query.slot;

  res.send(`
    <h1>患者番号入力</h1>
    <p>予約日：${date}</p>
    <p>予約時間：${slot}</p>

    <form action="/confirm" method="POST">
      <input type="hidden" name="date" value="${date}">
      <input type="hidden" name="slot" value="${slot}">

      <label>患者番号</label><br>
      <input type="text" name="patientNumber" required><br><br>

      <button type="submit">予約する</button>
    </form>
  `);
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
    return res.send(`
    <h1>患者番号入力</h1>

    <p style="color:red;">
      患者番号が間違っています。もう一度入力してください。
    </p>

    <p>予約日：${date}</p>
    <p>予約時間：${slot}</p>

    <form action="/confirm" method="POST">
      <input type="hidden" name="date" value="${date}">
      <input type="hidden" name="slot" value="${slot}">

      <label>患者番号</label><br>
      <input type="text" name="patientNumber" required><br><br>

      <button type="submit">確認へ</button>
    </form>
  `);
  }

  res.send(`
    <h1>予約確認</h1>

    <p>患者番号：${patientNumber}</p>
    <p>氏名：${patient.name}</p>
    <p>予約日：${date}</p>
    <p>予約時間：${slot}</p>

    <form action="/reserve" method="POST">
      <input type="hidden" name="patientNumber" value="${patientNumber}">
      <input type="hidden" name="date" value="${date}">
      <input type="hidden" name="slot" value="${slot}">

      <button type="submit">この内容で予約する</button>
    </form>

    <br>
    <a href="/">戻る</a>
  `);
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

  const existingReservation = await prisma.reservation.findFirst({
    where: {
      patientNumber,
      date,
    },
  });

  if (existingReservation) {
    return res.send(`
      <h1>予約不可</h1>
      <p>同じ日にすでに予約があります。</p>
      <p>既存予約：${existingReservation.date} ${existingReservation.slot}</p>
      <a href="/">戻る</a>
    `);
  }

  const count = await prisma.reservation.count({
    where: {
      date,
      slot,
    },
  });

  const reservationCode = Math.random()
    .toString(36)
    .substring(2, 8)
    .toUpperCase();

  if (count >= 2) {
    return res.send(`
      <h1>予約不可</h1>
      <p>${date} ${slot} は満員です。</p>
      <a href="/">戻る</a>
    `);
  }

  await prisma.reservation.create({
    data: {
      patientNumber,
      date,
      slot,
      reservationCode,
    },
  });

  res.send(`
    <h1>予約受付</h1>
    <p>患者番号：${patientNumber}</p>
    <p>氏名：${patient.name}</p>
    <p>予約日：${date}</p>
    <p>予約時間：${slot}</p>
    <p><strong>予約番号：${reservationCode}</strong></p>
    <p>予約を保存しました。</p>
    <a href="/">戻る</a>
  `);
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

  const tableRows = reservations
    .map(
      (r) => `
      <tr>
        <td>${r.date}</td>
        <td>${r.slot}</td>
        <td>${r.patient.name}</td>
        <td>${r.patientNumber}</td>
        <td>${r.reservationCode}</td>
        <td>
          <form action="/cancel" method="POST">
            <input type="hidden" name="from" value="admin"> 
            <input type="hidden" name="id" value="${r.id}">
            <button type="submit">キャンセル</button>
          </form>
        </td>
      </tr>
    `,
    )
    .join("");

  res.send(`
    <h1>予約一覧</h1>
    <p>
  <a href="/admin/add">
    📞 電話予約を追加
  </a>
</p>
    <p>検索中の患者番号：${searchPatientNumber || "なし"}</p>
<p>検索結果：${reservations.length}件</p>
    <form method="GET" action="/admin">
    <br><br>

<label>日付</label><br>
<input
  type="date"
  name="date"
  value="${searchDate}"
>

<br><br>
  <input
    type="text"
    name="patientNumber"
    placeholder="患者番号"
    value="${searchPatientNumber}"
  >

  <button type="submit">検索</button>
</form>

<br>

<a href="/admin?date=${today}">
  今日の予約
</a>

&nbsp;&nbsp;

<a href="/admin">
  全件表示
</a>

<p>
患者番号：${searchPatientNumber || "指定なし"}
／
日付：${searchDate || "指定なし"}
</p>

<br>
    <table border="1" cellpadding="8">
  <tr>
    <th>日付</th>
    <th>時間</th>
    <th>氏名</th>
    <th>患者番号</th>
    <th>予約番号</th>
    <th>操作</th>
  </tr>

  ${tableRows}
</table>
    <a href="/">戻る</a>
  `);
});

app.get("/admin/add", (req, res) => {
  if (!req.session.isAdmin) {
    return res.redirect("/admin-login");
  }

  res.send(`
    <h1>電話予約</h1>

    <form action="/admin/add" method="POST">

      <label>患者番号</label><br>
      <input type="text" name="patientNumber" required>

      <br><br>

      <label>日付</label><br>
      <input type="date" name="date" required>

      <br><br>

      <label>時間</label><br>

      <select name="slot">
        <option>09:00</option>
        <option>09:30</option>
        <option>10:00</option>
        <option>10:30</option>
      </select>

      <br><br>

      <button type="submit">
        確認
      </button>

    </form>

    <br>

    <a href="/admin">
      戻る
    </a>
  `);
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
    return res.send(`
      <h1>電話予約</h1>

      <p style="color:red;">
        患者番号が見つかりません。
      </p>

      <a href="/admin/add">戻る</a>
    `);
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

  const existingReservation = await prisma.reservation.findFirst({
    where: {
      patientNumber,
      date,
    },
  });

  if (existingReservation) {
    return res.send(`
      <h1>予約不可</h1>
      <p>同じ日にすでに予約があります。</p>
      <p>既存予約：${existingReservation.date} ${existingReservation.slot}</p>
      <a href="/admin/add">戻る</a>
    `);
  }

  const count = await prisma.reservation.count({
    where: {
      date,
      slot,
    },
  });

  if (count >= 2) {
    return res.send(`
      <h1>予約不可</h1>
      <p>${date} ${slot} は満員です。</p>
      <a href="/admin/add">戻る</a>
    `);
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

  res.send(`
    <h1>電話予約完了</h1>
    <p>患者番号：${patientNumber}</p>
    <p>氏名：${patient.name}</p>
    <p>予約日：${date}</p>
    <p>予約時間：${slot}</p>
    <p><strong>予約番号：${reservationCode}</strong></p>
    <p>予約を登録しました。</p>
    <a href="/admin">予約一覧へ戻る</a>
  `);
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

  res.send(`
  <h1>キャンセル確認</h1>

  <p>氏名：${reservation.patient.name}</p>
  <p>予約日：${reservation.date}</p>
  <p>予約時間：${reservation.slot}</p>

  <p style="color:red;">
    本当にキャンセルしますか？
  </p>

  <form action="/cancel-confirm" method="POST">
    <input type="hidden" name="id" value="${reservation.id}">
    <input type="hidden" name="from" value="${from}">

    <button type="submit">
      はい、キャンセルします
    </button>
  </form>

  <br>

  <a href="${from === "admin" ? "/admin" : "/"}">
    戻る
  </a>
`);
});

app.get("/cancel-input", (req, res) => {
  res.send(`
    <h1>予約キャンセル</h1>

    <form action="/cancel-patient" method="POST">
      <label>患者番号</label><br>
      <input type="text" name="patientNumber" required><br><br>

      <button type="submit">予約を探す</button>
    </form>

    <br>
    <a href="/">戻る</a>
  `);
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
    return res.send(`
    <h1>予約キャンセル</h1>
    <p style="color:red;">患者番号が見つかりません。</p>
    <a href="/cancel-input">戻る</a>
  `);
  }

  const reservations = await prisma.reservation.findMany({
    where: {
      patientNumber,
      date: {
        gte: today,
      },
    },
    include: {
      patient: true,
    },
    orderBy: [
      {
        date: "asc",
      },
      {
        slot: "asc",
      },
    ],
  });
  if (reservations.length === 0) {
    return res.send(`
          <h1>予約キャンセル</h1>
          <p style="color:red;">予約が見つかりません。</p>
          <a href="/cancel-input">戻る</a>
        `);
  }

  const tableRows = reservations
    .map(
      (r) => `
      <tr>
        <td>${r.date}</td>
        <td>${r.slot}</td>
        <td>${r.patient.name}</td>
        <td>${r.patientNumber}</td>
        <td>${r.reservationCode}</td>
        <td>
<form action="/cancel" method="POST">
          <input type="hidden" name="from" value="patient">
            <input type="hidden" name="id" value="${r.id}">
            <button type="submit">キャンセル</button>
          </form>
        </td>
      </tr>
    `,
    )
    .join("");

  res.send(`
        <h1>予約一覧</h1>
        <p>患者番号：${patientNumber}</p>
        <p>氏名：${patient.name}</p>
        <table border="1" cellpadding="8">
  <tr>
    <th>日付</th>
    <th>時間</th>
    <th>氏名</th>
    <th>患者番号</th>
    <th>予約番号</th>
    <th>操作</th>
  </tr>

  ${tableRows}
</table>

        <a href="/">トップへ戻る</a>
    `);
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
