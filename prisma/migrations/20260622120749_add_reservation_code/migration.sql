/*
  Warnings:

  - Added the required column `reservationCode` to the `Reservation` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Reservation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "patientNumber" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "reservationCode" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Reservation" ("createdAt", "date", "id", "patientNumber", "slot") SELECT "createdAt", "date", "id", "patientNumber", "slot" FROM "Reservation";
DROP TABLE "Reservation";
ALTER TABLE "new_Reservation" RENAME TO "Reservation";
CREATE UNIQUE INDEX "Reservation_reservationCode_key" ON "Reservation"("reservationCode");
CREATE UNIQUE INDEX "Reservation_date_slot_patientNumber_key" ON "Reservation"("date", "slot", "patientNumber");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
