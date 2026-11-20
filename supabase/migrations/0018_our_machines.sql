-- 0018: our machines (P-047, F-15). Safe to run twice.
--
-- 1. Region honesty (audit G-0185, G-0190). The only fleet is AWS eu-west-1 (Ireland). Organizations defaulted to
--    region 'us', and their jobs ran in Ireland while the dashboard said United States. New organizations default to
--    'eu'; every existing 'us' organization is moved to 'eu', which is where its jobs actually ran. The API lets an
--    organization choose a region only when that region has machines (FENVIX_MACHINE_REGIONS).
alter table public.workspaces alter column region set default 'eu';
update public.workspaces set region = 'eu' where region = 'us';
