module.exports = function registerAdminRoutes(app, context) {
  const {
    prisma,
    config,
    line,
    lineConfig,
    lineClient,
    adminLoginLimiter,
    patientVerifyLimiter,
    getTodayText,
    formatJapaneseDate,
    formatJapaneseDateShort,
    isValidPatientNumber,
    isValidDateText,
    isPastReservationSlot,
    getCurrentReservation,
    isValidDoctorId,
    isValidSlot,
    canCancelReservation,
    isWithinReservationPeriod,
    getWeekParam,
    verifyAdminPassword,
    createReservationCode,
    requireAdminLogin,
    getSlotSetting,
    createAuditLog,
  } = context;

  app.use("/admin", (req, res, next) => {
    res.locals.isAdminPage = true;
    res.locals.isAdminLoggedIn = Boolean(req.session.adminLoggedIn);

    next();
  });

  app.get("/admin-login", (req, res) => {
    if (req.session.isAdmin) {
      return res.redirect("/admin");
    }

    return res.render("admin-login", {
      title: "管理者ログイン",
      error: null,
    });
  });

  app.post("/admin-login", adminLoginLimiter, async (req, res) => {
    const password =
      typeof req.body.password === "string" ? req.body.password : "";

    const passwordIsValid = await verifyAdminPassword(password);

    if (!passwordIsValid) {
      await createAuditLog("管理者ログイン失敗", null, req.ip);

      return res.status(401).render("admin-login", {
        title: "管理者ログイン",
        error: "パスワードが違います。",
      });
    }

    /*
     * ログイン前後でセッションIDを変更して、
     * セッション固定攻撃を防ぎます。
     */
    req.session.regenerate((regenerateError) => {
      if (regenerateError) {
        console.error(
          "管理者ログイン時のセッション再生成エラー:",
          regenerateError,
        );

        return res.status(500).send("ログイン処理中にエラーが発生しました。");
      }

      req.session.isAdmin = true;
      req.session.doctorId = null;
      req.session.cookie.maxAge = 15 * 60 * 1000;

      req.session.save(async (saveError) => {
        if (saveError) {
          console.error("管理者ログイン時のセッション保存エラー:", saveError);

          return res.status(500).send("ログイン処理中にエラーが発生しました。");
        }

        await createAuditLog("管理者ログイン", null, req.ip);

        return res.redirect("/admin/doctors");
      });
    });
  });

  app.get("/admin-logout", async (req, res) => {
    try {
      await createAuditLog("管理者ログアウト", null, req.ip);

      req.session.destroy((error) => {
        if (error) {
          console.error("管理者ログアウトエラー:", error);

          return res
            .status(500)
            .send("ログアウト処理中にエラーが発生しました。");
        }

        res.clearCookie("clinic.sid");

        return res.redirect("/admin-login");
      });
    } catch (error) {
      console.error(error);

      return res.status(500).send("ログアウト処理中にエラーが発生しました。");
    }
  });

  app.get("/admin/doctors", requireAdminLogin, async (req, res) => {
    try {
      req.session.doctorId = null;

      const doctors = await prisma.doctor.findMany({
        where: {
          isActive: true,
        },
        orderBy: [
          {
            sortOrder: "asc",
          },
          {
            id: "asc",
          },
        ],
      });

      return res.render("admin-select-doctor", {
        title: "担当医選択",

        isAdminPage: false,
        isAdminLoggedIn: true,

        doctor: null,
        doctors,
      });
    } catch (error) {
      console.error("担当医選択画面表示エラー:", error);

      return res.status(500).render("error", {
        title: "担当医選択",
        heading: "担当医を表示できませんでした",
        message: "時間をおいて、もう一度お試しください。",
        detail: "",
        backUrl: "/admin-login",

        isAdminPage: false,
        isAdminLoggedIn: true,
        isPatientLoggedIn: false,
      });
    }
  });

  app.get("/admin/select-doctor", requireAdminLogin, async (req, res) => {
    try {
      const doctorId = Number(req.query.doctorId);

      if (!isValidDoctorId(doctorId)) {
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

      /*
       * 最初に選んだ担当医を
       * 管理画面全体の担当医として保存します。
       */
      req.session.doctorId = doctor.id;

      return res.redirect("/admin");
    } catch (error) {
      console.error("管理画面担当医選択エラー:", error);

      return res.status(500).render("error", {
        title: "担当医選択",
        heading: "担当医を選択できませんでした",
        message: "担当医選択中にエラーが発生しました。",
        detail: "",
        backUrl: "/admin/doctors",
      });
    }
  });

  app.get("/admin", requireAdminLogin, async (req, res) => {
    try {
      const queryDoctorId = Number(req.query.doctorId);
      const sessionDoctorId = Number(req.session.doctorId);

      let doctorId = sessionDoctorId;

      if (isValidDoctorId(queryDoctorId)) {
        doctorId = queryDoctorId;
        req.session.doctorId = queryDoctorId;
      }

      if (!isValidDoctorId(doctorId)) {
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

      /*
       * URLの日付を取得
       * 例：/admin?date=2026-07-22
       */
      const queryDate = String(req.query.date || "").trim();

      /*
       * 日付が正しければ指定日、
       * 正しくなければ今日を表示
       */
      const selectedDate = isValidDateText(queryDate) ? queryDate : today;

      const reservations = await prisma.reservation.findMany({
        where: {
          doctorId,
          date: selectedDate,
        },
        include: {
          patient: true,
        },
        orderBy: [
          {
            slot: "asc",
          },
          {
            createdAt: "asc",
          },
        ],
      });

      /*
       * 選択中の担当医が表示する全時間枠
       *
       * getSlotsForDateだけを使うと、
       * 休診に変更された枠や通常診療外の枠を
       * 一覧に表示できないため、表示用枠を使用します。
       */
      const slots = config.getDisplaySlots(doctorId);

      /*
       * 日付・時間ごとの診療設定を取得
       *
       * 管理画面で休診や定員変更をした内容も反映します。
       */
      const slotSettings = {};

      await Promise.all(
        slots.map(async (slot) => {
          const setting = await getSlotSetting(selectedDate, slot, doctorId);

          slotSettings[slot] = {
            isOpen: Boolean(setting.isOpen),
            capacity: Number(setting.capacity || 0),
            isOverride: Boolean(setting.isOverride),
          };
        }),
      );

      return res.render("admin-dashboard", {
        title: "日毎スケジュール",

        isAdminPage: true,
        isAdminLoggedIn: true,

        doctorId,
        doctor,
        doctors,

        today,
        selectedDate,

        slots,
        slotSettings,
        reservations,

        formatJapaneseDateShort,
        getCapacityForSlot: config.getCapacityForSlot,

        updatedAt: new Date(),
      });
    } catch (error) {
      console.error("管理ダッシュボード表示エラー:", error);

      return res.status(500).render("error", {
        title: "日毎スケジュール",
        heading: "予約情報を取得できませんでした",
        message: "管理画面の表示中にエラーが発生しました。",
        detail: "",
        backUrl: "/admin",

        isAdminPage: true,
        isAdminLoggedIn: true,
      });
    }
  });
  app.get("/admin/reservations", requireAdminLogin, async (req, res) => {
    try {
      const doctorId = Number(req.session.doctorId);

      const reservationPatientId = Number(req.query.reservationPatientId);

      const patientNumber = String(req.query.patientNumber || "").trim();

      const editReservationId = Number(req.query.editReservationId || 0);

      /*
       * 選択中の担当医を確認
       */
      if (!isValidDoctorId(doctorId)) {
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

      /*
       * ==============================
       * 予約追加モード
       * ==============================
       *
       * reservationPatientIdから
       * 予約を追加する患者を取得します。
       */
      let reservationPatient = null;

      if (Number.isInteger(reservationPatientId) && reservationPatientId > 0) {
        reservationPatient = await prisma.patient.findUnique({
          where: {
            id: reservationPatientId,
          },

          include: {
            reservations: {
              where: {
                date: {
                  gte: getTodayText(),
                },
              },

              include: {
                doctor: true,
              },

              orderBy: [
                {
                  date: "asc",
                },
                {
                  slot: "asc",
                },
              ],
            },
          },
        });

        if (!reservationPatient) {
          return res.status(404).render("error", {
            title: "予約追加",
            heading: "患者が見つかりません",
            message: "選択された患者情報が見つかりませんでした。",
            detail: "",
            backUrl: "/admin/reservation-add",
          });
        }

        const currentReservation = getCurrentReservation(
          reservationPatient.reservations,
        );

        if (currentReservation) {
          return res.status(400).render("error", {
            title: "予約追加",
            heading: "すでに予約があります",
            message:
              "この患者には現在有効な予約があります。予約変更を行ってください。",
            detail: "",
            backUrl:
              "/admin/patients" +
              `?keyword=${encodeURIComponent(reservationPatient.patientNumber)}`,
          });
        }
      }

      /*
       * 以前のpatientNumber方式にも対応
       */
      let selectedPatient = reservationPatient || null;

      if (patientNumber && !selectedPatient) {
        selectedPatient = await prisma.patient.findUnique({
          where: {
            patientNumber,
          },

          include: {
            reservations: {
              where: {
                date: {
                  gte: getTodayText(),
                },
              },

              include: {
                doctor: true,
              },

              orderBy: [
                {
                  date: "asc",
                },
                {
                  slot: "asc",
                },
              ],
            },
          },
        });

        if (!selectedPatient) {
          return res.redirect(
            "/admin/reservation-add" + "?error=patient-not-found",
          );
        }
      }

      const selectedCurrentReservation = selectedPatient
        ? getCurrentReservation(selectedPatient.reservations)
        : null;

      if (selectedPatient) {
        selectedPatient = {
          ...selectedPatient,

          reservations: selectedCurrentReservation
            ? [selectedCurrentReservation]
            : [],
        };
      }

      /*
       * ==============================
       * 予約変更モード
       * ==============================
       *
       * editReservationIdから、
       * 予約・患者・担当医をまとめて取得します。
       */
      let editReservation = null;

      if (Number.isInteger(editReservationId) && editReservationId > 0) {
        editReservation = await prisma.reservation.findUnique({
          where: {
            id: editReservationId,
          },

          include: {
            patient: true,
            doctor: true,
          },
        });

        if (!editReservation) {
          return res.status(404).render("error", {
            title: "予約変更",
            heading: "予約が見つかりません",
            message: "変更対象の予約が削除されたか、存在しません。",
            detail: "",
            backUrl: "/admin/reservation-add",
          });
        }

        /*
         * 最初に選択した担当医に固定するため、
         * 別の担当医の予約は変更できません。
         */
        if (Number(editReservation.doctorId) !== Number(doctorId)) {
          return res.render("admin-change-doctor-confirm", {
            title: "担当医切替確認",

            doctorId,
            editReservation,

            message:
              "現在選択している担当医の予約ではありません。担当医を切り替えて予約変更を続けますか？",

            backUrl:
              "/admin/patients" +
              `?keyword=${encodeURIComponent(editReservation.patientNumber)}`,

            isAdminPage: true,
            isAdminLoggedIn: true,
          });
        }

        /*
         * 変更対象患者を選択患者として保持します。
         */
        selectedPatient = editReservation.patient;
      }

      /*
       * ==============================
       * 表示する週
       * ==============================
       */
      const week = getWeekParam(req.query.week);

      /*
       * 日本時間の今日
       */
      const todayText = getTodayText();

      const todayParts = todayText.split("-").map(Number);

      const todayDate = new Date(
        todayParts[0],
        todayParts[1] - 1,
        todayParts[2],
      );

      /*
       * 表示する7日間
       */
      const dates = [];

      const weekdays = ["日", "月", "火", "水", "木", "金", "土"];

      for (let index = week * 7; index < week * 7 + 7; index++) {
        const date = new Date(todayDate);

        date.setDate(todayDate.getDate() + index);

        const year = date.getFullYear();

        const month = String(date.getMonth() + 1).padStart(2, "0");

        const day = String(date.getDate()).padStart(2, "0");

        const value = `${year}-${month}-${day}`;

        dates.push({
          value,

          label:
            `${date.getMonth() + 1}/` +
            `${date.getDate()}` +
            `(${weekdays[date.getDay()]})`,
        });
      }

      /*
       * 予約可能最終日
       */
      const maxReservableDate = new Date(todayDate);

      maxReservableDate.setDate(
        maxReservableDate.getDate() + config.RESERVATION_DAYS,
      );

      const maxReservableText = maxReservableDate.toLocaleDateString("sv-SE");

      /*
       * 次の週を表示できるか
       */
      const nextWeekStart = new Date(todayDate);

      nextWeekStart.setDate(nextWeekStart.getDate() + (week + 1) * 7);

      const nextWeekStartText = nextWeekStart.toLocaleDateString("sv-SE");

      const canGoNextWeek = nextWeekStartText <= maxReservableText;

      /*
       * 選択中担当医の表示枠
       */
      const slots = config.getDisplaySlots(doctorId);

      /*
       * 表示期間内の予約
       */
      const reservations = await prisma.reservation.findMany({
        where: {
          doctorId,

          date: {
            gte: dates[0].value,
            lte: dates[dates.length - 1].value,
          },
        },

        include: {
          patient: true,
          doctor: true,
        },

        orderBy: [
          {
            date: "asc",
          },
          {
            slot: "asc",
          },
          {
            id: "asc",
          },
        ],
      });

      /*
       * 日付・時間ごとの診療設定
       */
      const slotSettings = {};

      await Promise.all(
        dates.flatMap((dateItem) => {
          const availableSlots = config.getSlotsForDate(
            dateItem.value,
            doctorId,
          );

          return slots.map(async (slot) => {
            const key = `${dateItem.value}_${slot}`;

            if (!availableSlots.includes(slot)) {
              slotSettings[key] = {
                isScheduled: false,
                isOpen: false,
                isOverride: false,
                capacity: 0,
              };

              return;
            }

            const setting = await getSlotSetting(
              dateItem.value,
              slot,
              doctorId,
            );

            slotSettings[key] = {
              isScheduled: true,
              isOpen: Boolean(setting.isOpen),
              isOverride: Boolean(setting.isOverride),
              capacity: Number(setting.capacity || 0),
            };
          });
        }),
      );

      /*
       * 予約変更を優先して判定します。
       */
      const isEditMode = Boolean(editReservation);

      const isAddMode = !isEditMode && Boolean(selectedPatient);

      return res.render("admin-reservations", {
        title: isEditMode
          ? "予約変更"
          : isAddMode
            ? "予約追加"
            : "予約スケジュール",

        isAdminPage: true,
        isAdminLoggedIn: true,

        doctor,
        doctorId,

        /*
         * 追加・変更対象患者
         */
        selectedPatient,

        patientNumber: selectedPatient ? selectedPatient.patientNumber : "",

        reservationPatient: reservationPatient || null,

        reservationPatientId: reservationPatient ? reservationPatient.id : null,

        /*
         * 変更対象予約
         */
        editReservation,

        editReservationId: editReservation ? editReservation.id : 0,

        /*
         * スケジュール
         */
        reservations,
        week,
        dates,
        slots,
        slotSettings,

        today: todayText,
        maxReservableText,
        canGoNextWeek,

        formatJapaneseDateShort,
        getSlotLabel: config.getSlotLabel,

        isPastReservationSlot,
      });
    } catch (error) {
      console.error("予約スケジュール表示エラー:", error);

      return res.status(500).render("error", {
        title: "予約スケジュール表示エラー",

        heading: "予約スケジュールを表示できませんでした",

        message: "予約スケジュールの読み込み中にエラーが発生しました。",

        detail: "",

        backUrl: "/admin/reservation-add",
      });
    }
  });

  app.get("/admin/logs", requireAdminLogin, async (req, res) => {
    const logs = await prisma.auditLog.findMany({
      orderBy: {
        createdAt: "desc",
      },
      take: 100,
    });

    return res.render("admin-logs", {
      title: "操作ログ",
      logs,
    });
  });

  app.get("/admin/add", requireAdminLogin, async (req, res) => {
    const doctorId = Number(req.session.doctorId);

    if (!isValidDoctorId(doctorId)) {
      return res.redirect("/admin/doctors");
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
          const todayText = getTodayText();

          const existingReservationCandidates = await tx.reservation.findMany({
            where: {
              patientNumber,

              date: {
                gte: todayText,
              },
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

          const existingReservation = getCurrentReservation(
            existingReservationCandidates,
          );

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

          reservationCode = createReservationCode();

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
    const doctorId = Number(req.session.doctorId);

    if (!isValidDoctorId(doctorId)) {
      return res.redirect("/admin/doctors");
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

    if (reservation.doctorId !== doctorId) {
      return res.redirect("/admin/reservations");
    }

    res.render("admin-edit", {
      title: "予約変更",
      doctor,
      doctorId,
      reservation,
      slots: config.getDisplaySlots(doctorId),
      error: null,
      formatJapaneseDateShort,
      getSlotLabel: config.getSlotLabel,
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
        getSlotLabel: config.getSlotLabel,
        error,
      });
    };
    if (
      !isValidDateText(date) ||
      !isValidSlot(slot, doctorId) ||
      !isWithinReservationPeriod(date) ||
      isPastReservationSlot(date, slot)
    ) {
      return renderEdit("予約内容が間違っています。");
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
    try {
      const queryDoctorId = Number(req.query.doctorId);
      const sessionDoctorId = Number(req.session.doctorId);

      const doctorId = isValidDoctorId(queryDoctorId)
        ? queryDoctorId
        : sessionDoctorId;

      if (isValidDoctorId(queryDoctorId)) {
        req.session.doctorId = queryDoctorId;
      }
      const date = String(req.query.date || "");
      const slot = String(req.query.slot || "");
      const success = String(req.query.success || "");

      if (!isValidDoctorId(doctorId)) {
        return res.redirect("/admin/doctors");
      }

      if (!isValidDateText(date) || !isValidSlot(slot, doctorId)) {
        return res.redirect("/admin/reservations");
      }

      /*
       * 管理画面では過去枠も詳細を確認できるようにするため、
       * isPastReservationSlotによるリダイレクトは行わない
       */

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

      const slotSetting = await getSlotSetting(date, slot, doctorId);

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

      const reservationCount = reservations.length;

      const remaining = Math.max(slotSetting.capacity - reservationCount, 0);

      const isFull =
        slotSetting.isOpen && reservationCount >= slotSetting.capacity;

      const isPast = isPastReservationSlot(date, slot);

      return res.render("admin-slot", {
        title: "予約枠詳細",

        isAdminPage: true,
        isAdminLoggedIn: true,

        doctor,
        doctorId,
        date,
        slot,

        slotLabel: config.getSlotLabel(slot, doctorId),

        reservations,
        reservationCount,
        remaining,
        isFull,
        isPast,

        isOpen: slotSetting.isOpen,
        isOverride: slotSetting.isOverride,
        capacity: slotSetting.capacity,
        slotSetting,
        formatJapaneseDateShort,

        success,
      });
    } catch (error) {
      console.error("予約枠詳細表示エラー:", error);

      return res.status(500).send("予約枠詳細の表示中にエラーが発生しました。");
    }
  });

  app.post("/admin/slot/settings", requireAdminLogin, async (req, res) => {
    try {
      const doctorId = Number(req.session.doctorId);
      const date = String(req.body.date || "");
      const slot = String(req.body.slot || "");
      const isOpen = req.body.isOpen === "true";
      const capacity = Number(req.body.capacity);

      const backUrl =
        `/admin/slot?date=${encodeURIComponent(date)}` +
        `&slot=${encodeURIComponent(slot)}`;

      if (!isValidDoctorId(doctorId)) {
        return res.redirect("/admin/doctors");
      }

      const isValidCapacity =
        !isOpen ||
        (Number.isInteger(capacity) && capacity >= 1 && capacity <= 5);

      if (
        !isValidDateText(date) ||
        !isValidSlot(slot, doctorId) ||
        !isValidCapacity
      ) {
        return res.render("error", {
          title: "設定変更エラー",
          heading: "設定内容が不正です",
          message: "診療状態または定員を確認してください。",
          detail: "",
          backUrl,
        });
      }

      if (isPastReservationSlot(date, slot)) {
        return res.render("error", {
          title: "設定変更不可",
          heading: "過去の予約枠です",
          message: "過去の予約枠は変更できません。",
          detail: "",
          backUrl: "/admin/reservations",
        });
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

      /*
       * 保存前の診療状態と定員を取得
       */
      const currentSetting = await getSlotSetting(date, slot, doctorId);

      const reservationCount = await prisma.reservation.count({
        where: {
          doctorId,
          date,
          slot,
        },
      });

      if (reservationCount > 0 && !isOpen) {
        return res.render("error", {
          title: "設定変更不可",
          heading: "休診に変更できません",
          message:
            "すでに予約が入っているため、この枠を休診には変更できません。",
          detail: `現在の予約数：${reservationCount}人`,
          backUrl,
        });
      }

      if (isOpen && capacity < reservationCount) {
        return res.render("error", {
          title: "設定変更不可",
          heading: "定員を減らせません",
          message: "定員は、現在入っている予約数以上に設定してください。",
          detail:
            `現在の予約数：${reservationCount}人 / ` +
            `指定した定員：${capacity}人`,
          backUrl,
        });
      }

      await prisma.slotOverride.upsert({
        where: {
          doctorId_date_slot: {
            doctorId,
            date,
            slot,
          },
        },
        update: {
          isOpen,
          capacity: isOpen ? capacity : 0,
        },
        create: {
          doctorId,
          date,
          slot,
          isOpen,
          capacity: isOpen ? capacity : 0,
        },
      });

      await createAuditLog(
        "予約枠設定変更",
        `医師ID:${doctorId}`,
        isOpen
          ? `${date} ${slot} / 診療 / 定員${capacity}人`
          : `${date} ${slot} / 休診`,
      );

      /*
       * 何が変更されたかを判定
       */
      const statusChanged = currentSetting.isOpen !== isOpen;

      const capacityChanged = isOpen && currentSetting.capacity !== capacity;

      let successType = "setting";

      if (statusChanged) {
        successType = "status";
      } else if (capacityChanged) {
        successType = "capacity";
      }

      return res.redirect(`${backUrl}&success=${successType}`);
    } catch (error) {
      console.error("予約枠設定変更エラー:", error);

      return res.status(500).render("error", {
        title: "設定変更エラー",
        heading: "エラーが発生しました",
        message: "予約枠設定の変更中にエラーが発生しました。",
        detail: "",
        backUrl: "/admin/reservations",
      });
    }
  });

  app.get("/admin/slot/patient-search", requireAdminLogin, async (req, res) => {
    try {
      const doctorId = Number(req.session.doctorId);

      const date = String(req.query.date || "");

      const slot = String(req.query.slot || "");

      const keyword = String(req.query.keyword || "").trim();

      if (!isValidDoctorId(doctorId)) {
        return res.redirect("/admin/doctors");
      }

      if (!isValidDateText(date) || !isValidSlot(slot, doctorId)) {
        return res.redirect("/admin/reservations");
      }

      if (isPastReservationSlot(date, slot)) {
        return res.render("error", {
          title: "患者検索",
          heading: "受付終了しています",
          message: "過去の予約枠には予約を追加できません。",
          detail: "",
          backUrl:
            `/admin/slot?date=${encodeURIComponent(date)}` +
            `&slot=${encodeURIComponent(slot)}`,
        });
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

      /*
       * 管理画面で変更した休診・定員を含む設定
       */
      const slotSetting = await getSlotSetting(date, slot, doctorId);

      if (!slotSetting.isOpen) {
        return res.render("error", {
          title: "患者検索",
          heading: "休診です",
          message: "この予約枠は休診に設定されています。",
          detail: "",
          backUrl:
            `/admin/slot?date=${encodeURIComponent(date)}` +
            `&slot=${encodeURIComponent(slot)}`,
        });
      }

      const reservationCount = await prisma.reservation.count({
        where: {
          doctorId,
          date,
          slot,
        },
      });

      if (reservationCount >= slotSetting.capacity) {
        return res.render("error", {
          title: "患者検索",
          heading: "満員です",
          message: "この予約枠はすでに満員です。",
          detail: "",
          backUrl:
            `/admin/slot?date=${encodeURIComponent(date)}` +
            `&slot=${encodeURIComponent(slot)}`,
        });
      }

      let patients = [];

      if (keyword) {
        const today = new Date().toLocaleDateString("sv-SE", {
          timeZone: "Asia/Tokyo",
        });

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

          include: {
            reservations: {
              where: {
                date: {
                  gte: today,
                },
              },

              include: {
                doctor: true,
              },

              orderBy: [
                {
                  date: "asc",
                },
                {
                  slot: "asc",
                },
              ],
            },
          },

          orderBy: {
            patientNumber: "asc",
          },

          take: 50,
        });
      }

      return res.render("admin-slot-patient-search", {
        title: "予約追加",

        isAdminPage: true,
        isAdminLoggedIn: true,

        doctor,
        doctorId,
        date,
        slot,

        slotLabel: config.getSlotLabel(slot, doctorId),

        keyword,
        patients,
        hasSearched: Boolean(keyword),

        registerError: null,
        registerSuccess: null,
        confirmPatient: null,
        registeredPatient: null,

        newPatientNumber: String(req.query.newPatientNumber || ""),

        newPatientName: String(req.query.newPatientName || ""),

        formatJapaneseDateShort,
        getSlotLabel: config.getSlotLabel,
      });
    } catch (error) {
      console.error("患者検索画面表示エラー:", error);

      return res.status(500).render("error", {
        title: "患者検索エラー",
        heading: "エラーが発生しました",
        message: "患者検索画面の表示中にエラーが発生しました。",
        detail: "",
        backUrl: "/admin/reservations",
      });
    }
  });

  app.post(
    "/admin/slot/patient-register-confirm",
    requireAdminLogin,
    async (req, res) => {
      try {
        const doctorId = Number(req.session.doctorId);

        const patientNumber = String(req.body.patientNumber || "").trim();

        const date = String(req.body.date || "").trim();

        const slot = String(req.body.slot || "").trim();

        const backUrl =
          "/admin/reservations" +
          `?patientNumber=${encodeURIComponent(patientNumber)}`;

        /*
         * 担当医チェック
         */
        if (!isValidDoctorId(doctorId)) {
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

        /*
         * 入力値チェック
         */
        if (
          !isValidPatientNumber(patientNumber) ||
          !isValidDateText(date) ||
          !isValidSlot(slot, doctorId) ||
          !isWithinReservationPeriod(date)
        ) {
          return res.status(400).render("error", {
            title: "予約追加",
            heading: "予約を追加できません",
            message: "患者情報または予約日時が正しくありません。",
            detail: "",
            backUrl,
          });
        }

        /*
         * 過去の予約枠チェック
         */
        if (isPastReservationSlot(date, slot)) {
          return res.status(400).render("error", {
            title: "予約追加",
            heading: "受付終了しています",
            message: "過去の予約枠には予約を追加できません。",
            detail: "",
            backUrl,
          });
        }

        /*
         * 患者情報取得
         */
        const patient = await prisma.patient.findUnique({
          where: {
            patientNumber,
          },
        });

        if (!patient) {
          return res.status(404).render("error", {
            title: "予約追加",
            heading: "患者情報が見つかりません",
            message: "指定された患者は登録されていません。",
            detail: "",
            backUrl: "/admin/patients",
          });
        }

        /*
         * 本来の診療枠か確認
         */
        const availableSlots = config.getSlotsForDate(date, doctorId);

        if (!availableSlots.includes(slot)) {
          return res.status(400).render("error", {
            title: "予約追加",
            heading: "予約できない日時です",
            message: "選択された日時は診療時間ではありません。",
            detail: "",
            backUrl,
          });
        }

        /*
         * 診療設定・定員を取得
         */
        const setting = await getSlotSetting(date, slot, doctorId);

        if (!setting.isOpen) {
          return res.status(400).render("error", {
            title: "予約追加",
            heading: "休診の予約枠です",
            message: "選択された予約枠は休診に設定されています。",
            detail: "",
            backUrl,
          });
        }

        const capacity = Number(setting.capacity || 0);

        if (!Number.isInteger(capacity) || capacity <= 0) {
          return res.status(400).render("error", {
            title: "予約追加",
            heading: "予約を追加できません",
            message: "選択された予約枠の定員が設定されていません。",
            detail: "",
            backUrl,
          });
        }

        /*
         * 同じ患者の未来予約を確認
         */
        const today = new Date().toLocaleDateString("sv-SE", {
          timeZone: "Asia/Tokyo",
        });

        const existingReservation = await prisma.reservation.findFirst({
          where: {
            patientNumber,
            date: {
              gte: today,
            },
          },
          include: {
            doctor: true,
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

        if (existingReservation) {
          return res.status(409).render("error", {
            title: "予約追加",
            heading: "すでに予約があります",
            message:
              "この患者には現在有効な予約があるため、新しい予約を追加できません。",
            detail:
              `${formatJapaneseDateShort(existingReservation.date)} ` +
              `${config.getSlotLabel(
                existingReservation.slot,
                existingReservation.doctorId,
              )}`,
            backUrl:
              "/admin/slot" +
              `?date=${encodeURIComponent(existingReservation.date)}` +
              `&slot=${encodeURIComponent(existingReservation.slot)}`,
          });
        }

        /*
         * 選択枠の現在の予約数を確認
         */
        const reservationCount = await prisma.reservation.count({
          where: {
            doctorId,
            date,
            slot,
          },
        });

        if (reservationCount >= capacity) {
          return res.status(409).render("error", {
            title: "予約追加",
            heading: "予約枠が満員です",
            message:
              "選択された予約枠は満員になりました。別の日時を選択してください。",
            detail: "",
            backUrl,
          });
        }

        /*
         * 予約確認画面を表示
         */
        return res.render("admin-patient-register-confirm", {
          title: "予約追加確認",

          isAdminPage: true,
          isAdminLoggedIn: true,

          patient,
          patientNumber,

          doctor,
          doctorId,

          date,
          slot,

          dateLabel: formatJapaneseDateShort(date),

          slotLabel: config.getSlotLabel(slot, doctorId),

          capacity,
          reservationCount,

          backUrl,
        });
      } catch (error) {
        console.error("患者予約追加確認エラー:", error);

        return res.status(500).render("error", {
          title: "予約追加エラー",
          heading: "予約確認画面を表示できませんでした",
          message: "予約内容の確認中にエラーが発生しました。",
          detail: "",
          backUrl: "/admin/patients",
        });
      }
    },
  );
  app.post(
    "/admin/slot/patient-register",
    requireAdminLogin,
    async (req, res) => {
      try {
        const doctorId = Number(req.session.doctorId);
        const date = String(req.body.date || "").trim();
        const slot = String(req.body.slot || "").trim();

        const patientNumber = String(req.body.patientNumber || "").trim();

        const name = String(req.body.name || "")
          .trim()
          .replace(/\s+/g, " ");

        if (!isValidDoctorId(doctorId)) {
          return res.redirect("/admin/doctors");
        }

        if (!isValidDateText(date) || !isValidSlot(slot, doctorId)) {
          return res.redirect("/admin/reservations");
        }

        if (isPastReservationSlot(date, slot)) {
          return res.render("error", {
            title: "患者登録",
            heading: "受付終了しています",
            message: "過去の予約枠には患者を登録できません。",
            detail: "",
            backUrl:
              `/admin/slot?date=${encodeURIComponent(date)}` +
              `&slot=${encodeURIComponent(slot)}`,
          });
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

        const slotSetting = await getSlotSetting(date, slot, doctorId);

        if (!slotSetting.isOpen) {
          return res.render("error", {
            title: "患者登録",
            heading: "休診です",
            message: "この予約枠は休診に設定されています。",
            detail: "",
            backUrl:
              `/admin/slot?date=${encodeURIComponent(date)}` +
              `&slot=${encodeURIComponent(slot)}`,
          });
        }

        const reservationCount = await prisma.reservation.count({
          where: {
            doctorId,
            date,
            slot,
          },
        });

        if (reservationCount >= slotSetting.capacity) {
          return res.render("error", {
            title: "患者登録",
            heading: "満員です",
            message: "この予約枠はすでに満員です。",
            detail: "",
            backUrl:
              `/admin/slot?date=${encodeURIComponent(date)}` +
              `&slot=${encodeURIComponent(slot)}`,
          });
        }

        let registerError = null;

        if (!patientNumber) {
          registerError = "患者番号を入力してください。";
        } else if (patientNumber.length > 50) {
          registerError = "患者番号は50文字以内で入力してください。";
        } else if (!name) {
          registerError = "患者氏名を入力してください。";
        } else if (name.length > 100) {
          registerError = "患者氏名は100文字以内で入力してください。";
        }

        if (registerError) {
          return res.status(400).render("admin-slot-patient-search", {
            title: "予約追加",

            isAdminPage: true,
            isAdminLoggedIn: true,

            doctor,
            doctorId,
            date,
            slot,

            slotLabel: config.getSlotLabel(slot, doctorId),

            keyword: "",
            patients: [],
            hasSearched: false,

            registerError,
            registerSuccess: null,
            confirmPatient: null,
            registeredPatient: null,

            newPatientNumber: patientNumber,
            newPatientName: name,

            formatJapaneseDateShort,
            getSlotLabel: config.getSlotLabel,
          });
        }

        let registeredPatient;

        try {
          registeredPatient = await prisma.patient.create({
            data: {
              patientNumber,
              name,
            },
          });
        } catch (error) {
          if (error?.code === "P2002") {
            return res.status(409).render("admin-slot-patient-search", {
              title: "予約追加",

              isAdminPage: true,
              isAdminLoggedIn: true,

              doctor,
              doctorId,
              date,
              slot,

              slotLabel: config.getSlotLabel(slot, doctorId),

              keyword: "",
              patients: [],
              hasSearched: false,

              registerError:
                "この患者番号はすでに登録されています。患者検索から選択してください。",

              registerSuccess: null,
              confirmPatient: null,
              registeredPatient: null,

              newPatientNumber: patientNumber,
              newPatientName: name,

              formatJapaneseDateShort,
              getSlotLabel: config.getSlotLabel,
            });
          }

          throw error;
        }

        await createAuditLog("患者登録", patientNumber, `患者氏名: ${name}`);

        return res.render("admin-slot-patient-search", {
          title: "予約追加",

          isAdminPage: true,
          isAdminLoggedIn: true,

          doctor,
          doctorId,
          date,
          slot,

          slotLabel: config.getSlotLabel(slot, doctorId),

          keyword: "",
          patients: [],
          hasSearched: false,

          registerError: null,
          registerSuccess: "以下の患者情報を登録しました。",

          confirmPatient: null,

          registeredPatient: {
            patientNumber: registeredPatient.patientNumber,
            name: registeredPatient.name,
            reservations: [],
          },

          newPatientNumber: "",
          newPatientName: "",

          formatJapaneseDateShort,
          getSlotLabel: config.getSlotLabel,
        });
      } catch (error) {
        console.error("患者登録エラー:", error);

        return res.status(500).render("error", {
          title: "患者登録エラー",
          heading: "エラーが発生しました",
          message: "患者登録中にエラーが発生しました。",
          detail: "",
          backUrl: "/admin/reservations",
        });
      }
    },
  );

  app.get("/admin/slot/confirm", requireAdminLogin, async (req, res) => {
    const doctorId = Number(req.session.doctorId);
    const date = String(req.query.date || "");
    const slot = String(req.query.slot || "");
    const patientNumber = String(req.query.patientNumber || "").trim();

    if (!isValidDoctorId(doctorId)) {
      return res.redirect("/admin/doctors");
    }

    if (
      !isValidDateText(date) ||
      !isValidSlot(slot, doctorId) ||
      !isValidPatientNumber(patientNumber)
    ) {
      return res.redirect("/admin/reservations");
    }

    const [doctor, patient] = await Promise.all([
      prisma.doctor.findFirst({
        where: {
          id: doctorId,
          isActive: true,
        },
      }),

      prisma.patient.findUnique({
        where: {
          patientNumber,
        },
      }),
    ]);

    if (!doctor) {
      req.session.doctorId = null;
      return res.redirect("/admin/doctors");
    }

    if (!patient) {
      return res.render("error", {
        title: "予約不可",
        heading: "患者が見つかりません",
        message: "指定された患者情報が見つかりません。",
        detail: "",
        backUrl:
          `/admin/slot/patient-search?date=${date}` +
          `&slot=${encodeURIComponent(slot)}`,
      });
    }

    const availableSlots = config.getSlotsForDate(date, doctorId);

    if (!availableSlots.includes(slot)) {
      return res.render("error", {
        title: "予約不可",
        heading: "診療時間外です",
        message: "この日時は診療時間外です。",
        detail: "",
        backUrl:
          `/admin/slot?date=${date}` + `&slot=${encodeURIComponent(slot)}`,
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
          `/admin/slot?date=${date}` + `&slot=${encodeURIComponent(slot)}`,
      });
    }

    const today = new Date().toLocaleDateString("sv-SE", {
      timeZone: "Asia/Tokyo",
    });

    const existingReservation = await prisma.reservation.findFirst({
      where: {
        patientNumber,
        date: {
          gte: today,
        },
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

    if (existingReservation) {
      return res.render("error", {
        title: "予約不可",
        heading: "すでに予約があります",
        message: "この患者には、すでに予約があります。",
        detail:
          `既存予約：${existingReservation.date} ` +
          `${existingReservation.slot}`,
        backUrl:
          `/admin/slot/patient-search?date=${date}` +
          `&slot=${encodeURIComponent(slot)}`,
      });
    }

    return res.render("admin-slot-confirm", {
      title: "予約確認",
      doctor,
      doctorId,
      date,
      slot,
      slotLabel: config.getSlotLabel(slot, doctorId),
      patient,
      formatJapaneseDateShort,
    });
  });

  app.post("/admin/slot/complete", requireAdminLogin, async (req, res) => {
    const doctorId = Number(req.session.doctorId);
    const date = String(req.body.date || "");
    const slot = String(req.body.slot || "");
    const patientNumber = String(req.body.patientNumber || "").trim();

    const backUrl =
      `/admin/slot?date=${date}` + `&slot=${encodeURIComponent(slot)}`;

    if (!isValidDoctorId(doctorId)) {
      return res.redirect("/admin/doctors");
    }

    if (
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
      prisma.doctor.findFirst({
        where: {
          id: doctorId,
          isActive: true,
        },
      }),

      prisma.patient.findUnique({
        where: {
          patientNumber,
        },
      }),
    ]);

    if (!doctor) {
      req.session.doctorId = null;
      return res.redirect("/admin/doctors");
    }

    if (!patient) {
      return res.render("error", {
        title: "予約不可",
        heading: "患者が見つかりません",
        message: "指定された患者情報が見つかりません。",
        detail: "",
        backUrl,
      });
    }

    const availableSlots = config.getSlotsForDate(date, doctorId);

    if (!availableSlots.includes(slot)) {
      return res.render("error", {
        title: "予約不可",
        heading: "診療時間外です",
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

          const today = new Date().toLocaleDateString("sv-SE", {
            timeZone: "Asia/Tokyo",
          });

          const existingReservation = await tx.reservation.findFirst({
            where: {
              patientNumber,
              date: {
                gte: today,
              },
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

          if (existingReservation) {
            throw new Error(
              `DUPLICATE:${existingReservation.date} ${existingReservation.slot}`,
            );
          }

          reservationCode = createReservationCode();

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

      if (error.message.startsWith("DUPLICATE:")) {
        return res.render("error", {
          title: "予約不可",
          heading: "すでに予約があります",
          message: "この患者には、すでに予約があります。",
          detail: `既存予約：${error.message.replace("DUPLICATE:", "")}`,
          backUrl,
        });
      }

      console.error("管理者予約追加エラー:", error);

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

    return res.render("admin-slot-complete", {
      title: "予約完了",
      doctor,
      doctorId,
      date,
      slot,
      slotLabel: config.getSlotLabel(slot, doctorId),
      patient,
      reservationCode,
      formatJapaneseDateShort,
    });
  });

  app.post("/admin/edit/:id/confirm", requireAdminLogin, async (req, res) => {
    const id = Number(req.params.id);

    const doctorId = Number(req.session.doctorId);

    const date = String(req.body.date || "");
    const slot = String(req.body.slot || "");

    if (!isValidDoctorId(doctorId)) {
      return res.redirect("/admin/doctors");
    }

    if (
      !Number.isInteger(id) ||
      id <= 0 ||
      !isValidDateText(date) ||
      !isValidSlot(slot, doctorId)
    ) {
      return res.redirect("/admin/reservations");
    }

    const [doctor, reservation] = await Promise.all([
      prisma.doctor.findFirst({
        where: {
          id: doctorId,
          isActive: true,
        },
      }),

      prisma.reservation.findUnique({
        where: {
          id,
        },
        include: {
          patient: true,
          doctor: true,
        },
      }),
    ]);

    if (!doctor) {
      req.session.doctorId = null;
      return res.redirect("/admin/doctors");
    }

    if (!reservation) {
      return res.redirect("/admin/reservations");
    }

    if (reservation.doctorId !== doctorId) {
      return res.redirect("/admin/reservations");
    }

    const availableSlots = config.getSlotsForDate(date, doctorId);

    if (!availableSlots.includes(slot)) {
      return res.render("error", {
        title: "予約変更不可",
        heading: "診療時間外です",
        message: "この日時は診療時間外です。",
        detail: "",
        backUrl: `/admin/edit/${id}`,
      });
    }

    const count = await prisma.reservation.count({
      where: {
        doctorId,
        date,
        slot,
        id: {
          not: id,
        },
      },
    });

    const capacity = config.getCapacityForSlot(date, slot, doctorId);

    if (count >= capacity) {
      return res.render("error", {
        title: "予約変更不可",
        heading: "満員です",
        message: "この予約枠は満員です。",
        detail: "",
        backUrl: `/admin/edit/${id}`,
      });
    }

    return res.render("admin-edit-confirm", {
      title: "予約変更確認",
      doctor,
      reservation,
      date,
      slot,
      slotLabel: config.getSlotLabel(slot, doctorId),
      getSlotLabel: config.getSlotLabel,
      formatJapaneseDateShort,
    });
  });

  app.post("/admin/edit/:id/complete", requireAdminLogin, async (req, res) => {
    const id = Number(req.params.id);
    const doctorId = Number(req.session.doctorId);
    const date = String(req.body.date || "");
    const slot = String(req.body.slot || "");

    const backUrl = `/admin/edit/${id}`;

    if (!isValidDoctorId(doctorId)) {
      return res.redirect("/admin/doctors");
    }

    if (
      !Number.isInteger(id) ||
      id <= 0 ||
      !isValidDateText(date) ||
      !isValidSlot(slot, doctorId) ||
      !isWithinReservationPeriod(date)
    ) {
      return res.render("error", {
        title: "予約変更不可",
        heading: "予約変更不可",
        message: "予約内容が不正です。",
        detail: "",
        backUrl,
      });
    }

    const [doctor, reservation] = await Promise.all([
      prisma.doctor.findFirst({
        where: {
          id: doctorId,
          isActive: true,
        },
      }),

      prisma.reservation.findUnique({
        where: {
          id,
        },
        include: {
          patient: true,
          doctor: true,
        },
      }),
    ]);

    if (!doctor) {
      req.session.doctorId = null;

      return res.redirect("/admin/doctors");
    }

    if (!reservation) {
      return res.render("error", {
        title: "エラー",
        heading: "予約が見つかりません",
        message: "変更対象の予約が存在しません。",
        detail: "",
        backUrl: "/admin/reservations",
      });
    }

    if (reservation.doctorId !== doctorId) {
      return res.render("error", {
        title: "予約変更不可",
        heading: "予約変更不可",
        message: "現在選択中の担当医の予約ではありません。",
        detail: "",
        backUrl: "/admin/reservations",
      });
    }

    const availableSlots = config.getSlotsForDate(date, doctorId);

    if (!availableSlots.includes(slot)) {
      return res.render("error", {
        title: "予約変更不可",
        heading: "診療時間外です",
        message:
          `${formatJapaneseDate(date)} ` +
          `${config.getSlotLabel(slot, doctorId)} は診療時間外です。`,
        detail: "",
        backUrl,
      });
    }

    try {
      await prisma.$transaction(
        async (tx) => {
          const currentReservation = await tx.reservation.findUnique({
            where: {
              id,
            },
          });

          if (!currentReservation) {
            throw new Error("NOT_FOUND");
          }

          if (currentReservation.doctorId !== doctorId) {
            throw new Error("FORBIDDEN");
          }

          const count = await tx.reservation.count({
            where: {
              doctorId,
              date,
              slot,
              id: {
                not: id,
              },
            },
          });

          const capacity = config.getCapacityForSlot(date, slot, doctorId);

          if (count >= capacity) {
            throw new Error("FULL");
          }

          const today = new Date().toLocaleDateString("sv-SE", {
            timeZone: "Asia/Tokyo",
          });

          const existingReservation = await tx.reservation.findFirst({
            where: {
              patientNumber: currentReservation.patientNumber,

              date: {
                gte: today,
              },

              id: {
                not: id,
              },
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

          if (existingReservation) {
            throw new Error(
              `DUPLICATE:${existingReservation.date} ${existingReservation.slot}`,
            );
          }

          await tx.reservation.update({
            where: {
              id,
            },
            data: {
              date,
              slot,
              doctorId,
            },
          });
        },
        {
          isolationLevel: "Serializable",
        },
      );
    } catch (error) {
      if (error.message === "NOT_FOUND") {
        return res.render("error", {
          title: "エラー",
          heading: "予約が見つかりません",
          message: "変更対象の予約が存在しません。",
          detail: "",
          backUrl: "/admin/reservations",
        });
      }

      if (error.message === "FORBIDDEN") {
        return res.render("error", {
          title: "予約変更不可",
          heading: "予約変更不可",
          message: "現在選択中の担当医の予約ではありません。",
          detail: "",
          backUrl: "/admin/reservations",
        });
      }

      if (error.message === "FULL") {
        return res.render("error", {
          title: "予約変更不可",
          heading: "満員です",
          message:
            `${formatJapaneseDate(date)} ` +
            `${config.getSlotLabel(slot, doctorId)} は満員です。`,
          detail: "",
          backUrl,
        });
      }

      if (
        typeof error.message === "string" &&
        error.message.startsWith("DUPLICATE:")
      ) {
        return res.render("error", {
          title: "予約変更不可",
          heading: "すでに予約があります",
          message: "この患者には、ほかの予約がすでにあります。",
          detail: `既存予約：${error.message.replace("DUPLICATE:", "")}`,
          backUrl,
        });
      }

      console.error("管理者予約変更エラー:", error);

      return res.render("error", {
        title: "予約変更不可",
        heading: "エラー",
        message: "予約変更処理中にエラーが発生しました。",
        detail: "",
        backUrl,
      });
    }

    await createAuditLog(
      "予約変更",
      `予約ID:${id}`,
      `${reservation.date} ${reservation.slot} / 医師ID:${reservation.doctorId}` +
        ` → ${date} ${slot} / 医師ID:${doctorId}`,
    );

    return res.render("admin-complete", {
      title: "予約変更完了",
      heading: "予約を変更しました",
      message: "以下の内容に変更しました。",

      reservationTableTitle: "変更後の予約内容",

      reservation: {
        id,
        date,
        slot,
        doctorId,

        doctor: {
          id: doctor.id,
          name: doctor.name,
          displayName: doctor.displayName,
        },

        patient: {
          patientNumber: reservation.patient.patientNumber,
          name: reservation.patient.name,
        },
      },

      isAdminPage: true,
      isAdminLoggedIn: true,
    });
  });

  app.get("/admin/reservation-add", requireAdminLogin, async (req, res) => {
    try {
      const doctorId = Number(req.session.doctorId);

      if (!isValidDoctorId(doctorId)) {
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

      const keyword = String(req.query.keyword || "").trim();

      const hasSearched = keyword.length > 0;

      let patients = [];

      if (hasSearched) {
        patients = await prisma.patient.findMany({
          where: {
            OR: [
              {
                patientNumber: {
                  contains: keyword,
                  mode: "insensitive",
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

          include: {
            reservations: {
              where: {
                date: {
                  gte: getTodayText(),
                },
              },

              include: {
                doctor: true,
              },

              orderBy: [
                {
                  date: "asc",
                },
                {
                  slot: "asc",
                },
              ],
            },
          },

          orderBy: {
            patientNumber: "asc",
          },

          take: 100,
        });
      }

      return res.render("admin-reservation-add", {
        title: "予約追加",

        isAdminPage: true,
        isAdminLoggedIn: true,

        doctorId,
        doctor,

        path: req.path,

        keyword,
        hasSearched,
        patients,

        success: String(req.query.success || ""),

        error: "",
      });
    } catch (error) {
      console.error("予約追加患者検索エラー:", error);

      return res.status(500).render("admin-reservation-add", {
        title: "予約追加",

        isAdminPage: true,
        isAdminLoggedIn: true,

        doctorId: "",
        doctor: null,

        path: req.path,

        keyword: String(req.query.keyword || "").trim(),

        hasSearched: false,
        patients: [],

        success: "",

        error:
          "患者情報を取得できませんでした。時間をおいて再度お試しください。",
      });
    }
  });

  // ======================================================
  // 管理画面：予約追加から新規患者登録
  // ======================================================

  app.get(
    "/admin/reservation-add/patient/new",
    requireAdminLogin,
    async (req, res) => {
      try {
        return res.render("admin-patient-add", {
          title: "新規患者登録",

          isAdminPage: true,
          isAdminLoggedIn: true,

          mode: "reservation",

          patientNumber: "",
          name: "",

          birthYear: "",
          birthMonth: "",
          birthDay: "",

          error: "",
        });
      } catch (error) {
        console.error("予約追加新規患者画面エラー:", error);

        return res.status(500).render("error", {
          title: "新規患者登録",
          heading: "画面を表示できません",
          message: "新規患者登録画面を表示できませんでした。",
          detail: "",
          backUrl: "/admin/reservation-add",
        });
      }
    },
  );
  // ======================================================
  // 予約追加画面：新規患者登録確認
  // ======================================================

  app.post(
    "/admin/reservation-add/patient/confirm",
    requireAdminLogin,
    async (req, res) => {
      try {
        const patientNumber = String(req.body.patientNumber || "").trim();

        const name = String(req.body.name || "")
          .trim()
          .replace(/\s+/g, " ");

        const birthYear = String(req.body.birthYear || "").trim();

        const birthMonth = String(req.body.birthMonth || "").trim();

        const birthDay = String(req.body.birthDay || "").trim();

        const renderInputError = (error) => {
          return res.status(400).render("admin-reservation-add", {
            title: "予約追加",

            isAdminPage: true,
            isAdminLoggedIn: true,

            keyword: "",
            hasSearched: false,
            patients: [],

            patientNumber,
            name,
            birthYear,
            birthMonth,
            birthDay,

            success: "",
            error,
          });
        };

        if (
          !isValidPatientNumber(patientNumber) ||
          !name ||
          !birthYear ||
          !birthMonth ||
          !birthDay
        ) {
          return renderInputError(
            "患者番号・氏名・生年月日を正しく入力してください。",
          );
        }

        const year = Number(birthYear);
        const month = Number(birthMonth);
        const day = Number(birthDay);

        const birthDate = new Date(Date.UTC(year, month - 1, day));

        const isValidBirthDate =
          Number.isInteger(year) &&
          year >= 1900 &&
          year <= new Date().getFullYear() &&
          Number.isInteger(month) &&
          month >= 1 &&
          month <= 12 &&
          Number.isInteger(day) &&
          day >= 1 &&
          day <= 31 &&
          birthDate.getUTCFullYear() === year &&
          birthDate.getUTCMonth() + 1 === month &&
          birthDate.getUTCDate() === day;

        if (!isValidBirthDate) {
          return renderInputError("生年月日を正しく入力してください。");
        }

        const existingPatient = await prisma.patient.findUnique({
          where: {
            patientNumber,
          },
        });

        if (existingPatient) {
          return renderInputError(
            "この患者番号はすでに登録されています。患者検索から選択してください。",
          );
        }

        const birthDateText =
          `${year}-` +
          `${String(month).padStart(2, "0")}-` +
          `${String(day).padStart(2, "0")}`;

        return res.render("admin-patient-add-confirm", {
          title: "患者登録確認",

          isAdminPage: true,
          isAdminLoggedIn: true,

          patientNumber,
          name,

          birthYear: year,
          birthMonth: month,
          birthDay: day,
          birthDateText,

          backUrl: "/admin/reservation-add",
        });
      } catch (error) {
        console.error("予約追加患者登録確認エラー:", error);

        return res.status(500).render("error", {
          title: "患者登録確認",
          heading: "患者情報を確認できませんでした",
          message: "時間をおいて、もう一度お試しください。",
          detail: "",
          backUrl: "/admin/reservation-add",

          isAdminPage: true,
          isAdminLoggedIn: true,
        });
      }
    },
  );

  // ======================================================
  // 予約追加画面：新規患者登録実行
  // ======================================================

  app.post(
    "/admin/reservation-add/patient/complete",
    requireAdminLogin,
    async (req, res) => {
      try {
        const patientNumber = String(req.body.patientNumber || "").trim();

        const name = String(req.body.name || "")
          .trim()
          .replace(/\s+/g, " ");

        const birthDateText = String(req.body.birthDate || "").trim();

        if (
          !isValidPatientNumber(patientNumber) ||
          !name ||
          !isValidDateText(birthDateText)
        ) {
          return res.status(400).render("error", {
            title: "患者登録",
            heading: "登録内容が不正です",
            message: "入力画面へ戻り、患者情報をもう一度確認してください。",
            detail: "",
            backUrl: "/admin/reservation-add",

            isAdminPage: true,
            isAdminLoggedIn: true,
          });
        }

        const birthParts = birthDateText.split("-").map(Number);

        const birthDate = new Date(
          Date.UTC(birthParts[0], birthParts[1] - 1, birthParts[2]),
        );

        const isValidBirthDate =
          birthDate.getUTCFullYear() === birthParts[0] &&
          birthDate.getUTCMonth() + 1 === birthParts[1] &&
          birthDate.getUTCDate() === birthParts[2];

        if (!isValidBirthDate) {
          return res.status(400).render("error", {
            title: "患者登録",
            heading: "生年月日が不正です",
            message: "入力画面へ戻り、生年月日を確認してください。",
            detail: "",
            backUrl: "/admin/reservation-add",

            isAdminPage: true,
            isAdminLoggedIn: true,
          });
        }

        const existingPatient = await prisma.patient.findUnique({
          where: {
            patientNumber,
          },
        });

        /*
         * 確認画面の表示後に、別の操作で同じ患者番号が
         * 登録される可能性があるため、登録直前にも確認します。
         */
        if (existingPatient) {
          return res.status(409).render("error", {
            title: "患者登録",
            heading: "患者番号が重複しています",
            message:
              "この患者番号はすでに登録されています。患者検索から選択してください。",
            detail: "",
            backUrl:
              `/admin/reservation-add?keyword=` +
              encodeURIComponent(patientNumber),

            isAdminPage: true,
            isAdminLoggedIn: true,
          });
        }

        const patient = await prisma.patient.create({
          data: {
            patientNumber,
            name,
            birthDate,
          },
        });

        await createAuditLog("患者登録", `患者番号:${patientNumber}`, name);

        return res.render("patient-add-complete", {
          title: "患者登録完了",

          patient,
          reservation: null,

          showReservationAddButton: true,

          reservationAddUrl:
            `/admin/reservations?week=0` +
            `&reservationPatientId=${patient.id}`,

          isAdminPage: true,
          isAdminLoggedIn: true,
        });
      } catch (error) {
        console.error("予約追加患者登録エラー:", error);

        if (error.code === "P2002") {
          return res.status(409).render("error", {
            title: "患者登録",
            heading: "患者番号が重複しています",
            message: "この患者番号はすでに登録されています。",
            detail: "",
            backUrl: "/admin/reservation-add",

            isAdminPage: true,
            isAdminLoggedIn: true,
          });
        }

        return res.status(500).render("error", {
          title: "患者登録エラー",
          heading: "患者情報を登録できませんでした",
          message: "時間をおいて、もう一度お試しください。",
          detail: "",
          backUrl: "/admin/reservation-add",

          isAdminPage: true,
          isAdminLoggedIn: true,
        });
      }
    },
  );

  app.get("/admin/patients", requireAdminLogin, async (req, res) => {
    try {
      const doctorId = Number(req.session.doctorId);

      const keyword = String(req.query.keyword || "").trim();

      const today = new Date().toLocaleDateString("sv-SE", {
        timeZone: "Asia/Tokyo",
      });

      const doctor = isValidDoctorId(doctorId)
        ? await prisma.doctor.findFirst({
            where: {
              id: doctorId,
              isActive: true,
            },
          })
        : null;

      const doctors = await prisma.doctor.findMany({
        where: {
          isActive: true,
        },
        orderBy: {
          id: "asc",
        },
      });

      const foundPatients = keyword
        ? await prisma.patient.findMany({
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

            include: {
              reservations: {
                where: {
                  date: {
                    gte: today,
                  },
                },

                include: {
                  doctor: true,
                },

                orderBy: [
                  {
                    date: "asc",
                  },
                  {
                    slot: "asc",
                  },
                ],
              },
            },

            orderBy: {
              patientNumber: "asc",
            },

            take: 50,
          })
        : [];

      const patients = foundPatients.map((patient) => {
        const currentReservation = getCurrentReservation(patient.reservations);

        return {
          ...patient,

          reservations: currentReservation ? [currentReservation] : [],
        };
      });

      return res.render("admin-patients", {
        title: "患者管理",

        isAdminPage: true,
        isAdminLoggedIn: true,

        path: req.path,

        doctorId,
        doctor,
        doctors,

        keyword,
        patients,

        formatJapaneseDateShort,
      });
    } catch (error) {
      console.error("患者検索エラー:", error);

      return res.status(500).render("error", {
        title: "患者管理",
        heading: "患者情報を取得できませんでした",
        message: "時間をおいて、もう一度お試しください。",
        detail: "",
        backUrl: "/admin/patients",

        isAdminPage: true,
        isAdminLoggedIn: true,
      });
    }
  });

  app.get("/admin/patients/add", (req, res) => {
    if (!req.session.isAdmin) {
      return res.redirect("/admin-login");
    }

    res.render("admin-patient-add", {
      title: "患者登録",
      error: null,
    });
  });

  app.post("/admin/patients/add", requireAdminLogin, async (req, res) => {
    try {
      const patientNumber = String(req.body.patientNumber || "").trim();

      const name = String(req.body.name || "").trim();

      const year = String(req.body.birthYear || "").trim();

      const birthMonth = String(req.body.birthMonth || "").trim();

      const birthDay = String(req.body.birthDay || "").trim();

      const month = birthMonth.padStart(2, "0");
      const day = birthDay.padStart(2, "0");

      const birthDateText = `${year}-${month}-${day}`;
      const birthDate = new Date(`${birthDateText}T00:00:00+09:00`);
      const isValidBirthDate =
        /^\d{4}-\d{2}-\d{2}$/.test(birthDateText) &&
        !Number.isNaN(birthDate.getTime()) &&
        birthDate.toLocaleDateString("sv-SE", {
          timeZone: "Asia/Tokyo",
        }) === birthDateText;

      if (
        !isValidPatientNumber(patientNumber) ||
        !name ||
        !year ||
        !birthMonth ||
        !birthDay ||
        !isValidBirthDate
      ) {
        return res.status(400).render("admin-patient-add", {
          title: "患者登録",
          error: "患者番号・氏名・生年月日を正しく入力してください。",
          patientNumber,
          name,
          birthYear: year,
          birthMonth,
          birthDay,
          isAdminPage: true,
          isAdminLoggedIn: true,
        });
      }

      const existingPatient = await prisma.patient.findUnique({
        where: {
          patientNumber,
        },
      });

      if (existingPatient) {
        return res.status(409).render("admin-patient-add", {
          title: "患者登録",
          error: "この患者番号はすでに登録されています。",
          patientNumber,
          name,
          birthYear: year,
          birthMonth,
          birthDay,
          isAdminPage: true,
          isAdminLoggedIn: true,
        });
      }

      const patient = await prisma.patient.create({
        data: {
          patientNumber,
          name,
          birthDate,
        },
      });

      await createAuditLog("患者登録", `患者番号:${patientNumber}`, name);

      const today = new Date().toLocaleDateString("sv-SE", {
        timeZone: "Asia/Tokyo",
      });

      const reservation = await prisma.reservation.findFirst({
        where: {
          patientNumber,
          date: {
            gte: today,
          },
        },
        include: {
          doctor: true,
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

      return res.render("patient-add-complete", {
        title: "患者登録完了",
        patient,
        reservation,
        isAdminPage: true,
        isAdminLoggedIn: true,
      });
    } catch (error) {
      console.error("患者登録エラー:", error);

      return res.status(500).render("error", {
        title: "患者登録エラー",
        heading: "患者情報を登録できませんでした",
        message: "患者登録中にエラーが発生しました。もう一度お試しください。",
        detail: "",
        backUrl: "/admin/patients/add",
      });
    }
  });

  app.get("/admin/patients/edit/:id", requireAdminLogin, async (req, res) => {
    try {
      const id = Number(req.params.id);

      const keyword = String(req.query.keyword || "").trim();

      if (!Number.isInteger(id) || id <= 0) {
        return res.redirect(
          `/admin/patients?keyword=${encodeURIComponent(keyword)}`,
        );
      }

      const patient = await prisma.patient.findUnique({
        where: {
          id,
        },
      });

      if (!patient) {
        return res.render("error", {
          title: "患者編集",
          heading: "患者が見つかりません",
          message: "選択された患者情報が見つかりませんでした。",
          detail: "",
          backUrl: `/admin/patients?keyword=${encodeURIComponent(keyword)}`,

          isAdminPage: true,
          isAdminLoggedIn: true,
        });
      }

      const birth = patient.birthDate
        ? new Date(patient.birthDate)
        : new Date();

      return res.render("admin-patient-edit", {
        title: "患者編集",

        patient,

        birthYear: birth.getUTCFullYear(),
        birthMonth: birth.getUTCMonth() + 1,
        birthDay: birth.getUTCDate(),

        currentYear: new Date().getFullYear(),

        keyword,

        error: null,

        isAdminPage: true,
        isAdminLoggedIn: true,
      });
    } catch (error) {
      console.error("患者編集画面表示エラー:", error);

      return res.status(500).render("error", {
        title: "患者編集",
        heading: "患者情報を表示できませんでした",
        message: "時間をおいて、もう一度お試しください。",
        detail: "",
        backUrl: "/admin/patients",

        isAdminPage: true,
        isAdminLoggedIn: true,
      });
    }
  });

  app.post("/admin/patients/edit/:id", requireAdminLogin, async (req, res) => {
    try {
      const id = Number(req.params.id);

      const keyword = String(req.body.keyword || "").trim();

      const patientNumber = String(req.body.patientNumber || "").trim();

      const name = String(req.body.name || "").trim();

      const year = String(req.body.birthYear || "");
      const month = String(req.body.birthMonth || "").padStart(2, "0");
      const day = String(req.body.birthDay || "").padStart(2, "0");

      const birthDateText = `${year}-${month}-${day}`;
      const birthDate = new Date(`${birthDateText}T00:00:00.000Z`);

      const patient = await prisma.patient.findUnique({
        where: {
          id,
        },
      });

      if (!patient) {
        return res.render("error", {
          title: "患者編集",
          heading: "患者が見つかりません",
          message: "選択された患者情報が見つかりませんでした。",
          detail: "",
          backUrl: `/admin/patients?keyword=${encodeURIComponent(keyword)}`,

          isAdminPage: true,
          isAdminLoggedIn: true,
        });
      }

      const yearNumber = Number(year);
      const monthNumber = Number(month);
      const dayNumber = Number(day);

      const isValidBirthDate =
        !Number.isNaN(birthDate.getTime()) &&
        birthDate.getUTCFullYear() === yearNumber &&
        birthDate.getUTCMonth() + 1 === monthNumber &&
        birthDate.getUTCDate() === dayNumber;

      if (
        !isValidPatientNumber(patientNumber) ||
        !name ||
        !/^\d{4}$/.test(year) ||
        !/^\d{2}$/.test(month) ||
        !/^\d{2}$/.test(day) ||
        !isValidBirthDate
      ) {
        return res.render("admin-patient-edit", {
          title: "患者編集",

          patient: {
            ...patient,
            patientNumber,
            name,
          },

          birthYear: yearNumber || new Date(patient.birthDate).getUTCFullYear(),

          birthMonth:
            monthNumber || new Date(patient.birthDate).getUTCMonth() + 1,

          birthDay: dayNumber || new Date(patient.birthDate).getUTCDate(),

          currentYear: new Date().getFullYear(),

          keyword,

          error: "患者番号・氏名・生年月日を正しく入力してください。",

          isAdminPage: true,
          isAdminLoggedIn: true,
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
        return res.render("admin-patient-edit", {
          title: "患者編集",

          patient: {
            ...patient,
            patientNumber,
            name,
          },

          birthYear: yearNumber,
          birthMonth: monthNumber,
          birthDay: dayNumber,

          currentYear: new Date().getFullYear(),

          keyword,

          error: "この患者番号はすでに使われています。",

          isAdminPage: true,
          isAdminLoggedIn: true,
        });
      }

      return res.render("admin-patient-edit-confirm", {
        title: "患者編集確認",

        patient,

        newPatient: {
          id,
          patientNumber,
          name,
          birthDateText,
        },

        keyword,

        isAdminPage: true,
        isAdminLoggedIn: true,
      });
    } catch (error) {
      console.error("患者編集確認エラー:", error);

      return res.status(500).render("error", {
        title: "患者編集",
        heading: "患者情報を確認できませんでした",
        message: "時間をおいて、もう一度お試しください。",
        detail: "",
        backUrl: "/admin/patients",

        isAdminPage: true,
        isAdminLoggedIn: true,
      });
    }
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

  app.get("/admin/patients/:id", requireAdminLogin, async (req, res) => {
    try {
      const patientId = Number(req.params.id);

      if (!Number.isInteger(patientId) || patientId <= 0) {
        return res.status(400).render("error", {
          title: "患者情報エラー",
          heading: "患者情報を表示できません",
          message: "患者情報が正しく指定されていません。",
          detail: "",
          backUrl: "/admin/patients",

          isAdminPage: true,
          isAdminLoggedIn: true,
        });
      }

      const patient = await prisma.patient.findUnique({
        where: {
          id: patientId,
        },
      });

      if (!patient) {
        return res.status(404).render("error", {
          title: "患者情報エラー",
          heading: "患者が見つかりません",
          message: "指定された患者情報は存在しません。",
          detail: "",
          backUrl: "/admin/patients",

          isAdminPage: true,
          isAdminLoggedIn: true,
        });
      }

      const allReservations = await prisma.reservation.findMany({
        where: {
          patientNumber: patient.patientNumber,
        },

        include: {
          doctor: true,
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

      const reservation = getCurrentReservation(allReservations);

      const pastReservations = allReservations
        .filter((reservationItem) => {
          return isPastReservationSlot(
            reservationItem.date,
            reservationItem.slot,
          );
        })
        .sort((a, b) => {
          const dateCompare = String(b.date).localeCompare(String(a.date));

          if (dateCompare !== 0) {
            return dateCompare;
          }

          return String(b.slot).localeCompare(String(a.slot));
        });

      return res.render("admin-patient-detail", {
        title: "患者詳細",

        patient,
        reservation,
        pastReservations,

        keyword: String(req.query.keyword || ""),

        isAdminPage: true,
        isAdminLoggedIn: true,
      });
    } catch (error) {
      console.error("患者詳細表示エラー:", error);

      return res.status(500).render("error", {
        title: "患者情報エラー",
        heading: "患者情報を表示できません",
        message: "患者情報の読み込み中にエラーが発生しました。",
        detail: "",
        backUrl: "/admin/patients",

        isAdminPage: true,
        isAdminLoggedIn: true,
      });
    }
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
      heading: "予約をキャンセルしました",
      message: "以下の内容をキャンセルしました。",

      reservation: {
        id: reservation.id,
        date: reservation.date,
        slot: reservation.slot,
        doctorId: reservation.doctorId,

        doctor: reservation.doctor,

        patient: {
          patientNumber: reservation.patient.patientNumber,
          name: reservation.patient.name,
        },
      },

      reservationTableTitle: "キャンセルした予約内容",

      isAdminPage: true,
      isAdminLoggedIn: true,
    });
  });

  app.post("/admin/change-doctor/continue", requireAdminLogin, (req, res) => {
    req.session.doctorId = Number(req.body.doctorId);

    return req.session.save(() => {
      return res.redirect(
        "/admin/reservations?week=0&editReservationId=" +
          encodeURIComponent(req.body.editReservationId),
      );
    });
  });

  /* =========================
   404エラー
========================= */
};
