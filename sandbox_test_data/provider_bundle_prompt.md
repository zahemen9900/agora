# Sandbox Deliberation Prompt

You are advising the launch team for a hosted agent product.

Use the CSV at `sandbox_test_data/provider_bundle_eval.csv`. Do not answer from inspection alone. Load the file in Python inside the sandbox and show the calculations that justify your recommendation.

## Decision Task

Pick exactly one provider bundle for launch next month.

## Launch Constraints

- Monthly workload mix is the same as the `tasks` counts in the CSV.
- Monthly budget cap is `$540`.
- Weighted overall `pass_rate` must be at least `0.82`.
- Weighted overall `policy_violations_per_1k` must be at most `1.2`.
- For `ops_automation`, `tool_success_rate` must be at least `0.89`.
- For `customer_support`, `p95_latency_ms` must stay below `7000`.

## Required Analysis

1. Compute weighted overall metrics for every bundle:
   - `pass_rate`
   - `tool_success_rate`
   - `avg_cost_usd`
   - `reasoning_tokens`
   - `policy_violations_per_1k`
   - `abstain_rate`
2. Convert `avg_cost_usd` into projected monthly spend using the `tasks` column.
3. Eliminate bundles that violate any hard constraint.
4. Among the survivors, rank them using this score:

\[
\text{launch\_score} =
45 \cdot \text{pass\_rate}
+ 20 \cdot \text{tool\_success\_rate}
- 8 \cdot \text{policy\_violations\_per\_1k}
- 4 \cdot \text{abstain\_rate}
- 0.0004 \cdot \text{p95\_latency\_ms\_weighted}
- 0.03 \cdot \text{monthly\_spend}
\]

5. Run one sensitivity analysis where `ops_automation` volume doubles and the other workloads stay fixed.
6. State whether the recommendation changes under that sensitivity case.

## Output Format

- Show the Python-derived comparison table.
- Name the winning bundle.
- Explain why it wins and why the rejected bundles fail.
- Call out one operational risk tied to the winner.
