-- CreateEnum
CREATE TYPE "OnboardingTaskStatus" AS ENUM ('PENDING', 'DONE', 'SKIPPED');

-- CreateEnum
CREATE TYPE "OnboardingCategory" AS ENUM ('PAPERWORK', 'DOCUMENTS', 'IT_SETUP', 'ORIENTATION', 'TEAM');

-- CreateEnum
CREATE TYPE "OnboardingAssignee" AS ENUM ('HR', 'MANAGER', 'EMPLOYEE', 'IT');

-- CreateTable
CREATE TABLE "OnboardingTemplateTask" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" "OnboardingCategory" NOT NULL,
    "assignee" "OnboardingAssignee" NOT NULL,
    "dueOffsetDays" INTEGER NOT NULL,
    "departmentId" UUID,
    "requiredDocumentType" "DocumentType",
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OnboardingTemplateTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnboardingTask" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "templateTaskId" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" "OnboardingCategory" NOT NULL,
    "assignee" "OnboardingAssignee" NOT NULL,
    "dueDate" DATE NOT NULL,
    "status" "OnboardingTaskStatus" NOT NULL DEFAULT 'PENDING',
    "requiredDocumentType" "DocumentType",
    "sortOrder" INTEGER NOT NULL,
    "completedAt" TIMESTAMP(3),
    "completedById" UUID,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OnboardingTask_employeeId_idx" ON "OnboardingTask"("employeeId");

-- AddForeignKey
ALTER TABLE "OnboardingTemplateTask" ADD CONSTRAINT "OnboardingTemplateTask_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingTask" ADD CONSTRAINT "OnboardingTask_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingTask" ADD CONSTRAINT "OnboardingTask_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
