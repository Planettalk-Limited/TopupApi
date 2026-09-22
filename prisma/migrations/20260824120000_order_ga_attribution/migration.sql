-- AlterTable
-- Analytics attribution captured at checkout, replayed on the server-side GA4
-- purchase event. Both nullable: pre-existing orders have no captured context, and a
-- browser that blocks analytics never supplies one.
ALTER TABLE "orders" ADD COLUMN     "gaClientId" TEXT,
ADD COLUMN     "gaSessions" JSONB;
