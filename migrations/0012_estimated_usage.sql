-- Mark answers whose usage was estimated rather than reported by the provider.
--
-- A streamed answer only learns its real token counts from the provider's final
-- usage message, which arrives after the last token. A client that disconnects
-- before then leaves the row at zero tokens and zero dollars while the provider
-- has already generated, and already charged for, the response. The budget then
-- never advances, so aborting each request just before the end is a way to spend
-- without ever being billed.
--
-- The fix books an estimate for what was streamed. That estimate must not be
-- silently mixed into a column the usage dashboard reports as measured, hence
-- this flag: the numbers stay usable for a budget, and stay honest about which
-- ones were counted and which were inferred.

alter table answers
    add column usage_estimated boolean not null default false;
