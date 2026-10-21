-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('GBA', 'NDS', 'N3DS');

-- AlterTable
ALTER TABLE "game_slots" ADD COLUMN     "platform" "Platform" NOT NULL DEFAULT 'GBA';
