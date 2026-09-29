-- CreateEnum
CREATE TYPE "PolicyCategory" AS ENUM ('LEAVE', 'ATTENDANCE', 'CONDUCT', 'ONBOARDING', 'BENEFITS', 'PAYROLL', 'IT_SECURITY', 'OTHER');

-- CreateTable
CREATE TABLE "PolicyDocument" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "category" "PolicyCategory" NOT NULL,
    "version" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "summary" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "publishedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PolicyDocument_storageKey_key" ON "PolicyDocument"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyDocument_title_version_key" ON "PolicyDocument"("title", "version");

-- AddForeignKey
ALTER TABLE "PolicyDocument" ADD CONSTRAINT "PolicyDocument_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
