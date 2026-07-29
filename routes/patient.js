module.exports = function registerPatientRoutes(app, context) {
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

  app.get("/health", (req, res) => {
    res.status(200).json({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/", (req, res) => {
    res.redirect("/psychiatry");
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

    return res.render("verify", {
      title: "予約情報の確認",
      error: null,
    });
  });

  app.get("/phone-reservation", (req, res) => {
    const clinicPhone = String(process.env.CLINIC_PHONE || "").trim();

    return res.render("phone-reservation", {
      title: "お電話でのご予約",
      heading: "患者番号が分からない方へ",
      message:
        "患者番号を確認できない場合は、お手数ですがお電話にてご予約ください。",
      clinicPhone,
    });
  });

  app.post("/verify", patientVerifyLimiter, async (req, res) => {
    try {
      const patientNumber = String(req.body.patientNumber || "").trim();
      const birthYear = String(req.body.birthYear || "").trim();
      const birthMonth = String(req.body.birthMonth || "").trim();
      const birthDay = String(req.body.birthDay || "").trim();

      if (
        !isValidPatientNumber(patientNumber) ||
        !/^\d{4}$/.test(birthYear) ||
        !/^\d{1,2}$/.test(birthMonth) ||
        !/^\d{1,2}$/.test(birthDay)
      ) {
        return res.status(400).render("verify", {
          title: "予約情報の確認",
          error: "患者番号と生年月日を正しく入力してください。",
        });
      }

      const year = Number(birthYear);
      const month = Number(birthMonth);
      const day = Number(birthDay);
      const inputDate = new Date(Date.UTC(year, month - 1, day));

      const isValidBirthDate =
        inputDate.getUTCFullYear() === year &&
        inputDate.getUTCMonth() + 1 === month &&
        inputDate.getUTCDate() === day;

      if (!isValidBirthDate) {
        return res.status(400).render("verify", {
          title: "予約情報の確認",
          error: "生年月日を正しく入力してください。",
        });
      }

      const patient = await prisma.patient.findUnique({
        where: { patientNumber },
      });

      let isVerified = false;

      if (patient && patient.birthDate) {
        const registeredDate = new Date(patient.birthDate);

        isVerified =
          registeredDate.getUTCFullYear() === year &&
          registeredDate.getUTCMonth() + 1 === month &&
          registeredDate.getUTCDate() === day;
      }

      if (isVerified) {
        return req.session.regenerate((regenerateError) => {
          if (regenerateError) {
            console.error(
              "患者予約情報確認時のセッション再生成エラー:",
              regenerateError,
            );

            return res.status(500).render("error", {
              title: "予約情報の確認エラー",
              heading: "予約情報を確認できませんでした",
              message: "時間をおいて、もう一度お試しください。",
              detail: "",
              backUrl: "/verify",
            });
          }

          req.session.patientNumber = patient.patientNumber;
          req.session.patientId = patient.id;
          req.session.verifyFailureCount = 0;
          req.session.changeReservationId = null;
          req.session.completeMessage = null;
          req.session.cookie.maxAge = 30 * 60 * 1000;

          return req.session.save((saveError) => {
            if (saveError) {
              console.error("患者セッション保存エラー:", saveError);

              return res.status(500).render("error", {
                title: "予約情報の確認エラー",
                heading: "予約情報を確認できませんでした",
                message: "時間をおいて、もう一度お試しください。",
                detail: "",
                backUrl: "/verify",
              });
            }

            return res.redirect("/mypage");
          });
        });
      }

      const failureCount = Number(req.session.verifyFailureCount || 0) + 1;
      req.session.verifyFailureCount = failureCount;

      if (failureCount >= 2) {
        req.session.verifyFailureCount = 2;

        const clinicPhone = String(process.env.CLINIC_PHONE || "").trim();

        return req.session.save((saveError) => {
          if (saveError) {
            console.error("予約情報確認失敗回数保存エラー:", saveError);
          }

          return res.status(403).render("phone-reservation", {
            title: "お電話でのご予約",
            heading: "入力内容を確認できませんでした",
            message:
              "入力内容を患者データと照合できませんでした。お手数ですが、お電話にてご予約ください。",
            clinicPhone,
          });
        });
      }

      return req.session.save((saveError) => {
        if (saveError) {
          console.error("予約情報確認失敗回数保存エラー:", saveError);
        }

        return res.status(401).render("verify", {
          title: "予約情報の確認",
          error:
            "患者データを確認できませんでした。患者番号と生年月日をご確認のうえ、もう一度お試しください。",
        });
      });
    } catch (error) {
      console.error("予約情報確認エラー:", error);

      return res.status(500).render("error", {
        title: "予約情報の確認エラー",
        heading: "予約情報を確認できませんでした",
        message: "時間をおいて、もう一度お試しください。",
        detail:
          process.env.NODE_ENV === "production"
            ? ""
            : String(error.message || error),
        backUrl: "/verify",
      });
    }
  });

  app.get("/logout", (req, res) => {
    if (!req.session.patientNumber) {
      return res.redirect("/psychiatry");
    }

    return res.render("logout-confirm", {
      title: "ログアウト確認",
    });
  });

  app.post("/logout", (req, res) => {
    req.session.destroy((destroyError) => {
      if (destroyError) {
        console.error("患者ログアウトエラー:", destroyError);

        return res.status(500).render("error", {
          title: "ログアウトエラー",
          heading: "ログアウトできませんでした",
          message: "時間をおいて、もう一度お試しください。",
          detail: "",
          backUrl: "/mypage",
        });
      }

      res.clearCookie("clinic.sid", {
        path: "/",
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
      });

      return res.redirect("/psychiatry");
    });
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
    try {
      const patientNumber = req.session.patientNumber;

      if (!patientNumber) {
        return res.redirect("/psychiatry");
      }

      const today = new Date().toLocaleDateString("sv-SE", {
        timeZone: "Asia/Tokyo",
      });

      const patient = await prisma.patient.findUnique({
        where: {
          patientNumber,
        },
      });

      if (!patient) {
        req.session.patientNumber = null;
        req.session.changeReservationId = null;

        return res.redirect("/psychiatry");
      }

      const reservationCandidates = await prisma.reservation.findMany({
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

      const reservation = getCurrentReservation(reservationCandidates);

      if (!reservation) {
        req.session.changeReservationId = null;
      }
      const canModifyReservation = reservation
        ? canCancelReservation(reservation.date)
        : false;

      return res.render("mypage", {
        title: "マイページ",
        isPatientLoggedIn: true,

        patient,
        reservation,
        canModifyReservation,
      });
    } catch (error) {
      console.error("マイページ表示エラー:", error);

      return res.status(500).render("error", {
        title: "マイページ",
        heading: "予約情報を取得できませんでした",
        message: "時間をおいて、もう一度お試しください。",
        detail: "",
        backUrl: "/psychiatry",
        isAdminPage: false,
        isAdminLoggedIn: false,
        isPatientLoggedIn: true,
      });
    }
  });

  app.get("/select-doctor", async (req, res) => {
    try {
      if (!req.session.patientNumber) {
        return res.redirect("/verify");
      }

      const doctors = await prisma.doctor.findMany({
        where: {
          isActive: true,
        },
        orderBy: {
          id: "asc",
        },
      });

      return res.render("select-doctor", {
        title: "担当医を選択",
        doctors,
        isChangeMode: Boolean(req.session.changeReservationId),
      });
    } catch (error) {
      console.error("担当医選択画面表示エラー:", error);

      return res.status(500).render("error", {
        title: "担当医選択",
        heading: "担当医を表示できませんでした",
        message: "時間をおいて、もう一度お試しください。",
        detail: "",
        backUrl: "/mypage",
      });
    }
  });

  /*
   * 新規予約の入口です。
   * ログイン済みの患者だけが予約画面へ進めます。
   */
  app.get("/new", (req, res) => {
    if (!req.session.patientNumber) {
      return res.redirect("/verify");
    }

    req.session.changeReservationId = null;
    req.session.completeMessage = null;

    return res.redirect("/select-doctor");
  });

  app.get("/api/slots", (req, res) => {
    const date = String(req.query.date || "");
    const doctorId = Number(req.query.doctorId);

    if (!isValidDateText(date) || !isValidDoctorId(doctorId)) {
      return res.status(400).json([]);
    }

    const slots = config.getSlotsForDate(date, doctorId);

    return res.json(slots);
  });

  app.get("/api/admin/slots", requireAdminLogin, async (req, res) => {
    try {
      const sessionDoctorId = Number(req.session.doctorId);
      const requestedDoctorId = Number(req.query.doctorId);

      const doctorId = isValidDoctorId(sessionDoctorId)
        ? sessionDoctorId
        : requestedDoctorId;

      const date = String(req.query.date || "");
      const excludeReservationId = Number(req.query.excludeReservationId);

      if (!isValidDoctorId(doctorId) || !isValidDateText(date)) {
        return res.status(400).json({
          slots: [],
        });
      }

      const doctor = await prisma.doctor.findFirst({
        where: {
          id: doctorId,
          isActive: true,
        },
      });

      if (!doctor) {
        return res.status(404).json({
          slots: [],
        });
      }

      const configuredSlots = config.getSlotsForDate(date, doctorId);
      const availableSlots = [];

      for (const slot of configuredSlots) {
        if (isPastReservationSlot(date, slot)) {
          continue;
        }

        const slotSetting = await getSlotSetting(date, slot, doctorId);

        if (!slotSetting.isOpen || slotSetting.capacity <= 0) {
          continue;
        }

        const count = await prisma.reservation.count({
          where: {
            doctorId,
            date,
            slot,

            ...(Number.isInteger(excludeReservationId) &&
            excludeReservationId > 0
              ? {
                  id: {
                    not: excludeReservationId,
                  },
                }
              : {}),
          },
        });

        if (count >= slotSetting.capacity) {
          continue;
        }

        availableSlots.push({
          value: slot,
          label: config.getSlotLabel(slot, doctorId),
        });
      }

      return res.json({
        slots: availableSlots,
      });
    } catch (error) {
      console.error("管理画面予約枠取得エラー:", error);

      return res.status(500).json({
        slots: [],
      });
    }
  });

  app.get("/change", async (req, res) => {
    try {
      const patientNumber = req.session.patientNumber;

      if (!patientNumber) {
        return res.redirect("/psychiatry");
      }

      const reservationCandidates = await prisma.reservation.findMany({
        where: {
          patientNumber,

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
      });

      const reservation = getCurrentReservation(reservationCandidates);

      if (!reservation) {
        req.session.changeReservationId = null;

        return res.redirect("/mypage");
      }

      /*
       * キャンセルと同じ期限を予約変更にも適用します。
       * 予約日前日の23時59分を過ぎると変更できません。
       */
      if (!canCancelReservation(reservation.date)) {
        req.session.changeReservationId = null;

        return res.status(400).render("error", {
          title: "予約変更不可",
          heading: "予約を変更できません",
          message: "予約変更の受付期限を過ぎています。",
          detail:
            "当日の予約変更はできません。必要な場合は医院へ直接ご連絡ください。",
          backUrl: "/mypage",

          isAdminPage: false,
          isAdminLoggedIn: false,
          isPatientLoggedIn: true,
        });
      }

      req.session.changeReservationId = reservation.id;

      return req.session.save((saveError) => {
        if (saveError) {
          console.error("予約変更情報保存エラー:", saveError);

          return res.status(500).render("error", {
            title: "予約変更エラー",
            heading: "予約変更を開始できませんでした",
            message: "時間をおいて、もう一度お試しください。",
            detail: "",
            backUrl: "/mypage",

            isAdminPage: false,
            isAdminLoggedIn: false,
            isPatientLoggedIn: true,
          });
        }

        return res.redirect("/select-doctor");
      });
    } catch (error) {
      console.error("患者予約変更開始エラー:", error);

      return res.status(500).render("error", {
        title: "予約変更エラー",
        heading: "予約変更を開始できませんでした",
        message: "時間をおいて、もう一度お試しください。",
        detail: "",
        backUrl: "/mypage",

        isAdminPage: false,
        isAdminLoggedIn: false,
        isPatientLoggedIn: true,
      });
    }
  });

  app.get("/terms", (req, res) => {
    res.render("terms", {
      title: "利用規約",
    });
  });

  app.get("/privacy", (req, res) => {
    res.render("privacy", {
      title: "プライバシーポリシー",
    });
  });

  app.get("/reserve", async (req, res) => {
    try {
      const patientNumber = req.session.patientNumber;
      const doctorId = Number(req.query.doctorId);
      const week = getWeekParam(req.query.week);

      if (!patientNumber) {
        return res.redirect("/verify");
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

      maxReservableDate.setDate(
        maxReservableDate.getDate() + config.RESERVATION_DAYS,
      );

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
          label:
            `${date.getMonth() + 1}/` +
            `${date.getDate()}` +
            `（${weekdays[date.getDay()]}）`,
          weekday: date.getDay(),
        });
      }

      const startDate = dates[0].value;
      const endDate = dates[dates.length - 1].value;

      const slots = config.getDisplaySlots(doctorId);

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
              isOpen: setting.isOpen,
              isOverride: setting.isOverride,
              capacity: setting.capacity,
            };
          });
        }),
      );
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
        slots,
        slotSettings,

        today,
        maxReservableText,
        canGoNextWeek,

        holidays: config.holidays,
        getSlotLabel: config.getSlotLabel,
        isPastReservationSlot,

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
    try {
      const patientNumber = req.session.patientNumber;
      const doctorId = Number(req.query.doctorId);
      const date = String(req.query.date || "");
      const slot = String(req.query.slot || "");

      if (!patientNumber) {
        return res.redirect("/verify");
      }

      if (
        !isValidDoctorId(doctorId) ||
        !isValidDateText(date) ||
        !isValidSlot(slot, doctorId) ||
        !isWithinReservationPeriod(date) ||
        isPastReservationSlot(date, slot)
      ) {
        return res.status(400).render("error", {
          title: "予約不可",
          heading: "予約内容を確認できませんでした",
          message: "選択された予約日時が無効です。",
          detail: "",
          backUrl: `/reserve?doctorId=${doctorId}`,
        });
      }

      const availableSlots = config.getSlotsForDate(date, doctorId);

      if (!availableSlots.includes(slot)) {
        return res.status(400).render("error", {
          title: "予約不可",
          heading: "予約できない時間です",
          message: "選択された時間は診療時間外です。",
          detail: "",
          backUrl: `/reserve?doctorId=${doctorId}`,
        });
      }

      const slotSetting = await getSlotSetting(date, slot, doctorId);

      if (!slotSetting.isOpen || slotSetting.capacity <= 0) {
        return res.status(400).render("error", {
          title: "予約不可",
          heading: "予約できない時間です",
          message: "選択された時間は現在予約を受け付けていません。",
          detail: "",
          backUrl: `/reserve?doctorId=${doctorId}`,
        });
      }

      const currentReservationId = Number(req.session.changeReservationId);

      const reservationCount = await prisma.reservation.count({
        where: {
          doctorId,
          date,
          slot,

          ...(Number.isInteger(currentReservationId) && currentReservationId > 0
            ? {
                id: {
                  not: currentReservationId,
                },
              }
            : {}),
        },
      });

      if (reservationCount >= slotSetting.capacity) {
        return res.status(409).render("error", {
          title: "予約不可",
          heading: "選択された予約枠は満員です",
          message: "ほかの方の予約により、選択された時間が満員になりました。",
          detail: "別の日時を選択してください。",
          backUrl: `/reserve?doctorId=${doctorId}`,
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
        return res.redirect("/select-doctor");
      }

      if (!patient) {
        req.session.patientNumber = null;
        req.session.patientId = null;

        return res.redirect("/verify");
      }

      return res.render("confirm", {
        title: req.session.changeReservationId ? "予約変更確認" : "予約確認",

        patient,
        date,
        doctor,
        doctorId,
        slot,

        isChangeMode: Boolean(req.session.changeReservationId),

        clinicPhone: String(process.env.CLINIC_PHONE || "").trim(),
      });
    } catch (error) {
      console.error("予約確認画面表示エラー:", error);

      return res.status(500).render("error", {
        title: "予約確認エラー",
        heading: "予約内容を確認できませんでした",
        message: "時間をおいて、もう一度お試しください。",
        detail: "",
        backUrl: "/select-doctor",
      });
    }
  });

  app.post("/reserve", async (req, res) => {
    const patientNumber = req.session.patientNumber;
    const doctorId = Number(req.body.doctorId);
    const date = String(req.body.date || "");
    const slot = String(req.body.slot || "");
    const changeReservationId = Number(req.session.changeReservationId);

    const agreed = req.body.agreed === "true";

    if (!patientNumber) {
      return res.redirect("/verify");
    }

    if (!agreed) {
      return res.status(400).render("error", {
        title: "予約確認",
        heading: "同意が必要です",
        message:
          "予約を確定するには、利用規約およびプライバシーポリシーへの同意が必要です。",
        detail: "",
        backUrl: "javascript:history.back()",
      });
    }

    if (
      !isValidDoctorId(doctorId) ||
      !isValidPatientNumber(patientNumber) ||
      !isValidDateText(date) ||
      !isValidSlot(slot, doctorId) ||
      !isWithinReservationPeriod(date) ||
      isPastReservationSlot(date, slot)
    ) {
      return res.status(400).render("error", {
        title: "予約不可",
        heading: "予約不可",
        message: "予約内容が不正です。",
        detail: "",
        backUrl: `/reserve?doctorId=${doctorId}`,
      });
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

    const availableSlots = config.getSlotsForDate(date, doctorId);

    if (!availableSlots.includes(slot)) {
      return res.status(400).render("error", {
        title: "予約不可",
        heading: "予約不可",
        message: "その時間は診療時間外です。",
        detail: "",
        backUrl: `/reserve?doctorId=${doctorId}`,
      });
    }

    const patient = await prisma.patient.findUnique({
      where: {
        patientNumber,
      },
    });

    if (!patient) {
      req.session.patientNumber = null;
      req.session.patientId = null;

      return res.redirect("/psychiatry");
    }

    let reservationCode = null;

    try {
      await prisma.$transaction(
        async (tx) => {
          const slotSetting = await getSlotSetting(date, slot, doctorId, tx);

          const count = await tx.reservation.count({
            where: {
              date,
              slot,
              doctorId,

              ...(Number.isInteger(changeReservationId) &&
              changeReservationId > 0
                ? {
                    id: {
                      not: changeReservationId,
                    },
                  }
                : {}),
            },
          });

          if (
            !slotSetting.isOpen ||
            slotSetting.capacity <= 0 ||
            count >= slotSetting.capacity
          ) {
            throw new Error("FULL");
          }

          if (
            Number.isInteger(changeReservationId) &&
            changeReservationId > 0
          ) {
            const currentReservation = await tx.reservation.findUnique({
              where: {
                id: changeReservationId,
              },
            });

            if (
              !currentReservation ||
              currentReservation.patientNumber !== patientNumber
            ) {
              throw new Error("NOT_FOUND");
            }

            if (!canCancelReservation(currentReservation.date)) {
              throw new Error("CHANGE_DEADLINE");
            }

            await tx.reservation.update({
              where: {
                id: changeReservationId,
              },
              data: {
                date,
                slot,
                doctorId,
              },
            });

            return;
          }

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
      if (error.message === "FULL") {
        return res.status(409).render("error", {
          title: "予約不可",
          heading: "選択された予約枠は満員です",
          message: "ほかの方の予約により、選択された時間が満員になりました。",
          detail: "別の日時を選択してください。",
          backUrl: `/reserve?doctorId=${doctorId}`,
        });
      }

      if (error.message === "NOT_FOUND") {
        req.session.changeReservationId = null;

        return res.redirect("/mypage");
      }

      if (error.message === "CHANGE_DEADLINE") {
        req.session.changeReservationId = null;

        return res.status(400).render("error", {
          title: "予約変更不可",
          heading: "予約を変更できません",
          message: "予約変更の受付期限を過ぎています。",
          detail:
            "当日の予約変更はできません。必要な場合は医院へ直接ご連絡ください。",
          backUrl: "/mypage",
          isPatientLoggedIn: true,
        });
      }

      if (
        typeof error.message === "string" &&
        error.message.startsWith("DUPLICATE:")
      ) {
        return res.status(409).render("error", {
          title: "予約不可",
          heading: "すでに予約があります",
          message:
            "現在の予約を変更またはキャンセルしてから、新しい予約をお取りください。",
          detail: `既存予約：${error.message.replace("DUPLICATE:", "")}`,
          backUrl: "/mypage",
        });
      }

      console.error("患者予約確定エラー:", error);

      return res.status(500).render("error", {
        title: "予約不可",
        heading: "予約を確定できませんでした",
        message:
          "予約処理中にエラーが発生しました。時間をおいて、もう一度お試しください。",
        detail: "",
        backUrl: `/reserve?doctorId=${doctorId}`,
      });
    }

    await createAuditLog(
      Number.isInteger(changeReservationId) && changeReservationId > 0
        ? "患者予約変更"
        : "患者予約",
      `患者番号:${patientNumber}`,
      `${date} ${slot} / 医師ID:${doctorId}`,
    );

    const isChangeMode =
      Number.isInteger(changeReservationId) && changeReservationId > 0;

    req.session.changeReservationId = null;

    req.session.completeMessage = {
      title: isChangeMode ? "予約変更完了" : "予約完了",

      heading: isChangeMode ? "予約を変更しました" : "予約が完了しました",

      message: isChangeMode
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

      showProgress: false,
      backUrl: "/mypage",
      backLabel: "マイページへ戻る",
    };

    return req.session.save((saveError) => {
      if (saveError) {
        console.error("予約完了情報保存エラー:", saveError);

        return res.status(500).render("error", {
          title: "予約完了",
          heading: "予約は完了しました",
          message: "予約は登録されましたが、完了画面を表示できませんでした。",
          detail: "",
          backUrl: "/mypage",
        });
      }

      return res.redirect("/complete");
    });
  });
  app.post("/cancel", async (req, res) => {
    const patientNumber = req.session.patientNumber;
    const id = Number(req.body.id);

    if (!patientNumber) {
      return res.redirect("/psychiatry");
    }

    if (!Number.isInteger(id) || id <= 0) {
      return res.redirect("/mypage");
    }

    const reservation = await prisma.reservation.findFirst({
      where: {
        id,
        patientNumber,
      },
      include: {
        patient: true,
        doctor: true,
      },
    });

    if (!reservation) {
      return res.status(404).render("error", {
        title: "エラー",
        heading: "予約が見つかりません",
        message: "この予約は存在しないか、操作する権限がありません。",
        detail: "",
        backUrl: "/mypage",
        isPatientLoggedIn: true,
      });
    }

    if (!canCancelReservation(reservation.date)) {
      return res.status(400).render("error", {
        title: "キャンセル不可",
        heading: "キャンセル期限を過ぎています",
        message: "予約のキャンセルは、予約日前日の23時59分までです。",
        detail: "キャンセルが必要な場合は、医院へ直接ご連絡ください。",
        backUrl: "/mypage",
        isPatientLoggedIn: true,
      });
    }

    return res.render("cancel-confirm", {
      title: "予約キャンセル確認",
      reservation,
      from: "patient",
      isPatientLoggedIn: true,
    });
  });

  app.post("/cancel-confirm", async (req, res) => {
    const patientNumber = req.session.patientNumber;
    const id = Number(req.body.id);

    if (!patientNumber) {
      return res.redirect("/psychiatry");
    }

    if (!Number.isInteger(id) || id <= 0) {
      return res.redirect("/mypage");
    }

    const reservation = await prisma.reservation.findFirst({
      where: {
        id,
        patientNumber,
      },
      include: {
        patient: true,
        doctor: true,
      },
    });

    if (!reservation) {
      return res.status(404).render("error", {
        title: "エラー",
        heading: "予約が見つかりません",
        message: "この予約は存在しないか、操作する権限がありません。",
        detail: "",
        backUrl: "/mypage",
        isPatientLoggedIn: true,
      });
    }

    if (!canCancelReservation(reservation.date)) {
      return res.status(400).render("error", {
        title: "キャンセル不可",
        heading: "キャンセル期限を過ぎています",
        message: "予約のキャンセルは、予約日前日の23時59分までです。",
        detail: "キャンセルが必要な場合は、医院へ直接ご連絡ください。",
        backUrl: "/mypage",
        isPatientLoggedIn: true,
      });
    }

    try {
      await prisma.$transaction(
        async (tx) => {
          const currentReservation = await tx.reservation.findFirst({
            where: {
              id,
              patientNumber,
            },
          });

          if (!currentReservation) {
            throw new Error("NOT_FOUND");
          }

          if (!canCancelReservation(currentReservation.date)) {
            throw new Error("CANCEL_DEADLINE");
          }

          await tx.reservation.delete({
            where: {
              id: currentReservation.id,
            },
          });
        },
        {
          isolationLevel: "Serializable",
        },
      );
    } catch (error) {
      if (error.message === "NOT_FOUND") {
        return res.status(404).render("error", {
          title: "エラー",
          heading: "予約が見つかりません",
          message: "この予約はすでにキャンセルされた可能性があります。",
          detail: "",
          backUrl: "/mypage",
          isPatientLoggedIn: true,
        });
      }

      if (error.message === "CANCEL_DEADLINE") {
        return res.status(400).render("error", {
          title: "キャンセル不可",
          heading: "キャンセル期限を過ぎています",
          message: "予約のキャンセルは、予約日前日の23時59分までです。",
          detail: "キャンセルが必要な場合は、医院へ直接ご連絡ください。",
          backUrl: "/mypage",
          isPatientLoggedIn: true,
        });
      }

      console.error("患者予約キャンセルエラー:", error);

      return res.status(500).render("error", {
        title: "エラー",
        heading: "キャンセルできませんでした",
        message: "予約キャンセル処理中にエラーが発生しました。",
        detail: "",
        backUrl: "/mypage",
        isPatientLoggedIn: true,
      });
    }

    await createAuditLog(
      "患者予約キャンセル",
      `予約ID:${reservation.id}`,
      `患者番号:${patientNumber} / ${reservation.date} ${reservation.slot} / 医師ID:${reservation.doctorId}`,
    );

    req.session.changeReservationId = null;

    req.session.cancelComplete = {
      title: "予約キャンセル完了",
      heading: "予約をキャンセルしました",
      message: "予約のキャンセルが完了しました。",
      reservation,
      backUrl: "/mypage",
      backLabel: "マイページへ戻る",
      isPatientLoggedIn: true,
    };

    return req.session.save((saveError) => {
      if (saveError) {
        console.error("キャンセル完了情報保存エラー:", saveError);

        return res.status(500).render("error", {
          title: "キャンセル完了",
          heading: "予約はキャンセルされました",
          message:
            "予約はキャンセルされましたが、完了画面を表示できませんでした。",
          detail: "",
          backUrl: "/mypage",
          isPatientLoggedIn: true,
        });
      }

      return res.redirect("/cancel-complete");
    });
  });

  app.get("/cancel-complete", (req, res) => {
    const data = req.session.cancelComplete;

    if (!data) {
      return res.redirect("/mypage");
    }

    req.session.cancelComplete = null;

    return res.render("cancel-complete", data);
  });
};
