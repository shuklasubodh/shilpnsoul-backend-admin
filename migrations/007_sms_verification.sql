ALTER TABLE notification_verifications
  DROP CONSTRAINT IF EXISTS notification_verifications_channel_check;

ALTER TABLE notification_verifications
  ADD CONSTRAINT notification_verifications_channel_check
  CHECK (channel IN ('EMAIL', 'WHATSAPP', 'SMS'));

ALTER TABLE notification_deliveries
  DROP CONSTRAINT IF EXISTS notification_deliveries_channel_check;

ALTER TABLE notification_deliveries
  ADD CONSTRAINT notification_deliveries_channel_check
  CHECK (channel IN ('EMAIL', 'WHATSAPP', 'SMS'));
