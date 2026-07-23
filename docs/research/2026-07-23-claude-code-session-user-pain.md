# Claude Code Session User Pain and Product Opportunities

**Research date:** 2026-07-23

**Project:** cc-analyzer

**Status:** Product research and recommendations; no implementation decision implied

## Executive summary

cc-analyzer already provides unusually deep retrospective analytics for Claude Code
sessions: cost and token accounting, context-window pressure, compactions, cache
efficiency, tool and skill use, retries, errors, subagents, files, transcripts, and
project- and portfolio-level trends.

The strongest user pain found in public reports is adjacent to those capabilities,
but more operational:

1. Users cannot reliably find the prior session that contains the work they need.
2. A session may exist on disk but be missing from Claude Code's picker or fail to
   resume with its full history.
3. Cleanup, updates, corruption, and index failures can make session history
   inaccessible or permanently remove it.
4. Context exhaustion and compaction can destroy continuity at the point where the
   user most needs a trustworthy handoff.
5. Users struggle to explain rapid usage-limit consumption from the information
   available locally.
6. Existing analytics describe activity and spend better than they describe
   outcomes, recoverability, or the next action a user should take.

This suggests a product direction:

> Evolve cc-analyzer from a session analytics dashboard into a local session
> observability and recovery workbench.

The recommended first milestone is:

> Find any Claude Code session, understand whether it is healthy, and resume or
> preserve it safely.

That milestone would combine transcript full-text search, exact resume actions,
session health diagnostics, retention warnings, and evidence-based export/handoff
reports. It reuses cc-analyzer's strongest existing assets while addressing pain
that users repeatedly report.

## Research question

What problems do users experience around Claude Code sessions, and how could
cc-analyzer—in its current or future form—help solve them?

Subquestions:

- Which problems recur across official guidance, issue reports, and community tools?
- Which problems are already addressed by cc-analyzer?
- Where does the current product stop short of a useful user outcome?
- Which opportunities fit the project's local-first, read-only architecture?
- Which apparent opportunities should be avoided because the available data cannot
  support a reliable answer?

## Method and evidence quality

This was a focused online research pass, not a statistically representative user
study. Sources included:

- Official Anthropic documentation and support guidance.
- Public issues in `anthropics/claude-code`, used as evidence of concrete failure
  modes rather than prevalence.
- Community discussions and newly built session-management products, used as demand
  signals and competitive evidence.
- The current cc-analyzer README, architecture documentation, schema, search query,
  and UI descriptions.

Evidence is weighted as follows:

1. Official documentation for intended behavior and supported workflows.
2. Reproducible or detailed upstream issues for observed failures.
3. Multiple independent community products solving the same problem as evidence of
   unmet demand.
4. Individual community comments as qualitative anecdotes only.

The research does **not** establish market size, incidence rates, willingness to
pay, or which feature would improve retention. Those require direct interviews and
product telemetry or a structured survey.

## Current cc-analyzer position

cc-analyzer is a read-only, local-first browser and analyzer for Claude Code JSONL
sessions. It never writes to `~/.claude`; its disposable SQLite index and pricing
cache live under `~/.config/cc-analyzer/`.

The product currently includes:

- Global project and session browsing.
- Per-session totals and per-turn analysis.
- Token-category and model-level cost accounting.
- Cache-write and cache-read analysis.
- Context-window fill charts and compaction markers.
- Tool, skill, subagent, command, retry, and error analysis.
- Files touched, branches, versions, and environment metadata.
- Portfolio and project trends.
- Human-readable transcripts and step timelines.
- CLI, TUI, and local web interfaces over one analysis core.

These are strong foundations. The gap is that most current surfaces answer:

- What happened?
- How much did it cost?
- Which tools or models were involved?

They less directly answer:

- Where is the work I remember?
- Can this session still be resumed?
- Is its conversation chain damaged?
- What important state is at risk of disappearing?
- What should I do next?
- Did the session actually produce a successful outcome?

### Current search limitation

The web app advertises global session search, but the underlying query matches only:

- Session title.
- Session UUID.
- Project path.

