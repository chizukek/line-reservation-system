require("dotenv").config();

const { PrismaClient } = require("@prisma/client");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const connectPgSimple = require("connect-pg-simple");
const { Pool } = require("pg");
const line = require("@line/bot-sdk");
const config = require("./config");

const prisma = new PrismaClient();
const app = express();
const PgSession = connectPgSimple(session);

const sessionPool = new Pool({
  connectionString: process.env.DATABASE_URL,

  /*
   * Render PostgreSQLへ外部接続するときのSSL設定です。
   * ローカル開発からRender DBへ接続する場合にも必要です。
   */
  ssl:
    process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("localhost")
      ? {
          rejectUnauthorized: false,
        }
      : false,

  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

sessionPool.on("error", (error) => {
  console.error("セッションDB接続エラー:", error);
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
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

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  throw new Error("SESSION_SECRETは32文字以上で設定してください。");
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URLが設定されていません。");
}

if (!ADMIN_PASSWORD_HASH && !ADMIN_PASSWORD) {
  throw new Error(
    "ADMIN_PASSWORD_HASHまたはADMIN_PASSWORDが設定されていません。",
  );
}

if (process.env.NODE_ENV === "production" && !ADMIN_PASSWORD_HASH) {
  throw new Error(
    "本番環境ではADMIN_PASSWORDではなくADMIN_PASSWORD_HASHを設定してください。",
  );
}

/* =========================
   Express基本設定
========================= */

app.set("view engine", "ejs");
app.set("views", "views");

app.locals.CLINIC_PHONE = process.env.CLINIC_PHONE || "";

app.disable("x-powered-by");

if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

/* =========================
   セキュリティヘッダー
========================= */

app.use(
  helmet({
    crossOriginEmbedderPolicy: false,

    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],

        /*
         * 現在のEJS内にインラインJavaScriptやstyle属性が
         * 存在しても画面が壊れない設定です。
         */
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],

        imgSrc: ["'self'", "data:", "https:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],

        upgradeInsecureRequests:
          process.env.NODE_ENV === "production" ? [] : null,
      },
    },

    referrerPolicy: {
      policy: "strict-origin-when-cross-origin",
    },
  }),
);

/* =========================
   アクセス回数制限
========================= */

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 500,

  standardHeaders: "draft-8",
  legacyHeaders: false,

  skip: (req) => {
    return req.path === "/health" || req.path === "/line/webhook";
  },

  message: "アクセスが集中しています。時間をおいて、もう一度お試しください。",
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,

  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,

  message: "ログイン試行回数が多すぎます。15分後に、もう一度お試しください。",
});

const patientVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,

  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,

  message:
    "予約情報確認の試行回数が多すぎます。時間をおいて、もう一度お試しください。",
});

app.use(globalLimiter);

/* =========================
   リクエスト本文
========================= */

app.use(
  express.urlencoded({
    extended: false,
    limit: "100kb",
    parameterLimit: 100,
  }),
);

/*
 * LINE WebhookはLINE SDKが生データを検証するため、
 * 通常のexpress.json()から除外します。
 */
app.use((req, res, next) => {
  if (req.path === "/line/webhook") {
    return next();
  }

  return express.json({
    limit: "100kb",
  })(req, res, next);
});

/* =========================
   静的ファイル
========================= */

app.use(
  express.static("public", {
    etag: true,
    maxAge: process.env.NODE_ENV === "production" ? "1d" : 0,

    setHeaders: (res) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
    },
  }),
);

/* =========================
   セッション
========================= */

app.use(
  session({
    name: "clinic.sid",

    secret: process.env.SESSION_SECRET,

    store: new PgSession({
      pool: sessionPool,
      createTableIfMissing: true,
      tableName: "user_sessions",
      ttl: 30 * 60,
      pruneSessionInterval: 15 * 60,
    }),

    resave: false,
    saveUninitialized: false,
    rolling: true,

    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 60 * 1000,
      path: "/",
    },
  }),
);

/* =========================
   CSRF対策
========================= */

/*
 * POSTなどの更新リクエストについて、
 * 自分の予約サイトから送られたものか確認します。
 *
 * LINE WebhookはLINE SDKによる署名検証があるため除外します。
 */
app.use((req, res, next) => {
  const protectedMethods = ["POST", "PUT", "PATCH", "DELETE"];

  if (!protectedMethods.includes(req.method)) {
    return next();
  }

  if (req.path === "/line/webhook") {
    return next();
  }

  const origin = req.get("origin");
  const referer = req.get("referer");
  const host = req.get("host");
  const protocol = req.protocol;

  const currentOrigin = `${protocol}://${host}`;

  let configuredOrigin = null;

  try {
    if (process.env.APP_URL) {
      configuredOrigin = new URL(process.env.APP_URL).origin;
    }
  } catch (error) {
    console.error("APP_URLの形式が不正です:", error);
  }

  const allowedOrigins = new Set(
    [currentOrigin, configuredOrigin].filter(Boolean),
  );

  let sourceOrigin = null;

  try {
    if (origin) {
      sourceOrigin = new URL(origin).origin;
    } else if (referer) {
      sourceOrigin = new URL(referer).origin;
    }
  } catch {
    sourceOrigin = null;
  }

  if (!sourceOrigin || !allowedOrigins.has(sourceOrigin)) {
    return res.status(403).send("不正な送信元からのリクエストです。");
  }

  return next();
});

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
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
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

  /*
   * ログイン画面と担当医選択画面では、
   * 管理画面用のヘッダー・サイドメニューを表示しない。
   */
  const hideAdminNavigationPaths = [
    "/admin-login",
    "/admin/doctors",
    "/admin/select-doctor",
  ];

  res.locals.isAdminPage =
    req.path.startsWith("/admin") &&
    !hideAdminNavigationPaths.includes(req.path);

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
function getTodayText() {
  return new Date().toLocaleDateString("sv-SE", {
    timeZone: "Asia/Tokyo",
  });
}

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

