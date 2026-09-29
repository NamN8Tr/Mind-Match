# Solver provenance

This worker is an independent implementation written for Smart Rot. It does
not copy or link code from Solvitaire or SolverLab.

Its design uses standard, publicly documented search techniques: bounded
best-first search, depth-first search with transposition tables, heuristic move
ordering, checkpoint adoption, and deterministic search diversification.
Solvitaire and SolverLab were evaluated as prior art and helped inform the
choice of those general techniques:

- Solvitaire: https://github.com/thecharlieblake/Solvitaire (GPL-2.0)
- SolverLab: https://github.com/jsgrrchg/SolverLab (Apache-2.0)

The bundled worker remains Smart Rot code and has no runtime dependency on
either project. Solver output is treated as untrusted input and replayed by the
authoritative TypeScript game engine before a board enters the persistent pool.
