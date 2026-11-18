-- DropIndex
DROP INDEX "usage_event_subscriber_no_year_month_idx";

-- CreateIndex
CREATE INDEX "usage_event_subscriber_no_year_month_created_at_id_idx" ON "usage_event"("subscriber_no", "year", "month", "created_at", "id");
