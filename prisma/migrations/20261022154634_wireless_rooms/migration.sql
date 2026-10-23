-- AlterEnum
ALTER TYPE "LinkMode" ADD VALUE 'WIRELESS';

-- AlterTable
ALTER TABLE "link_seats" ADD COLUMN     "leftAt" TIMESTAMP(3);
