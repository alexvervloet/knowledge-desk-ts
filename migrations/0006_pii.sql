-- Phase 6: flag documents that contain obvious PII at ingest time. Stored as a
-- JSONB array of type names (email, phone, ssn, credit_card); empty when clean.
-- This is a visibility signal for admins, not a gate.

alter table documents
    add column pii_types jsonb not null default '[]'::jsonb;
