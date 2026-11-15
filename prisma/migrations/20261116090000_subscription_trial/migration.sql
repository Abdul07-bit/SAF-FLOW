-- Free trial: new subscriptions can start with a short Growth trial. While
-- set, the subscription pauses at trial end until the setup fee is paid; the
-- setup payment then converts it to the chosen plan with free days.
ALTER TABLE "product_subscriptions" ADD COLUMN "trial_ends_at" TIMESTAMP(3);
