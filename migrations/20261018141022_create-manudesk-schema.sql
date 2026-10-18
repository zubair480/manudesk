-- ManuDesk schema (contract: docs/INSFORGE_PLAN.md, section Database).
-- Every object is prefixed md_ so it never collides with the other app in this project.
-- Reads: anon/authenticated may SELECT the public leaderboard tables. md_iterations (prompts, model
-- output, candidate Verilog) is not readable by anon/authenticated at all.
-- Writes: only the project API key (project_admin, table owner) through functions and the compute server.

-- md_designs: one row per benchmark design. Seeded from designs/*/spec.json + start.v (never tb.v).
CREATE TABLE public.md_designs (
  name            text PRIMARY KEY,
  top             text NOT NULL,
  summary         text NOT NULL,
  baseline_mhz    numeric NOT NULL,
  target_mhz      numeric NOT NULL,
  latency_budget  integer NOT NULL,
  resource_budget jsonb NOT NULL DEFAULT '{}'::jsonb,
  start_verilog   text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- md_playbooks: versioned markdown rules written by the reflector.
CREATE TABLE public.md_playbooks (
  version    integer PRIMARY KEY CHECK (version > 0),
  body       text NOT NULL,
  evidence   jsonb NOT NULL DEFAULT '[]'::jsonb,
  dropped    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- md_runs: one agent run; md-run-step advances it one step per call.
CREATE TABLE public.md_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  design           text NOT NULL REFERENCES public.md_designs(name) ON UPDATE CASCADE ON DELETE CASCADE,
  goal             text NOT NULL DEFAULT '',
  target_mhz       numeric NOT NULL,
  max_iterations   integer NOT NULL DEFAULT 6 CHECK (max_iterations > 0),
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'running', 'reached', 'exhausted', 'failed')),
  step             text NOT NULL DEFAULT 'plan'
                   CHECK (step IN ('plan', 'analyze', 'engineer', 'check', 'done')),
  iteration        integer NOT NULL DEFAULT 0 CHECK (iteration >= 0),
  best_mhz         numeric,
  best_check_id    uuid,
  playbook_version integer REFERENCES public.md_playbooks(version) ON DELETE SET NULL,
  done_contract    jsonb,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- md_checks: every check (MCP tool, agent run, nightly baseline). No Verilog column by design:
-- the source lives in the private md-artifacts bucket under artifact_key.
CREATE TABLE public.md_checks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  design         text NOT NULL REFERENCES public.md_designs(name) ON UPDATE CASCADE ON DELETE CASCADE,
  source         text NOT NULL CHECK (source IN ('mcp', 'agent', 'baseline')),
  run_id         uuid REFERENCES public.md_runs(id) ON DELETE SET NULL,
  verilog_sha256 text NOT NULL,
  pass           boolean NOT NULL,
  stage          text NOT NULL,
  mhz            numeric,
  x              numeric,
  lat            integer,
  path           text,
  use            jsonb,
  fix            jsonb,
  duration_ms    integer,
  artifact_key   text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.md_runs
  ADD CONSTRAINT md_runs_best_check_id_fkey
  FOREIGN KEY (best_check_id) REFERENCES public.md_checks(id) ON DELETE SET NULL;

-- md_iterations: one agent role call inside a run.
CREATE TABLE public.md_iterations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES public.md_runs(id) ON DELETE CASCADE,
  n                 integer NOT NULL CHECK (n >= 0),
  role              text NOT NULL CHECK (role IN ('planner', 'analyst', 'engineer')),
  model             text,
  prompt_tokens     integer,
  completion_tokens integer,
  input             jsonb,
  output            jsonb,
  verilog           text,
  check_id          uuid REFERENCES public.md_checks(id) ON DELETE SET NULL,
  accepted          boolean,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- md_rule_stats: per-rule effect stats from md-meta. design is free text (no FK) so an
-- aggregate row such as design = '*' is allowed.
CREATE TABLE public.md_rule_stats (
  rule_id          text NOT NULL,
  playbook_version integer NOT NULL REFERENCES public.md_playbooks(version) ON DELETE CASCADE,
  design           text NOT NULL,
  gain_pct         numeric,
  rej_rate         numeric,
  reached          numeric,
  iters            numeric,
  n_runs           integer NOT NULL DEFAULT 0,
  computed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, playbook_version, design)
);

-- Indexes
CREATE INDEX md_checks_design_created_idx ON public.md_checks (design, created_at DESC);
CREATE INDEX md_checks_run_id_idx         ON public.md_checks (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX md_checks_leaderboard_idx    ON public.md_checks (design, mhz DESC) WHERE pass;
CREATE INDEX md_runs_status_idx           ON public.md_runs (status, updated_at);
CREATE INDEX md_runs_design_idx           ON public.md_runs (design, created_at DESC);
CREATE INDEX md_iterations_run_id_idx     ON public.md_iterations (run_id, n);
CREATE INDEX md_iterations_check_id_idx   ON public.md_iterations (check_id) WHERE check_id IS NOT NULL;
CREATE INDEX md_runs_best_check_id_idx    ON public.md_runs (best_check_id) WHERE best_check_id IS NOT NULL;
CREATE INDEX md_rule_stats_version_idx    ON public.md_rule_stats (playbook_version);

-- updated_at triggers
CREATE TRIGGER md_designs_updated_at
  BEFORE UPDATE ON public.md_designs
  FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();

CREATE TRIGGER md_runs_updated_at
  BEFORE UPDATE ON public.md_runs
  FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();

-- RLS
ALTER TABLE public.md_designs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.md_checks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.md_runs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.md_iterations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.md_playbooks  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.md_rule_stats ENABLE ROW LEVEL SECURITY;

-- Drop InsForge's broad default runtime privileges, then grant back read-only access.
REVOKE ALL ON public.md_designs, public.md_checks, public.md_runs, public.md_iterations,
              public.md_playbooks, public.md_rule_stats
  FROM anon, authenticated;

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT ON public.md_designs, public.md_checks, public.md_runs,
                public.md_playbooks, public.md_rule_stats
  TO anon, authenticated;

CREATE POLICY md_designs_public_read    ON public.md_designs    FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY md_checks_public_read     ON public.md_checks     FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY md_runs_public_read       ON public.md_runs       FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY md_playbooks_public_read  ON public.md_playbooks  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY md_rule_stats_public_read ON public.md_rule_stats FOR SELECT TO anon, authenticated USING (true);
-- md_iterations: no policy and no grant for anon/authenticated (service access only).
