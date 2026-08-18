-- WhatsApp contacts table to track first-time message senders
CREATE TABLE IF NOT EXISTS whatsapp_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT NOT NULL,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  first_contacted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(phone_number, workspace_id)
);

-- Enable RLS
ALTER TABLE whatsapp_contacts ENABLE ROW LEVEL SECURITY;

-- Policy: Service role can do anything
CREATE POLICY "Service role full access on whatsapp_contacts"
  ON whatsapp_contacts
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_whatsapp_contacts_phone_workspace 
  ON whatsapp_contacts(phone_number, workspace_id);
