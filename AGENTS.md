# pi-goal

This project is a local Pi package. Keep extension code small, testable, and biased toward observable runtime evidence.

Implementation rules:

- Treat the main Pi session as user-visible work. Do not hide goal work inside the verifier.
- Keep the verifier independent from the main session context.
- Default verifier behavior must be read-only except for running validation commands.
- A verifier that cannot produce concrete evidence must fail the goal.
- Persist compact goal state, not full hidden transcripts, into the visible Pi session.
