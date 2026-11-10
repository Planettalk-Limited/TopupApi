-- CreateEnum
CREATE TYPE "GiftEntitlementStatus" AS ENUM ('LINK_ISSUED', 'SUBMITTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GiftSubmissionStatus" AS ENUM ('SUBMITTED', 'PENDING_VALIDATION', 'APPROVED', 'REJECTED', 'RECIPIENT_CONTACTED', 'AWAITING_REDEMPTION', 'FULFILLED', 'SENDER_NOTIFIED', 'ESCALATED', 'CANCELLED');

-- CreateTable
CREATE TABLE "gift_campaign_entitlements" (
    "id" TEXT NOT NULL,
    "campaignKey" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenSalt" TEXT NOT NULL,
    "status" "GiftEntitlementStatus" NOT NULL DEFAULT 'LINK_ISSUED',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "linkDeliveryChannel" TEXT,
    "linkDeliveredAt" TIMESTAMP(3),
    "linkDeliveryError" TEXT,
    "firstOpenedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gift_campaign_entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_campaign_submissions" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "campaignKey" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "senderName" TEXT NOT NULL,
    "senderEmail" TEXT NOT NULL,
    "senderPhone" TEXT NOT NULL,
    "recipientName" TEXT NOT NULL,
    "recipientPhone" TEXT NOT NULL,
    "recipientEmail" TEXT,
    "relationship" TEXT,
    "preferredContact" TEXT,
    "declarationAcceptedAt" TIMESTAMP(3) NOT NULL,
    "termsVersion" TEXT NOT NULL,
    "termsAcceptedAt" TIMESTAMP(3) NOT NULL,
    "status" "GiftSubmissionStatus" NOT NULL DEFAULT 'SUBMITTED',
    "reasonCode" TEXT,
    "reasonNote" TEXT,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "eligibilityResult" TEXT NOT NULL,
    "assignedAdminId" TEXT,
    "voucherOrderId" TEXT,
    "voucherReference" TEXT,
    "voucherIssuedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "senderNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gift_campaign_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_campaign_events" (
    "id" TEXT NOT NULL,
    "entitlementId" TEXT,
    "submissionId" TEXT,
    "type" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "reasonCode" TEXT,
    "note" TEXT,
    "channel" TEXT,
    "outcome" TEXT,
    "actorType" TEXT NOT NULL,
    "adminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_campaign_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gift_campaign_entitlements_orderId_key" ON "gift_campaign_entitlements"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "gift_campaign_entitlements_tokenHash_key" ON "gift_campaign_entitlements"("tokenHash");

-- CreateIndex
CREATE INDEX "gift_campaign_entitlements_customerId_campaignKey_idx" ON "gift_campaign_entitlements"("customerId", "campaignKey");

-- CreateIndex
CREATE INDEX "gift_campaign_entitlements_status_idx" ON "gift_campaign_entitlements"("status");

-- CreateIndex
CREATE INDEX "gift_campaign_entitlements_createdAt_idx" ON "gift_campaign_entitlements"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "gift_campaign_submissions_reference_key" ON "gift_campaign_submissions"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "gift_campaign_submissions_entitlementId_key" ON "gift_campaign_submissions"("entitlementId");

-- CreateIndex
CREATE UNIQUE INDEX "gift_campaign_submissions_voucherOrderId_key" ON "gift_campaign_submissions"("voucherOrderId");

-- CreateIndex
CREATE INDEX "gift_campaign_submissions_status_idx" ON "gift_campaign_submissions"("status");

-- CreateIndex
CREATE INDEX "gift_campaign_submissions_customerId_idx" ON "gift_campaign_submissions"("customerId");

-- CreateIndex
CREATE INDEX "gift_campaign_submissions_recipientPhone_idx" ON "gift_campaign_submissions"("recipientPhone");

-- CreateIndex
CREATE INDEX "gift_campaign_submissions_createdAt_idx" ON "gift_campaign_submissions"("createdAt");

-- CreateIndex
CREATE INDEX "gift_campaign_events_entitlementId_idx" ON "gift_campaign_events"("entitlementId");

-- CreateIndex
CREATE INDEX "gift_campaign_events_submissionId_idx" ON "gift_campaign_events"("submissionId");

-- CreateIndex
CREATE INDEX "gift_campaign_events_createdAt_idx" ON "gift_campaign_events"("createdAt");

-- AddForeignKey
ALTER TABLE "gift_campaign_entitlements" ADD CONSTRAINT "gift_campaign_entitlements_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_campaign_entitlements" ADD CONSTRAINT "gift_campaign_entitlements_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_campaign_submissions" ADD CONSTRAINT "gift_campaign_submissions_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "gift_campaign_entitlements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_campaign_submissions" ADD CONSTRAINT "gift_campaign_submissions_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_campaign_submissions" ADD CONSTRAINT "gift_campaign_submissions_assignedAdminId_fkey" FOREIGN KEY ("assignedAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_campaign_submissions" ADD CONSTRAINT "gift_campaign_submissions_voucherOrderId_fkey" FOREIGN KEY ("voucherOrderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_campaign_events" ADD CONSTRAINT "gift_campaign_events_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "gift_campaign_entitlements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_campaign_events" ADD CONSTRAINT "gift_campaign_events_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "gift_campaign_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_campaign_events" ADD CONSTRAINT "gift_campaign_events_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

