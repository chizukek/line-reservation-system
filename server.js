require("dotenv").config();

const { app, prisma, sessionPool } = require("./app");

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

async function shutdown(signal) {
  console.log(`${signal}を受信しました。終了処理を開始します。`);

  server.close(async () => {
    try {
      await prisma.$disconnect();
      await sessionPool.end();

      console.log("終了処理が完了しました。");
      process.exit(0);
    } catch (error) {
      console.error("終了処理エラー:", error);
      process.exit(1);
    }
  });

  setTimeout(() => {
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
