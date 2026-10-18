-- ManuDesk live feed over InsForge realtime. The web dashboard subscribes instead of polling.
--
-- Channels (hyphens, not underscores: `_` is a LIKE wildcard and is rejected in channel patterns):
--   md-runs        run_changed     every insert/update on md_runs
--   md-checks      check_added     every insert on md_checks (MCP, agent and baseline checks)
--   md-run:<uuid>  run_changed / iteration_changed / check_added for one run
--
-- Payloads carry ids and summary fields only. md_iterations' verilog/input/output bodies and any
-- Verilog are never published; clients fetch details through md-run-status / md-run-verilog.
-- Anonymous visitors can subscribe (realtime.channels already grants SELECT to anon with RLS off),
-- but nobody except the triggers below can publish on md-* channels.

-- Supersede the earlier md_checks / md_run:% feed (no consumers; '_' in its patterns also matches md-*).
DROP TRIGGER IF EXISTS md_checks_notify_insert ON public.md_checks;
DROP FUNCTION IF EXISTS public.md_checks_notify_insert();
DELETE FROM realtime.channels WHERE pattern IN ('md_checks', 'md_run:%');

INSERT INTO realtime.channels (pattern, description, enabled) VALUES
  ('md-runs',   'ManuDesk: run status changes (summary fields only)', true),
  ('md-checks', 'ManuDesk: new checks (summary fields only, no Verilog)', true),
  ('md-run:%',  'ManuDesk: one run''s status, iterations and checks (summary fields only)', true)
ON CONFLICT (pattern) DO UPDATE SET description = EXCLUDED.description, enabled = EXCLUDED.enabled;

CREATE OR REPLACE FUNCTION public.md_rt_runs()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, realtime AS $$
DECLARE v jsonb := jsonb_build_object(
  'id', NEW.id, 'design', NEW.design, 'status', NEW.status, 'step', NEW.step,
  'iteration', NEW.iteration, 'max_iterations', NEW.max_iterations,
  'best_mhz', NEW.best_mhz, 'target_mhz', NEW.target_mhz, 'updated_at', NEW.updated_at,
  'op', lower(TG_OP));
BEGIN
  PERFORM realtime.publish('md-runs', 'run_changed', v);
  PERFORM realtime.publish('md-run:' || NEW.id::text, 'run_changed', v);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.md_rt_iterations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, realtime AS $$
BEGIN
  PERFORM realtime.publish('md-run:' || NEW.run_id::text, 'iteration_changed', jsonb_build_object(
    'id', NEW.id, 'run_id', NEW.run_id, 'n', NEW.n, 'role', NEW.role, 'model', NEW.model,
    'check_id', NEW.check_id, 'accepted', NEW.accepted, 'created_at', NEW.created_at,
    'op', lower(TG_OP)));
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.md_rt_checks()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, realtime AS $$
DECLARE v jsonb := jsonb_build_object(
  'id', NEW.id, 'design', NEW.design, 'source', NEW.source, 'run_id', NEW.run_id,
  'pass', NEW.pass, 'stage', NEW.stage, 'mhz', NEW.mhz, 'x', NEW.x, 'lat', NEW.lat,
  'duration_ms', NEW.duration_ms, 'created_at', NEW.created_at);
BEGIN
  PERFORM realtime.publish('md-checks', 'check_added', v);
  IF NEW.run_id IS NOT NULL THEN
    PERFORM realtime.publish('md-run:' || NEW.run_id::text, 'check_added', v);
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.md_rt_runs(), public.md_rt_iterations(), public.md_rt_checks() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS md_runs_realtime ON public.md_runs;
CREATE TRIGGER md_runs_realtime AFTER INSERT OR UPDATE ON public.md_runs
  FOR EACH ROW EXECUTE FUNCTION public.md_rt_runs();

DROP TRIGGER IF EXISTS md_iterations_realtime ON public.md_iterations;
CREATE TRIGGER md_iterations_realtime AFTER INSERT OR UPDATE ON public.md_iterations
  FOR EACH ROW EXECUTE FUNCTION public.md_rt_iterations();

DROP TRIGGER IF EXISTS md_checks_realtime ON public.md_checks;
CREATE TRIGGER md_checks_realtime AFTER INSERT ON public.md_checks
  FOR EACH ROW EXECUTE FUNCTION public.md_rt_checks();

-- Read-only for clients: md-* channels accept no client publishes. RLS on realtime.messages was off,
-- so the permissive policy keeps every other channel exactly as it was (anon/authenticated may still
-- publish there). Trigger publishes run as the realtime.publish owner and bypass RLS.
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS md_channels_no_client_publish ON realtime.messages;
CREATE POLICY md_channels_no_client_publish ON realtime.messages FOR INSERT TO anon, authenticated
  WITH CHECK (channel_name NOT LIKE 'md-%');
