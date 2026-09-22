-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('NEW', 'SHORTLISTED', 'REJECTED', 'HIRED');

-- CreateTable
CREATE TABLE "job_postings" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "employmentType" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'OPEN',
    "createdByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_postings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_applications" (
    "id" TEXT NOT NULL,
    "jobPostingId" TEXT,
    "jobTitleSnapshot" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "linkedin" TEXT,
    "portfolio" TEXT,
    "currentTitle" TEXT,
    "yearsExperience" TEXT NOT NULL,
    "preferredLocation" TEXT NOT NULL,
    "workPreference" TEXT NOT NULL,
    "rightToWork" TEXT NOT NULL,
    "whyJoin" TEXT NOT NULL,
    "cvKey" TEXT NOT NULL,
    "cvOriginalFilename" TEXT NOT NULL,
    "cvContentType" TEXT NOT NULL,
    "cvSizeBytes" INTEGER NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'NEW',
    "rejectionSentAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_postings_slug_key" ON "job_postings"("slug");

-- CreateIndex
CREATE INDEX "job_postings_status_idx" ON "job_postings"("status");

-- CreateIndex
CREATE INDEX "job_applications_jobPostingId_idx" ON "job_applications"("jobPostingId");

-- CreateIndex
CREATE INDEX "job_applications_status_idx" ON "job_applications"("status");

-- CreateIndex
CREATE INDEX "job_applications_submittedAt_idx" ON "job_applications"("submittedAt");

-- AddForeignKey
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_jobPostingId_fkey" FOREIGN KEY ("jobPostingId") REFERENCES "job_postings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