It does not search prompts, assistant text, tool calls, commands, paths mentioned in
the transcript, or tool results. A user who remembers “the session where we fixed
the token refresh race” but not its generated title still has to inspect sessions
manually.

### Current persistence limitation

The index is intentionally disposable and stores flattened metrics and JSON
aggregates, not a recoverable copy of the transcript. Deleted source sessions are
pruned on reindex. This is correct for the original cache design, but means the
index cannot preserve user history after Claude Code deletes or loses a JSONL file.

### Current insight limitation

cc-analyzer already exposes many inputs needed for good recommendations—context
growth, compactions, cache behavior, idle gaps, retries, tool errors, test commands,
and stop reasons—but largely presents them as charts and tables. Users must infer
the action themselves.

## Pain point 1: Finding the right prior session

### Evidence

Anthropic documents several ways to resume sessions: recent-session continuation,
the session picker, session names, direct session IDs, and pull-request linkage. It
also documents that sessions created by `claude -p` or the Agent SDK do not appear
in the interactive picker, although they can be resumed by ID.

Source:

- [Manage sessions — Claude Code Docs](https://code.claude.com/docs/en/sessions)

Public issue reports describe the resume picker showing only a small subset of
sessions or failing to expose older sessions that remain on disk:

- [Allow `/resume` and `--resume` to display full session history](https://github.com/anthropics/claude-code/issues/25130)
- [Resume feature does not preserve conversation context](https://github.com/anthropics/claude-code/issues/15837)

Independent products repeatedly lead with the same job:

- Full-text search across session content.
- Cross-project or cross-directory discovery.
- Search-result snippets.
- One-click or copyable resume commands.
- Human-readable archives and exports.

Examples:

- [Claude Session](https://claudesession.com/)
- [Claude Code Viewer](https://github.com/d-kimuson/claude-code-viewer)
- [Claude Code History Viewer](https://jhlee0409.github.io/claude-code-history-viewer/)
- [Sesh](https://marketplace.visualstudio.com/items?itemName=MichaelOgundare.sesh)

The number of independent tools targeting this job suggests genuine demand, while
also indicating that basic full-text search is becoming a commodity feature.

### User job

> Find the session where I discussed, attempted, changed, or learned something,
> even when I do not know its title, project encoding, or UUID.

### Opportunity for cc-analyzer

Add SQLite FTS5 indexing over selectable transcript fields:

- User prompts.
- Assistant text.
- Tool names.
- Shell commands.
- File paths.
- Tool inputs.
- Tool results, with lower ranking weight because they can be very noisy.

Search results should include:

- A short matching snippet.
- Why the result matched: prompt, assistant text, command, path, or output.
- Project, branch, date, title, and session ID.
- Health/resumability status.
- Exact `cd <cwd> && claude --resume <session-id>` command.
- Copy-command and open-in-terminal actions where the frontend permits them.

Ranking should prefer:

1. User-prompt matches.
2. Session-title matches.
3. Assistant-text matches.
4. Commands and file paths.
5. Tool output.

This would make search materially better than a raw substring scan through JSONL.

## Pain point 2: Session resume failures and damaged conversation chains

### Evidence

Users have reported sessions that retain their complete JSONL transcript but resume
with only the last message or a partial conversation:

- [Conversation history missing on resume except the last message](https://github.com/anthropics/claude-code/issues/24304)

The issue discussion identifies possible structural failure patterns such as:

- Duplicate or colliding message identifiers.
- Broken `parentUuid` references.
- Disconnected compaction roots.
- Conversation subtrees that are present but unreachable by resume traversal.

Separate reports describe persistence failures after crashes or interruptions:

- [Add persistent session storage to prevent context loss on session crashes](https://github.com/anthropics/claude-code/issues/7584)

### User job

> Tell me whether this session is intact before I depend on resume, and explain what
> is wrong if Claude Code cannot reconstruct it.

### Opportunity for cc-analyzer

Introduce a read-only session health engine and a `cc-analyzer doctor` command.

Potential checks:

- Invalid JSON lines and tolerant-schema fallbacks.
- Duplicate UUIDs or message IDs.
- References to missing parents.
- Multiple unexpected roots.
- Disconnected event subgraphs.
- Compaction boundaries without a following summary.
- Summary nodes whose expected boundary is absent.
- Sessions ending in an unresolved tool call.
- Truncated last lines or suspiciously incomplete events.
- Session ID inconsistencies inside one file.
- Project directory and authoritative `cwd` mismatches.
- Source JSONL present but absent from Claude's session index.
- cc-analyzer index entry whose source file has disappeared.

Suggested classifications:

- **Healthy:** conversation structure is internally consistent.
- **Warning:** readable, but contains anomalies that may affect resume.
- **Damaged:** transcript is readable but its resume chain is structurally broken.
- **Missing source:** an indexed session no longer exists on disk.
- **Unknown:** format drift prevents a confident assessment.

The output must distinguish a proven structural problem from a heuristic warning.

This feature fits the current architecture particularly well: the parser is already
tolerant, events already expose parent relationships, and diagnosis does not require
modifying Claude's files.

## Pain point 3: Silent cleanup and history loss

### Evidence

Detailed reports describe updates or cleanup removing session JSONL files, session
indexes, or both:

- [Desktop app update deletes session history](https://github.com/anthropics/claude-code/issues/48334)

Related reports linked from that issue describe:

- Complete loss across some projects.
- Index loss while JSONL data survives.
- JSONL loss while stale index entries survive.
- Restored sessions being deleted again by a later cleanup pass.
- Cleanup settings allegedly not preventing deletion.

Community tools have begun advertising transcript preservation specifically because
Claude Code history may be cleaned up.

### User job

> Warn me before valuable history becomes inaccessible, and let me preserve selected
> work without changing Claude Code's own files.

### Opportunity for cc-analyzer

Phase 1 should preserve the project's read-only boundary:

- Read and display the effective Claude Code cleanup/retention configuration when
  discoverable.
- Warn about old sessions that may be approaching cleanup.
- Track sessions seen in the previous cc-analyzer index but now missing.
- Offer explicit Markdown or JSON export for selected sessions.
- Produce a “valuable but at-risk” list using recency, cost, duration, file changes,
  compactions, and explicit user selection—not an opaque importance score.

Phase 2 could add an optional archive under cc-analyzer's own state directory:

- Disabled by default.
- Explicitly enabled and scoped by the user.
- Never writes to `~/.claude`.
- Reports storage size before enabling.
- Supports independent deletion and retention controls.
- Clearly states whether raw prompts, tool results, images, and secrets are copied.
- Ideally supports encryption or integration with an OS-protected storage location.

An archive is not a small extension of the disposable index. It changes the privacy,
storage, retention, and threat model and therefore deserves a separate design
decision.

## Pain point 4: Context exhaustion and failed compaction

### Evidence

Anthropic explains that long sessions repeatedly carry prior conversation and tool
history, increasing context use. It recommends clearing between unrelated tasks,
compacting when continuity is required, and monitoring usage.

Sources:

- [Models, usage, and limits in Claude Code](https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code)
- [Manage costs effectively — Claude Code Docs](https://code.claude.com/docs/en/costs)
- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)

Issue reports describe a failure mode where the context becomes too full to continue
and manual compaction also fails, leaving no recovery path that preserves session
state:

- [Reaching context limit does not allow manual compact](https://github.com/anthropics/claude-code/issues/25620)
- [Large file exceeds the compactable amount](https://github.com/anthropics/claude-code/issues/8047)

### User job

> Warn me before the session becomes difficult to recover, identify what filled the
> context, and help me carry forward the important state.

### Opportunity for cc-analyzer

Convert context charts into evidence-backed diagnostics:

- Largest context jump by API call and turn.
- Largest tool result or file read.
- Image or payload events associated with sudden growth.
- Context refill immediately after compaction.
- Repeated compactions over a short span.
- Compaction followed by retry bursts or error increases.
- Session trajectory indicating that a new turn is likely to be expensive.

Potential recommendations:

- Continue normally.
- Compact soon.
- Start a fresh session because unrelated work or stale history dominates.
- Export a handoff before continuing.
- Re-run a specific verification after compaction.

Recommendations must explain their evidence and avoid presenting a fixed percentage
threshold as universally optimal.

## Pain point 5: Compaction can lose or distort critical state

### Evidence

Anthropic notes that compaction summarizes older history and that users can provide
custom compaction instructions. Resume and compaction behavior can create expensive
cache transitions:

- [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching)

Users request persistent memory across compactions and report building their own
pre-compaction save mechanisms:

- [Persistent memory across context compactions](https://github.com/anthropics/claude-code/issues/34556)

Recent research also describes a more serious failure mode: compaction summaries can
promote partial or interrupted command output into apparently confirmed outcomes:

- [Compaction as Epistemic Failure](https://arxiv.org/abs/2607.13071)

The paper is recent and should be treated as an important research signal rather
than assumed universal behavior.

### User job

> Tell me what important evidence the compaction summary omitted or overstated, and
> give the next session a trustworthy handoff.

### Opportunity for cc-analyzer

Build a compaction audit that compares the pre-boundary evidence with the summary:

- User requirements not represented in the summary.
- Unresolved errors omitted.
- Failing or interrupted tests described as successful.
- Files changed but not mentioned.
- Decisions and alternatives omitted.
- TODOs or promised follow-ups omitted.
- Claims unsupported by a successful tool result.

Start with deterministic evidence extraction:

- Last observed test commands and result status.
- Unresolved tool errors.
- Files written or edited.
- Explicit user requirements.
- Pending TODO-like statements.
- Last successful verification.
- Git branch and working directory.

An optional model-generated summary could be added later, but it should never replace
the raw evidence and should be labeled as generated inference.

## Pain point 6: Usage-limit and cost confusion

### Evidence

Anthropic documents that prompt caching makes repeated context cheaper than uncached
input while the content still occupies the context window. It also notes that the
first turn after resuming a long conversation can be especially expensive:

- [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching)

Users report cache-read tokens dominating visible usage:

- [Cache-read tokens consume 99.93% of usage quota](https://github.com/anthropics/claude-code/issues/24147)

Other reports describe a mismatch between local transcript-derived usage and the
account's five-hour usage meter:

- [Current session limit reaches 100% despite low visible local usage](https://github.com/anthropics/claude-code/issues/54750)

Possible explanations include usage from another surface or device, other running
processes, server-side accounting, or prompt-cache behavior. Local JSONL data cannot
distinguish all of these.

### User job

> Explain which local session behavior is consuming tokens and cost without claiming
> to know account-wide usage that is not present in the transcript.

### Opportunity for cc-analyzer

Enhance local diagnostics:

- Marginal tokens and cost by turn.
- Cache-read, cache-write, input, and output contribution per turn.
- Resume cold-start or cache-reset spikes.
- Cache rewrites following idle gaps.
- Repeated large-context calls with little productive output.
- Model-switch and context-limit effects.
- Locally observed concurrent sessions.

Explicit non-goal:

> cc-analyzer should not claim to reproduce or predict Anthropic's exact five-hour
> or weekly subscription meter from local transcripts.

The UI should clearly say “local transcript usage” and explain why it may differ
from account-level limits.

## Pain point 7: Activity analytics do not establish value

### Evidence

Anthropic's organizational analytics increasingly correlate usage with outputs such
as commits and pull requests and present costs alongside artifacts:

- [Claude Code usage analytics](https://support.claude.com/en/articles/12157520-claude-code-usage-analytics)
- [New analytics and cost controls for Claude Enterprise](https://claude.com/blog/giving-admins-more-visibility-and-control-over-claude-usage-and-spend)

This reflects an important distinction:

- Tool calls, tokens, time, and files touched are activity measures.
- Successful tests, accepted changes, commits, PRs, and resolved tasks are outcome
  signals.

### User job

> Show me which ways of using Claude Code lead to useful outcomes, not only which
> sessions are expensive or busy.

### Opportunity for cc-analyzer

Add cautiously labeled outcome signals:

- Tests attempted and last observed test status.
- Sessions ending with an unresolved tool error.
- Files written versus only read.
- Commits associated by time, branch, or explicit transcript evidence.
- Pull requests referenced or created.
- Sessions with a clear completion message but no observed verification.
- Cost per successful test run, commit, or PR.
- Repeated failed approaches across related sessions.

These signals are correlational. A commit may include work from multiple sessions,
and a session may produce valuable reasoning without a commit. The product should not
collapse them into a synthetic “developer productivity score.”

## Recommended product priorities

### P0: Full-text session discovery and resume

Deliver:

- Transcript FTS5.
- Search CLI.
- Web and TUI search integration.
- Ranked snippets and field-aware matches.
- Exact resume commands and safe copy actions.
- Filters by project, date, branch, source field, health, and resumability.

Why P0:

- Direct, repeatedly observed user pain.
- Strong fit with the existing SQLite index and transcript parser.
- Enables recovery, handoff, and later diagnostic workflows.
- Necessary to remain competitive with newer session browsers.

### P0: Session health and recoverability

Deliver:

- `cc-analyzer doctor`.
- Structural conversation checks.
- Health status in session lists and search results.
- Clear distinction between source missing, index stale, and chain damaged.
- Read-only remediation guidance.

Why P0:

- Differentiates cc-analyzer from basic history search.
- Leverages existing parent IDs, compaction records, parser errors, and index state.
- Addresses cases where raw transcript data exists but Claude cannot use it.

### P0/P1: Retention guard and explicit preservation

Deliver first:

- Retention/configuration visibility.
- Missing-since-last-index detection.
- At-risk session warnings.
- Markdown and JSON export.

Design separately:

- Optional raw transcript archive under cc-analyzer state.

Why:

- Data loss is high impact.
- An archive is valuable but materially changes privacy and storage expectations.

### P1: Actionable context and cost diagnostics

Deliver:

- Context jump attribution.
- Largest payload and output identification.
- Cache cliff and idle-rewrite detection.
- Marginal per-turn cost.
- Explainable next-action recommendations.

Why P1:

- Much of the required data already exists.
- Makes current analytics immediately useful rather than merely descriptive.

### P1: Compaction audit and deterministic handoff

Deliver:

- Evidence-based session state report.
- Pre/post-compaction omissions and contradictions.
- Unresolved error and verification warnings.
- Exportable handoff Markdown.

Why P1:

- Strong differentiation.
- Directly connects cc-analyzer's compaction support to user continuity.
- Requires careful false-positive management, so it should follow health diagnostics.

### P2: Outcome and workflow intelligence

Deliver:

- Test, commit, PR, and unresolved-work signals.
- Correlational workflow comparisons.
- Project-level patterns without productivity scoring.

Why P2:

- Valuable but more ambiguous than search and health.
- Git attribution and success classification need careful design.

## Features to deprioritize or constrain

### Generic additional charts

Do not add a chart unless it supports a decision or diagnostic question. The product
already has substantial analytical breadth.

### Exact subscription-limit prediction

Do not imply that local JSONL explains account-wide limits. Show local contributors
and the limits of the evidence.

### Live follow as a standalone feature

Live follow becomes compelling when it can warn about:

- Dangerous context growth.
- Repeated cache rewrites.
- Failed compaction.
- Unresolved errors before exit.

A scrolling live transcript alone is less differentiated.

### Export as a standalone feature

Tie export to explicit jobs:

- Preserve before cleanup.
- Create a handoff.
- Share a sanitized incident record.
- Attach evidence to a bug report.

### Unfocused session comparison

The current roadmap also suggests comparing two sessions. Comparison is useful when
it answers a concrete question, such as:

- Why did one attempt cost more?
- Which attempt reached a successful test result?
- Did a resumed or compacted session rebuild substantially more context?
- Which tools, models, or files differed between a successful and failed approach?

A generic side-by-side transcript diff should be deprioritized until one of these
diagnostic workflows is designed. Comparison should support a user decision, not
exist only because two session analyses are available.

### Automatic repair of Claude JSONL

Do not make in-place repair an early feature. It conflicts with the strongest trust
property: cc-analyzer never writes to `~/.claude`.

If repair is ever considered, it should be a separate, explicit, backup-first
workflow with a documented format-compatibility risk.

### Opaque AI scoring

Avoid “session quality,” “productivity,” or “importance” scores whose construction
cannot be inspected. Prefer observable facts, named heuristics, and explanations.

## Proposed milestone: Session Recovery Workbench

### Product promise

> Find any Claude Code session, verify whether its history is healthy, and resume or
> preserve it safely.

### Suggested scope

1. Add FTS5-backed transcript search.
2. Add a scriptable `search` command with JSON output.
3. Add resume-command generation.
4. Add session graph and source-file health checks.
5. Surface health in CLI, TUI, and web search results.
6. Add retention/config warnings.
7. Add Markdown and JSON handoff/export.

### Suggested exclusions

- No mutation of `~/.claude`.
- No automatic transcript archive in the initial release.
- No model calls required for indexing or handoff generation.
- No exact account-quota forecast.
- No automated repair.

### Possible command surface

```text
cc-analyzer search "token refresh race"
cc-analyzer search "bun test" --in=commands --project=current --json
cc-analyzer resume <session-id> --print
cc-analyzer doctor [session-id|path]
cc-analyzer doctor --all --json
cc-analyzer export <session-id> --format=markdown
cc-analyzer handoff <session-id> --format=markdown
```

`resume --print` is intentionally safe and scriptable. Whether cc-analyzer should
spawn Claude Code directly should be a separate UX decision.

## Architecture implications

### Search index

Transcript search would require content-oriented storage beyond the current
aggregate row:

- An FTS5 virtual table keyed by session path or stable session ID.
- Field or content-type metadata for ranking and filtering.
- Incremental replacement when size or mtime changes.
- Removal behavior that distinguishes “source deleted” from “never indexed.”
- Limits or selective indexing for exceptionally large tool results.

Privacy implications:

- The current index already contains sensitive paths and behavioral metadata.
- Full transcript indexing greatly increases sensitivity.
- Documentation must state that prompts and outputs are copied into the state DB.
- File permissions, deletion behavior, and opt-out controls should be reviewed.
- A content-free mode may be appropriate for users who want only aggregate analytics.

### Health engine

Health checks should be pure functions over parsed events and discovery/index
metadata where possible. This keeps them reusable across:

- Single-session CLI output.
- Streaming or batch index paths.
- Web API.
- TUI.
- Tests with purpose-built corrupt fixtures.

Graph checks may require retaining small UUID/parent maps even when full turn detail
is disabled. This should be evaluated against the indexer's streaming memory goals.

### Retention and archive

Retention inspection should be read-only and tolerate unknown Claude Code versions
and settings formats.

An archive, if approved later, should be separate from the disposable analytics DB.
Schema migration must never silently erase preserved history.

### Handoff reports

Deterministic handoff generation can reuse:

- Real prompt segmentation.
- Step and tool-result resolution.
- Error state.
- Files touched.
- Branch and version metadata.
- Test-command classification.
- Compaction boundaries.

The report should cite turn numbers or timestamps so users can inspect its evidence.

## Validation plan

Before committing to the full milestone:

### User interviews

Interview 8–12 active Claude Code users across:

- Individual Pro/Max users.
- API-key users.
- Developers with hundreds or thousands of sessions.
- Users working across worktrees or multiple machines.
- Users who have experienced resume or cleanup failures.

Questions should focus on recent behavior:

- “Tell me about the last time you tried to find an older session.”
- “What did you remember, and what information did you lack?”
- “What did you do when resume failed?”
- “Have you lost session history? What was the impact?”
- “When do you decide to compact, clear, or start fresh?”
- “How do you know whether a session was successful?”
- “What session content would you refuse to place in another local index?”

Avoid asking users to rank hypothetical features before understanding their actual
workarounds.

### Prototype tests

Build narrow prototypes for:

1. FTS search with snippets and a resume command.
2. A health report over real damaged-session fixtures.
3. A deterministic handoff report around a compaction boundary.

Measure:

- Time to find a known session.
- Search success from vague remembered phrases.
- False positives from tool-output noise.
- Whether health explanations are understandable.
- Whether the handoff catches something users care about.

### Product telemetry

If consistent with the existing telemetry policy, collect only coarse, content-free
events:

- Search command used.
- Result-count bucket.
- Resume command copied.
- Doctor outcome bucket.
- Export/handoff invoked.

Never collect query text, session IDs, project paths, health details, or transcript
content.

## Key product decisions still needed

1. Is full transcript content indexed by default, opt-in, or controlled by a
   content-free mode?
2. Should missing source sessions remain represented as tombstones, and for how long?
3. Is preservation/export sufficient, or should cc-analyzer maintain an optional raw
   archive?
4. Should `resume` only print/copy a command, or may it launch Claude Code?
5. Which health checks are definitive enough to label “damaged”?
6. How much tool output should FTS retain?
7. Should handoff generation remain deterministic, or support an optional local or
   remote model?
8. How should secrets and binary/image payloads be treated during indexing and
   export?

## Conclusions

### Primary conclusion

The highest-value expansion is not broader aggregate analytics. It is closing the
loop from observation to recovery:

```text
discover → inspect → diagnose → resume or preserve
```

### Strategic conclusion

Full-text search is necessary but insufficient as a differentiator. Multiple tools
now provide search and one-click resume. cc-analyzer's advantage can be the depth and
trustworthiness of its analysis:

- Structural session health.
- Context and compaction diagnostics.
- Evidence-based handoffs.
- Cost explanations grounded in token categories.
- Local-first and read-only behavior.

### Trust conclusion

The project should preserve three principles:

1. Never claim more than the transcript evidence supports.
2. Keep heuristics named, explainable, and inspectable.
3. Do not mutate Claude Code's source history as part of normal operation.

### Recommended next step

Write a focused product/design specification for the Session Recovery Workbench,
starting with transcript FTS, resume actions, and session health. Resolve the privacy
and index-retention decisions before implementation.

### Implication for the current roadmap

The existing roadmap lists live-follow, session comparison, and report export. The
research does not reject those ideas, but changes their framing:

- **Live-follow** should become proactive context-risk and unresolved-error warning.
- **Compare** should explain cost, context, or outcome differences between attempts.
- **Export** should preserve at-risk work or produce a trustworthy handoff.

The higher-priority foundation is session discovery and recoverability. These three
roadmap ideas become more valuable when attached to that workflow.

## Source index

### Official Anthropic sources

- [Manage sessions — Claude Code Docs](https://code.claude.com/docs/en/sessions)
- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [Manage costs effectively](https://code.claude.com/docs/en/costs)
- [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching)
- [Models, usage, and limits in Claude Code](https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code)
- [Claude Code usage analytics](https://support.claude.com/en/articles/12157520-claude-code-usage-analytics)
- [New analytics and cost controls for Claude Enterprise](https://claude.com/blog/giving-admins-more-visibility-and-control-over-claude-usage-and-spend)

### Upstream issue reports

- [Conversation history missing on resume](https://github.com/anthropics/claude-code/issues/24304)
- [Resume picker does not display full history](https://github.com/anthropics/claude-code/issues/25130)
- [Resume does not preserve context](https://github.com/anthropics/claude-code/issues/15837)
- [Persistent storage after crashes](https://github.com/anthropics/claude-code/issues/7584)
- [Desktop update deletes session history](https://github.com/anthropics/claude-code/issues/48334)
- [Manual compact unavailable at context limit](https://github.com/anthropics/claude-code/issues/25620)
- [Large file creates irrecoverable context](https://github.com/anthropics/claude-code/issues/8047)
- [Persistent memory across compactions](https://github.com/anthropics/claude-code/issues/34556)
- [Cache-read tokens dominate quota](https://github.com/anthropics/claude-code/issues/24147)
- [Local usage does not explain account limit](https://github.com/anthropics/claude-code/issues/54750)

### Related products and research

- [Claude Session](https://claudesession.com/)
- [Claude Code Viewer](https://github.com/d-kimuson/claude-code-viewer)
- [Claude Code History Viewer](https://jhlee0409.github.io/claude-code-history-viewer/)
- [Sesh](https://marketplace.visualstudio.com/items?itemName=MichaelOgundare.sesh)
- [Compaction as Epistemic Failure](https://arxiv.org/abs/2607.13071)
