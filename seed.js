const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  await prisma.patient.createMany({
  data: [
    { patientNumber: "10001", name: "山田 太郎" },
    { patientNumber: "10002", name: "佐藤 花子" },
    { patientNumber: "10003", name: "田中 一郎" },
  ]
});

  console.log("患者データを登録しました");
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });