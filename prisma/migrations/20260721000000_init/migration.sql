-- CreateEnum
CREATE TYPE "CreditbackCountry" AS ENUM ('GB', 'US', 'CA', 'FR', 'IE');

-- CreateEnum
CREATE TYPE "CreditbackClaimStatus" AS ENUM ('NEW', 'CREDITED', 'REJECTED');

-- CreateTable
CREATE TABLE "creditback_claims" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "countryCode" "CreditbackCountry" NOT NULL,
    "email" TEXT NOT NULL,
    "transactionValue" DECIMAL(12,2) NOT NULL,
    "transactionCurrency" TEXT NOT NULL,
    "transactionId" TEXT,
    "locale" TEXT,
    "status" "CreditbackClaimStatus" NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creditback_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "creditback_claims_email_idx" ON "creditback_claims"("email");

-- CreateIndex
CREATE INDEX "creditback_claims_status_idx" ON "creditback_claims"("status");
