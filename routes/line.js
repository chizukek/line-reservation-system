module.exports = function registerLineRoutes(app, context) {
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
    createAuditLog
  } = context;

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

};
