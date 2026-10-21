-- AlterTable
ALTER TABLE "users" ADD COLUMN     "statusReason" TEXT,
ADD COLUMN     "suspendedUntil" TIMESTAMP(3);
