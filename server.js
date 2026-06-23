const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const express = require("express");
const session = require("express-session");
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
  const dates = [];

  for (let i = 0; i < 14; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);

    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");

    dates.push(`${year}-${month}-${day}`);
  }
  const slots = ["09:00", "09:30", "10:00", "10:30"];

  const reservations = await prisma.reservation.findMany();

  const rows = slots
    .map((slot) => {
      const cells = dates
        .map((date) => {
          const count = reservations.filter(
            (r) => r.date === date && r.slot === slot,
          ).length;

          const today = new Date().toISOString().split("T")[0];

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
        ${dates.map((date) => `<th>${date}</th>`).join("")}
      </tr>
      ${rows}
    </table>
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
  const reservations = await prisma.reservation.findMany({
    orderBy: {
      createdAt: "desc",
    },
  });

  const list = reservations
    .map(
      (r) => `
    <li>
      ${r.date} ${r.slot} / 患者番号：${r.patientNumber} / 予約番号：${r.reservationCode}

      <form action="/cancel" method="POST" style="display:inline;">
        <input type="hidden" name="id" value="${r.id}">
        <button type="submit">キャンセル</button>
      </form>
    </li>
  `,
    )
    .join("");

  res.send(`
    <h1>予約一覧</h1>
    <ul>${list}</ul>
    <a href="/">戻る</a>
  `);
});

app.post("/cancel", async (req, res) => {
  const id = Number(req.body.id);

  await prisma.reservation.delete({
    where: {
      id,
    },
  });

  res.send(`
      <h1>キャンセル完了</h1>
      <p>予約を削除しました。</p>
      <a href="/admin">予約一覧へ戻る</a>
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
  const today = new Date().toISOString().split("T")[0];

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
    orderBy: {
      date: "asc",
    },
  });
  if (reservations.length === 0) {
    return res.send(`
          <h1>予約キャンセル</h1>
          <p style="color:red;">予約が見つかりません。</p>
          <a href="/cancel-input">戻る</a>
        `);
  }

  const list = reservations
    .map(
      (r) => `
            <li>
${r.date} ${r.slot} / 予約番号：${r.reservationCode}
                <form action="/cancel-patient-confirm" method="POST" style="display:inline;">
                    <input type="hidden" name="id" value="${r.id}">
                    <button type="submit">キャンセルする</button>
                </form>
            </li>
        `,
    )
    .join("");

  res.send(`
        <h1>予約一覧</h1>
        <p>患者番号：${patientNumber}</p>
        <p>氏名：${patient.name}</p>
        <ul>
            ${list}
        </ul>

        <a href="/">トップへ戻る</a>
    `);
});

app.post("/cancel-patient-confirm", async (req, res) => {
  const id = Number(req.body.id);

  await prisma.reservation.delete({
    where: {
      id,
    },
  });

  res.send(`
      <h1>キャンセル完了</h1>
      <p>予約をキャンセルしました。</p>
      <a href="/">トップへ戻る</a>
    `);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
