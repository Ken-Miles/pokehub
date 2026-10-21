-- AlterTable
ALTER TABLE "users" ADD COLUMN     "isTester" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "drop_files" (
    "id" TEXT NOT NULL,
    "uploaderId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "note" TEXT,
    "readable" BOOLEAN NOT NULL,
    "parseError" TEXT,
    "generation" INTEGER,
    "gameVersion" TEXT,
    "trainerName" TEXT,
    "trainerId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drop_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "drop_files_storageKey_key" ON "drop_files"("storageKey");

-- CreateIndex
CREATE INDEX "drop_files_uploaderId_createdAt_idx" ON "drop_files"("uploaderId", "createdAt");

-- CreateIndex
CREATE INDEX "drop_files_createdAt_idx" ON "drop_files"("createdAt");

-- AddForeignKey
ALTER TABLE "drop_files" ADD CONSTRAINT "drop_files_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
