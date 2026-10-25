-- CreateTable
CREATE TABLE "ds_consoles" (
    "userId" TEXT NOT NULL,
    "wfcUserId" TEXT,
    "wifiSettings" BYTEA,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ds_consoles_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ds_consoles_wfcUserId_key" ON "ds_consoles"("wfcUserId");

-- AddForeignKey
ALTER TABLE "ds_consoles" ADD CONSTRAINT "ds_consoles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