function formatJapaneseDateShort(dateText) {
  const date = new Date(`${dateText}T00:00:00+09:00`);

  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

function isValidPatientNumber(patientNumber) {
  return /^\d{5}$/.test(String(patientNumber || ""));
}

function isValidDateText(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(date || ""));
}

function isPastReservationSlot(date, slot) {
  if (!isValidDateText(date) || typeof slot !== "string") {
    return true;
  }

  // 「10:00」でも「10:00〜11:00」でも開始時刻だけを取得
  const slotStart = slot.split("〜")[0].trim();
  const timeMatch = slotStart.match(/^(\d{1,2}):(\d{2})$/);

  if (!timeMatch) {
    return true;
  }

  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);

  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return true;
  }

  const slotDateTime = new Date(
    `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+09:00`,
  );

  return slotDateTime.getTime() <= Date.now();
}

function getCurrentReservation(reservations) {
  if (!Array.isArray(reservations)) {
    return null;
  }

  return (
    reservations.find((reservation) => {
      return !isPastReservationSlot(reservation.date, reservation.slot);
    }) || null
  );
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

function canCancelReservation(dateText) {
  if (!isValidDateText(dateText)) {
    return false;
  }

  const now = new Date(
    new Date().toLocaleString("en-US", {
      timeZone: "Asia/Tokyo",
    }),
  );

  const reservationDate = new Date(`${dateText}T00:00:00+09:00`);

  const deadline = new Date(reservationDate);
  deadline.setDate(deadline.getDate() - 1);
  deadline.setHours(23, 59, 59, 999);

  return now <= deadline;
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
  maxDate.setDate(maxDate.getDate() + config.RESERVATION_DAYS);

  const targetDate = new Date(`${dateText}T00:00:00+09:00`);

  return targetDate > today && targetDate <= maxDate;
}

function getWeekParam(value) {
  const week = Number(value);

  if (!Number.isInteger(week)) {
    return 0;
  }

  const maxWeek = Math.floor((config.RESERVATION_DAYS - 1) / 7);

  if (week < 0) {
    return 0;
  }

  if (week > maxWeek) {
    return maxWeek;
  }

  return week;
}

/* =========================
   管理者認証
========================= */
async function verifyAdminPassword(password) {
  if (typeof password !== "string" || password.length === 0) {
    return false;
  }

  /*
   * 本番環境ではbcryptハッシュを照合します。
   */
  if (ADMIN_PASSWORD_HASH) {
    return bcrypt.compare(password, ADMIN_PASSWORD_HASH);
  }

  /*
   * 開発環境で一時的にADMIN_PASSWORDを使う場合も、
   * 単純な !== 比較は行いません。
   */
  const inputBuffer = Buffer.from(password);
  const expectedBuffer = Buffer.from(ADMIN_PASSWORD || "");

  if (inputBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(inputBuffer, expectedBuffer);
}

function createReservationCode() {
  return crypto.randomBytes(5).toString("hex").toUpperCase();
}

function requireAdminLogin(req, res, next) {
  if (!req.session.isAdmin) {
    return res.redirect("/admin-login?reason=timeout");
  }

  req.session.cookie.maxAge = 15 * 60 * 1000;

  return next();
}

async function getSlotSetting(date, slot, doctorId, db = prisma) {
  const override = await db.slotOverride.findUnique({
    where: {
      doctorId_date_slot: {
        doctorId,
        date,
        slot,
      },
    },
  });

  if (override) {
    return {
      isOpen: override.isOpen,
      capacity: override.isOpen ? override.capacity : 0,
      isOverride: true,
    };
  }

  const availableSlots = config.getSlotsForDate(date, doctorId);

  return {
    isOpen: availableSlots.includes(slot),
    capacity: availableSlots.includes(slot)
      ? config.getCapacityForSlot(date, slot, doctorId)
      : 0,
    isOverride: false,
  };
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

  res.locals.formatJapaneseDateShort = formatJapaneseDateShort;

  res.locals.getSlotLabel = config.getSlotLabel;

  return next();
});


/* =========================
   ルート登録
========================= */

const registerPatientRoutes = require("./routes/patient");
const registerAdminRoutes = require("./routes/admin");
const registerLineRoutes = require("./routes/line");

const routeContext = {
  prisma, config, line, lineConfig, lineClient,
  adminLoginLimiter, patientVerifyLimiter,
  getTodayText, formatJapaneseDate, formatJapaneseDateShort,
  isValidPatientNumber, isValidDateText, isPastReservationSlot,
  getCurrentReservation, isValidDoctorId, isValidSlot,
  canCancelReservation, isWithinReservationPeriod, getWeekParam,
  verifyAdminPassword, createReservationCode, requireAdminLogin,
  getSlotSetting, createAuditLog,
};

registerPatientRoutes(app, routeContext);
registerAdminRoutes(app, routeContext);
registerLineRoutes(app, routeContext);

/* =========================
   404エラー
========================= */

app.use((req, res) => {
  return res.status(404).render("error", {
    title: "ページが見つかりません",
    heading: "ページが見つかりません",
    message: "指定されたページは存在しないか、移動した可能性があります。",
    detail: "",
    backUrl: "/",
  });
});

/* =========================
   共通エラー処理
========================= */

app.use((error, req, res, next) => {
  console.error("未処理エラー:", error);

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).render("error", {
    title: "エラー",
    heading: "エラーが発生しました",
    message: "時間をおいて、もう一度お試しください。",
    detail: "",
    backUrl: "/",
  });
});

module.exports = { app, prisma, sessionPool };
