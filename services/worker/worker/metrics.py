from prometheus_client import Counter, Gauge, Histogram

RUNS_FINISHED = Counter("reqcheck_worker_runs_total", "Finished runs", ["status", "provider"])
RUN_DURATION = Histogram("reqcheck_worker_run_duration_seconds", "Run duration", ["status"],
                         buckets=(10, 30, 60, 120, 300, 600, 1200, 1800, 3600))
RUNS_IN_PROGRESS = Gauge("reqcheck_worker_runs_in_progress", "Runs in progress")
LLM_CALLS = Counter("reqcheck_llm_calls_total", "LLM calls made by runs", ["provider", "model"])
LLM_TOKENS = Counter("reqcheck_llm_tokens_total", "LLM tokens used by runs", ["provider", "model", "kind"])
LLM_COST = Counter("reqcheck_llm_cost_usd_total", "Estimated LLM cost, USD", ["provider", "model"])
FINDINGS = Counter("reqcheck_findings_total", "Findings reported", ["severity"])
